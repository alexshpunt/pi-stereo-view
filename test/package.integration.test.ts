import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { assistantMessage, PiIntegrationTest, text, toolCall } from "pi-coding-agent-test";
import { expect, test } from "vitest";

const exec = promisify(execFile);

test("ships only public runtime files and loads the installed archive in real Pi", async () => {
  const scratch = await mkdtemp(path.join(tmpdir(), "pi-agent-transcript-package-"));
  const runtime = path.join(scratch, "runtime");
  const workspace = path.join(scratch, "workspace");
  const agent = path.join(scratch, "agent");
  try {
    await Promise.all([runtime, workspace, agent].map(directory => mkdir(directory)));
    // Packaging checks use a fixed pane width, not the user's default split ratio.
    await writeFile(path.join(agent, "transcript.json"), JSON.stringify({
      mode: "split", side: "left", layout: "columns", chatWidth: 40, chatHeight: 12, zoom: null,
    }));
    const packed = await exec("npm", ["pack", "--json", "--pack-destination", scratch], {
      cwd: process.cwd(), maxBuffer: 1024 * 1024,
    });
    const [archive]: { filename: string; files: { path: string }[] }[] = JSON.parse(packed.stdout);
    const paths = archive.files.map(file => file.path).sort();
    expect(paths.filter(file => !/^(package\.json|README\.md|LICENSE|src\/.+\.ts)$/.test(file))).toEqual([]);
    expect(paths).toContain("LICENSE");
    expect(paths).toContain("src/index.ts");

    await writeFile(path.join(runtime, "package.json"), JSON.stringify({ private: true }));
    await exec("npm", ["install", path.join(scratch, archive.filename), "--omit=dev", "--ignore-scripts",
      "--legacy-peer-deps", "--no-audit", "--no-fund"], { cwd: runtime, maxBuffer: 1024 * 1024 });
    expect(await readdir(path.join(runtime, "node_modules"))).toEqual([".package-lock.json", "pi-agent-transcript"]);
    const installed = path.join(runtime, "node_modules/pi-agent-transcript");
    const manifest = JSON.parse(await readFile(path.join(installed, "package.json"), "utf8"));
    expect(manifest.private).not.toBe(true);
    expect(manifest.license).toBe("MIT");
    expect(manifest.dependencies ?? {}).toEqual({});
    expect(manifest.peerDependencies).toMatchObject({
      "@earendil-works/pi-coding-agent": "*", "@earendil-works/pi-tui": "*",
    });
    expect(manifest.keywords).toContain("pi-package");
    expect(manifest.repository.url).toBe("git+https://github.com/alexshpunt/pi-agent-transcript.git");

    const run = await new PiIntegrationTest({
      testName: "installed-archive", artifactsDir: path.resolve("tmp/test-runs"), cwd: workspace,
      piCommand: path.resolve("test/fixtures/pi-host.sh"), isolateUserResources: false,
      environment: { PI_CODING_AGENT_DIR: agent }, rawMode: false, tuiSize: { cols: 120, rows: 45 },
      extensions: [...manifest.pi.extensions.map((entry: string) => path.resolve(installed, entry)),
        path.resolve("test/fixtures/native-probe.ts")],
      tools: ["write"], conversation: [
        assistantMessage([toolCall({ id: "packed-write", name: "write",
          arguments: { path: path.join(workspace, "effect.txt"), content: "PACKED TOOL EFFECT" } })], { stopReason: "toolUse" }),
        assistantMessage([text("PACKED ANSWER")]),
      ],
    }).run("PACKED USER");
    expect(run.providerRequests).toHaveLength(2);
    expect(await readFile(path.join(workspace, "effect.txt"), "utf8")).toBe("PACKED TOOL EFFECT");
    const frame: string[] = JSON.parse(await readFile(path.join(workspace, "native-snapshot.json"), "utf8"));
    const lines = frame.map(stripTerminalSequences);
    expect(lines.filter(line => line.includes("[ ≡ ]"))).toHaveLength(1);
    expect(lines.filter(line => line.includes("Conversation") && line.includes("[ ↗ ]"))).toHaveLength(1);
    expect(lines.filter(line => line.includes("Activity") && line.includes("[ ↗ ]"))).toHaveLength(1);
    for (const marker of ["PACKED USER", "PACKED ANSWER", "NATIVE CALL MARKER", "NATIVE RESULT MARKER", "THINKING MARKER"]) {
      expect(lines.join("\n")).toContain(marker);
    }
    expect(lines.join("\n")).not.toContain("Transcript split is unavailable");
    expect(lines.slice(-5).some(line => line.includes("─".repeat(120)))).toBe(true);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}, 120_000);
