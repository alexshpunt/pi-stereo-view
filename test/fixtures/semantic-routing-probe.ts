import { writeFile } from "node:fs/promises";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Container, Text, type Component, type TUI } from "@earendil-works/pi-tui";
import { emittedFrame } from "./emitted-frame.js";

type Document = Component & {
  pane: string;
  source: Container;
  beginFrame(): void;
  searchEntries(): { text: string; label: string }[];
};
type Host = TUI & { layoutRoot: Component; getScreenLines(): string[] };

class OpaqueSystemNote extends Text {}

/** Observe real native diagnostics, reused statuses and execution through the same pane/search APIs. */
export default function semanticRoutingProbe(pi: ExtensionAPI): void {
  let tui: Host;
  const documents = (): Document[] => {
    const found: Document[] = [];
    const seen = new Set<Component>();
    const visit = (component: Component): void => {
      if (seen.has(component)) return;
      seen.add(component);
      if (component.constructor.name === "NativeDocument") {
        found.push(component as Document);
        return;
      }
      const owner = component as Component & { children?: Component[]; child?: Component };
      for (const child of owner.children ?? []) visit(child);
      if (owner.child) visit(owner.child);
    };
    visit(tui.layoutRoot);
    return found;
  };
  pi.on("session_start", async (_event, ctx) => {
    let finish = (): void => {};
    await ctx.ui.custom<void>((host, _theme, _keys, done) => {
      tui = host as Host;
      finish = done;
      return new Text("", 0, 0);
    }, { overlay: true, overlayOptions: { visible: () => false, nonCapturing: true }, onHandle: () => finish() });
    ctx.ui.notify("STARTUP INFO MARKER", "info");
    ctx.ui.notify("STARTUP WARNING MARKER", "warning");
    ctx.ui.notify("STARTUP ERROR MARKER", "error");
  });
  pi.on("message_end", event => {
    if (event.message.role !== "assistant") return;
    return { message: {
      ...event.message,
      content: [{ type: "thinking", thinking: "THINKING EXECUTION MARKER" }, ...event.message.content],
    } };
  });
  pi.registerEntryRenderer<{ parentToolCallId: string }>("semantic-execution-output", () =>
    new Text("LINKED TOOL OUTPUT MARKER", 0, 0));
  pi.on("message_end", event => {
    if (event.message.role === "toolResult") {
      pi.appendEntry("semantic-execution-output", { parentToolCallId: event.message.toolCallId });
    }
  });
  pi.on("agent_before_settle", async (_event, ctx) => {
    ctx.ui.notify("RUNTIME WARNING MARKER", "warning");
    ctx.ui.notify("RUNTIME ERROR MARKER", "error");
    ctx.ui.notify("FIRST RUNTIME STATUS", "info");
    await emittedFrame(tui, () => tui.requestRender(true));
    const source = documents()[0].source.children[2] as Container;
    const status = source.children.at(-1);
    ctx.ui.notify("UPDATED RUNTIME STATUS", "info");
    await emittedFrame(tui, () => tui.requestRender(true));
    const reusedStatus = source.children.at(-1) === status;
    source.addChild(new OpaqueSystemNote("UNKNOWN SYSTEM MARKER", 0, 0));
    await emittedFrame(tui, () => tui.requestRender(true));
    const panes: Record<string, string[]> = {};
    const search: Record<string, { text: string; label: string }[]> = {};
    for (const document of documents()) {
      document.beginFrame();
      panes[document.pane] = document.render(180);
      search[document.pane] = document.searchEntries().map(({ text, label }) => ({ text, label }));
    }
    await writeFile(process.env.SEMANTIC_ROUTING_FILE!, JSON.stringify({ panes, search, reusedStatus, screen: tui.getScreenLines() }));
  });
}
