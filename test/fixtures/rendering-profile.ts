import { writeFile } from "node:fs/promises";
import path from "node:path";
import { Session } from "node:inspector/promises";
import { performance } from "node:perf_hooks";
import { setImmediate } from "node:timers/promises";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Container, ScrollView, stripTerminalSequences, Text, type Component, type TUI } from "@earendil-works/pi-tui";

type Host = TUI & { layoutRoot?: Container; getScreenLines(): string[]; handleTerminalInput(data: string): void };
interface Sample { action: string; emittedFrameMs: number; cpuMs: number; documents: number; timestampIndexes: number; sourceInvalidations: number; paneRows: number; panePreviewCharacters: number; previewScrollRows: number; bytes: number; nativeMs: number; compactMs: number; documentMs: number }

/** Measure real native frame emission and capture V8 profiles without changing Pi source. */
export default function renderingProfile(pi: ExtensionAPI): void {
  let tui: Host;
  const samples: Sample[] = [];
  let documents = 0;
  let timestampIndexes = 0;
  let sourceInvalidations = 0;
  let paneRows = 0;
  let panePreviewCharacters = 0;
  let previewScrollRows = 0;
  let nativeMs = 0;
  let compactMs = 0;
  let documentMs = 0;
  let bytes = 0;
  let frame: (() => void) | undefined;
  let initialDisplay: { emittedFrameMs: number; cpuMs: number } | undefined;
  let restoreStartupWrite: (() => void) | undefined;
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
    // Initial history is constructed after session_start handlers finish.
    // Include that construction and remaining native initialization, not module loading.
    const start = performance.now();
    const cpu = process.cpuUsage();
    const write = tui.terminal.write;
    let output = "";
    restoreStartupWrite = () => { tui.terminal.write = write; };
    tui.terminal.write = data => {
      write.call(tui.terminal, data);
      output += data;
      if (!data.includes("\x1b[?2026l")) return;
      if (stripTerminalSequences(output).includes("SYNTHETIC TOOL " + (Number(process.env.PROFILE_HISTORY) - 1) + " line")) {
        const usage = process.cpuUsage(cpu);
        initialDisplay = { emittedFrameMs: performance.now() - start, cpuMs: (usage.user + usage.system) / 1000 };
        restoreStartupWrite?.();
        restoreStartupWrite = undefined;
      }
      output = "";
    };
  });
  pi.on("agent_before_settle", async (_event, ctx) => {
    restoreStartupWrite?.();
    restoreStartupWrite = undefined;
    if (!initialDisplay) throw new Error("The restored synthetic history was not observed before setup");
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
      panePreviewCharacters = 0;
      previewScrollRows = 0;
      const before = { documents, timestampIndexes, sourceInvalidations, bytes, nativeMs, compactMs, documentMs };
      const cpu = process.cpuUsage();
      const start = performance.now();
      await paint(action);
      const usage = process.cpuUsage(cpu);
      samples.push({ action: name, emittedFrameMs: performance.now() - start, cpuMs: (usage.user + usage.system) / 1000,
        documents: documents - before.documents, timestampIndexes: timestampIndexes - before.timestampIndexes,
        sourceInvalidations: sourceInvalidations - before.sourceInvalidations, paneRows, panePreviewCharacters, previewScrollRows, bytes: bytes - before.bytes,
        nativeMs: nativeMs - before.nativeMs, compactMs: compactMs - before.compactMs, documentMs: documentMs - before.documentMs });
    };
    const phases: Record<string, string[]> = {};
    try {
      inspector.connect();
      await capture();
      const mounted = containers();
      for (const pane of mounted.filter(component => component.children.length === 2 && component.children[1] instanceof ScrollView)) {
        const render = pane.render;
        const view = pane.children[1] as ScrollView;
        const scrollRender = view.render;
        let previewing = false;
        view.render = width => {
          const lines = scrollRender.call(view, width);
          if (previewing) previewScrollRows += lines.length;
          return lines;
        };
        pane.render = width => {
          previewing = true;
          try {
            const lines = render.call(pane, width);
            paneRows = Math.max(paneRows, lines.length);
            panePreviewCharacters += lines.reduce((total, line) => total + line.length, 0);
            return lines;
          } finally { previewing = false; }
        };
        restoreCounters.push(() => { pane.render = render; view.render = scrollRender; });
      }
      // Instrument the loader's actual instances; fixture imports have a separate module cache.
      const indexes = new Set<object>();
      for (const document of mounted.filter(component => component.constructor.name === "NativeDocument")) {
        const render = document.render;
        document.render = width => {
          documents++;
          const start = performance.now();
          try { return render.call(document, width); }
          finally { documentMs += performance.now() - start; }
        };
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
      // Time the actual projected native owners, without suppressing any render calls.
      const compact = mounted.filter(component => component.constructor.name === "CompactMessage");
      const owners = new Set<Component>(compact.length ?
        compact.map(component => Reflect.get(component, "component") as Component) : messages);
      for (const owner of owners) {
        const render = owner.render;
        owner.render = width => {
          const start = performance.now();
          try { return render.call(owner, width); }
          finally { nativeMs += performance.now() - start; }
        };
        restoreCounters.push(() => { owner.render = render; });
      }
      for (const component of compact) {
        const prepare = Reflect.get(component, "prepare") as (width: number, separate: boolean) => boolean;
        Reflect.set(component, "prepare", (width: number, separate: boolean) => {
          const start = performance.now();
          const nativeBefore = nativeMs;
          try { return prepare.call(component, width, separate); }
          finally { compactMs += performance.now() - start - (nativeMs - nativeBefore); }
        });
        restoreCounters.push(() => { Reflect.set(component, "prepare", prepare); });
      }
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
      phases.streamed = await capture();
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
          timestampIndexes: group.map(sample => sample.timestampIndexes), sourceInvalidations: group.map(sample => sample.sourceInvalidations), paneRows: group.map(sample => sample.paneRows), panePreviewCharacters: group.map(sample => sample.panePreviewCharacters), previewScrollRows: group.map(sample => sample.previewScrollRows),
          nativeP50: percentile(group.map(sample => sample.nativeMs), 0.5), compactP50: percentile(group.map(sample => sample.compactMs), 0.5),
          documentP50: percentile(group.map(sample => sample.documentMs), 0.5) }];
      }));
      await writeFile(path.join(ctx.cwd, "rendering-measurements.json"), JSON.stringify({
        samples, summary, initialDisplay, frames: phases, runtime: { node: process.version, pid: process.pid,
          mode: process.env.PROFILE_MODE, nativeComponents: components.length, samples: count,
          savedToolBlocks: messages.filter(component => component.constructor.name === "ToolExecutionComponent").length },
        draft: ctx.ui.getEditorText(), syntheticOnly: true,
        frameDefinition: "Action to synchronized terminal-frame emission, not compositor presentation; process CPU delta includes scheduling background work.",
        initialDisplayDefinition: "End of profiling session_start handler to first emitted frame containing restored history, including native history construction and remaining initialization; excludes module loading and precedes the scripted setup turn.",
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
