import { setImmediate } from "node:timers/promises";
import type { Theme, ToolInfo } from "@earendil-works/pi-coding-agent";
import {
  Container, HStack, isViewportTUI, mixColors, MouseRegion, rgbColor, ScrollView, Text, truncateToWidth, visibleWidth, VStack,
  type Color, type Component, type RgbColor, type ScrollViewOptions, type StackChild, type TUI, type TuiMouseEvent,
} from "@earendil-works/pi-tui";
import { NativeDocument, type DocumentActs, type Pane } from "./native.ts";
import { actColor, pointerMotionAvailable } from "./acts.ts";
import { NativeContentIndex } from "./content.ts";
import { NestedCalls } from "./nested-calls.ts";
import type { Preferences } from "./preferences.ts";
import type { TranscriptTimestamps } from "./timestamps.ts";
import { PANEL_SEARCH_ROWS, PanelSearch, PanelSearchShortcut, type SearchHit } from "./search.ts";
import { SplitSurface } from "./surface.ts";
import { sameValues } from "./render-cache.ts";
import type { Problem } from "./report.ts";

type NativeTui = TUI & {
  layoutRoot?: Container;
  setLayoutRoot(component: Component | undefined): void;
  getFocusedComponent(): Component | null;
};
const MIN_CHAT = 24;
const MIN_ACTIVITY = 40;
const MIN_ROWS = 4;
const TOOLBAR_BUTTON_WIDTH = 6;

/**
 * A control that renders again only when one of its inputs changes. Every spinner frame lays out
 * all toolbar and panel controls; restyling unchanged labels would cost more than the panels themselves.
 */
function memoized(inputs: (width: number) => unknown[], render: (width: number) => string[]): Component {
  let last: { inputs: unknown[]; lines: string[] } | undefined;
  return {
    render: width => {
      const current = inputs(width);
      if (last && sameValues(last.inputs, current)) return last.lines;
      last = { inputs: current, lines: render(width) };
      return last.lines;
    },
    invalidate: () => { last = undefined; },
  };
}

class PanelScrollView extends ScrollView {
  constructor(component: Component, options: ScrollViewOptions, private readonly interact: () => void, active: () => boolean) {
    super(component, options);
    // Pi sends keyboard scrolling and native search to the primary ScrollView; follow the active panel.
    Object.defineProperty(this, "primary", { get: active });
  }

  override handleMouse(event: TuiMouseEvent): ReturnType<Container["handleMouse"]> {
    if (event.type === "wheel" || (event.type === "press" && event.button === "left")) this.interact();
    // Native layout already dispatches to the visible document with its scroll offset.
    // Container routing here would send the event into unrelated off-screen rows.
    return undefined;
  }
}
class NativeSurfaceScrollView extends ScrollView {
  override handleMouse(event: TuiMouseEvent): ReturnType<Container["handleMouse"]> {
    if (event.type !== "wheel" || !event.wheelDelta) return undefined;
    this.scrollBy(event.wheelDelta);
    return { handled: true, target: { component: this, originX: event.screenX - event.x,
      originY: event.screenY - event.y, width: event.width, height: event.height } };
  }
}

class ButtonStack extends VStack {
  private style: "icons" | "text" = "icons";
  private lastLayout = "";

  constructor(private readonly items: StackChild[], private readonly controls: { index: number; icon: number }[],
    private readonly titleLength?: number, private readonly fill?: Component) {
    super();
  }

  setStyle(style: "icons" | "text"): void {
    if (this.style !== style) { this.style = style; this.lastLayout = ""; }
  }

  override render(width: number): string[] {
    const textWidth = (index: number): number => {
      const item = this.items[index];
      const component = "component" in item ? item.component : item;
      return (component as Component & { textWidth(): number }).textWidth();
    };
    const layout = `${this.style}:${width}:${this.style === "text" ? this.controls.map(control => textWidth(control.index)).join(",") : ""}`;
    if (layout !== this.lastLayout) {
      this.lastLayout = layout;
      this.clear();
      const entries = this.items.map((item, index) => {
        const entry = "component" in item ? { ...item } : { component: item };
        const control = this.controls.find(candidate => candidate.index === index);
        if (control) {
          entry.basis = this.style === "icons" ? control.icon : textWidth(index);
          entry.minSize = entry.basis;
          entry.shrink = 0;
        } else if (this.titleLength !== undefined) {
          entry.minSize = this.style === "icons" ? 1 : this.titleLength;
        }
        return entry;
      });
      if (this.style === "icons") {
        this.addChild(new HStack(entries), { basis: 1, shrink: 0 });
      } else {
        let row: StackChild[] = [];
        let occupied = 0;
        const flush = (): void => {
          if (row.length) {
            const spaced = row.map((item, index) => {
              const entry = "component" in item ? { ...item } : { component: item };
              if (index < row.length - 1) {
                if (typeof entry.basis === "number" && !entry.grow) entry.basis++;
                entry.minSize = (entry.minSize ?? 0) + 1;
              }
              return entry;
            });
            if (this.fill && !row.includes(entries[0])) spaced.push({ component: this.fill, basis: 0, grow: 1 });
            // Keep the last label off the panel's right edge, where the scrollbar sits.
            if (this.fill) spaced.push({ component: this.fill, basis: 1, shrink: 0 });
            this.addChild(new HStack(spaced), { basis: 1, shrink: 0 });
          }
          row = []; occupied = 0;
        };
        for (const [index, entry] of entries.entries()) {
          const control = this.controls.find(candidate => candidate.index === index);
          const size = control ? textWidth(index) : this.titleLength ?? 0;
          if (row.length && occupied + 1 + size > width - (this.fill ? 1 : 0)) flush();
          occupied += (row.length ? 1 : 0) + size;
          row.push(entry);
        }
        flush();
      }
    }
    // Pi and the split surface lay out these rows themselves and read render only for the height.
    // Rendering the rows here would composite every button into a full-width row on every frame.
    return Array<string>(this.children.length).fill("");
  }
}
class TranscriptColumns extends HStack {
  /** Reserve a fixed width for Conversation, independent of its content. */
  sizeConversation(component: Component, width: number): void {
    const entry = this.entries.find(entry => entry.component === component);
    if (entry) entry.basis = width;
  }
}

