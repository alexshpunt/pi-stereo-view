import type { Theme } from "@earendil-works/pi-coding-agent";
import { Container, Text, type Component } from "@earendil-works/pi-tui";
import { componentTree, type ContentEntry, type ToolSummary } from "./content.js";
import { CompactTool } from "./compact-tools.js";
import type { SearchClock } from "./search-highlight.js";
import type { NestedCall, NestedCalls } from "./nested-calls.js";
import type { ToolPresentation } from "./tool-presentation.js";
import { ToolIndent } from "./tool-indent.js";

export interface NativeTreeBody { entry: ContentEntry; component: Component; excerpt?: Component; clock?(): SearchClock | undefined }
interface Node { key: string; summary: ToolSummary; children: Node[]; count?: number }

/** Structural disclosure only: every result body is the original native component. */
export class NestedTree extends Container {
  readonly positions = new Map<Component, { row: number; lines: string[]; clock?: SearchClock; excerptRow?: number }>();
  private parent?: NativeTreeBody;
  private panels: NativeTreeBody[] = [];
  private reveal?: Component;
  private readonly open = new Map<string, boolean>();
  private readonly revealed = new Set<string>();
  private readonly rows = new Map<string, CompactTool>();
  private readonly indents = new WeakMap<Component, Map<string, ToolIndent>>();
  private buckets = new Map<string, string>();
  private nodes = new Map<string, Node>();
  private mode?: boolean;

  constructor(readonly rootId: string, private readonly calls: NestedCalls, private readonly theme: () => Theme,
    private readonly present: (name: string) => ToolPresentation, private readonly compact: () => boolean, private readonly changed: () => void, private readonly gutter: () => number = () => 0) { super(); }

