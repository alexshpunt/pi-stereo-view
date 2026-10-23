import { Container, Markdown, Text, stripTerminalSequences, type Component } from "@earendil-works/pi-tui";
import { searchText, type SearchEntry } from "./search.js";

export type Pane = "activity" | "chat";
export type ContentKind = "dialogue" | "system" | "thinking" | "tool" | "shell";

const panes: Record<ContentKind, Pane> = {
  dialogue: "chat", system: "chat", thinking: "activity", tool: "activity", shell: "activity",
};

interface NativeContent extends Component {
  text?: string;
  message?: { content?: unknown; summary?: string; details?: { parentToolCallId?: unknown } };
  entry?: { data?: { parentToolCallId?: unknown } };
  toolCallId?: string;
  toolName?: string;
  args?: unknown;
  result?: { content?: unknown };
  command?: string;
  outputLines?: string[];
  customComponent?: Component;
  setExpanded?: (expanded: boolean) => void;
}
interface NativeAssistant extends Container {
  contentContainer: Container;
  hasToolCalls: boolean;
  lastMessage?: { content: { type: string; text?: string; thinking?: string }[] };
  contentIsStale?: boolean;
  buildContent?(message: NonNullable<NativeAssistant["lastMessage"]>): void;
  setHideThinkingBlock(hidden: boolean): void;
}

/** One native owner and its pane projection; spacing and search retain that same owner. */
export interface ContentEntry {
  source: Component;
  owner: Component;
  component: Component;
  kind: ContentKind;
  spacing: Component[];
  compact: boolean;
  search(width: number): Omit<SearchEntry, "source">;
}

const nameOf = (component: Component): string => component.constructor.name;
const contentText = (content: unknown): string => typeof content === "string" ? content :
  Array.isArray(content) ? content.filter(block => block?.type === "text" && typeof block.text === "string")
    .map(block => block.text).join("\n") : "";

/** Native text renderers retain their source before terminal wrapping and padding. */
function componentText(component: Component): string | undefined {
  if (!(component instanceof Text) && !(component instanceof Markdown)) return undefined;
  const text: unknown = Reflect.get(component, "text");
  return typeof text === "string" ? stripTerminalSequences(text) : undefined;
}
function assistant(component: Component): NativeAssistant | undefined {
  if (nameOf(component) !== "AssistantMessageComponent") return undefined;
  const native = component as NativeAssistant;
  if (!Array.isArray(native.contentContainer?.children) || typeof native.hasToolCalls !== "boolean" ||
    (native.lastMessage !== undefined && !Array.isArray(native.lastMessage.content))) {
    throw new Error("Pi's assistant content metadata is not supported");
  }
  // Pi-Bolt builds streamed children lazily. Synchronize the real owner before
  // indexing or cloning it, so a pane cannot rebuild both content kinds itself.
  if (native.contentIsStale === true) {
    if (!native.lastMessage || typeof native.buildContent !== "function") {
      throw new Error("Pi's deferred assistant content is not supported");
    }
    native.buildContent(native.lastMessage);
  }
  return native;
}

/** Read supported native execution identities; unrecognized content is system information. */
const nativeKinds: Record<string, { kind: ContentKind; accepts(content: NativeContent): boolean }> = {
  UserMessageComponent: { kind: "dialogue", accepts: content => typeof content.text === "string" },
  ToolExecutionComponent: { kind: "tool", accepts: content => typeof content.toolName === "string" },
  BashExecutionComponent: {
    kind: "shell", accepts: content => typeof content.command === "string" && Array.isArray(content.outputLines),
  },
};

/** Shared semantic index for painting and search, independent of wording, severity and lifecycle. */
export class NativeContentIndex {
  private signature: unknown[] = [];
  private content: ContentEntry[] = [];
  private readonly views = new WeakMap<NativeAssistant, Partial<Record<Pane, Container>>>();

  constructor(private readonly source: Container) {}