class TranscriptRows extends VStack {
  /** Limit Conversation while leaving at least one Activity content row. */
  limitConversation(component: Component, height: number, chatMinimum: number, activityMinimum: number): void {
    for (const entry of this.entries) {
      if (entry.component === component) {
        entry.maxSize = height;
        entry.minSize = chatMinimum;
      } else if (entry.minSize !== undefined) entry.minSize = activityMinimum;
    }
  }
}

class TranscriptRoot extends VStack {
  private readonly owned: Component[];

  constructor(children: StackChild[], private readonly unhandled: (event: TuiMouseEvent) => void) {
    super(children);
    this.owned = [...this.children];
  }

  override handleMouse(event: TuiMouseEvent): ReturnType<Container["handleMouse"]> {
    // Pi offers the root only events no component handled, such as pointer moves outside the split panels.
    this.unhandled(event);
    return undefined;
  }

  unchanged(): boolean {
    return this.children.length === this.owned.length && this.children.every((child, index) => child === this.owned[index]);
  }

  preserveForeignChildren(native: VStack): void {
    for (const entry of this.entries) {
      if (!this.owned.includes(entry.component)) native.addChild(entry.component, entry);
    }
  }
}

class TranscriptPane extends VStack {
  constructor(private readonly header: Component, private readonly view: ScrollView, private readonly height: () => number,
    private readonly widgets?: ScrollView, private readonly widgetsVisible: () => boolean = () => false) {
    super([
      { component: header, basis: "auto", shrink: 0 },
      { component: view, basis: 0, grow: 1, minSize: 1 },
      ...(widgets ? [{ component: widgets, basis: "auto" as const, minSize: 0,
        visible: () => widgetsVisible() }] : []),
    ]);
  }

  override handleMouse(event: TuiMouseEvent): ReturnType<Container["handleMouse"]> {
    if (event.type !== "wheel") return undefined;
    // Native wheel routing gives any unused delta to the primary panel, Activity.
    // Consume it here so the wheel only moves the panel under the pointer.
    this.view.scrollBy(event.wheelDelta ?? 0);
    return { handled: true, target: {
      component: this, originX: event.screenX - event.x, originY: event.screenY - event.y,
      width: event.width, height: event.height,
    } };
  }

  override render(width: number): string[] {
    // Native layout measures height here, then paints the original header and ScrollView.
    // Empty preview rows avoid composing colored history text in ancestor measurements.
    const headerRows = this.header.render(width).length;
    const contentRows = this.view.children[0].render(this.view.getContentWidth(width)).length;
    const widgetRows = this.widgets && this.widgetsVisible() ? this.widgets.render(width).length : 0;
    const available = Math.max(1, this.height() - headerRows);
    return Array<string>(headerRows + Math.min((widgetRows ? Math.max(1, contentRows) : contentRows) + widgetRows, available)).fill("");
  }
}

/** Project native fullscreen history and transient surfaces without taking ownership of their lifecycle. */
export class TranscriptLayout {
  private host?: NativeTui;
  private original?: Container;
  private mounted?: Component;
  private activity?: ScrollView;
  private chat?: ScrollView;
  private documents?: Record<Pane, NativeDocument>;
  private surface?: SplitSurface;
  private disposeDocuments?: () => void;
  private activePane: Pane = "chat";
  private readonly searchShortcut = new PanelSearchShortcut();
  private readonly searchRows: Record<Pane, VStack> = { chat: new VStack(), activity: new VStack() };
  private search?: {
    pane: Pane; bar: PanelSearch; document: NativeDocument; view: ScrollView;
    top: number; following: boolean; focus: Component | null;
  };
  private searchVersion = 0;
  private restoreVersion = 0;
  private drag?: { position: number; size: number };
  private failed = false;
  private fallback = false;
  private automaticHeight = MIN_ROWS;
  private readonly rejectedRoots = new WeakSet<Component>();
  private rebuild = (): void => {};
  private index?: NativeContentIndex;
  /** The act under the pointer; a pointer move collects the act its document reports. */
  private hoverAct?: number;
  private moving?: { act: number };
  /** The terminal's reported background, which act colors are mixed into. */
  private terminalBackground?: RgbColor;

  constructor(
    readonly preferences: Preferences,
    private readonly theme: () => Theme,
    private readonly warn: (message: string) => void,
    private readonly save: () => void,
    private readonly timestamps: TranscriptTimestamps,
    private readonly openSettings: () => void,
    private readonly copy?: (text: string | undefined) => void,
    private readonly getTools: () => readonly ToolInfo[] = () => [],
    private readonly nested = new NestedCalls(),
    private readonly getEditor: () => Component | undefined = () => undefined,
    /** Show a problem that stops the split, with a way to report it. */
    private readonly report: (problem: Problem) => void = problem => this.warn("pi-stereo-view " + problem.summary +
      (problem.error === undefined ? "" : ": " + (problem.error instanceof Error ? problem.error.message : String(problem.error)))),
  ) {}

  /** Refuse a Pi layout the split cannot use; Pi keeps its own history view. */
  private refuse(reason: string): void {
    this.report({ summary: "split is unavailable: " + reason });
  }

  /**
   * Stop the split after an unexpected error instead of letting it reach Pi's render loop, which would end Pi.
   * The next layout pass shows Pi's own history and dock.
   */
  private fail(error: unknown): void {
    if (this.failed) return;
    this.failed = true;
    this.searchShortcut.dispose();
    this.disposeDocuments?.();
    queueMicrotask(() => {
      this.closeSearch(false);
      this.report({ summary: "split disabled after an error", error });
      this.host?.requestRender();
    });
  }

