import { ToolExecutionComponent, type ToolRenderers } from "@earendil-works/pi-coding-agent";
import { Text, stripTerminalSequences, type Component, type TUI } from "@earendil-works/pi-tui";

type Start = { parentToolCallId: string; toolCallId: string; toolName: string; args: unknown };
type End = { parentToolCallId: string; toolCallId: string; toolName: string; result: { content?: unknown }; isError: boolean; durationMs?: number };
type RecordCall = { id: string; name: string; status: "ok" | "error" | "unfinished"; arguments?: unknown; argumentsBytes?: number; error?: string };
type SavedMessage = { role: string; toolCallId?: string; nestedCalls?: { complete: boolean; calls: RecordCall[] } };
type Call = { root: string; id: string; name: string; args: unknown; status: string; result?: string; saved?: boolean; bytes?: number; parallel?: boolean; view: Component };

const clean = (value: string): string => stripTerminalSequences(value).replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "");
const resultText = (content: unknown): string => Array.isArray(content) ? content.map(block =>
  block?.type === "text" && typeof block.text === "string" ? clean(block.text.replace(/^<system-result\b[^>]*><uuid>[a-f\d-]{36}<\/uuid><\/system-result>\n/iu, "")) : block?.type === "image" ? "[image]" : "").filter(Boolean).join("\n") : "";

/** Display-only nested call state. Saved records never imply that a result was saved. */
export class NestedActivity {
  private calls = new Map<string, Call>();
  private roots = new Map<string, Component[]>();
  private byView = new WeakMap<Component, Call>();
  private notices = new Map<string, Text>();
  revision = 0;

  constructor(private readonly tui?: TUI, private readonly cwd = "", private readonly renderer?: (name: string) => ToolRenderers | undefined) {}

  entries(parent: string): readonly Component[] { return this.roots.get(parent) ?? []; }

  summary(view: Component): { name: string; args: unknown; status: "running" | "success" | "error" | "unknown" } | undefined {
    const call = this.byView.get(view);
    return call ? { name: call.name, args: call.args, status: call.status === "error" ? "error" : call.status === "ok" ? "success" : call.status === "running" ? "running" : "unknown" } : undefined;
  }

  id(view: Component): string | undefined { return this.byView.get(view)?.id; }
  isSaved(view: Component): boolean { return this.byView.get(view)?.saved === true; }
  search(view: Component): string {
    const call = this.byView.get(view);
    return call ? [call.name, JSON.stringify(call.args, null, 2), call.result].filter(Boolean).join("\n") : "";
  }

  private paint(call: Call): void {
    const depth = Math.max(1, call.id.slice(call.root.length).split("/").length - 1);
    const prefix = "  ".repeat(Math.min(depth, 8));
    const args = call.args === undefined ? (call.bytes === undefined ? "" : `Arguments omitted (${call.bytes} bytes)`) : JSON.stringify(call.args, null, 2);
    const details = [args, call.result, call.saved ? "Result not saved" : ""].filter(Boolean).join("\n");
    if (!(call.view instanceof Text)) return;
    call.view.setText(`${prefix}↳ ${clean(call.name)} [${call.status}${call.parallel ? ", overlapping" : ""}]\n${details.split("\n").map(line => prefix + clean(line)).join("\n")}`);
  }

  start(event: Start): void {
    const root = this.calls.get(event.parentToolCallId)?.root ?? event.parentToolCallId;
    const running = [...this.calls.values()].filter(call => call.root === root && call.status === "running" && !event.parentToolCallId.startsWith(call.id + "/") && event.parentToolCallId !== call.id);
    const native = this.tui ? new ToolExecutionComponent(event.toolName, event.toolCallId, event.args, { showImages: true }, this.renderer?.(event.toolName), this.tui, this.cwd) : undefined;
    native?.markExecutionStarted();
    native?.setArgsComplete();
    native?.setExpanded(true);
    const call: Call = { root, id: event.toolCallId, name: event.toolName, args: event.args, status: "running", parallel: running.length > 0, view: native ?? new Text("", 0, 0) };
    for (const other of running) { other.parallel = true; this.paint(other); }
    this.calls.set(call.id, call);
    this.byView.set(call.view, call);
    const entries = this.roots.get(root) ?? [];
    entries.push(call.view);
    this.roots.set(root, entries);
    this.paint(call);
    this.revision++;
  }

  update(event: { toolCallId: string; partialResult: { content?: unknown } }): void {
    const call = this.calls.get(event.toolCallId);
    if (!call) return;
    call.result = resultText(event.partialResult.content);
    if (call.view instanceof ToolExecutionComponent) call.view.updateResult({ ...event.partialResult, content: Array.isArray(event.partialResult.content) ? event.partialResult.content : [], isError: false }, true);
    this.paint(call);
  }

  end(event: End): void {
    const call = this.calls.get(event.toolCallId);
    if (!call) return;
    call.status = event.isError ? "error" : "ok";
    call.result = resultText(event.result.content);
    if (call.view instanceof ToolExecutionComponent) call.view.updateResult({ ...event.result, content: Array.isArray(event.result.content) ? event.result.content : [], isError: event.isError, durationMs: event.durationMs });
    this.paint(call);
  }

  absorb(message: SavedMessage): void {
    const root = message.toolCallId;
    const nested = message.nestedCalls;
    if (message.role !== "toolResult" || !root || !nested || !Array.isArray(nested.calls)) return;
    let entries = this.roots.get(root);
    if (!entries) { entries = []; this.roots.set(root, entries); }
    for (const record of nested.calls) {
      if (this.calls.has(record.id)) continue;
      const call: Call = { root, id: record.id, name: record.name, args: record.arguments, status: record.status,
        bytes: record.argumentsBytes, result: record.error, saved: true, view: new Text("", 0, 0) };
      this.calls.set(record.id, call);
      this.byView.set(call.view, call);
      entries.push(call.view);
      this.paint(call);
      this.revision++;
    }
    if (!nested.complete && !this.notices.has(root)) {
      const notice = new Text("  Nested call record incomplete", 0, 0);
      this.notices.set(root, notice);
      entries.push(notice);
      this.revision++;
    }
  }

  restore(branch: readonly { type: string; message?: unknown }[]): void {
    this.calls.clear(); this.roots.clear(); this.notices.clear(); this.revision++;
    for (const entry of branch) if (entry.type === "message" && entry.message && typeof entry.message === "object") this.absorb(entry.message as SavedMessage);
  }
}
