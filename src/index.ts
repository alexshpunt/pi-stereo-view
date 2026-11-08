import path from "node:path";
import { copyToClipboard, getAgentDir, getSettingsListTheme, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Box, Container, isKeyRelease, matchesKey, SettingsList, Text, type OverlayHandle, type TUI, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { TranscriptLayout } from "./layout.js";
import { TOOL_START_ENTRY, TranscriptTimestamps } from "./timestamps.js";
import { defaults, loadPreferences, savePreferences, type Preferences } from "./preferences.js";
import { beforeFirstFrame } from "./startup.js";
import { observeNativeEditor } from "./native-editor.js";
import { NestedCalls } from "./nested-calls.js";

/** Split native fullscreen history without changing message content or the input dock. */
export default async function transcript(pi: ExtensionAPI): Promise<void> {
  let layout: TranscriptLayout | undefined;
  let host: TUI | undefined;
  let timestamps: TranscriptTimestamps | undefined;
  const nested = new NestedCalls();
  const nativeEditor = observeNativeEditor();
  let unsubscribeInput: (() => void) | undefined;
  let writes = Promise.resolve();
  let preferences: Preferences = { ...defaults };
  const file = path.join(getAgentDir(), "transcript.json");
  let preferenceWarning: string | undefined;
  const readPreferences = async (): Promise<void> => {
    try { preferences = await loadPreferences(file); }
    catch (error) {
      preferences = { ...defaults };
      preferenceWarning = "Could not read pi-stereo-view preferences; using defaults: " + String(error);
    }
  };
  await readPreferences();

  let settingsOpen = false;
  const closeSearch = (): void => { layout?.closeSearch(false); };

  const openSettings = async (ui: ExtensionContext["ui"]): Promise<void> => {
    if (settingsOpen) return;
    settingsOpen = true;
    closeSearch();
    try {
      let overlay: OverlayHandle | undefined;
      await ui.custom<void>((tui, _theme, _keys, done) => {
        // Pi dispatches outside clicks to the underlying layout, not the overlay.
        const viewport = tui as unknown as { dispatchMouseToOverlay?: (event: TuiMouseEvent) => { hit: boolean } };
        const dispatch = viewport.dispatchMouseToOverlay;
        const ownDispatch = Object.hasOwn(viewport, "dispatchMouseToOverlay");
        const dismissOutside = dispatch && function (event: TuiMouseEvent): { hit: boolean } {
          const result = dispatch.call(viewport, event);
          if (!result.hit && event.type === "press" && event.button === "left" && overlay?.isFocused()) {
            done();
            return { hit: true };
          }
          return result;
        };
        if (dismissOutside) viewport.dispatchMouseToOverlay = dismissOutside;
        const list = new SettingsList([{
          id: "timestamps", label: "Show timestamps",
          description: "Hide clock rows without changing messages or recorded tool starts.",
          currentValue: preferences.showTimestamps ? "on" : "off", values: ["on", "off"],
        }, {
          id: "copyButtons", label: "Show copy buttons",
          description: "Hide copy buttons and their rows; keyboard copying stays available.",
          currentValue: preferences.showCopyButtons ? "on" : "off", values: ["on", "off"],
        }, {
          id: "buttonStyle", label: "Button style",
          description: "Choose icons or text for toolbar, panel and copy controls.",
          currentValue: preferences.buttonStyle, values: ["icons", "text"],
        }, {
          id: "compactTools", label: "Compact Activity tools",
          description: "Group adjacent tools and expand individual calls inline. Full text stays searchable and copyable.",
          currentValue: preferences.compactTools ? "on" : "off", values: ["on", "off"],
        }, {
          id: "height", label: "Conversation height",
          description: "Auto grows to half the history area. Drag sets a manual maximum.",
          currentValue: preferences.chatHeight === null ? "auto" : "manual", values: ["auto", "manual"],
        }], 5, getSettingsListTheme(), (id, value) => {
          if (id === "timestamps") layout?.setTimestamps(value === "on");
          else if (id === "copyButtons") layout?.setCopyButtons(value === "on");
          else if (id === "buttonStyle") layout?.setButtonStyle(value === "text" ? "text" : "icons");
          else if (id === "compactTools") layout?.setCompactTools(value === "on");
          else if (id === "height") layout?.setAutomaticHeight(value === "auto");
          tui.requestRender();
        }, () => done());
        const content = new Container();
        content.addChild({
          render: () => [ui.theme.fg("accent", ui.theme.bold("pi-stereo-view settings")), ""],
          invalidate() {},
        });
        content.addChild(list);
        const box = new Box(1, 1, text => ui.theme.bg("customMessageBg", text));
        box.addChild(content);
        return {
          render: (width: number) => box.render(width),
          invalidate: () => box.invalidate(),
          handleMouse: (event) => box.handleMouse(event),
          dispose: () => {
            if (viewport.dispatchMouseToOverlay === dismissOutside) {
              if (ownDispatch) viewport.dispatchMouseToOverlay = dispatch;
              else delete viewport.dispatchMouseToOverlay;
            }
          },
          handleInput: (data: string) => {
            list.handleInput(data);
            tui.requestRender();
          },
        };
      }, { overlay: true, overlayOptions: { width: 60, margin: 1 }, onHandle: handle => { overlay = handle; } });
    } finally {
      settingsOpen = false;
    }
    await writes;
  };

  const ensureLayout = (): void => {
    if (host) layout?.attach(host);
  };
  const persist = (ui: ExtensionContext["ui"]): void => {
    const snapshot = { ...preferences };
    writes = writes.then(() => savePreferences(file, snapshot)).catch(error => {
      ui.notify("Could not save pi-stereo-view preferences: " + String(error), "error");
    });
  };

  const createLayout = (tui: TUI, ui: ExtensionContext["ui"], session: ExtensionContext["sessionManager"]): void => {
    host = tui;
    timestamps = new TranscriptTimestamps(session);
    nested.restore(session.getBranch());
    layout = new TranscriptLayout(preferences, () => ui.theme,
      message => ui.notify(message, "warning"), () => persist(ui), timestamps,
      () => { void openSettings(ui).catch(error => ui.notify(String(error), "error")); }, text => {
        if (text === undefined) {
          ui.notify("This block is no longer in the current history.", "warning");
          return;
        }
        if (!text) {
          ui.notify("This block has no text to copy.", "info");
          return;
        }
        void copyToClipboard(text).then(() => ui.notify("Block sent to clipboard.", "info"),
          error => ui.notify("Could not copy block: " + String(error), "error"));
      }, () => pi.getAllTools(), nested, () => nativeEditor.get(tui));
    try { ensureLayout(); }
    catch (error) {
      layout.dispose();
      layout = undefined;
      host = undefined;
      timestamps = undefined;
      throw error;
    }
  };
  let earlySession: string | undefined;
  const releaseStartup = beforeFirstFrame((tui, ui, session) => {
    earlySession = session.getSessionId();
    createLayout(tui, ui, session);
    const mounted = layout;
    return () => { mounted?.dispose(); };
  });

  pi.on("session_start", async (event, ctx) => {
    releaseStartup();
    if (ctx.mode !== "tui") return;
    const early = event.reason === "startup" && earlySession === ctx.sessionManager.getSessionId() && layout !== undefined;
    earlySession = undefined;
    if (!early) {
      closeSearch();
      layout?.dispose();
      unsubscribeInput?.();
      await readPreferences();
    }
    if (preferenceWarning) {
      ctx.ui.notify(preferenceWarning, "warning");
      preferenceWarning = undefined;
    }
    let finish: () => void = () => {};
    await ctx.ui.custom<void>((tui, _theme, _keys, done) => {
      if (early) host = tui;
      else createLayout(tui, ctx.ui, ctx.sessionManager);
      finish = done;
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
    nested.absorb(event.message);
    timestamps?.observe(event.message, true);
    layout?.refreshSearch();
  });
  pi.on("tool_execution_update", () => {
    layout?.refreshSearch();
  });
  pi.on("tool_execution_end", event => {
    nested.end(event);
    layout?.refreshSearch();
    host?.requestRender();
  });
  pi.on("tool_execution_start", event => {
    if (event.parentToolCallId) {
      nested.start(event);
      layout?.refreshSearch();
      host?.requestRender();
      return;
    }
    if (!timestamps) return;
    pi.appendEntry(TOOL_START_ENTRY, { toolCallId: event.toolCallId, time: Date.now() });
    host?.requestRender();
  });
  pi.on("session_tree", (_event, ctx) => { closeSearch(); nested.restore(ctx.sessionManager.getBranch()); timestamps?.reset(); host?.requestRender(); });
  pi.on("session_compact", (_event, ctx) => { closeSearch(); nested.restore(ctx.sessionManager.getBranch()); timestamps?.reset(); host?.requestRender(); });
  pi.on("session_shutdown", async () => {
    releaseStartup();
    nativeEditor.dispose();
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
    description: "History: copy, settings, toggle, swap, layout <columns|rows>, zoom <chat|activity>, width, height, scroll",
    handler: async (args, ctx) => {
      if (ctx.mode !== "tui" || !layout) {
        ctx.ui.notify("pi-stereo-view layout is available only in interactive Pi.", "warning");
        return;
      }
      const [action = "toggle", target, amount] = args.trim().split(/\s+/);
      if (action === "toggle" || action === "") toggle();
      else if (action === "settings") await openSettings(ctx.ui);
      else if (action === "copy") {
        const blocks = layout.copyBlocks();
        if (!blocks.length) {
          ctx.ui.notify("No blocks to copy in the active split panel.", "info");
          return;
        }
        closeSearch();
        const choice = await ctx.ui.select("Copy a block from the active panel", blocks.map(block => block.label));
        blocks.find(block => block.label === choice)?.copy();
      } else if (action === "help") {
        ctx.ui.notify("pi-stereo-view: choose icon or text buttons in /stereo-view settings. Buttons: ▣/Join combines history, ◫/Open splits it, ▤/Rows and ▥/Cols change layout, ↕/↔/Swap exchanges panels, ↗/Max and ↙/Out zoom and restore, ⌕/Find searches, ⊟/Few and ⊞/All toggle compact tools, ≡/Menu opens settings, ⧉/Copy copies a block. /stereo-view copy chooses a block with the keyboard. Ctrl+F searches and PgUp/PgDn scroll the active panel; Ctrl+Alt+Up/Down switches it. Drag the ═ or ║ divider to resize.", "info");
      } else if (action === "swap") layout.swap();
      else if (action === "width" && /^\d+$/.test(target ?? "")) layout.setWidth(Number(target));
      else if (action === "height" && target === "auto") layout.setHeight(null);
      else if (action === "height" && /^\d+$/.test(target ?? "")) layout.setHeight(Number(target));
      else if (action === "layout" && (target === "columns" || target === "rows")) layout.setLayout(target);
      else if (action === "zoom" && (target === "chat" || target === "activity")) layout.maximize(target);
      else if (action === "scroll" && (target === "chat" || target === "activity") && /^-?\d+$/.test(amount ?? "")) {
        layout.scroll(target, Number(amount));
      } else {
        ctx.ui.notify("Use /stereo-view [copy|help|settings|toggle|swap|layout <columns|rows>|zoom <chat|activity>|width <columns>|height <rows|auto>|scroll <chat|activity> <lines>]", "warning");
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