  /** Return the same classification until native ownership or assistant content changes. */
  entries(pane: Pane): ContentEntry[] {
    this.refresh();
    return this.content.filter(entry => panes[entry.kind] === pane);
  }

  /** A rebuilt history cannot retain search hits belonging to removed native owners. */
  contains(source: Component, pane?: Pane): boolean {
    this.refresh();
    return this.content.some(entry => entry.source === source && (pane === undefined || panes[entry.kind] === pane));
  }

  /** Build clipboard text only on demand, from this branch's current semantic block. */
  copy(entry: ContentEntry, width: number): string | undefined {
    this.refresh();
    const current = this.content.find(candidate => candidate.source === entry.source && candidate.component === entry.component);
    if (!current) return undefined;
    const group = current.kind === "tool" && current.owner === current.source
      ? this.content.filter(candidate => candidate === current || candidate.owner === current.source)
      : [current];
    return group.map(candidate => stripTerminalSequences(candidate.search(width).text)).filter(Boolean).join("\n\n");
  }

  private refresh(): void {
    const history = this.source.children[2] as Container;
    if (!Array.isArray(history?.children)) throw new Error("Pi's history document is not supported");
    const signature: unknown[] = [...this.source.children, ...history.children];
    for (const component of history.children) {
      const metadata = component as NativeContent;
      signature.push(metadata.toolCallId, metadata.entry?.data?.parentToolCallId, metadata.message?.details?.parentToolCallId);
      const native = assistant(component);
      if (native) signature.push(native.lastMessage, ...native.contentContainer.children);
    }
    if (signature.length === this.signature.length && signature.every((value, index) => value === this.signature[index])) return;
    const owners = new Map<string, NativeContent>();
    for (const component of history.children) {
      const adapter = nativeKinds[nameOf(component)];
      const native = component as NativeContent;
      if (adapter?.kind === "tool" && adapter.accepts(native) && typeof native.toolCallId === "string") {
        owners.set(native.toolCallId, native);
      }
    }
    const entries = this.source.children.slice(0, 2).map(component => this.entry(component, "system", [], false));
    let spacing: Component[] = [];
    for (const component of history.children) {
      if (nameOf(component) === "Spacer") {
        spacing.push(component);
        continue;
      }
      const native = assistant(component);
      if (native) entries.push(...this.assistantEntries(native, spacing));
      else {
        const adapter = nativeKinds[nameOf(component)];
        const native = component as NativeContent;
        const kind = adapter?.accepts(native) ? adapter.kind : "system";
        const parentId = native.entry?.data?.parentToolCallId ?? native.message?.details?.parentToolCallId;
        const owner = kind === "system" && typeof parentId === "string" ? owners.get(parentId) : undefined;
        entries.push(this.entry(component, kind, spacing, true, owner));
      }
      spacing = [];
    }
    // Project late execution output beside its owner, never reorder native history.
    const linked = new Map<Component, ContentEntry[]>();
    for (const entry of entries) {
      if (entry.owner === entry.source) continue;
      const group = linked.get(entry.owner) ?? [];
      group.push(entry);
      linked.set(entry.owner, group);
    }
    this.content = entries.flatMap(entry => entry.owner === entry.source
      ? [entry, ...(linked.get(entry.source) ?? [])] : []);
    this.signature = signature;
  }

