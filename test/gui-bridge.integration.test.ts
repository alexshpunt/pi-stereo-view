import { connect } from "node:net";
import { Container, Text } from "@earendil-works/pi-tui";
import { expect, test } from "vitest";
import { NativeContentIndex } from "../src/content.ts";
import { defaults } from "../src/preferences.ts";
import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { GuiDocuments } from "../src/gui-documents.ts";
import { NativeDocument } from "../src/native.ts";
import { TranscriptTimestamps } from "../src/timestamps.ts";
import { startGuiBridge } from "../src/gui-bridge.ts";

test("the private bridge serves pages from the live classified history and closes", async () => {
  const root = new Container(); root.addChild(new Container()); root.addChild(new Container());
  const history = new Container(); root.addChild(history);
  const text = new Text("live one", 0, 0); history.addChild(text);
  const index = new NativeContentIndex(root);
  let socketPath = "";
  const stop = await startGuiBridge("terminal", () => index, async (_terminal, label) => {
    socketPath = JSON.parse(label).socket;
  });
  const request = (payload: unknown): Promise<any> => new Promise((resolve, reject) => {
    const socket = connect(socketPath);
    let reply = "";
    socket.on("error", reject);
    socket.on("connect", () => socket.write(JSON.stringify(payload) + "\n"));
    socket.on("data", chunk => { reply += chunk; });
    socket.on("end", () => { try { resolve(JSON.parse(reply)); } catch (error) { reject(error); } });
  });
  try {
    const query = { v: 1, op: "page", pane: "chat", start: 2, count: 1, width: 40 };
    const before = await request(query);
    expect(before.total).toBe(3);
    expect(before.entries[0].lines.join("")).toContain("live one");
    text.setText("live two");
    const after = await request(query);
    expect(after.entries[0].id).toBe(before.entries[0].id);
    expect(after.entries[0].lines.join("")).toContain("live two");
    expect((await request({ ...query, count: 1000 })).error).toBeTruthy();
  } finally { await stop(); }
  await expect(request({})).rejects.toThrow();
});

test("the private bridge serves controls and rejects unknown actions", async () => {
  let socketPath = "";
  const actions: string[] = [];
  const state = { v: 1 as const, layout: "columns" as const, side: "left" as const, mode: "split" as const,
    zoom: null, showToolbar: true, showHeaders: true, compactTools: true, preferences: { ...defaults } };
  const stop = await startGuiBridge("terminal", () => undefined, async (_terminal, label) => {
    socketPath = JSON.parse(label).socket;
  }, () => ({ state: () => state, action: action => { actions.push(action); },
    setting: setting => { actions.push(`${setting.key}:${setting.value}`); }, renderer: () => undefined }));
  const request = (payload: unknown): Promise<any> => new Promise((resolve, reject) => {
    const socket = connect(socketPath);
    let reply = "";
    socket.on("error", reject);
    socket.on("connect", () => socket.write(JSON.stringify(payload) + "\n"));
    socket.on("data", chunk => { reply += chunk; });
    socket.on("end", () => { try { resolve(JSON.parse(reply)); } catch (error) { reject(error); } });
  });
  try {
    expect(await request({ v: 1, op: "state" })).toEqual(state);
    expect(await request({ v: 1, op: "action", action: "swap" })).toEqual({ v: 1, ok: true });
    expect(actions).toEqual(["swap"]);
    expect(await request({ v: 1, op: "setting", key: "compactTools", value: false })).toEqual({ v: 1, ok: true });
    expect(actions).toEqual(["swap", "compactTools:false"]);
    expect((await request({ v: 1, op: "setting", key: "compactTools", value: "bad" })).error).toBeTruthy();
    expect((await request({ v: 1, op: "action", action: "execute" })).error).toBeTruthy();
    expect(actions).toEqual(["swap", "compactTools:false"]);
  } finally { await stop(); }
});

test("the bridge serves native viewport rows and sends clicks only to their displayed frame", async () => {
  class UserMessageComponent extends Text {
    events: string[] = [];
    handleMouse(event: import("@earendil-works/pi-tui").TuiMouseEvent) {
      this.events.push(event.type);
      return { handled: true, capture: event.type === "press" };
    }
  }
  const text = new UserMessageComponent("native live content", 0, 0);
  const root = new Container(), history = new Container();
  root.addChild(new Container()); root.addChild(new Container()); root.addChild(history); history.addChild(text);
  const timestamps = new TranscriptTimestamps({ buildContextEntries: () => [], getBranch: () => [] } as unknown as ExtensionContext["sessionManager"]);
  const theme = { fg: (_name: string, value: string) => value } as Theme;
  const doc = (pane: "chat" | "activity") => new NativeDocument(root, pane, timestamps, () => theme, () => 0, () => false);
  const gui = new GuiDocuments({ chat: doc("chat"), activity: doc("activity") }, () => timestamps.beginFrame());
  let socketPath = "";
  const state = { v: 1 as const, layout: "columns" as const, side: "left" as const, mode: "split" as const,
    zoom: null, showToolbar: true, showHeaders: true, compactTools: true, preferences: { ...defaults } };
  const stop = await startGuiBridge("terminal", () => undefined, async (_terminal, label) => { socketPath = JSON.parse(label).socket; },
    () => ({ state: () => state, action: () => {}, setting: () => {}, renderer: () => gui }));
  const request = (payload: unknown): Promise<any> => new Promise((resolve, reject) => {
    const socket = connect(socketPath);
    let reply = "";
    socket.on("error", reject);
    socket.on("connect", () => socket.write(JSON.stringify(payload) + "\n"));
    socket.on("data", chunk => { reply += chunk; });
    socket.on("end", () => { try { resolve(JSON.parse(reply)); } catch (error) { reject(error); } });
  });
  try {
    const page = await request({ v: 1, op: "view", pane: "chat", top: 0, height: 10, width: 40, following: false });
    const y = page.lines.findIndex((line: string) => line.includes("native live content"));
    expect(y).toBeGreaterThanOrEqual(0);
    const event = { button: "left", x: 0, y };
    expect(await request({ v: 1, op: "mouse", pane: "chat", frame: page.frame, event: { ...event, type: "press" } })).toEqual({ v: 1, ok: true });
    expect(await request({ v: 1, op: "mouse", pane: "chat", frame: page.frame, event: { ...event, type: "release" } })).toEqual({ v: 1, ok: true });
    expect(text.events).toEqual(["press", "release", "click"]);
    expect(await request({ v: 1, op: "mouse", pane: "chat", frame: page.frame, event: { ...event, type: "press" } })).toEqual({ v: 1, ok: false });
  } finally { await stop(); gui.dispose(); }
});
