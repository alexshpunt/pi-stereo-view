import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { assistantMessage, PiIntegrationTest, text, toolCall } from "pi-coding-agent-test";
import { expect, test } from "vitest";

test.each([true, false])("streams and collapses tools with grouping set to %s", async groupTools => {
  await mkdir(path.resolve("tmp"), { recursive: true });
  const cwd = await mkdtemp(path.resolve("tmp/stream-tools-"));
  const agent = await mkdtemp(path.resolve("tmp/stream-tools-agent-"));
  try {
    await writeFile(path.join(agent, "settings.json"), JSON.stringify({ quietStartup: true, hideThinkingBlock: false }));
    await writeFile(path.join(agent, "transcript.json"), JSON.stringify({
      layout: "columns", side: "left", chatWidth: null, groupTools, compactTools: true, streamTools: true, streamDelay: 1,
    }));
    const result = await new PiIntegrationTest({
      testName: `stream-tools-${groupTools}`, artifactsDir: path.resolve("tmp/test-runs"), cwd,
      piCommand: path.resolve("test/fixtures/pi-host.sh"), isolateUserResources: false,
      environment: {
        PI_CODING_AGENT_DIR: agent, GROUP_TOOLS_TOGGLE: groupTools ? "" : "1", TZ: "UTC", DISPLAY: "", WAYLAND_DISPLAY: "", TERMUX_VERSION: "",
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
    expect(body("collapsed")).not.toContain("NATIVE-HEADER");
    if (groupTools) {
      expect(body("collapsed")).toMatch(/stream_probe ×2/);
    } else {
      for (const phase of ["collapsed", "compactAgain", "ungroupedAgain"]) {
        expect(body(phase)).not.toContain("NATIVE-HEADER");
        expect(body(phase)).not.toContain("×2");
        expect(frames[phase].filter(line => /●\s+▸\s+stream_probe/u.test(line))).toHaveLength(2);
      }
      expect(body("toolbar")).toContain("NATIVE-HEADER-A");
      expect(body("toolbar")).toContain("NATIVE-HEADER-B");
      expect(body("toolbar")).not.toContain("×2");
      expect(body("grouped")).toContain("stream_probe ×2");
      const saved = JSON.parse(await readFile(path.join(agent, "transcript.json"), "utf8"));
      expect(saved).toMatchObject({ groupTools: false, compactTools: true, streamTools: true, streamDelay: 1 });
    }
    expect(body("settings")).toMatch(new RegExp("Group Activity tools\\s+" + (groupTools ? "on" : "off")));
    expect(body("settings")).toContain("Stream latest tools");
    expect(body("settings")).toContain("Collapse delay");
    expect(body("settings")).toMatch(/Collapse delay\s+1s/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
    await rm(agent, { recursive: true, force: true });
  }
});
