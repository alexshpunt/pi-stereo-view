import { setImmediate } from "node:timers/promises";
import type { Theme } from "@earendil-works/pi-coding-agent";
import {
  Container, HStack, isViewportTUI, mixColors, MouseRegion, rgbColor, ScrollView, Text, truncateToWidth, VStack,
  type Color, type Component, type ScrollViewOptions, type StackChild, type TUI, type TuiMouseEvent,
} from "@earendil-works/pi-tui";
import { NativeDocument, type Pane } from "./native.js";
import type { Preferences } from "./preferences.js";
import type { TranscriptTimestamps } from "./timestamps.js";
import { PanelSearchShortcut, type SearchEntry, type SearchHit } from "./search.js";

type NativeTui = TUI & { layoutRoot?: Container; setLayoutRoot(component: Component | undefined): void };
const MIN_CHAT = 24;
const MIN_ACTIVITY = 40;
const MIN_ROWS = 4;
const BUTTON_WIDTH = 5;

class PanelScrollView extends ScrollView {
  constructor(component: Component, options: ScrollViewOptions, private readonly interact: () => void) {
    super(component, options);
  }

  override handleMouse(event: TuiMouseEvent): ReturnType<Container["handleMouse"]> {
    if (event.type === "wheel" || (event.type === "press" && event.button === "left")) this.interact();
    return super.handleMouse(event);
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
  limitConversation(component: Component, height: number): void {
    const entry = this.entries.find(entry => entry.component === component);
    if (entry) entry.maxSize = height;
  }
}

class TranscriptPane extends VStack {
  constructor(private readonly header: Component, private readonly view: ScrollView, private readonly height: () => number) {
    super([
      { component: header, basis: "auto", shrink: 0 },
      { component: view, basis: "auto", grow: 1, minSize: 1 },
    ]);
  }

  override render(width: number): string[] {
    // Native layout measures height here, then paints the original header and ScrollView.
    // Empty preview rows avoid composing colored history text in ancestor measurements.
    const headerRows = this.header.render(width).length;
    const contentRows = this.view.children[0].render(this.view.getContentWidth(width)).length;
    const available = Math.max(1, this.height() - headerRows);
    return Array<string>(headerRows + Math.min(contentRows, available)).fill("");
  }
}

class TranscriptRoot extends VStack {
  constructor(children: StackChild[], private readonly source: Container, private readonly nativeScroll: ScrollView) { super(children); }

  override invalidate(): void {
    // The same history is projected into several visible and hidden layout entries.
    // After guarded fallback the native ScrollView already owns that invalidation.
    if (this.nativeScroll.children[0] !== this.source) this.source.invalidate();
    super.invalidate();
  }
}
/** Own only guarded fullscreen history controls; never replace the input dock. */
export class TranscriptLayout {
  private host?: NativeTui;
  private original?: Container;
  private mounted?: Component;
  private activity?: ScrollView;
  private chat?: ScrollView;
  private documents?: Record<Pane, NativeDocument>;
  private disposeDocuments?: () => void;
  private activePane: Pane = "chat";
  private readonly searchShortcut = new PanelSearchShortcut();
  private drag?: { position: number; size: number };
  private failed = false;
  private fallback = false;
  private automaticHeight = MIN_ROWS;
  private readonly rejectedRoots = new WeakSet<Component>();
  private rebuild = (): void => {};
  private restoreDocument = (): void => {};

  constructor(
    readonly preferences: Preferences,
    private readonly theme: () => Theme,
    private readonly warn: (message: string) => void,
    private readonly save: () => void,
    private readonly timestamps: TranscriptTimestamps,
    private readonly openSettings: () => void,
    private readonly openSearch: (pane: Pane) => void,
  ) {}

