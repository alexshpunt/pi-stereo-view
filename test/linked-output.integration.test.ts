import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { assistantMessage, getToolExecution, PiIntegrationTest, testArtifactsDir, text, toolCall } from "pi-coding-agent-test";
import { expect, test } from "vitest";

const artifactsDir = testArtifactsDir(import.meta.filename, path.resolve("tmp/test-runs"));
const clean = (lines: string[]): string => lines.map(stripTerminalSequences).join("\n");
const ordered = (value: string, markers: string[]): void => {
  const positions = markers.map(marker => value.indexOf(marker));
  expect(positions, value).not.toContain(-1);
  expect(positions, value).toEqual([...positions].sort((a, b) => a - b));
};
interface Capture {
  panes: Record<string, string[]>;
  search: Record<string, { text: string; label: string }[]>;
  native: string[];
  expanded: string[];
  revealed: boolean;
  searchRow?: number;
  sourceChildrenUnchanged: boolean;
  screen: string[];
}

// Configured startup and native renderers are part of the history-reconstruction contract.
test.each(["columns", "rows"] as const)("groups late output and its search under the saved execution owner in %s", async layout => {
  await mkdir(path.resolve("tmp"), { recursive: true });
  const cwd = await mkdtemp(path.resolve("tmp/linked-output-"));
  const agent = await mkdtemp(path.resolve("tmp/linked-output-agent-"));
  try {
    const probe = path.join(cwd, "worker-probe");
    await mkdir(probe);
    await writeFile(path.join(probe, "package.json"), JSON.stringify({
      name: "unrelated-worker-probe", pi: { extensions: ["probe.ts"] },
    }));
    await writeFile(path.join(probe, "probe.ts"),
      `export { default } from ${JSON.stringify(path.resolve("test/fixtures/linked-output-probe.ts"))};\n`);
    await writeFile(path.join(agent, "settings.json"), JSON.stringify({
      quietStartup: true, packages: [path.resolve("."), probe],
    }));
    await writeFile(path.join(agent, "transcript.json"), JSON.stringify({
      mode: "split", side: "left", chatWidth: 60, layout, chatHeight: 20, zoom: null, showTimestamps: false,
    }));
    const session = SessionManager.create(cwd, cwd);
    session.appendMessage({ role: "user", content: "SAVED USER DIALOGUE", timestamp: Date.now() });
    for (const phase of ["live", "resume"] as const) {
      if (phase === "resume") SessionManager.open(session.getSessionFile()!).appendCustomMessageEntry(
        "unrelated-worker-message", "LATE MESSAGE OUTPUT", true, { parentToolCallId: "second-write" },
      );
      const name = `linked-output-${layout}-${phase}`;
      const captureFile = path.join(artifactsDir, name, "linked-output.json");
      const result = await new PiIntegrationTest({
        testName: name, artifactsDir, cwd,
        piCommand: path.resolve("test/fixtures/startup-host.sh"), isolateUserResources: false,
        environment: {
          PI_CODING_AGENT_DIR: agent, PI_TRANSCRIPT_TEST_SESSION: session.getSessionFile()!,
          LINKED_OUTPUT_APPEND: phase === "live" ? "1" : "0", LINKED_OUTPUT_FILE: captureFile,
        },
        rawMode: false, tuiSize: { cols: 160, rows: 60 }, extensions: [], tools: ["write"],
        conversation: phase === "live" ? [
          assistantMessage([toolCall({ id: "first-write", name: "write", arguments: {
            path: "first-owned.txt", content: "FIRST FILE CONTENT",
          } })], { stopReason: "toolUse" }),
          assistantMessage([toolCall({ id: "second-write", name: "write", arguments: {
            path: "second-unrelated.txt", content: "SECOND FILE CONTENT",
          } })], { stopReason: "toolUse" }),
          assistantMessage([text("TOOLS FINISHED")]),
        ] : [assistantMessage([text("SESSION RESUMED")])],
      }).run(phase === "live" ? "Write both files" : "Inspect restored history");
      expect(result.exitCode).toBe(0);
      expect(result.providerRequests).toHaveLength(phase === "live" ? 3 : 1);
      if (phase === "live") {
        expect(getToolExecution(result, "first-write").isError).toBe(false);
        expect(getToolExecution(result, "second-write").isError).toBe(false);
      }
      const capture: Capture = JSON.parse(await readFile(captureFile, "utf8"));
      const activity = clean(capture.panes.activity);
      const chat = clean(capture.panes.chat);
      const grouped = ["first-owned.txt", "LATE FIRST OUTPUT", "LATER FIRST UPDATE", "second-unrelated.txt", "LATE SECOND OUTPUT"];
      if (phase === "resume") {
        grouped.push("LATE MESSAGE OUTPUT");
        expect(chat).not.toContain("LATE MESSAGE OUTPUT");
      }
      expect(activity).not.toContain("EXPANDED WORKER DETAIL");
      ordered(activity, grouped);
      ordered(capture.search.activity.map(entry => entry.text).join("\n"), grouped);
      ordered(clean(capture.native), ["first-owned.txt", "second-unrelated.txt", "LATE SECOND OUTPUT", "LATE FIRST OUTPUT", "LATER FIRST UPDATE"]);
      expect(capture.sourceChildrenUnchanged).toBe(true);
      for (const marker of ["LATE FIRST OUTPUT", "LATER FIRST UPDATE", "LATE SECOND OUTPUT"]) {
        expect(activity.split(marker)).toHaveLength(2);
        expect(chat).not.toContain(marker);
        expect(capture.search.chat.map(entry => entry.text).join("\n")).not.toContain(marker);
        expect(JSON.stringify(result.providerRequests)).not.toContain(marker);
      }
      expect(chat).toContain("UNOWNED WORKER REPORT");
      expect(activity).not.toContain("UNOWNED WORKER REPORT");
      expect(capture.revealed).toBe(true);
      expect(clean(capture.expanded)).toContain("EXPANDED WORKER DETAIL");
      expect(capture.searchRow).toBeTypeOf("number");
      expect(stripTerminalSequences(capture.expanded[capture.searchRow!])).toContain("LATE FIRST OUTPUT");
      expect(clean(capture.screen)).toContain("Activity");
      expect(clean(capture.screen)).toContain("LATE FIRST OUTPUT");
    }
    expect(await readFile(path.join(cwd, "first-owned.txt"), "utf8")).toBe("FIRST FILE CONTENT");
    expect(await readFile(path.join(cwd, "second-unrelated.txt"), "utf8")).toBe("SECOND FILE CONTENT");
    expect(SessionManager.open(session.getSessionFile()!).getBranch().filter(entry =>
      entry.type === "custom" && entry.customType === "unrelated-worker-report")).toHaveLength(4);
  } finally {
    await Promise.all([cwd, agent].map(directory => rm(directory, { recursive: true, force: true })));
  }
}, 60_000);

