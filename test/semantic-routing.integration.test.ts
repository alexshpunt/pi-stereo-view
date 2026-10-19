import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { assistantMessage, getToolExecution, PiIntegrationTest, text, toolCall } from "pi-coding-agent-test";
import { expect, test } from "vitest";

const clean = (lines: string[]): string => lines.map(stripTerminalSequences).join("\n");

test.each(["columns", "rows"] as const)("routes real native diagnostics and system content separately from execution in %s", async layout => {
  await mkdir(path.resolve("tmp"), { recursive: true });
  const cwd = await mkdtemp(path.resolve("tmp/semantic-routing-"));
  const agent = await mkdtemp(path.resolve("tmp/semantic-agent-"));
  try {
    const misdeclared = path.join(cwd, "misdeclared-package");
    await mkdir(misdeclared);
    // Exercise the native loader's startupDiagnostics, not a notify() stand-in.
    await writeFile(path.join(misdeclared, "package.json"), JSON.stringify({
      name: "semantic-native-diagnostic-test", dependencies: { "@earendil-works/pi-coding-agent": "*" },
      pi: { extensions: ["probe.ts"] },
    }));
    await writeFile(path.join(misdeclared, "probe.ts"),
      `export { default } from ${JSON.stringify(path.resolve("test/fixtures/semantic-routing-probe.ts"))};\n`);
    await writeFile(path.join(agent, "settings.json"), JSON.stringify({
      quietStartup: false, hideThinkingBlock: false, packages: [path.resolve("."), misdeclared],
    }));
    await writeFile(path.join(agent, "transcript.json"), JSON.stringify({
      mode: "split", side: "left", chatWidth: 60, layout, chatHeight: 25, zoom: null, showTimestamps: false,
    }));
    const session = SessionManager.create(cwd, cwd);
    session.appendMessage({ role: "user", content: "SAVED DIALOGUE MARKER", timestamp: Date.now() });
    session.appendMessage({ role: "custom", customType: "unclassified-test-content", content: "CUSTOM SYSTEM MARKER",
      display: true, timestamp: Date.now() });
    session.appendMessage({ role: "bashExecution", command: "printf 'SHELL EXECUTION MARKER\\n'", output: "SHELL EXECUTION MARKER\n",
      exitCode: 0, cancelled: false, truncated: false, timestamp: Date.now() });
    const captureFile = path.resolve(`tmp/test-runs/semantic-routing-${layout}/semantic-routing.json`);
    const result = await new PiIntegrationTest({
      testName: `semantic-routing-${layout}`, artifactsDir: path.resolve("tmp/test-runs"), cwd,
      piCommand: path.resolve("test/fixtures/startup-host.sh"), isolateUserResources: false,
      environment: { PI_CODING_AGENT_DIR: agent, PI_TRANSCRIPT_TEST_SESSION: session.getSessionFile()!, SEMANTIC_ROUTING_FILE: captureFile },
      rawMode: false, tuiSize: { cols: 160, rows: 65 }, extensions: [], tools: ["write"],
      conversation: [
        assistantMessage([text("ASSISTANT DIALOGUE MARKER"), toolCall({ id: "semantic-write", name: "write",
          arguments: { path: "semantic-result.txt", content: "TOOL EXECUTION MARKER" } })], { stopReason: "toolUse" }),
        assistantMessage([text("FINAL DIALOGUE MARKER")]),
      ],
    }).run("USER DIALOGUE MARKER");
    expect(result.providerRequests).toHaveLength(2);
    expect(getToolExecution(result, "semantic-write").isError).toBe(false);
    expect(await readFile(path.join(cwd, "semantic-result.txt"), "utf8")).toBe("TOOL EXECUTION MARKER");
    const capture: {
      panes: Record<string, string[]>;
      search: Record<string, { text: string; label: string }[]>;
      reusedStatus: boolean;
    } = JSON.parse(await readFile(captureFile, "utf8"));
    const chat = clean(capture.panes.chat);
    const activity = clean(capture.panes.activity);
    const chatSearch = capture.search.chat.map(entry => entry.text).join("\n");
    const activitySearch = capture.search.activity.map(entry => entry.text).join("\n");
    expect(chat).toContain("[Extension issues]");
    for (const marker of ["Warning: Extension package", "STARTUP INFO MARKER", "STARTUP WARNING MARKER", "STARTUP ERROR MARKER",
      "RUNTIME WARNING MARKER", "RUNTIME ERROR MARKER", "UPDATED RUNTIME STATUS", "CUSTOM SYSTEM MARKER", "UNKNOWN SYSTEM MARKER",
      "SAVED DIALOGUE MARKER", "USER DIALOGUE MARKER", "ASSISTANT DIALOGUE MARKER", "FINAL DIALOGUE MARKER"]) {
      expect(chat, marker).toContain(marker);
      expect(activity, marker).not.toContain(marker);
      expect(chatSearch, marker).toContain(marker);
      expect(activitySearch, marker).not.toContain(marker);
    }
    expect(capture.reusedStatus).toBe(true);
    expect(chat).not.toContain("FIRST RUNTIME STATUS");
    expect(chatSearch).not.toContain("FIRST RUNTIME STATUS");
    for (const marker of ["THINKING EXECUTION MARKER", "semantic-result.txt", "SHELL EXECUTION MARKER"]) {
      expect(activity, marker).toContain(marker);
      expect(chat, marker).not.toContain(marker);
      expect(activitySearch, marker).toContain(marker);
      expect(chatSearch, marker).not.toContain(marker);
    }
  } finally {
    await Promise.all([cwd, agent].map(directory => rm(directory, { recursive: true, force: true })));
  }
}, 45_000);
