import path from "node:path";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text, type TUI } from "@earendil-works/pi-tui";
import { TranscriptLayout } from "./layout.js";
import { defaults, loadPreferences, savePreferences, type Preferences } from "./preferences.js";

/** Split native fullscreen history without changing session data or the input dock. */
export default function transcript(pi: ExtensionAPI): void {
  let layout: TranscriptLayout | undefined;
  let host: TUI | undefined;
  let unsubscribeInput: (() => void) | undefined;
  let writes = Promise.resolve();
  let preferences: Preferences = { ...defaults };
  const file = path.join(getAgentDir(), "transcript.json");

  const ensureLayout = (): void => {
    if (host && preferences.mode === "split") layout?.attach(host);
  };
  const persist = (ctx: ExtensionContext): void => {
    const snapshot = { ...preferences };
    writes = writes.then(() => savePreferences(file, snapshot)).catch(error => {
      ctx.ui.notify("Could not save transcript preferences: " + String(error), "error");
    });
  };

  pi.on("session_start", async (_event, ctx) => {
    if (ctx.mode !== "tui") return;
    layout?.dispose();
    unsubscribeInput?.();
    try {
      preferences = await loadPreferences(file);
    } catch (error) {
      ctx.ui.notify("Could not read transcript preferences; using defaults: " + String(error), "warning");
      preferences = { ...defaults };
    }
    let finish: () => void = () => {};
    await ctx.ui.custom<void>((tui, _theme, _keys, done) => {
      host = tui;
      finish = done;
      layout = new TranscriptLayout(preferences, () => ctx.ui.theme,
        message => ctx.ui.notify(message, "warning"), () => persist(ctx));
      ensureLayout();
      return new Text("", 0, 0);
    }, {
      overlay: true,
      overlayOptions: { visible: () => false, nonCapturing: true },
      onHandle: () => finish(),
    });
    unsubscribeInput = ctx.ui.onTerminalInput(() => {
      ensureLayout();
      return undefined;
    });
  });
  pi.on("message_update", () => ensureLayout());
  pi.on("session_shutdown", async () => {
    unsubscribeInput?.();
    unsubscribeInput = undefined;
    layout?.dispose();
    layout = undefined;
    host = undefined;
    await writes;
  });

  const toggle = (): void => {
    layout?.toggle();
    if (preferences.mode === "combined") layout?.dispose();
    else ensureLayout();
  };
  pi.registerCommand("transcript", {
    description: "Split history: toggle, swap, width <columns>, scroll <chat|activity> <lines>",
    handler: async (args, ctx) => {
      if (ctx.mode !== "tui" || !layout) {
        ctx.ui.notify("Transcript layout is available only in interactive Pi.", "warning");
        return;
      }
      const [action = "toggle", target, amount] = args.trim().split(/\s+/);
      if (action === "toggle" || action === "") toggle();
      else if (action === "swap") layout.swap();
      else if (action === "width" && /^\d+$/.test(target ?? "")) layout.setWidth(Number(target));
      else if (action === "scroll" && (target === "chat" || target === "activity") && /^-?\d+$/.test(amount ?? "")) {
        layout.scroll(target, Number(amount));
      } else {
        ctx.ui.notify("Use /transcript [toggle|swap|width <columns>|scroll <chat|activity> <lines>]", "warning");
        return;
      }
      ensureLayout();
      await writes;
    },
  });
  pi.registerShortcut("ctrl+alt+t", { description: "Toggle split history", handler: async () => toggle() });
  pi.registerShortcut("ctrl+alt+s", { description: "Swap transcript panels", handler: async () => layout?.swap() });
  pi.registerShortcut("ctrl+alt+left", { description: "Narrow conversation panel", handler: async () => {
    layout?.setWidth(preferences.chatWidth - 4);
  } });
  pi.registerShortcut("ctrl+alt+right", { description: "Widen conversation panel", handler: async () => {
    layout?.setWidth(preferences.chatWidth + 4);
  } });
}
