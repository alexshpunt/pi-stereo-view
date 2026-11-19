import { Container, Markdown, Text, stripTerminalSequences, type Component } from "@earendil-works/pi-tui";
import { searchText, type SearchEntry } from "./search.ts";
import { NestedCalls } from "./nested-calls.ts";
import { sameValues } from "./render-cache.ts";

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
  result?: { content?: unknown; isError?: boolean };
  isPartial?: boolean;
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

export interface ToolSummary {
  name: string;
  args: unknown;
  status: "running" | "success" | "error" | "unknown";
  /** Image blocks in the call's result, shown on compact rows that hide the native card. */
  images?: number;
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
  /** Live execution metadata exists only on calls, never on linked output. */
  tool?(): ToolSummary;
}
/** A call's status from Pi's result fields, which Pi updates in place without invalidating the call. */
export function callStatus(call: Component): ToolSummary["status"] {
  const { result, isPartial } = call as NativeContent;
  return !result || isPartial !== false ? "running" : result.isError ? "error" : "success";
}
/** Number of image blocks in a tool result's content. */
export function imageCount(content: unknown): number {
  if (!Array.isArray(content)) return 0;
  let count = 0;
  for (const block of content) if (block?.type === "image") count++;
  return count;
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

/** Native rendering creates one child per visible text block or consecutive thinking run. */
function forEachRun(source: NativeAssistant, visit: (kind: ContentKind) => void): void {
  let thinking = false;
  for (const block of source.lastMessage?.content ?? []) {
    if (block.type === "thinking") {
      if (!thinking && block.thinking?.trim()) { visit("thinking"); thinking = true; }
    } else {
      thinking = false;
      if (block.type === "text" && block.text?.trim()) visit("dialogue");
    }
  }
}
/** One non-spacer native history child, its spacing and the entries projected from it. */
interface Classified {
  component: Component;
  spacing: Component[];
  entries: ContentEntry[];
  /** Native identities that ownership depends on; Pi sets them at construction. */
  toolCallId: unknown;
  parentId: unknown;
  custom: unknown;
  /** Assistant inputs: Pi replaces the content array whenever it rebuilds the message's blocks. */
  content?: Component[];
  contentLength?: number;
  message?: unknown;
  /** Linked panel inputs: its resolved owner and the panel parts shown as nested calls. */
  parent?: { id: string; owner?: NativeContent; parts?: Component[] };
}

const parentOf = (component: NativeContent): unknown => component.entry?.data?.parentToolCallId ?? component.message?.details?.parentToolCallId;

/** The previous entry for the same native block, when every field that renders or searches it is equal. */
function reuse(entry: ContentEntry, previous: readonly ContentEntry[]): ContentEntry {
  const match = previous.find(candidate => candidate.source === entry.source && candidate.component === entry.component);
  return match && match.owner === entry.owner && match.kind === entry.kind && match.compact === entry.compact &&
    sameValues(match.spacing, entry.spacing) ? match : entry;
}

/** Read supported native execution identities; unrecognized content is system information. */
const nativeKinds: Record<string, { kind: ContentKind; accepts(content: NativeContent): boolean }> = {
  UserMessageComponent: { kind: "dialogue", accepts: content => typeof content.text === "string" },
  ToolExecutionComponent: { kind: "tool", accepts: content => typeof content.toolName === "string" },
  BashExecutionComponent: {
    kind: "shell", accepts: content => typeof content.command === "string" && Array.isArray(content.outputLines),
  },
};

/** Traverse the same component links as the native render cache, including wrappers. */
export function componentTree(root: Component | undefined): NativeContent[] {
  const seen = new Set<Component>();
  const nodes: NativeContent[] = [];
  const visit = (component: Component | undefined): void => {
    if (!component || seen.has(component) || typeof component.render !== "function") return;
    seen.add(component);
    const node = component as NativeContent & { children?: Component[]; child?: Component; component?: Component };
    nodes.push(node);
    if (Array.isArray(node.children)) for (const child of node.children) visit(child);
    visit(node.child); visit(node.component); visit(node.customComponent);
  };
  visit(root);
  return nodes;
}

/** Preserve searchable tool-result text even when a custom renderer abbreviates it. */
function nestedResultText(component: Component | undefined): string[] {
  return componentTree(component).flatMap(node => nameOf(node) === "ToolExecutionComponent" ? [contentText(node.result?.content)] : []).filter(Boolean);
}

/** Unwrap layout-only containers while retaining each original renderer and shared note. */
function nativePanelParts(source: NativeContent): Component[] | undefined {
  if (!source.customComponent) return undefined;
  const parts: Component[] = [];
  const seen = new Set<Component>();
  const visit = (component: Component): void => {
    if (seen.has(component)) return;
    seen.add(component);
    if (component.constructor === Container) for (const child of (component as Container).children) visit(child);
    else if (nameOf(component) !== "Spacer") parts.push(component);
  };
  visit(source.customComponent);
  return parts.filter(part => nameOf(part) === "ToolExecutionComponent").length > 1 ? parts : undefined;
}
/** Shared semantic index for painting and search, independent of wording, severity and lifecycle. */
export class NativeContentIndex {
  private content: ContentEntry[] = [];
  /** History children, source parts and per-block classification from the last verification. */
  private history: Component[] = [];
  private head: Component[] = [];
  private headEntries: ContentEntry[] = [];
  private blocks: Classified[] = [];
  private readonly owners = new Map<string, NativeContent>();
  private panes: Partial<Record<Pane, ContentEntry[]>> = {};
  private readonly expandedPanels = new WeakMap<Component, Component>();
  private readonly views = new WeakMap<NativeAssistant, Partial<Record<Pane, Container>>>();
  private readonly diagnostics = new WeakMap<NativeAssistant, Component[]>();

  private pass?: { active: boolean; verified?: { children: Component[]; length: number; last?: Component; parts: number; revision: number; trees: boolean } };

  /**
   * With `nestedTrees` on, a parented output panel is split into the native parts of its nested calls, which Activity
   * shows as the caller's tree. Off, the panel stays one original entry beside its owner.
   */
  constructor(private readonly source: Container, readonly nested = new NestedCalls(), readonly nestedTrees: () => boolean = () => true) {}

  /**
   * Native history cannot change while Pi lays out one frame, so the panes of a pass
   * share one verification. The pass ends in the next microtask; structural changes
   * and nested-call updates inside it still verify again.
   */
  beginFrame(): void {
    if (this.pass?.active) { this.pass.verified = undefined; return; }
    const pass: NonNullable<typeof this.pass> = { active: true };
    this.pass = pass;
    queueMicrotask(() => { pass.active = false; if (this.pass === pass) this.pass = undefined; });
  }

  /** Return the same classification until native ownership or assistant content changes. */
  entries(pane?: Pane): ContentEntry[] {
    this.refresh();
    if (pane === undefined) return this.content;
    return this.panes[pane] ??= this.content.filter(entry => panes[entry.kind] === pane);
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
    const pass = this.pass?.active ? this.pass : undefined;
    const children = history.children;
    const verified = pass?.verified;
    if (verified && verified.children === children && verified.length === children.length && verified.last === children.at(-1) &&
      verified.parts === this.source.children.length && verified.revision === this.nested.revision && verified.trees === this.nestedTrees()) return;
    this.verify(history);
    if (pass) pass.verified = { children, length: children.length, last: children.at(-1), parts: this.source.children.length, revision: this.nested.revision, trees: this.nestedTrees() };
  }

  /** Whether a classified block still has the native inputs its entries were built from. */
  private unchanged(block: Classified): boolean {
    const component = block.component as NativeAssistant & NativeContent;
    if (component.toolCallId !== block.toolCallId || parentOf(component) !== block.parentId || component.customComponent !== block.custom) return false;
    if (block.content) {
      const children = component.contentContainer?.children;
      if (component.contentIsStale === true || children !== block.content || children.length !== block.contentLength ||
        component.lastMessage !== block.message) return false;
    }
    if (block.parent) {
      const owner = this.owners.get(block.parent.id);
      if (owner !== block.parent.owner) return false;
      const parts = owner?.toolCallId ? this.panelParts(component, owner.toolCallId) : undefined;
      if (parts ? !sameValues(block.parent.parts, parts) : block.parent.parts) return false;
    }
    return true;
  }

  /**
   * Reclassify only blocks whose native inputs changed: new or moved children, rebuilt assistant content,
   * and parented panels whose owner or parts changed. Unchanged blocks keep their entry objects, and the
   * content array keeps its identity while no entry changed, so streaming does not rebuild the index.
   */
  private verify(history: Container): void {
    const children = history.children;
    const head = this.source.children;
    let same = 0;
    const limit = Math.min(children.length, this.history.length);
    while (same < limit && children[same] === this.history[same]) same++;
    const structural = same !== children.length || same !== this.history.length;
    if (!structural && sameValues(this.head, head) && this.blocks.every(block => this.unchanged(block))) return;
    this.owners.clear();
    for (const component of children) {
      const adapter = nativeKinds[nameOf(component)];
      const native = component as NativeContent;
      if (adapter?.kind === "tool" && adapter.accepts(native) && typeof native.toolCallId === "string") {
        this.owners.set(native.toolCallId, native);
      }
    }
    // Blocks of the unchanged prefix keep their positions; later children may have moved.
    let previous: Map<Component, Classified> | undefined;
    const find = (component: Component, index: number): Classified | undefined => {
      if (this.blocks[index]?.component === component) return this.blocks[index];
      previous ??= new Map(this.blocks.map(block => [block.component, block]));
      return previous.get(component);
    };
    const blocks: Classified[] = [];
    const entries = head.slice(0, 2).map(component => reuse(this.entry(component, "system", [], false), this.headEntries));
    this.headEntries = entries.slice();
    let spacing: Component[] = [];
    for (let position = 0; position < children.length; position++) {
      const component = children[position];
      if (nameOf(component) === "Spacer") {
        spacing.push(component);
        continue;
      }
      const old = find(component, blocks.length);
      // Spacing before a block in the unchanged prefix lies in that prefix too.
      const sameSpacing = old !== undefined && (position < same || sameValues(old.spacing, spacing));
      const block = old && sameSpacing && this.unchanged(old) ? old : this.classify(component, sameSpacing ? old!.spacing : spacing, old);
      blocks.push(block);
      for (const entry of block.entries) entries.push(entry);
      spacing = [];
    }
    this.blocks = blocks;
    this.history = children.slice();
    this.head = head.slice();
    // Project late execution output beside its owner, never reorder native history.
    const linked = new Map<Component, ContentEntry[]>();
    for (const entry of entries) {
      if (entry.owner === entry.source) continue;
      const group = linked.get(entry.owner) ?? [];
      group.push(entry);
      linked.set(entry.owner, group);
    }
    const content = linked.size ? entries.flatMap(entry => entry.owner === entry.source
      ? [entry, ...(linked.get(entry.source) ?? [])] : []) : entries;
    if (sameValues(this.content, content)) return;
    this.content = content;
    this.panes = {};
  }

  /** The parts a nested-call tree shows for an owner's linked panel, or none to keep the panel whole. */
  private panelParts(panel: NativeContent, owner: string): Component[] | undefined {
    return this.nestedTrees() && this.nested.entries(owner).length ? nativePanelParts(panel) : undefined;
  }

  /** Build the entries of one native history block, keeping previous entry objects that did not change. */
  private classify(component: Component, spacing: Component[], old: Classified | undefined): Classified {
    const native = component as NativeContent;
    const block: Classified = { component, spacing, entries: [], toolCallId: native.toolCallId, parentId: parentOf(native), custom: native.customComponent };
    const message = assistant(component);
    if (message) {
      block.entries = this.assistantEntries(message, spacing);
      block.content = message.contentContainer.children;
      block.contentLength = block.content.length;
      block.message = message.lastMessage;
    } else {
      const adapter = nativeKinds[nameOf(component)];
      const content = component as NativeContent;
      const kind = adapter?.accepts(content) ? adapter.kind : "system";
      const parentId = block.parentId;
      const owner = kind === "system" && typeof parentId === "string" ? this.owners.get(parentId) : undefined;
      if (owner && this.expandedPanels.get(component) !== owner) {
        content.setExpanded?.(true);
        this.expandedPanels.set(component, owner);
      } else if (!owner) this.expandedPanels.delete(component);
      const parts = owner ? this.panelParts(content, owner.toolCallId!) : undefined;
      if (kind === "system" && typeof parentId === "string") block.parent = { id: parentId, owner, parts };
      if (parts) for (const part of parts) {
        const adapter = nativeKinds[nameOf(part)];
        const partKind = adapter?.accepts(part as NativeContent) ? adapter.kind : "system";
        block.entries.push(this.entry(part, partKind, [], true, owner));
      } else block.entries.push(this.entry(component, kind, spacing, true, owner));
    }
    if (old) block.entries = block.entries.map(entry => reuse(entry, old.entries));
    return block;
  }

  private entry(source: Component, kind: ContentKind, spacing: Component[], compact: boolean, owner?: NativeContent): ContentEntry {
    const tool = kind === "tool" ? (): ToolSummary => {
      const native = source as NativeContent;
      return {
        name: native.toolName!, args: native.args,
        status: callStatus(native), images: imageCount(native.result?.content),
      };
    } : undefined;
    return { source, owner: owner ?? source, component: source, kind: owner ? "tool" : kind, spacing, compact, tool, search: width => {
      const native = source as NativeContent;
      if (kind === "tool") {
        if (typeof native.toolName !== "string") throw new Error("Pi's tool metadata is not supported");
        return {
          label: native.toolName,
          text: [native.toolName, JSON.stringify(native.args, null, 2), contentText(native.result?.content), this.nested.search(native.toolCallId ?? "")].filter(Boolean).join("\n"),
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
      const saved = contentText(native.message?.content) || native.message?.summary || "";
      const rendered = componentText(native.customComponent ?? source) ||
        searchText(source.render(width).join("\n")).split("\n").map(line => line.trimEnd()).join("\n").replace(/^\n+|\n+$/g, "");
      const text = [saved || rendered];
      if (native.customComponent && rendered && !text.some(part => part.includes(rendered))) text.push(rendered);
      for (const result of nestedResultText(native.customComponent)) if (!text.some(part => part.includes(result))) text.push(result);
      return {
        label: owner?.toolName ?? (native.message?.summary !== undefined ? "Summary" : "System"),
        text: text.filter(Boolean).join("\n"),
        reveal: typeof native.setExpanded === "function" ? () => native.setExpanded!(true) : undefined,
      };
    } };
  }

  private assistantEntries(source: NativeAssistant, spacing: Component[]): ContentEntry[] {
    // Native rendering creates one child per visible text block or consecutive thinking run.
    // Match those children to semantic content before projecting; a Text diagnostic is not thinking.
    const runs: ContentKind[] = [];
    forEachRun(source, kind => runs.push(kind));
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
    // Entries outlive one classification; search reads the current diagnostics.
    this.diagnostics.set(source, diagnostics);
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
      // Keep the array of unchanged views: their native render caches compare child identity.
      if (content.children.length !== parts.length || content.children.some((child, index) => child !== parts[index])) content.children = parts;
      result.push({
        source, owner: source, component: view, kind: pane === "activity" ? "thinking" : runs.includes("dialogue") ? "dialogue" : "system", spacing, compact: true,
        search: width => {
          const kind = pane === "activity" ? "thinking" : "text";
          const saved = (source.lastMessage?.content ?? []).filter(block => block.type === kind)
            .map(block => kind === "text" ? block.text ?? "" : block.thinking ?? "").join("\n\n");
          return {
            label: pane === "activity" ? "Thinking" : "Assistant",
            text: [saved, ...(pane === "chat" ? (this.diagnostics.get(source) ?? []).map(child => searchText(child.render(width).join("\n"))) : [])].filter(Boolean).join("\n\n"),
            reveal: pane === "activity" ? () => source.setHideThinkingBlock(false) : undefined,
          };
        },
      });
    }
    return result;
  }
}
