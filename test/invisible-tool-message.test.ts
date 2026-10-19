import { initTheme, ToolExecutionComponent, type Theme } from "@earendil-works/pi-coding-agent";
import { Container, getCapabilities, Image, setCapabilities, stripTerminalSequences, Text, type TUI } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, expect, test } from "vitest";
import { CompactMessage } from "../src/timestamps.js";

const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=";
const imageResult = () => ({ content: [
  { type: "text", text: "MODEL ONLY RESULT" }, { type: "image", data: png, mimeType: "image/png" },
], isError: false });
const colors = { fg: (_name: string, value: string) => value } as Theme;
const capabilities = getCapabilities();
const images = (lines: string[]) => lines.some(line => line.includes("\x1b_G") || line.includes("\x1b]1337;File="));
type Renderers = NonNullable<ConstructorParameters<typeof ToolExecutionComponent>[4]>;
const tool = (renderers?: Renderers) => new ToolExecutionComponent("unrelated_capture", "capture-owner", {}, {}, renderers,
  { requestRender() {} } as unknown as TUI, process.cwd());
const compact = (native: ToolExecutionComponent) => new CompactMessage(native, () => "12:34:56", () => colors, () => 0, () => true);

beforeEach(() => {
  initTheme("dark", false);
  setCapabilities({ ...capabilities, images: "kitty" });
});
afterEach(() => setCapabilities(capabilities));

test.each([false, true])("empty custom renderers omit automatic images, clocks and spacing (blank rows: %s)", padded => {
  const empty = () => padded ? new Text("\x1b[0m  \n  ", 0, 0) : new Container();
  const native = tool({ renderShell: "self", renderCall: empty, renderResult: empty });
  native.updateResult(imageResult());
  const message = compact(native);
  try {
    expect(images(native.render(60)), "The native result must reproduce the reserved image block").toBe(true);
    expect(message.prepare(60, true)).toBe(false);
    expect(message.render(60)).toEqual([]);
    expect(message.searchClock()).toBeUndefined();
    expect(images(native.render(60)), "Projection must not mutate the combined native result").toBe(true);
  } finally { message.dispose(); }
});

test("visible native and custom image output retains its placement rows", () => {
  for (const renderers of [undefined, {
    renderShell: "self" as const, renderCall: () => new Text("VISIBLE CALL", 0, 0), renderResult: () => new Container(),
  }, {
    renderShell: "self" as const, renderCall: () => new Container(),
    renderResult: () => new Image(png, "image/png", { fallbackColor: value => value }, { maxWidthCells: 10 }),
  }]) {
    const native = tool(renderers);
    native.updateResult(imageResult());
    const message = compact(native);
    try {
      const original = native.render(51);
      expect(message.prepare(60, false)).toBe(true);
      expect(message.render(60)[0].trim()).toBe("12:34:56");
      expect(message.render(60).slice(1)).toEqual(original);
      expect(images(message.render(60))).toBe(true);
    } finally { message.dispose(); }
  }
});

test("visibility follows partial and final renderer updates without stale image blocks", () => {
  const native = tool({
    renderShell: "self", renderCall: () => new Container(),
    renderResult: result => new Text(String((result.details as { shown?: string } | undefined)?.shown ?? ""), 0, 0),
  });
  const message = compact(native);
  try {
    for (const shown of ["", "VISIBLE PROGRESS", "", "VISIBLE FINAL", ""]) {
      native.updateResult({ ...imageResult(), details: { shown } }, shown !== "VISIBLE FINAL");
      expect(message.prepare(60, true)).toBe(Boolean(shown));
      const lines = message.render(60);
      if (shown) {
        expect(lines.map(stripTerminalSequences).join("\n")).toContain(shown);
        expect(images(lines)).toBe(true);
      } else {
        expect(lines).toEqual([]);
        expect(message.searchClock()).toBeUndefined();
      }
    }
  } finally { message.dispose(); }
});
