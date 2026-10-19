import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { assistantMessage, PiIntegrationTest, text } from "pi-coding-agent-test";
import { expect, test } from "vitest";

const firstFrame = (output: string): string => {
  const frame = /\x1b\[\?2026h([\s\S]*?)\x1b\[\?2026l/.exec(output);
  expect(frame, "Pi must emit a synchronized application frame").not.toBeNull();
  return stripTerminalSequences(frame![1]);
};
const workspace = async (): Promise<{ cwd: string; agent: string }> => {
  await mkdir(path.resolve("tmp"), { recursive: true });
  return {
    cwd: await mkdtemp(path.resolve("tmp/first-frame-workspace-")),
    agent: await mkdtemp(path.resolve("tmp/first-frame-agent-")),
  };
};
const preferences = (layout = "columns", mode = "split") => ({
  mode, side: "right", chatWidth: 55, layout, chatHeight: 12, zoom: null, showTimestamps: false,
});
const assertSplit = (frame: string, layout: string): void => {
  expect(frame).toContain("Conversation");
  expect(frame).toContain("Activity");
  expect(frame).toContain(layout === "columns" ? "║" : "═");
  expect(frame.indexOf("Activity")).toBeLessThan(frame.indexOf("Conversation"));
  expect(frame).toContain("─".repeat(140));
};

for (const layout of ["columns", "rows"] as const) for (const slowFirst of [true, false]) {
  test(`shows saved ${layout} in frame one with normal loading, slow package ${slowFirst ? "before" : "after"}`, async () => {
    const { cwd, agent } = await workspace();
    try {
      const slow = path.join(cwd, "slow-package");
      await mkdir(slow);
      await writeFile(path.join(slow, "package.json"), JSON.stringify({ name: "slow-startup-test", pi: { extensions: ["slow.ts"] } }));
      await writeFile(path.join(slow, "slow.ts"), `export default function (pi) { pi.on("session_start", async () => { await new Promise(resolve => setTimeout(resolve, 150)); }); }`);
      const packages = slowFirst ? [slow, path.resolve(".")] : [path.resolve("."), slow];
      await writeFile(path.join(agent, "settings.json"), JSON.stringify({ quietStartup: false, packages }));
      await writeFile(path.join(agent, "transcript.json"), JSON.stringify(preferences(layout)));
      const result = await new PiIntegrationTest({
        testName: `first-frame-${layout}-${slowFirst ? "before" : "after"}`, artifactsDir: path.resolve("tmp/test-runs"), cwd,
        piCommand: path.resolve("test/fixtures/startup-host.sh"), isolateUserResources: false,
        environment: { PI_CODING_AGENT_DIR: agent }, rawMode: false, tuiSize: { cols: 140, rows: 38 },
        extensions: [], tools: [], conversation: [assistantMessage([text("STARTUP COMPLETE")])],
      }).run("STARTUP CHECK");
      assertSplit(firstFrame(result.terminalOutput), layout);
      expect(result.providerRequests).toHaveLength(1);
      expect(result.terminalOutput).not.toContain("early layout is unavailable");
    } finally {
      await Promise.all([cwd, agent].map(directory => rm(directory, { recursive: true, force: true })));
    }
  });
}

test("restores startup hooks before an awaited native initialization dialog", async () => {
  const { cwd, agent } = await workspace();
  try {
    await writeFile(path.join(agent, "transcript.json"), JSON.stringify(preferences()));
    const result = await new PiIntegrationTest({
      testName: "first-frame-dialog", artifactsDir: path.resolve("tmp/test-runs"), cwd,
      piCommand: path.resolve("test/fixtures/pi-host.sh"), isolateUserResources: false,
      environment: { PI_CODING_AGENT_DIR: agent }, rawMode: false, tuiSize: { cols: 140, rows: 38 },
      extensions: [path.resolve("test/fixtures/first-frame-probe.ts"), path.resolve("src/index.ts")],
      tools: [], conversation: [assistantMessage([text("DIALOG COMPLETE")])],
    }).run("STARTUP DIALOG CHECK");
    assertSplit(firstFrame(result.terminalOutput), "columns");
    expect(JSON.parse(await readFile(path.join(cwd, "first-frame-probe.json"), "utf8"))).toEqual({
      selected: "Continue", prototypeRestored: true, startRestored: true, descriptorRestored: true,
    });
    expect(result.terminalOutput).toContain("DIALOG COMPLETE");
  } finally {
    await Promise.all([cwd, agent].map(directory => rm(directory, { recursive: true, force: true })));
  }
});

test("launches a resumed session with its saved split in frame one", async () => {
  const { cwd, agent } = await workspace();
  try {
    const session = SessionManager.create(cwd, cwd);
    session.appendMessage({ role: "user", content: "SAVED STARTUP USER", timestamp: Date.now() });
    await writeFile(path.join(agent, "settings.json"), JSON.stringify({ packages: [path.resolve(".")] }));
    await writeFile(path.join(agent, "transcript.json"), JSON.stringify(preferences()));
    const result = await new PiIntegrationTest({
      testName: "first-frame-resume", artifactsDir: path.resolve("tmp/test-runs"), cwd,
      piCommand: path.resolve("test/fixtures/startup-host.sh"), isolateUserResources: false,
      environment: { PI_CODING_AGENT_DIR: agent, PI_TRANSCRIPT_TEST_SESSION: session.getSessionFile()! },
      rawMode: false, tuiSize: { cols: 140, rows: 38 }, extensions: [], tools: [],
      conversation: [assistantMessage([text("RESUME COMPLETE")])],
    }).run("RESUMED STARTUP CHECK");
    assertSplit(firstFrame(result.terminalOutput), "columns");
    expect(result.terminalOutput).toContain("SAVED STARTUP USER");
  } finally {
    await Promise.all([cwd, agent].map(directory => rm(directory, { recursive: true, force: true })));
  }
});

test("falls back without dropping a foreign startup layout entry", async () => {
  const { cwd, agent } = await workspace();
  try {
    await writeFile(path.join(agent, "transcript.json"), JSON.stringify(preferences()));
    const result = await new PiIntegrationTest({
      testName: "first-frame-foreign-layout", artifactsDir: path.resolve("tmp/test-runs"), cwd,
      piCommand: path.resolve("test/fixtures/pi-host.sh"), isolateUserResources: false,
      environment: { PI_CODING_AGENT_DIR: agent, TRANSCRIPT_FOREIGN_LAYOUT_TEXT: "FOREIGN STARTUP ENTRY" },
      rawMode: false, tuiSize: { cols: 140, rows: 38 },
      extensions: [path.resolve("test/fixtures/incompatible-layout.ts"), path.resolve("src/index.ts"), path.resolve("test/fixtures/native-probe.ts")],
      tools: [], conversation: [assistantMessage([text("FALLBACK ANSWER")])],
    }).run("FOREIGN LAYOUT CHECK");
    const screen: string[] = JSON.parse(await readFile(path.join(cwd, "native-snapshot.json"), "utf8"));
    const visible = screen.map(stripTerminalSequences).join("\n");
    expect(visible).toContain("FOREIGN STARTUP ENTRY");
    expect(visible).toContain("FOREIGN LAYOUT CHECK");
    expect(visible).toContain("FALLBACK ANSWER");
    expect(visible).not.toContain("Conversation");
    expect(visible.split("Pi's fullscreen layout is not supported.")).toHaveLength(2);
    expect(result.providerRequests).toHaveLength(1);
  } finally {
    await Promise.all([cwd, agent].map(directory => rm(directory, { recursive: true, force: true })));
  }
});

for (const fallback of ["combined", "regular", "narrow"] as const) {
  test(`keeps ${fallback} startup usable without forcing split`, async () => {
    const { cwd, agent } = await workspace();
    try {
      await writeFile(path.join(agent, "settings.json"), JSON.stringify({ packages: [path.resolve(".")] }));
      await writeFile(path.join(agent, "transcript.json"), JSON.stringify(preferences("columns", fallback === "combined" ? "combined" : "split")));
      const result = await new PiIntegrationTest({
        testName: `first-frame-${fallback}`, artifactsDir: path.resolve("tmp/test-runs"), cwd,
        piCommand: path.resolve("test/fixtures/startup-host.sh"), isolateUserResources: false,
        environment: { PI_CODING_AGENT_DIR: agent, PI_TRANSCRIPT_TEST_MODE: fallback === "regular" ? "regular" : "fullscreen" },
        rawMode: false, tuiSize: { cols: fallback === "narrow" ? 45 : 140, rows: 38 }, extensions: [], tools: [],
        conversation: [assistantMessage([text("FALLBACK COMPLETE")])],
      }).run("FALLBACK CHECK");
      const frame = firstFrame(result.terminalOutput);
      expect(frame).not.toContain("Conversation");
      expect(frame).not.toContain("Activity");
      expect(result.terminalOutput).toContain("FALLBACK COMPLETE");
      expect(result.terminalOutput).not.toContain("early layout is unavailable");
    } finally {
      await Promise.all([cwd, agent].map(directory => rm(directory, { recursive: true, force: true })));
    }
  });
}
