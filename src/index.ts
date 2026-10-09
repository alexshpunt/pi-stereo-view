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
    if (host) layout?.attach(host);
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
    ensureLayout();
  };
  pi.registerCommand("transcript", {
    description: "History: toggle, swap, layout <columns|rows>, zoom <chat|activity>, width, height, scroll",
    handler: async (args, ctx) => {
      if (ctx.mode !== "tui" || !layout) {
        ctx.ui.notify("Transcript layout is available only in interactive Pi.", "warning");
        return;
      }
      const [action = "toggle", target, amount] = args.trim().split(/\s+/);
      if (action === "toggle" || action === "") toggle();
      else if (action === "help") {
        ctx.ui.notify("Transcript icons: ▣ combined, ◫ split, ▤ rows, ▥ columns, ↕/↔ swap, ↗ expand, ↙ restore. Drag the ═ or ║ divider to resize.", "info");
      } else if (action === "swap") layout.swap();
      else if (action === "width" && /^\d+$/.test(target ?? "")) layout.setWidth(Number(target));
      else if (action === "height" && /^\d+$/.test(target ?? "")) layout.setHeight(Number(target));
      else if (action === "layout" && (target === "columns" || target === "rows")) layout.setLayout(target);
      else if (action === "zoom" && (target === "chat" || target === "activity")) layout.maximize(target);
      else if (action === "scroll" && (target === "chat" || target === "activity") && /^-?\d+$/.test(amount ?? "")) {
        layout.scroll(target, Number(amount));
      } else {
        ctx.ui.notify("Use /transcript [help|toggle|swap|layout <columns|rows>|zoom <chat|activity>|width <columns>|height <rows>|scroll <chat|activity> <lines>]", "warning");
        return;
      }
      ensureLayout();
      await writes;
    },
  });
  pi.registerShortcut("ctrl+alt+t", { description: "Toggle split history", handler: async () => toggle() });
  pi.registerShortcut("ctrl+alt+s", { description: "Swap transcript panels", handler: async () => layout?.swap() });
  pi.registerShortcut("ctrl+alt+left", { description: "Shrink conversation along the split axis", handler: async () => {
    layout?.resize(-1);
  } });
  pi.registerShortcut("ctrl+alt+right", { description: "Grow conversation along the split axis", handler: async () => {
    layout?.resize(1);
  } });
}
