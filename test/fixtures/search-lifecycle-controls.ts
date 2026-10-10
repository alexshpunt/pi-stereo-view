import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { setImmediate } from "node:timers/promises";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Container, ScrollView, Text, type TUI } from "@earendil-works/pi-tui";

type Host = TUI & { getScreenLines(): string[]; handleTerminalInput(data: string): void; layoutRoot?: Container };
type Observation = { frames: Record<string, string[]>; draft?: string; following?: boolean; streamingIdle?: boolean };

/** Cross real reload, branch navigation and streaming boundaries with a search picker open. */
export default function searchLifecycleControls(pi: ExtensionAPI): void {
  let tui: Host;
  let file: string;
  let observation: Observation = { frames: {} };
  let streaming: Promise<void> | undefined;
  const capture = async (): Promise<string[]> => {
    tui.requestRender(true);
    await setImmediate();
    return tui.getScreenLines();
  };
  const input = async (data: string): Promise<void> => {
    tui.handleTerminalInput(data);
    await setImmediate();
  };
  const save = (): Promise<void> => writeFile(file, JSON.stringify(observation));
  const chatView = (): ScrollView | undefined => {
    const walk = (component: Container): ScrollView | undefined => {
      if (component instanceof ScrollView && Reflect.get(component.children[0], "pane") === "chat") return component;
      for (const child of component.children ?? []) if (child instanceof Container) {
        const found = walk(child);
        if (found) return found;
      }
      return undefined;
    };
    return tui.layoutRoot ? walk(tui.layoutRoot) : undefined;
  };
  pi.on("session_start", async (event, ctx) => {
    file = path.join(ctx.cwd, "search-lifecycle-frames.json");
    let finish = (): void => {};
    await ctx.ui.custom<void>((host, _theme, _keys, done) => {
      tui = host as Host;
      finish = done;
      return new Text("", 0, 0);
    }, { overlay: true, overlayOptions: { visible: () => false, nonCapturing: true }, onHandle: () => finish() });
    if (event.reason !== "reload") return;
    observation = JSON.parse(await readFile(file, "utf8"));
    observation.frames.reloaded = await capture();
    await save();
    void setImmediate().then(async () => {
      await input("/search-branch-check");
      await input("\r");
    });
  });
  pi.registerCommand("search-lifecycle-check", {
    description: "Reload while the search overlay is open",
    handler: async (_args, ctx) => {
      await capture();
      await input("\x06");
      await input("OLD BRANCH ONLY");
      observation.frames.beforeReload = await capture();
      await save();
      await ctx.reload();
    },
  });
  pi.registerCommand("search-branch-check", {
    description: "Change branch with an open picker, then stream a response",
    handler: async (_args, ctx) => {
      await capture();
      await input("\x06");
      await input("OLD BRANCH ONLY");
      observation.frames.beforeBranch = await capture();
      await ctx.navigateTree(process.env.SEARCH_BRANCH_TARGET!, { summarize: false });
      observation.frames.branched = await capture();
      ctx.ui.setEditorText("LIFECYCLE UNSENT DRAFT");
      await input("\x06");
      await input("OLD BRANCH ONLY");
      observation.frames.oldQuery = await capture();
      await input("\x1b");
      await save();
      pi.sendUserMessage("FRESH STREAM USER");
    },
  });
  pi.on("message_update", (event, ctx) => {
    if (streaming || event.assistantMessageEvent.type !== "text_delta") return;
    observation.streamingIdle = ctx.isIdle();
    streaming = setImmediate().then(async () => {
      ctx.ui.setEditorText("LIFECYCLE UNSENT DRAFT");
      await input("\x06");
      await input("BRANCH NEW ANCHOR");
      observation.frames.streamingPicker = await capture();
      await input("\r");
      await capture();
      observation.frames.streamingJump = await capture();
    });
  });
  pi.on("agent_before_settle", async (_event, ctx) => {
    await streaming;
    observation.frames.finished = await capture();
    observation.following = chatView()?.isFollowingEnd;
    await input("\x06");
    await input("STREAM COMPLETE MARKER");
    observation.frames.completeQuery = await capture();
    await input("\x1b");
    observation.draft = ctx.ui.getEditorText();
    await save();
  });
}
