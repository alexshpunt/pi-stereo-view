import { describe, expect, it, vi } from "vitest";
import type { Component } from "@earendil-works/pi-tui";
import { GuiHold, HOLD_REASON } from "../src/gui-hold.ts";

const component = (): Component => ({ render: () => [], invalidate() {} });

function setup() {
  const editor = component();
  const state = { focused: editor as Component | null, stopCalls: 0, startCalls: 0 };
  const host = {
    stop() { state.stopCalls++; }, start() { state.startCalls++; },
    getFocusedComponent: () => state.focused,
  };
  const written: string[] = [];
  const hold = new GuiHold(() => host, focused => focused === editor, async reason => { written.push(reason); }, 10);
  return { editor, state, host, hold, written };
}

describe("telling Herdr when the GUI cannot show Pi's screen", () => {
  it("clears a label an earlier process left behind", async () => {
    const { hold, written } = setup();
    await hold.start();
    expect(written).toEqual([""]);
    await hold.dispose();
  });

  it("holds the terminal while Pi gives it to a child program and releases it afterwards", async () => {
    const { hold, host, written, state } = setup();
    await hold.start();
    host.stop();
    await hold.idle();
    expect(written).toEqual(["", HOLD_REASON]);
    expect(state.stopCalls).toBe(1);
    host.start();
    await hold.idle();
    expect(written).toEqual(["", HOLD_REASON, ""]);
    expect(state.startCalls).toBe(1);
    await hold.dispose();
  });

  it("holds only after a focused component outside the projection stays focused for two polls", async () => {
    const { hold, state, written } = setup();
    await hold.start();
    state.focused = component();
    hold.evaluate();
    await hold.idle();
    expect(written).toEqual([""]);
    hold.evaluate();
    await hold.idle();
    expect(written).toEqual(["", HOLD_REASON]);
    state.focused = null;
    hold.evaluate();
    await hold.idle();
    expect(written).toEqual(["", HOLD_REASON, ""]);
    await hold.dispose();
  });

  it("does not hold for a focus change that lasts one poll", async () => {
    const { hold, editor, state, written } = setup();
    await hold.start();
    state.focused = component();
    hold.evaluate();
    state.focused = editor;
    hold.evaluate();
    state.focused = component();
    hold.evaluate();
    await hold.idle();
    expect(written).toEqual([""]);
    await hold.dispose();
  });

  it("writes the label once for a long hold", async () => {
    vi.useFakeTimers();
    try {
      const { hold, state, written } = setup();
      await hold.start();
      state.focused = component();
      await vi.advanceTimersByTimeAsync(100);
      expect(written).toEqual(["", HOLD_REASON]);
      await hold.dispose();
    } finally { vi.useRealTimers(); }
  });

  it("restores Pi's own stop and start and clears the label when it ends", async () => {
    const { hold, host, written } = setup();
    const stop = host.stop, start = host.start;
    await hold.start();
    host.stop();
    await hold.dispose();
    expect(host.stop).toBe(stop);
    expect(host.start).toBe(start);
    expect(written.at(-1)).toBe("");
  });

  it("keeps going when a label write fails", async () => {
    const editor = component();
    let focused: Component | null = editor;
    const host = { stop() {}, start() {}, getFocusedComponent: () => focused };
    const written: string[] = [];
    let fail = true;
    const hold = new GuiHold(() => host, candidate => candidate === editor, async reason => {
      if (fail) { fail = false; throw new Error("hc is busy"); }
      written.push(reason);
    }, 10);
    await hold.start();
    focused = component();
    hold.evaluate(); hold.evaluate();
    focused = null;
    hold.evaluate();
    await hold.dispose();
    expect(written).toEqual([HOLD_REASON, "", ""]);
  });
});