  private button(label: () => string, action: () => void, enabled = (): boolean => true, background?: () => Color): Component {
    const button = new MouseRegion(memoized(width => [width, this.theme(), this.preferences.buttonStyle, label(), enabled(), background?.()],
      width => new Text(this.theme().style((this.preferences.buttonStyle === "icons" ? "[ " + label() + " ]" : "[" + label() + "]").padEnd(width), {
        fg: enabled() ? "accent" : "dim", bg: background?.(),
      }), 0, 0).render(width)), event => {
      if (event.button !== "left") return;
      if (event.type === "press") return { capture: true };
      if (event.type === "click" && enabled() && event.x >= 0 && event.x < event.width && event.y === 0) {
        action();
        return { handled: true, render: true };
      }
      return { handled: true };
    });
    return Object.assign(button, { textWidth: () => visibleWidth(label()) + 2 });
  }

  /** Mount controls only on a compatible native fullscreen history tree. */
  attach(tui: TUI): void {
    if (!isViewportTUI(tui)) {
      this.dispose();
      return;
    }
    const host = tui as unknown as NativeTui;
    if (typeof host.getFocusedComponent !== "function") {
      this.refuse("Pi's focus API is not supported.");
      return;
    }
    if (host.layoutRoot === this.mounted && this.host) {
      const mounted = this.mounted as TranscriptRoot;
      if (mounted.unchanged()) return;
      const original = this.original!;
      mounted.preserveForeignChildren(original as VStack);
      this.dispose();
      this.rejectedRoots.add(original);
      this.refuse("Pi's fullscreen layout is not supported.");
      return;
    }
    const root = host.layoutRoot;
    if (this.host) this.dispose();
    if (root && this.rejectedRoots.has(root)) return;
    if (!root || root.constructor.name !== "VStack" || root.children.length !== 2) {
      if (root) this.rejectedRoots.add(root);
      this.refuse("Pi's fullscreen layout is not supported.");
      return;
    }
    const [transcript, dock] = root.children;
    const scroll = transcript as ScrollView;
    const owner = scroll as unknown as { child?: Component; children: Component[] };
    const document = owner.children?.[0] as Container;
    if (transcript.constructor.name !== "ScrollView" || dock.constructor.name !== "VStack" ||
        document?.constructor.name !== "Container" || owner.child !== document || document.children.length !== 3 ||
        !Array.isArray((document.children[2] as Container)?.children)) {
      this.rejectedRoots.add(root);
      this.refuse("Pi's history document is not supported.");
      return;
    }
    // Route only the known native dock shape. Keep the original untouched for fallback.
    const nativeDock = dock as unknown as { entries: Array<Exclude<StackChild, Component>>; children: Component[] };
    const entries = Array.isArray(nativeDock.entries) ? nativeDock.entries.map(entry => ({ ...entry })) : [];
    const supportedDock = entries.length === 6 && entries.every((entry, i) => entry.component === nativeDock.children[i]) &&
      [2, 4].every(i => entries[i].component.constructor.name === "Container") &&
      entries[3].minSize === 3;
    const above = supportedDock ? entries[2].component as Container : undefined;
    const below = supportedDock ? entries[4].component as Container : undefined;
    const editorSlot = supportedDock && entries[3].component.constructor.name === "Container"
      ? entries[3].component as Container : undefined;
    let projectDialog = false;
    const dialogPresent = (): boolean => {
      const editor = this.getEditor();
      return !!editor && !!editorSlot && editorSlot.children.length === 1 && editorSlot.children[0] !== editor;
    };
    const projectedDock = supportedDock ? new VStack(entries.filter((_, i) => i !== 2 && i !== 4).map(entry =>
      entry.component === editorSlot ? { ...entry, visible: () => !projectDialog } : entry)) : undefined;
    // Preserve the original containers and Pi's above/editor/below order. Pi still owns their lifecycle.
    const surfaceTree = above && below ? new VStack([
      above, ...(editorSlot ? [{ component: editorSlot, visible: () => projectDialog }] : []), below,
    ]) : undefined;
    const surfaceView = surfaceTree ? new NativeSurfaceScrollView(surfaceTree, { overscroll: "contain" }) : undefined;
    const widgetsPresent = (): boolean => !!above && !!below && (above.children.length > 1 || below.children.length > 0);
    const surfacePresent = (): boolean => widgetsPresent() || projectDialog;
    const dockUnchanged = (): boolean => supportedDock && nativeDock.entries.length === 6 &&
      nativeDock.entries.every((entry, i) => entry.component === nativeDock.children[i] &&
        Object.keys({ ...entry, ...entries[i] }).every(key =>
          entry[key as keyof typeof entry] === entries[i][key as keyof typeof entry]));
    this.host = host;
    this.original = root;
    this.failed = false;
    // Auto scrollbars overlay one native content column; keep clocks outside it.
    const timestampGutter = (): number => scroll.scrollbar === "auto" ? 1 : 0;
    const showTimestamps = (): boolean => this.preferences.showTimestamps;
    const showCopyButtons = (): boolean => this.preferences.showCopyButtons;
    const index = new NativeContentIndex(document, this.nested, () => this.preferences.nestedTree);
    this.index = index;
    const acts: DocumentActs = {
      colors: () => this.preferences.actColors,
      color: act => actColor(this.theme(), act, this.terminalBackground),
      hovered: () => this.hoverAvailable() && this.preferences.actHover ? this.hoverAct : undefined,
      hover: act => { if (this.moving) this.moving.act = act; },
      goTo: () => this.preferences.goTo,
      jump: (from, source) => {
        void this.goTo(from, source).catch(error => this.warn("Could not open the other panel: " + String(error)));
      },
    };
    const activityDocument = new NativeDocument(document, "activity", this.timestamps, this.theme, timestampGutter, showTimestamps,
      () => this.activate("activity"), false, index, this.copy, showCopyButtons,
      () => ({ compact: this.preferences.compactTools, group: this.preferences.groupTools }), this.getTools,
      () => { if (this.activity) this.activity.scrollTo(this.activity.scrollTop, { disableFollow: true }); }, () => this.preferences.buttonStyle, {
        enabled: () => this.preferences.streamTools, delay: () => this.preferences.streamDelay * 1000,
        changed: () => this.host?.requestRender(),
      }, acts);
    const chatDocument = new NativeDocument(document, "chat", this.timestamps, this.theme, timestampGutter, showTimestamps,
      () => this.activate("chat"), false, index, this.copy, showCopyButtons, undefined, undefined, undefined, () => this.preferences.buttonStyle,
      undefined, acts);
    this.documents = { activity: activityDocument, chat: chatDocument };
    this.disposeDocuments = () => {
      activityDocument.dispose();
      chatDocument.dispose();
    };
    // Combined history keeps the original native document, renderer and scroll state.
    const scrollOptions = {
      follow: "end" as const,
      overscroll: "contain" as const,
      scrollbar: scroll.scrollbar,
      scrollbarTrackStyle: scroll.scrollbarTrackStyle,
      scrollbarThumbStyle: scroll.scrollbarThumbStyle,
    };
    this.activity = new PanelScrollView(activityDocument, scrollOptions, () => this.activate("activity"),
      () => this.searchPane() === "activity");
    this.chat = new PanelScrollView(chatDocument, scrollOptions, () => this.activate("chat"), () => this.searchPane() === "chat");
    // Each document renders only the history near its panel's viewport from the previous layout.
    for (const [document, view] of [[activityDocument, this.activity], [chatDocument, this.chat]] as const) {
      document.setViewport(() => view.viewportHeight ?
        { top: view.scrollTop, height: view.viewportHeight, following: view.isFollowingEnd } : undefined, () => this.host?.requestRender());
    }
    let historyHeight = 0;
    let chatHeader: Component;
    let activityHeader: Component;
    let projectSurface = false;
    // Every root entry asks in turn during one visibility pass; evaluate the projection once.
    let pass: { width: number; height: number; shown: boolean } | undefined;
    const shown = (viewport: { width: number; height: number }): boolean => {
      if (pass?.width === viewport.width && pass.height === viewport.height) return pass.shown;
      pass = { ...viewport, shown: evaluate(viewport) };
      return pass.shown;
    };
    const evaluate = ({ width, height }: { width: number; height: number }): boolean => {
      // Width-only stack rendering during external-editor handoff has no viewport height bound.
      height = Math.min(height, Math.max(1, host.terminal.rows));
      const previousHeight = historyHeight;
      const candidate = !!projectedDock && (widgetsPresent() || dialogPresent()) && dockUnchanged() && !this.failed &&
        this.preferences.mode === "split" && this.preferences.zoom !== "chat";
      projectDialog = candidate && dialogPresent();
      historyHeight = Math.max(0, height - (candidate ? projectedDock : dock).render(width).length - toolbar.render(width).length);
      const search = this.search;
      if (search && previousHeight !== historyHeight) queueMicrotask(() => {
        if (this.search === search) search.bar.reposition();
      });
      this.automaticHeight = Math.max(MIN_ROWS, Math.floor(historyHeight / 2));
      const chatWidth = this.preferences.zoom || this.preferences.layout === "rows" ? width : Math.min(width - MIN_ACTIVITY - 1,
        Math.max(MIN_CHAT, this.preferences.chatWidth ?? this.defaultWidth(width)));
      const activityWidth = this.preferences.zoom || this.preferences.layout === "rows" ? width : width - chatWidth - 1;
      const chatSearch = this.search?.pane === "chat" ? PANEL_SEARCH_ROWS : 0;
      const activitySearch = this.search?.pane === "activity" ? PANEL_SEARCH_ROWS : 0;
      const chatMin = Math.max(MIN_ROWS + chatSearch, chatHeader.render(Math.max(1, chatWidth)).length + 1);
      const activityMin = Math.max(MIN_ROWS + activitySearch, activityHeader.render(Math.max(1, activityWidth)).length + 1);
      const fits = this.preferences.zoom ? width >= MIN_CHAT && historyHeight >= (this.preferences.zoom === "chat" ? chatMin : activityMin) :
        this.preferences.layout === "columns" ? width >= MIN_CHAT + MIN_ACTIVITY + 1 && historyHeight >= Math.max(chatMin, activityMin) :
          width >= MIN_CHAT && historyHeight >= chatMin + activityMin + 1;
      this.fallback = this.preferences.mode === "split" && !fits;
      projectSurface = candidate && fits;
      if (this.search && (this.fallback || this.failed || this.preferences.mode !== "split" ||
        (this.preferences.zoom && this.preferences.zoom !== this.search.pane))) this.closeSearch(false);
      this.searchShortcut.sync(!this.failed && this.preferences.mode === "split" && fits);
      if (this.failed) return false;
      try {
        if (this.preferences.mode !== "split" || !fits) return false;
        // Both panels project the same native history and supported content kinds.
        activityDocument.check();
        if (projectSurface && surfaceTree && surfacePresent()) {
          const widgetWidth = activityWidth;
          const chatLimit = Math.max(chatMin, Math.min((this.preferences.chatHeight ?? this.automaticHeight) + chatSearch,
            historyHeight - activityMin - 1));
          const activityHeight = this.preferences.zoom || this.preferences.layout === "columns" ? historyHeight :
            historyHeight - 1 - Math.min(chatLimit, Math.max(chatMin, chatPane.render(width).length));
          // Do not clip opaque interactive surfaces: their own wheel handlers may consume scrolling.
          // If the entire surface cannot fit, leave Pi's original dock available instead.
          const budget = Math.max(0, activityHeight - activityHeader.render(widgetWidth).length);
          if (surfaceTree.render(widgetWidth).length > budget) {
            projectSurface = false;
            this.fallback = true;
            return false;
          }
        }
        this.activity?.setScrollbar(scroll.scrollbar);
        this.chat?.setScrollbar(scroll.scrollbar);
        columns.sizeConversation(chatPane, this.preferences.chatWidth ?? this.defaultWidth(width));
        // Keep short Conversation intact; shrink Activity first when history fills up.
        rows.limitConversation(chatPane, Math.max(chatMin,
          Math.min((this.preferences.chatHeight ?? this.automaticHeight) + chatSearch,
            historyHeight - activityMin - 1)), chatMin, activityMin);
        return true;
      } catch (error) {
        projectSurface = false;
        this.fail(error);
        return false;
      }
    };
    const headers: ButtonStack[] = [];
    const toolbar = new ButtonStack([
      { component: this.button(
        () => this.preferences.mode === "combined" || this.fallback || this.failed ? (this.preferences.buttonStyle === "icons" ? "◫" : "Split") : (this.preferences.buttonStyle === "icons" ? "▣" : "Combine"),
        () => this.toggle(), () => !this.fallback && !this.failed,
      ), basis: TOOLBAR_BUTTON_WIDTH + 1, minSize: TOOLBAR_BUTTON_WIDTH, shrink: 1 },
      { component: this.button(
        () => this.preferences.layout === "columns" ? (this.preferences.buttonStyle === "icons" ? "▤" : "Rows") : (this.preferences.buttonStyle === "icons" ? "▥" : "Columns"),
        () => this.setLayout(this.preferences.layout === "columns" ? "rows" : "columns"), () => !this.failed,
      ), basis: TOOLBAR_BUTTON_WIDTH + 1, minSize: TOOLBAR_BUTTON_WIDTH, shrink: 1 },
      { component: this.button(
        () => this.preferences.buttonStyle === "icons" ? (this.preferences.layout === "columns" ? "↔" : "↕") : "Swap", () => this.swap(),
        () => this.preferences.mode === "split" && !this.preferences.zoom && !this.fallback && !this.failed,
      ), basis: TOOLBAR_BUTTON_WIDTH + 1, minSize: TOOLBAR_BUTTON_WIDTH, shrink: 1 },
      { component: this.button(() => this.preferences.buttonStyle === "icons" ? "≡" : "Settings", this.openSettings), basis: TOOLBAR_BUTTON_WIDTH, shrink: 0 },
    ], [
      { index: 0, icon: 6 },
      { index: 1, icon: 6 },
      { index: 2, icon: 6 },
      { index: 3, icon: 5 },
    ]);
    const pane = (title: string, target: Pane, view: ScrollView): Component => {
      const hue = target === "chat" ? rgbColor(104, 158, 115) : rgbColor(107, 152, 190);
      let colors: { inputs: unknown[]; palette: { fill: Color; text: Color; border: Color } } | undefined;
      // Mixed colors keep their identity while the theme is unchanged, so memoized controls can compare them.
      const palette = () => {
        const theme = this.theme();
        const inputs = [theme, theme.colors.customMessageBg, theme.colors.text, theme.colors.border];
        if (!colors || !sameValues(colors.inputs, inputs)) colors = { inputs, palette: {
          fill: mixColors(theme.colors.customMessageBg, hue, 0.15, "srgb"),
          text: mixColors(theme.colors.text, hue, 0.25),
          border: mixColors(theme.colors.border, hue, 0.3),
        } };
        return colors.palette;
      };
      const line = memoized(width => [width, this.theme(), palette()],
        width => [this.theme().style("─".repeat(width), { fg: palette().border })]);
      const label = new ButtonStack([
        { component: new MouseRegion(memoized(width => [width, this.theme(), palette(), this.searchPane() === target],
          width => new Text(this.theme().style(truncateToWidth(width < title.length + 3 ? title : " " + (this.searchPane() === target ? "● " : " ") + title, width, "").padEnd(width), {
            fg: this.searchPane() === target ? "accent" : palette().text, bg: palette().fill,
          }), 0, 0).render(width)), event => {
          if (event.button === "left" && (event.type === "press" || event.type === "click")) {
            this.activate(target);
            return { handled: true, render: true };
          }
          return undefined;
        }), basis: 0, grow: 1, minSize: title.length },
        ...(target === "activity" ? [{ component: this.button(
          () => this.preferences.compactTools ? (this.preferences.buttonStyle === "icons" ? "⊞" : "Full tools") : (this.preferences.buttonStyle === "icons" ? "⊟" : "Compact tools"),
          () => {
            this.activate("activity");
            this.setCompactTools(!this.preferences.compactTools);
          }, () => true, () => palette().fill,
        ), basis: 6, minSize: 5, shrink: 1 }] : []),
        { component: this.button(() => this.preferences.buttonStyle === "icons" ? "⌕" : "Find", () => {
          this.activate(target);
          this.openSearch(target);
        }, () => true, () => palette().fill), basis: TOOLBAR_BUTTON_WIDTH + 1, minSize: TOOLBAR_BUTTON_WIDTH, shrink: 1 },
        { component: this.button(
          () => this.preferences.zoom === target ? (this.preferences.buttonStyle === "icons" ? "↙" : "Restore") : (this.preferences.buttonStyle === "icons" ? "↗" : "Maximize"),
          () => this.maximize(target), () => true, () => palette().fill,
        ), basis: 5, shrink: 0 },
      ], target === "activity" ? [
        { index: 1, icon: 6 },
        { index: 2, icon: 6 },
        { index: 3, icon: 5 },
      ] : [
        { index: 1, icon: 6 },
        { index: 2, icon: 5 },
      ], title.length, memoized(width => [width, this.theme(), palette()],
        width => [this.theme().style(" ".repeat(width), { bg: palette().fill })]));
      headers.push(label);
      const header = new VStack([
        { component: line, basis: 1, shrink: 0, visible: () =>
          this.preferences.zoom !== null || this.preferences.layout === "columns" ||
          (this.preferences.side === "left" ? target === "chat" : target === "activity") },
        { component: label, basis: "auto", shrink: 0 },
        { component: line, basis: 1, shrink: 0 },
        { component: this.searchRows[target], basis: "auto", shrink: 0,
          visible: () => this.search?.pane === target },
      ]);
      if (target === "chat") chatHeader = header;
      else activityHeader = header;
      return new TranscriptPane(header, view, () => historyHeight,
        target === "activity" ? surfaceView : undefined, () => projectSurface && surfacePresent());
    };
    const activityPane = pane("Activity", "activity", this.activity);
    const chatPane = pane("Conversation", "chat", this.chat);
    const divider = (axis: "columns" | "rows"): Component => new MouseRegion(memoized(width => [width, host.terminal.rows, this.theme()],
      width => axis === "columns" ?
        Array.from({ length: host.terminal.rows }, () => this.theme().fg("dim", "║")) :
        [this.theme().fg("dim", "═".repeat(width))]), event => {
      if (event.button !== "left" && event.type !== "release") return;
      const position = axis === "columns" ? event.screenX : event.screenY;
      if (event.type === "press") {
        const before = this.preferences.side === "left";
        const size = axis === "columns" ?
          (before ? position : host.terminal.columns - position - 1) :
          this.currentHeight();
        this.drag = { position, size };
        return { capture: true };
      }
      if (event.type === "drag" && this.drag) {
        const delta = position - this.drag.position;
        const size = this.drag.size + (this.preferences.side === "left" ? delta : -delta);
        if (axis === "columns") this.setWidth(size, false);
        else this.setHeight(size, false);
        return { handled: true };
      }
      if (event.type === "release" && this.drag) {
        this.drag = undefined;
        this.save();
        return { handled: true };
      }
      return undefined;
    });
    const columnDivider = divider("columns");
    const rowDivider = divider("rows");
    const columns = new TranscriptColumns();
    const rows = new TranscriptRows();
    this.rebuild = (): void => {
      toolbar.setStyle(this.preferences.buttonStyle);
      for (const header of headers) header.setStyle(this.preferences.buttonStyle);
      for (const [stack, axis] of [[columns, "columns"], [rows, "rows"]] as const) {
        stack.clear();
        const minimum = axis === "columns" ? MIN_CHAT : MIN_ROWS;
        const chatEntry = {
          component: chatPane, basis: axis === "columns" ? this.preferences.chatWidth ?? MIN_CHAT : "auto" as const,
          maxSize: axis === "rows" ? this.preferences.chatHeight ?? undefined : undefined,
          minSize: minimum, shrink: axis === "columns" ? 1 : 0,
        };
        const activityEntry = {
          component: activityPane, basis: axis === "columns" ? 0 : "auto" as const,
          grow: axis === "columns" ? 1 : 0, minSize: axis === "columns" ? MIN_ACTIVITY : MIN_ROWS,
        };
        const first = this.preferences.side === "left" ? chatEntry : activityEntry;
        const second = this.preferences.side === "left" ? activityEntry : chatEntry;
        stack.addChild(first.component, first);
        stack.addChild(axis === "columns" ? columnDivider : rowDivider, { basis: 1, shrink: 0 });
        stack.addChild(second.component, second);
      }
    };
    this.rebuild();
    const surface = new SplitSurface(host, {
      model: () => {
        const zoom = this.preferences.zoom;
        if (zoom) return { component: zoom === "chat" ? chatPane : activityPane, fill: false, minSize: MIN_ROWS };
        return this.preferences.layout === "columns" ? { component: columns, fill: true, minSize: 1 } : { component: rows, fill: false, minSize: 1 };
      },
      height: () => historyHeight,
      active: () => {
        const pane = this.searchPane();
        return pane === "chat" ? this.chat : pane === "activity" ? this.activity : undefined;
      },
      failed: error => this.fail(error),
      pointer: {
        start: () => { this.moving = { act: 0 }; },
        end: () => {
          const act = this.moving?.act ?? 0;
          this.moving = undefined;
          this.setHover(act);
        },
        leave: () => this.setHover(0),
      },
    });
    surface.setModels([columns, rows, activityPane, chatPane]);
    this.surface = surface;
    const mounted = new TranscriptRoot([
      { component: toolbar, basis: "auto", shrink: 0, visible: () => {
        // Root visibility is evaluated once at the start of each native layout pass.
        pass = undefined;
        // An error here would reach Pi's render loop and end Pi; stop the split instead.
        try {
          this.timestamps.beginFrame();
          // Combined history draws Pi's own document, so the shared index waits until the split is shown again.
          // Pi-Bolt can then keep releasing the settled messages it draws itself.
          if (this.preferences.mode === "split" && !this.failed) {
            index.beginFrame();
            activityDocument.beginFrame(true);
            chatDocument.beginFrame(true);
          }
        } catch (error) {
          this.fail(error);
        }
        return true;
      } },
      { component: {
        render: width => [this.theme().style("─".repeat(width), { fg: this.theme().colors.border })],
        invalidate() {},
      }, basis: 1, shrink: 0, visible: viewport => !shown(viewport) },
      // The split paints as one full-width row block; the proxy gives Pi's keyboard scrolling the active panel.
      { component: surface, basis: "auto", minSize: 1, visible: viewport => shown(viewport) },
      { component: surface.proxy, basis: 0, shrink: 0, visible: viewport => shown(viewport) },
      { component: transcript, basis: 0, grow: 1, minSize: 1, visible: viewport => !shown(viewport) },
      ...(projectedDock ? [{ component: projectedDock, basis: "auto" as const, shrink: 0, minSize: 1,
        visible: () => projectSurface }] : []),
      { component: dock, basis: "auto", shrink: 0, minSize: 1, visible: () => !projectSurface },
    ], event => surface.unhandled(event));
    this.mounted = mounted;
    host.setLayoutRoot(mounted);
    host.requestRender();
    this.queryBackground(host);
  }

