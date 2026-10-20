import { writeFile } from "node:fs/promises";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";
import { Container, MouseRegion, Text, stripTerminalSequences, type Component, type TUI, type TuiMouseEvent } from "@earendil-works/pi-tui";
import type { SearchEntry, SearchHit } from "../../src/search.js";
import { emittedFrame } from "./emitted-frame.js";

type Document = Container & {
  pane: string;
  source: Container;
  beginFrame(): void;
  searchEntries(): SearchEntry[];
  reveal(hit: SearchHit, query: string): boolean;
  searchRow(hit: SearchHit): number | undefined;
};
type Host = TUI & { layoutRoot: Component; getScreenLines(): string[] };
type Native = Component & { toolCallId?: string; children?: Component[]; child?: Component; component?: Component };
const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6SAAAAABJRU5ErkJggg==";
const empty = (): Component => ({ render: () => [], invalidate() {} });
const content = () => [{ type: "text" as const, text: "HIDDEN AGENT RESULT" },
  { type: "image" as const, data: png, mimeType: "image/png" }];

/** Exercise renderer-controlled visibility with genuine native tool and image components. */
export default function invisibleToolProbe(pi: ExtensionAPI): void {
  let tui: Host;
  let clicks = 0;
  const stages: Record<string, unknown> = {};
  const documents = (): Document[] => {
    const found: Document[] = [];
    const visited = new Set<Component>();
    const visit = (component: Native): void => {
      if (visited.has(component)) return;
      visited.add(component);
      if (component.constructor.name === "NativeDocument") { found.push(component as Document); return; }
      for (const child of component.children ?? []) visit(child);
      if (component.child) visit(component.child);
    };
    visit(tui.layoutRoot);
    return found;
  };
  const toolId = (root: Native, visited = new Set<Component>()): string | undefined => {
    if (visited.has(root)) return;
    visited.add(root);
    if (root.toolCallId) return root.toolCallId;
    for (const child of [...(root.children ?? []), root.child, root.component]) {
      if (!child) continue;
      const id = toolId(child, visited);
      if (id) return id;
    }
  };
  const observe = async () => {
    await emittedFrame(tui, () => tui.requestRender(true));
    const mounted = documents();
    const activity = mounted.find(document => document.pane === "activity")!;
    const history = activity.source.children[2] as Container;
    const original = [...history.children];
    activity.beginFrame();
    const lines = activity.render(180);
    const blocks: Record<string, string[]> = {};
    for (const child of activity.children) {
      const id = toolId(child);
      if (id) blocks[id] = child.render(180);
    }
    const nativeBlocks: Record<string, string[]> = {};
    for (const child of history.children as Native[]) if (child.toolCallId) nativeBlocks[child.toolCallId] = child.render(180);
    const chat = mounted.find(document => document.pane === "chat")!;
    chat.beginFrame();
    return { blocks, nativeBlocks, lines, chat: chat.render(180), screen: tui.getScreenLines(),
      sourceChildrenUnchanged: original.length === history.children.length && original.every((child, index) => child === history.children[index]) };
  };
  pi.on("session_start", async (_event, ctx) => {
    let finish = (): void => {};
    await ctx.ui.custom<void>((host, _theme, _keys, done) => {
      tui = host as Host;
      finish = done;
      return new Text("", 0, 0);
    }, { overlay: true, overlayOptions: { visible: () => false, nonCapturing: true }, onHandle: () => finish() });
  });
  pi.registerEntryRenderer<{ parentToolCallId: string }>("visible-hidden-owner-note", () => new Text("VISIBLE LINKED DIAGNOSTIC", 0, 0));
  pi.on("message_end", event => {
    if (event.message.role === "toolResult" && event.message.toolCallId === "silent-picture") {
      pi.appendEntry("visible-hidden-owner-note", { parentToolCallId: event.message.toolCallId });
    }
  });
  pi.registerTool({
    name: "silent_picture", label: "Silent picture", description: "Return an agent-only image and text.", parameters: Type.Object({}),
    renderShell: "self", renderCall: empty, renderResult: empty,
    async execute() { return { content: content(), details: {} }; },
  });
  pi.registerTool({
    name: "changing_picture", label: "Changing picture", description: "Change native visibility while executing.", parameters: Type.Object({}),
    renderShell: "self", renderCall: empty,
    renderResult: result => (result.details as { visible?: boolean } | undefined)?.visible
      ? new Text("VISIBLE PARTIAL RESULT", 0, 0) : empty(),
    async execute(_id, _args, _signal, onUpdate) {
      stages.start = await observe();
      onUpdate?.({ content: content(), details: { visible: false } });
      stages.hiddenPartial = await observe();
      onUpdate?.({ content: content(), details: { visible: true } });
      stages.visiblePartial = await observe();
      onUpdate?.({ content: content(), details: { visible: false } });
      stages.hiddenAgain = await observe();
      return { content: content(), details: { visible: false } };
    },
  });
  pi.registerTool({
    name: "plain_picture", label: "Plain picture", description: "Return an ordinary visible image without custom renderers.", parameters: Type.Object({}),
    async execute() { return { content: [{ type: "image" as const, data: png, mimeType: "image/png" }], details: {} }; },
  });
  pi.registerTool({
    name: "painted_picture", label: "Painted picture", description: "Return visible custom content and an image.", parameters: Type.Object({}),
    renderShell: "self", renderCall: () => new Text("VISIBLE CUSTOM CALL", 0, 0),
    renderResult: () => new MouseRegion(new Text("VISIBLE CUSTOM RESULT", 0, 0), event => {
      if (event.type !== "click") return;
      clicks++;
      return { handled: true };
    }),
    async execute() { return { content: content(), details: {} }; },
  });
  pi.on("agent_before_settle", async () => {
    stages.final = await observe();
    const activity = documents().find(document => document.pane === "activity")!;
    const entry = activity.searchEntries().find(item => item.text.includes("VISIBLE LINKED DIAGNOSTIC"));
    if (!entry) throw new Error("A visible diagnostic of the hidden tool is missing from Activity search");
    const hit: SearchHit = { entry, line: 0, text: "VISIBLE LINKED DIAGNOSTIC", ranges: [{ start: 0, end: 25 }] };
    const revealed = activity.reveal(hit, hit.text);
    const lines = activity.render(180);
    const searchRow = activity.searchRow(hit);
    const mouseRow = lines.findIndex(line => stripTerminalSequences(line).includes("VISIBLE CUSTOM RESULT"));
    const before = clicks;
    activity.handleMouse({ type: "click", button: "left", x: 2, y: mouseRow, screenX: 2, screenY: mouseRow,
      width: 180, height: lines.length } as TuiMouseEvent);
    await writeFile(process.env.INVISIBLE_TOOLS_FILE!, JSON.stringify({ stages, revealed, searchRow, searched: lines,
      clickedVisibleResult: clicks === before + 1 }));
  });
}
