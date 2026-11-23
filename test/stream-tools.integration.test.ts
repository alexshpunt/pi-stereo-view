import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { assistantMessage, PiIntegrationTest, text, toolCall } from "pi-coding-agent-test";
import { expect, test } from "vitest";

test.each([[true, true], [true, false], [false, true]])("streams the latest tools in full, then hides them after the delay (compact: %s, group: %s)", async (compactTools, groupTools) => {
  await mkdir(path.resolve("tmp"), { recursive: true });
  const cwd = await mkdtemp(path.resolve("tmp/stream-tools-"));
  const agent = await mkdtemp(path.resolve("tmp/stream-tools-agent-"));
  try {
    await writeFile(path.join(agent, "settings.json"), JSON.stringify({ quietStartup: true, hideThinkingBlock: false }));
    await writeFile(path.join(agent, "transcript.json"), JSON.stringify({
      layout: "columns", side: "left", chatWidth: null, compactTools, groupTools, streamTools: true, streamDelay: 1,
    }));
    const result = await new PiIntegrationTest({
      testName: `stream-tools-${compactTools}-${groupTools}`, artifactsDir: path.resolve("tmp/test-runs"), cwd,
      piCommand: path.resolve("test/fixtures/pi-host.sh"), isolateUserResources: false,
      environment: {
        PI_CODING_AGENT_DIR: agent, TZ: "UTC", DISPLAY: "", WAYLAND_DISPLAY: "", TERMUX_VERSION: "",
        WSL_DISTRO_NAME: "", WSL_INTEROP: "", WT_SESSION: "stream-tools-test", SSH_CONNECTION: "stream-tools-test",
      },
      rawMode: false, tuiSize: { cols: 120, rows: 40 }, timeoutMs: 60_000,
      extensions: [path.resolve("src/index.ts"), path.resolve("test/fixtures/stream-tools-probe.ts")],
      tools: ["stream_probe"], conversation: [
        assistantMessage([
          toolCall({ id: "stream-a", name: "stream_probe", arguments: { tag: "A" } }),
          toolCall({ id: "stream-b", name: "stream_probe", arguments: { tag: "B" } }),
        ], { stopReason: "toolUse" }),
        assistantMessage([text("ANSWER-FIXTURE")]),
      ],
    }).run("USER-FIXTURE");
    expect(result.exitCode).toBe(0);
    const frames = JSON.parse(await readFile(path.join(cwd, "stream-observation.json"), "utf8")) as Record<string, string[]>;
    await writeFile(path.join(result.artifacts.directory, "stream-observation.json"), JSON.stringify(frames, null, 2));
    const body = (name: string): string => frames[name].join("\n");
    // A running call is drawn as its native card, not as a compact row.
    expect(body("running")).toContain("NATIVE-HEADER-A");
    // A finished call stays in full during the delay, beside the next call; neither is merged.
    expect(body("secondRunning")).toContain("NATIVE-HEADER-A");
    expect(body("secondRunning")).toContain("NATIVE-HEADER-B");
    expect(body("justFinished")).toContain("RESULT-B");
    expect(body("justFinished")).not.toContain("×2");
    // After the delay both hide in place: merged into one counted header, or each as its own row.
    expect(body("collapsed")).not.toContain("NATIVE-HEADER");
    if (groupTools) expect(body("collapsed")).toMatch(/stream_probe ×2/);
    else {
      expect(body("collapsed")).not.toContain("×2");
      expect(frames.collapsed.filter(line => /●\s+▸\s+stream_probe/u.test(line))).toHaveLength(2);
    }
    expect(body("settings")).toMatch(new RegExp("Finished tool calls\\s+" + (compactTools ? "one line" : "full")));
    expect(body("settings")).toMatch(new RegExp("Repeated tool calls\\s+" + (groupTools ? "merge" : "separate")));
    expect(body("settings")).toMatch(/Codemode calls\s+tree/);
    expect(body("settings")).toContain("Running tool calls");
    expect(body("settings")).toMatch(/Fold finished calls after\s+1s/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
    await rm(agent, { recursive: true, force: true });
  }
});
