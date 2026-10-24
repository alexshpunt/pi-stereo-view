import { parseSkillBlock, sessionEntryToContextMessages, type ExtensionContext, type Theme } from "@earendil-works/pi-coding-agent";
import {
  Container, stripTerminalSequences, visibleWidth,
  type Component, type TuiMouseEvent,
} from "@earendil-works/pi-tui";

import { NativeRenderCache } from "./render-cache.js";
type Message = ReturnType<typeof sessionEntryToContextMessages>[number];
type TimedSource = { message: Message; time: unknown };
type UserSlot = { kind: string; text?: string; time: unknown };

// Identical native padding is common across cold blocks. Keep only a few short blank rows.
const blankRows = new Set<string>();
const blank = (line: string): boolean => {
  if (blankRows.has(line)) return true;
  if (stripTerminalSequences(line).trim().length !== 0) return false;
  if (line.length <= 4096) {
    if (blankRows.size >= 32) blankRows.delete(blankRows.values().next().value!);
    blankRows.add(line);
  }
  return true;
};

/** Display-only session entry: { toolCallId: string, time: epoch milliseconds }. */
export const TOOL_START_ENTRY = "pi-agent-transcript/tool-start";

const validTime = (value: unknown): number | undefined => {
  const time = typeof value === "number" ? value : typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isFinite(time) && Number.isFinite(new Date(time).getTime()) ? time : undefined;
};

/** Format a reliable source in the process's local zone; never substitute now. */
export function timestampLabel(value: unknown): string {
  const time = validTime(value);
  if (time === undefined) return "";
  const date = new Date(time);
  return [date.getHours(), date.getMinutes(), date.getSeconds()]
    .map(part => String(part).padStart(2, "0")).join(":");
}

const userSlots = ({ message, time }: TimedSource): UserSlot[] => {
  if (message.role !== "user") return [];
  const text = typeof message.content === "string" ? message.content :
    message.content.filter(block => block.type === "text").map(block => block.text).join("");
  if (!text) return [];
  const skill = parseSkillBlock(text);
  if (!skill) return [{ kind: "UserMessageComponent", text, time }];
  return [
    { kind: "SkillInvocationMessageComponent", time },
    ...(skill.userMessage ? [{ kind: "UserMessageComponent", text: skill.userMessage, time }] : []),
  ];
};

/** Correlate only the active history, using order/identity rather than text keys. */
export class TranscriptTimestamps {
  private orderedLabels = new WeakMap<Component, string>();
  private messageTimes = new WeakMap<object, unknown>();
  private starts = new Map<string, number>();
  private owners = new Map<string, unknown>();
  private readonly liveCalls = new Set<string>();
  private pendingUser?: { source: TimedSource; before: number; ended: boolean };
  private frameActive = false;
  private preparedComponents?: Component[];

  constructor(private readonly session: ExtensionContext["sessionManager"]) {}

  private sources(): TimedSource[] {
    return this.session.buildContextEntries().flatMap(entry =>
      sessionEntryToContextMessages(entry).map(message => ({
        message, time: validTime("timestamp" in message ? message.timestamp : undefined) ?? entry.timestamp,
      })));
  }

  /** Include the current unpersisted user and streamed tool IDs before UI delivery. */
  observe(message: Message, ended = false): void {
    this.preparedComponents = undefined;
    if (message.role === "user") {
      if (!ended) {
        this.pendingUser = {
          source: { message, time: message.timestamp },
          before: this.sources().filter(source => source.message.role === "user").length,
          ended: false,
        };
      } else if (this.pendingUser) {
        this.pendingUser.ended = true;
      }
    }
    if (message.role === "assistant") {
      for (const block of message.content) {
        if (block.type === "toolCall") this.liveCalls.add(block.id);
      }
    }
  }

  /** Forget ephemeral identities when the selected history changes. */
  reset(): void {
    this.preparedComponents = undefined;
    this.pendingUser = undefined;
    this.liveCalls.clear();
    this.orderedLabels = new WeakMap();
    this.messageTimes = new WeakMap();
    this.starts.clear();
    this.owners.clear();
  }

