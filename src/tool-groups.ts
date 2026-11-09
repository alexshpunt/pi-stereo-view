import type { Component } from "@earendil-works/pi-tui";
import type { ContentEntry, ToolSummary } from "./content.ts";

export interface ToolGroup { calls: ContentEntry[]; key: string; name: string; status: ToolSummary["status"] }

/** Adjacency is measured before pane filtering; live calls break runs. Linked output belongs to its call. */
export function toolGroups(entries: readonly ContentEntry[], present: (name: string) => { name: string; key: string },
  live: (source: Component) => boolean = () => false): Map<Component, ToolGroup> {
  const groups = new Map<Component, ToolGroup>();
  let run: ToolGroup | undefined;
  for (const entry of entries) {
    if (entry.owner !== entry.source) continue;
    // A call still shown in full neither joins nor continues a group.
    if (!entry.tool || live(entry.source)) { run = undefined; continue; }
    const { name, status } = entry.tool();
    const identity = present(name);
    if (!run || run.key !== identity.key || run.status !== status || status === "error") run = { calls: [], ...identity, status };
    run.calls.push(entry);
    groups.set(entry.source, run);
  }
  return groups;
}

/** Every group has one state; failed calls always remain individual rows. */
export function groupSummary(group: ToolGroup): ToolSummary {
  return { name: group.name, args: undefined, status: group.status };
}