  setBodies(parent: NativeTreeBody, panels: NativeTreeBody[], reveal?: Component): void {
    this.parent = parent; this.panels = panels; this.reveal = reveal;
  }
  private isOpen(key: string): boolean { return this.revealed.has(key) || (this.open.get(key) ?? !this.compact()); }
  private indent(component: Component, depth: number, body = false): Component {
    const gutter = this.gutter();
    if (!depth && !gutter) return component;
    let levels = this.indents.get(component);
    if (!levels) { levels = new Map(); this.indents.set(component, levels); }
    const key = `${gutter}:${depth}:${body}`;
    let view = levels.get(key);
    if (!view) { view = new ToolIndent(component, depth, body, this.theme, gutter); levels.set(key, view); }
    return view;
  }
  private header(node: Node, expandable: boolean): CompactTool {
    // Include expandability in the key: late native output can turn a leaf into a disclosure.
    const key = node.key + (expandable ? ":open" : ":leaf");
    let row = this.rows.get(key);
    if (!row) {
      row = new CompactTool(() => this.nodes.get(node.key)!.summary, this.theme, {
        alignControl: true,
        count: node.count ? () => this.nodes.get(node.key)!.count! : undefined,
        expanded: () => this.isOpen(node.key),
        toggle: expandable ? () => { this.open.set(node.key, !this.isOpen(node.key)); this.changed(); } : undefined,
      });
      this.rows.set(key, row);
    }
    return row;
  }
  override render(width: number): string[] {
    if (!this.parent) return [];
    if (this.mode !== this.compact()) { this.open.clear(); this.mode = this.compact(); }
    this.revealed.clear();
    const records = this.calls.entries(this.rootId);
    const siblings = new Map<string, NestedCall[]>();
    for (const call of records) {
      const list = siblings.get(call.parent) ?? []; list.push(call); siblings.set(call.parent, list);
    }
    this.nodes = new Map();
    const buckets = new Map<string, string>();
    const paths = new Map<string, string[]>();
    const make = (parent: string, ancestors: string[], visiting = new Set<string>()): Node[] => {
      if (visiting.has(parent)) return [];
      const seen = new Set(visiting); seen.add(parent);
      const runs: NestedCall[][] = [];
      for (const call of siblings.get(parent) ?? []) {
        const last = runs.at(-1);
        if (last && this.present(last[0].name).key === this.present(call.name).key) last.push(call); else runs.push([call]);
      }
      return runs.map(run => {
        const grouped = run.length > 1;
        const key = grouped ? "group:" + run[0].id : run[0].id;
        const path = [...ancestors, key]; paths.set(key, path);
        const children = run.map(call => {
          buckets.set(call.id, key);
          const callPath = grouped ? [...path, call.id] : path; paths.set(call.id, callPath);
          const node: Node = { key: call.id, summary: { ...call, name: this.present(call.name).name }, children: make(call.id, callPath, seen) };
          this.nodes.set(node.key, node);
          return node;
        });
        if (!grouped) return children[0];
        const status = run.some(call => call.status === "error") ? "error" : run.some(call => call.status === "running") ? "running" :
          run.some(call => call.status === "unknown") ? "unknown" : "success";
        const group: Node = { key, count: run.length, summary: { name: this.present(run[0].name).name, args: undefined, status }, children };
        this.nodes.set(key, group);
        return group;
      });
    };
    const roots = make(this.rootId, []);
    // A late sibling can turn an open singleton into a group. Carry only the
    // immediately visible state; an explicitly closed group must remain closed.
    for (const [id, key] of buckets) {
      const previous = this.buckets.get(id);
      if (previous && previous !== key && !this.open.has(key) && this.isOpen(previous)) this.open.set(key, true);
    }
    this.buckets = buckets;
    const attached = new Map<string, NativeTreeBody[]>();
    const identified = this.panels.map(panel => ({ panel, ids: [...new Set(componentTree(panel.entry.source)
      .filter(node => node.constructor.name === "ToolExecutionComponent" && typeof node.toolCallId === "string").map(node => node.toolCallId!))] }));
    const independent = new Map<string, Set<string>>();
    for (const { ids } of identified) {
      const bucket = ids.length === 1 ? buckets.get(ids[0]) : undefined;
      if (!bucket) continue;
      const group = independent.get(bucket) ?? new Set<string>();
      group.add(ids[0]); independent.set(bucket, group);
    }
    for (const { panel, ids } of identified) {
      const locations = ids.map(id => buckets.get(id));
      // Independent native results belong to their calls. One shared result for
      // several siblings stays whole at the group; opaque bodies stay at the caller.
      const bucket = locations.length && locations[0] && locations.every(location => location === locations[0]) ? locations[0] : "";
      const key = ids.length === 1 && (independent.get(bucket)?.size ?? 0) > 1 ? ids[0] : bucket;
      const list = attached.get(key) ?? []; list.push(panel); attached.set(key, list);
      if (this.reveal === panel.entry.source) for (const ancestor of paths.get(key) ?? ["output"]) this.revealed.add(ancestor);
    }
    const output: Node = { key: "output", summary: { ...this.parent.entry.tool!(), name: this.present(this.parent.entry.tool!().name).name + " output", args: undefined }, children: [] };
    this.nodes.set(output.key, output);
    if (this.reveal === this.parent.entry.source) this.revealed.add(output.key);
    const result: Component[] = [];
    this.positions.clear();
    let row = 0;
    const append = (component: Component, depth: number, body = false): string[] => {
      const view = this.indent(component, depth, body);
      result.push(view);
      const lines = view.render(width); row += lines.length; return lines;
    };
    const appendBody = (body: NativeTreeBody, depth: number): void => {
      const start = row;
      const lines = append(body.component, depth, depth > 0);
      const excerptRow = body.excerpt ? row : undefined;
      if (body.excerpt) append(body.excerpt, depth, depth > 0);
      this.positions.set(body.entry.source, { row: start, lines, clock: body.clock?.(), excerptRow });
    };
    const paint = (node: Node, depth: number): void => {
      const panels = attached.get(node.key) ?? [];
      const expandable = node.children.length > 0 || panels.length > 0;
      append(this.header(node, expandable), depth);
      if (!expandable || !this.isOpen(node.key)) return;
      for (const child of node.children) paint(child, depth + 1);
      for (const panel of panels) appendBody(panel, depth + 1);
    };
    for (const root of roots) paint(root, 0);
    if (this.calls.isIncomplete(this.rootId)) append(new Text(this.theme().fg("dim", "Nested call record incomplete"), 0, 0), 0);
    append(this.header(output, true), 0);
    if (this.isOpen(output.key)) {
      for (const panel of attached.get("") ?? []) appendBody(panel, 1);
      appendBody(this.parent, 1);
    }
    this.children = result;
    return super.render(width);
  }
}
