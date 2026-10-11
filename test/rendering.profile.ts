import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { assistantMessage, PiIntegrationTest, text } from "pi-coding-agent-test";
import { expect, test } from "vitest";

const modes = (process.env.PROFILE_MODES ?? "stock,combined,columns,rows").split(",");
const size = Number(process.env.PROFILE_HISTORY ?? 100);
const toolLines = Number(process.env.PROFILE_TOOL_LINES ?? 80);
const width = Number(process.env.PROFILE_WIDTH ?? 120);
const height = Number(process.env.PROFILE_HEIGHT ?? 35);
const scrollbar = process.env.PROFILE_SCROLLBAR ?? "always";
if (!["always", "auto", "hidden"].includes(scrollbar)) throw new Error("Unknown profile scrollbar: " + scrollbar);
const output = path.resolve(process.env.PROFILE_OUTPUT ?? "tmp/profiling/baseline");
const transcript = path.resolve(process.env.PROFILE_TRANSCRIPT_PATH ?? ".");
const profileSearch = process.env.PROFILE_SEARCH === "1";
const searchPane = process.env.PROFILE_SEARCH_PANE ?? "chat";
if (!["chat", "activity"].includes(searchPane)) throw new Error("Unknown search pane: " + searchPane);

const savedAssistant = (content: AssistantMessage["content"]): AssistantMessage => ({
  role: "assistant", content, timestamp: Date.parse("2026-01-01T10:00:00Z"), api: "openai-responses", provider: "openai", model: "synthetic-profile",
  stopReason: content.some(block => block.type === "toolCall") ? "toolUse" : "stop",
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
});