  /** Share one history correlation across the panels measured in a native frame. */
  beginFrame(): void {
    this.frameActive = true;
    this.preparedComponents = undefined;
  }
  /** Rebuild from the current branch, never abandoned entries elsewhere in the file. */
  prepare(components: Component[]): void {
    if (this.frameActive && this.preparedComponents === components) return;
    this.preparedComponents = components;
    const sources = this.sources();
    this.messageTimes = new WeakMap(sources.map(source => [source.message, source.time]));
    const users = sources.filter(source => source.message.role === "user");
    if (this.pendingUser?.ended && users.length > this.pendingUser.before) this.pendingUser = undefined;
    const slots = users.flatMap(userSlots);
    const nativeUsers = components.filter(component =>
      component.constructor.name === "UserMessageComponent" || component.constructor.name === "SkillInvocationMessageComponent");
    if (nativeUsers.length !== slots.length && this.pendingUser) slots.push(...userSlots(this.pendingUser.source));
    this.orderedLabels = new WeakMap();
    if (nativeUsers.length === slots.length) {
      // Text is a compatibility check after ordinal association, never an identity key.
      const matches = nativeUsers.every((component, index) => {
        const slot = slots[index];
        return component.constructor.name === slot.kind &&
          (slot.text === undefined || (component as Component & { text?: unknown }).text === slot.text);
      });
      if (matches) nativeUsers.forEach((component, index) => this.orderedLabels.set(component, timestampLabel(slots[index].time)));
    }
    const bash = sources.filter(source => source.message.role === "bashExecution");
    const nativeBash = components.filter(component => component.constructor.name === "BashExecutionComponent");
    if (nativeBash.length === bash.length && nativeBash.every((component, index) =>
      (component as Component & { command?: unknown }).command === (bash[index].message as { command: string }).command)) {
      nativeBash.forEach((component, index) => this.orderedLabels.set(component, timestampLabel(bash[index].time)));
    }
    this.starts.clear();
    for (const entry of this.session.getBranch()) {
      if (entry.type !== "custom" || entry.customType !== TOOL_START_ENTRY || !entry.data || typeof entry.data !== "object") continue;
      const data = entry.data as { toolCallId?: unknown; time?: unknown };
      const time = validTime(data.time);
      if (typeof data.toolCallId === "string" && time !== undefined) this.starts.set(data.toolCallId, time);
    }
    this.owners.clear();
    for (const { message, time } of sources) {
      if (message.role !== "assistant") continue;
      for (const block of message.content) if (block.type === "toolCall") this.owners.set(block.id, time);
    }
  }

  /** Reject changed private metadata before relying on it for a label. */
  check(component: Component): void {
    const name = component.constructor.name;
    const native = component as Component & { text?: unknown; lastMessage?: unknown; toolCallId?: unknown; message?: unknown; entry?: unknown; command?: unknown };
    const hasMessage = ["CustomMessageComponent", "BranchSummaryMessageComponent", "CompactionSummaryMessageComponent"].includes(name);
    if ((name === "UserMessageComponent" && typeof native.text !== "string") ||
        (name === "BashExecutionComponent" && typeof native.command !== "string") ||
        (name === "AssistantMessageComponent" && (!("lastMessage" in native) ||
          (native.lastMessage !== undefined && (!native.lastMessage || typeof native.lastMessage !== "object")))) ||
        (name === "ToolExecutionComponent" && typeof native.toolCallId !== "string") ||
        (hasMessage && (!native.message || typeof native.message !== "object")) ||
        (name === "CustomEntryComponent" && (!native.entry || typeof native.entry !== "object"))) {
      throw new Error("Pi's message timestamp metadata is not supported");
    }
  }

  /** Resolve original time or an explicit unknown/legacy approximation. */
  label(component: Component): string {
    const name = component.constructor.name;
    const native = component as Component & {
      lastMessage?: object & { timestamp?: unknown };
      message?: object & { timestamp?: unknown };
      entry?: { timestamp?: unknown };
      toolCallId?: string;
    };
    if (name === "UserMessageComponent" || name === "SkillInvocationMessageComponent" || name === "BashExecutionComponent") {
      return this.orderedLabels.get(component) ?? "";
    }
    if (name === "ToolExecutionComponent") {
      const id = native.toolCallId!;
      const start = this.starts.get(id);
      if (start !== undefined) return timestampLabel(start);
      if (this.liveCalls.has(id)) return "";
      const owner = this.owners.get(id);
      return validTime(owner) === undefined ? "" : "~" + timestampLabel(owner);
    }
    const message = name === "AssistantMessageComponent" ? native.lastMessage : native.message;
    return timestampLabel(message ? validTime(message.timestamp) ?? this.messageTimes.get(message) : native.entry?.timestamp);
  }
}

// Reserve the glyph's painted overhang, without a label or surrounding frame.
const COPY_CONTROL = "⧉ ";
const COPY_CONTROL_WIDTH = visibleWidth(COPY_CONTROL);
/** Keep message text full-width, with a clock above and copy action below. */
export class CompactMessage extends Container {
  private top = 0;
  private contentWidth = 0;
  private contentHeight = 0;
  private hasClock = false;
  private headerRows = 0;
  private bodyRows = 0;
  private copyRow?: number;
  private copyColumn?: number;
  private copyPressed = false;
  private leadingRows = 0;
  private prepared?: { width: number; content: string[]; lines: string[] };
  private readonly nativeCache: NativeRenderCache;
  private formatted?: { width: number; time: string; copy: string; gutter: number; theme: Theme; version: number; top: number; lines: string[] };

  constructor(private readonly component: Component, private readonly label: () => string,
    private readonly theme: () => Theme, private readonly gutter: () => number,
    private readonly show: () => boolean, private readonly copy?: () => void,
    private readonly showCopy: () => boolean = () => true) {
    super();
    this.addChild(component);
    this.nativeCache = new NativeRenderCache(component);
  }