  private button(icon: () => string, action: () => void, enabled = (): boolean => true, background?: () => Color): Component {
    return new MouseRegion({
      render: width => new Text(this.theme().style("[ " + icon() + " ]", {
        fg: enabled() ? "accent" : "dim", bg: background?.(),
      }), 0, 0).render(width),
      invalidate() {},
    }, event => {
      if (event.button !== "left") return;
      if (event.type === "press") return { capture: true };
      if (event.type === "click" && enabled() && event.x >= 0 && event.x < event.width && event.y === 0) {
        action();
        return { handled: true, render: true };
      }
      return { handled: true };
    });
  }

  /** Mount controls only on a compatible native fullscreen history tree. */
  attach(tui: TUI): void {
    if (!isViewportTUI(tui)) {
      this.dispose();
      return;
    }
    const host = tui as NativeTui;
    if (host.layoutRoot === this.mounted && this.host) return;
    const root = host.layoutRoot;
    if (this.host) this.dispose();
    if (root && this.rejectedRoots.has(root)) return;
    if (!root || root.constructor.name !== "VStack" || root.children.length !== 2) {
      if (root) this.rejectedRoots.add(root);
      this.warn("Transcript split is unavailable: Pi's fullscreen layout is not supported.");
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
      this.warn("Transcript split is unavailable: Pi's history document is not supported.");
      return;
    }
    this.host = host;
    this.original = root;
    this.failed = false;
    // Auto scrollbars overlay one native content column; keep clocks outside it.
    const timestampGutter = (): number => scroll.scrollbar === "auto" ? 1 : 0;
    const showTimestamps = (): boolean => this.preferences.showTimestamps;
    const activityDocument = new NativeDocument(document, "activity", this.timestamps, this.theme, timestampGutter, showTimestamps,
      () => this.activate("activity"), false);
    const chatDocument = new NativeDocument(document, "chat", this.timestamps, this.theme, timestampGutter, showTimestamps,
      () => this.activate("chat"), false);
    this.documents = { activity: activityDocument, chat: chatDocument };
    const combinedDocument = new NativeDocument(document, "combined", this.timestamps, this.theme, timestampGutter, showTimestamps,
      undefined, false);
    this.disposeDocuments = () => {
      activityDocument.dispose();
      chatDocument.dispose();
      combinedDocument.dispose();
    };
    // Keep the native combined ScrollView, including its selection and scroll state.
    owner.child = combinedDocument;
    owner.children[0] = combinedDocument;
    this.restoreDocument = () => {
      if (owner.child === combinedDocument) owner.child = document;
      if (owner.children[0] === combinedDocument) owner.children[0] = document;
    };
    const scrollOptions = {
      follow: "end" as const,
      overscroll: "contain" as const,
      scrollbar: scroll.scrollbar,
      scrollbarTrackStyle: scroll.scrollbarTrackStyle,
      scrollbarThumbStyle: scroll.scrollbarThumbStyle,
    };
    this.activity = new PanelScrollView(activityDocument, { ...scrollOptions, primary: true }, () => this.activate("activity"));
    this.chat = new PanelScrollView(chatDocument, scrollOptions, () => this.activate("chat"));
    let historyHeight = 0;
    const shown = ({ width, height }: { width: number; height: number }): boolean => {
      historyHeight = Math.max(0, height - dock.render(width).length - 1);
      this.automaticHeight = Math.max(MIN_ROWS, Math.floor(historyHeight / 2));
      const fits = this.preferences.zoom ? width >= MIN_CHAT && historyHeight >= MIN_ROWS :
        this.preferences.layout === "columns" ? width >= MIN_CHAT + MIN_ACTIVITY + 1 && historyHeight >= MIN_ROWS :
          width >= MIN_CHAT && historyHeight >= MIN_ROWS * 2 + 1;
      this.fallback = this.preferences.mode === "split" && !fits;
      this.searchShortcut.sync(!this.failed && this.preferences.mode === "split" && fits);
      if (this.failed) return false;
      try {
        // Both panels project the same native history and supported content kinds.
        activityDocument.check();
        if (this.preferences.mode !== "split" || !fits) return false;
        this.activity?.setScrollbar(scroll.scrollbar);
        this.chat?.setScrollbar(scroll.scrollbar);
        columns.sizeConversation(chatPane, this.preferences.chatWidth ?? this.defaultWidth(width));
        // Keep short Conversation intact; shrink Activity first when history fills up.
        rows.limitConversation(chatPane, Math.max(MIN_ROWS,
          Math.min(this.preferences.chatHeight ?? this.automaticHeight, historyHeight - MIN_ROWS - 1)));
        return true;
      } catch (error) {
        this.failed = true;
        this.searchShortcut.dispose();
        this.restoreDocument();
        this.disposeDocuments?.();
        queueMicrotask(() => this.warn("Transcript split disabled: " + (error as Error).message));
        return false;
      }
    };
    const toolbar = new HStack([
      { component: this.button(
        () => this.preferences.mode === "combined" || this.fallback || this.failed ? "◫" : "▣",
        () => this.toggle(), () => !this.fallback && !this.failed,
      ), basis: BUTTON_WIDTH, shrink: 0 },
      { component: this.button(
        () => this.preferences.layout === "columns" ? "▤" : "▥",
        () => this.setLayout(this.preferences.layout === "columns" ? "rows" : "columns"), () => !this.failed,
      ), basis: BUTTON_WIDTH, shrink: 0 },
      { component: this.button(
        () => this.preferences.layout === "columns" ? "↔" : "↕", () => this.swap(),
        () => this.preferences.mode === "split" && !this.preferences.zoom && !this.fallback && !this.failed,
      ), basis: BUTTON_WIDTH, shrink: 0 },
      { component: this.button(() => "≡", this.openSettings), basis: BUTTON_WIDTH, shrink: 0 },
    ], { gap: 1 });
    const pane = (title: string, target: Pane, view: ScrollView): Component => {
      const hue = target === "chat" ? rgbColor(104, 158, 115) : rgbColor(107, 152, 190);
      const palette = () => {
        const theme = this.theme();
        return {
          fill: mixColors(theme.colors.customMessageBg, hue, 0.15, "srgb"),
          text: mixColors(theme.colors.text, hue, 0.25),
          border: mixColors(theme.colors.border, hue, 0.3),
        };
      };
      const line: Component = {
        render: width => [this.theme().style("─".repeat(width), { fg: palette().border })],
        invalidate() {},
      };
      const label = new HStack([
        { component: new MouseRegion({
          render: width => new Text(this.theme().style(truncateToWidth((this.searchPane() === target ? "● " : " ") + title, width, "").padEnd(width), {
            fg: this.searchPane() === target ? "accent" : palette().text, bg: palette().fill,
          }), 0, 0).render(width),
          invalidate() {},
        }, event => {
          if (event.button === "left" && (event.type === "press" || event.type === "click")) {
            this.activate(target);
            return { handled: true, render: true };
          }
          return undefined;
        }), basis: 0, grow: 1, minSize: 1 },
        { component: this.button(() => "⌕", () => {
          this.activate(target);
          this.openSearch(target);
        }, () => true, () => palette().fill), basis: BUTTON_WIDTH, shrink: 0 },
        { component: this.button(
          () => this.preferences.zoom === target ? "↙" : "↗",
          () => this.maximize(target), () => true, () => palette().fill,
        ), basis: BUTTON_WIDTH, shrink: 0 },
      ]);
      const header = new VStack([
        { component: line, basis: 1, shrink: 0, visible: () =>
          this.preferences.zoom !== null || this.preferences.layout === "columns" ||
          (this.preferences.side === "left" ? target === "chat" : target === "activity") },
        { component: label, basis: 1, shrink: 0 },
        { component: line, basis: 1, shrink: 0 },
      ]);
      return new TranscriptPane(header, view, () => historyHeight);
    };
    const activityPane = pane("Activity", "activity", this.activity);
    const chatPane = pane("Conversation", "chat", this.chat);
    const divider = (axis: "columns" | "rows"): Component => new MouseRegion({
      render: width => axis === "columns" ?
        Array.from({ length: host.terminal.rows }, () => this.theme().fg("dim", "║")) :
        [this.theme().fg("dim", "═".repeat(width))],
      invalidate() {},
    }, event => {
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
    const mounted = new TranscriptRoot([
      { component: toolbar, basis: 1, shrink: 0, visible: () => {
        // Root visibility is evaluated once at the start of each native layout pass.
        this.timestamps.beginFrame();
        activityDocument.beginFrame();
        chatDocument.beginFrame();
        combinedDocument.beginFrame();
        return true;
      } },
      { component: columns, basis: 0, grow: 1, minSize: 1,
        visible: viewport => shown(viewport) && !this.preferences.zoom && this.preferences.layout === "columns" },
      { component: rows, basis: "auto", minSize: 1,
        visible: viewport => shown(viewport) && !this.preferences.zoom && this.preferences.layout === "rows" },
      { component: activityPane, basis: "auto", minSize: MIN_ROWS,
        visible: viewport => shown(viewport) && this.preferences.zoom === "activity" },
      { component: chatPane, basis: "auto", minSize: MIN_ROWS,
        visible: viewport => shown(viewport) && this.preferences.zoom === "chat" },
      { component: transcript, basis: 0, grow: 1, minSize: 1, visible: viewport => !shown(viewport) },
      { component: dock, basis: "auto", shrink: 0, minSize: 1 },
    ], document, scroll);
    this.mounted = mounted;
    host.setLayoutRoot(mounted);
    host.requestRender();
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

  /** Read search text from the selected pane's current native branch. */
  searchEntries(pane: Pane): SearchEntry[] { return this.documents?.[pane].searchEntries() ?? []; }

  /** Reveal and scroll one current result, leaving the other pane and follow state alone. */
  async jumpToSearch(pane: Pane, hit: SearchHit): Promise<void> {
    const document = this.documents?.[pane];
    const view = pane === "chat" ? this.chat : this.activity;
    if (!document || !view || !this.searchPane() || !document.reveal(hit)) return;
    this.activate(pane);
    this.host?.requestRender(true);
    await setImmediate();
    if (this.documents?.[pane] !== document || !this.searchPane() || !document.containsSearchHit(hit)) return;
    let row = document.searchRow(hit);
    if (row === undefined) {
      document.showSearchExcerpt(hit);
      this.host?.requestRender(true);
      await setImmediate();
      if (this.documents?.[pane] !== document || !this.searchPane() || !document.containsSearchHit(hit)) return;
      row = document.searchRow(hit);
    }
    if (row === undefined) {
      this.warn("The selected search result is no longer in the current history.");
      return;
    }
    view.scrollTo(Math.max(0, row - 2), { disableFollow: true });
    this.host?.requestRender(true);
  }
  private changed(persist = true): void {
    this.searchShortcut.sync(Boolean(this.searchPane()));
    this.rebuild();
    this.host?.requestRender();
    if (persist) this.save();
  }

  /** Show or hide clock rows without changing their recorded source times. */
  setTimestamps(show: boolean): void {
    this.preferences.showTimestamps = show;
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

  /** Scroll one native pane without moving the other. */
  scroll(pane: Pane, lines: number): void {
    (pane === "chat" ? this.chat : this.activity)?.scrollBy(lines);
    this.host?.requestRender();
  }

  /** Release owned views and restore the original tree only if still mounted. */
  dispose(): void {
    this.searchShortcut.dispose();
    this.restoreDocument();
    this.disposeDocuments?.();
    this.disposeDocuments = undefined;
    this.restoreDocument = () => {};
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
    this.drag = undefined;
    this.rebuild = () => {};
  }
}
