import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { assistantMessage, getToolExecution, getToolResultText, PiIntegrationTest, text, toolCall } from "pi-coding-agent-test";
import { expect, test } from "vitest";

test("compacts live tools without losing calls, full search, copy or normal history", async () => {
  await mkdir(path.resolve("tmp"), { recursive: true });
  const cwd = await mkdtemp(path.resolve("tmp/compact-tools-"));
  const agent = await mkdtemp(path.resolve("tmp/compact-tools-agent-"));
  try {
    await writeFile(path.join(agent, "settings.json"), JSON.stringify({ quietStartup: true, hideThinkingBlock: false }));
    await writeFile(path.join(agent, "transcript.json"), JSON.stringify({ layout: "rows", side: "left", chatWidth: null, chatHeight: 14 }));
    const result = await new PiIntegrationTest({
      testName: "compact-tools", artifactsDir: path.resolve("tmp/test-runs"), cwd,
      piCommand: path.resolve("test/fixtures/pi-host.sh"), isolateUserResources: false,
      environment: {
        PI_CODING_AGENT_DIR: agent, TZ: "UTC", DISPLAY: "", WAYLAND_DISPLAY: "", TERMUX_VERSION: "",
        WSL_DISTRO_NAME: "", WSL_INTEROP: "", WT_SESSION: "compact-tools-test", SSH_CONNECTION: "compact-tools-test",
      },
      rawMode: false, tuiSize: { cols: 120, rows: 52 }, timeoutMs: 60_000,
      extensions: [path.resolve("src/index.ts"), path.resolve("test/fixtures/compact-tools-probe.ts")],
      tools: ["compact_probe"], conversation: [
        assistantMessage([
          toolCall({ id: "compact-first", name: "compact_probe", arguments: { tag: "FIRST-FIXTURE" } }),
          toolCall({ id: "compact-second", name: "compact_probe", arguments: { tag: "SECOND-FIXTURE" } }),
        ], { stopReason: "toolUse" }),
        assistantMessage([
          toolCall({ id: "compact-third", name: "compact_probe", arguments: { tag: "THIRD-FIXTURE" } }),
        ], { stopReason: "toolUse" }),
        assistantMessage([text("ANSWER-FIXTURE")]),
      ],
    }).run("USER-FIXTURE");
    expect(result.exitCode).toBe(0);
    const observation = JSON.parse(await readFile(path.join(cwd, "compact-observation.json"), "utf8")) as {
      frames: Record<string, string[]>; copied: string; error?: string;
    };
    await writeFile(path.join(result.artifacts.directory, "compact-observation.json"), JSON.stringify(observation, null, 2));
    expect(observation.error, observation.frames.failure?.map(stripTerminalSequences).join("\n")).toBeUndefined();
    const frame = (name: string): string[] => observation.frames[name].map(stripTerminalSequences);
    const body = (name: string): string => frame(name).join("\n");
    const call = (name: string, tag: string): string | undefined => observation.frames[name].find(line => stripTerminalSequences(line).includes("compact_probe") && line.includes(tag));
    expect(getToolExecution(result, "compact-first").isError).toBe(false);
    expect(getToolExecution(result, "compact-second").isError).toBe(true);
    expect(getToolExecution(result, "compact-third").isError).toBe(false);
    expect(call("started", "FIRST-FIXTURE")).toBeDefined();
    expect(call("partial", "FIRST-FIXTURE")).toBe(call("started", "FIRST-FIXTURE"));
    expect(call("firstFinished", "FIRST-FIXTURE")).not.toBe(call("started", "FIRST-FIXTURE"));
    expect(call("rows", "SECOND-FIXTURE")).not.toBe(call("firstFinished", "SECOND-FIXTURE"));
    for (const name of ["started", "partial", "firstFinished", "rows", "zoom", "columns", "narrow", "again"]) {
      const toolRows = frame(name).filter(line => ["FIRST-FIXTURE", "SECOND-FIXTURE", "THIRD-FIXTURE"].some(tag => line.includes(tag)));
      expect(toolRows.length, name).toBeGreaterThan(0);
      for (const line of toolRows) {
        // This scenario keeps Activity on the right in Columns and full-width in Rows or zoom.
        const columns = ["columns", "narrow", "again"].includes(name);
        const divider = columns ? line.indexOf("║") : -1;
        if (columns) expect(divider, name).toBeGreaterThanOrEqual(0);
        const inset = line.slice(divider + 1).match(/^\s*/u)?.[0] ?? "";
        expect(visibleWidth(inset), name).toBe(1);
      }
    }
    for (const name of ["rows", "zoom", "columns", "narrow", "again"]) {
      const rows = frame(name);
      const indices = ["FIRST-FIXTURE", "SECOND-FIXTURE", "THIRD-FIXTURE"].map(tag => rows.findIndex(line => line.includes("compact_probe") && line.includes(tag)));
      expect(indices.every(index => index >= 0), name + "\n" + rows.join("\n")).toBe(true);
      expect(indices[1], name).toBe(indices[0] + 1);
      expect(indices[2], name).toBeGreaterThan(indices[1] + 1);
      expect(body(name)).not.toContain("RESULT-FIRST-FIXTURE");
      expect(body(name)).not.toContain("LATE-RESULT-FIXTURE");
      for (const line of observation.frames[name]) expect(visibleWidth(line), name).toBeLessThanOrEqual(name === "narrow" ? 65 : 120);
    }
    expect(body("rows")).toContain("USER-FIXTURE");
    expect(body("rows")).toContain("ANSWER-FIXTURE");
    expect(body("zoom")).not.toContain("USER-FIXTURE");
    expect(body("search")).toContain("LATE-RESULT-FIXTURE");
    expect(body("searchClosed")).not.toContain("LATE-RESULT-FIXTURE");
    expect(observation.copied).toContain(JSON.stringify({ tag: "FIRST-FIXTURE" }, null, 2));
    expect(observation.copied).toContain(getToolResultText(result, "compact-first"));
    expect(observation.copied).toContain("LATE-RESULT-FIXTURE");
    for (const name of ["restored", "combined", "fallback"]) {
      expect(body(name)).toContain("NATIVE-HEADER-FIRST-FIXTURE");
      expect(body(name)).toContain("RESULT-FIRST-FIXTURE");
      expect(body(name)).toContain("LATE-RESULT-FIXTURE");
    }
    const saved = JSON.parse(await readFile(path.join(agent, "transcript.json"), "utf8"));
    expect(saved.compactTools).toBe(true);
  } finally {
    await Promise.all([cwd, agent].map(directory => rm(directory, { recursive: true, force: true })));
  }
}, 75_000);
