import type { Theme } from "@earendil-works/pi-coding-agent";
import {
  Container, HStack, isViewportTUI, mixColors, MouseRegion, rgbColor, ScrollView, Text, VStack,
  type Color, type Component, type TUI,
} from "@earendil-works/pi-tui";
import { NativeDocument, type Pane } from "./native.js";
import type { Preferences } from "./preferences.js";
import type { TranscriptTimestamps } from "./timestamps.js";

type NativeTui = TUI & { layoutRoot?: Container; setLayoutRoot(component: Component | undefined): void };
const MIN_CHAT = 24;
const MIN_ACTIVITY = 40;
const MIN_ROWS = 4;
const BUTTON_WIDTH = 5;

class TranscriptRows extends VStack {
  /** Limit Conversation while leaving at least one Activity content row. */
  limitConversation(component: Component, height: number): void {
    const entry = this.entries.find(entry => entry.component === component);
    if (entry) entry.maxSize = height;
  }
}

/** Own only guarded fullscreen history controls; never replace the input dock. */
export class TranscriptLayout {
  private host?: NativeTui;
  private original?: Container;
  private mounted?: Component;
  private activity?: ScrollView;
  private chat?: ScrollView;
  private drag?: { position: number; size: number };
  private failed = false;
  private fallback = false;
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
    const activityDocument = new NativeDocument(document, "activity", this.timestamps, this.theme, timestampGutter, showTimestamps);
    const chatDocument = new NativeDocument(document, "chat", this.timestamps, this.theme, timestampGutter, showTimestamps);
    const combinedDocument = new NativeDocument(document, "combined", this.timestamps, this.theme, timestampGutter, showTimestamps);
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
    this.activity = new ScrollView(activityDocument, { ...scrollOptions, primary: true });
    this.chat = new ScrollView(chatDocument, scrollOptions);
    let historyHeight = 0;
    const shown = ({ width, height }: { width: number; height: number }): boolean => {
      historyHeight = Math.max(0, height - dock.render(width).length - 1);
      const fits = this.preferences.zoom ? width >= MIN_CHAT && historyHeight >= MIN_ROWS :
        this.preferences.layout === "columns" ? width >= MIN_CHAT + MIN_ACTIVITY + 1 && historyHeight >= MIN_ROWS :
          width >= MIN_CHAT && historyHeight >= MIN_ROWS * 2 + 1;
      this.fallback = this.preferences.mode === "split" && !fits;
      if (this.failed) return false;
      try {
        activityDocument.check();
        chatDocument.check();
        if (this.preferences.mode !== "split" || !fits) return false;
        this.activity?.setScrollbar(scroll.scrollbar);
        this.chat?.setScrollbar(scroll.scrollbar);
        // Keep short Conversation intact; shrink Activity first when history fills up.
        rows.limitConversation(chatPane, Math.max(MIN_ROWS,
          Math.min(this.preferences.chatHeight, historyHeight - MIN_ROWS - 1)));
        return true;
      } catch (error) {
        this.failed = true;
        this.restoreDocument();
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
        { component: {
          render: width => new Text(this.theme().style((" " + title).padEnd(width), {
            fg: palette().text, bg: palette().fill,
          }), 0, 0).render(width),
          invalidate() {},
        }, basis: 0, grow: 1, minSize: 1 },
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
      return new VStack([
        { component: header, basis: "auto", shrink: 0 },
        { component: view, basis: "auto", grow: 1, minSize: 1 },
      ]);
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
          (before ? position - 1 : historyHeight - position);
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
    const columns = new HStack();
    const rows = new TranscriptRows();
    this.rebuild = (): void => {
      for (const [stack, axis] of [[columns, "columns"], [rows, "rows"]] as const) {
        stack.clear();
        const minimum = axis === "columns" ? MIN_CHAT : MIN_ROWS;
        const chatEntry = {
          component: chatPane, basis: axis === "columns" ? this.preferences.chatWidth : "auto" as const,
          maxSize: axis === "rows" ? this.preferences.chatHeight : undefined,
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
    const mounted = new VStack([
      { component: toolbar, basis: 1, shrink: 0 },
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
    ]);
    this.mounted = mounted;
    host.setLayoutRoot(mounted);
    host.requestRender();
  }

  private changed(persist = true): void {
    this.rebuild();
    this.host?.requestRender();
    if (persist) this.save();
  }

  /** Show or hide clock rows without changing their recorded source times. */
  setTimestamps(show: boolean): void {
    this.preferences.showTimestamps = show;
    this.changed();
  }

  /** Set the requested conversation width without discarding the stacked height. */
  setWidth(width: number, persist = true): void {
    this.preferences.chatWidth = Math.max(MIN_CHAT, Math.min(240, Math.trunc(width)));
    this.changed(persist);
  }

  /** Set the requested stacked conversation height, including its header. */
  setHeight(height: number, persist = true): void {
    this.preferences.chatHeight = Math.max(MIN_ROWS, Math.min(240, Math.trunc(height)));
    this.changed(persist);
  }

  /** Resize the conversation along the selected split axis. */
  resize(direction: number): void {
    if (this.preferences.layout === "columns") this.setWidth(this.preferences.chatWidth + direction * 4);
    else this.setHeight(this.preferences.chatHeight + direction);
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
    this.restoreDocument();
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
    this.drag = undefined;
    this.rebuild = () => {};
  }
}
