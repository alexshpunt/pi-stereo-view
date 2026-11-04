import { writeFile } from "node:fs/promises";
import { setTimeout } from "node:timers/promises";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text, stripTerminalSequences, type Component, type TUI } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { emittedFrame } from "./emitted-frame.js";

type Document = Component & { pane: string; source: { children: Component[] }; beginFrame(): void; searchEntries(): { text: string; label: string }[]; handleMouse(event: import("@earendil-works/pi-tui").TuiMouseEvent): unknown };
type Host = TUI & { layoutRoot: Component; getScreenLines(): string[] };
type Entry = { source: Component; owner: Component; component: Component; search(width: number): { text: string } };
interface GroupDisclosure { closed: string[]; opened: string[]; reclosed: string[]; reopened: string[]; panelCounts: number[][] }
interface CallDisclosure extends GroupDisclosure { id: string; name: string; expandable: boolean }
interface Capture { panes: Record<string, string[]>; search: Record<string, { text: string; label: string }[]>; screen: string[]; children: { type: string; text: string }[]; toolIds: string[]; originalSources: boolean; originalRenderers: boolean; copies: string[]; folded: string[]; group?: GroupDisclosure; individual?: { grouped: string[]; panelCounts: number[]; calls: CallDisclosure[] } }

/** Follow rendered component links once per parent, retaining duplicate placements. */
function references(root: Component, ancestors = new Set<Component>()): Component[] {
  if (ancestors.has(root)) return [];
  const next = new Set(ancestors).add(root);
  const node = root as Component & { children?: Component[]; child?: Component; component?: Component };
  const children = new Set([...(node.children ?? []), node.child, node.component].filter((child): child is Component => typeof child?.render === "function"));
  return [root, ...[...children].flatMap(child => references(child, next))];
}

