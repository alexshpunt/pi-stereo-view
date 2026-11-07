import { parseSkillBlock, sessionEntryToContextMessages, type ExtensionContext, type Theme } from "@earendil-works/pi-coding-agent";
import {
  Container, stripTerminalSequences, visibleWidth,
  type Component, type TuiMouseEvent,
} from "@earendil-works/pi-tui";

import { NativeRenderCache } from "./render-cache.js";
type Message = ReturnType<typeof sessionEntryToContextMessages>[number];
type TimedSource = { message: Message; time: unknown };
type UserSlot = { kind: string; text?: string; time: unknown };
interface BranchTimes {
  messageTimes: WeakMap<object, unknown>; users: TimedSource[]; bash: TimedSource[];
  starts: Map<string, number>; owners: Map<string, unknown>;
}

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
  // Every visible block asks for its clock on every frame.
  let label = labels.get(time);
  if (label !== undefined) return label;
  const date = new Date(time);
  label = [date.getHours(), date.getMinutes(), date.getSeconds()]
    .map(part => String(part).padStart(2, "0")).join(":");
  if (labels.size >= 8192) labels.clear();
  labels.set(time, label);
  return label;
}
const labels = new Map<number, string>();

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
  private readonly liveUsers = new Map<number, TimedSource>();
  private frameActive = false;
  private preparedComponents?: Component[];

  constructor(private readonly session: ExtensionContext["sessionManager"]) {}

  private branch?: { leaf: object; sources: TimedSource[]; derived?: BranchTimes };

  /** Session entries are append-only, so one leaf entry identifies the whole active branch. */
  private leaf(): object | undefined {
    const leaf = typeof this.session.getLeafEntry === "function" ? this.session.getLeafEntry() : undefined;
    return leaf && typeof leaf === "object" ? leaf : undefined;
  }
  private sources(): TimedSource[] {
    const leaf = this.leaf();
    if (leaf && this.branch?.leaf === leaf) return this.branch.sources;
    const sources = this.session.buildContextEntries().flatMap(entry =>
      sessionEntryToContextMessages(entry).map(message => ({
        message, time: validTime("timestamp" in message ? message.timestamp : undefined) ?? entry.timestamp,
      })));
    this.branch = leaf ? { leaf, sources } : undefined;
    return sources;
  }
  /** Branch-derived lookups are rebuilt only when the active branch changes. */
  private times(): BranchTimes {
    const sources = this.sources();
    if (this.branch?.sources === sources && this.branch.derived) return this.branch.derived;
    const users = sources.filter(source => source.message.role === "user");
    const starts = new Map<string, number>();
    for (const entry of this.session.getBranch()) {
      if (entry.type !== "custom" || entry.customType !== TOOL_START_ENTRY || !entry.data || typeof entry.data !== "object") continue;
      const data = entry.data as { toolCallId?: unknown; time?: unknown };
      const time = validTime(data.time);
      if (typeof data.toolCallId === "string" && time !== undefined) starts.set(data.toolCallId, time);
    }
    const owners = new Map<string, unknown>();
    for (const { message, time } of sources) {
      if (message.role !== "assistant") continue;
      for (const block of message.content) if (block.type === "toolCall") owners.set(block.id, time);
    }
    const derived = {
      messageTimes: new WeakMap(sources.map(source => [source.message, source.time])), users,
      bash: sources.filter(source => source.message.role === "bashExecution"), starts, owners,
    };
    if (this.branch?.sources === sources) this.branch.derived = derived;
    return derived;
  }

  /** Include the current unpersisted user and streamed tool IDs before UI delivery. */
  observe(message: Message, ended = false): void {
    this.preparedComponents = undefined;
    if (message.role === "user") {
      if (!ended) {
        this.pendingUser = {
          source: { message: { ...message, content: typeof message.content === "string" ? message.content : message.content.map(block => ({ ...block })) }, time: message.timestamp },
          before: this.sources().filter(source => source.message.role === "user").length,
          ended: false,
        };
        this.liveUsers.set(this.pendingUser.before, this.pendingUser.source);
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
    this.liveUsers.clear();
    this.orderedLabels = new WeakMap();
    this.messageTimes = new WeakMap();
    this.branch = undefined;
    this.starts = new Map();
    this.owners = new Map();
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
    const { messageTimes, users, bash, starts, owners } = this.times();
    this.messageTimes = messageTimes;
    if (this.pendingUser?.ended && users.length > this.pendingUser.before) this.pendingUser = undefined;
    const nativeUsers = components.filter(component =>
      component.constructor.name === "UserMessageComponent" || component.constructor.name === "SkillInvocationMessageComponent");
    const sources = users.slice();
    if (this.pendingUser && users.length === this.pendingUser.before) sources.push(this.pendingUser.source);
    const associations: Array<{ component: Component; time: unknown }> = [];
    let position = 0;
    let matched = true;
    for (const [index, source] of sources.entries()) {
      const live = this.liveUsers.get(index);
      // An extension may replace a message after Pi rendered it. Use the observed
      // version only for the same timestamp and only if it matches native text.
      const candidates = [userSlots(source)];
      if (live && validTime(live.time) !== undefined && validTime(live.time) === validTime(source.time)) {
        candidates.push(userSlots(live));
      }
      const slots = candidates.find(candidate => candidate.every((slot, offset) => {
        const component = nativeUsers[position + offset];
        return component?.constructor.name === slot.kind &&
          (slot.text === undefined || (component as Component & { text?: unknown }).text === slot.text);
      }));
      if (!slots) { matched = false; break; }
      slots.forEach((slot, offset) => associations.push({ component: nativeUsers[position + offset], time: slot.time }));
      position += slots.length;
    }
    this.orderedLabels = new WeakMap();
    if (matched && position === nativeUsers.length) {
      for (const { component, time } of associations) this.orderedLabels.set(component, timestampLabel(time));
    }
    const nativeBash = components.filter(component => component.constructor.name === "BashExecutionComponent");
    if (nativeBash.length === bash.length && nativeBash.every((component, index) =>
      (component as Component & { command?: unknown }).command === (bash[index].message as { command: string }).command)) {
      nativeBash.forEach((component, index) => this.orderedLabels.set(component, timestampLabel(bash[index].time)));
    }
    this.starts = starts;
    this.owners = owners;
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

const TEXT_COPY_CONTROL = "[Copy]";
// CGJ avoids xterm's single-codepoint rescaling; the trailing cell reserves overhang.
const ICON_COPY_CONTROL = "⧉\u034f ";
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
  private copyWidth = 0;
  private copyPressed = false;
  private leadingRows = 0;
  private prepared?: { width: number; content: string[]; lines: string[] };
  private readonly nativeCache: NativeRenderCache;
  private formatted?: { width: number; time: string; copy: string; gutter: number; theme: Theme; version: number; top: number; lines: string[] };

  constructor(private readonly component: Component, private readonly label: () => string,
    private readonly theme: () => Theme, private readonly gutter: () => number,
    private readonly show: () => boolean, private readonly copy?: () => void,
    private readonly showCopy: () => boolean = () => true,
    private readonly buttonStyle: () => "icons" | "text" = () => "text") {
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
    const control = this.buttonStyle() === "icons" ? ICON_COPY_CONTROL : TEXT_COPY_CONTROL;
    const controlWidth = visibleWidth(control);
    const copy = label && this.copy && this.showCopy() && this.contentWidth >= controlWidth ? control : "";
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
      this.copyWidth = controlWidth;
      this.copyColumn = this.contentWidth - controlWidth;
      lines.push(" ".repeat(this.copyColumn) + theme.style(copy, { fg: "dim", dim: this.buttonStyle() === "icons" }));
    }
    this.formatted = { width, time, copy, gutter, theme, version: this.nativeCache.version, top: this.top, lines };
    return lines;
  }

  override handleMouse(event: TuiMouseEvent): ReturnType<Container["handleMouse"]> {
    const target = { component: this, originX: event.screenX - event.x, originY: event.screenY - event.y,
      width: event.width, height: event.height };
    const onCopy = this.copyColumn !== undefined && this.copyRow !== undefined &&
      event.y === this.leadingRows + this.copyRow && event.x >= this.copyColumn &&
      event.x < this.copyColumn + this.copyWidth && event.button === "left";
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
