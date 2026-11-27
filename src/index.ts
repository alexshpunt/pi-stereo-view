import path from "node:path";
import { copyToClipboard, getAgentDir, getSettingsListTheme, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { backgroundAnsi, Box, Container, isKeyRelease, matchesKey, rgbColor, SettingsList, Text, type OverlayHandle, type SettingItem, type TUI, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { SteadySettings } from "./steady-settings.ts";
import { HexInput } from "./hex-input.ts";
import { SettingInput, type SettingInputTheme } from "./setting-input.ts";
import { parseHex } from "./turns.ts";
import { TranscriptLayout } from "./layout.ts";
import { TOOL_START_ENTRY, TranscriptTimestamps } from "./timestamps.ts";
import { HOVER_COLORS, TURN_MIXES, TURN_STRIPES, GO_TO, PI_WINDOWS, defaults, loadPreferences, savePreferences, validAutoPaneHeaderRows, type TurnStripe, type GoTo, type PiWindows, type Preferences } from "./preferences.ts";
import { beforeFirstFrame } from "./startup.ts";
import { observeNativeEditor } from "./native-editor.ts";
import { NestedCalls } from "./nested-calls.ts";
import { ProblemReporter } from "./report.ts";
import { startGuiBridge } from "./gui-bridge.ts";
import { openGuiForFocusedTerminal } from "./gui-open.ts";

const DELAYS = [1, 2, 3, 5, 10, 30];
/**
 * What a setting's values read as in the settings list, by setting id: what the user sees once it is chosen. The saved
 * file and the code keep the short values. Values without an entry, such as delays, percents and colors, show as they are.
 */
const SHOWN_VALUES: Record<string, Record<string, string>> = {
  timestamps: { on: "shown", off: "hidden" },
  copyButtons: { on: "shown", off: "hidden" },
  buttonStyle: { text: "words" },
  compactTools: { on: "one line", off: "full" },
  groupTools: { on: "merge", off: "separate" },
  nestedTree: { on: "tree", off: "raw output" },
  streamTools: { on: "full", off: "one line" },
  height: { auto: "grow with messages", manual: "fixed by drag" },
  piWindows: { combined: "full screen", maximize: "maximize Activity", inline: "inside Activity" },
  turnHoverColor: { turn: "turn color" },
  goTo: { clock: "click clock", button: "button" },
};
const shownValue = (id: string, value: string): string => SHOWN_VALUES[id]?.[value] ?? value;
const savedValue = (id: string, shown: string): string =>
  Object.entries(SHOWN_VALUES[id] ?? {}).find(([, label]) => label === shown)?.[0] ?? shown;

/** Split native fullscreen history without changing message content or the input dock. */
export default async function transcript(pi: ExtensionAPI): Promise<void> {
  let layout: TranscriptLayout | undefined;
  let host: TUI | undefined;
  let timestamps: TranscriptTimestamps | undefined;
  const nested = new NestedCalls();
  const nativeEditor = observeNativeEditor();
  let unsubscribeInput: (() => void) | undefined;
  let stopGuiBridge: (() => Promise<void>) | undefined;
  let guiOpenTimer: ReturnType<typeof setTimeout> | undefined;
  let guiBridgeActive = false;
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
        const HOVER_LABEL = "  Highlight turn on hover";
        const SETTINGS_BACKGROUND = "customMessageBg";
        const listTheme = getSettingsListTheme();
        const inputTheme: SettingInputTheme = {
          title: text => ui.theme.bold(ui.theme.fg("accent", text)),
          hint: text => ui.theme.fg("dim", text),
          error: text => ui.theme.fg("error", text),
        };
        // A saved mix outside the offered steps stays selectable until another is chosen.
        const mixSetting = (id: "turnClockMix" | "turnStripeMix" | "turnBackgroundMix" | "turnHoverMix", label: string, description: string) => ({
          id, label, description, currentValue: `${preferences[id]}%`,
          values: [...new Set([...TURN_MIXES, preferences[id]])].sort((a, b) => a - b).map(percent => `${percent}%`),
        });
        // A typed hover color joins the presets, so the arrows can step to and from it.
        const hoverColors = (current: string): string[] => ["turn", ...new Set([...HOVER_COLORS, ...(current === "turn" ? [] : [current])])];
        const items: SettingItem[] = [{
          id: "timestamps", label: "Block clocks",
          description: "The clock row above every block. Hiding it keeps the recorded times.",
          currentValue: preferences.showTimestamps ? "on" : "off", values: ["on", "off"],
        }, {
          id: "copyButtons", label: "Copy buttons",
          description: "The Copy button on every block. Keyboard copying works either way.",
          currentValue: preferences.showCopyButtons ? "on" : "off", values: ["on", "off"],
        }, {
          id: "buttonStyle", label: "Button labels",
          description: "Toolbar, panel and copy buttons as icons, such as [ ⌕ ], or as words, such as [Find].",
          currentValue: preferences.buttonStyle, values: ["icons", "text"],
        }, {
          id: "showModelUsage", label: "Model usage",
          description: "Show recorded tokens and cost for model responses and tools that report them.",
          currentValue: preferences.showModelUsage ? "on" : "off", values: ["on", "off"],
        }, {
          id: "compactTools", label: "Finished tool calls",
          description: "One line that opens the full card when clicked, or the full card. Search and copy always use the full text.",
          currentValue: preferences.compactTools ? "on" : "off", values: ["on", "off"],
        }, {
          id: "groupTools", label: "Repeated tool calls",
          description: "Adjacent calls of the same tool merged under one counted line, such as read ×3, or each on its own.",
          currentValue: preferences.groupTools ? "on" : "off", values: ["on", "off"],
        }, {
          id: "nestedTree", label: "Codemode calls",
          description: "The calls a tool such as Codemode makes: a tree under the tool, or the tool's own raw output.",
          currentValue: preferences.nestedTree ? "on" : "off", values: ["on", "off"],
        }, {
          id: "streamTools", label: "Running tool calls",
          description: "A running call shows its full card and folds after the delay below, or shows as one line right away.",
          currentValue: preferences.streamTools ? "on" : "off", values: ["on", "off"],
        }, {
          id: "streamDelay", label: "Fold finished calls after",
          description: "How long a finished call stays full before it folds into one line or its merged group.",
          currentValue: `${preferences.streamDelay}s`, values: [...new Set([...DELAYS, preferences.streamDelay])].sort((a, b) => a - b).map(seconds => `${seconds}s`),
        }, {
          id: "showToolDurations", label: "Tool durations",
          description: "Show the recorded time for each finished call in split history.",
          currentValue: preferences.showToolDurations ? "on" : "off", values: ["on", "off"],
        }, {
          id: "height", label: "Conversation height in rows",
          description: "In the Rows layout, Conversation grows with its messages up to half the history, or keeps the height you dragged.",
          currentValue: preferences.chatHeight === null ? "auto" : "manual", values: ["auto", "manual"],
        }, {
          id: "showToolbar", label: "Show toolbar",
          description: "Show the controls above history. You can always reopen settings with /stereo-view settings.",
          currentValue: preferences.showToolbar ? "on" : "off", values: ["on", "off"],
        }, {
          id: "showPaneHeaders", label: "Show pane headers",
          description: "Auto hides the pane titles and controls when history is short. Ctrl+F still searches without headers.",
          currentValue: preferences.showPaneHeaders === "auto" ? "auto" : preferences.showPaneHeaders ? "on" : "off",
          values: ["on", "off", "auto"],
        }, {
          id: "autoPaneHeaderRows", label: "Auto header threshold (rows)",
          description: "In Auto, show headers at this many history rows, not counting the toolbar or input area. Press Enter to edit.",
          currentValue: String(preferences.autoPaneHeaderRows),
          submenu: (current, done) => new SettingInput(current, inputTheme, {
            title: "Auto header threshold (rows)",
            hint: "Minimum history rows · Enter to keep · Esc to cancel",
            error: "Enter a positive whole number of rows.",
            normalize: input => {
              const value = /^\d+$/.test(input.trim()) ? Number(input) : NaN;
              return validAutoPaneHeaderRows(value) ? String(value) : undefined;
            },
          }, done),
        }, {
          id: "piWindows", label: "Pi pickers in split",
          description: "Pi's own pickers, such as the session tree or the model list, open full screen, in maximized Activity, or inside Activity.",
          currentValue: preferences.piWindows, values: [...PI_WINDOWS],
        }, {
          // Switches the whole group; the settings indented under it keep their values while it is off.
          id: "turns", label: "Color each turn",
          description: "A turn is a message you or an extension send, with all the work that answers it. Off turns off everything below.",
          currentValue: preferences.turns ? "on" : "off", values: ["on", "off"],
        }, {
          id: "turnClock", label: "  Tint clocks",
          description: "Color the background of every block's clock with its turn's color.",
          currentValue: preferences.turnClock ? "on" : "off", values: ["on", "off"],
        }, {
          ...mixSetting("turnClockMix", "  Clock tint strength", "How strongly the turn's color shows behind the clock: the percent of the color mixed into the background."),
        }, {
          id: "turnStripe", label: "  Left stripe",
          description: "Mark every block of a turn on the left: a colored cell (block), a thin colored line, or nothing.",
          currentValue: preferences.turnStripe, values: [...TURN_STRIPES],
        }, {
          ...mixSetting("turnStripeMix", "  Stripe strength", "How strongly the turn's color shows in stripes and in lines between turns: 100% is the full color."),
        }, {
          id: "turnBackground", label: "  Tint blocks",
          description: "Tint the background of every block of a turn. Tool cards and messages shift by the same amount.",
          currentValue: preferences.turnBackground ? "on" : "off", values: ["on", "off"],
        }, {
          ...mixSetting("turnBackgroundMix", "  Block tint strength", "How strongly the turn's color tints the background of its blocks."),
        }, {
          id: "turnSeparator", label: "  Line between turns",
          description: "Draw a line in the turn's color in both panels where each new turn begins.",
          currentValue: preferences.turnSeparator ? "on" : "off", values: ["on", "off"],
        }, {
          id: "turnHover", label: HOVER_LABEL,
          description: hoverAvailable ? "While the pointer is over any block, highlight its whole turn in both panels."
            : "Unavailable: the terminal does not report pointer motion, such as inside tmux, zellij or screen.",
          currentValue: hoverAvailable ? (preferences.turnHover ? "on" : "off") : "unavailable",
          values: hoverAvailable ? ["on", "off"] : ["unavailable"],
        }, {
          ...mixSetting("turnHoverMix", "  Hover strength", "How strongly the hover color tints every block of the turn under the pointer."),
        }, {
          id: "turnHoverColor", label: "  Hover color",
          description: "Each turn in its own color, or every turn in one #rrggbb color. ←/→ pick a preset; Enter types any color.",
          currentValue: preferences.turnHoverColor, values: hoverColors(preferences.turnHoverColor),
          submenu: (current, done) => new HexInput(current, inputTheme, done),
        }, {
          id: "goTo", label: "  Jump to other panel",
          description: "Open the same point of history in the other panel by clicking a block's clock, a Go to button, both or neither.",
          currentValue: preferences.goTo, values: [...GO_TO],
        }];
        for (const item of items) {
          item.currentValue = shownValue(item.id, item.currentValue);
          item.values = item.values?.map(value => shownValue(item.id, value));
        }
        // Each group's title shows above its first setting.
        const groups = new Map([["timestamps", "Blocks"], ["compactTools", "Activity tools"], ["height", "Layout"], ["turns", "Turns"]]);
        const visibleSettings = items.length;
        const apply = (id: string, shown: string): void => {
          const value = savedValue(id, shown);
          if (id === "turns" || id === "turnClock" || id === "turnBackground" || id === "turnSeparator") layout?.setTurnMark(id, value === "on");
          else if (id === "turnStripe") layout?.setTurnMark("turnStripe", value as TurnStripe);
          else if (id === "turnClockMix" || id === "turnStripeMix" || id === "turnBackgroundMix" || id === "turnHoverMix") {
            layout?.setTurnMark(id, Number.parseInt(value, 10));
          } else if (id === "turnHoverColor") {
            layout?.setTurnMark(id, value);
            const item = items.find(entry => entry.id === id);
            if (item) item.values = hoverColors(value).map(entry => shownValue(id, entry));
          }
          else if (id === "turnHover") { if (value !== "unavailable") layout?.setTurnHover(value === "on"); }
          else if (id === "goTo") layout?.setGoTo(value as GoTo);
          else if (id === "piWindows") layout?.setPiWindows(value as PiWindows);
          else if (id === "timestamps") layout?.setTimestamps(value === "on");
          else if (id === "copyButtons") layout?.setCopyButtons(value === "on");
          else if (id === "showToolDurations" || id === "showModelUsage") layout?.setMetric(id, value === "on");
          else if (id === "buttonStyle") layout?.setButtonStyle(value === "text" ? "text" : "icons");
          else if (id === "compactTools") layout?.setCompactTools(value === "on");
          else if (id === "groupTools") layout?.setGroupTools(value === "on");
          else if (id === "nestedTree") layout?.setNestedTree(value === "on");
          else if (id === "streamTools") layout?.setStreamTools(value === "on");
          else if (id === "streamDelay") layout?.setStreamDelay(Number.parseInt(value, 10));
          else if (id === "height") layout?.setAutomaticHeight(value === "auto");
          else if (id === "showToolbar") layout?.setChrome({ showToolbar: value === "on" });
          else if (id === "showPaneHeaders") layout?.setChrome({ showPaneHeaders: value === "auto" ? value : value === "on" });
          else if (id === "autoPaneHeaderRows") layout?.setChrome({ autoPaneHeaderRows: Number(value) });
          tui.requestRender();
        };
        const list = new SettingsList(items, visibleSettings, {
          ...listTheme,
          label: (text, selected) => {
            const label = text.trim();
            // Turn settings look disabled while turns are off, and so does an unavailable setting; both stay listed
            // so their explanations can be read. Only turn settings are indented.
            if (text.startsWith("  ") && !preferences.turns) return ui.theme.fg("dim", text);
            if (!hoverAvailable && label === HOVER_LABEL.trim()) return ui.theme.fg("dim", text);
            return listTheme.label(text, selected);
          },
          value: (text, selected) => {
            if (text === "unavailable") return ui.theme.fg("dim", text);
            // A hover color shows a swatch of itself.
            const color = parseHex(text);
            if (!color) return listTheme.value(text, selected);
            // The swatch's own background ends at the swatch; the panel's background resumes after it, with no reset
            // that would end the panel's background for the rest of the row.
            return backgroundAnsi(rgbColor(color.r, color.g, color.b), ui.theme.getColorMode()) + "  " +
              ui.theme.getBgAnsi(SETTINGS_BACKGROUND) + " " + listTheme.value(text, selected);
          },
        }, apply, () => done());
        const steady = new SteadySettings(list, items, visibleSettings, apply,
          { titles: groups, style: text => ui.theme.bold(ui.theme.fg("accent", text)) });
        const content = new Container();
        content.addChild({
          render: () => [ui.theme.fg("accent", ui.theme.bold("pi-stereo-view settings")), ""],
          invalidate() {},
        });
        content.addChild(steady);
        const box = new Box(1, 1, text => ui.theme.bg(SETTINGS_BACKGROUND, text));
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
    if (!stopGuiBridge && process.env.HC_TERMINAL_ID && process.platform !== "win32") {
      try {
        const terminal = process.env.HC_TERMINAL_ID;
        stopGuiBridge = await startGuiBridge(terminal, () => layout?.guiIndex(), undefined, () => {
          const current = layout;
          return current ? { state: () => current.guiState(), action: action => current.guiAction(action),
            setting: setting => current.guiSetting(setting), renderer: () => current.guiRenderer(),
            surface: () => current.guiSurface(),
            search: () => current.guiSearchModel() } : undefined;
        });
        guiBridgeActive = true;
        // Give Herdr time to identify this Pi; never raise a background agent's tab.
        guiOpenTimer = setTimeout(() => {
          void openGuiForFocusedTerminal(terminal, process.pid, undefined, () => guiBridgeActive);
        }, 1000);
        guiOpenTimer.unref();
      } catch (error) { ctx.ui.notify("Native Stereo View is unavailable: " + String(error), "warning"); }
    }
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
    layout?.invalidateGui();
    timestamps?.observe(event.message);
    layout?.refreshSearch();
  });
  pi.on("message_update", event => {
    layout?.invalidateGui();
    timestamps?.observe(event.message);
    layout?.refreshSearch();
    ensureLayout();
  });
  pi.on("message_end", event => {
    layout?.invalidateGui();
    if (nested.absorb(event.message)) host?.requestRender();
    timestamps?.observe(event.message, true);
    layout?.refreshSearch();
  });
  pi.on("tool_execution_update", () => {
    layout?.invalidateGui();
    layout?.refreshSearch();
  });
  pi.on("tool_execution_end", event => {
    layout?.invalidateGui();
    nested.end(event);
    layout?.refreshSearch();
    host?.requestRender();
  });
  pi.on("tool_execution_start", event => {
    layout?.invalidateGui();
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
  pi.on("session_tree", (_event, ctx) => { layout?.invalidateGui(); closeSearch(); nested.restore(ctx.sessionManager.getBranch()); timestamps?.reset(); host?.requestRender(); });
  pi.on("session_compact", (_event, ctx) => { layout?.invalidateGui(); closeSearch(); nested.restore(ctx.sessionManager.getBranch()); timestamps?.reset(); host?.requestRender(); });
  pi.on("session_shutdown", async () => {
    guiBridgeActive = false;
    if (guiOpenTimer) clearTimeout(guiOpenTimer);
    guiOpenTimer = undefined;
    await stopGuiBridge?.();
    stopGuiBridge = undefined;
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
    description: "History: copy, settings, toolbar, headers, both, toggle, swap, layout <columns|rows>, zoom <chat|activity>, width, height, scroll",
    handler: async (args, ctx) => {
      if (ctx.mode !== "tui" || !layout) {
        ctx.ui.notify("pi-stereo-view layout is available only in interactive Pi.", "warning");
        return;
      }
      const [action = "toggle", target, amount] = args.trim().split(/\s+/);
      if (action === "toggle" || action === "") toggle();
      else if (action === "settings") await openSettings(ctx.ui);
      else if (action === "toolbar") layout.setChrome({ showToolbar: !preferences.showToolbar });
      else if (action === "headers") layout.togglePaneHeaders();
      else if (action === "both") layout.toggleChrome();
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
        ctx.ui.notify("pi-stereo-view: choose icon or text buttons in /stereo-view settings. Buttons: ▣/Combine combines history, ◫/Split separates it, ▤/Rows and ▥/Columns change layout, ↕/↔/Swap exchanges panels, ↗/Maximize and ↙/Restore change panel size, ⌕/Find searches, ⊟/Compact tools and ⊞/Full tools toggle compact tools, ≡/Settings opens settings, ⌃/⌄ hides or restores pane headers, ⧉/Copy copies a block, ⇄/Go to or a click on a block's clock opens the same point in the other panel. /stereo-view copy chooses a block with the keyboard. Ctrl+F searches and PgUp/PgDn scroll the active panel; Ctrl+Alt+Up/Down switches it. Drag the ═ or ║ divider to resize. Use /stereo-view toolbar or /stereo-view headers to toggle either set of controls, or /stereo-view both to toggle both.", "info");
      } else if (action === "swap") layout.swap();
      else if (action === "width" && /^\d+$/.test(target ?? "")) layout.setWidth(Number(target));
      else if (action === "height" && target === "auto") layout.setHeight(null);
      else if (action === "height" && /^\d+$/.test(target ?? "")) layout.setHeight(Number(target));
      else if (action === "layout" && (target === "columns" || target === "rows")) layout.setLayout(target);
      else if (action === "zoom" && (target === "chat" || target === "activity")) layout.maximize(target);
      else if (action === "scroll" && (target === "chat" || target === "activity") && /^-?\d+$/.test(amount ?? "")) {
        layout.scroll(target, Number(amount));
      } else {
        ctx.ui.notify("Use /stereo-view [copy|help|settings|toolbar|headers|both|toggle|swap|layout <columns|rows>|zoom <chat|activity>|width <columns>|height <rows|auto>|scroll <chat|activity> <lines>]", "warning");
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
