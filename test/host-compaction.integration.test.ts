import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { PiIntegrationTest } from "pi-coding-agent-test";
import { afterEach, beforeAll, expect, test } from "vitest";

const columns = 120;
const chatWidth = 40;
const directories: string[] = [];
const clean = (lines: string[]): string[] => lines.map(stripTerminalSequences);

beforeAll(async () => { await mkdir(path.resolve("tmp"), { recursive: true }); });
afterEach(async () => {
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

async function run(mode: "bolt" | "unknown") {
  const cwd = await mkdtemp(path.resolve("tmp/host-compaction-"));
  const agent = await mkdtemp(path.resolve("tmp/host-compaction-agent-"));
  directories.push(cwd, agent);
  await writeFile(path.join(agent, "settings.json"), JSON.stringify({
    packages: [path.resolve(".")], quietStartup: true, hideThinkingBlock: false,
  }));
  await writeFile(path.join(agent, "transcript.json"), JSON.stringify({
    side: "left", chatWidth, layout: "columns", chatHeight: null, showTimestamps: false, showCopyButtons: false,
  }));
  const result = await new PiIntegrationTest({
    testName: `host-compaction-${mode}`, artifactsDir: path.resolve("tmp/test-runs"), cwd,
    piCommand: path.resolve("test/fixtures/startup-host.sh"), isolateUserResources: false,
    environment: { PI_CODING_AGENT_DIR: agent, HOST_COMPACTION: mode },
    rawMode: false, tuiSize: { cols: columns, rows: 40 }, tools: [],
    providerMode: "user", model: "host-compaction-test/host-compaction",
    extensions: [path.resolve("test/fixtures/host-compaction-probe.ts")],
  }).run("FIRST USER");
  const frames: Record<string, string[]> = JSON.parse(await readFile(path.join(cwd, "host-compaction-frames.json"), "utf8"));
  return { result, frames };
}

/** Text of each split panel: Conversation on the left of the column divider, Activity on the right. */
function panes(lines: string[]): { chat: string; activity: string } | undefined {
  const header = lines.findIndex(line => line.includes("Conversation") && line.includes("Activity"));
  if (header < 0) return undefined;
  const divider = lines[header].indexOf("║");
  return {
    chat: lines.slice(header + 1).map(line => line.slice(0, divider)).join("\n"),
    activity: lines.slice(header + 1).map(line => line.slice(divider + 1)).join("\n"),
  };
}

test("keeps a Pi-Bolt reply split after Pi-Bolt releases its native children", async () => {
  const { result, frames } = await run("bolt");
  for (const key of ["compacted", "later"]) {
    const split = panes(clean(frames[key]));
    expect(split, key).toBeDefined();
    expect(split!.chat, key).toContain("ANSWER 1");
    expect(split!.chat, key).not.toContain("REASONING 1");
    expect(split!.activity, key).toContain("REASONING 1");
    expect(split!.activity, key).not.toContain("ANSWER 1");
  }
  expect(panes(clean(frames.second))!.chat).toContain("ANSWER 2");
  expect(result.terminalOutput).not.toContain("split disabled");
  expect(result.terminalOutput).not.toContain("/issues/new?");
});

test("an unreadable reply turns the split off with a report link instead of ending Pi", async () => {
  const { result, frames } = await run("unknown");
  const later = clean(frames.later).join("\n");
  expect(panes(clean(frames.later))).toBeUndefined();
  expect(later).toContain("FIRST USER");
  expect(later).toContain("github.com/alexshpunt/pi-stereo-view/issues");
  // Pi keeps working: the next turn runs and its reply is shown in Pi's own history.
  const assistants = (result.messages as { role: string }[]).filter(message => message.role === "assistant");
  expect(assistants).toHaveLength(2);
  expect(clean(frames.second).join("\n")).toContain("ANSWER 2");
  // The prefilled issue carries the error for GitHub's new-issue form.
  const link = /https:\/\/github\.com\/alexshpunt\/pi-stereo-view\/issues\/new\?[^\x1b\x07]+/.exec(result.terminalOutput)?.[0];
  expect(link).toBeDefined();
  const url = new URL(link!);
  expect(url.searchParams.get("title")).toBeTruthy();
  // The stack names the code that failed, so the report can be traced without the user's session.
  expect(url.searchParams.get("body")).toMatch(/at \S*assistantEntries/);
});
