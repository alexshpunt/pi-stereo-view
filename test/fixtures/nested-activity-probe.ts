import { writeFile } from "node:fs/promises";
import { setTimeout } from "node:timers/promises";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text, type Component, type TUI } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { emittedFrame } from "./emitted-frame.js";

type Document = Component & { pane: string; beginFrame(): void; searchEntries(): { text: string; label: string }[] };
type Host = TUI & { layoutRoot: Component; getScreenLines(): string[] };

/** An actual tool executes two concurrently running nested tools through Pi. */
export default function nestedActivityProbe(pi: ExtensionAPI): void {
  let tui: Host;
  const captures: Record<string, { panes: Record<string, string[]>; search: Record<string, { text: string; label: string }[]>; screen: string[] }> = {};
  const observe = async (phase: string) => {
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
    const search: Record<string, { text: string; label: string }[]> = {};
    for (const document of documents) {
      document.beginFrame();
      panes[document.pane] = document.render(180);
      search[document.pane] = document.searchEntries().map(({ text, label }) => ({ text, label }));
    }
    captures[phase] = { panes, search, screen: tui.getScreenLines() };
    await writeFile(process.env.NESTED_ACTIVITY_CAPTURE!, JSON.stringify(captures));
  };
  pi.on("session_start", async (_event, ctx) => {
    let finish = (): void => {};
    await ctx.ui.custom<void>((host, _theme, _keys, done) => {
      tui = host as Host; finish = done; return new Text("", 0, 0);
    }, { overlay: true, overlayOptions: { visible: () => false, nonCapturing: true }, onHandle: () => finish() });
  });
  pi.registerTool({
    name: "nested_activity_leaf", label: "Nested leaf", description: "Run one deterministic nested call.",
    parameters: Type.Object({ marker: Type.String(), fail: Type.Boolean() }),
    executionMode: "parallel",
    async execute(_id, args) {
      await setTimeout(350);
      if (args.fail) throw new Error("FAILURE-RESULT-Q82");
      return { content: [{ type: "text", text: "SUCCESS-RESULT-P82" }], details: {} };
    },
  });
  pi.registerTool({
    name: "nested_activity_parent", label: "Nested parent", description: "Execute two nested calls.",
    parameters: Type.Object({}),
    async execute(_id, _args, _signal, _update, ctx) {
      const calls = [
        ctx.executeTool("nested_activity_leaf", { marker: "ARG-P82", fail: false }),
        ctx.executeTool("nested_activity_leaf", { marker: "ARG-Q82", fail: true }),
      ];
      await setTimeout(100);
      await observe("running");
      await Promise.all(calls);
      return { content: [{ type: "text", text: "PARENT-RESULT-82" }], details: {} };
    },
  });
  let runningCapture: Promise<void> | undefined;
  pi.on("tool_execution_start", event => {
    if (process.env.NESTED_ACTIVITY_CALLER === "codemode" && event.toolName === "nested_activity_leaf" && !runningCapture) {
      runningCapture = setTimeout(100).then(() => observe("running"));
    }
  });
  pi.on("agent_before_settle", async () => { await runningCapture; await observe("settled"); });
}
