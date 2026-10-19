import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { assistantMessage, PiIntegrationTest, text } from "pi-coding-agent-test";
import { expect, test } from "vitest";

const clean = (lines: string[]): string => lines.map(stripTerminalSequences).join("\n");

for (const layout of ["columns", "rows"] as const) for (const probeFirst of [true, false]) {
  test(`keeps startup information in Conversation in ${layout}, notifier ${probeFirst ? "before" : "after"} stereo-view`, async () => {
    await mkdir(path.resolve("tmp"), { recursive: true });
    const cwd = await mkdtemp(path.resolve("tmp/startup-routing-"));
    const agent = await mkdtemp(path.resolve("tmp/startup-agent-"));
    try {
      await writeFile(path.join(agent, "settings.json"), JSON.stringify({ quietStartup: false }));
      await writeFile(path.join(agent, "transcript.json"), JSON.stringify({
        mode: "split", side: "left", chatWidth: 60, layout, chatHeight: 25, zoom: null,
      }));
      const stereo = path.resolve("src/index.ts");
      const probe = path.resolve("test/fixtures/startup-routing-probe.ts");
      const captureFile = path.resolve(`tmp/test-runs/startup-routing-${layout}-${probeFirst ? "before" : "after"}/startup-routing.json`);
      const result = await new PiIntegrationTest({
        testName: `startup-routing-${layout}-${probeFirst ? "before" : "after"}`,
        artifactsDir: path.resolve("tmp/test-runs"), cwd,
        piCommand: path.resolve("test/fixtures/pi-host.sh"), isolateUserResources: false,
        environment: { PI_CODING_AGENT_DIR: agent, STARTUP_ROUTING_FILE: captureFile }, rawMode: false,
        tuiSize: { cols: 140, rows: 65 }, extensions: probeFirst ? [probe, stereo] : [stereo, probe],
        tools: [], conversation: [assistantMessage([text("ANSWER MARKER")])],
      }).run("USER MARKER");
      expect(result.providerRequests).toHaveLength(1);
      const capture: { panes: Record<string, string[]>; screen: string[] } = JSON.parse(
        await readFile(captureFile, "utf8"));
      const chat = clean(capture.panes.chat);
      const activity = clean(capture.panes.activity);
      for (const marker of ["Pi can explain its own features", "[Extensions]", "EARLY STARTUP NOTICE", "DELAYED STARTUP NOTICE"]) {
        expect(chat, chat).toContain(marker);
        expect(activity, activity).not.toContain(marker);
      }
      expect(activity).toContain("OPERATIONAL NOTICE");
      expect(chat).not.toContain("OPERATIONAL NOTICE");
      expect(chat).toContain("USER MARKER");
      expect(chat).toContain("ANSWER MARKER");
      expect(clean(capture.screen)).toContain("Conversation");
      expect(clean(capture.screen)).toContain("Activity");
    } finally {
      await Promise.all([cwd, agent].map(directory => rm(directory, { recursive: true, force: true })));
    }
  }, 45_000);
}

test("reload keeps orientation in Conversation without adopting operational notifications", async () => {
  await mkdir(path.resolve("tmp"), { recursive: true });
  const cwd = await mkdtemp(path.resolve("tmp/startup-reload-"));
  const agent = await mkdtemp(path.resolve("tmp/startup-reload-agent-"));
  try {
    await writeFile(path.join(agent, "settings.json"), JSON.stringify({ quietStartup: false }));
    await writeFile(path.join(agent, "transcript.json"), JSON.stringify({
      mode: "split", side: "left", chatWidth: 60, layout: "columns", chatHeight: 25, zoom: null,
    }));
    const captureFile = path.resolve("tmp/test-runs/startup-routing-reload/startup-routing.json");
    const result = await new PiIntegrationTest({
      testName: "startup-routing-reload", artifactsDir: path.resolve("tmp/test-runs"), cwd,
      piCommand: path.resolve("test/fixtures/pi-host.sh"), isolateUserResources: false,
      environment: { PI_CODING_AGENT_DIR: agent, STARTUP_ROUTING_FILE: captureFile }, rawMode: false,
      tuiSize: { cols: 140, rows: 65 }, timeoutMs: 60_000,
      extensions: [path.resolve("src/index.ts"), path.resolve("test/fixtures/startup-routing-probe.ts"),
        path.resolve("test/fixtures/reload-controls.ts")],
      tools: [], conversation: [assistantMessage([text("ANSWER AFTER RELOAD")])],
    }).run("/transcript-reload-check");
    expect(result.providerRequests).toHaveLength(1);
    const capture: { panes: Record<string, string[]> } = JSON.parse(await readFile(captureFile, "utf8"));
    const state: { reloads: number } = JSON.parse(await readFile(path.join(cwd, "reload-frames.json"), "utf8"));
    expect(state.reloads).toBe(2);
    expect(clean(capture.panes.chat)).toContain("Pi can explain its own features");
    expect(clean(capture.panes.chat)).toContain("[Extensions]");
    expect(clean(capture.panes.chat)).not.toContain("OPERATIONAL NOTICE");
    expect(clean(capture.panes.activity)).toContain("OPERATIONAL NOTICE");
    expect(clean(capture.panes.activity)).not.toContain("Pi can explain its own features");
  } finally {
    await Promise.all([cwd, agent].map(directory => rm(directory, { recursive: true, force: true })));
  }
}, 90_000);
