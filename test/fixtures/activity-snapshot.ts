import { writeFile } from "node:fs/promises";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text, type Component, type TUI } from "@earendil-works/pi-tui";
import { emittedFrame } from "./emitted-frame.js";

type Document = Component & { pane: string; beginFrame(): void; handleMouse(event: import("@earendil-works/pi-tui").TuiMouseEvent): unknown };
type Host = TUI & { layoutRoot: Component; getScreenLines(): string[] };

export default function activitySnapshot(pi: ExtensionAPI): void {
  let tui: Host;
  if (process.env.SYNTHETIC_NESTED_REPORT) pi.registerEntryRenderer<{ parentToolCallId: string; text: string }>(
    "nested-report", (entry, options) => new Text(entry.data!.text + (options.expanded ? "\nNESTED DETAIL" : ""), 0, 0));
  pi.on("session_start", async (_event, ctx) => {
    let finish = (): void => {};
    await ctx.ui.custom<void>((host, _theme, _keys, done) => {
      tui = host as Host; finish = done; return new Text("", 0, 0);
    }, { overlay: true, overlayOptions: { visible: () => false, nonCapturing: true }, onHandle: () => finish() });
  });
  pi.on("agent_before_settle", async () => {
    if (process.env.SYNTHETIC_NESTED_REPORT) pi.appendEntry("nested-report", { parentToolCallId: "nested-edit", text: "NESTED REPORT DATA" });
    await emittedFrame(tui, () => tui.requestRender(true));
    const documents: Document[] = [];
    const seen = new Set<Component>();
    const visit = (component: Component): void => {
      if (seen.has(component)) return;
      seen.add(component);
      if (component.constructor.name === "NativeDocument") { documents.push(component as Document); return; }
      const node = component as Component & { children?: Component[]; child?: Component };
      for (const child of node.children ?? []) visit(child);
      if (node.child) visit(node.child);
    };
    visit(tui.layoutRoot);
    const panes: Record<string, string[]> = {};
    for (const document of documents) { document.beginFrame(); panes[document.pane] = document.render(180); }
    const activity = documents.find(document => document.pane === "activity")!;
    const lines = panes.activity.map(line => line.replace(/\x1b\[[0-9;]*m/g, ""));
    const row = lines.findIndex(line => /●\s+▸\s+codemode\b/u.test(line));
    if (row < 0) throw new Error("Collapsed nested caller not found");
    const x = lines[row].indexOf("▸") + 1;
    const event = { type: "click" as const, button: "left" as const, x, y: row, screenX: x, screenY: row, width: 180, height: lines.length, shift: false, alt: false, ctrl: false };
    activity.handleMouse({ ...event, type: "press" });
    activity.handleMouse(event);
    await emittedFrame(tui, () => tui.requestRender(true));
    activity.beginFrame();
    const opened = activity.render(180);
    const tree = (activity as Document & { children: Component[] }).children.flatMap(child => {
      const queue = [child];
      const found: Component[] = [];
      for (const node of queue) {
        if (node.constructor.name === "NestedTree") found.push(node);
        else queue.push(...((node as Component & { children?: Component[] }).children ?? []));
      }
      return found;
    })[0];
    if (!tree?.handleMouse) throw new Error("Nested tree not found");
    const treeLines = tree.render(178).map(line => line.replace(/\x1b\[[0-9;]*m/g, ""));
    const outputRow = treeLines.findIndex(line => /▸\s+codemode output\b/u.test(line));
    if (outputRow < 0) throw new Error("Nested output row not found");
    const outputX = Math.max(8, treeLines[outputRow].indexOf("▸") + 1);
    const outputEvent = { ...event, x: outputX, y: outputRow, screenX: outputX, screenY: outputRow, width: 178, height: treeLines.length };
    tree.handleMouse({ ...outputEvent, type: "press" });
    tree.handleMouse(outputEvent);
    activity.beginFrame();
    const outputOpened = activity.render(180);
    await writeFile(process.env.ACTIVITY_SNAPSHOT!, JSON.stringify({ panes, opened, outputOpened, screen: tui.getScreenLines() }));
  });
}
