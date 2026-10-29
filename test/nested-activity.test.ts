import { expect, test } from "vitest";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { NestedActivity } from "../src/nested-activity.js";

const texts = (activity: NestedActivity, parent: string): string[] => activity.entries(parent).map(component =>
  component.render(120).map(stripTerminalSequences).join("\n"));

test("tracks concurrent nested calls individually through their outcomes", () => {
  const activity = new NestedActivity();
  activity.start({ parentToolCallId: "outer", toolCallId: "outer/1", toolName: "read", args: { path: "alpha.txt" } });
  activity.start({ parentToolCallId: "outer", toolCallId: "outer/2", toolName: "write", args: { path: "beta.txt" } });
  activity.end({ parentToolCallId: "outer", toolCallId: "outer/2", toolName: "write", result: { content: [{ type: "text", text: "write failure" }] }, isError: true });
  const rows = texts(activity, "outer");
  expect(rows).toHaveLength(2);
  expect(rows[0]).toContain("alpha.txt");
  expect(rows[1]).toContain("beta.txt");
  expect(rows[1]).toContain("write failure");
  expect(rows[0]).not.toContain("write failure");
  expect(activity.entries("outer").map(view => activity.summary(view)?.status)).toEqual(["running", "error"]);
});

test("hides a leading IDE reference from nested results without removing result content", () => {
  const activity = new NestedActivity();
  activity.start({ parentToolCallId: "outer", toolCallId: "outer/1", toolName: "read", args: {} });
  const reference = '<system-' + 'result note="Internal reference; not part of the file. Do not edit."><uuid>12345678-1234-1234-1234-123456789abc</uuid></system-' + 'result>';
  activity.end({ parentToolCallId: "outer", toolCallId: "outer/1", toolName: "read", isError: false,
    result: { content: [{ type: "text", text: `${reference}\nPayload ${reference}` }] } });
  const rendered = activity.entries("outer")[0].render(500).map(stripTerminalSequences).join("\n");
  expect(rendered).toContain(`Payload ${reference}`);
  expect(rendered.split(reference)).toHaveLength(2);
});
test("restores recorded metadata without claiming missing results, and resets branches", () => {
  const activity = new NestedActivity();
  activity.restore([{ type: "message", message: { role: "toolResult", toolCallId: "saved", nestedCalls: {
    complete: false, calls: [{ id: "saved/1", name: "read", status: "ok", arguments: { path: "saved.txt" } },
      { id: "saved/2", name: "write", status: "error", argumentsBytes: 9000, error: "saved error" }],
  } } }]);
  const rows = texts(activity, "saved");
  expect(rows.join("\n")).toContain("saved.txt");
  expect(rows.join("\n")).toContain("saved error");
  expect(rows.join("\n")).toContain("9000");
  expect(rows.join("\n")).not.toContain("write failure");
  activity.restore([]);
  expect(activity.entries("saved")).toEqual([]);
});
