import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { setImmediate } from "node:timers/promises";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, Text, type TUI } from "@earendil-works/pi-tui";

type Host = TUI & { getScreenLines(): string[]; handleTerminalInput(data: string): void };

/**
 * Open Pi's session tree by double Escape and by /tree, and extension dialogs, after the first answer settles, then
 * record the screens. A follow-up message ends the scenario.
 */
export default function piWindowsProbe(pi: ExtensionAPI): void {
  let host: Host;
  let started = false;
  pi.on("session_start", async (_event, ctx) => {
    await ctx.ui.custom<void>((tui, _theme, _keys, done) => {
      host = tui as Host;
      queueMicrotask(done);
      return new Text("", 0, 0);
    }, { overlay: true, overlayOptions: { visible: () => false, nonCapturing: true } });
  });
  pi.on("agent_settled", (_event, ctx) => {
    if (started) return;
    started = true;
    // Double Escape opens the tree only while no agent run is streaming.
    void setImmediate().then(() => probe(ctx)).catch(async error => {
      await writeFile(path.join(ctx.cwd, "pi-windows-frames.json"), JSON.stringify({ error: String(error?.stack ?? error) }));
      pi.sendUserMessage("PROBE-DONE");
    });
  });

  async function probe(ctx: ExtensionContext): Promise<void> {
    const frames: Record<string, string[]> = {};
    const capture = async (key: string): Promise<string[]> => {
      host.requestRender(true);
      await setImmediate();
      const lines = host.getScreenLines().map(stripTerminalSequences);
      frames[key] = lines;
      return lines;
    };
    const key = async (data: string): Promise<void> => {
      host.handleTerminalInput(data);
      await setImmediate();
    };
    const click = async (label: string, side?: "left" | "right"): Promise<void> => {
      const lines = await capture("_");
      const y = lines.findIndex(line => line.includes(label));
      if (y < 0) throw new Error("Missing control " + label + "\n" + lines.join("\n"));
      const x = lines[y].indexOf(label, side === "right" ? lines[y].indexOf("║") + 1 : 0);
      await key(`\x1b[<0;${x + 1};${y + 1}M`);
      await key(`\x1b[<0;${x + 1};${y + 1}m`);
    };
    const doubleEscape = async (): Promise<void> => { await key("\x1b"); await key("\x1b"); };
    const preferencesFile = path.join(getAgentDir(), "transcript.json");
    const savedBefore = await readFile(preferencesFile, "utf8");

    await capture("split");
    await doubleEscape();
    await capture("treeEscape");
    await key("\x1b");
    await capture("afterEscape");

    // Choosing another entry closes the tree and asks "Summarize branch?" in Pi's general selector; Escape there
    // reopens the tree, and Escape again closes it without navigating.
    await doubleEscape();
    await key("\x1b[A");
    await key("\r");
    await capture("treeSummary");
    await key("\x1b");
    await capture("treeAgain");
    await key("\x1b");
    await capture("afterSummary");

    for (const character of "/tree") await key(character);
    await key("\r");
    // Enter may first accept the command completion.
    if (ctx.ui.getEditorText().trim()) await key("\r");
    await capture("treeCommand");
    // The current leaf is selected first; choosing it closes the tree without navigating.
    await key("\r");
    await capture("afterSelect");
    const savedAfter = await readFile(preferencesFile, "utf8");

    const select = ctx.ui.select("EXTENSION-SELECT-PROBE", ["CHOICE-A", "CHOICE-B"]);
    await capture("extensionSelect");
    await key("\r");
    const selected = await select;
    const custom = ctx.ui.custom<string>((_tui, _theme, _keys, done) => ({
      render: () => ["EXTENSION-CUSTOM-PROBE"],
      invalidate() {},
      handleInput: (data: string) => { if (data === "\r") done("CUSTOM-VALUE"); },
    }));
    await capture("extensionCustom");
    await key("\r");
    const customValue = await custom;

    await click("[ ▤ ]");
    await doubleEscape();
    await capture("rowsTree");
    await key("\x1b");
    await click("[ ▥ ]");

    await click("[ ↗ ]", "left");
    await doubleEscape();
    await capture("chatZoomTree");
    await key("\x1b");
    await click("[ ↙ ]");
    await capture("restored");

    await writeFile(path.join(ctx.cwd, "pi-windows-frames.json"), JSON.stringify({
      frames, selected, customValue, savedUnchanged: savedBefore === savedAfter,
    }));
    pi.sendUserMessage("PROBE-DONE");
  }
}