  /** Ask the terminal for its background once; act colors use a guess from the theme until it answers. */
  private queryBackground(host: NativeTui): void {
    if (this.terminalBackground || typeof host.queryTerminalColors !== "function") return;
    void host.queryTerminalColors({ timeoutMs: 1000 }).then(colors => {
      if (!colors.background || this.host !== host) return;
      this.terminalBackground = colors.background;
      host.requestRender();
    }, () => {});
  }

  /** Pi reports pointer motion for hover only outside terminal multiplexers and with its mouse support on. */
  hoverAvailable(): boolean {
    return pointerMotionAvailable(this.host);
  }

  /** Highlight another act; pointer moves within one act render nothing. */
  private setHover(act: number): void {
    const next = act || undefined;
    if (next === this.hoverAct) return;
    this.hoverAct = next;
    if (this.preferences.actHover && this.hoverAvailable()) this.host?.requestRender();
  }

  /** Scroll the other panel to the same point of history as a block, returning from a zoomed panel first. */
  async goTo(from: Pane, source: Component): Promise<void> {
    const target = this.index?.counterpart(source, from);
    if (!target || !this.searchPane()) return;
    const pane: Pane = from === "chat" ? "activity" : "chat";
    if (this.preferences.zoom) {
      this.preferences.zoom = null;
      this.changed(false);
      // The restored panel needs a layout pass for its viewport.
      await setImmediate();
    }
    const document = this.documents?.[pane];
    const view = pane === "chat" ? this.chat : this.activity;
    if (!document || !view || !this.searchPane()) return;
    this.activate(pane);
    const row = document.locate(target);
    if (row === undefined) return;
    view.scrollTo(Math.max(0, row - 1), { disableFollow: true });
    this.host?.requestRender();
  }

