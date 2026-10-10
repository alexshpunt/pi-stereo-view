import type { Theme } from "@earendil-works/pi-coding-agent";
import { Container, Spacer, Text, type Component, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { searchText, type SearchEntry, type SearchHit } from "./search.js";
import { CompactMessage, TimestampedMessage, type TranscriptTimestamps } from "./timestamps.js";

export type Pane = "activity" | "chat";
interface NativeAssistant extends Container {
  contentContainer: Container;
  hasToolCalls: boolean;
}
const nameOf = (component: Component): string => component.constructor.name;

function assistant(component: Component): NativeAssistant | undefined {
  if (nameOf(component) !== "AssistantMessageComponent") return undefined;
  const source = component as NativeAssistant;
  if (!Array.isArray(source.contentContainer?.children) || typeof source.hasToolCalls !== "boolean") {
    throw new Error("Pi's assistant component is not supported");
  }
  return source;
}

function assistantParts(source: NativeAssistant, pane: Pane): Component[] {
  const result: Component[] = [];
  let spacing: Component[] = [];
  for (const component of source.contentContainer.children) {
    const name = nameOf(component);
    if (name === "Spacer") {
      spacing.push(component);
      continue;
    }
    const target = name === "Markdown" ? "chat" :
      name === "MouseRegion" || name === "Text" ? "activity" : undefined;
    if (!target) throw new Error("Pi's assistant content layout is not supported");
    if (target === pane) result.push(...(pane === "chat" ? [] : spacing), component);
    spacing = [];
  }
  return result;
}

/**
 * Project the live native component tree, not messages or renderer strings.
 * Assistant shells keep the native render method and original content components.
 * Their separate children and mouse layout leave the combined tree untouched.
 */
export class NativeDocument extends Container {
  private readonly views = new WeakMap<NativeAssistant, Container>();
  private readonly stamped = new WeakMap<Component, Component>();
  private readonly positions = new Map<Component, { row: number; lines: string[]; excerptRow?: number }>();
  private excerpt?: SearchHit;
  private searchAnchor?: SearchHit;
  private lastWidth = 1;
  private frameActive = false;
  private frameWidth?: number;
  private checked = false;

  constructor(
    private readonly source: Container,
    private readonly pane: Pane | "combined",
    private readonly timestamps: TranscriptTimestamps,
    private readonly theme: () => Theme,
    private readonly timestampGutter: () => number,
    private readonly showTimestamps: () => boolean,
    private readonly interact: () => void = () => {},
  ) {
    super();
  }

  /** Start a native frame; only repeated measurements within that frame may reuse routing. */
  beginFrame(): void {
    this.frameActive = true;
    this.frameWidth = undefined;
    this.checked = false;
  }
  check(): void {
    if (this.frameActive && this.checked) return;
    const chat = this.source.children[2] as Container;
    if (!Array.isArray(chat?.children)) throw new Error("Pi's history document is not supported");
    for (const component of chat.children) {
      this.timestamps.check(component);
      const native = assistant(component);
      if (native) assistantParts(native, this.pane === "combined" ? "activity" : this.pane);
    }
    this.checked = true;
  }

  /** Read full saved text from the current native branch, including collapsed blocks. */
  searchEntries(): SearchEntry[] {
    if (this.pane === "combined") return [];
    const entries: SearchEntry[] = [];
    const add = (source: Component, label: string, text: string, reveal?: () => void): void => {
      if (text.trim()) entries.push({ source, label, text, reveal });
    };
    const contentText = (content: unknown): string => typeof content === "string" ? content :
      Array.isArray(content) ? content.filter(block => block?.type === "text" && typeof block.text === "string")
        .map(block => block.text).join("\n") : "";
    for (const component of (this.source.children[2] as Container).children) {
      const name = nameOf(component);
      const native = component as Component & {
        text?: string; lastMessage?: { content: { type: string; text?: string; thinking?: string }[] };
        toolName?: string; args?: unknown; result?: { content?: unknown };
        command?: string; outputLines?: string[]; message?: { content?: unknown; summary?: string };
        setExpanded?: (expanded: boolean) => void; setHideThinkingBlock?: (hide: boolean) => void;
      };
      if (name === "UserMessageComponent" && this.pane === "chat") {
        if (typeof native.text !== "string") throw new Error("Pi's user search text is not supported");
        add(component, "User", native.text);
      } else if (name === "AssistantMessageComponent") {
        if (!Array.isArray(native.lastMessage?.content)) throw new Error("Pi's assistant search text is not supported");
        const kind = this.pane === "chat" ? "text" : "thinking";
        const text = native.lastMessage?.content.filter(block => block.type === kind)
          .map(block => kind === "text" ? block.text ?? "" : block.thinking ?? "").join("\n\n") ?? "";
        add(component, kind === "text" ? "Assistant" : "Thinking", text, kind === "thinking" ? () => {
          if (typeof native.setHideThinkingBlock !== "function") throw new Error("Pi's thinking reveal is not supported");
          native.setHideThinkingBlock(false);
        } : undefined);
      } else if (this.pane === "activity" && name === "ToolExecutionComponent") {
        if (typeof native.toolName !== "string") throw new Error("Pi's tool search text is not supported");
        add(component, native.toolName, [native.toolName, JSON.stringify(native.args, null, 2), contentText(native.result?.content)]
          .filter(Boolean).join("\n"), () => {
            if (typeof native.setExpanded !== "function") throw new Error("Pi's tool reveal is not supported");
            native.setExpanded(true);
          });
      } else if (this.pane === "activity" && name === "BashExecutionComponent") {
        if (typeof native.command !== "string" || !Array.isArray(native.outputLines)) {
          throw new Error("Pi's shell search text is not supported");
        }
        add(component, "Shell", [native.command, ...native.outputLines].join("\n"), () => native.setExpanded?.(true));
      } else if (this.pane === "activity" && name !== "Spacer" && name !== "Image" && name !== "UserMessageComponent") {
        add(component, name.replace(/(?:Message)?Component$/, ""),
          contentText(native.message?.content) || native.message?.summary || searchText(component.render(this.lastWidth).join("\n")));
      }
    }
    return entries;
  }

  /** Reject hits whose native owner was removed by a branch change or history rebuild. */
  containsSearchHit(hit: SearchHit): boolean {
    return (this.source.children[2] as Container).children.includes(hit.entry.source);
  }
  /** Reveal one selected block without replacing its native renderer. */
  reveal(hit: SearchHit): boolean {
    if (!this.containsSearchHit(hit)) return false;
    this.excerpt = undefined;
    this.searchAnchor = hit;
    hit.entry.reveal?.();
    return true;
  }

  /** Add a temporary fragment when the renderer does not display the saved matching text. */
  showSearchExcerpt(hit: SearchHit): void { this.excerpt = hit; }

  /** Locate the selected occurrence after native wrapping, padding and timestamp decoration. */
  searchRow(hit: SearchHit): number | undefined {
    const block = this.positions.get(hit.entry.source);
    if (!block) return undefined;
    if (block.excerptRow !== undefined) return block.excerptRow;
    const normalize = (text: string): string => searchText(text).normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
    const wanted = normalize(hit.text);
    if (!wanted) return block.row;
    const rows: number[] = [];
    const text = block.lines.map((line, row) => {
      const plain = normalize(searchText(line).replace(/\s+(?:~?\d{2}:\d{2}:\d{2}|--:--:--)\s*[┃│]?$/, ""));
      rows.push(...Array.from({ length: plain.length }, () => row));
      return plain;
    }).join("");
    let occurrence = searchText(hit.entry.text).split("\n").slice(0, hit.line).filter(line => normalize(line) === wanted).length;
    let start = 0;
    while (start <= text.length) {
      const index = text.indexOf(wanted, start);
      if (index < 0) return undefined;
      if (occurrence-- === 0) return block.row + rows[index];
      start = index + wanted.length;
    }
    return undefined;
  }

  override handleMouse(event: TuiMouseEvent): ReturnType<Container["handleMouse"]> {
    if (event.type === "wheel" || (event.type === "press" && event.button === "left")) this.interact();
    return super.handleMouse(event);
  }
  override render(width: number): string[] {
    if (this.frameActive && this.frameWidth === width) return super.render(width);
    const chat = this.source.children[2] as Container;
    this.timestamps.prepare(chat.children);
    this.lastWidth = width;
    this.positions.clear();
    if (this.excerpt && !chat.children.includes(this.excerpt.entry.source)) this.excerpt = undefined;
    if (this.searchAnchor && !chat.children.includes(this.searchAnchor.entry.source)) this.searchAnchor = undefined;
    const result: Component[] = this.pane !== "chat" ? this.source.children.slice(0, 2) : [];
    let row = this.pane === "combined" ? 0 : result.reduce((count, child) => count + child.render(width).length, 0);
    let spacing: Component[] = [];
    let visibleBlock = false;
    for (const component of chat.children) {
      const name = nameOf(component);
      if (name === "Spacer") {
        spacing.push(component);
        continue;
      }
      const native = assistant(component);
      let routed: Component | undefined;
      if (native && this.pane !== "combined") {
        const parts = assistantParts(native, this.pane);
        if (parts.length) {
          let view = this.views.get(native);
          if (!view) {
            view = Object.create(native) as Container;
            const content = new Container();
            Object.assign(view, { children: [content], contentContainer: content });
            this.views.set(native, view);
          }
          (view.children[0] as Container).children = parts;
          routed = view;
        }
      } else {
        const target = name === "UserMessageComponent" || name === "Image" ? "chat" : "activity";
        if (target === this.pane || this.pane === "combined") routed = component;
      }
      if (routed) {
        const start = result.length;
        const wasVisible = visibleBlock;
        // Empty native assistant shells do not need a detached timestamp row.
        if (native && native.contentContainer.children.length === 0) result.push(...spacing, routed);
        else {
          let stamped = this.stamped.get(routed);
          if (!stamped) {
            const Decorator = this.pane !== "combined" ? CompactMessage : TimestampedMessage;
            stamped = new Decorator(routed, () => this.timestamps.label(component), this.theme, this.timestampGutter, this.showTimestamps);
            this.stamped.set(routed, stamped);
          }
          if (stamped instanceof CompactMessage) {
            visibleBlock = stamped.prepare(width, visibleBlock) || visibleBlock;
            result.push(stamped);
          } else result.push(...spacing, stamped);
        }
        if (this.pane !== "combined") {
          const lines = result.slice(start).flatMap(child => child.render(width));
          let excerptRow: number | undefined;
          if (this.excerpt?.entry.source === component) {
            const fragment = new Text(this.theme().fg("accent", "Search match: ") + searchText(this.excerpt.text), 1, 0);
            if (!lines.length && wasVisible) {
              result.push(new Spacer(1));
              lines.push("");
            }
            excerptRow = row + lines.length;
            result.push(fragment);
            lines.push(...fragment.render(width));
            visibleBlock = true;
          }
          this.positions.set(component, { row, lines, excerptRow });
          row += lines.length;
        }
      }
      spacing = [];
    }
    if (this.pane === "combined") result.push(...spacing);
    // Native follow-end guidance overlays the bottom row. Keep the selected last line above it.
    if (this.pane !== "combined" && this.searchAnchor) result.push(new Spacer(1));
    this.children = result;
    this.frameWidth = width;
    return super.render(width);
  }

  override invalidate(): void {
    this.frameWidth = undefined;
    this.checked = false;
    // Theme changes must rebuild native parents, including collapsed thinking text.
    this.source.invalidate();
  }
}
