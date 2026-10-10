import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { Container, Text } from "@earendil-works/pi-tui";
import { expect, test } from "vitest";
import { NativeDocument } from "../src/native.js";
import { TranscriptTimestamps } from "../src/timestamps.js";

class UserMessageComponent extends Text {
  renders = 0;
  override render(width: number): string[] { this.renders++; return super.render(width); }
}

const colors = { fg: (_name: string, value: string) => value } as Theme;

test("renders a native block once for repeated layout measurements but refreshes the next frame", () => {
  const user = new UserMessageComponent("FIRST", 0, 0);
  const history = new Container();
  history.addChild(user);
  const source = new Container();
  source.addChild(new Container());
  source.addChild(new Container());
  source.addChild(history);
  let indexes = 0;
  const timestamps = new TranscriptTimestamps({
    buildContextEntries: () => { indexes++; return []; }, getBranch: () => [],
  } as unknown as ExtensionContext["sessionManager"]);
  const document = new NativeDocument(source, "chat", timestamps, () => colors, () => 0, () => false);
  document.beginFrame();
  timestamps.beginFrame();
  const first = document.render(30);
  expect(document.render(30)).toEqual(first);
  expect(user.renders).toBe(1);
  expect(indexes).toBe(1);
  user.setText("SECOND");
  document.beginFrame();
  timestamps.beginFrame();
  expect(document.render(30).join("\n")).toContain("SECOND");
  expect(user.renders).toBe(2);
  expect(indexes).toBe(2);
  document.render(20);
  expect(user.renders).toBe(3);
  document.invalidate();
  document.render(20);
  expect(user.renders).toBe(4);
});