  private activate(pane: Pane): void {
    if (this.activePane === pane) return;
    this.activePane = pane;
    this.host?.requestRender();
  }

  /** Choose the last interacted pane only while a supported split is mounted. */
  searchPane(): Pane | undefined {
    if (!this.host || this.host.layoutRoot !== this.mounted || this.failed || this.fallback ||
      this.preferences.mode !== "split") return undefined;
    return this.preferences.zoom ?? this.activePane;
  }

  /** Offer block copying only from a currently visible split panel. */
  copyBlocks(): ReturnType<NativeDocument["copyBlocks"]> {
    const pane = this.searchPane();
    return pane ? this.documents?.[pane].copyBlocks() ?? [] : [];
  }
  private canFocusSearch(): boolean {
    const focused = this.host?.getFocusedComponent();
    if (!focused || focused === this.search?.bar.input) return true;
    const editor = this.getEditor();
    if (editor) return focused === editor;
    const dock = this.original?.children[1];
    const pending = dock ? [dock] : [];
    const visited = new Set<Component>();
    while (pending.length) {
      const component = pending.pop()!;
      if (component === focused) return true;
      if (visited.has(component)) continue;
      visited.add(component);
      if (component instanceof Container) pending.push(...component.children);
    }
    return false;
  }

  /** Open the inline field, or leave another active interface's focus untouched. */
  openSearch(pane: Pane): boolean {
    const host = this.host;
    const document = this.documents?.[pane];
    const view = pane === "chat" ? this.chat : this.activity;
    if (!host || !document || !view || !this.searchPane() || !this.canFocusSearch()) return false;
    if (this.search?.pane === pane) {
      this.search.bar.focus();
      host.requestRender();
      return true;
    }
    this.closeSearch();
    this.activate(pane);
    const bar = new PanelSearch(() => document.searchEntries(), host, this.theme, (hit, query) => {
      const version = ++this.searchVersion;
      if (!hit) {
        document.clearSearch();
        host.requestRender();
        return;
      }
      void this.jumpToSearch(pane, hit, query, () => this.search?.bar === bar && this.searchVersion === version)
        .catch(error => this.warn("Could not navigate search: " + String(error)));
    }, () => this.closeSearch(), this.preferences.buttonStyle);
    this.search = { pane, bar, document, view, top: view.scrollTop, following: view.isFollowingEnd,
      focus: host.getFocusedComponent() };
    this.searchRows[pane].addChild(bar);
    bar.focus();
    host.requestRender();
    return true;
  }

