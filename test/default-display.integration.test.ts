import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { assistantMessage, PiIntegrationTest, text, toolCall } from "pi-coding-agent-test";
import { expect, test } from "vitest";

test("a fresh install starts side by side with compact, streaming tools and text buttons", async () => {
  await mkdir(path.resolve("tmp"), { recursive: true });
  const cwd = await mkdtemp(path.resolve("tmp/default-display-"));
  const agent = await mkdtemp(path.resolve("tmp/default-display-agent-"));
  try {
    await writeFile(path.join(agent, "settings.json"), JSON.stringify({ quietStartup: true, hideThinkingBlock: false }));
    const result = await new PiIntegrationTest({
      testName: "default-display", artifactsDir: path.resolve("tmp/test-runs"), cwd,
      piCommand: path.resolve("test/fixtures/pi-host.sh"), isolateUserResources: false,
      environment: {
        PI_CODING_AGENT_DIR: agent, PI_TRANSCRIPT_TEST_DEFAULTS: "1", STREAM_WAIT_MS: "5600", TZ: "UTC", DISPLAY: "",
        WAYLAND_DISPLAY: "", TERMUX_VERSION: "", WSL_DISTRO_NAME: "", WSL_INTEROP: "", WT_SESSION: "default-display-test", SSH_CONNECTION: "default-display-test",
      },
      rawMode: false, tuiSize: { cols: 120, rows: 40 }, timeoutMs: 60_000,
      extensions: [path.resolve("src/index.ts"), path.resolve("test/fixtures/stream-tools-probe.ts")],
      tools: ["stream_probe"], conversation: [
        assistantMessage([
          toolCall({ id: "default-a", name: "stream_probe", arguments: { tag: "A" } }),
          toolCall({ id: "default-b", name: "stream_probe", arguments: { tag: "B" } }),
        ], { stopReason: "toolUse" }),
        assistantMessage([text("ANSWER-FIXTURE")]),
      ],
    }).run("USER-FIXTURE");
    expect(result.exitCode).toBe(0);
    const frames = JSON.parse(await readFile(path.join(cwd, "stream-observation.json"), "utf8")) as Record<string, string[]>;
    const rows = (name: string): string[] => frames[name];
    const body = (name: string): string => rows(name).join("\n");
    // Conversation on the left, Activity on the right, text buttons, streamed full cards.
    const header = rows("running").find(line => line.includes("Conversation") && line.includes("Activity"))!;
    expect(header.indexOf("Conversation")).toBeLessThan(header.indexOf("Activity"));
    expect(body("running")).toContain("[Settings]");
    expect(body("running")).toContain("[Full tools]");
    expect(body("running")).toContain("NATIVE-HEADER-A");
    expect(body("justFinished")).toContain("NATIVE-HEADER-B");
    expect(body("collapsed")).not.toContain("NATIVE-HEADER");
    expect(body("collapsed")).toMatch(/stream_probe ×2/);
    expect(body("settings")).toMatch(/Stream latest tools\s+on/);
    expect(body("settings")).toMatch(/Compact Activity tools\s+on/);
    expect(body("settings")).toMatch(/Collapse delay\s+5s/);
    expect(body("settings")).toMatch(/Conversation height\s+auto/);
    // The last header label keeps one cell clear of the panel's right edge.
    const maximize = rows("running").find(line => line.includes("[Maximize]"))!;
    expect(maximize.slice(maximize.indexOf("[Maximize]") + "[Maximize]".length)).toMatch(/^\s/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
    await rm(agent, { recursive: true, force: true });
  }
});