  private entry(source: Component, kind: ContentKind, spacing: Component[], compact: boolean, owner?: NativeContent): ContentEntry {
    return { source, owner: owner ?? source, component: source, kind: owner ? "tool" : kind, spacing, compact, search: width => {
      const native = source as NativeContent;
      if (kind === "tool") {
        if (typeof native.toolName !== "string") throw new Error("Pi's tool metadata is not supported");
        return {
          label: native.toolName,
          text: [native.toolName, JSON.stringify(native.args, null, 2), contentText(native.result?.content)].filter(Boolean).join("\n"),
          reveal: () => {
            if (typeof native.setExpanded !== "function") throw new Error("Pi's tool reveal is not supported");
            native.setExpanded(true);
          },
        };
      }
      if (kind === "shell") {
        if (typeof native.command !== "string" || !Array.isArray(native.outputLines)) throw new Error("Pi's shell metadata is not supported");
        return { label: "Shell", text: [native.command, ...native.outputLines].join("\n"), reveal: () => native.setExpanded?.(true) };
      }
      if (kind === "dialogue") {
        if (typeof native.text !== "string") throw new Error("Pi's user text metadata is not supported");
        return { label: "User", text: native.text };
      }
      return {
        label: owner?.toolName ?? (native.message?.summary !== undefined ? "Summary" : "System"),
        text: contentText(native.message?.content) || native.message?.summary || componentText(native.customComponent ?? source) ||
          searchText(source.render(width).join("\n")).split("\n").map(line => line.trimEnd()).join("\n").replace(/^\n+|\n+$/g, ""),
        reveal: typeof native.setExpanded === "function" ? () => native.setExpanded!(true) : undefined,
      };
    } };
  }

  private assistantEntries(source: NativeAssistant, spacing: Component[]): ContentEntry[] {
    // Native rendering creates one child per visible text block or consecutive thinking run.
    // Match those children to semantic content before projecting; a Text diagnostic is not thinking.
    const runs: ContentKind[] = [];
    let thinking = false;
    for (const block of source.lastMessage?.content ?? []) {
      if (block.type === "thinking") {
        if (block.thinking?.trim() && !thinking) { runs.push("thinking"); thinking = true; }
      } else {
        thinking = false;
        if (block.type === "text" && block.text?.trim()) runs.push("dialogue");
      }
    }
    const groups: Record<Pane, Component[]> = { chat: [], activity: [] };
    const diagnostics: Component[] = [];
    let slot = 0;
    let padding: Component[] = [];
    for (const child of source.contentContainer.children) {
      if (nameOf(child) === "Spacer") { padding.push(child); continue; }
      const kind = runs[slot++] ?? "system";
      if ((kind === "thinking" && nameOf(child) !== "MouseRegion") || (kind === "dialogue" && nameOf(child) !== "Markdown")) {
        throw new Error("Pi's assistant rendering does not match its content metadata");
      }
      groups[panes[kind]].push(...padding, child);
      if (kind === "system") diagnostics.push(child);
      padding = [];
    }
    if (slot < runs.length) throw new Error("Pi's assistant content layout is not supported");
    const views = this.views.get(source) ?? {};
    this.views.set(source, views);
    const result: ContentEntry[] = [];
    for (const pane of ["chat", "activity"] as const) {
      const parts = groups[pane];
      if (!parts.length) continue;
      let view = views[pane];
      if (!view) {
        view = Object.create(source) as Container;
        const content = new Container();
        Object.assign(view, {
          children: [content], contentContainer: content,
          // This is a partial view: rebuilding the assistant would restore both panes.
          invalidate: () => content.invalidate(),
        });
        views[pane] = view;
      }
      const content = view.children[0] as Container;
      content.children = parts;
      result.push({
        source, owner: source, component: view, kind: pane === "activity" ? "thinking" : runs.includes("dialogue") ? "dialogue" : "system", spacing, compact: true,
        search: width => {
          const kind = pane === "activity" ? "thinking" : "text";
          const saved = (source.lastMessage?.content ?? []).filter(block => block.type === kind)
            .map(block => kind === "text" ? block.text ?? "" : block.thinking ?? "").join("\n\n");
          return {
            label: pane === "activity" ? "Thinking" : "Assistant",
            text: [saved, ...(pane === "chat" ? diagnostics.map(child => searchText(child.render(width).join("\n"))) : [])].filter(Boolean).join("\n\n"),
            reveal: pane === "activity" ? () => source.setHideThinkingBlock(false) : undefined,
          };
        },
      });
    }
    return result;
  }
}
