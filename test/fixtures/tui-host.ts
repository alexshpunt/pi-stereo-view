import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text, type TUI } from "@earendil-works/pi-tui";

export type TestHost = TUI & { getScreenLines(): string[]; handleTerminalInput(data: string): void };

/** Obtain the host without showing a dialog or taking input focus. */
export async function captureTui(ctx: ExtensionContext): Promise<TestHost> {
  let tui!: TestHost;
  let finish = (): void => {};
  await ctx.ui.custom<void>((host, _theme, _keys, done) => {
    tui = host as TestHost;
    finish = done;
    return new Text("", 0, 0);
  }, { overlay: true, overlayOptions: { visible: () => false, nonCapturing: true }, onHandle: () => finish() });
  return tui;
}
