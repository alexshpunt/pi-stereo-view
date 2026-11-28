import type { Pane } from "./content.ts";
import type { GuiMouse, GuiPane } from "./gui-documents.ts";
import { GO_TO, PI_WINDOWS, TURN_STRIPES, type Preferences } from "./preferences.ts";

export type GuiSetting = { key: keyof Preferences; value: boolean | string | number | null };

/** Only display preferences accepted from the local GUI, with the same bounds as saved settings. */
function guiSetting(key: unknown, value: unknown): GuiSetting | undefined {
  if (typeof key !== "string") return undefined;
  const booleans = ["showTimestamps", "showCopyButtons", "showToolbar", "showToolDurations", "showModelUsage", "compactTools", "groupTools", "nestedTree", "streamTools", "turns", "turnClock", "turnBackground", "turnSeparator", "turnHover"];
  let valid = booleans.includes(key) && typeof value === "boolean";
  if (key === "showPaneHeaders") valid = typeof value === "boolean" || value === "auto";
  if (key === "buttonStyle") valid = value === "icons" || value === "text";
  if (key === "turnStripe") valid = TURN_STRIPES.includes(value as typeof TURN_STRIPES[number]);
  if (key === "goTo") valid = GO_TO.includes(value as typeof GO_TO[number]);
  if (key === "piWindows") valid = PI_WINDOWS.includes(value as typeof PI_WINDOWS[number]);
  if (key === "turnHoverColor") valid = typeof value === "string" && (value === "turn" || /^#[0-9a-f]{6}$/i.test(value));
  if (["turnClockMix", "turnStripeMix", "turnBackgroundMix", "turnHoverMix"].includes(key))
    valid = typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 100;
  if (key === "streamDelay") valid = typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 300;
  if (key === "autoPaneHeaderRows") valid = typeof value === "number" && Number.isSafeInteger(value) && value > 0;
  if (key === "chatHeight") valid = value === null || (typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 240);
  if (key === "chatWidth") valid = value === null || (typeof value === "number" && Number.isInteger(value) && value >= 24 && value <= 240);
  return valid ? { key: key as keyof Preferences, value: value as GuiSetting["value"] } : undefined;
}

export interface GuiPageRequest {
  v: 1;
  op: "page";
  pane: Pane;
  start: number;
  count: number;
  width: number;
}

export const GUI_ACTIONS = ["swap", "layout", "mode", "zoom-chat", "zoom-activity", "compact", "settings", "headers"] as const;
export type GuiAction = typeof GUI_ACTIONS[number];
export type GuiSearchRequest = { v: 1; op: "search"; pane: Pane } & (
  { action: "open"; top: number; height: number; following: boolean } |
  { action: "query"; query: string } | { action: "next" | "previous" | "close" | "state" });
export type GuiPasteChunk = { v: 1; transaction: string; index: number; count: number; data: string; frame: number } & (
  { op: "surface-paste"; target?: "dock" } | { op: "overlay-paste"; revision: number; id: number });
export type GuiRequest = GuiPageRequest | GuiSearchRequest | GuiPasteChunk | { v: 1; op: "state" } | { v: 1; op: "action"; action: GuiAction } |
  ({ v: 1; op: "setting" } & GuiSetting) |
  { v: 1; op: "image"; id: string; offset: number; length: number } |
  { v: 1; op: "overlays" } |
  { v: 1; op: "overlay-key"; revision: number; id: number; frame: number; data: string } |
  { v: 1; op: "overlay-mouse"; revision: number; id: number; frame: number; event: { type: "press" | "release" | "drag"; button: "left"; x: number; y: number; cancel?: boolean } } |
  { v: 1; op: "surface"; width: number; target?: "dock" } | { v: 1; op: "surface-key"; frame: number; data: string; target?: "dock" } |
  { v: 1; op: "surface-mouse"; frame: number; target?: "dock"; event: { type: "press" | "release" | "drag"; button: "left"; x: number; y: number; cancel?: boolean } } |
  { v: 1; op: "view"; pane: GuiPane; top: number; height: number; width: number; following: boolean } |
  { v: 1; op: "mouse"; pane: GuiPane; frame: number; event: GuiMouse };

/** Reject invalid and oversized requests before looking at Pi's live components. */
export function parseGuiRequest(value: unknown): GuiRequest | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const request = value as Record<string, unknown>;
  if (request.v === 1 && request.op === "setting") {
    const setting = guiSetting(request.key, request.value);
    return setting ? { v: 1, op: "setting", ...setting } : undefined;
  }
  if (request.v === 1 && request.op === "state") return { v: 1, op: "state" };
  if (request.v === 1 && request.op === "action" && typeof request.action === "string" &&
      (GUI_ACTIONS as readonly string[]).includes(request.action)) {
    return { v: 1, op: "action", action: request.action as GuiAction };
  }
  const integer = (n: unknown, min: number, max: number): n is number =>
    typeof n === "number" && Number.isSafeInteger(n) && n >= min && n <= max;
  if (request.v === 1 && (request.op === "surface-paste" || request.op === "overlay-paste") &&
      typeof request.transaction === "string" && /^[a-zA-Z0-9_-]{1,64}$/.test(request.transaction) &&
      integer(request.index, 0, 4095) && integer(request.count, 1, 4096) && request.index < request.count &&
      integer(request.frame, 1, Number.MAX_SAFE_INTEGER) && typeof request.data === "string" &&
      request.data.length > 0 && request.data.length <= 512 && Array.from(request.data).length <= 256 &&
      !request.data.includes("\0") && !request.data.includes("\x1b")) {
    const base = { v: 1 as const, transaction: request.transaction, index: request.index, count: request.count,
      frame: request.frame, data: request.data };
    if (request.op === "surface-paste" && (request.target === undefined || request.target === "dock"))
      return { ...base, op: "surface-paste", ...(request.target === "dock" ? { target: "dock" as const } : {}) };
    if (request.op === "overlay-paste" && integer(request.revision, 1, Number.MAX_SAFE_INTEGER) &&
        integer(request.id, 1, Number.MAX_SAFE_INTEGER))
      return { ...base, op: "overlay-paste", revision: request.revision, id: request.id };
    return undefined;
  }
  if (request.v === 1 && request.op === "overlays") return { v: 1, op: "overlays" };
  if (request.v === 1 && (request.op === "overlay-key" || request.op === "overlay-mouse") &&
      integer(request.revision, 1, Number.MAX_SAFE_INTEGER) && integer(request.id, 1, Number.MAX_SAFE_INTEGER) &&
      integer(request.frame, 1, Number.MAX_SAFE_INTEGER)) {
    const base = { v: 1 as const, revision: request.revision, id: request.id, frame: request.frame };
    if (request.op === "overlay-key" && typeof request.data === "string" && request.data.length > 0 &&
        request.data.length <= 1024 && !request.data.includes("\0")) return { ...base, op: "overlay-key", data: request.data };
    if (request.op === "overlay-mouse" && request.event && typeof request.event === "object" && !Array.isArray(request.event)) {
      const e = request.event as Record<string, unknown>;
      if ((e.type === "press" || e.type === "release" || e.type === "drag") && e.button === "left" &&
          integer(e.x, 0, 4095) && integer(e.y, 0, 255) && (e.cancel === undefined || (e.type === "release" && typeof e.cancel === "boolean")))
        return { ...base, op: "overlay-mouse", event: { type: e.type, button: "left", x: e.x, y: e.y,
          ...(e.cancel === undefined ? {} : { cancel: e.cancel }) } };
    }
    return undefined;
  }
  const surfaceTarget = request.target === "dock" ? { target: "dock" as const } : {};
  if (request.op === "surface" || request.op === "surface-key" || request.op === "surface-mouse") {
    if (request.v !== 1 || (request.target !== undefined && request.target !== "dock")) return undefined;
    if (request.op === "surface" && integer(request.width, 10, 300))
      return { v: 1, op: "surface", width: request.width, ...surfaceTarget };
    if (request.op === "surface-key" && integer(request.frame, 1, Number.MAX_SAFE_INTEGER) &&
        typeof request.data === "string" && request.data.length > 0 && request.data.length <= 1024 && !request.data.includes("\0"))
      return { v: 1, op: "surface-key", frame: request.frame, data: request.data, ...surfaceTarget };
    if (request.op === "surface-mouse" && integer(request.frame, 1, Number.MAX_SAFE_INTEGER) &&
        request.event && typeof request.event === "object" && !Array.isArray(request.event)) {
      const e = request.event as Record<string, unknown>;
      if ((e.type === "press" || e.type === "release" || e.type === "drag") && e.button === "left" &&
          integer(e.x, 0, 299) && integer(e.y, 0, 255) && (e.cancel === undefined || (e.type === "release" && typeof e.cancel === "boolean")))
        return { v: 1, op: "surface-mouse", frame: request.frame, ...surfaceTarget, event: { type: e.type, button: "left", x: e.x, y: e.y,
          ...(e.cancel === undefined ? {} : { cancel: e.cancel }) } };
    }
    return undefined;
  }
  if (request.v === 1 && request.op === "image" && typeof request.id === "string" && /^[a-f0-9]{64}$/.test(request.id) &&
      integer(request.offset, 0, 24 * 1024 * 1024) && integer(request.length, 1, 524288))
    return { v: 1, op: "image", id: request.id, offset: request.offset, length: request.length };
  if (request.v === 1 && request.op === "search" && (request.pane === "chat" || request.pane === "activity")) {
    const pane = request.pane;
    if (request.action === "query" && typeof request.query === "string" && request.query.length <= 2048)
      return { v: 1, op: "search", pane, action: "query", query: request.query };
    if (request.action === "open" && integer(request.top, 0, Number.MAX_SAFE_INTEGER - 512) &&
        integer(request.height, 1, 256) && typeof request.following === "boolean")
      return { v: 1, op: "search", pane, action: "open", top: request.top, height: request.height, following: request.following };
    if (request.action === "next" || request.action === "previous" || request.action === "close" || request.action === "state")
      return { v: 1, op: "search", pane, action: request.action };
    return undefined;
  }
  if (request.v === 1 && request.op === "mouse" && (request.pane === "chat" || request.pane === "activity" || request.pane === "combined") &&
      integer(request.frame, 1, Number.MAX_SAFE_INTEGER) && request.event && typeof request.event === "object" && !Array.isArray(request.event)) {
    const e = request.event as Record<string, unknown>;
    if (typeof e.type !== "string" || !["press", "release", "move", "drag", "wheel"].includes(e.type) ||
        typeof e.button !== "string" || !["left", "middle", "right", "none"].includes(e.button) ||
        !integer(e.x, -600, 600) || !integer(e.y, -512, 512) ||
        [e.shift, e.alt, e.ctrl].some(value => value !== undefined && typeof value !== "boolean") ||
        (e.wheelDelta !== undefined && (typeof e.wheelDelta !== "number" || !Number.isFinite(e.wheelDelta) || Math.abs(e.wheelDelta) > 10000)) ||
        (e.clickCount !== undefined && e.clickCount !== 1 && e.clickCount !== 2 && e.clickCount !== 3) ||
        (e.cancel !== undefined && (e.type !== "release" || typeof e.cancel !== "boolean"))) return undefined;
    const event = { type: e.type, button: e.button, x: e.x, y: e.y,
      ...(e.shift === undefined ? {} : { shift: e.shift }), ...(e.alt === undefined ? {} : { alt: e.alt }),
      ...(e.ctrl === undefined ? {} : { ctrl: e.ctrl }), ...(e.wheelDelta === undefined ? {} : { wheelDelta: e.wheelDelta }),
      ...(e.clickCount === undefined ? {} : { clickCount: e.clickCount }),
      ...(e.cancel === undefined ? {} : { cancel: e.cancel }) } as GuiMouse;
    return { v: 1, op: "mouse", pane: request.pane, frame: request.frame, event };
  }
  if (request.v === 1 && request.op === "view" && (request.pane === "chat" || request.pane === "activity" || request.pane === "combined") &&
      integer(request.top, 0, Number.MAX_SAFE_INTEGER - 512) && integer(request.height, 1, 256) &&
      integer(request.width, 10, 300) && typeof request.following === "boolean") {
    return { v: 1, op: "view", pane: request.pane, top: request.top, height: request.height,
      width: request.width, following: request.following };
  }
  if (request.v !== 1 || request.op !== "page" || (request.pane !== "chat" && request.pane !== "activity") ||
      !integer(request.start, 0, Number.MAX_SAFE_INTEGER) || !integer(request.count, 0, 64) ||
      !integer(request.width, 10, 300)) return undefined;
  return { v: 1, op: "page", pane: request.pane, start: request.start, count: request.count, width: request.width };
}
