import type { Theme } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, type Component } from "@earendil-works/pi-tui";
import { expect, test, vi } from "vitest";
import { CompactMessage } from "../src/timestamps.js";

// Count the real classifier without replacing terminal parsing or native components.
vi.mock(import("@earendil-works/pi-tui"), async importOriginal => {
  const actual = await importOriginal();
  return { ...actual, stripTerminalSequences: vi.fn(actual.stripTerminalSequences) };
});

const colors = { fg: (_color: string, value: string) => value } as Theme;
const padding = (color: number, width = 40): string =>
  "\x1b[48;2;9;8;" + color + "m" + " ".repeat(width) + "\x1b[0m";

function block(edge: string, body: string, width = 80): string[] {
  const native: Component = { render: () => [edge, body, "", "second paragraph", edge], invalidate() {} };
  const message = new CompactMessage(native, () => "12:34:56", () => colors, () => 0, () => false);
  try { return message.render(width); }
  finally { message.dispose(); }
}

const callsFor = (line: string): number => vi.mocked(stripTerminalSequences).mock.calls
  .filter(args => args[0] === line).length;

test("classifies repeated native padding once across cold message blocks", () => {
  vi.mocked(stripTerminalSequences).mockClear();
  const edge = padding(137);
  for (let index = 0; index < 20; index++) {
    expect(block(edge, "message " + index)).toEqual(["message " + index, "", "second paragraph"]);
  }
  expect(callsFor(edge), "Identical padding must not repeat ANSI parsing for every cold block").toBe(1);
});

test("bounds remembered padding instead of retaining every style and width", () => {
  vi.mocked(stripTerminalSequences).mockClear();
  const first = padding(138);
  block(first, "first");
  for (let index = 0; index < 40; index++) block(padding(index), "body");
  block(first, "last");
  expect(callsFor(first), "Old padding must be classified again after bounded eviction").toBe(2);
});

test("does not retain oversized padding and preserves semantic prompt markers", () => {
  vi.mocked(stripTerminalSequences).mockClear();
  const large = padding(139, 8192);
  block(large, "body", 9000);
  block(large, "body", 9000);
  expect(callsFor(large)).toBe(4);
  const marked = "\x1b]133;A\x07" + padding(140);
  const output = block(marked, "visible body");
  expect(output[0]).toBe("\x1b]133;A\x07visible body");
  expect(output.at(-1)).toBe("second paragraph\x1b]133;A\x07");
});
