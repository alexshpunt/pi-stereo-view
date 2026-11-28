import { connect } from "node:net";
import { Text, type Component } from "@earendil-works/pi-tui";
import { expect, test, vi } from "vitest";
import { startGuiBridge } from "../src/gui-bridge.ts";
import { GuiSurface } from "../src/gui-surface.ts";
import { GuiOverlays } from "../src/gui-overlays.ts";
import { defaults } from "../src/preferences.ts";

class Dialog extends Text {
  inputs: string[] = [];
  handleInput(data: string) { this.inputs.push(data); }
}

test("assembles long surface and overlay pastes once and cancels stale or malformed transactions", async () => {
  const dialog = new Dialog("dialog", 0, 0), overlay = new Dialog("overlay", 0, 0), other = new Dialog("other", 0, 0);
  let focus: Component | null = dialog, socketPath = "";
  const surface = new GuiSurface(() => dialog, () => focus);
  const host = { terminal: { columns: 80, rows: 24 }, renderedOverlayLayouts: [{ entry: { component: overlay }, row: 1, col: 1, width: 20, height: 1 }],
    getFocusedComponent: () => focus, requestRender() {}, setFocus(component: Component) { focus = component; } };
  const overlays = new GuiOverlays(host);
  const state = { v: 1 as const, layout: "columns" as const, side: "left" as const, mode: "split" as const,
    zoom: null, showToolbar: true, showHeaders: true, compactTools: true, preferences: { ...defaults } };
  const stop = await startGuiBridge("terminal", () => undefined, async (_terminal, label) => { socketPath = JSON.parse(label).socket; },
    () => ({ state: () => state, action: () => {}, setting: () => {}, renderer: () => undefined, search: () => undefined,
      surface: () => surface, overlays: () => overlays }));
  const request = (payload: unknown): Promise<any> => new Promise((resolve, reject) => {
    const socket = connect(socketPath); let response = "";
    socket.on("error", reject);
    socket.on("connect", () => socket.write(JSON.stringify(payload) + "\n"));
    socket.on("data", chunk => { response += chunk; });
    socket.on("end", () => { try { resolve(JSON.parse(response)); } catch (error) { reject(error); } });
  });
  const fragmented = (payload: unknown): Promise<any> => new Promise((resolve, reject) => {
    const bytes = Buffer.from(JSON.stringify(payload) + "\n");
    const emoji = bytes.indexOf(Buffer.from("😀"));
    const socket = connect(socketPath); let response = "";
    socket.on("error", reject);
    socket.on("connect", () => {
      socket.write(bytes.subarray(0, emoji + 1));
      setTimeout(() => socket.write(bytes.subarray(emoji + 1)), 10);
    });
    socket.on("data", chunk => { response += chunk; });
    socket.on("end", () => { try { resolve(JSON.parse(response)); } catch (error) { reject(error); } });
  });
  try {
    const page = await request({ v: 1, op: "surface", width: 40 });
    const base = { v: 1, op: "surface-paste", frame: page.frame, transaction: "long", count: 4 };
    const chunks = ["a".repeat(256), "😀".repeat(256), "😀".repeat(256), "last"];
    for (const [index, data] of chunks.entries()) {
      expect(await (index === 1 ? fragmented({ ...base, index, data }) : request({ ...base, index, data }))).toEqual({ v: 1, ok: true });
      if (index < chunks.length - 1) expect(dialog.inputs).toEqual([]);
    }
    expect(dialog.inputs).toEqual([`\x1b[200~${chunks.join("")}\x1b[201~`]);
    expect(await request({ ...base, transaction: "stale", index: 0, data: "first" })).toEqual({ v: 1, ok: true });
    focus = other;
    expect(await request({ ...base, transaction: "stale", index: 1, data: "second" })).toEqual({ v: 1, ok: false });
    focus = dialog;
    expect(await request({ ...base, transaction: "stale", index: 2, data: "last" })).toEqual({ v: 1, ok: false });
    expect(await request({ ...base, transaction: "bad", index: 0, data: "first" })).toEqual({ v: 1, ok: true });
    expect((await request({ ...base, transaction: "bad", index: 1, data: "\x1b" })).error).toBeTruthy();
    expect(await request({ ...base, transaction: "bad", index: 2, data: "last" })).toEqual({ v: 1, ok: false });
    expect(dialog.inputs).toHaveLength(1);
    const clock = vi.spyOn(Date, "now");
    try {
      clock.mockReturnValue(100_000);
      expect(await request({ ...base, transaction: "expired", index: 0, data: "first" })).toEqual({ v: 1, ok: true });
      clock.mockReturnValue(130_001);
      expect(await request({ ...base, transaction: "expired", index: 1, data: "second" })).toEqual({ v: 1, ok: false });
    } finally { clock.mockRestore(); }
    expect(dialog.inputs).toHaveLength(1);
    focus = overlay;
    const projected = await request({ v: 1, op: "overlays" });
    const layer = projected.overlays[0];
    const over = { v: 1, op: "overlay-paste", revision: projected.revision, id: layer.id, frame: layer.frame, transaction: "overlay", count: 2 };
    expect(await request({ ...over, index: 0, data: "x".repeat(256) })).toEqual({ v: 1, ok: true });
    expect(await request({ ...over, index: 1, data: "last" })).toEqual({ v: 1, ok: true });
    expect(overlay.inputs).toEqual([`\x1b[200~${"x".repeat(256)}last\x1b[201~`]);
    expect(await request({ ...over, transaction: "overlay-stale", index: 0, data: "first" })).toEqual({ v: 1, ok: true });
    focus = other;
    expect(await request({ ...over, transaction: "overlay-stale", index: 1, data: "last" })).toEqual({ v: 1, ok: false });
    expect(overlay.inputs).toHaveLength(1);
  } finally { await stop(); surface.dispose(); overlays.dispose(); }
});
