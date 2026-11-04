import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { assistantMessage, PiIntegrationTest, text, toolCall } from "pi-coding-agent-test";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { expect, test } from "vitest";

test("keeps native extension widgets in Activity and restores them when split is disabled", async () => {
  const cwd = await mkdtemp(path.resolve("tmp/widgets-"));
  const agent = await mkdtemp(path.resolve("tmp/widgets-agent-"));
  try {
    await writeFile(path.join(agent, "settings.json"), JSON.stringify({ quietStartup: true }));
    await writeFile(path.join(agent, "transcript.json"), JSON.stringify({ mode: "split", side: "left", chatWidth: 36 }));
    await new PiIntegrationTest({
      testName: "widgets", artifactsDir: path.resolve("tmp/test-runs"), cwd,
      piCommand: path.resolve("test/fixtures/pi-host.sh"), isolateUserResources: false,
      environment: { PI_CODING_AGENT_DIR: agent }, rawMode: false,
      tuiSize: { cols: 120, rows: 35 },
      extensions: [path.resolve("src/index.ts"), path.resolve("test/fixtures/widgets-probe.ts")],
      tools: ["bash"], conversation: [
        assistantMessage([toolCall({ id: "history", name: "bash", arguments: { command: "for i in $(seq 1 60); do echo ACTIVITY-LINE-$i; done" } })], { stopReason: "toolUse" }),
        assistantMessage([text("ANSWER")]),
      ],
    }).run("HELLO");
    const frames: { [key: string]: string[] | number | Array<{ type: string; x: number; y: number; width: number }> } =
      JSON.parse(await readFile(path.join(cwd, "widget-frames.json"), "utf8"));
    const lines = (key: string): string[] => (frames[key] as string[]).map(stripTerminalSequences);
    const split = lines("split");
    for (const marker of ["WIDGET ALPHA", "WIDGET BETA"]) {
      const line = split.find(line => line.includes(marker));
      expect(line).toBeDefined();
      expect(line!.indexOf(marker)).toBeGreaterThan(36);
      expect(line).toContain("║");
    }
    const scrolled = lines("scrolled");
    const widgetRow = split.findIndex(line => line.includes("WIDGET ALPHA"));
    expect(widgetRow).toBe(scrolled.findIndex(line => line.includes("WIDGET ALPHA")));
    expect(split.slice(0, widgetRow).join("\n")).toContain("ACTIVITY-LINE-");
    expect(scrolled.slice(0, widgetRow).join("\n")).not.toEqual(split.slice(0, widgetRow).join("\n"));
    expect(frames.events).toEqual(expect.arrayContaining([expect.objectContaining({ type: "click", x: 0, y: 0 })]));
    expect(frames.events).toEqual(expect.arrayContaining([expect.objectContaining({ type: "wheel", x: 0, y: 0 })]));
    expect(frames.disposed).toBe(1);
    expect(lines("medium").find(line => line.includes("MEDIUM WIDGET 15"))).toContain("║");
    expect(lines("oversized").join("\n")).toContain("LONG WIDGET 12");
    expect(lines("oversized").find(line => line.includes("LONG WIDGET 1"))).not.toContain("║");
    expect(lines("afterOversized").find(line => line.includes("WIDGET RETURNED"))).toContain("║");
    for (const name of ["chatZoom", "activityZoom", "rows", "narrow", "restored"]) {
      expect(lines(name).join("\n"), name).toContain("WIDGET ALPHA");
      expect(lines(name).join("\n"), name).toContain("WIDGET BETA");
    }
    expect(lines("chatZoom").find(line => line.includes("WIDGET ALPHA"))).not.toContain("║");
    expect(lines("narrow").find(line => line.includes("WIDGET ALPHA"))).not.toContain("║");
    expect(lines("restored").find(line => line.includes("WIDGET ALPHA"))).toContain("║");
    const combined = lines("combined");
    expect(combined.join("\n")).toContain("WIDGET ALPHA");
    expect(combined.join("\n")).toContain("WIDGET BETA");
    expect(combined.find(line => line.includes("WIDGET ALPHA"))).not.toContain("║");
    const updated = lines("updated");
    expect(updated.join("\n")).toContain("WIDGET UPDATED");
    expect(updated.join("\n")).not.toContain("WIDGET ALPHA");
    expect(updated.join("\n")).not.toContain("WIDGET BETA");
    expect(updated.find(line => line.includes("WIDGET UPDATED"))).toContain("║");
  } finally {
    await Promise.all([cwd, agent].map(directory => rm(directory, { recursive: true, force: true })));
  }
});
