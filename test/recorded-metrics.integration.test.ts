import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { assistantMessage, PiIntegrationTest, text, toolCall } from "pi-coding-agent-test";
import { expect, test } from "vitest";

const plain = (lines: string[]) => lines.map(stripTerminalSequences);
const at = Date.parse("2026-01-01T10:00:00Z");
const response = (content: AssistantMessage["content"], input: number, stopReason: AssistantMessage["stopReason"]): AssistantMessage => ({
  role: "assistant", content, stopReason, timestamp: at, api: "openai-responses", provider: "openai", model: "metrics-fixture",
  usage: { input, output: 36, cacheRead: 52, cacheWrite: 9, totalTokens: input + 97,
    cost: { input: 0.003, output: 0.004, cacheRead: 0.0001, cacheWrite: 0.0002, total: 0.0073 } },
});
const duration = /\b(?:\d+ms|\d+\.\ds)\b/u;

test("live execution and resumed split history show only recorded metrics when enabled", async () => {
  await mkdir(path.resolve("tmp"), { recursive: true });
  const cwd = await mkdtemp(path.resolve("tmp/recorded-metrics-"));
  const agent = await mkdtemp(path.resolve("tmp/recorded-metrics-agent-"));
  try {
    await writeFile(path.join(agent, "settings.json"), JSON.stringify({ quietStartup: true }));
    const session = SessionManager.create(cwd, cwd);
    session.appendMessage({ role: "user", content: "Metrics fixture", timestamp: at });
    session.appendMessage(response([{ type: "thinking", thinking: "Saved reasoning" }, { type: "text", text: "Saved answer" }], 7654, "stop"));
    session.appendMessage(response([{ type: "toolCall", id: "legacy", name: "read", arguments: { path: "LEGACY-PATH" } }], 4321, "toolUse"));
    session.appendMessage({ role: "toolResult", toolCallId: "legacy", toolName: "read", content: [{ type: "text", text: "Legacy body" }], isError: false, timestamp: at });
    const run = async (phase: "live" | "resume" | "disabled", enabled: boolean) => {
      await writeFile(path.join(agent, "transcript.json"), JSON.stringify({
        layout: "columns", side: "left", chatWidth: 46, showTimestamps: phase !== "resume", compactTools: true,
        groupTools: false, showToolDurations: enabled, showModelUsage: enabled,
      }));
      const capture = path.join(cwd, phase + ".json");
      const result = await new PiIntegrationTest({
        testName: `recorded-metrics-${phase}`, artifactsDir: path.resolve("tmp/test-runs"), cwd,
        piCommand: path.resolve("test/fixtures/pi-host.sh"), isolateUserResources: false,
        environment: { PI_CODING_AGENT_DIR: agent, PI_TRANSCRIPT_TEST_SESSION: session.getSessionFile()!,
          NESTED_ACTIVITY_CAPTURE: capture, NESTED_ACTIVITY_CALLER: "codemode", NESTED_ACTIVITY_USAGE: "1" },
        extensions: ["builtin:codemode", path.resolve("src/index.ts"), path.resolve("test/fixtures/nested-activity-probe.ts")],
        rawMode: false, tuiSize: { cols: 160, rows: 50 }, timeoutMs: 35_000,
        tools: ["codemode", "nested_activity_leaf"],
        conversation: phase === "live" ? [assistantMessage([toolCall({ id: "metrics-root", name: "codemode", arguments: { code: `const children = [tools.nested_activity_leaf({marker: "ARG-P82", fail: false}), tools.nested_activity_leaf({marker: "ARG-Q82", fail: true})]; for (const result of await Promise.allSettled(children)) text(result.status);` } })], { stopReason: "toolUse" }), assistantMessage([text("Settled")])] : [assistantMessage([text("Restored")])],
      }).run(phase);
      expect(result.exitCode).toBe(0);
      const { settled } = JSON.parse(await readFile(capture, "utf8")) as { settled: { panes: { activity: string[]; chat: string[] }; screen: string[] } };
      return {
        activity: plain(settled.panes.activity), chat: plain(settled.panes.chat), screen: plain(settled.screen),
      };
    };
    for (const phase of ["live", "resume", "disabled"] as const) {
      const { activity, chat, screen } = await run(phase, phase !== "disabled");
      const legacy = activity.find(line => /●.*LEGACY-PATH/u.test(line));
      expect(legacy).toBeDefined();
      expect(legacy).not.toMatch(duration);
      const tools = activity.filter(line => /●.*(?:codemode\b(?! output)|nested_activity_leaf\b).*(?:\bconst\b|ARG-[PQ]82)/u.test(line));
      expect(tools).toHaveLength(3);
      if (phase === "disabled") {
        for (const row of tools) expect(row).not.toMatch(duration);
        expect([...activity, ...chat].join("\n")).not.toMatch(/↑7\.7k|↑4\.3k|0\.0036/);
      } else {
        for (const row of tools) expect(row).toMatch(duration);
        const modelRows = chat.filter(line => line.includes("↑7.7k"));
        expect(modelRows).toHaveLength(1);
        expect(modelRows[0]).toContain("↑7.7k ↓36 R52 W9 $0.0073");
        if (phase === "live") expect(modelRows[0]).toMatch(/\d{2}:\d{2}:\d{2}\s+↑7\.7k/);
        else expect(modelRows[0]).not.toMatch(/\d{2}:\d{2}:\d{2}/);
        expect(activity.filter(line => line.includes("↑4.3k"))).toHaveLength(1);
        expect(activity.filter(line => line.includes("$0.0036"))).toHaveLength(phase === "live" ? 2 : 1);
        expect(screen.join("\n")).toContain("$0.0036");
        expect(activity.join("\n")).not.toContain("↑7.7k");
      }
    }
  } finally {
    await Promise.all([cwd, agent].map(directory => rm(directory, { recursive: true, force: true })));
  }
}, 120_000);
