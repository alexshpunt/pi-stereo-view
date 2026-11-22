import path from "node:path";
import { copyToClipboard, getAgentDir, getSettingsListTheme, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Box, Container, isKeyRelease, matchesKey, SettingsList, Text, type OverlayHandle, type SettingItem, type TUI, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { SteadySettings } from "./steady-settings.ts";
import { TranscriptLayout } from "./layout.ts";
import { TOOL_START_ENTRY, TranscriptTimestamps } from "./timestamps.ts";
import { TURN_MIXES, TURN_STRIPES, GO_TO, defaults, loadPreferences, savePreferences, type TurnStripe, type GoTo, type Preferences } from "./preferences.ts";
import { beforeFirstFrame } from "./startup.ts";
import { observeNativeEditor } from "./native-editor.ts";
import { NestedCalls } from "./nested-calls.ts";
import { ProblemReporter } from "./report.ts";

const DELAYS = [1, 2, 3, 5, 10, 30];

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
        const hoverAvailable = layout?.hoverAvailable() ?? false;
        const HOVER_LABEL = "  Highlight on hover";
        const TURNS_HEADER = "Turns";
        const listTheme = getSettingsListTheme();
        // A saved mix outside the offered steps stays selectable until another is chosen.
        const mixSetting = (id: "turnClockMix" | "turnStripeMix" | "turnBackgroundMix" | "turnHoverMix", label: string, description: string) => ({
          id, label, description, currentValue: `${preferences[id]}%`,
          values: [...new Set([...TURN_MIXES, preferences[id]])].sort((a, b) => a - b).map(percent => `${percent}%`),
        });
        const items: SettingItem[] = [{
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
          description: "Show each finished call as one row that opens its full card. Full text stays searchable and copyable.",
          currentValue: preferences.compactTools ? "on" : "off", values: ["on", "off"],
        }, {
          id: "groupTools", label: "Group Activity tools",
          description: "Merge adjacent calls of the same tool and state under one counted header.",
          currentValue: preferences.groupTools ? "on" : "off", values: ["on", "off"],
        }, {
          id: "nestedTree", label: "Nested call tree",
          description: "Show the calls a tool makes, such as Codemode's, as a tree. Off keeps the tool's own output panel.",
          currentValue: preferences.nestedTree ? "on" : "off", values: ["on", "off"],
        }, {
          id: "streamTools", label: "Stream latest tools",
          description: "While compact or grouped, show new tool calls in full and collapse them after the delay.",
          currentValue: preferences.streamTools ? "on" : "off", values: ["on", "off"],
        }, {
          id: "streamDelay", label: "Collapse delay",
          description: "How long a finished streamed tool call stays fully visible before it collapses.",
          currentValue: `${preferences.streamDelay}s`, values: [...new Set([...DELAYS, preferences.streamDelay])].sort((a, b) => a - b).map(seconds => `${seconds}s`),
        }, {
          id: "height", label: "Conversation height",
          description: "Auto grows to half the history area. Drag sets a manual maximum.",
          currentValue: preferences.chatHeight === null ? "auto" : "manual", values: ["auto", "manual"],
        }, {
          // The Turns header switches the whole feature; its settings sit indented under it and keep their values while it is off.
          id: "turns", label: TURNS_HEADER,
          description: "A turn is one request, yours or an extension's, with all the work that answers it. On colors each turn alike in both panels, highlights it on hover and links the panels with Go to, as the settings below choose.",
          currentValue: preferences.turns ? "on" : "off", values: ["on", "off"],
        }, {
          id: "turnClock", label: "  Clock color",
          description: "Color the background of every block's clock in its turn's color.",
          currentValue: preferences.turnClock ? "on" : "off", values: ["on", "off"],
        }, {
          ...mixSetting("turnClockMix", "  Clock color strength", "How strongly the turn's color shows behind the clock: the percent of the hue mixed into the terminal background."),
        }, {
          id: "turnStripe", label: "  Stripe",
          description: "Mark every block of a turn on the left: a colored cell (block), a thin colored line, or nothing.",
          currentValue: preferences.turnStripe, values: [...TURN_STRIPES],
        }, {
          ...mixSetting("turnStripeMix", "  Stripe color strength", "How strongly the turn's color shows in stripes, lines and separators: 100% is the full hue."),
        }, {
          id: "turnBackground", label: "  Background",
          description: "Tint the plain background of every block of a turn. Tool cards and messages keep their own backgrounds.",
          currentValue: preferences.turnBackground ? "on" : "off", values: ["on", "off"],
        }, {
          ...mixSetting("turnBackgroundMix", "  Background color strength", "How strongly the turn's color tints the background of its blocks."),
        }, {
          id: "turnSeparator", label: "  Separator",
          description: "Draw a line in the turn's color in both panels where each new turn begins.",
          currentValue: preferences.turnSeparator ? "on" : "off", values: ["on", "off"],
        }, {
          id: "turnHover", label: HOVER_LABEL,
          description: hoverAvailable ? "While the pointer is over any block, highlight its whole turn in both panels."
            : "Unavailable: the terminal does not report pointer motion here, such as inside tmux, zellij or screen, or with Pi's mouse support off.",
          currentValue: hoverAvailable ? (preferences.turnHover ? "on" : "off") : "unavailable",
          values: hoverAvailable ? ["on", "off"] : ["unavailable"],
        }, {
          ...mixSetting("turnHoverMix", "  Hover color strength",
            "How strongly the turn's color tints the background of every block of the turn under the pointer, in place of its background color."),
        }, {
          id: "goTo", label: "  Go to",
          description: "Open the same point of history in the other panel by clicking a block's clock, a Go to button beside Copy, both or neither.",
          currentValue: preferences.goTo, values: [...GO_TO],
        }];
        const VISIBLE_SETTINGS = 20;
        const apply = (id: string, value: string): void => {
          if (id === "turns" || id === "turnClock" || id === "turnBackground" || id === "turnSeparator") layout?.setTurnMark(id, value === "on");
          else if (id === "turnStripe") layout?.setTurnMark("turnStripe", value as TurnStripe);
          else if (id === "turnClockMix" || id === "turnStripeMix" || id === "turnBackgroundMix" || id === "turnHoverMix") {
            layout?.setTurnMark(id, Number.parseInt(value, 10));
          }
          else if (id === "turnHover") { if (value !== "unavailable") layout?.setTurnHover(value === "on"); }
          else if (id === "goTo") layout?.setGoTo(value as GoTo);
          else if (id === "timestamps") layout?.setTimestamps(value === "on");
          else if (id === "copyButtons") layout?.setCopyButtons(value === "on");
          else if (id === "buttonStyle") layout?.setButtonStyle(value === "text" ? "text" : "icons");
          else if (id === "compactTools") layout?.setCompactTools(value === "on");
          else if (id === "groupTools") layout?.setGroupTools(value === "on");
          else if (id === "nestedTree") layout?.setNestedTree(value === "on");
          else if (id === "streamTools") layout?.setStreamTools(value === "on");
          else if (id === "streamDelay") layout?.setStreamDelay(Number.parseInt(value, 10));
          else if (id === "height") layout?.setAutomaticHeight(value === "auto");
          tui.requestRender();
        };
        const list = new SettingsList(items, VISIBLE_SETTINGS, {
          ...listTheme,
          label: (text, selected) => {
            const label = text.trim();
            if (label === TURNS_HEADER) return ui.theme.bold(ui.theme.fg("accent", text));
            // Turn settings look disabled while turns are off, and so does an unavailable setting; both stay listed
            // so their explanations can be read. Only turn settings are indented.
            if (text.startsWith("  ") && !preferences.turns) return ui.theme.fg("dim", text);
            if (!hoverAvailable && label === HOVER_LABEL.trim()) return ui.theme.fg("dim", text);
            return listTheme.label(text, selected);
          },
          value: (text, selected) => text === "unavailable" ? ui.theme.fg("dim", text) : listTheme.value(text, selected),
        }, apply, () => done());
        const steady = new SteadySettings(list, items, VISIBLE_SETTINGS, apply);
        const content = new Container();
        content.addChild({
          render: () => [ui.theme.fg("accent", ui.theme.bold("pi-stereo-view settings")), ""],
          invalidate() {},
        });
        content.addChild(steady);
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
            steady.handleInput(data);
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
    const problems = new ProblemReporter(ui, copyToClipboard);
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
      }, () => pi.getAllTools(), nested, () => nativeEditor.get(tui), problem => problems.show(problem));
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
      // Pi starts its terminal before session_start, also after an early layout mount.
      layout?.markTerminalStarted();
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
        ctx.ui.notify("pi-stereo-view: choose icon or text buttons in /stereo-view settings. Buttons: ▣/Combine combines history, ◫/Split separates it, ▤/Rows and ▥/Columns change layout, ↕/↔/Swap exchanges panels, ↗/Maximize and ↙/Restore change panel size, ⌕/Find searches, ⊟/Compact tools and ⊞/Full tools toggle compact tools, ≡/Settings opens settings, ⧉/Copy copies a block, ⇄/Go to or a click on a block's clock opens the same point in the other panel. /stereo-view copy chooses a block with the keyboard. Ctrl+F searches and PgUp/PgDn scroll the active panel; Ctrl+Alt+Up/Down switches it. Drag the ═ or ║ divider to resize.", "info");
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
