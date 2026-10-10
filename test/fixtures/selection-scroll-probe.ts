import { writeFile } from "node:fs/promises";
import path from "node:path";
import { setImmediate, setTimeout } from "node:timers/promises";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { MouseRegion, ScrollView, Text, type TUI } from "@earendil-works/pi-tui";

type Box = { rect: { x: number; y: number; width: number; height: number }; children: Box[]; scrollView?: ScrollView };
type Host = TUI & {
  currentLayout?: { root: Box };
  getScreenLines(): string[];
  handleTerminalInput(data: string): void;
  copyTextToClipboard(text: string): Promise<boolean>;
  copyActiveSelectionToClipboard(): Promise<boolean>;
  resetTextSelection(): void;
};

/** Hold a native selection at each edge and observe scrolling and copied text. */
export default function selectionScrollProbe(pi: ExtensionAPI): void {
  let tui: Host;
  // Only off-screen rows consume drags. A ScrollView must not route viewport rows back into them.
  pi.registerToolRenderer((name, next) => name === "write" ? {
    renderCall: () => new MouseRegion(new Text(Array.from({ length: 100 }, (_, i) => "Activity line " + i).join("\n"), 0, 0),
      event => event.type === "drag" && event.y < 25 ? { handled: true } : undefined),
    renderResult: () => new Text("Activity result", 0, 0),
  } : next());
  pi.on("session_start", async (_event, ctx) => {
    let finish = () => {};
    await ctx.ui.custom<void>((host, _theme, _keys, done) => {
      tui = host as Host;
      finish = done;
      return new Text("", 0, 0);
    }, { overlay: true, overlayOptions: { visible: () => false, nonCapturing: true }, onHandle: () => finish() });
  });
  pi.on("agent_before_settle", async (_event, ctx) => {
    const capture = async () => { tui.requestRender(true); await setImmediate(); return tui.getScreenLines(); };
    const mouse = async (button: number, x: number, y: number, suffix = "M") => {
      tui.handleTerminalInput(`\x1b[<${button};${x + 1};${y + 1}${suffix}`);
      await setImmediate();
    };
    const boxes = (): Box[] => {
      const found: Box[] = [];
      const visit = (box: Box) => { if (box.scrollView) found.push(box); box.children.forEach(visit); };
      visit(tui.currentLayout!.root);
      return found;
    };
    await capture();
    const views = boxes().map(box => box.scrollView!);
    const copied: string[] = [];
    const originalCopy = tui.copyTextToClipboard;
    tui.copyTextToClipboard = async value => { copied.push(value); return true; };
    const observations = [];
    try {
      for (const view of views) {
        const other = views.find(candidate => candidate !== view);
        for (const direction of [-1, 1]) {
          tui.resetTextSelection();
          view.scrollTo(35, { disableFollow: true });
          await capture();
          const box = boxes().find(box => box.scrollView === view)!;
          const x = box.rect.x + 10;
          const startY = box.rect.y + Math.floor(box.rect.height / 2);
          const edgeY = direction < 0 ? box.rect.y : box.rect.y + box.rect.height - 1;
          const before = view.scrollTop;
          const otherBefore = other?.scrollTop;
          await mouse(0, x, startY);
          await mouse(32, x, edgeY);
          await setTimeout(180);
          const first = view.scrollTop;
          await tui.copyActiveSelectionToClipboard();
          const firstCopy = copied.at(-1) ?? "";
          await setTimeout(180);
          const held = view.scrollTop;
          await tui.copyActiveSelectionToClipboard();
          const heldCopy = copied.at(-1) ?? "";
          const frame = await capture();
          // Moving back inside must stop without needing a release.
          await mouse(32, x, startY);
          await setTimeout(80);
          const inside = view.scrollTop;
          await setTimeout(120);
          const insideHeld = view.scrollTop;
          await mouse(32, x, edgeY);
          await setTimeout(100);
          await mouse(0, x, edgeY, "m");
          const released = view.scrollTop;
          await setTimeout(160);
          await tui.copyActiveSelectionToClipboard();
          observations.push({ direction, before, first, held, firstCopy, heldCopy, inside, insideHeld, released, afterRelease: view.scrollTop,
            otherBefore, otherAfter: other?.scrollTop, copied: copied.at(-1), frame });
        }
      }
      await writeFile(path.join(ctx.cwd, "selection-scroll.json"), JSON.stringify(observations));
    } finally {
      tui.resetTextSelection();
      tui.copyTextToClipboard = originalCopy;
    }
  });
}
