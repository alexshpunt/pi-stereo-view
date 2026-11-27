import { connect } from "node:net";
import { Container, Text } from "@earendil-works/pi-tui";
import { expect, test } from "vitest";
import { NativeContentIndex } from "../src/content.ts";
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
