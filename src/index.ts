import path from "node:path";
import { getAgentDir, getSettingsListTheme, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Box, Container, isKeyRelease, matchesKey, SettingsList, Text, type TUI } from "@earendil-works/pi-tui";
import { PanelSearch, type SearchHit } from "./search.js";
import type { Pane } from "./native.js";
import { TranscriptLayout } from "./layout.js";
import { TOOL_START_ENTRY, TranscriptTimestamps } from "./timestamps.js";
import { defaults, loadPreferences, savePreferences, type Preferences } from "./preferences.js";

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
  let searchGeneration = 0;
  let cancelSearch: (() => void) | undefined;
  let searchTask: Promise<void> | undefined;

  const closeSearch = (): void => {
    searchGeneration++;
    cancelSearch?.();
    cancelSearch = undefined;
  };

  const openSearch = async (ctx: ExtensionContext, pane: Pane): Promise<void> => {
    if (settingsOpen || !layout?.searchPane()) return;
    closeSearch();
    const generation = searchGeneration;
    await searchTask?.catch(() => {});
    if (generation !== searchGeneration || !layout?.searchPane()) return;
    const task = (async () => {
      const hit = await ctx.ui.custom<SearchHit | undefined>((tui, _theme, _keys, done) => {
        cancelSearch = () => done(undefined);
        return new PanelSearch("Search " + (pane === "chat" ? "Conversation" : "Activity"),
          () => layout?.searchEntries(pane) ?? [], tui, ctx.ui.theme, done);
      }, { overlay: true, overlayOptions: () => ({ width: Math.min(110, Math.floor((host?.terminal.columns ?? 80) * 0.8)), margin: 1 }) });
      if (generation !== searchGeneration) return;
      cancelSearch = undefined;
      if (hit) await layout?.jumpToSearch(pane, hit);
    })();
    searchTask = task;
    try { await task; }
    finally {
      if (searchTask === task) searchTask = undefined;
      if (generation === searchGeneration) cancelSearch = undefined;
    }
  };

  const openSettings = async (ctx: ExtensionContext): Promise<void> => {
    if (settingsOpen) return;
    settingsOpen = true;
    closeSearch();
    try {
      await searchTask?.catch(() => {});
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
          render: () => [ctx.ui.theme.fg("accent", ctx.ui.theme.bold("Transcript settings")), ""],
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
      ctx.ui.notify("Could not save transcript preferences: " + String(error), "error");
    });
  };

  pi.on("session_start", async (_event, ctx) => {
    if (ctx.mode !== "tui") return;
    closeSearch();
    layout?.dispose();
    unsubscribeInput?.();
    timestamps = new TranscriptTimestamps(ctx.sessionManager);
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
        message => ctx.ui.notify(message, "warning"), () => persist(ctx), timestamps!,
        () => { void openSettings(ctx).catch(error => ctx.ui.notify(String(error), "error")); },
        pane => { void openSearch(ctx, pane).catch(error => ctx.ui.notify(String(error), "error")); });
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
        if (!isKeyRelease(data) && !cancelSearch) {
          void openSearch(ctx, pane).catch(error => ctx.ui.notify(String(error), "error"));
        }
        return { consume: true };
      }
      return undefined;
    });
  });
  pi.on("message_start", event => timestamps?.observe(event.message));
  pi.on("message_update", event => {
    timestamps?.observe(event.message);
    ensureLayout();
  });
  pi.on("message_end", event => timestamps?.observe(event.message, true));
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
  pi.registerCommand("transcript", {
    description: "History: settings, toggle, swap, layout <columns|rows>, zoom <chat|activity>, width, height, scroll",
    handler: async (args, ctx) => {
      if (ctx.mode !== "tui" || !layout) {
        ctx.ui.notify("Transcript layout is available only in interactive Pi.", "warning");
        return;
      }
      const [action = "toggle", target, amount] = args.trim().split(/\s+/);
      if (action === "toggle" || action === "") toggle();
      else if (action === "settings") await openSettings(ctx);
      else if (action === "help") {
        ctx.ui.notify("Transcript icons: ▣ combined, ◫ split, ▤ rows, ▥ columns, ↕/↔ swap, ↗ expand, ↙ restore, ⌕ search, ≡ settings. Ctrl+F searches the active panel. Drag the ═ or ║ divider to resize.", "info");
      } else if (action === "swap") layout.swap();
      else if (action === "width" && /^\d+$/.test(target ?? "")) layout.setWidth(Number(target));
      else if (action === "height" && target === "auto") layout.setHeight(null);
      else if (action === "height" && /^\d+$/.test(target ?? "")) layout.setHeight(Number(target));
      else if (action === "layout" && (target === "columns" || target === "rows")) layout.setLayout(target);
      else if (action === "zoom" && (target === "chat" || target === "activity")) layout.maximize(target);
      else if (action === "scroll" && (target === "chat" || target === "activity") && /^-?\d+$/.test(amount ?? "")) {
        layout.scroll(target, Number(amount));
      } else {
        ctx.ui.notify("Use /transcript [help|settings|toggle|swap|layout <columns|rows>|zoom <chat|activity>|width <columns>|height <rows|auto>|scroll <chat|activity> <lines>]", "warning");
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