/** Matched real-Pi workload; timings are evidence, not brittle wall-clock assertions. */
test.each(modes)("profiles native rendering in %s", async mode => {
  if (!["stock", "combined", "columns", "rows"].includes(mode)) throw new Error("Unknown profile mode: " + mode);
  const extensions = [...(mode === "stock" ? [] : [path.join(transcript, "src/index.ts")]), path.resolve("test/fixtures/rendering-profile.ts")];
  const transcriptGit = (...args: string[]): string => execFileSync("git", ["-C", transcript, ...args], { encoding: "utf8" }).trim();
  const transcriptCommit = transcriptGit("rev-parse", "HEAD");
  const transcriptDiff = transcriptGit("diff", "HEAD");
  await mkdir(output, { recursive: true });
  await mkdir(path.resolve("tmp"), { recursive: true });
  const cwd = await mkdtemp(path.resolve("tmp/render-profile-"));
  const agent = await mkdtemp(path.resolve("tmp/render-profile-agent-"));
  const artifact = path.join(output, mode);
  try {
    await writeFile(path.join(agent, "settings.json"), JSON.stringify({ quietStartup: true, hideThinkingBlock: false, fullscreenScrollbar: scrollbar, compaction: { enabled: false } }));
    await writeFile(path.join(agent, "transcript.json"), JSON.stringify({
      mode: mode === "combined" ? "combined" : "split", side: "left", chatWidth: Math.floor((width - 1) * 0.35),
      layout: mode === "rows" ? "rows" : "columns", chatHeight: null, zoom: null, showTimestamps: true,
    }));
    const manager = SessionManager.create(cwd, cwd);
    const at = Date.parse("2026-01-01T10:00:00Z");
    for (let index = 0; index < size; index++) {
      manager.appendMessage({ role: "user", content: "SYNTHETIC USER " + index + "\nExplain the recorded operation and preserve the next paragraph.\n\nAnother paragraph.", timestamp: at + index });
      manager.appendMessage(savedAssistant([
        { type: "thinking", thinking: "SYNTHETIC THINKING " + index + "\nCheck the output before answering." },
        { type: "text", text: "SYNTHETIC ASSISTANT " + index + "\n\nA paragraph with `inline code`, **bold text** and a [local label](https://example.invalid/).\n\n- First item\n- Second item" },
        { type: "toolCall", id: "synthetic-read-" + index, name: "read", arguments: { path: "synthetic-data.txt" } },
      ]));
      manager.appendMessage({ role: "toolResult", toolName: "read", toolCallId: "synthetic-read-" + index, isError: false,
        content: [{ type: "text", text: Array.from({ length: toolLines }, (_, row) => "SYNTHETIC TOOL " + index + " line " + row + " predictable result data").join("\n") }], timestamp: at + index });
    }
    const runtime = { extensions, transcriptCommit, pi: execFileSync(process.env.PI_COMMAND ?? "pi", ["--version"], { encoding: "utf8" }).trim(),
      transcript: { path: transcript, sourceCommit: transcriptCommit, workingTree: transcriptGit("status", "--porcelain") },
      profileStartup: process.env.PROFILE_STARTUP === "1", profileSearch, searchPane,
      workload: { exchanges: size, toolLines, width, height, scrollbar, syntheticOnly: true },
      provider: "One local scripted setup turn, outside the measured actions. No paid model call or tool execution.", mode };
    await mkdir(artifact, { recursive: true });
    await writeFile(path.join(output, "runtime-" + mode + ".json"), JSON.stringify(runtime, null, 2));
    const result = await new PiIntegrationTest({
      testName: mode, artifactsDir: output, cwd,
      piCommand: path.resolve("test/fixtures/pi-host.sh"), isolateUserResources: false,
      environment: { PI_CODING_AGENT_DIR: agent, PI_TRANSCRIPT_IDE_PATH: "", PI_TRANSCRIPT_TEST_SESSION: manager.getSessionFile()!,
        PROFILE_MODE: mode, PROFILE_HISTORY: String(size), PROFILE_SAMPLES: process.env.PROFILE_SAMPLES ?? "12", PROFILE_TOOL_LINES: String(toolLines),
        PROFILE_STARTUP: process.env.PROFILE_STARTUP ?? "0", PROFILE_SEARCH: profileSearch ? "1" : "0", PROFILE_SEARCH_PANE: searchPane },
      rawMode: false, tuiSize: { cols: width, rows: height }, timeoutMs: 180_000,
      extensions,
      tools: [], conversation: [assistantMessage([text("SYNTHETIC PROFILE READY", { chunks: { kind: "fixed", size: 100 } })])],
    }).run("SYNTHETIC PROFILE SETUP");
    expect(result.providerRequests).toHaveLength(1);
    // The harness recreates its artifact folder, so save provenance again after the run.
    await writeFile(path.join(artifact, "runtime.json"), JSON.stringify(runtime, null, 2));
    const measurements = JSON.parse(await readFile(path.join(cwd, "rendering-measurements.json"), "utf8"));
    await writeFile(path.join(artifact, "measurements.json"), JSON.stringify(measurements, null, 2));
    await writeFile(path.join(artifact, "rendering.cpuprofile"), await readFile(path.join(cwd, "rendering.cpuprofile")));
    if (process.env.PROFILE_STARTUP === "1") {
      for (const phase of ["initial", "cold"]) {
        await writeFile(path.join(artifact, phase + ".cpuprofile"), await readFile(path.join(cwd, phase + ".cpuprofile")));
      }
    }
    expect(measurements.runtime.autoExtensionsDisabled, "Personal and project extensions must not enter the comparison").toBe(true);
    const launchedExtensions: string[] = measurements.runtime.extensions;
    expect(launchedExtensions).toHaveLength(extensions.length + 1);
    expect(measurements.frames.initial.join("\n").includes("[ ≡ ]"),
      "Only Transcript modes must paint the extension toolbar").toBe(mode !== "stock");
    expect(launchedExtensions.filter(extension => !extensions.includes(extension)),
      "Only the scripted test harness may accompany the requested profile extensions").toHaveLength(1);
    expect(launchedExtensions).toEqual(expect.arrayContaining(extensions));
    expect(launchedExtensions.find(extension => !extensions.includes(extension))).toMatch(/[/\\]pi-coding-agent-test[/\\]dist[/\\]harness[/\\]extension\.js$/);
    expect(transcriptGit("rev-parse", "HEAD"), "The loaded transcript source changed during measurement").toBe(transcriptCommit);
    expect(transcriptGit("diff", "HEAD"), "The loaded transcript changes must stay fixed during measurement").toBe(transcriptDiff);
    if (profileSearch && (mode === "columns" || mode === "rows")) {
      expect(measurements.frames.searchQuery.join("\n")).toContain("Search:");
      expect(measurements.frames.searchClosed.join("\n")).not.toContain("Search:");
      expect(measurements.samples.some((sample: { action: string }) => sample.action === "search-typing")).toBe(true);
    }
    expect(measurements.syntheticOnly).toBe(true);
    if (mode === "stock" || mode === "combined") {
      expect(measurements.samples.every((sample: { documents: number; timestampIndexes: number }) =>
        sample.documents === 0 && sample.timestampIndexes === 0), "Native history must not use projected Transcript documents").toBe(true);
    }
    expect(measurements.initialDisplay.emittedFrameMs).toBeGreaterThan(0);
    expect(measurements.initialDisplay.cpuMs).toBeGreaterThan(0);
    expect(measurements.runtime.savedToolBlocks, "The synthetic history must not be compacted before measurement").toBe(size);
    expect(measurements.samples).not.toHaveLength(0);
    expect(measurements.samples.find((sample: { action: string }) => sample.action === "cold").sourceInvalidations,
      "A root invalidation must refresh the shared native history exactly once").toBe(1);
    expect(measurements.frames.streamed.some((line: string) => line.includes("SYNTHETIC STREAM UPDATE")),
      "The streamed native assistant must be visible before restoring its content").toBe(true);
    expect(measurements.markers.some((line: string) => line.includes("SYNTHETIC TOOL UPDATE")),
      "The updated native tool must be visible in the emitted final frame").toBe(true);
    expect(measurements.samples.every((sample: { paneRows: number }) => sample.paneRows <= height),
      "Pane height measurement must not assemble more than a window of history rows").toBe(true);
    expect(measurements.samples.every((sample: { previewScrollRows: number }) => sample.previewScrollRows <= height),
      "Intrinsic pane measurement must not pad the full scrollback for a scrollbar").toBe(true);
    expect(measurements.samples.every((sample: { panePreviewCharacters: number }) => sample.panePreviewCharacters === 0),
      "Intrinsic pane height measurement must not composite native text").toBe(true);
    if (scrollbar === "auto") {
      expect(measurements.samples.filter((sample: { action: string }) => sample.action === "scroll")
        .every((sample: { visibleScrollbars: number }) => sample.visibleScrollbars > 0),
      "Auto-mode scrolling must measure visible native scrollbars, not a hidden-bar substitute").toBe(true);
    }
    expect(measurements.draft).toBe("SYNTHETIC PROFILE DRAFT ");
    console.log(JSON.stringify({ mode, summary: measurements.summary }));
  } finally {
    await rm(cwd, { recursive: true, force: true });
    await rm(agent, { recursive: true, force: true });
  }
});
