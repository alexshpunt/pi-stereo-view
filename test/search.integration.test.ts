import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { assistantMessage, PiIntegrationTest, text } from "pi-coding-agent-test";
import { afterEach, beforeAll, expect, test } from "vitest";

const directories: string[] = [];
const clean = (frame: string[]): string[] => frame.map(stripTerminalSequences);
beforeAll(async () => { await mkdir(path.resolve("tmp"), { recursive: true }); });
afterEach(async () => {
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

test.each(["columns", "rows"] as const)("searches Conversation with keyboard and header in %s without altering the draft", async layout => {
  const cwd = await mkdtemp(path.resolve("tmp/search-"));
  const agent = await mkdtemp(path.resolve("tmp/search-agent-"));
  directories.push(cwd, agent);
  await writeFile(path.join(agent, "settings.json"), JSON.stringify({ quietStartup: true }));
  await writeFile(path.join(agent, "transcript.json"), JSON.stringify({
    mode: "split", side: "left", chatWidth: 45, layout, chatHeight: null, zoom: null, showTimestamps: true,
  }));
  // Explicitly enable the native shortcut too, so an accidental double search is exercised on every host.
  await writeFile(path.join(agent, "keybindings.json"), JSON.stringify({ "tui.altScreen.search": "ctrl+f" }));
  const result = await new PiIntegrationTest({
    testName: "search-" + layout, artifactsDir: path.resolve("tmp/test-runs"), cwd,
    piCommand: path.resolve("test/fixtures/pi-host.sh"), isolateUserResources: false,
    environment: { PI_CODING_AGENT_DIR: agent },
    rawMode: false, tuiSize: { cols: 140, rows: 40 },
    extensions: [path.resolve("src/index.ts"), path.resolve("test/fixtures/search-controls.ts")],
    tools: [], conversation: [assistantMessage([text(Array.from({ length: 60 }, (_, row) => "History line " + row).join("\n"))])],
  }).run("deployment runtime ready");
  expect(result.providerRequests).toHaveLength(1);
  const observation: { frames: Record<string, string[]>; draft: string } = JSON.parse(await readFile(path.join(cwd, "search-frames.json"), "utf8"));
  const { frames } = observation;
  await writeFile(path.resolve("tmp/test-runs", "search-" + layout, "search-frames.json"), JSON.stringify(observation));
  expect(clean(frames.keyboard).join("\n")).toContain("Search Conversation");
  expect(clean(frames.query).join("\n")).toContain("deployment runtime ready");
  expect(clean(frames.canceled).join("\n")).not.toContain("Search Conversation");
  expect(clean(frames.header).join("\n")).toContain("Search Conversation");
  expect(clean(frames.jumped).join("\n")).toContain("deployment runtime ready");
  expect(clean(frames.jumped).join("\n")).not.toContain("Search Conversation");
  expect(observation.draft).toBe("UNSENT SEARCH DRAFT");
  for (const frame of Object.values(frames)) {
    for (const line of frame) expect(visibleWidth(line)).toBeLessThanOrEqual(140);
  }
});
