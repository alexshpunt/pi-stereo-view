import type { ToolSummary } from "./content.ts";

type Start = { parentToolCallId?: string; toolCallId: string; toolName: string; args: unknown };
type End = { toolCallId: string; isError: boolean };
type SavedCall = { id: string; name: string; status: string; arguments?: unknown; error?: string };
type SavedMessage = { role: string; toolCallId?: string; nestedCalls?: { calls: SavedCall[]; complete: boolean } };

export interface NestedCall extends ToolSummary { id: string; parent: string; root: string; error?: string }

/** Execution identities only. Native tools and extensions retain ownership of all result UI. */
export class NestedCalls {
  private readonly calls = new Map<string, NestedCall>();
  private readonly roots = new Map<string, NestedCall[]>();
  private readonly incomplete = new Set<string>();
  revision = 0;

  entries(root: string): readonly NestedCall[] { return this.roots.get(root) ?? []; }
  private put(call: NestedCall): void {
    const existing = this.calls.get(call.id);
    if (existing) { Object.assign(existing, call); return; }
    this.calls.set(call.id, call);
    const list = this.roots.get(call.root) ?? [];
    list.push(call); this.roots.set(call.root, list);
  }
  isIncomplete(root: string): boolean { return this.incomplete.has(root); }
  search(root: string): string {
    return this.entries(root).map(call => [call.name, JSON.stringify(call.args, null, 2), call.error].filter(Boolean).join("\n")).join("\n");
  }
  start(event: Start): void {
    if (!event.parentToolCallId) return;
    const parent = this.calls.get(event.parentToolCallId);
    this.put({ id: event.toolCallId, parent: event.parentToolCallId, root: parent?.root ?? event.parentToolCallId,
      name: event.toolName, args: event.args, status: "running" });
    this.revision++;
  }
  end(event: End): void {
    const call = this.calls.get(event.toolCallId);
    if (!call) return;
    call.status = event.isError ? "error" : "success";
    this.revision++;
  }
  absorb(message: SavedMessage): void {
    if (message.role !== "toolResult" || !message.toolCallId || !Array.isArray(message.nestedCalls?.calls)) return;
    const root = message.toolCallId;
    const ids = new Set(message.nestedCalls.calls.map(call => call.id));
    for (const record of message.nestedCalls.calls) {
      const existing = this.calls.get(record.id);
      // Pi records nested identities as <caller-id>/<ordinal>, including deeper calls.
      const parent = record.id.slice(0, record.id.lastIndexOf("/"));
      this.put({ id: record.id, root, parent: existing?.parent ?? (ids.has(parent) ? parent : root),
        name: record.name, args: record.arguments, error: record.error,
        status: record.status === "ok" ? "success" : record.status === "error" ? "error" : "unknown" });
    }
    if (message.nestedCalls.complete) this.incomplete.delete(root); else this.incomplete.add(root);
    this.revision++;
  }
  restore(branch: readonly { type: string; message?: unknown }[]): void {
    this.calls.clear(); this.roots.clear(); this.incomplete.clear(); this.revision++;
    for (const entry of branch) if (entry.type === "message" && entry.message && typeof entry.message === "object") this.absorb(entry.message as SavedMessage);
  }
}
