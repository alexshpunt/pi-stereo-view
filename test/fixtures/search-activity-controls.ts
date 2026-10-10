import { writeFile } from "node:fs/promises";
import path from "node:path";
import { setImmediate } from "node:timers/promises";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Container, ScrollView, stripTerminalSequences, Text, visibleWidth, type TUI } from "@earendil-works/pi-tui";
import { Type } from "typebox";

type Host = TUI & { getScreenLines(): string[]; handleTerminalInput(data: string): void; layoutRoot?: Container };

/** Exercise saved and hidden Activity text through inline search and native renderers. */
export default function searchActivityControls(pi: ExtensionAPI): void {
  let tui: Host;
  const capture = async (): Promise<string[]> => {
    tui.requestRender(true);
    await setImmediate();
    return tui.getScreenLines();
  };
  const input = async (data: string): Promise<void> => {
    tui.handleTerminalInput(data);
    await setImmediate();
  };
  const click = async (label: string, owner: string): Promise<void> => {
    const lines = (await capture()).map(stripTerminalSequences);
    const row = lines.findIndex(line => line.includes(owner) && line.includes(label));
    if (row < 0) throw new Error("Missing panel control " + owner + " " + label);
    const offset = lines[row].indexOf(label, lines[row].indexOf(owner));
    const x = visibleWidth(lines[row].slice(0, offset)) + 2;
    await input(`\x1b[<0;${x + 1};${row + 1}M`);
    await input(`\x1b[<0;${x + 1};${row + 1}m`);
  };
  const containers = (): Container[] => {
    const found = new Set<Container>();
    const walk = (component: Container): void => {
      if (found.has(component)) return;
      found.add(component);
      for (const child of component.children ?? []) if (child instanceof Container) walk(child);
    };
    if (tui.layoutRoot) walk(tui.layoutRoot);
    return [...found];
  };
  const view = (pane: string): ScrollView => {
    const found = containers().find(component => component instanceof ScrollView && Reflect.get(component.children[0], "pane") === pane);
    if (!(found instanceof ScrollView)) throw new Error("Missing native scroll view " + pane);
    return found;
  };
  for (const name of ["saved_probe", "saved_hidden"]) {
    pi.registerTool({
      name, label: name, description: "Saved search fixture", parameters: Type.Object({}),
      renderCall: () => new Text(name === "saved_hidden" ? "CUSTOM NATIVE HEADER" : "SAVED NATIVE HEADER", 0, 0),
      renderResult: (result, options) => new Text(name === "saved_hidden" ? "CUSTOM NATIVE RESULT" :
        options.expanded ? result.content.filter(block => block.type === "text").map(block => block.text).join("\n") : "COLLAPSED NATIVE RESULT", 0, 0),
      async execute() { throw new Error("Saved tool must not execute"); },
    });
  }
  pi.on("session_start", async (_event, ctx) => {
    let finish = (): void => {};
    await ctx.ui.custom<void>((host, _theme, _keys, done) => {
      tui = host as Host;
      finish = done;
      return new Text("", 0, 0);
    }, { overlay: true, overlayOptions: { visible: () => false, nonCapturing: true }, onHandle: () => finish() });
  });
  pi.on("agent_before_settle", async (_event, ctx) => {
    const frames: Record<string, string[]> = {};
    const states: Record<string, { chatTop: number; activityTop: number; follow: boolean }> = {};
    ctx.ui.setEditorText("ACTIVITY UNSENT DRAFT");
    await capture();
    for (const component of containers()) {
      if (component.constructor.name === "ToolExecutionComponent") Reflect.get(component, "setExpanded").call(component, false);
    }
    frames.initial = await capture();
    const snapshot = (name: string): void => {
      states[name] = { chatTop: view("chat").scrollTop, activityTop: view("activity").scrollTop, follow: view("activity").isFollowingEnd };
    };
    snapshot("initial");
    await click("Activity", "Activity");
    frames.active = await capture();
    const search = async (name: string, query: string, header = false, choose = true): Promise<void> => {
      if (header) await click("[ ⌕ ]", "Activity");
      else await input("\x06");
      frames[name + "Picker"] = await capture();
      await input(query);
      frames[name + "Query"] = await capture();
      await input(choose ? "\r" : "\x1b");
      // Navigation may need a second render to measure a revealed native block.
      await capture();
      frames[name] = await capture();
      snapshot(name);
      if (choose) await input("\x1b");
    };
    await search("tool", "rstrtwrkr");
    await search("thinking", "скртйрсскй");
    await search("custom", "cstm hddn rslt", true);
    await search("missing", "ABANDONED BRANCH UNIQUE", false, false);
    await search("scope", "deployment runtime ready", false, false);
    await click("[ ⌕ ]", "Conversation");
    frames.ownHeader = await capture();
    await input("ЗАПУСК РАБОЧЕГО");
    frames.russianQuery = await capture();
    await input("\r");
    frames.russian = await capture();
    // The wheel event, not just a header click, must choose Activity again.
    const lines = (await capture()).map(stripTerminalSequences);
    const row = lines.findIndex(line => line.includes("Activity"));
    const x = visibleWidth(lines[row].slice(0, lines[row].indexOf("Activity"))) + 2;
    await input(`\x1b[<64;${x + 1};${row + 3}M`);
    await input("\x06");
    frames.wheelPicker = await capture();
    await input("\x1b");
    await click("[ ↗ ]", "Activity");
    await input("\x06");
    frames.expandedPicker = await capture();
    await input("\x1b");
    await click("[ ↙ ]", "Activity");
    await click("[ ▣ ]", "[ ▣ ]");
    await input("\x06");
    frames.combinedPicker = await capture();
    await input("\x1b");
    await click("[ ◫ ]", "[ ◫ ]");
    const { columns, rows } = process.stdout;
    try {
      process.stdout.columns = 40;
      process.stdout.rows = 8;
      process.stdout.emit("resize");
      await capture();
      await input("\x06");
      frames.fallbackPicker = await capture();
      await input("\x1b");
    } finally {
      process.stdout.columns = columns;
      process.stdout.rows = rows;
      process.stdout.emit("resize");
    }
    frames.restored = await capture();
    await writeFile(path.join(ctx.cwd, "search-activity-frames.json"), JSON.stringify({ frames, states, draft: ctx.ui.getEditorText() }));
  });
}