/** Observe native history while actual nested tools run through Pi. */
export default function nestedActivityProbe(pi: ExtensionAPI): void {
  let tui: Host;
  const captures: Record<string, Capture> = {};
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
    let children: Capture["children"] = [];
    let toolIds: string[] = [];
    let copies: string[] = [];
    let originalSources = false;
    let originalRenderers = false;
    let folded: string[] = [];
    let group: GroupDisclosure | undefined;
    let individual: Capture["individual"];
    for (const document of documents) {
      document.beginFrame();
      if (document.pane === "activity") {
        const index = Reflect.get(document, "index") as { entries(pane: string): Entry[]; copy(entry: Entry, width: number): string | undefined };
        const entries = index.entries("activity");
        const originals = (document.source.children[2] as Component & { children: Component[] }).children;
        const originalComponents = new Set(originals.flatMap(component => references(component)));
        originalSources = entries.every(entry => originalComponents.has(entry.source));
        toolIds = entries.filter(entry => entry.owner === entry.source && entry.source.constructor.name === "ToolExecutionComponent").map(entry => Reflect.get(entry.source, "toolCallId") as string);
        const panels = entries.filter(entry => typeof Reflect.get(entry.source, "customComponent") === "object");
        children = originals.filter(component => typeof Reflect.get(component, "customComponent") === "object" &&
          entries.some(entry => references(component).includes(entry.source)))
          .map(component => ({ type: component.constructor.name, text: component.render(180).join("\n") }));
        copies = entries.map(entry => index.copy(entry, 180) ?? "");
        const render = (): string[] => {
          document.beginFrame();
          return document.render(180).map(stripTerminalSequences);
        };
        const click = (row: number, lines: string[]): void => {
          const x = Math.max(8, lines[row].search(/[▸▾]/u) + 1);
          const event = { type: "click" as const, button: "left" as const, x, y: row, screenX: x, screenY: row, width: 180, height: lines.length, shift: false, alt: false, ctrl: false };
          document.handleMouse({ ...event, type: "press" });
          document.handleMouse(event);
        };
        const panelCounts = (): number[] => {
          const visible = references(document);
          return panels.map(panel => visible.filter(component => component === panel.source).length);
        };
        if (process.env.NESTED_ACTIVITY_CALLER) {
          const parentName = process.env.NESTED_ACTIVITY_CALLER === "parent" ? "nested_activity_parent" : process.env.NESTED_ACTIVITY_CALLER;
          for (const entry of entries) if (Reflect.get(entry.source, "toolName") === parentName)
            (Reflect.get(entry.source, "setExpanded") as (expanded: boolean) => void).call(entry.source, true);
          const lines = render();
          const row = lines.findIndex(line => /●\s+▸/u.test(line) && line.includes(parentName));
          if (row >= 0) click(row, lines);
          folded = render();
          // Exercise a child group independently from the root and native output.
          const groupRow = folded.findIndex(line => /●\s+[▸▾].*×\d+/u.test(line));
          if (groupRow >= 0) {
            if (folded[groupRow].includes("▾")) { click(groupRow, folded); render(); }
            const closed = render();
            const counts = [panelCounts()];
            click(groupRow, closed);
            const opened = render(); counts.push(panelCounts());
            click(groupRow, opened);
            const reclosed = render(); counts.push(panelCounts());
            click(groupRow, reclosed);
            const reopened = render(); counts.push(panelCounts());
            group = { closed, opened, reclosed, reopened, panelCounts: counts };
          }
          if (process.env.NESTED_ACTIVITY_INDIVIDUAL === "1") {
            const units = [...originalComponents].filter(component => component.constructor.name === "ToolExecutionComponent" &&
              ["read", "bash", "search", "replace"].includes(Reflect.get(component, "toolName") as string));
            const counts = (): number[] => {
              const visible = references(document);
              return units.map(unit => visible.filter(component => component === unit).length);
            };
            // A group reveals call headers; only each call's disclosure reveals its body.
            for (let pass = 0; pass < 16; pass++) {
              const current = render();
              const next = current.findIndex(line => /●\s+▸.*×\d+/u.test(line));
              if (next < 0) break;
              click(next, current);
            }
            individual = { grouped: render(), panelCounts: counts(), calls: [] };
            for (const unit of units) {
              const name = Reflect.get(unit, "toolName") as string;
              const args = Reflect.get(unit, "args") as Record<string, unknown>;
              const marker = [args.command, args.query, args.path].find(value => typeof value === "string") as string;
              const header = (lines: string[]): number => lines.findIndex(line =>
                new RegExp("●\\s+(?:[▸▾]\\s+)?" + name + "\\b", "u").test(line) && line.includes(marker));
              let current = render();
              let selected = header(current);
              const expandable = selected >= 0 && /●\s+[▸▾]/u.test(current[selected]);
              if (expandable && current[selected].includes("▾")) { click(selected, current); current = render(); }
              const closed = current;
              const panelCounts = [counts()];
              if (expandable) { selected = header(current); click(selected, current); current = render(); }
              const opened = current; panelCounts.push(counts());
              if (expandable) { selected = header(current); click(selected, current); current = render(); }
              const reclosed = current; panelCounts.push(counts());
              if (expandable) { selected = header(current); click(selected, current); current = render(); }
              const reopened = current; panelCounts.push(counts());
              individual.calls.push({ id: Reflect.get(unit, "toolCallId") as string, name, expandable,
                closed, opened, reclosed, reopened, panelCounts });
              if (expandable) { selected = header(current); click(selected, current); render(); }
            }
          }
          // Reveal remaining child nodes and the original parent output via mouse.
          for (let pass = 0; pass < 32; pass++) {
            const current = render();
            const next = current.findIndex(line => /●\s+▸/u.test(line));
            if (next < 0) break;
            click(next, current);
          }
        }
        render();
        const nativeTools = new Set(originals.flatMap(component => references(component)).filter(component => component.constructor.name === "ToolExecutionComponent"));
        originalRenderers = references(document).filter(component => component.constructor.name === "ToolExecutionComponent").every(component => nativeTools.has(component));
      }
      panes[document.pane] = document.render(180);
      search[document.pane] = document.searchEntries().map(({ text, label }) => ({ text, label }));
    }
    await emittedFrame(tui, () => tui.requestRender(true));
    captures[phase] = { panes, search, screen: tui.getScreenLines(), children, toolIds, originalSources, originalRenderers, copies, folded, group, individual };
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
    renderResult: result => new Text(String((result.details as { nativeValue?: string } | undefined)?.nativeValue ?? ""), 0, 0),
    async execute(_id, args) {
      await setTimeout(350);
      if (args.fail) throw new Error("FAILURE-RESULT-Q82");
      return { content: [{ type: "text", text: "SUCCESS-RESULT-P82" }], details: { nativeValue: "NATIVE-RESULT-P82" } };
    },
  });
  pi.registerTool({
    name: "nested_activity_parent", label: "Nested parent", description: "Execute two nested calls and render their outcomes.",
    parameters: Type.Object({}),
    renderResult: result => {
      const calls = (result.details as { calls?: { marker: string; status: string }[] } | undefined)?.calls ?? [];
      return new Text([...calls.map(call => `${call.marker}: ${call.status}`), ...result.content.flatMap(block => block.type === "text" ? [block.text] : [])].join("\n"), 0, 0);
    },
    async execute(_id, _args, _signal, update, ctx) {
      const calls = [
        { marker: "ARG-P82", status: "running", fail: false },
        { marker: "ARG-Q82", status: "running", fail: true },
      ];
      update?.({ content: [{ type: "text", text: calls.map(call => `${call.marker}: ${call.status}`).join("\n") }], details: { calls: calls.map(call => ({ ...call })) } });
      const pending = calls.map(async call => {
        const outcome = await ctx.executeTool("nested_activity_leaf", { marker: call.marker, fail: call.fail });
        call.status = outcome.isError ? "error" : "ok";
        return outcome;
      });
      await setTimeout(100);
      await observe("running");
      const outcomes = await Promise.all(pending);
      return { content: [{ type: "text", text: calls.map(call => `${call.marker}: ${call.status}`).join("\n") }, ...outcomes.flatMap(outcome => outcome.result.content)], details: { calls } };
    },
  });
  let runningCapture: Promise<void> | undefined;
  pi.on("tool_execution_start", event => {
    if (process.env.NESTED_ACTIVITY_CALLER === "codemode" && event.toolName === "nested_activity_leaf" && !runningCapture) {
      runningCapture = setTimeout(100).then(() => observe("running"));
    }
  });
  pi.on("agent_before_settle", async () => {
    await runningCapture;
    await observe("settled");
    if (process.env.NESTED_ACTIVITY_HOLD === "1") await setTimeout(20_000);
  });
}
