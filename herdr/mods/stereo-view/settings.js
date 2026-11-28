import { div } from "gpui-kit";
import { h_flex, v_flex, Input, InputState } from "gpui-base";

const MIXES = [2, 5, 8, 10, 15, 20, 30, 50, 75, 100];
const COLORS = ["turn", "#808080", "#3b82f6", "#14b8a6", "#22c55e", "#eab308", "#f97316", "#ef4444", "#a855f7"];
const DELAYS = [1, 2, 3, 5, 10, 30];
const bool = [true, false];
const mix = current => [...new Set([...MIXES, current])].sort((a, b) => a - b);

/** The setting values are the typed values saved by Stereo View, not display labels. */
export function settingGroups(p) {
  const row = (key, label, values, labels) => ({ key, label, value: p[key], values, labels });
  return [
    { title: "Blocks", rows: [
      row("showTimestamps", "Block clocks", bool),
      row("showCopyButtons", "Copy buttons", bool),
      row("buttonStyle", "Button labels", ["text", "icons"], ["words", "icons"]),
      row("showModelUsage", "Model usage", bool),
    ] },
    { title: "Activity tools", rows: [
      row("compactTools", "Finished tool calls", bool, ["one line", "full"]),
      row("groupTools", "Repeated tool calls", bool, ["merge", "separate"]),
      row("nestedTree", "Codemode calls", bool, ["tree", "raw output"]),
      row("streamTools", "Running tool calls", bool, ["full", "one line"]),
      row("streamDelay", "Fold finished calls after", [...new Set([...DELAYS, p.streamDelay])].sort((a, b) => a - b)),
      row("showToolDurations", "Tool durations", bool),
    ] },
    { title: "Layout", rows: [
      { ...row("chatHeight", "Conversation height in rows", [null, p.chatHeight ?? 12]), labels: ["grow with messages", "fixed"] },
      row("showToolbar", "Show toolbar", bool),
      row("showPaneHeaders", "Show pane headers", [true, false, "auto"]),
      { ...row("autoPaneHeaderRows", "Auto header threshold (rows)", []), input: true },
      row("piWindows", "Pi pickers in split", ["combined", "maximize", "inline"], ["full screen", "maximize Activity", "inside Activity"]),
    ] },
    { title: "Turns", rows: [
      row("turns", "Color each turn", bool),
      row("turnClock", "Tint clocks", bool),
      row("turnClockMix", "Clock tint strength", mix(p.turnClockMix)),
      row("turnStripe", "Left stripe", ["block", "line", "off"]),
      row("turnStripeMix", "Stripe strength", mix(p.turnStripeMix)),
      row("turnBackground", "Tint blocks", bool),
      row("turnBackgroundMix", "Block tint strength", mix(p.turnBackgroundMix)),
      row("turnSeparator", "Line between turns", bool),
      row("turnHover", "Highlight turn on hover", bool),
      row("turnHoverMix", "Hover strength", mix(p.turnHoverMix)),
      { ...row("turnHoverColor", "Hover color", [...new Set([...COLORS, p.turnHoverColor])]), input: true },
      row("goTo", "Jump to other panel", ["clock", "button", "both", "off"], ["click clock", "button", "both", "off"]),
    ] },
  ];
}

export function nextSetting(values, current, direction) {
  if (!values.length) return current;
  const index = values.indexOf(current);
  return values[((index < 0 ? 0 : index) + direction + values.length) % values.length];
}

