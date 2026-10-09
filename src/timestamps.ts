import { parseSkillBlock, sessionEntryToContextMessages, type ExtensionContext, type Theme } from "@earendil-works/pi-coding-agent";
import { Container, Text, type Component } from "@earendil-works/pi-tui";

type Message = ReturnType<typeof sessionEntryToContextMessages>[number];
type TimedSource = { message: Message; time: unknown };
type UserSlot = { kind: string; text?: string; time: unknown };

/** Display-only session entry: { toolCallId: string, time: epoch milliseconds }. */
export const TOOL_START_ENTRY = "pi-agent-transcript/tool-start";

const validTime = (value: unknown): number | undefined => {
  const time = typeof value === "number" ? value : typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isFinite(time) && Number.isFinite(new Date(time).getTime()) ? time : undefined;
};

/** Format a reliable source in the process's local zone; never substitute now. */
export function timestampLabel(value: unknown): string {
  const time = validTime(value);
  if (time === undefined) return "--:--:--";
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

  constructor(private readonly session: ExtensionContext["sessionManager"]) {}

  private sources(): TimedSource[] {
    return this.session.buildContextEntries().flatMap(entry =>
      sessionEntryToContextMessages(entry).map(message => ({
        message, time: validTime("timestamp" in message ? message.timestamp : undefined) ?? entry.timestamp,
      })));
  }

  /** Include the current unpersisted user and streamed tool IDs before UI delivery. */
  observe(message: Message, ended = false): void {
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
    this.pendingUser = undefined;
    this.liveCalls.clear();
    this.orderedLabels = new WeakMap();
    this.messageTimes = new WeakMap();
    this.starts.clear();
    this.owners.clear();
  }

  /** Rebuild from the current branch, never abandoned entries elsewhere in the file. */
  prepare(components: Component[]): void {
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
      return this.orderedLabels.get(component) ?? "--:--:--";
    }
    if (name === "ToolExecutionComponent") {
      const id = native.toolCallId!;
      const start = this.starts.get(id);
      if (start !== undefined) return timestampLabel(start);
      if (this.liveCalls.has(id)) return "--:--:--";
      const owner = this.owners.get(id);
      return validTime(owner) === undefined ? "--:--:--" : "~" + timestampLabel(owner);
    }
    const message = name === "AssistantMessageComponent" ? native.lastMessage : native.message;
    return timestampLabel(message ? validTime(message.timestamp) ?? this.messageTimes.get(message) : native.entry?.timestamp);
  }
}

/** Add one dim row while retaining the native component and its mouse layout. */
export class TimestampedMessage extends Container {
  private readonly timeRow: Component;

  constructor(private readonly component: Component, label: () => string, theme: () => Theme, gutter: () => number) {
    super();
    this.timeRow = {
      render: width => {
        const time = label();
        return new Text(theme().fg("dim", time.padStart(Math.max(time.length, width - gutter()))), 0, 0).render(width);
      },
      invalidate() {},
    };
    this.addChild(component);
  }

  override render(width: number): string[] {
    // Native self-rendered tools may intentionally return no visible block.
    // Render once, preserving its exact lines and the original mouse target.
    const content = this.component.render(width);
    this.children = content.length ? [this.timeRow, this.component] : [this.component];
    return content.length ? [...this.timeRow.render(width), ...content] : content;
  }
}
