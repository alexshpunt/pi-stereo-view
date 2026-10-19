import { InteractiveMode } from "@earendil-works/pi-coding-agent";
import { expect, test } from "vitest";
import { beforeFirstFrame } from "../src/startup.js";

test("cancels an unused startup hook without leaving a prototype replacement", () => {
  const original = InteractiveMode.prototype.init;
  const release = beforeFirstFrame(() => { throw new Error("No renderer should be started"); });
  expect(InteractiveMode.prototype.init).not.toBe(original);
  release();
  release();
  expect(InteractiveMode.prototype.init).toBe(original);
});

test("a cancelled hook retained by another wrapper never inspects a later renderer", async () => {
  const prototype = InteractiveMode.prototype;
  const original = prototype.init;
  let calls = 0;
  prototype.init = async () => { calls++; };
  const release = beforeFirstFrame(() => { throw new Error("Cancelled hook mounted a layout"); });
  const retained = prototype.init;
  const replacement = async function (this: InteractiveMode): Promise<void> { await retained.call(this); };
  prototype.init = replacement;
  try {
    release();
    const later = Object.create(prototype) as InteractiveMode;
    Object.defineProperty(later, "renderer", { get: () => { throw new Error("Cancelled hook inspected a later renderer"); } });
    await replacement.call(later);
    expect(calls).toBe(1);
    expect(prototype.init).toBe(replacement);
  } finally {
    prototype.init = original;
  }
});

test("startup hook cleanup does not overwrite another extension's later replacement", () => {
  const original = InteractiveMode.prototype.init;
  const release = beforeFirstFrame(() => () => {});
  const replacement = async (): Promise<void> => {};
  try {
    InteractiveMode.prototype.init = replacement;
    release();
    expect(InteractiveMode.prototype.init).toBe(replacement);
  } finally {
    InteractiveMode.prototype.init = original;
  }
});
