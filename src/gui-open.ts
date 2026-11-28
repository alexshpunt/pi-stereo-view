import { execFile } from "node:child_process";

export type HerdrCommand = (args: string[]) => Promise<string>;

export const herdrCommand: HerdrCommand = args => new Promise((resolve, reject) => {
  execFile("herdr-app", args, { timeout: 4000, maxBuffer: 1024 * 1024, windowsHide: true }, (error, stdout) => {
    if (error) reject(error); else resolve(stdout);
  });
});

/** Open only with an App-verified, machine-qualified caller address. */
export async function openGuiForFocusedTerminal(terminal: string, pid: number, run: HerdrCommand = herdrCommand,
  stillRunning: () => boolean = () => true): Promise<boolean> {
  // HC_TERMINAL_ID is normally a bare, machine-local ID. It cannot identify the
  // caller in the App's machine namespace, even when its PID also matches.
  // Fail closed until the App supplies a verified fully qualified address.
  if (!/^[^/\s]+\/t[a-zA-Z0-9]+$/.test(terminal) || !Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    const status = JSON.parse(await run(["status"]));
    if (status.agent !== terminal || typeof status.tab !== "string" || !status.tab) return false;
    const list = JSON.parse(await run(["do", "agent.list"]));
    if (!Array.isArray(list.agents) || !list.agents.some((agent: { terminal?: unknown; pid?: unknown }) =>
      agent.terminal === status.agent && agent.pid === pid)) return false;
    const latest = JSON.parse(await run(["status"]));
    if (!stillRunning() || latest.agent !== status.agent || latest.tab !== status.tab) return false;
    await run(["do", "app.open", JSON.stringify({ mod: "stereo-view", app: "stereo-view", for: status.agent })]);
    return true;
  } catch {
    // The app or the optional mod may not be installed. The terminal stays usable.
    return false;
  }
}