  /** Rebuild the open search index only after saved history changes. */
  refreshSearch(): void { this.search?.bar.markDirty(); }

  /** Remove transient search state and optionally restore pre-search scrolling. */
  closeSearch(restore = true): void {
    if (!restore) this.restoreVersion++;
    const restoreVersion = this.restoreVersion;
    const search = this.search;
    const host = this.host;
    if (!search || !host) return;
    this.search = undefined;
    this.searchVersion++;
    this.searchRows[search.pane].clear();
    search.document.clearSearch();
    search.bar.retire(() => {
      if (host.getFocusedComponent() === search.bar.input) {
        host.setFocus(search.focus);
        host.requestRender();
      }
    });
    if (host.getFocusedComponent() === search.bar.input) host.setFocus(search.focus);
    host.requestRender();
    if (!restore) return;
    // Removing the row changes viewport height. Restore after native layout settles.
    void setImmediate().then(() => {
      if (this.restoreVersion !== restoreVersion || this.host !== host ||
        this.documents?.[search.pane] !== search.document || this.search?.pane === search.pane) return;
      if (search.following) search.view.scrollToEnd();
      else search.view.scrollTo(search.top, { disableFollow: true });
      host.requestRender();
    });
  }

  /** Reveal and scroll one current result, leaving the other panel alone. */
  async jumpToSearch(pane: Pane, hit: SearchHit, query = "", current = (): boolean => true): Promise<void> {
    const document = this.documents?.[pane];
    const view = pane === "chat" ? this.chat : this.activity;
    if (!document || !view || !this.searchPane() || !current() || !document.reveal(hit, query)) return;
    this.activate(pane);
    this.host?.requestRender();
    await setImmediate();
    if (!current() || this.documents?.[pane] !== document || !this.searchPane() || !document.containsSearchHit(hit)) return;
    let row = document.searchRow(hit);
    if (row === undefined) {
      document.showSearchExcerpt(hit);
      this.host?.requestRender();
      await setImmediate();
      if (!current() || this.documents?.[pane] !== document || !this.searchPane() || !document.containsSearchHit(hit)) return;
      row = document.searchRow(hit);
    }
    if (row === undefined) {
      this.warn("The selected search result is no longer in the current history.");
      return;
    }
    view.scrollTo(Math.max(0, row - Math.min(2, Math.max(0, view.viewportHeight - 1))), { disableFollow: true });
    this.host?.requestRender();
  }
  private changed(persist = true): void {
    this.searchShortcut.sync(Boolean(this.searchPane()));
    this.rebuild();
    this.host?.requestRender();
    if (persist) this.save();
  }