  /** Prepare one visible block and its separator once per document render. */
  prepare(width: number, separate: boolean): boolean {
    const lines = this.renderContent(width);
    const leading = separate && lines.length > 0 ? 1 : 0;
    if (this.prepared?.width !== width || this.prepared.content !== lines || this.leadingRows !== leading) {
      this.prepared = { width, content: lines, lines: leading ? ["", ...lines] : lines };
    }
    this.leadingRows = leading;
    return lines.length > 0;
  }

  override render(width: number): string[] {
    if (this.prepared?.width === width) return this.prepared.lines;
    this.leadingRows = 0;
    return this.renderContent(width);
  }

  /** Exclude presentation rows when mapping saved-text search matches. */
  searchClock(): { row: number; column: number; footerRow?: number } | undefined {
    if (!this.hasClock && this.copyRow === undefined) return undefined;
    return {
      row: this.hasClock ? this.leadingRows : -1, column: 0,
      ...(this.copyRow === undefined ? {} : { footerRow: this.leadingRows + this.copyRow }),
    };
  }
  private renderContent(width: number): string[] {
    const label = this.label();
    const gutter = this.gutter();
    const theme = this.theme();
    // Only the scrollbar needs a side gutter; controls have their own rows.
    this.contentWidth = Math.max(1, width - gutter);
    const time = label && this.show() && visibleWidth(label) + 1 <= this.contentWidth ? " " + label : "";
    const copy = label && this.copy && this.showCopy() && this.contentWidth >= COPY_CONTROL_WIDTH ? COPY_CONTROL : "";
    const content = this.nativeCache.render(this.contentWidth, theme);
    this.contentHeight = content.length;
    const cached = this.formatted;
    if (cached?.width === width && cached.time === time && cached.copy === copy && cached.gutter === gutter && cached.theme === theme &&
      cached.version === this.nativeCache.version) {
      this.top = cached.top;
      return cached.lines;
    }
    this.formatted = undefined;
    this.top = 0;
    this.hasClock = false;
    this.headerRows = 0;
    this.bodyRows = 0;
    this.copyRow = undefined;
    this.copyColumn = undefined;
    let end = content.length;
    // Image protocols need every placement row. Keep their native block intact.
    if (!this.nativeCache.hasImagePlacement) {
      while (this.top < end && blank(content[this.top])) this.top++;
      while (end > this.top && blank(content[end - 1])) end--;
    }
    const body = content.slice(this.top, end);
    if (!body.length) return body;
    if (!this.nativeCache.hasImagePlacement) {
      // User message zones live on native padding rows. Keep those shell markers.
      const zones = (rows: string[]): string => rows.join("").match(/\x1b\]133;[ABC](?:\x07|\x1b\\)/g)?.join("") ?? "";
      body[0] = zones(content.slice(0, this.top)) + body[0];
      body[body.length - 1] += zones(content.slice(end));
    }
    this.hasClock = Boolean(time);
    this.headerRows = time ? 1 : 0;
    this.bodyRows = body.length;
    const lines = time ? [theme.fg("dim", time), ...body] : body;
    if (copy) {
      this.copyRow = lines.length;
      this.copyColumn = this.contentWidth - COPY_CONTROL_WIDTH;
      lines.push(" ".repeat(this.copyColumn) + theme.style(copy, { fg: "dim", dim: true }));
    }
    this.formatted = { width, time, copy, gutter, theme, version: this.nativeCache.version, top: this.top, lines };
    return lines;
  }

  override handleMouse(event: TuiMouseEvent): ReturnType<Container["handleMouse"]> {
    const target = { component: this, originX: event.screenX - event.x, originY: event.screenY - event.y,
      width: event.width, height: event.height };
    const onCopy = this.copyColumn !== undefined && this.copyRow !== undefined &&
      event.y === this.leadingRows + this.copyRow && event.x >= this.copyColumn &&
      event.x < this.copyColumn + COPY_CONTROL_WIDTH && event.button === "left";
    if (onCopy && event.type === "press") {
      this.copyPressed = true;
      return { handled: true, capture: true, target };
    }
    if (onCopy && event.type === "click") {
      this.copyPressed = false;
      this.copy?.();
      return { handled: true, target };
    }
    if (this.copyPressed) {
      if (event.type === "release") this.copyPressed = false;
      return { handled: true, target };
    }
    const bodyRow = event.y - this.leadingRows - this.headerRows;
    if (bodyRow < 0 || bodyRow >= this.bodyRows || event.x >= this.contentWidth) return undefined;
    return super.handleMouse({
      ...event, y: bodyRow + this.top, width: this.contentWidth, height: this.contentHeight,
    });
  }

  /** Release native invalidation subscriptions without changing the source document. */
  dispose(): void {
    this.nativeCache.dispose();
    this.prepared = undefined;
    this.formatted = undefined;
  }
  override invalidate(): void {
    this.prepared = undefined;
    this.formatted = undefined;
    this.component.invalidate();
  }
}
