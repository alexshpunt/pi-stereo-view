import { writeFile } from "node:fs/promises";
import path from "node:path";
import { setImmediate } from "node:timers/promises";
import { createAssistantMessageEventStream, type AssistantMessage, type AssistantMessageEvent } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, Text, type TUI } from "@earendil-works/pi-tui";

type TestHost = TUI & { getScreenLines?(): string[]; handleTerminalInput(data: string): void };
export interface StreamingFrame { turn: number; phase: string; lines: string[] }

/** Stream real native thinking/text updates and record the split before shutdown restores native history. */
export default function streamingLayoutProbe(pi: ExtensionAPI): void {
  let tui: TestHost | undefined;
  let turn = 0;
  let acknowledge: (() => void) | undefined;
  let captures = Promise.resolve();
  const frames: StreamingFrame[] = [];
  const capture = async (phase: string): Promise<void> => {
    if (!tui) throw new Error("The streaming layout probe requires an interactive terminal");
    tui.requestRender(true);
    await setImmediate();
    const lines = tui.getScreenLines?.() ?? tui.render(tui.terminal.columns);
    frames.push({ turn, phase, lines: lines.map(stripTerminalSequences) });
  };
  pi.on("session_start", async (_event, ctx) => {
    let finish = (): void => {};
    await ctx.ui.custom<void>((host, _theme, _keys, done) => {
      tui = host as TestHost;
      finish = done;
      return new Text("", 0, 0);
    }, { overlay: true, overlayOptions: { visible: () => false, nonCapturing: true }, onHandle: () => finish() });
    await capture("startup");
  });
  pi.on("message_update", event => {
    const painted = acknowledge;
    acknowledge = undefined;
    // Return before yielding: Pi applies its native component update after notifying extensions.
    captures = captures.then(async () => {
      await setImmediate();
      await capture(event.assistantMessageEvent.type);
      painted?.();
    });
  });
  pi.on("agent_before_settle", async (_event, ctx) => {
    await captures;
    await capture("settled");
    if (turn === 1) {
      pi.sendUserMessage("STREAM USER 2", { deliverAs: "followUp" });
      return;
    }
    // The existing shortcut must still round-trip through the untouched native transcript.
    tui!.handleTerminalInput("\x1b[116;7u");
    await capture("combined");
    tui!.handleTerminalInput("\x1b[116;7u");
    await capture("restored");
    await writeFile(path.join(ctx.cwd, "streaming-layout-frames.json"), JSON.stringify(frames));
  });
  pi.registerProvider("streaming-layout-test", {
    name: "Offline streaming layout test", api: "openai-completions", apiKey: "offline",
    baseUrl: "http://streaming-layout-test.invalid",
    models: [{ id: "streaming-layout", name: "Offline streaming layout", reasoning: true, input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 4096 }],
    streamSimple(model, _context, options) {
      turn++;
      const stream = createAssistantMessageEventStream();
      const output: AssistantMessage = {
        role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id,
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: "stop", timestamp: Date.now(),
      };
      const emit = async (event: AssistantMessageEvent): Promise<void> => {
        if (options?.signal?.aborted) throw new Error("Stream aborted");
        // Each delta waits for its native frame, not a wall-clock delay or a mocked renderer.
        await new Promise<void>(resolve => { acknowledge = resolve; stream.push(event); });
      };
      void (async () => {
        stream.push({ type: "start", partial: output });
        if (process.env.TRANSCRIPT_STREAM_THINKING === "1") {
          const contentIndex = output.content.length;
          const block = { type: "thinking" as const, thinking: "" };
          output.content.push(block);
          await emit({ type: "thinking_start", contentIndex, partial: output });
          for (const delta of [`REASONING ${turn}`, " FINISHED"]) {
            block.thinking += delta;
            await emit({ type: "thinking_delta", contentIndex, delta, partial: output });
          }
          await emit({ type: "thinking_end", contentIndex, content: block.thinking, partial: output });
        }
        const contentIndex = output.content.length;
        const block = { type: "text" as const, text: "" };
        output.content.push(block);
        await emit({ type: "text_start", contentIndex, partial: output });
        for (const delta of [`ANSWER ${turn}`, " FINISHED"]) {
          block.text += delta;
          await emit({ type: "text_delta", contentIndex, delta, partial: output });
        }
        await emit({ type: "text_end", contentIndex, content: block.text, partial: output });
        stream.push({ type: "done", reason: "stop", message: output });
        stream.end();
      })().catch(error => {
        output.stopReason = options?.signal?.aborted ? "aborted" : "error";
        output.errorMessage = String(error);
        stream.push({ type: "error", reason: output.stopReason, error: output });
        stream.end();
      });
      return stream;
    },
  });
}
