import type { Theme } from "@earendil-works/pi-coding-agent";
import { Container, type Component } from "@earendil-works/pi-tui";
import { TimestampedMessage, type TranscriptTimestamps } from "./timestamps.js";

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
    if (target === pane) result.push(...spacing, component);
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
  private readonly stamped = new WeakMap<Component, TimestampedMessage>();

  constructor(
    private readonly source: Container,
    private readonly pane: Pane | "combined",
    private readonly timestamps: TranscriptTimestamps,
    private readonly theme: () => Theme,
    private readonly timestampGutter: () => number,
  ) {
    super();
  }

  check(): void {
    const chat = this.source.children[2] as Container;
    if (!Array.isArray(chat?.children)) throw new Error("Pi's history document is not supported");
    for (const component of chat.children) {
      this.timestamps.check(component);
      const native = assistant(component);
      if (native) assistantParts(native, this.pane === "combined" ? "activity" : this.pane);
    }
  }

  override render(width: number): string[] {
    const chat = this.source.children[2] as Container;
    this.timestamps.prepare(chat.children);
    const result: Component[] = this.pane !== "chat" ? this.source.children.slice(0, 2) : [];
    let spacing: Component[] = [];
    let previous: Pane = "activity";
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
        previous = target;
      }
      if (routed) {
        // Empty native assistant shells do not need a detached timestamp row.
        if (native && native.contentContainer.children.length === 0) result.push(...spacing, routed);
        else {
          let stamped = this.stamped.get(routed);
          if (!stamped) {
            stamped = new TimestampedMessage(routed, () => this.timestamps.label(component), this.theme, this.timestampGutter);
            this.stamped.set(routed, stamped);
          }
          result.push(...spacing, stamped);
        }
      }
      spacing = [];
    }
    if (previous === this.pane || this.pane === "combined") result.push(...spacing);
    this.children = result;
    return super.render(width);
  }

  override invalidate(): void {
    // Theme changes must rebuild native parents, including collapsed thinking text.
    this.source.invalidate();
  }
}
