import { writeFile } from "node:fs/promises";
import path from "node:path";
import { setImmediate } from "node:timers/promises";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, Text, visibleWidth, type TUI } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { emittedFrame } from "./emitted-frame.js";

export const aliasNames = {
  source: "alias_probe", local: "mcp__local__alias_probe",
  foreign: "mcp__remote__alias_probe", unknown: "unknown_alias_fixture",
};
type Host = TUI & { getScreenLines(): string[]; handleTerminalInput(data: string): void };

/** Exercise alias presentation without installing or replacing an execution forwarder. */
export default function compactAliasesProbe(pi: ExtensionAPI): void {
  let tui: Host;
  const singleton = process.env.COMPACT_ALIAS_SINGLETON === "1";
  const frames: Record<string, string[]> = {};
  const executions: { name: string; id: string; tag: string }[] = [];
  const capture = async (name?: string): Promise<string[]> => {
    await emittedFrame(tui, () => tui.requestRender(true));
    const lines = tui.getScreenLines();
    if (name) frames[name] = lines;
    return lines.map(stripTerminalSequences);
  };
  const input = async (data: string): Promise<void> => { tui.handleTerminalInput(data); await setImmediate(); };
  const click = async (label: string, owner = ""): Promise<void> => {
    const lines = await capture();
    const y = lines.findIndex(line => line.includes(owner) && line.includes(label));
    if (y < 0) throw new Error("Missing alias fixture target: " + owner + " " + label);
    const index = lines[y].indexOf(label, lines[y].indexOf(owner));
    const x = visibleWidth(lines[y].slice(0, index)) + 2;
    await input(`\x1b[<0;${x + 1};${y + 1}M`);
    await input(`\x1b[<0;${x + 1};${y + 1}m`);
  };
  pi.on("session_start", async (_event, ctx) => {
    let finish = (): void => {};
    await ctx.ui.custom<void>((host, _theme, _keys, done) => {
      tui = host as Host; finish = done; return new Text("", 0, 0);
    }, { overlay: true, overlayOptions: { visible: () => false, nonCapturing: true }, onHandle: () => finish() });
  });
  const parameters = Type.Object({ tag: Type.String() });
  const description = "Produce a value through the selected fixture identity.";
  for (const [kind, name] of Object.entries(aliasNames)) {
    pi.registerTool({
      name, label: name, description, parameters,
      ...(kind === "source" ? { namespace: { name: "ide_alias_fixture" } } :
        kind === "foreign" ? { namespace: { name: "mcp__remote" } } : {}),
      ...(kind === "unknown" ? {} : {
        renderCall: (args: { tag?: string }) => new Text("ORIGINAL-" + name + "-" + args.tag, 0, 0),
        renderResult: (result: { content: { type: string; text?: string }[] }) => new Text(result.content
          .filter(block => block.type === "text").map(block => block.text).join("\n"), 0, 0),
      }),
      async execute(id, args) {
        executions.push({ name, id, tag: args.tag });
        if (singleton && kind === "source") {
          await capture("singleton");
          await click(args.tag, name);
          await capture("singletonOpen");
        }
        if (singleton && kind === "local") await capture("formed");
        return { content: [{ type: "text", text: "RESULT-" + args.tag }], details: {} };
      },
    });
  }
  pi.on("agent_before_settle", async (_event, ctx) => {
    try {
      if (singleton) {
        await capture("formedDone");
        await click(aliasNames.source);
        await capture("groupHidden");
        await click(aliasNames.source);
        await capture("groupRestored");
      } else {
        await capture("collapsed");
        await click(aliasNames.source);
        await capture("members");
        await click("S938", aliasNames.source);
        await capture("sourceFull");
        await click("S938", aliasNames.source);
        await click("L938", aliasNames.source);
        await capture("aliasFull");
        await click("L938", aliasNames.source);
        await click("F938", aliasNames.foreign);
        await capture("foreignFull");
        await click("F938", aliasNames.foreign);
        await click("U938", aliasNames.unknown);
        await capture("fallbackFull");
        await click("U938", aliasNames.unknown);
        await click(aliasNames.source);
        await capture("collapsedAgain");
      }
      const starts = ctx.sessionManager.getBranch().flatMap(entry => entry.type === "custom" && entry.customType === "pi-agent-transcript/tool-start"
        ? [entry.data] : []);
      await writeFile(path.join(ctx.cwd, "compact-alias-observation.json"), JSON.stringify({ frames, executions, starts }));
    } catch (error) {
      await capture("failure");
      await writeFile(path.join(ctx.cwd, "compact-alias-observation.json"), JSON.stringify({ frames, executions, error: String(error) }));
      throw error;
    }
  });
}
