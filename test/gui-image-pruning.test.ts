import { expect, test } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
// @ts-expect-error The mod has no TypeScript declarations.
import { IMAGE_CACHE_INIT } from "../herdr/mods/stereo-view/image-pruner.js";
// @ts-expect-error The mod has no TypeScript declarations.
import { createImageCache } from "../herdr/mods/stereo-view/image-pruner.js";

/** A real long-lived App process which starts the same Node initializer as Herdr's exec. */
async function owner(root: string): Promise<{ child: ReturnType<typeof spawn>; directory: string }> {
  const app = `const {spawnSync}=require('node:child_process');const r=spawnSync(process.execPath,['-e',${JSON.stringify(IMAGE_CACHE_INIT)},process.argv[1]],{encoding:'utf8'});if(r.status!==0){console.error(r.stderr);process.exit(1)}console.log(r.stdout.trim());setInterval(()=>{},1000)`;
  const child = spawn(process.execPath, ["-e", app, root], { stdio: ["ignore", "pipe", "pipe"] });
  const directory = await new Promise<string>((resolve, reject) => {
    let stdout = "", stderr = "";
    child.stderr!.on("data", data => { stderr += String(data); });
    child.once("error", reject);
    child.once("exit", code => reject(new Error(`owner exited ${code}: ${stderr}`)));
    child.stdout!.on("data", data => {
      stdout += String(data);
      const newline = stdout.indexOf("\n");
      if (newline >= 0) resolve(stdout.slice(0, newline));
    });
  });
  return { child, directory };
}

async function stop(child: ReturnType<typeof spawn>): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const done = new Promise<void>(resolve => child.once("exit", () => resolve()));
  child.kill();
  await done;
}

test("image cleanup preserves other live App owners and removes only dead owners", async () => {
  const root = mkdtempSync(join(tmpdir(), "stereo-image-cache-"));
  const children: ReturnType<typeof spawn>[] = [];
  try {
    // An older App may still be reading a flat-cache file.
    const legacy = join(root, `${"a".repeat(64)}.png`);
    writeFileSync(legacy, "legacy image");
    const first = await owner(root); children.push(first.child);
    const second = await owner(root); children.push(second.child);
    expect(first.directory).not.toBe(second.directory);
    const firstImage = join(root, first.directory, "image.png");
    const secondImage = join(root, second.directory, "image.png");
    writeFileSync(firstImage, "first"); writeFileSync(secondImage, "second");
    const run = () => spawnSync(process.execPath, ["-e", IMAGE_CACHE_INIT, root], { encoding: "utf8" });
    const active = run();
    expect(active.status).toBe(0);
    const sameAppImage = join(root, active.stdout.trim(), "image.png");
    writeFileSync(sameAppImage, "same app");
    const secondRuntime = run();
    expect(secondRuntime.status).toBe(0);
    expect(secondRuntime.stdout.trim()).not.toBe(active.stdout.trim());
    expect(readFileSync(sameAppImage, "utf8")).toBe("same app");
    expect(readFileSync(firstImage, "utf8")).toBe("first");
    expect(readFileSync(secondImage, "utf8")).toBe("second");
    await stop(first.child);
    const afterExit = run();
    expect(afterExit.status).toBe(0);
    expect(existsSync(firstImage)).toBe(false);
    expect(readFileSync(secondImage, "utf8")).toBe("second");
    expect(readFileSync(legacy, "utf8")).toBe("legacy image");
  } finally {
    await Promise.all(children.map(stop));
    rmSync(root, { recursive: true, force: true });
  }
});

test("isolated cache initialization is shared across writers and never falls back to a shared path", async () => {
  let calls = 0;
  const expected = `owner-123-${"a".repeat(32)}`;
  const cache = createImageCache(async () => {
    calls++;
    if (calls === 1) return { code: 1, stdout: "" };
    if (calls === 2) return { code: 0, stdout: "../unsafe" };
    return { code: 0, stdout: `${expected}\n` };
  });
  await expect(cache()).rejects.toThrow();
  await expect(cache()).rejects.toThrow();
  await expect(Promise.all([cache(), cache()])).resolves.toEqual([expected, expected]);
  expect(await cache()).toBe(expected);
  expect(calls).toBe(3);
});
