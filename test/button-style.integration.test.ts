import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { assistantMessage, PiIntegrationTest, text } from "pi-coding-agent-test";
import { expect, test } from "vitest";

test("switches button presentation in settings, copies, fits narrow rows and survives restart", async () => {
  await mkdir(path.resolve("tmp"), { recursive: true });
  const cwd = await mkdtemp(path.resolve("tmp/style-"));
  const agent = await mkdtemp(path.resolve("tmp/style-agent-"));
  try {
    await writeFile(path.join(agent, "settings.json"), JSON.stringify({ quietStartup: true }));
    const run = (name: string, controls: number) => new PiIntegrationTest({
      testName: name, artifactsDir: path.resolve("tmp/test-runs"), cwd,
      piCommand: path.resolve("test/fixtures/pi-host.sh"), isolateUserResources: false,
      environment: { PI_CODING_AGENT_DIR: agent, STYLE_CONTROLS: String(controls),
        DISPLAY: "", WAYLAND_DISPLAY: "", TERMUX_VERSION: "", WSL_DISTRO_NAME: "", WSL_INTEROP: "",
        WT_SESSION: "style-test", SSH_CONNECTION: "style-test" },
      rawMode: false, tuiSize: { cols: 120, rows: 40 },
      extensions: [path.resolve("src/index.ts"), path.resolve("test/fixtures/button-style-probe.ts")],
      tools: [], conversation: [assistantMessage([text("STYLE ANSWER")])],
    }).run("STYLE USER");
    expect((await run("button-style", 1)).exitCode).toBe(0);
    const { frames, copies }: { frames: Record<string, string[]>; copies: string[] } = JSON.parse(await readFile(path.join(cwd, "style.json"), "utf8"));
    expect(frames.initial[0]).toContain("[≡]");
    expect(frames.menu.join("\n")).toContain("Button style");
    expect(frames.text[0]).toMatch(/^\[[A-Za-z]+\] \[[A-Za-z]+\] \[[A-Za-z]+\] \[[A-Za-z]+\]/);
    expect(frames.text.join("\n")).toContain("[Copy]");
    expect(frames.text.some(line => line.includes("Activity") && /\[[A-Za-z]+\] \[[A-Za-z]+\] \[[A-Za-z]+\]/.test(line))).toBe(true);
    expect(copies).toHaveLength(1);
    expect(["STYLE USER", "STYLE ANSWER"]).toContain(copies[0]);
    expect(frames.narrow[0].match(/\[[A-Za-z]+\]/g)).toHaveLength(4);
    expect(frames.narrow.some(line => line.includes("Activity") && (line.match(/\[[A-Za-z]+\]/g) ?? []).length === 3)).toBe(true);
    expect(frames.narrow.some(line => line.includes("Conversation"))).toBe(true);
    expect(frames.narrowZoom.some(line => line.includes("Conversation"))).toBe(false);
    expect(frames.narrowRestored.some(line => line.includes("Conversation"))).toBe(true);
    expect(JSON.parse(await readFile(path.join(agent, "transcript.json"), "utf8")).buttonStyle).toBe("text");
    expect((await run("button-style-restart", 2)).exitCode).toBe(0);
    const restarted = JSON.parse(await readFile(path.join(cwd, "style-restart.json"), "utf8"));
    expect(restarted.frames.initial[0]).toMatch(/^\[[A-Za-z]+\] \[/);
    expect(restarted.frames.iconsRestored[0]).toContain("[≡]");
    expect(restarted.frames.iconsRestored.join("\n")).toContain("⧉");
    expect(JSON.parse(await readFile(path.join(agent, "transcript.json"), "utf8")).buttonStyle).toBe("icons");
  } finally { await Promise.all([cwd, agent].map(directory => rm(directory, { recursive: true, force: true }))); }
});
