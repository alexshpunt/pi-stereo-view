import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { assistantMessage, getToolCallNames, getToolExecution, getToolResultText, PiIntegrationTest, text, toolCall } from "pi-coding-agent-test";
import { expect, test } from "vitest";
import { aliasNames } from "./fixtures/compact-aliases-probe.js";

test("groups a verified local forwarding alias with its source while foreign tools and original renderers remain distinct", async () => {
  await mkdir(path.resolve("tmp"), { recursive: true });
  const cwd = await mkdtemp(path.resolve("tmp/compact-aliases-"));
  const agent = await mkdtemp(path.resolve("tmp/compact-aliases-agent-"));
  const calls = [
    // Keep fixture values clear of native follow-end controls beside inline clocks.
    { id: "alias-source", name: aliasNames.source, tag: "S938" },
    { id: "alias-local", name: aliasNames.local, tag: "L938" },
    { id: "alias-foreign", name: aliasNames.foreign, tag: "F938" },
    { id: "alias-unknown", name: aliasNames.unknown, tag: "U938" },
    { id: "alias-before-text", name: aliasNames.source, tag: "B938" },
    { id: "alias-after-text", name: aliasNames.source, tag: "A938" },
  ];
  const asTool = (call: typeof calls[number]) => toolCall({ id: call.id, name: call.name, arguments: { tag: call.tag } });
  try {
    await writeFile(path.join(agent, "settings.json"), JSON.stringify({ quietStartup: true, hideThinkingBlock: false }));
    await writeFile(path.join(agent, "transcript.json"), JSON.stringify({ layout: "rows", side: "left", chatWidth: null, chatHeight: 14, compactTools: true }));
    const result = await new PiIntegrationTest({
      testName: "compact-aliases", artifactsDir: path.resolve("tmp/test-runs"), cwd,
      piCommand: path.resolve("test/fixtures/pi-host.sh"), isolateUserResources: false,
      environment: { PI_CODING_AGENT_DIR: agent, TZ: "UTC" },
      rawMode: false, tuiSize: { cols: 120, rows: 60 }, timeoutMs: 60_000,
      extensions: [path.resolve("src/index.ts"), path.resolve("test/fixtures/compact-aliases-probe.ts")],
      tools: Object.values(aliasNames), conversation: [
        assistantMessage(calls.slice(0, 5).map(asTool), { stopReason: "toolUse" }),
        assistantMessage([text("CONVERSATION-BOUNDARY-FIXTURE"), asTool(calls[5])], { stopReason: "toolUse" }),
        assistantMessage([text("ANSWER-FIXTURE")]),
      ],
    }).run("USER-FIXTURE");
    expect(result.exitCode).toBe(0);
    const observation = JSON.parse(await readFile(path.join(cwd, "compact-alias-observation.json"), "utf8")) as {
      frames: Record<string, string[]>; executions: { name: string; id: string; tag: string }[];
      starts: { toolCallId: string; time: number }[]; error?: string;
    };
    await writeFile(path.join(result.artifacts.directory, "compact-alias-observation.json"), JSON.stringify(observation, null, 2));
    expect(observation.error, observation.frames.failure?.map(stripTerminalSequences).join("\n")).toBeUndefined();
    const frame = (name: string): string[] => observation.frames[name].map(stripTerminalSequences);
    const body = (name: string): string => frame(name).join("\n");
    expect(getToolCallNames(result)).toEqual(calls.map(call => call.name));
    expect(observation.executions).toEqual(calls);
    for (const call of calls) {
      expect(getToolExecution(result, call.id).isError).toBe(false);
      expect(getToolResultText(result, call.id)).toContain("RESULT-" + call.tag);
    }
    const start = (id: string): string => {
      const data = observation.starts.find(entry => entry.toolCallId === id);
      expect(data).toBeDefined();
      return new Date(data!.time).toISOString().slice(11, 19);
    };
    for (const name of ["collapsed", "collapsedAgain"]) {
      const rows = frame(name).filter(line => line.includes(aliasNames.source) && !line.includes(aliasNames.foreign));
      expect(rows).toHaveLength(3);
      expect(rows[0].replace(/\d{2}:\d{2}:\d{2}/g, "")).toContain(String(2));
      expect(rows[0]).toContain(start(calls[0].id));
      expect(body(name)).not.toContain(aliasNames.local);
      expect(body(name)).not.toContain(calls[0].tag);
      expect(body(name)).not.toContain(calls[1].tag);
      for (const call of calls.slice(2)) expect(body(name)).toContain(call.tag);
      expect(body(name)).toContain(aliasNames.foreign);
      expect(body(name)).toContain(aliasNames.unknown);
      expect(body(name)).toContain("CONVERSATION-BOUNDARY-FIXTURE");
    }
    for (const call of calls.slice(0, 2)) {
      const member = frame("members").find(line => line.includes(aliasNames.source) && line.includes(call.tag));
      expect(member).toContain(start(call.id));
    }
    expect(body("members")).not.toContain(aliasNames.local);
    expect(body("members")).not.toContain("RESULT-" + calls[0].tag);
    expect(body("members")).not.toContain("RESULT-" + calls[1].tag);
    for (const [capture, index] of [["sourceFull", 0], ["aliasFull", 1], ["foreignFull", 2]] as const) {
      const call = calls[index];
      expect(body(capture)).toContain("ORIGINAL-" + call.name + "-" + call.tag);
      expect(body(capture)).toContain(getToolResultText(result, call.id));
      for (const other of calls.filter(other => other !== call)) expect(body(capture)).not.toContain("RESULT-" + other.tag);
    }
    expect(body("fallbackFull")).toContain(getToolResultText(result, calls[3].id));
    expect(body("fallbackFull")).not.toContain("RESULT-" + calls[0].tag);
    expect(body("fallbackFull")).not.toContain("RESULT-" + calls[1].tag);
  } finally {
    await Promise.all([cwd, agent].map(directory => rm(directory, { recursive: true, force: true })));
  }
}, 75_000);


