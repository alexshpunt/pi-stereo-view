import { writeFile } from "node:fs/promises";
import path from "node:path";
import { setImmediate } from "node:timers/promises";
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Container, Text, type Component, type TUI } from "@earendil-works/pi-tui";

type Host = TUI & { getScreenLines(): string[]; layoutRoot?: Container };
type Assistant = Container & { contentContainer: Container; lastMessage?: unknown; updateContent(message: unknown): void };

/**
 * Release a settled reply's native children the way Pi-Bolt 1.1.6+ does after it drew the reply itself
 * (HOST_COMPACTION=bolt, with Pi-Bolt's restore methods), or without any restore method (HOST_COMPACTION=unknown),
 * as an unknown host change would. Records the screen after each step and asks for a second turn.
 */
export default function hostCompactionProbe(pi: ExtensionAPI): void {
  let tui: Host;
  let turn = 0;
  const frames: Record<string, string[]> = {};
  const capture = async (): Promise<string[]> => {
    tui.requestRender(true);
    await setImmediate();
    await setImmediate();
    return tui.getScreenLines();
  };
  const assistants = (): Assistant[] => {
    const found: Assistant[] = [];
    const seen = new Set<Component>();
    const walk = (component: Component | undefined): void => {
      if (!component || seen.has(component)) return;
      seen.add(component);
      // The split's assistant views inherit from their native reply; only the reply's own prototype is the class's.
      if (component.constructor.name === "AssistantMessageComponent" && Object.hasOwn(Object.getPrototypeOf(component), "constructor")) {
        found.push(component as Assistant);
      }
      for (const child of (component as Container).children ?? []) walk(child);
    };
    walk(tui.layoutRoot);
    return found;
  };
  const compact = (assistant: Assistant): void => {
    let compacted = true;
    const empty = new Container();
    assistant.contentContainer = empty;
    assistant.clear();
    assistant.addChild(empty);
    // Pi rebuilds a reply's children whenever it is invalidated. Keep them missing, so only the host's own
    // restore method (Pi-Bolt) can bring them back, and an unknown host change keeps them missing for good.
    const rebuild = assistant.updateContent.bind(assistant);
    Object.assign(assistant, { updateContent: () => {} });
    if (process.env.HOST_COMPACTION !== "bolt") return;
    Object.assign(assistant, {
      isCompacted: () => compacted,
      thaw: () => {
        compacted = false;
        rebuild(assistant.lastMessage);
      },
    });
  };
  pi.on("session_start", async (_event, ctx) => {
    let finish = (): void => {};
    await ctx.ui.custom<void>((host, _theme, _keys, done) => {
      tui = host as Host;
      finish = done;
      return new Text("", 0, 0);
    }, { overlay: true, overlayOptions: { visible: () => false, nonCapturing: true }, onHandle: () => finish() });
  });
  pi.on("agent_before_settle", async (_event, ctx) => {
    if (turn === 1) {
      frames.before = await capture();
      const [assistant] = assistants();
      if (!assistant) throw new Error("Missing the native reply to compact");
      compact(assistant);
      frames.compacted = await capture();
      frames.later = await capture();
      pi.sendUserMessage("SECOND USER", { deliverAs: "followUp" });
      return;
    }
    frames.second = await capture();
    await writeFile(path.join(ctx.cwd, "host-compaction-frames.json"), JSON.stringify(frames));
  });
  pi.registerProvider("host-compaction-test", {
    name: "Offline host compaction test", api: "openai-completions", apiKey: "offline",
    baseUrl: "http://host-compaction-test.invalid",
    models: [{ id: "host-compaction", name: "Offline host compaction", reasoning: true, input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 4096 }],
    streamSimple(model) {
      turn++;
      const stream = createAssistantMessageEventStream();
      const output: AssistantMessage = {
        role: "assistant", content: [{ type: "thinking", thinking: `REASONING ${turn}` }, { type: "text", text: `ANSWER ${turn}` }],
        api: model.api, provider: model.provider, model: model.id,
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: "stop", timestamp: Date.now(),
      };
      queueMicrotask(() => {
        stream.push({ type: "start", partial: output });
        stream.push({ type: "done", reason: "stop", message: output });
        stream.end();
      });
      return stream;
    },
  });
}
