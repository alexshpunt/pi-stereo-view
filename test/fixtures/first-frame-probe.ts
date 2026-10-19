import { writeFile } from "node:fs/promises";
import path from "node:path";
import { InteractiveMode, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text, type TUI } from "@earendil-works/pi-tui";
import { emittedFrame } from "./emitted-frame.js";

type Host = TUI & { getScreenLines(): string[]; handleTerminalInput(data: string): void };

/** Keep an earlier init wrapper in place and exercise a real native startup dialog. */
export default function firstFrameProbe(pi: ExtensionAPI): void {
  const nativeInit = InteractiveMode.prototype.init;
  let renderer: TUI | undefined;
  let nativeStart: TUI["start"] | undefined;
  let ownStart: boolean | undefined;
  const recorder = async function (this: InteractiveMode): Promise<void> {
    renderer = (this as unknown as { renderer: TUI }).renderer;
    nativeStart = (Object.getPrototypeOf(renderer) as TUI).start;
    ownStart = false;
    await nativeInit.call(this);
  };
  InteractiveMode.prototype.init = recorder;
  pi.on("session_start", async (event, ctx) => {
    if (ctx.mode !== "tui" || event.reason !== "startup") return;
    let tui: Host;
    let finish = (): void => {};
    await ctx.ui.custom<void>((host, _theme, _keys, done) => {
      tui = host as Host;
      finish = done;
      return new Text("", 0, 0);
    }, { overlay: true, overlayOptions: { visible: () => false, nonCapturing: true }, onHandle: () => finish() });
    let dialog: Promise<string | undefined> | undefined;
    const opened = emittedFrame(tui!, () => { dialog = ctx.ui.select("STARTUP DIALOG CHECK", ["Continue", "Cancel"]); });
    await opened;
    tui!.handleTerminalInput("\r");
    const selected = await dialog!;
    await writeFile(path.join(ctx.cwd, "first-frame-probe.json"), JSON.stringify({
      selected, prototypeRestored: InteractiveMode.prototype.init === recorder,
      startRestored: renderer?.start === nativeStart, descriptorRestored: renderer && Object.hasOwn(renderer, "start") === ownStart,
    }));
  });
  pi.on("session_shutdown", () => {
    if (InteractiveMode.prototype.init === recorder) InteractiveMode.prototype.init = nativeInit;
  });
}
