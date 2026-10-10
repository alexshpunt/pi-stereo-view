import { writeFile } from "node:fs/promises";
import path from "node:path";
import { Session } from "node:inspector/promises";
import { performance } from "node:perf_hooks";
import { setImmediate } from "node:timers/promises";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Container, ScrollView, stripTerminalSequences, Text, type TUI } from "@earendil-works/pi-tui";

type Host = TUI & { layoutRoot?: Container; getScreenLines(): string[]; handleTerminalInput(data: string): void };
interface Sample { action: string; emittedFrameMs: number; cpuMs: number; documents: number; timestampIndexes: number; sourceInvalidations: number; paneRows: number; bytes: number }

/** Measure real native frame emission and capture V8 profiles without changing Pi source. */
export default function renderingProfile(pi: ExtensionAPI): void {
  let tui: Host;
  const samples: Sample[] = [];
  let documents = 0;
  let timestampIndexes = 0;
  let sourceInvalidations = 0;
  let paneRows = 0;
  let bytes = 0;
  let frame: (() => void) | undefined;
  const count = Math.max(3, Number(process.env.PROFILE_SAMPLES ?? 12));
  const capture = async (): Promise<string[]> => {
    tui.requestRender(true);
    await setImmediate();
    return tui.getScreenLines();
  };
  const containers = (): Container[] => {
    const found = new Set<Container>();
    const walk = (component: Container): void => {
      if (found.has(component)) return;
      found.add(component);
      for (const child of component.children ?? []) if (child instanceof Container) walk(child);
    };
    if (tui.layoutRoot) walk(tui.layoutRoot);
    return [...found];
  };
  const paint = (action: () => void): Promise<void> => new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { frame = undefined; reject(new Error("No emitted frame within 30s")); }, 30_000);
    frame = () => { clearTimeout(timeout); frame = undefined; resolve(); };
    try { action(); }
    catch (error) { clearTimeout(timeout); frame = undefined; reject(error); }
  });
  pi.on("session_start", async (_event, ctx) => {
    let finish = (): void => {};
    await ctx.ui.custom<void>((host, _theme, _keys, done) => {
      tui = host as Host;
      finish = done;
      return new Text("", 0, 0);
    }, { overlay: true, overlayOptions: { visible: () => false, nonCapturing: true }, onHandle: () => finish() });
  });
  pi.on("agent_before_settle", async (_event, ctx) => {
    const write = tui.terminal.write;
    const restoreCounters: (() => void)[] = [];
    tui.terminal.write = data => {
      write.call(tui.terminal, data);
      bytes += Buffer.byteLength(data);
      if (data.includes("\x1b[?2026l")) frame?.();
    };
    const inspector = new Session();
    const measure = async (name: string, action: () => void): Promise<void> => {
      paneRows = 0;
      const before = { documents, timestampIndexes, sourceInvalidations, bytes };
      const cpu = process.cpuUsage();
      const start = performance.now();
      await paint(action);
      const usage = process.cpuUsage(cpu);
      samples.push({ action: name, emittedFrameMs: performance.now() - start, cpuMs: (usage.user + usage.system) / 1000,
        documents: documents - before.documents, timestampIndexes: timestampIndexes - before.timestampIndexes,
        sourceInvalidations: sourceInvalidations - before.sourceInvalidations, paneRows, bytes: bytes - before.bytes });
    };
    const phases: Record<string, string[]> = {};
    try {
      inspector.connect();
      await capture();
      const mounted = containers();
      for (const pane of mounted.filter(component => component.children.length === 2 && component.children[1] instanceof ScrollView)) {
        const render = pane.render;
        pane.render = width => {
          const lines = render.call(pane, width);
          paneRows = Math.max(paneRows, lines.length);
          return lines;
        };
        restoreCounters.push(() => { pane.render = render; });
      }
      // Instrument the loader's actual instances; fixture imports have a separate module cache.
      const indexes = new Set<object>();
      for (const document of mounted.filter(component => component.constructor.name === "NativeDocument")) {
        const render = document.render;
        document.render = width => { documents++; return render.call(document, width); };
        restoreCounters.push(() => { document.render = render; });
        const index = Reflect.get(document, "timestamps") as { prepare(components: unknown[]): void };
        if (indexes.has(index)) continue;
        indexes.add(index);
        const prepare = index.prepare;
        index.prepare = components => { timestampIndexes++; return prepare.call(index, components); };
        restoreCounters.push(() => { index.prepare = prepare; });
      }
      const allViews = mounted.filter((component): component is ScrollView => component instanceof ScrollView);
      const combined = allViews.find(view => Reflect.get(view.children[0], "pane") === "combined");
      const nativeRoot = (combined ? Reflect.get(combined.children[0], "source") : allViews[0]?.children[0]) as Container;
      const messages = (nativeRoot?.children[2] as Container)?.children;
      if (!Array.isArray(messages)) throw new Error("Unsupported native history for profiling");
      const invalidate = nativeRoot.invalidate;
      nativeRoot.invalidate = () => { sourceInvalidations++; invalidate.call(nativeRoot); };
      restoreCounters.push(() => { nativeRoot.invalidate = invalidate; });
      for (const component of messages) if (component.constructor.name === "ToolExecutionComponent") {
        Reflect.get(component, "setExpanded").call(component, true);
      }
      // First invalidated frame exposes cold text/layout work, separately from warmed interaction.
      await measure("cold", () => { tui.layoutRoot?.invalidate(); tui.requestRender(true); });
      phases.initial = await capture();
      for (let index = 0; index < 3; index++) await paint(() => tui.requestRender(true));
      await inspector.post("Profiler.enable");
      await inspector.post("Profiler.start");
      for (let index = 0; index < count; index++) await measure("frame", () => tui.requestRender(true));
      ctx.ui.setEditorText("SYNTHETIC PROFILE DRAFT ");
      await capture();
      for (let index = 0; index < count; index++) await measure("typing", () => tui.handleTerminalInput(index % 2 ? "\x7f" : "x"));
      const components = containers();
      const views = components.filter((component): component is ScrollView => component instanceof ScrollView);
      const split = process.env.PROFILE_MODE === "columns" || process.env.PROFILE_MODE === "rows";
      const view = views.find(candidate => candidate.viewportHeight > 0 &&
        (!split || Reflect.get(candidate.children[0], "pane") === "chat"));
      if (!view) throw new Error("Missing visible native scroll view");
      for (let index = 0; index < count; index++) await measure("scroll", () => {
        view.scrollBy(index % 2 ? 3 : -3);
        tui.requestRender();
      });
      const { columns, rows } = process.stdout;
      try {
        for (let index = 0; index < Math.min(6, count); index++) await measure("resize", () => {
          process.stdout.columns = columns - (index % 2 ? 0 : 4);
          process.stdout.emit("resize");
        });
      } finally {
        process.stdout.columns = columns;
        process.stdout.rows = rows;
        process.stdout.emit("resize");
        await capture();
      }
      const assistant = messages.filter(component => component.constructor.name === "AssistantMessageComponent").at(-1) as
        (Container & { lastMessage: AssistantMessage; updateContent(message: AssistantMessage, streaming: boolean): void }) | undefined;
      if (!assistant) throw new Error("Missing native assistant update target");
      const original = assistant.lastMessage;
      for (let index = 0; index < count; index++) await measure("stream", () => {
        assistant.updateContent({ ...original, content: [{ type: "text", text: Array.from({ length: 80 }, (_, row) => "SYNTHETIC STREAM LINE " + row).join("\n") + "\nSYNTHETIC STREAM UPDATE " + index }] }, true);
        tui.requestRender();
      });
      assistant.updateContent(original, false);
      const tool = messages.filter(component => component.constructor.name === "ToolExecutionComponent").at(-1) as
        (Container & { updateResult(result: { content: { type: string; text: string }[]; isError: boolean }, partial: boolean): void }) | undefined;
      if (!tool) throw new Error("Missing saved native tool update target");
      for (let index = 0; index < count; index++) await measure("tool", () => {
        tool.updateResult({ content: [{ type: "text", text: Array.from({ length: Number(process.env.PROFILE_TOOL_LINES ?? 80) }, (_, row) => "SYNTHETIC TOOL UPDATE " + index + " line " + row).join("\n") }], isError: false }, true);
        tui.requestRender();
      });
      const { profile } = await inspector.post("Profiler.stop");
      await writeFile(path.join(ctx.cwd, "rendering.cpuprofile"), JSON.stringify(profile));
      phases.finished = await capture();
      const percentile = (values: number[], fraction: number): number => values.slice().sort((a, b) => a - b)[Math.ceil(values.length * fraction) - 1];
      const summary = Object.fromEntries([...new Set(samples.map(sample => sample.action))].map(action => {
        const group = samples.filter(sample => sample.action === action);
        return [action, { count: group.length, frameP50: percentile(group.map(sample => sample.emittedFrameMs), 0.5),
          frameP95: percentile(group.map(sample => sample.emittedFrameMs), 0.95), cpuP50: percentile(group.map(sample => sample.cpuMs), 0.5),
          cpuP95: percentile(group.map(sample => sample.cpuMs), 0.95), documents: group.map(sample => sample.documents),
          timestampIndexes: group.map(sample => sample.timestampIndexes), sourceInvalidations: group.map(sample => sample.sourceInvalidations), paneRows: group.map(sample => sample.paneRows) }];
      }));
      await writeFile(path.join(ctx.cwd, "rendering-measurements.json"), JSON.stringify({
        samples, summary, frames: phases, runtime: { node: process.version, pid: process.pid,
          mode: process.env.PROFILE_MODE, nativeComponents: components.length, samples: count,
          savedToolBlocks: messages.filter(component => component.constructor.name === "ToolExecutionComponent").length },
        draft: ctx.ui.getEditorText(), syntheticOnly: true,
        frameDefinition: "Action to synchronized terminal-frame emission, not compositor presentation; process CPU delta includes scheduling background work.",
        toolTarget: "Latest saved native tool, visible in Activity while following the end.",
        markers: phases.finished.map(stripTerminalSequences).filter(line => line.includes("SYNTHETIC")),
      }, null, 2));
    } finally {
      inspector.disconnect();
      tui.terminal.write = write;
      for (const restore of restoreCounters.reverse()) restore();
    }
  });
}