test("keeps an opened singleton visible when a later verified alias forms its group", async () => {
  await mkdir(path.resolve("tmp"), { recursive: true });
  const cwd = await mkdtemp(path.resolve("tmp/compact-singleton-"));
  const agent = await mkdtemp(path.resolve("tmp/compact-singleton-agent-"));
  const calls = [
    { id: "singleton-first", name: aliasNames.source, tag: "S938" },
    { id: "singleton-second", name: aliasNames.local, tag: "L938" },
  ];
  try {
    await writeFile(path.join(agent, "settings.json"), JSON.stringify({ quietStartup: true }));
    await writeFile(path.join(agent, "transcript.json"), JSON.stringify({ layout: "rows", side: "left", chatWidth: null, chatHeight: 14, compactTools: true }));
    const result = await new PiIntegrationTest({
      testName: "compact-singleton", artifactsDir: path.resolve("tmp/test-runs"), cwd,
      piCommand: path.resolve("test/fixtures/pi-host.sh"), isolateUserResources: false,
      environment: { PI_CODING_AGENT_DIR: agent, TZ: "UTC", COMPACT_ALIAS_SINGLETON: "1" },
      rawMode: false, tuiSize: { cols: 120, rows: 60 }, timeoutMs: 60_000,
      extensions: [path.resolve("src/index.ts"), path.resolve("test/fixtures/compact-aliases-probe.ts")],
      tools: calls.map(call => call.name), conversation: [
        ...calls.map(call => assistantMessage([toolCall({ id: call.id, name: call.name, arguments: { tag: call.tag } })], { stopReason: "toolUse" })),
        assistantMessage([text("ANSWER-FIXTURE")]),
      ],
    }).run("USER-FIXTURE");
    expect(result.exitCode).toBe(0);
    const observation = JSON.parse(await readFile(path.join(cwd, "compact-alias-observation.json"), "utf8")) as {
      frames: Record<string, string[]>; executions: typeof calls; error?: string;
    };
    await writeFile(path.join(result.artifacts.directory, "compact-alias-observation.json"), JSON.stringify(observation, null, 2));
    expect(observation.error, observation.frames.failure?.map(stripTerminalSequences).join("\n")).toBeUndefined();
    const body = (name: string): string => observation.frames[name].map(stripTerminalSequences).join("\n");
    expect(getToolCallNames(result)).toEqual(calls.map(call => call.name));
    expect(observation.executions).toEqual(calls);
    for (const call of calls) {
      expect(getToolExecution(result, call.id).isError).toBe(false);
      expect(getToolResultText(result, call.id)).toContain("RESULT-" + call.tag);
    }
    const original = "ORIGINAL-" + calls[0].name + "-" + calls[0].tag;
    expect(body("singleton")).toContain(calls[0].tag);
    expect(body("singleton")).not.toContain(original);
    expect(body("singletonOpen")).toContain(original);
    for (const capture of ["formed", "formedDone", "groupRestored"]) {
      expect(body(capture), capture + "\n" + body(capture)).toContain(original);
      expect(body(capture)).toContain(getToolResultText(result, calls[0].id));
      expect(body(capture)).toContain(calls[1].tag);
      expect(body(capture)).not.toContain("ORIGINAL-" + calls[1].name + "-" + calls[1].tag);
      expect(body(capture)).not.toContain("RESULT-" + calls[1].tag);
    }
    expect(body("groupHidden")).toContain(aliasNames.source);
    expect(body("groupHidden").replace(/\d{2}:\d{2}:\d{2}/g, "")).toContain(String(2));
    for (const call of calls) expect(body("groupHidden")).not.toContain(call.tag);
  } finally {
    await Promise.all([cwd, agent].map(directory => rm(directory, { recursive: true, force: true })));
  }
}, 75_000);