  /** Color the blocks of each act: behind the clock, as a stripe, as a background, or not at all. */
  setActColors(colors: Preferences["actColors"]): void {
    this.preferences.actColors = colors;
    this.changed();
  }

  /** Highlight the act under the pointer in both panels. */
  setActHover(hover: boolean): void {
    this.preferences.actHover = hover;
    this.changed();
  }

  /** Open the other panel from a block's clock, its button, both or neither. */
  setGoTo(goTo: Preferences["goTo"]): void {
    this.preferences.goTo = goTo;
    this.changed();
  }

  /** Show or hide clock rows without changing their recorded source times. */
  setTimestamps(show: boolean): void {
    this.preferences.showTimestamps = show;
    this.changed();
  }

  /** Hide copy icons without disabling the keyboard copy picker. */
  setCopyButtons(show: boolean): void {
    this.preferences.showCopyButtons = show;
    this.changed();
  }

  /** Change the presentation of toolbar, header and copy controls. */
  setButtonStyle(style: "icons" | "text"): void {
    this.preferences.buttonStyle = style;
    this.changed();
  }

  /** Project tool calls as dense rows while retaining their full search and copy text. */
  setCompactTools(compact: boolean): void {
    this.preferences.compactTools = compact;
    this.changed();
  }

  /** Merge adjacent calls of one tool in one state under a counted header, with or without compact rows. */
  setGroupTools(group: boolean): void {
    this.preferences.groupTools = group;
    this.changed();
  }

