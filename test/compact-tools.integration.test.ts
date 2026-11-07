import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { assistantMessage, getToolCallNames, getToolExecution, getToolResultText, PiIntegrationTest, text, toolCall } from "pi-coding-agent-test";
import { expect, test } from "vitest";

test("compacts live tools without losing calls, full search, copy or normal history", async () => {
  await mkdir(path.resolve("tmp"), { recursive: true });
  const cwd = await mkdtemp(path.resolve("tmp/compact-tools-"));
  const agent = await mkdtemp(path.resolve("tmp/compact-tools-agent-"));
  try {
    await writeFile(path.join(agent, "settings.json"), JSON.stringify({ quietStartup: true, hideThinkingBlock: false }));
    await writeFile(path.join(agent, "transcript.json"), JSON.stringify({ layout: "rows", side: "left", chatWidth: null, chatHeight: 14 }));
    // Short unique arguments leave room for original clocks at the minimum Activity width.
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
          toolCall({ id: "compact-first", name: "compact_probe", arguments: { tag: "A938" } }),
          toolCall({ id: "compact-peer", name: "compact_probe", arguments: { tag: "D938" } }),
          toolCall({ id: "compact-second", name: "compact_probe", arguments: { tag: "B938" } }),
          toolCall({ id: "compact-failure", name: "compact_probe", arguments: { tag: "E938" } }),
        ], { stopReason: "toolUse" }),
        assistantMessage([
          toolCall({ id: "compact-third", name: "compact_probe", arguments: { tag: "C938" } }),
        ], { stopReason: "toolUse" }),
        assistantMessage([text("ANSWER-FIXTURE")]),
      ],
    }).run("USER-FIXTURE");
    expect(result.exitCode).toBe(0);
    const observation = JSON.parse(await readFile(path.join(cwd, "compact-observation.json"), "utf8")) as {
      frames: Record<string, string[]>; copied: string; error?: string;
      starts: { toolCallId: string; time: number }[]; executions: string[]; actions: string[];
      widths: Record<string, Record<string, number>>;
      actionPoints: { tag: string; x: number; width: number }[];
    };
    await writeFile(path.join(result.artifacts.directory, "compact-observation.json"), JSON.stringify(observation, null, 2));
    expect(observation.error, observation.frames.failure?.map(stripTerminalSequences).join("\n")).toBeUndefined();
    const frame = (name: string): string[] => observation.frames[name].map(stripTerminalSequences);
    const body = (name: string): string => frame(name).join("\n");
    const call = (name: string, tag: string): string | undefined => observation.frames[name].find(line => stripTerminalSequences(line).includes("compact_probe") && line.includes(tag));
    expect(getToolExecution(result, "compact-first").isError).toBe(false);
    expect(getToolExecution(result, "compact-peer").isError).toBe(false);
    expect(getToolExecution(result, "compact-second").isError).toBe(true);
    expect(getToolExecution(result, "compact-failure").isError).toBe(true);
    expect(getToolExecution(result, "compact-third").isError).toBe(false);
    expect(getToolCallNames(result)).toEqual(Array(5).fill("compact_probe"));
    expect(observation.executions).toEqual(["A938", "D938", "B938", "E938", "C938"]);
    expect(observation.actions).toEqual(["A938"]);
    // Both captures use full-width Activity; only compact hierarchy narrows its native child.
    const normalWidth = observation.widths.normal.A938;
    const memberWidth = observation.widths.memberOpen.A938;
    const failureWidth = observation.widths.failureOpen.B938;
    expect(normalWidth).toBeGreaterThan(0);
    expect(memberWidth).toBeGreaterThan(0);
    expect(memberWidth).toBeLessThan(normalWidth);
    expect(failureWidth).toBeGreaterThan(memberWidth);
    expect(failureWidth).toBeLessThan(observation.widths.normal.B938);
    // The helper clicks two cells into ACTION-A938, not into a presentation guide.
    expect(observation.actionPoints).toEqual([{ tag: "A938", x: 2, width: memberWidth }]);
    const start = (id: string): string => {
      const data = observation.starts.find(entry => entry.toolCallId === id);
      expect(data).toBeDefined();
      return new Date(data!.time).toISOString().slice(11, 19);
    };
    for (const name of ["initialGroup", "groupClosed", "memberHidden"]) {
      const groups = frame(name).filter(line => line.includes("compact_probe"));
      expect(groups).toHaveLength(name === "initialGroup" ? 1 : 4);
      expect(groups[0].replace(/\d{2}:\d{2}:\d{2}/g, "")).toContain(String(name === "initialGroup" ? 4 : 2));
      expect(groups[0]).toContain(start("compact-first"));
      expect(body(name)).not.toContain("A938");
      expect(body(name)).not.toContain("D938");
      if (name === "initialGroup") {
        expect(body(name)).not.toContain("B938");
        expect(body(name)).not.toContain("E938");
      } else {
        expect(call(name, "B938")).toContain(start("compact-second"));
        expect(call(name, "E938")).toContain(start("compact-failure"));
      }
      expect(body(name)).not.toContain("LATE-RESULT-FIXTURE");
    }
    for (const name of ["started", "partial", "pendingLater", "firstFinished", "groupOpen", "clocksOn"]) {
      expect(call(name, "A938"), name + "\n" + body(name)).toContain(start("compact-first"));
    }
    expect(call("groupOpen", "D938")).toContain(start("compact-peer"));
    expect(call("groupOpen", "B938")).toContain(start("compact-second"));
    expect(call("groupOpen", "E938")).toContain(start("compact-failure"));
    // A completed call is separate from the still-running suffix, whose open members survive its new head.
    expect(call("firstFinished", "D938")).toBeDefined();
    expect(call("firstFinished", "B938")).toBeDefined();
    expect(call("firstFinished", "E938")).toBeDefined();
    expect(body("suffixCardOpen")).toContain("NATIVE-HEADER-D938");
    for (const tag of ["D938", "B938", "E938"]) expect(body("suffixHidden")).not.toContain(tag);
    for (const tag of ["A938", "D938", "B938", "E938"]) expect(body("mergedCollapsed")).not.toContain(tag);
    expect(frame("mergedCollapsed").filter(line => line.includes("compact_probe"))).toHaveLength(2);
    expect(body("mergedCollapsed")).not.toContain("NATIVE-HEADER-D938");
    expect(body("mergedRestored")).toContain("NATIVE-HEADER-D938");
    expect(body("mergedRestored")).toContain(getToolResultText(result, "compact-peer"));
    expect(call("firstFailure", "B938")).toBeDefined();
    expect(call("firstFailure", "E938")).toBeDefined();
    expect(call("groupOpen", "C938")).toContain(start("compact-third"));
    for (const name of ["groupOpen", "memberClosed", "clocksOff"]) {
      expect(body(name)).toContain("A938");
      expect(body(name)).toContain("D938");
      expect(body(name)).toContain("B938");
      expect(body(name)).toContain("E938");
      expect(body(name)).not.toContain("NATIVE-HEADER-A938");
      expect(body(name)).not.toContain("RESULT-A938");
      expect(body(name)).not.toContain("LATE-RESULT-FIXTURE");
    }
    for (const name of ["memberOpen", "nativeAction", "memberRows", "memberColumns", "memberNarrow", "memberZoom", "memberReopened"]) {
      expect(body(name)).toContain("NATIVE-HEADER-A938");
      expect(body(name)).toContain("RESULT-A938");
      expect(body(name)).toContain("LATE-RESULT-FIXTURE");
      expect(body(name)).not.toContain("NATIVE-HEADER-D938");
      expect(body(name)).not.toContain("NATIVE-HEADER-B938");
      expect(body(name)).not.toContain("NATIVE-HEADER-E938");
      expect(body(name)).not.toContain("NATIVE-HEADER-C938");
      expect(call(name, "B938"), name + "\n" + body(name)).toBeDefined();
    }
    expect(body("failureOpen")).toContain("NATIVE-HEADER-B938");
    expect(body("failureOpen")).toContain("ERROR-RESULT-FIXTURE");
    expect(call("failureOpen", "E938")).toBeDefined();
    expect(body("failureOpen")).not.toContain("NATIVE-HEADER-E938");
    expect(body("failureClosed")).not.toContain("NATIVE-HEADER-B938");
    expect(call("failureClosed", "B938")).toBeDefined();
    expect(call("failureClosed", "E938")).toBeDefined();
    expect(call("clocksOff", "A938")).not.toContain(start("compact-first"));
    expect(call("clocksOff", "B938")).not.toContain(start("compact-second"));
    expect(call("started", "A938")).toBeDefined();
    expect(call("partial", "A938")).toBe(call("started", "A938"));
    expect(call("firstFinished", "A938")).not.toBe(call("started", "A938"));
    expect(call("rows", "B938")).not.toBe(call("firstFinished", "B938"));
    for (const name of ["started", "partial", "firstFinished", "rows", "zoom", "columns", "narrow", "again"]) {
      const toolRows = frame(name).filter(line => ["A938", "D938", "B938", "E938", "C938"].some(tag => line.includes(tag)));
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
      const indices = ["A938", "D938", "B938", "E938", "C938"].map(tag => rows.findIndex(line => line.includes("compact_probe") && line.includes(tag)));
      expect(indices.every(index => index >= 0), name + "\n" + rows.join("\n")).toBe(true);
      expect(indices[1], name).toBe(indices[0] + 1);
      expect(indices[2], name).toBe(indices[1] + 1);
      expect(indices[3], name).toBe(indices[2] + 1);
      expect(indices[4], name).toBeGreaterThan(indices[3] + 1);
      expect(body(name)).not.toContain("RESULT-A938");
      expect(body(name)).not.toContain("LATE-RESULT-FIXTURE");
      for (const line of observation.frames[name]) expect(visibleWidth(line), name).toBeLessThanOrEqual(name === "narrow" ? 65 : 120);
    }
    expect(body("rows")).toContain("USER-FIXTURE");
    expect(body("rows")).toContain("ANSWER-FIXTURE");
    expect(body("zoom")).not.toContain("USER-FIXTURE");
    expect(body("search")).toContain("LATE-RESULT-FIXTURE");
    expect(body("searchClosed")).not.toContain("LATE-RESULT-FIXTURE");
    expect(observation.copied).toContain(JSON.stringify({ tag: "A938" }, null, 2));
    expect(observation.copied).toContain(getToolResultText(result, "compact-first"));
    expect(observation.copied).toContain("LATE-RESULT-FIXTURE");
    for (const name of ["restored", "combined", "fallback"]) {
      expect(body(name)).toContain("NATIVE-HEADER-A938");
      expect(body(name)).toContain("RESULT-A938");
      expect(body(name)).toContain("LATE-RESULT-FIXTURE");
    }
    const saved = JSON.parse(await readFile(path.join(agent, "transcript.json"), "utf8"));
    expect(saved.compactTools).toBe(true);
  } finally {
    await Promise.all([cwd, agent].map(directory => rm(directory, { recursive: true, force: true })));
  }
}, 75_000);
