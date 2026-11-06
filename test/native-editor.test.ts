import { InteractiveMode } from "@earendil-works/pi-coding-agent";
import { Text, type TUI } from "@earendil-works/pi-tui";
import { expect, test } from "vitest";
import { observeNativeEditor } from "../src/native-editor.js";

const prototype = InteractiveMode.prototype as unknown as Record<string, (...args: unknown[]) => unknown>;

test.each(["createExtensionUIContext", "rebuildChatFromMessages"])("tracks the native editor identity through %s", boundary => {
  const original = prototype[boundary];
  const context = {};
  prototype[boundary] = function () { return context; };
  const observer = observeNativeEditor();
  try {
    const tui = {} as TUI;
    const host = { renderer: tui, editor: new Text("first") };
    expect(prototype[boundary].call(host)).toBe(context);
    expect(prototype[boundary]).not.toBe(original);
    expect(observer.get(tui)).toBe(host.editor);
    host.editor = new Text("second");
    expect(observer.get(tui)).toBe(host.editor);
    expect(observer.get({} as TUI)).toBeUndefined();
    observer.dispose();
    expect(observer.get(tui)).toBeUndefined();
  } finally {
    observer.dispose();
    prototype[boundary] = original;
  }
});

test("cancels both boundaries without overwriting a later wrapper", () => {
  const original = prototype.createExtensionUIContext;
  const rebuild = prototype.rebuildChatFromMessages;
  let calls = 0;
  prototype.createExtensionUIContext = () => { calls++; };
  const observer = observeNativeEditor();
  const retained = prototype.createExtensionUIContext;
  const later = function (this: unknown) { return retained.call(this); };
  prototype.createExtensionUIContext = later;
  try {
    observer.dispose();
    observer.dispose();
    expect(prototype.createExtensionUIContext).toBe(later);
    expect(prototype.rebuildChatFromMessages).toBe(rebuild);
    const host = Object.defineProperty({}, "editor", { get() { throw new Error("Cancelled observer inspected host"); } });
    later.call(host);
    expect(calls).toBe(1);
  } finally {
    observer.dispose();
    prototype.createExtensionUIContext = original;
  }
});

test("leaves unknown hosts native and restores the original boundaries on dispose", () => {
  const original = prototype.createExtensionUIContext;
  prototype.createExtensionUIContext = () => undefined;
  const before = prototype.createExtensionUIContext;
  const rebuild = prototype.rebuildChatFromMessages;
  const observer = observeNativeEditor();
  try {
    prototype.createExtensionUIContext.call({});
    expect(observer.get({} as TUI)).toBeUndefined();
    observer.dispose();
    expect(prototype.createExtensionUIContext).toBe(before);
    expect(prototype.rebuildChatFromMessages).toBe(rebuild);
  } finally {
    observer.dispose();
    prototype.createExtensionUIContext = original;
  }
});