  /** Show nested calls as a tree, or keep the parent's native output panel. */
  setNestedTree(tree: boolean): void {
    this.preferences.nestedTree = tree;
    this.changed();
  }

  /** Show the latest tool calls in full while Compact or Group would hide them, until they have been finished for the delay. */
  setStreamTools(stream: boolean): void {
    this.preferences.streamTools = stream;
    this.changed();
  }

  /** Seconds a finished streamed call stays in full before collapsing. */
  setStreamDelay(seconds: number): void {
    this.preferences.streamDelay = Math.max(1, Math.min(300, Math.trunc(seconds)));
    this.changed();
  }
  private defaultWidth(width: number): number {
    return Math.max(MIN_CHAT, Math.floor((width - 1) * 0.2));
  }

  /** Set the requested conversation width without discarding the stacked height. */
  setWidth(width: number, persist = true): void {
    this.preferences.chatWidth = Math.max(MIN_CHAT, Math.min(240, Math.trunc(width)));
    this.changed(persist);
  }

  /** Set a manual maximum including the header, or null for automatic half-height. */
  setHeight(height: number | null, persist = true): void {
    this.preferences.chatHeight = height === null ? null : Math.max(MIN_ROWS, Math.min(240, Math.trunc(height)));
    this.changed(persist);
  }

  private currentHeight(): number {
    if (this.preferences.layout === "rows" && !this.preferences.zoom && this.chat?.viewportHeight) {
      return this.chat.viewportHeight + (this.preferences.side === "left" ? 3 : 2);
    }
    return this.preferences.chatHeight ?? this.automaticHeight;
  }

  /** Enable automatic height, or freeze the current rendered height as a manual limit. */
  setAutomaticHeight(automatic: boolean): void {
    this.setHeight(automatic ? null : this.currentHeight());
  }

  /** Resize the conversation along the selected split axis. */
  resize(direction: number): void {
    if (this.preferences.layout === "columns") {
      this.setWidth((this.preferences.chatWidth ?? this.defaultWidth(this.host?.terminal.columns ?? 0)) + direction * 4);
    } else this.setHeight((this.preferences.chatHeight ?? this.currentHeight()) + direction);
  }

  /** Choose a split layout and return from combined or expanded history. */
  setLayout(layout: Preferences["layout"]): void {
    this.drag = undefined;
    this.preferences.layout = layout;
    this.preferences.mode = "split";
    this.preferences.zoom = null;
    this.changed();
  }

  /** Expand or restore one panel while retaining its requested split arrangement. */
  maximize(pane: Pane): void {
    this.activate(pane);
    this.preferences.mode = "split";
    this.preferences.zoom = this.preferences.zoom === pane ? null : pane;
    this.changed();
  }

  /** Switch split and combined history without losing panel sizes or order. */
  toggle(): void {
    this.drag = undefined;
    this.preferences.mode = this.preferences.mode === "split" ? "combined" : "split";
    this.preferences.zoom = null;
    this.changed();
  }

  /** Exchange left/right or top/bottom while keeping each panel's size. */
  swap(): void {
    this.drag = undefined;
    this.preferences.side = this.preferences.side === "left" ? "right" : "left";
    this.changed();
  }

  /** Cycle keyboard scrolling and search to the other panel. */
  cyclePanel(): void {
    const pane = this.searchPane();
    if (!pane || this.preferences.zoom) return;
    this.activate(pane === "chat" ? "activity" : "chat");
  }

  /** Scroll one native pane without moving the other. */
  scroll(pane: Pane, lines: number): void {
    (pane === "chat" ? this.chat : this.activity)?.scrollBy(lines);
    this.host?.requestRender();
  }

  /** Release owned views and restore the original tree only if still mounted. */
  dispose(): void {
    this.closeSearch(false);
    this.searchShortcut.dispose();
    this.disposeDocuments?.();
    this.disposeDocuments = undefined;
    this.surface?.dispose();
    this.surface = undefined;
    const host = this.host;
    this.activity?.setScrollbar("hidden");
    this.chat?.setScrollbar("hidden");
    if (host && host.layoutRoot === this.mounted) host.setLayoutRoot(this.original);
    this.host?.requestRender();
    this.host = undefined;
    this.mounted = undefined;
    this.original = undefined;
    this.activity = undefined;
    this.chat = undefined;
    this.documents = undefined;
    this.index = undefined;
    this.hoverAct = undefined;
    this.moving = undefined;
    this.drag = undefined;
    this.rebuild = () => {};
  }
}
