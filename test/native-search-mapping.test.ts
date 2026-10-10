import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { Container, Text, stripTerminalSequences } from "@earendil-works/pi-tui";
import { expect, test } from "vitest";
import { NativeDocument } from "../src/native.js";
import { TranscriptTimestamps } from "../src/timestamps.js";
import type { SearchHit } from "../src/search.js";

class UserMessageComponent extends Text {}
const colors = {
  fg: (_name: string, value: string) => value,
  style: (value: string) => "\x1b[30;43m" + value + "\x1b[39;49m",
} as unknown as Theme;

const setup = (text: string, showTimestamps: boolean): { document: NativeDocument; hit: (line: number) => SearchHit } => {
  const user = new UserMessageComponent(text, 0, 0);
  const history = new Container();
  history.addChild(user);
  const source = new Container();
  source.addChild(new Container());
  source.addChild(new Container());
  source.addChild(history);
  const timestamps = new TranscriptTimestamps({ buildContextEntries: () => [], getBranch: () => [] } as unknown as ExtensionContext["sessionManager"]);
  const document = new NativeDocument(source, "chat", timestamps, () => colors, () => 0, () => showTimestamps);
  return { document, hit: line => ({ entry: { source: user, label: "User", text }, line, text: text.split("\n")[line] }) };
};

test("navigates and highlights the standalone occurrence after preceding substring collisions", () => {
  const { document, hit } = setup("worker ready ready\nready", false);
  const selected = hit(1);
  expect(document.reveal(selected, "rdy")).toBe(true);
  const rows = document.render(50);
  expect(document.searchRow(selected)).toBe(1);
  expect(rows[0]).not.toContain("\x1b[30;43m");
  expect(rows[1]).toContain("\x1b[30;43m");
  expect(rows.slice(0, 2).map(stripTerminalSequences).map(line => line.trim())).toEqual(["worker ready ready", "ready"]);
  document.dispose();
});

test.each([false, true])("keeps genuine saved timestamps searchable with display clocks %s", showTimestamps => {
  const { document, hit } = setup("first line\nfinished at 12:34:56", showTimestamps);
  const selected = hit(1);
  document.reveal(selected, "12:34:56");
  const rows = document.render(50);
  expect(document.searchRow(selected)).toBe(1);
  expect(rows[1]).toContain("\x1b[30;43m1");
  expect(stripTerminalSequences(rows[1]).trim()).toBe("finished at 12:34:56");
  document.dispose();
});
