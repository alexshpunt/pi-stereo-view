import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { setImmediate } from "node:timers/promises";
import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, Text, type TUI } from "@earendil-works/pi-tui";

type TestHost = TUI & {
  getScreenLines?(): string[];
  handleTerminalInput(data: string): void;
  copyTextToClipboard(text: string): Promise<boolean>;
  copyActiveSelectionToClipboard(): Promise<boolean>;
  resetTextSelection(): void;
};

/** Drive native input and observe the actual loaded Pi tree, not a test renderer. */
export default function nativeProbe(pi: ExtensionAPI): void {
  let tui: TestHost | undefined;
  const streamingFrames: { idle: boolean; lines: string[] }[] = [];
  let streamStep = 0;
  let streamingCapture = Promise.resolve();
  const capture = async (): Promise<string[]> => {
    tui!.requestRender(true);
    await setImmediate();
    return tui!.getScreenLines?.() ?? tui!.render(tui!.terminal.columns);
  };
  pi.on("message_update", (event, ctx) => {
    if (!tui || process.env.TRANSCRIPT_PROBE_DYNAMIC !== "1" ||
        event.assistantMessageEvent.type !== "text_delta" || streamStep >= 4) return;
    const keys = ["\x1b[116;7u", "\x1b[116;7u", "\x1b[115;7u", "\x1b[1;7C"];
    const key = keys[streamStep++];
    streamingCapture = streamingCapture.then(async () => {
      tui!.handleTerminalInput(key);
      streamingFrames.push({ idle: ctx.isIdle(), lines: await capture() });
    });
  });
  pi.registerToolRenderer((name, next) => name === "write" ? {
    renderCall: () => new Text("NATIVE CALL MARKER", 0, 0),
    renderResult: (_result, options) => new Text("NATIVE RESULT MARKER " + (options.expanded ? "expanded" : "collapsed"), 0, 0),
  } : next());
  pi.on("session_start", async (_event, ctx) => {
    if (ctx.mode !== "tui") return;
    let finish: () => void = () => {};
    await ctx.ui.custom<void>((host, _theme, _keys, done) => {
      tui = host as TestHost;
      finish = done;
      return new Text("", 0, 0);
    }, {
      overlay: true,
      overlayOptions: { visible: () => false, nonCapturing: true },
      onHandle: () => finish(),
    });
  });
  // The scripted test builder has no thinking block; add one through Pi's real
  // finalized-message transform so the native component receives mixed content.
  pi.on("message_end", event => {
    if (event.message.role !== "assistant") return;
    return { message: {
      ...event.message,
      content: [{ type: "thinking", thinking: "THINKING MARKER" }, ...event.message.content],
    } };
  });
  pi.on("agent_before_settle", async (_event, ctx) => {
    if (!tui) return;
    await streamingCapture;
    if (process.env.TRANSCRIPT_PROBE_DYNAMIC === "1") {
      const columns = process.stdout.columns;
      const widthFrames: string[][] = [await capture()];
      try {
        // ProcessTerminal reads this property and listens to the native resize event.
        process.stdout.columns = 40;
        process.stdout.emit("resize");
        widthFrames.push(await capture());
        process.stdout.columns = columns;
        process.stdout.emit("resize");
        widthFrames.push(await capture());
      } finally {
        process.stdout.columns = columns;
        process.stdout.emit("resize");
      }
      const modeFrames: { mode: string; lines: string[] }[] = [];
      for (let change = 0; change < 2; change++) {
        for (const character of "/settings") tui.handleTerminalInput(character);
        tui.handleTerminalInput("\r");
        await setImmediate();
        for (const character of "TUI mode") tui.handleTerminalInput(character);
        tui.handleTerminalInput("\r");
        tui.handleTerminalInput("\x1b");
        tui.handleTerminalInput("\x1b[D");
        modeFrames.push({ mode: tui.mode, lines: await capture() });
      }
      await writeFile(path.join(ctx.cwd, "dynamic-observation.json"), JSON.stringify({ streamingFrames, widthFrames, modeFrames }));
    }
    const initial = await capture();
    await writeFile(path.join(ctx.cwd, "native-snapshot.json"), JSON.stringify(initial));
    const sessionFile = ctx.sessionManager.getSessionFile();
    if (process.env.TRANSCRIPT_PROBE_SELECTION === "1") {
      const copied: string[] = [];
      const copy = tui.copyTextToClipboard;
      tui.copyTextToClipboard = async value => { copied.push(value); return true; };
      try {
        for (const marker of ["CHAT_COPY_MARKER", "NATIVE CALL MARKER"]) {
          const frame = (await capture()).map(stripTerminalSequences);
          const row = frame.findIndex(line => line.includes(marker));
          if (row < 0) throw new Error("Selection marker is not visible: " + marker);
          const column = frame[row].indexOf(marker);
          const mouse = async (button: number, x: number, suffix = "M") => {
            tui!.handleTerminalInput(`\x1b[<${button};${x + 1};${row + 1}${suffix}`);
            await setImmediate();
          };
          await mouse(0, column);
          await mouse(32, column + marker.length - 1);
          await mouse(0, column + marker.length - 1, "m");
          await tui.copyActiveSelectionToClipboard();
          tui.resetTextSelection();
        }
        const beforeWheel = await capture();
        tui.handleTerminalInput("\x1b[<64;2;5M");
        await setImmediate();
        const activityWheel = await capture();
        tui.handleTerminalInput("\x1b[<64;90;5M");
        await setImmediate();
        const chatWheel = await capture();
        await writeFile(path.join(ctx.cwd, "selection-observation.json"), JSON.stringify({ copied, beforeWheel, activityWheel, chatWheel }));
      } finally {
        tui.copyTextToClipboard = copy;
      }
    }
    const recorded = path.join(ctx.cwd, "recorded-session.jsonl");
    if (sessionFile && sessionFile !== recorded) {
      await writeFile(recorded, await readFile(sessionFile, "utf8"));
    }
    if (process.env.TRANSCRIPT_PROBE_CONTROLS === "1") {
      const frames: string[][] = [initial];
      const keys = [
        "\x1b[115;7u", // swap: ctrl+alt+s
        "\x1b[<0;41;2M", "\x1b[<32;33;2M", "\x1b[<0;33;2m", // drag to 32 columns
        "\x1b[1;7C", // widen by four
        "\x1b[116;7u", "\x1b[116;7u", // combined, then split
        "\x0f", "\x14", "\x14", // native expansion and thinking
      ];
      for (const key of keys) {
        tui.handleTerminalInput(key);
        await setImmediate();
        frames.push(await capture());
      }
      await writeFile(path.join(ctx.cwd, "control-frames.json"), JSON.stringify(frames));
    }
    if (process.env.TRANSCRIPT_PROBE_CONTROLS === "1") {
      await writeFile(path.join(ctx.cwd, "saved-preferences.json"), await readFile(path.join(getAgentDir(), "transcript.json"), "utf8"));
    }
  });
}
