import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { PiIntegrationTest } from "pi-coding-agent-test";
import { expect, test } from "vitest";
import type { StreamingFrame } from "./fixtures/streaming-layout-probe.js";

const columns = 140;
const chatWidth = 55;
const headerRow = (lines: string[], pane: string): number => lines.findIndex(line =>
  line.includes(pane) && line.includes("[ ↗ ]"));
const paneText = (lines: string[], layout: "columns" | "rows", pane: "Conversation" | "Activity"): string => {
  if (layout === "columns") {
    const divider = columns - chatWidth - 1;
    return lines.slice(4, -5).map(line => pane === "Conversation" ? line.slice(divider + 1) : line.slice(0, divider)).join("\n");
  }
  const start = headerRow(lines, pane);
  const other = headerRow(lines, pane === "Conversation" ? "Activity" : "Conversation");
  const end = other > start ? other - 1 : lines.findIndex((line, row) => row > start + 1 && line.includes("─".repeat(columns)));
  return lines.slice(start + 2, end).join("\n");
};

for (const layout of ["columns", "rows"] as const) for (const thinking of [true, false]) {
  test(`preserves ${layout} through ${thinking ? "thinking and text" : "text-only"} streaming and the next user turn`, async () => {
    await mkdir(path.resolve("tmp"), { recursive: true });
    const cwd = await mkdtemp(path.resolve("tmp/streaming-layout-workspace-"));
    const agent = await mkdtemp(path.resolve("tmp/streaming-layout-agent-"));
    const name = `streaming-layout-${layout}-${thinking ? "thinking" : "text"}`;
    const saved = { side: "right", chatWidth, layout, chatHeight: 12, showTimestamps: false, showCopyButtons: true };
    try {
      await writeFile(path.join(agent, "settings.json"), JSON.stringify({
        packages: [path.resolve(".")], quietStartup: true, hideThinkingBlock: false,
      }));
      await writeFile(path.join(agent, "transcript.json"), JSON.stringify(saved));
      // Fill the manual row height before streaming, so a content-sized pane cannot hide a size regression.
      const prompt = Array.from({ length: 20 }, (_, index) => `User context line ${index + 1}`).join("\n") + "\nSTREAM USER 1";
      const result = await new PiIntegrationTest({
        testName: name, artifactsDir: path.resolve("tmp/test-runs"), cwd,
        piCommand: path.resolve("test/fixtures/startup-host.sh"), isolateUserResources: false,
        environment: { PI_CODING_AGENT_DIR: agent, TRANSCRIPT_STREAM_THINKING: thinking ? "1" : "0" },
        rawMode: false, tuiSize: { cols: columns, rows: 44 }, tools: [],
        providerMode: "user", model: "streaming-layout-test/streaming-layout",
        extensions: [path.resolve("test/fixtures/streaming-layout-probe.ts")],
      }).run(prompt);
      const recorded = await readFile(path.join(cwd, "streaming-layout-frames.json"), "utf8");
      const frames: StreamingFrame[] = JSON.parse(recorded);
      await writeFile(path.join(result.artifacts.directory, "streaming-layout-frames.json"), recorded);
      const splitFrames = frames.filter(frame => frame.phase !== "combined");
      expect(frames.find(frame => frame.phase === "startup")).toBeDefined();
      expect(frames.filter(frame => frame.phase === "settled").map(frame => frame.turn)).toEqual([1, 2]);
      const messages = result.messages as { role: string; content: string | { type: string; text?: string }[] }[];
      const userMessages = messages.filter(message => message.role === "user");
      expect(userMessages.map(message => typeof message.content === "string" ? message.content :
        message.content.filter(block => block.type === "text").map(block => block.text).join(""))).toEqual([prompt, "STREAM USER 2"]);
      expect(messages.filter(message => message.role === "assistant")).toHaveLength(2);
      expect(result.state?.isIdle).toBe(true);
      expect(result.state?.hasPendingMessages).toBe(false);
      for (const turn of [1, 2]) {
        expect(frames.filter(frame => frame.turn === turn && frame.phase === "text_delta")).toHaveLength(2);
        expect(frames.filter(frame => frame.turn === turn && frame.phase === "thinking_delta")).toHaveLength(thinking ? 2 : 0);
      }
      expect(result.terminalOutput).not.toContain("split disabled");
      expect(result.terminalOutput).not.toContain("split is unavailable");
      for (const frame of splitFrames) {
        const label = `${frame.turn}: ${frame.phase}`;
        expect(headerRow(frame.lines, "Conversation"), label).toBeGreaterThan(0);
        expect(headerRow(frame.lines, "Activity"), label).toBeGreaterThan(0);
        if (layout === "columns") {
          expect(frame.lines[headerRow(frame.lines, "Conversation")].indexOf("║"), label).toBe(columns - chatWidth - 1);
        } else {
          const divider = frame.lines.findIndex(line => line.includes("═".repeat(columns)));
          expect(divider, label).toBeGreaterThan(0);
          expect(headerRow(frame.lines, "Activity"), label).toBeLessThan(divider);
          expect(headerRow(frame.lines, "Conversation"), label).toBeGreaterThan(divider);
          if (frame.phase !== "startup") {
            const chatHeader = headerRow(frame.lines, "Conversation");
            const dock = frame.lines.findIndex((line, row) => row > chatHeader + 1 && line.startsWith("──"));
            // Exclude the blank history/dock gap; a filled Conversation keeps its saved maximum.
            expect(dock - chatHeader - 1, label).toBe(saved.chatHeight);
          }
        }
        const chat = paneText(frame.lines, layout, "Conversation");
        const activity = paneText(frame.lines, layout, "Activity");
        expect(chat, label).not.toContain("REASONING");
        expect(activity, label).not.toContain("ANSWER");
        expect(activity, label).not.toContain("STREAM USER");
        if (frame.phase === "thinking_delta" || frame.phase === "thinking_end") {
          expect(activity, label).toContain(`REASONING ${frame.turn}`);
        }
        if (frame.phase === "text_delta" || frame.phase === "text_end" || frame.phase === "settled" || frame.phase === "restored") {
          expect(chat, label).toContain(`ANSWER ${frame.turn}`);
          expect(chat.match(new RegExp(`ANSWER ${frame.turn}`, "g")), label).toHaveLength(1);
          if (thinking) expect(activity, label).toContain(`REASONING ${frame.turn}`);
        }
      }
      const combined = frames.find(frame => frame.phase === "combined")!;
      expect(headerRow(combined.lines, "Conversation")).toBe(-1);
      expect(headerRow(combined.lines, "Activity")).toBe(-1);
      expect(combined.lines.join("\n")).toContain("ANSWER 2 FINISHED");
      if (thinking) expect(combined.lines.join("\n")).toContain("REASONING 2 FINISHED");
      expect(frames.at(-1)?.phase).toBe("restored");
      expect(JSON.parse(await readFile(path.join(agent, "transcript.json"), "utf8"))).toEqual(saved);
    } finally {
      await Promise.all([cwd, agent].map(directory => rm(directory, { recursive: true, force: true })));
    }
  });
}
