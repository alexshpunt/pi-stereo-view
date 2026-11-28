import { execFile } from "node:child_process";

export type HerdrCommand = (args: string[]) => Promise<string>;

export const herdrCommand: HerdrCommand = args => new Promise((resolve, reject) => {
  execFile("herdr-app", args, { timeout: 4000, maxBuffer: 1024 * 1024, windowsHide: true }, (error, stdout) => {
    if (error) reject(error); else resolve(stdout);
  });
});

/** Keep auto-open disabled until the running App can report its pane-view capability. */
export async function openGuiForFocusedTerminal(_terminal: string, _pid: number, _run: HerdrCommand = herdrCommand,
  _stillRunning: () => boolean = () => true): Promise<boolean> {
  // The command listing is from the CLI executable, which need not match the running App.
  // App status and agent.list do not report pane views. An invalid pane.view command is
  // not a safe probe: older Apps can route unknown commands to a mod. Opening the tab
  // manually remains available on both old and new Herdr versions.
  return false;
}