test("rebuilds linked ownership and discards old search on reload and branch navigation", async () => {
  await mkdir(path.resolve("tmp"), { recursive: true });
  const cwd = await mkdtemp(path.resolve("tmp/linked-output-lifecycle-"));
  const agent = await mkdtemp(path.resolve("tmp/linked-output-lifecycle-agent-"));
  try {
    await writeFile(path.join(agent, "settings.json"), JSON.stringify({ quietStartup: true }));
    await writeFile(path.join(agent, "transcript.json"), JSON.stringify({
      mode: "split", side: "left", chatWidth: 45, layout: "columns", chatHeight: 20, zoom: null, showTimestamps: false,
    }));
    const manager = SessionManager.create(cwd, cwd);
    const common = manager.appendMessage({ role: "user", content: "COMMON HISTORY", timestamp: Date.now() });
    const branch = (prefix: string): string => {
      const content: AssistantMessage["content"] = [
        { type: "toolCall", id: "shared-owner", name: "write", arguments: { path: `${prefix}-first.txt`, content: prefix } },
        { type: "toolCall", id: "shared-unrelated", name: "write", arguments: { path: `${prefix}-second.txt`, content: prefix } },
      ];
      manager.appendMessage({
        role: "assistant", content, timestamp: Date.now(), api: "openai-responses", provider: "openai", model: "saved-test-model",
        stopReason: "toolUse", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      });
      for (const toolCallId of ["shared-owner", "shared-unrelated"]) manager.appendMessage({
        role: "toolResult", toolName: "write", toolCallId, content: [{ type: "text", text: `${prefix} TOOL FINISHED` }],
        isError: false, timestamp: Date.now(),
      });
      return manager.appendCustomEntry("unrelated-worker-report", {
        parentToolCallId: "shared-owner", text: `${prefix.toUpperCase()} LINKED OUTPUT`,
      });
    };
    const target = branch("new");
    manager.branch(common);
    branch("old");
    const captureFile = path.join(artifactsDir, "linked-output-lifecycle", "linked-output.json");
    const result = await new PiIntegrationTest({
      testName: "linked-output-lifecycle", artifactsDir, cwd,
      piCommand: path.resolve("test/fixtures/pi-host.sh"), isolateUserResources: false,
      environment: {
        PI_CODING_AGENT_DIR: agent, PI_TRANSCRIPT_TEST_SESSION: manager.getSessionFile()!,
        LINKED_OUTPUT_BRANCH_TARGET: target, LINKED_OUTPUT_FILE: captureFile,
      },
      rawMode: false, tuiSize: { cols: 160, rows: 60 },
      extensions: [path.resolve("src/index.ts"), path.resolve("test/fixtures/linked-output-probe.ts")],
      tools: [], timeoutMs: 60_000, conversation: [assistantMessage([text("LIFECYCLE FINISHED")])],
    }).run("/linked-output-lifecycle-check");
    expect(result.exitCode).toBe(0);
    expect(result.providerRequests).toHaveLength(1);
    const snapshots: Record<string, Pick<Capture, "panes" | "search" | "native" | "screen" | "sourceChildrenUnchanged">> =
      JSON.parse(await readFile(captureFile, "utf8"));
    for (const phase of ["beforeReload", "reloaded", "beforeBranch"]) {
      const snapshot = snapshots[phase];
      ordered(clean(snapshot.panes.activity), ["old-first.txt", "OLD LINKED OUTPUT", "old-second.txt"]);
      expect(clean(snapshot.panes.chat)).not.toContain("OLD LINKED OUTPUT");
    }
    for (const phase of ["beforeReload", "beforeBranch"]) {
      expect(clean(snapshots[phase].screen)).toContain("Search:");
      expect(clean(snapshots[phase].screen)).toContain("1/1");
    }
    for (const phase of ["reloaded", "branched"]) expect(clean(snapshots[phase].screen)).not.toContain("Search:");
    expect(clean(snapshots.oldQuery.screen)).toContain("0/0");
    expect(clean(snapshots.newQuery.screen)).toContain("1/1");
    for (const phase of ["branched", "oldQuery", "newQuery", "revealed", "finished"]) {
      const snapshot = snapshots[phase];
      const activity = clean(snapshot.panes.activity);
      ordered(activity, ["new-first.txt", "NEW LINKED OUTPUT", "new-second.txt"]);
      ordered(snapshot.search.activity.map(entry => entry.text).join("\n"), ["new-first.txt", "NEW LINKED OUTPUT", "new-second.txt"]);
      ordered(clean(snapshot.native), ["new-first.txt", "new-second.txt", "NEW LINKED OUTPUT"]);
      expect(activity.split("NEW LINKED OUTPUT")).toHaveLength(2);
      expect(clean(snapshot.panes.chat)).not.toContain("NEW LINKED OUTPUT");
      expect(activity).not.toContain("OLD LINKED OUTPUT");
      expect(clean(snapshot.panes.chat)).not.toContain("OLD LINKED OUTPUT");
      expect(snapshot.search.activity.map(entry => entry.text).join("\n")).not.toContain("OLD LINKED OUTPUT");
      expect(snapshot.search.chat.map(entry => entry.text).join("\n")).not.toContain("OLD LINKED OUTPUT");
    }
    for (const snapshot of Object.values(snapshots)) expect(snapshot.sourceChildrenUnchanged).toBe(true);
    expect(clean(snapshots.revealed.screen)).toContain("NEW LINKED OUTPUT");
    expect(clean(snapshots.finished.panes.chat)).toContain("LIFECYCLE FINISHED");
  } finally {
    await Promise.all([cwd, agent].map(directory => rm(directory, { recursive: true, force: true })));
  }
}, 60_000);
