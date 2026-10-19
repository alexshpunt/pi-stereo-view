import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text, type Component, type TUI } from "@earendil-works/pi-tui";
import { emittedFrame } from "./emitted-frame.js";

type Host = TUI & { layoutRoot: Component; getScreenLines(): string[] };

/** Emit awaited initialization notices and capture the real pane documents after a turn. */
export default function startupRoutingProbe(pi: ExtensionAPI): void {
  let tui: Host;
  pi.on("session_start", async (event, ctx) => {
    if (event.reason === "startup") {
      ctx.ui.notify("EARLY STARTUP NOTICE", "warning");
      await new Promise(resolve => setTimeout(resolve, 25));
      ctx.ui.notify("DELAYED STARTUP NOTICE", "warning");
    }
    let finish = (): void => {};
    await ctx.ui.custom<void>((host, _theme, _keys, done) => {
      tui = host as Host;
      finish = done;
      return new Text("", 0, 0);
    }, { overlay: true, overlayOptions: { visible: () => false, nonCapturing: true }, onHandle: () => finish() });
  });
  pi.on("before_agent_start", (_event, ctx) => {
    ctx.ui.notify("OPERATIONAL NOTICE", "warning");
  });
  pi.on("agent_before_settle", async (_event, ctx) => {
    await emittedFrame(tui, () => tui.requestRender(true));
    const panes: Record<string, string[]> = {};
    const seen = new Set<Component>();
    const visit = (component: Component): void => {
      if (seen.has(component)) return;
      seen.add(component);
      if (component.constructor.name === "NativeDocument") {
        const document = component as Component & { pane: string; beginFrame(): void };
        document.beginFrame();
        panes[document.pane] = document.render(100);
        return;
      }
      const owner = component as Component & { children?: Component[]; child?: Component };
      for (const child of owner.children ?? []) visit(child);
      if (owner.child) visit(owner.child);
    };
    visit(tui.layoutRoot);
    await writeFile(process.env.STARTUP_ROUTING_FILE ?? path.join(ctx.cwd, "startup-routing.json"), JSON.stringify({ panes, screen: tui.getScreenLines() }));
  });
}
