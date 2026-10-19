import { Container, stripTerminalSequences, Text } from "@earendil-works/pi-tui";
import { expect, test } from "vitest";
import { StartupNotices } from "../src/startup-notices.js";

class ThemedText extends Text {
  stale = true;
  constructor(private value: string) { super("", 0, 0); }
  update(value: string): void { this.value = value; this.stale = true; }
  override render(width: number): string[] {
    if (this.stale) { this.stale = false; this.setText(this.value); }
    return super.render(width);
  }
}

test("classifies only notices present during startup, including before the first render", () => {
  const startup = new StartupNotices(true);
  const source = new Container();
  const early = new ThemedText("EARLY");
  const delayed = new ThemedText("DELAYED");
  source.addChild(early);
  expect(startup.contains(early, 80)).toBe(true);
  source.addChild(delayed);
  startup.finish(source, 80);
  const later = new ThemedText("LATER");
  expect(startup.contains(delayed, 80)).toBe(true);
  expect(startup.contains(later, 80)).toBe(false);
  expect(startup.contains(new Text("not a notice"), 80)).toBe(false);
});

test("retains startup identity across reload without adopting old operational notices", () => {
  const initial = new StartupNotices(true);
  const startup = new ThemedText("STARTUP");
  const source = new Container();
  source.addChild(startup);
  initial.finish(source, 80);
  const operational = new ThemedText("OPERATIONAL");
  source.addChild(operational);
  const reloaded = new StartupNotices(false);
  reloaded.finish(source, 80);
  expect(reloaded.contains(startup, 80)).toBe(true);
  expect(reloaded.contains(operational, 80)).toBe(false);
});

test("a reused native status becomes Activity when its content changes after startup", () => {
  const notices = new StartupNotices(true);
  const source = new Container();
  const status = new ThemedText("STARTUP");
  source.addChild(status);
  notices.finish(source, 80);
  status.update("\x1b[32mSTARTUP\x1b[0m");
  expect(notices.contains(status, 80)).toBe(true);
  expect(stripTerminalSequences(status.render(80).join("\n")).trimEnd()).toBe("STARTUP");
  status.update("OPERATIONAL");
  expect(notices.contains(status, 80)).toBe(false);
});
