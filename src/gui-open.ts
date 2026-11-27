import { execFile } from "node:child_process";

export type HerdrCommand = (args: string[]) => Promise<string>;

export const herdrCommand: HerdrCommand = args => new Promise((resolve, reject) => {
  execFile("herdr-app", args, { timeout: 4000, maxBuffer: 1024 * 1024, windowsHide: true }, (error, stdout) => {
    if (error) reject(error); else resolve(stdout);
  });
});

/** Do not switch another agent's tab when a background Pi starts. */
export async function openGuiForFocusedTerminal(terminal: string, pid: number, run: HerdrCommand = herdrCommand,
  stillRunning: () => boolean = () => true): Promise<boolean> {
  try {
    const status = JSON.parse(await run(["status"]));
    if (typeof status.agent !== "string" || (status.agent !== terminal && !status.agent.endsWith(`/${terminal}`))) return false;
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
