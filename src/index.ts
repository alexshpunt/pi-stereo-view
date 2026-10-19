import path from "node:path";
import { getAgentDir, getSettingsListTheme, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Box, Container, isKeyRelease, matchesKey, SettingsList, Text, type TUI } from "@earendil-works/pi-tui";
import { TranscriptLayout } from "./layout.js";
import { TOOL_START_ENTRY, TranscriptTimestamps } from "./timestamps.js";
import { defaults, loadPreferences, savePreferences, type Preferences } from "./preferences.js";
import { StartupNotices } from "./startup-notices.js";

/** Split native fullscreen history without changing message content or the input dock. */
export default function transcript(pi: ExtensionAPI): void {
  let layout: TranscriptLayout | undefined;
  let host: TUI | undefined;
  let timestamps: TranscriptTimestamps | undefined;
  let unsubscribeInput: (() => void) | undefined;
  let writes = Promise.resolve();
  let preferences: Preferences = { ...defaults };
  const file = path.join(getAgentDir(), "transcript.json");

  let settingsOpen = false;
  const closeSearch = (): void => { layout?.closeSearch(false); };

  const openSettings = async (ctx: ExtensionContext): Promise<void> => {
    if (settingsOpen) return;
    settingsOpen = true;
    closeSearch();
    try {
      await ctx.ui.custom<void>((tui, _theme, _keys, done) => {
        const list = new SettingsList([{
          id: "timestamps", label: "Show timestamps",
          description: "Hide clock rows without changing messages or recorded tool starts.",
          currentValue: preferences.showTimestamps ? "on" : "off", values: ["on", "off"],
        }, {
          id: "height", label: "Conversation height",
          description: "Auto grows to half the history area. Drag sets a manual maximum.",
          currentValue: preferences.chatHeight === null ? "auto" : "manual", values: ["auto", "manual"],
        }], 3, getSettingsListTheme(), (id, value) => {
          if (id === "timestamps") layout?.setTimestamps(value === "on");
          else if (id === "height") layout?.setAutomaticHeight(value === "auto");
          tui.requestRender();
        }, () => done());
        const content = new Container();
        content.addChild({
          render: () => [ctx.ui.theme.fg("accent", ctx.ui.theme.bold("pi-stereo-view settings")), ""],
          invalidate() {},
        });
        content.addChild(list);
        const box = new Box(1, 1, text => ctx.ui.theme.bg("customMessageBg", text));
        box.addChild(content);
        return {
          render: (width: number) => box.render(width),
          invalidate: () => box.invalidate(),
          handleMouse: (event) => box.handleMouse(event),
          handleInput: (data: string) => {
            list.handleInput(data);
            tui.requestRender();
          },
        };
      }, { overlay: true, overlayOptions: { width: 60, margin: 1 } });
    } finally {
      settingsOpen = false;
    }
    await writes;
  };

  const ensureLayout = (): void => {
    if (host) layout?.attach(host);
  };
  const persist = (ctx: ExtensionContext): void => {
    const snapshot = { ...preferences };
    writes = writes.then(() => savePreferences(file, snapshot)).catch(error => {
      ctx.ui.notify("Could not save pi-stereo-view preferences: " + String(error), "error");
    });
  };

  pi.on("session_start", async (event, ctx) => {
    if (ctx.mode !== "tui") return;
    closeSearch();
    layout?.dispose();
    unsubscribeInput?.();
    timestamps = new TranscriptTimestamps(ctx.sessionManager);
    try {
      preferences = await loadPreferences(file);
    } catch (error) {
      ctx.ui.notify("Could not read pi-stereo-view preferences; using defaults: " + String(error), "warning");
      preferences = { ...defaults };
    }
    let finish: () => void = () => {};
    await ctx.ui.custom<void>((tui, _theme, _keys, done) => {
      host = tui;
      finish = done;
      layout = new TranscriptLayout(preferences, () => ctx.ui.theme,
        message => ctx.ui.notify(message, "warning"), () => persist(ctx), timestamps!,
        () => { void openSettings(ctx).catch(error => ctx.ui.notify(String(error), "error")); },
        new StartupNotices(event.reason === "startup"));
      ensureLayout();
      return new Text("", 0, 0);
    }, {
      overlay: true,
      overlayOptions: { visible: () => false, nonCapturing: true },
      onHandle: () => finish(),
    });
    unsubscribeInput = ctx.ui.onTerminalInput(data => {
      ensureLayout();
      const pane = layout?.searchPane();
      if (pane && !settingsOpen && matchesKey(data, "ctrl+f")) {
        if (isKeyRelease(data) || layout?.openSearch(pane)) return { consume: true };
      }
      return undefined;
    });
  });
  pi.on("resources_discover", () => {
    layout?.finishStartup();
  });
  pi.on("message_start", event => {
    timestamps?.observe(event.message);
    layout?.refreshSearch();
  });
  pi.on("message_update", event => {
    timestamps?.observe(event.message);
    layout?.refreshSearch();
    ensureLayout();
  });
  pi.on("message_end", event => {
    timestamps?.observe(event.message, true);
    layout?.refreshSearch();
  });
  pi.on("tool_execution_update", () => layout?.refreshSearch());
  pi.on("tool_execution_end", () => layout?.refreshSearch());
  pi.on("tool_execution_start", event => {
    if (!timestamps || event.parentToolCallId) return;
    pi.appendEntry(TOOL_START_ENTRY, { toolCallId: event.toolCallId, time: Date.now() });
    host?.requestRender();
  });
  pi.on("session_tree", () => { closeSearch(); timestamps?.reset(); });
  pi.on("session_compact", () => { closeSearch(); timestamps?.reset(); });
  pi.on("session_shutdown", async () => {
    closeSearch();
    unsubscribeInput?.();
    unsubscribeInput = undefined;
    layout?.dispose();
    layout = undefined;
    timestamps = undefined;
    host = undefined;
    await writes;
  });

  const toggle = (): void => {
    layout?.toggle();
    ensureLayout();
  };
  pi.registerCommand("stereo-view", {
    description: "History: settings, toggle, swap, layout <columns|rows>, zoom <chat|activity>, width, height, scroll",
    handler: async (args, ctx) => {
      if (ctx.mode !== "tui" || !layout) {
        ctx.ui.notify("pi-stereo-view layout is available only in interactive Pi.", "warning");
        return;
      }
      const [action = "toggle", target, amount] = args.trim().split(/\s+/);
      if (action === "toggle" || action === "") toggle();
      else if (action === "settings") await openSettings(ctx);
      else if (action === "help") {
        ctx.ui.notify("pi-stereo-view icons: ▣ combined, ◫ split, ▤ rows, ▥ columns, ↕/↔ swap, ↗ expand, ↙ restore, ⌕ search, ≡ settings. Ctrl+F searches and PgUp/PgDn scroll the active panel; Ctrl+Alt+Up/Down switches it. Drag the ═ or ║ divider to resize.", "info");
      } else if (action === "swap") layout.swap();
      else if (action === "width" && /^\d+$/.test(target ?? "")) layout.setWidth(Number(target));
      else if (action === "height" && target === "auto") layout.setHeight(null);
      else if (action === "height" && /^\d+$/.test(target ?? "")) layout.setHeight(Number(target));
      else if (action === "layout" && (target === "columns" || target === "rows")) layout.setLayout(target);
      else if (action === "zoom" && (target === "chat" || target === "activity")) layout.maximize(target);
      else if (action === "scroll" && (target === "chat" || target === "activity") && /^-?\d+$/.test(amount ?? "")) {
        layout.scroll(target, Number(amount));
      } else {
        ctx.ui.notify("Use /stereo-view [help|settings|toggle|swap|layout <columns|rows>|zoom <chat|activity>|width <columns>|height <rows|auto>|scroll <chat|activity> <lines>]", "warning");
        return;
      }
      ensureLayout();
      await writes;
    },
  });
  pi.registerShortcut("ctrl+alt+t", { description: "Toggle split history", handler: async () => toggle() });
  pi.registerShortcut("ctrl+alt+s", { description: "Swap stereo-view panels", handler: async () => layout?.swap() });
  for (const key of ["ctrl+alt+up", "ctrl+alt+down"] as const) {
    pi.registerShortcut(key, { description: "Move keyboard scrolling to the other stereo-view panel", handler: async () => {
      layout?.cyclePanel();
    } });
  }
  pi.registerShortcut("ctrl+alt+left", { description: "Shrink conversation along the split axis", handler: async () => {
    layout?.resize(-1);
  } });
  pi.registerShortcut("ctrl+alt+right", { description: "Grow conversation along the split axis", handler: async () => {
    layout?.resize(1);
  } });
}
