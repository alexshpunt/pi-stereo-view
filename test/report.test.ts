import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, type Component, type TUI, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { expect, test, vi } from "vitest";
import { ISSUES_URL, ProblemReporter, problemReport } from "../src/report.ts";

const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };

test("a report link opens GitHub's new-issue form with the error, its stack and versions", () => {
  const error = new Error("BROKEN LAYOUT");
  error.stack = ["Error: BROKEN LAYOUT", "    at assistantEntries (/pkg/src/content.ts:1:1)", "    at verify (/pkg/src/content.ts:2:2)"].join("\n");
  const report = problemReport({ summary: "split disabled after an error", error });
  const url = new URL(report.url);
  expect(url.origin + url.pathname).toBe(ISSUES_URL + "/new");
  expect(url.searchParams.get("title")).toBe("BROKEN LAYOUT");
  const body = url.searchParams.get("body")!;
  expect(body).toBe(report.body);
  expect(body).toContain("at assistantEntries (/pkg/src/content.ts:1:1)");
  expect(body).toContain("at verify (/pkg/src/content.ts:2:2)");
  expect(body).toContain(version);
});

test("a report leaves out the user's home folder", () => {
  const error = new Error("HOME");
  error.stack = `Error: HOME\n    at frame (${homedir()}/.pi/agent/npm/node_modules/pi-stereo-view/src/content.ts:1:1)`;
  const { body } = problemReport({ summary: "split disabled after an error", error });
  expect(body).not.toContain(homedir());
  expect(body).toContain("at frame (~/.pi/agent/npm/node_modules/pi-stereo-view/src/content.ts:1:1)");
});

test("a long stack loses its last frames so the link stays within GitHub's limit, while the copied report keeps them", () => {
  const error = new Error("DEEP");
  const frames = Array.from({ length: 15 }, (_, index) => `    at frame${index} (/${"x".repeat(900)}/file.ts:${index}:1)`);
  error.stack = ["Error: DEEP", ...frames].join("\n");
  const report = problemReport({ summary: "split disabled after an error", error });
  expect(report.url.length).toBeLessThanOrEqual(7000);
  const body = new URL(report.url).searchParams.get("body")!;
  expect(body).toContain("at frame0 ");
  expect(body).not.toContain("at frame14 ");
  expect(report.body).toContain("at frame14 ");
});

test("a layout refusal without an error is reported by its summary", () => {
  const report = problemReport({ summary: "split is unavailable: UNSUPPORTED LAYOUT" });
  expect(report.title).toBe("split is unavailable: UNSUPPORTED LAYOUT");
  expect(new URL(report.url).searchParams.get("body")).toContain("split is unavailable: UNSUPPORTED LAYOUT");
});

type Widget = ((tui: TUI, theme: Theme) => Component) | undefined;
const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text } as unknown as Theme;
const click = (type: TuiMouseEvent["type"], x: number, y: number): TuiMouseEvent =>
  ({ type, button: "left", x, y, screenX: x, screenY: y, width: 80, height: 6, shift: false, alt: false, ctrl: false });

function reporter() {
  let widget: Widget;
  const notify = vi.fn();
  const copy = vi.fn(async (_text: string) => {});
  const problems = new ProblemReporter({ setWidget: (_key, content) => { widget = content; }, notify }, copy);
  const openUrl = vi.fn();
  const panel = (): Component | undefined => widget?.({ openUrl } as unknown as TUI, theme);
  /** Press and release on a button label, as Pi delivers a click. */
  const press = (component: Component, label: string): void => {
    const lines = component.render(80).map(stripTerminalSequences);
    const row = lines.findIndex(line => line.includes(label));
    const x = lines[row].indexOf(label) + 1;
    expect(component.handleMouse!(click("press", x, row))).toEqual({ capture: true });
    component.handleMouse!(click("click", x, row));
  };
  return { problems, panel, press, copy, openUrl, notify };
}

test("the panel buttons open the prefilled issue, copy the report and close the panel", async () => {
  const { problems, panel, press, copy, openUrl } = reporter();
  const problem = { summary: "split disabled after an error", error: new Error("BROKEN") };
  problems.show(problem);
  const shown = panel()!;
  expect(shown.render(80).join("\n")).toContain("BROKEN");
  press(shown, "[Open issue]");
  expect(openUrl).toHaveBeenCalledWith(problemReport(problem).url);
  press(shown, "[Copy report]");
  expect(copy).toHaveBeenCalledWith(problemReport(problem).body);
  press(shown, "[Close]");
  expect(panel()).toBeUndefined();
});

test("a closed problem does not come back in the same session, while a different one does", () => {
  const { problems, panel, press } = reporter();
  problems.show({ summary: "split disabled after an error", error: new Error("FIRST") });
  press(panel()!, "[Close]");
  problems.show({ summary: "split disabled after an error", error: new Error("FIRST") });
  expect(panel()).toBeUndefined();
  problems.show({ summary: "split disabled after an error", error: new Error("SECOND") });
  expect(panel()!.render(80).join("\n")).toContain("SECOND");
});
