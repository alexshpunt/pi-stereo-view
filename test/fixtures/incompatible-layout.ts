import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text, type TUI, type VStack } from "@earendil-works/pi-tui";

/** Add a zero-height foreign layout entry to exercise compatibility refusal. */
export default function incompatibleLayout(pi: ExtensionAPI): void {
  pi.on("session_start", async (_event, ctx) => {
    if (ctx.mode !== "tui") return;
    let finish: () => void = () => {};
    await ctx.ui.custom<void>((tui, _theme, _keys, done) => {
      const root = (tui as TUI & { layoutRoot: VStack }).layoutRoot;
      root.addChild(new Text("", 0, 0), { basis: 0, grow: 0, minSize: 0 });
      finish = done;
      return new Text("", 0, 0);
    }, {
      overlay: true,
      overlayOptions: { visible: () => false, nonCapturing: true },
      onHandle: () => finish(),
    });
  });
}