export function parseSettingInput(key, text) {
  const value = text.trim();
  if (key === "autoPaneHeaderRows") {
    const n = /^\d+$/.test(value) ? Number(value) : NaN;
    return Number.isSafeInteger(n) && n > 0 ? n : undefined;
  }
  if (key === "turnHoverColor" && /^#[0-9a-f]{6}$/i.test(value)) return value.toLowerCase();
  return undefined;
}

function display(row) {
  const position = row.values.indexOf(row.value);
  if (row.labels && position >= 0) return row.labels[position];
  if (row.value === true) return "on";
  if (row.value === false) return "off";
  if (row.key === "streamDelay") return `${row.value}s`;
  if (row.key.endsWith("Mix")) return `${row.value}%`;
  if (row.key === "turnHoverColor" && row.value === "turn") return "turn color";
  return String(row.value ?? "");
}

/**
 * Create once when the settings panel opens. Call render with the latest bridge preferences and theme.
 * update(key, value, cx) must send the typed value to Pi. close(cx) dismisses the panel.
 * InputState stays owned by this panel between renders, so editing survives bridge refreshes.
 */
export function createSettingsPanel(preferences, update, close) {
  const inputs = {
    autoPaneHeaderRows: InputState.new({ value: String(preferences.autoPaneHeaderRows) }),
    turnHoverColor: InputState.new({ value: preferences.turnHoverColor === "turn" ? "" : preferences.turnHoverColor }),
  };
  const errors = {};
  let closed = false;
  function dismiss(cx) {
    if (closed) return;
    closed = true;
    for (const input of Object.values(inputs)) input.release();
    close(cx);
  }
  for (const key of Object.keys(inputs)) {
    inputs[key].on("change", (_event, cx) => { delete errors[key]; cx.notify(); });
    inputs[key].on("submit", (_event, cx) => applyInput(key, cx));
  }
  function applyInput(key, cx) {
    const value = parseSettingInput(key, inputs[key].value());
    if (value === undefined) errors[key] = key === "turnHoverColor" ? "Enter a color as #rrggbb." : "Enter a positive whole number.";
    else { delete errors[key]; update(key, value, cx); }
    cx.notify();
  }
  const button = (id, title, action, t) => div().id(id).px(7).py(3).rounded(4).border_1().border_color(t.input)
    .bg(t.raised).text_color(t.foreground).cursor_pointer().hover(s => s.bg(t.hover)).on_click(action).child(title);
  return {
    render(p, t) {
      const groups = settingGroups(p);
      const content = v_flex().id("stereo-settings-scroll").flex_1().min_h(0).overflow_y_scrollbar().px(16).pb(16).gap(12);
      for (const group of groups) {
        const section = v_flex().gap(3).child(div().pt(7).pb(3).text_color(t.accent).font_semibold().child(group.title));
        for (const row of group.rows) {
          const controls = h_flex().items_center().gap(4);
          if (row.values.length) {
            controls.child(button(`stereo-setting-${row.key}-previous`, "‹", (_event, cx) => update(row.key, nextSetting(row.values, row.value, -1), cx), t))
              .child(div().min_w(80).px(5).text_color(t.foreground).child(display(row)))
              .child(button(`stereo-setting-${row.key}-next`, "›", (_event, cx) => update(row.key, nextSetting(row.values, row.value, 1), cx), t));
          }
          if (row.input) {
            controls.child(Input.new(inputs[row.key]).w(110).h(28).px(6).rounded(4).border_1().border_color(t.input)
              .bg(t.background).text_color(t.foreground))
              .child(button(`stereo-setting-${row.key}-apply`, "Apply", (_event, cx) => applyInput(row.key, cx), t));
          }
          section.child(h_flex().items_center().gap(8).py(2)
            .child(div().flex_1().min_w(0).text_color(t.foreground).child(row.label)).child(controls));
          if (errors[row.key]) section.child(div().text_color(t.error ?? t.foreground).child(errors[row.key]));
        }
        content.child(section);
      }
      return v_flex().id("stereo-settings").size_full().min_h(0).bg(t.surface).text_color(t.foreground)
        .on_key_down((event, cx) => { if (event.key === "escape") { dismiss(cx); cx.stop_propagation(); } })
        .child(h_flex().items_center().justify_between().px(16).py(10)
          .child(div().text_size(15).font_semibold().child("Stereo View settings"))
          .child(button("stereo-settings-close", "Close", (_event, cx) => dismiss(cx), t)))
        .child(content);
    },
  };
}
