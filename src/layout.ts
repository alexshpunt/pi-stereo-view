import type { Theme } from "@earendil-works/pi-coding-agent";
import {
  Container, HStack, isViewportTUI, MouseRegion, ScrollView, Text, VStack,
  type Component, type TUI,
} from "@earendil-works/pi-tui";
import { NativeDocument, type Pane } from "./native.js";
import type { Preferences } from "./preferences.js";

type NativeTui = TUI & { layoutRoot?: Container; setLayoutRoot(component: Component | undefined): void };
const MIN_CHAT = 24;
const MIN_ACTIVITY = 40;
const MIN_ROWS = 4;

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

  constructor(
    readonly preferences: Preferences,
    private readonly theme: () => Theme,
    private readonly warn: (message: string) => void,
    private readonly save: () => void,
  ) {}

  private button(label: () => string, action: () => void, enabled = (): boolean => true): Component {
    return new MouseRegion({
      render: width => new Text(this.theme().fg(enabled() ? "accent" : "dim", label()), 0, 0).render(width),
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
    const document = (scroll as ScrollView & { children: Component[] }).children?.[0] as Container;
    if (transcript.constructor.name !== "ScrollView" || dock.constructor.name !== "VStack" ||
        document?.constructor.name !== "Container" || document.children.length !== 3 ||
        !Array.isArray((document.children[2] as Container)?.children)) {
      this.rejectedRoots.add(root);
      this.warn("Transcript split is unavailable: Pi's history document is not supported.");
      return;
    }
    this.host = host;
    this.original = root;
    this.failed = false;
    const activityDocument = new NativeDocument(document, "activity");
    const chatDocument = new NativeDocument(document, "chat");
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
      const fits = this.preferences.zoom ? width >= MIN_CHAT && historyHeight >= 2 :
        this.preferences.layout === "columns" ? width >= MIN_CHAT + MIN_ACTIVITY + 1 && historyHeight >= 2 :
          width >= MIN_CHAT && historyHeight >= MIN_ROWS * 2 + 1;
      this.fallback = this.preferences.mode === "split" && !fits;
      if (this.preferences.mode !== "split" || !fits || this.failed) return false;
      this.activity?.setScrollbar(scroll.scrollbar);
      this.chat?.setScrollbar(scroll.scrollbar);
      try {
        activityDocument.check();
        chatDocument.check();
        return true;
      } catch (error) {
        this.failed = true;
        queueMicrotask(() => this.warn("Transcript split disabled: " + (error as Error).message));
        return false;
      }
    };
    const toolbar = new HStack([
      { component: this.button(
        () => this.preferences.mode === "combined" || this.fallback || this.failed ? "[Split]" : "[Combined]",
        () => this.toggle(), () => !this.fallback && !this.failed,
      ), basis: 10, shrink: 0 },
      { component: this.button(
        () => this.preferences.layout === "columns" ? "[Rows]" : "[Cols]",
        () => this.setLayout(this.preferences.layout === "columns" ? "rows" : "columns"), () => !this.failed,
      ), basis: 6, shrink: 0 },
      { component: this.button(() => "[Swap]", () => this.swap(),
        () => this.preferences.mode === "split" && !this.preferences.zoom && !this.fallback && !this.failed,
      ), basis: 6, shrink: 0 },
    ], { gap: 1 });
    const pane = (title: string, target: Pane, view: ScrollView): Component => new VStack([
      { component: new HStack([
        { component: {
          render: width => new Text(this.theme().fg("muted", " " + title), 0, 0).render(width),
          invalidate() {},
        }, basis: 0, grow: 1, minSize: 1 },
        { component: this.button(
          () => this.preferences.zoom === target ? "[Restore]" : "[Expand]",
          () => this.maximize(target),
        ), basis: 9, shrink: 0 },
      ], { gap: 1 }), basis: 1 },
      { component: view, basis: 0, grow: 1, minSize: 1 },
    ]);
    const activityPane = pane("Activity", "activity", this.activity);
    const chatPane = pane("Conversation", "chat", this.chat);
    const divider = (axis: "columns" | "rows"): Component => new MouseRegion({
      render: width => axis === "columns" ?
        Array.from({ length: host.terminal.rows }, () => this.theme().fg("dim", "│")) :
        [this.theme().fg("dim", "─".repeat(width))],
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
    const rows = new VStack();
    this.rebuild = (): void => {
      for (const [stack, axis] of [[columns, "columns"], [rows, "rows"]] as const) {
        stack.clear();
        const minimum = axis === "columns" ? MIN_CHAT : MIN_ROWS;
        const chatEntry = {
          component: chatPane, basis: axis === "columns" ? this.preferences.chatWidth : this.preferences.chatHeight,
          minSize: minimum, shrink: 1,
        };
        const activityEntry = {
          component: activityPane, basis: 0, grow: 1, minSize: axis === "columns" ? MIN_ACTIVITY : MIN_ROWS,
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
      { component: rows, basis: 0, grow: 1, minSize: 1,
        visible: viewport => shown(viewport) && !this.preferences.zoom && this.preferences.layout === "rows" },
      { component: activityPane, basis: 0, grow: 1, minSize: 1,
        visible: viewport => shown(viewport) && this.preferences.zoom === "activity" },
      { component: chatPane, basis: 0, grow: 1, minSize: 1,
        visible: viewport => shown(viewport) && this.preferences.zoom === "chat" },
      { component: transcript, basis: 0, grow: 1, minSize: 1, visible: viewport => !shown(viewport) },
      { component: dock, basis: "auto", shrink: 1, minSize: 1 },
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
