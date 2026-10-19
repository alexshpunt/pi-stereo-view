import { readFile, writeFile } from "node:fs/promises";
import { setImmediate } from "node:timers/promises";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Container, stripTerminalSequences, Text, type Component, type TUI } from "@earendil-works/pi-tui";
import type { SearchEntry, SearchHit } from "../../src/search.js";
import { emittedFrame } from "./emitted-frame.js";

type Document = Component & {
  pane: string;
  source: Container;
  beginFrame(): void;
  searchEntries(): SearchEntry[];
  reveal(hit: SearchHit, query: string): boolean;
  searchRow(hit: SearchHit): number | undefined;
};
type Host = TUI & {
  layoutRoot: Component;
  getScreenLines(): string[];
  handleTerminalInput(data: string): void;
  getFocusedComponent(): Component | null;
};
type Output = { parentToolCallId: string; text: string };

/** An unrelated producer publishes late output after both native tools finish. */
export default function linkedOutputProbe(pi: ExtensionAPI): void {
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
  const observe = async () => {
    await emittedFrame(tui, () => tui.requestRender(true));
    const mounted = documents();
    const history = mounted[0].source.children[2] as Container;
    const original = [...history.children];
    const native = history.render(180);
    const panes: Record<string, string[]> = {};
    const search: Record<string, { text: string; label: string }[]> = {};
    for (const document of mounted) {
      document.beginFrame();
      panes[document.pane] = document.render(180);
      search[document.pane] = document.searchEntries().map(({ text, label }) => ({ text, label }));
    }
    return {
      panes, search, native, screen: tui.getScreenLines(),
      sourceChildrenUnchanged: original.length === history.children.length &&
        original.every((child, index) => child === history.children[index]),
    };
  };
  let lifecycle: Record<string, Awaited<ReturnType<typeof observe>>> = {};
  const saveLifecycle = () => writeFile(process.env.LINKED_OUTPUT_FILE!, JSON.stringify(lifecycle));
  const input = async (data: string): Promise<void> => {
    tui.handleTerminalInput(data);
    await setImmediate();
  };
  const searchActivity = async (query: string): Promise<void> => {
    await emittedFrame(tui, () => tui.requestRender(true));
    const frame = tui.getScreenLines().map(stripTerminalSequences);
    const row = frame.findIndex(line => line.includes("Activity") && line.includes("[ ⌕ ]"));
    if (row < 0) throw new Error("Activity search button is missing");
    const column = frame[row].lastIndexOf("[ ⌕ ]") + 2;
    await input(`\x1b[<0;${column + 1};${row + 1}M`);
    await input(`\x1b[<0;${column + 1};${row + 1}m`);
    await input(query);
  };
  pi.registerCommand("linked-output-lifecycle-check", {
    description: "Reload with linked output selected in Activity search",
    handler: async (_args, ctx) => {
      await searchActivity("OLD LINKED OUTPUT");
      lifecycle.beforeReload = await observe();
      await saveLifecycle();
      await ctx.reload();
    },
  });
  pi.registerCommand("linked-output-branch-check", {
    description: "Switch branches with linked output selected in Activity search",
    handler: async (_args, ctx) => {
      await searchActivity("OLD LINKED OUTPUT");
      lifecycle.beforeBranch = await observe();
      await ctx.navigateTree(process.env.LINKED_OUTPUT_BRANCH_TARGET!, { summarize: false });
      lifecycle.branched = await observe();
      await searchActivity("OLD LINKED OUTPUT");
      lifecycle.oldQuery = await observe();
      await input("\x1b");
      await searchActivity("NEW LINKED OUTPUT");
      lifecycle.newQuery = await observe();
      await input("\r");
      lifecycle.revealed = await observe();
      await input("\x1b");
      await saveLifecycle();
      pi.sendUserMessage("Finish the linked-output lifecycle check");
    },
  });
  pi.registerEntryRenderer<Output>("unrelated-worker-report", (entry, options) =>
    new Text(entry.data!.text + (options.expanded ? "\nEXPANDED WORKER DETAIL" : ""), 0, 0));
  pi.registerMessageRenderer("unrelated-worker-message", message => new Text(String(message.content), 0, 0));
  pi.on("session_start", async (event, ctx) => {
    let finish = (): void => {};
    await ctx.ui.custom<void>((host, _theme, _keys, done) => {
      tui = host as Host;
      finish = done;
      return new Text("", 0, 0);
    }, { overlay: true, overlayOptions: { visible: () => false, nonCapturing: true }, onHandle: () => finish() });
    if (!process.env.LINKED_OUTPUT_BRANCH_TARGET || event.reason !== "reload") return;
    lifecycle = JSON.parse(await readFile(process.env.LINKED_OUTPUT_FILE!, "utf8"));
    const reloadFocus = tui.getFocusedComponent();
    void emittedFrame(tui, () => tui.requestRender(true), () => tui.getFocusedComponent() !== reloadFocus).then(async () => {
      lifecycle.reloaded = await observe();
      await saveLifecycle();
      await input("/linked-output-branch-check");
      await input("\r");
    });
  });
  pi.on("agent_before_settle", async () => {
    if (process.env.LINKED_OUTPUT_BRANCH_TARGET) {
      lifecycle.finished = await observe();
      await saveLifecycle();
      return;
    }
    if (process.env.LINKED_OUTPUT_APPEND === "1") {
      // Arrival order deliberately differs from the execution order.
      pi.appendEntry("unrelated-worker-report", { parentToolCallId: "second-write", text: "LATE SECOND OUTPUT" });
      pi.appendEntry("unrelated-worker-report", { parentToolCallId: "first-write", text: "LATE FIRST OUTPUT" });
      pi.appendEntry("unrelated-worker-report", { parentToolCallId: "first-write", text: "LATER FIRST UPDATE" });
      pi.appendEntry("unrelated-worker-report", { parentToolCallId: "missing-call", text: "UNOWNED WORKER REPORT" });
    }
    await emittedFrame(tui, () => tui.requestRender(true));
    const mounted = documents();
    const history = mounted[0].source.children[2] as Container;
    const original = [...history.children];
    for (const child of original) {
      const output = child as Component & { entry?: { data?: Output }; setExpanded?: (expanded: boolean) => void };
      if (output.entry?.data?.text) output.setExpanded?.(false);
    }
    await emittedFrame(tui, () => tui.requestRender(true));
    const native = history.render(180);
    const panes: Record<string, string[]> = {};
    const search: Record<string, { text: string; label: string }[]> = {};
    for (const document of mounted) {
      document.beginFrame();
      panes[document.pane] = document.render(180);
      search[document.pane] = document.searchEntries().map(({ text, label }) => ({ text, label }));
    }
    const activity = mounted.find(document => document.pane === "activity")!;
    const entry = activity.searchEntries().find(entry => entry.text.includes("LATE FIRST OUTPUT"));
    if (!entry) throw new Error("Late output is missing from Activity search");
    const hit: SearchHit = { entry, line: 0, text: "LATE FIRST OUTPUT", ranges: [{ start: 0, end: 17 }] };
    const revealed = activity.reveal(hit, "LATE FIRST OUTPUT");
    const expanded = activity.render(180);
    const searchRow = activity.searchRow(hit);
    await emittedFrame(tui, () => tui.requestRender(true));
    await writeFile(process.env.LINKED_OUTPUT_FILE!, JSON.stringify({
      panes, search, native, expanded, revealed, searchRow,
      sourceChildrenUnchanged: original.length === history.children.length &&
        original.every((child, index) => child === history.children[index]),
      screen: tui.getScreenLines(),
    }));
  });
}
