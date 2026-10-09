import type { Theme } from "@earendil-works/pi-coding-agent";
import {
  Container, HStack, isViewportTUI, MouseRegion, ScrollView, Text, VStack,
  type Component, type TUI,
} from "@earendil-works/pi-tui";
import { NativeDocument } from "./native.js";
import type { Preferences } from "./preferences.js";

type NativeTui = TUI & { layoutRoot?: Container; setLayoutRoot(component: Component | undefined): void };
const MIN_CHAT = 24;
const MIN_ACTIVITY = 40;

/** Own only a guarded fullscreen history layout; never replace the input dock. */
export class TranscriptLayout {
  private host?: NativeTui;
  private original?: Container;
  private mounted?: Component;
  private activity?: ScrollView;
  private chat?: ScrollView;
  private dragStart?: number;
  private failed = false;
  private readonly rejectedRoots = new WeakSet<Component>();

  constructor(
    readonly preferences: Preferences,
    private readonly theme: () => Theme,
    private readonly warn: (message: string) => void,
    private readonly save: () => void,
  ) {}

  attach(tui: TUI): void {
    if (!isViewportTUI(tui)) return;
    const host = tui as NativeTui;
    if (host.layoutRoot === this.mounted && this.host) return;
    const root = host.layoutRoot;
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
    const shown = ({ width }: { width: number }): boolean => {
      if (this.preferences.mode !== "split" || width < MIN_CHAT + MIN_ACTIVITY + 1 || this.failed) return false;
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
    const pane = (title: string, view: ScrollView): Component => new VStack([
      { component: {
        render: width => new Text(this.theme().fg("muted", " " + title), 0, 0).render(width),
        invalidate() {},
      }, basis: 1 },
      { component: view, basis: 0, grow: 1, minSize: 1 },
    ]);
    const activityPane = pane("Activity", this.activity);
    const chatPane = pane("Conversation", this.chat);
    const divider = new MouseRegion({
      render: () => Array.from({ length: host.terminal.rows }, () => this.theme().fg("dim", "│")),
      invalidate() {},
    }, event => {
      if (event.button !== "left" && event.type !== "release") return;
      if (event.type === "press") {
        this.dragStart = this.preferences.chatWidth;
        return { capture: true };
      }
      if (event.type === "drag" && this.dragStart !== undefined) {
        const width = this.preferences.side === "left" ? event.screenX : host.terminal.columns - event.screenX - 1;
        this.setWidth(width, false);
        return { handled: true };
      }
      if (event.type === "release" && this.dragStart !== undefined) {
        this.dragStart = undefined;
        this.save();
        return { handled: true };
      }
      return undefined;
    });
    const split = new HStack();
    const rebuildSplit = (): void => {
      split.clear();
      const chatEntry = { component: chatPane, basis: this.preferences.chatWidth, minSize: MIN_CHAT, shrink: 1 };
      const activityEntry = { component: activityPane, basis: 0, grow: 1, minSize: MIN_ACTIVITY };
      split.addChild(this.preferences.side === "left" ? chatEntry.component : activityEntry.component,
        this.preferences.side === "left" ? chatEntry : activityEntry);
      split.addChild(divider, { basis: 1, shrink: 0 });
      split.addChild(this.preferences.side === "left" ? activityEntry.component : chatEntry.component,
        this.preferences.side === "left" ? activityEntry : chatEntry);
    };
    rebuildSplit();
    // Rebuild only the horizontal entries after a preference edit; scroll views survive.
    this.rebuildSplit = rebuildSplit;
    const mounted = new VStack([
      { component: split, basis: 0, grow: 1, minSize: 1, visible: shown },
      { component: transcript, basis: 0, grow: 1, minSize: 1, visible: viewport => !shown(viewport) },
      { component: dock, basis: "auto", shrink: 1, minSize: 1 },
    ]);
    this.mounted = mounted;
    host.setLayoutRoot(mounted);
    host.requestRender();
  }

  private rebuildSplit = (): void => {};

  setWidth(width: number, persist = true): void {
    this.preferences.chatWidth = Math.max(MIN_CHAT, Math.min(240, Math.trunc(width)));
    this.rebuildSplit();
    this.host?.requestRender();
    if (persist) this.save();
  }

  toggle(): void {
    this.preferences.mode = this.preferences.mode === "split" ? "combined" : "split";
    this.host?.requestRender();
    this.save();
  }

  swap(): void {
    this.preferences.side = this.preferences.side === "left" ? "right" : "left";
    this.rebuildSplit();
    this.host?.requestRender();
    this.save();
  }

  scroll(pane: "chat" | "activity", lines: number): void {
    (pane === "chat" ? this.chat : this.activity)?.scrollBy(lines);
    this.host?.requestRender();
  }

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
    this.rebuildSplit = () => {};
  }
}
