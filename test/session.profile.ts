import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { assistantMessage, PiIntegrationTest, text, toolCall } from "pi-coding-agent-test";
import { expect, test } from "vitest";

// Opt-in: stream a scripted answer over a copy of a real saved session.
// The session stays outside the repository; only measurements are written.
const session = process.env.PROFILE_SESSION;
const mode = process.env.PROFILE_MODE ?? "split";
const transcript = path.resolve(process.env.PROFILE_TRANSCRIPT_PATH ?? ".");
const output = path.resolve(process.env.PROFILE_OUTPUT ?? "tmp/profiling/session");
const prose = Array.from({ length: 40 }, (_, row) => `Streamed paragraph line ${row} with \`code\`, **bold** words and more text.`).join("\n");
const command = "true # " + Array.from({ length: 60 }, (_, row) => `const value${row} = await tools.read({ path: "src/${row}.ts" });`).join(" ");

test.skipIf(!session)("profiles streaming over a saved session", async () => {
  if (!["stock", "split"].includes(mode)) throw new Error("Unknown profile mode: " + mode);
  await mkdir(path.resolve("tmp"), { recursive: true });
  const cwd = await mkdtemp(path.resolve("tmp/session-profile-"));
  const agent = await mkdtemp(path.resolve("tmp/session-profile-agent-"));
  try {
    await writeFile(path.join(agent, "settings.json"), JSON.stringify({ quietStartup: true, hideThinkingBlock: false, fullscreenScrollbar: "always", compaction: { enabled: false } }));
    await writeFile(path.join(agent, "transcript.json"), JSON.stringify({ side: "left", chatWidth: 90, layout: "columns", chatHeight: null,
      showTimestamps: true, showCopyButtons: true, compactTools: process.env.PROFILE_COMPACT !== "0" }));
    // The copied header must name an existing cwd, or Pi asks where to continue.
    const [header, ...entries] = (await readFile(session!, "utf8")).split("\n");
    const copy = path.join(cwd, "session.jsonl");
    await writeFile(copy, [JSON.stringify({ ...JSON.parse(header), cwd }), ...entries].join("\n"));
    const stream = { chunks: { kind: "fixed" as const, size: 4 }, delayMs: 8 };
    const result = await new PiIntegrationTest({
      testName: "session-" + mode, artifactsDir: path.join(output, "artifacts"), cwd,
      piCommand: path.resolve("test/fixtures/pi-host.sh"), isolateUserResources: false,
      environment: { PI_CODING_AGENT_DIR: agent, PI_TRANSCRIPT_IDE_PATH: "", PI_TRANSCRIPT_TEST_SESSION: copy,
        ...(process.env.PROFILE_CPU_DIR ? { NODE_OPTIONS: "--cpu-prof --cpu-prof-dir=" + path.resolve(process.env.PROFILE_CPU_DIR) } : {}) },
      rawMode: false, tuiSize: { cols: Number(process.env.PROFILE_WIDTH ?? 200), rows: Number(process.env.PROFILE_HEIGHT ?? 60) }, timeoutMs: 300_000,
      extensions: [...(mode === "stock" ? [] : [path.join(transcript, "src/index.ts")]), path.resolve("test/fixtures/session-measurements.ts")],
      tools: ["bash"],
      conversation: [
        assistantMessage([text(prose, stream), toolCall({ id: "profile-call", name: "bash", arguments: { command }, ...stream })], { stopReason: "toolUse" }),
        assistantMessage([text(prose, stream)]),
      ],
    }).run("SESSION PROFILE");
    // Pi may send extra requests for long restored contexts; the scripted turn needs at least two.
    expect(result.providerRequests.length).toBeGreaterThanOrEqual(2);
    const measured = JSON.parse(await readFile(path.join(cwd, "session-measurements.json"), "utf8"));
    await mkdir(output, { recursive: true });
    await writeFile(path.join(output, mode + ".json"), JSON.stringify({ mode, transcript, ...measured }, null, 2));
    console.log(JSON.stringify({ mode, ...measured }));
  } finally {
    await rm(cwd, { recursive: true, force: true });
    await rm(agent, { recursive: true, force: true });
  }
});
