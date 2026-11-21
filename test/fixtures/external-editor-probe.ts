import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { emittedFrame } from "./emitted-frame.ts";
import { captureTui, type TestHost } from "./tui-host.ts";

export default function externalEditorProbe(pi: ExtensionAPI): void {
  let tui: TestHost;
  pi.on("session_start", async (_event, ctx) => { tui = await captureTui(ctx); });
  pi.on("agent_before_settle", async (_event, ctx) => {
    ctx.ui.setEditorText("UNSENT EDITOR DRAFT\nsecond line");
    await emittedFrame(tui, () => tui.requestRender(true));
    // Fullscreen frames use the layout engine; the width-only render runs during stop().
    const render = tui.render;
    let stopped: string[] = [];
    tui.render = width => { stopped = render.call(tui, width); return stopped; };
    try {
      await emittedFrame(tui, () => tui.handleTerminalInput("\x07"),
        () => ctx.ui.getEditorText() === "EDITED PROMPT");
    } finally { tui.render = render; }
    await writeFile(path.join(ctx.cwd, "external-editor-stop.txt"), stopped.map(stripTerminalSequences).join("\n"));
    await writeFile(path.join(ctx.cwd, "external-editor-frame.txt"), tui.getScreenLines().map(stripTerminalSequences).join("\n"));
  });
}
