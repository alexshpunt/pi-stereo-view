import { describe, expect, it } from "vitest";
import { openGuiForFocusedTerminal } from "../src/gui-open.ts";

describe("opening the experimental GUI", () => {
  it("does not open automatically when the running App cannot prove its pane-view capability", async () => {
    const calls: string[][] = [];
    const run = async (args: string[]) => {
      calls.push(args);
      return args[0] === "status" ? JSON.stringify({ agent: "worker/t1", tab: "tab1" }) :
        JSON.stringify({ agents: [{ terminal: "worker/t1", pid: 42 }] });
    };
    expect(await openGuiForFocusedTerminal("worker/t1", 42, run)).toBe(false);
    expect(calls.some(args => args[1] === "app.open")).toBe(false);
  });
  it("does not trust the invoking executable's command list as the running App's capability", async () => {
    const calls: string[][] = [];
    const run = async (args: string[]) => {
      calls.push(args);
      if (args[0] === "commands") return JSON.stringify([{ name: "app.open" }]);
      if (args[0] === "status") return JSON.stringify({ agent: "worker/t1", tab: "tab1" });
      return JSON.stringify({ agents: [{ terminal: "worker/t1", pid: 42 }] });
    };
    expect(await openGuiForFocusedTerminal("worker/t1", 42, run)).toBe(false);
    expect(calls.some(args => args[1] === "app.open")).toBe(false);
  });

  it("does not infer a machine from a bare terminal ID even if PID matches", async () => {
    const calls: string[][] = [];
    const run = async (args: string[]) => {
      calls.push(args);
      if (args[0] === "status") return JSON.stringify({ agent: "other/t1", tab: "tab1" });
      return JSON.stringify({ agents: [{ terminal: "other/t1", pid: 42 }] });
    };
    expect(await openGuiForFocusedTerminal("t1", 42, run)).toBe(false);
    expect(calls.some(args => args[1] === "app.open")).toBe(false);
  });

  it("does not treat the same terminal ID and PID on another machine as the caller", async () => {
    const calls: string[][] = [];
    const run = async (args: string[]) => {
      calls.push(args);
      if (args[0] === "status") return JSON.stringify({ agent: "other/t1", tab: "tab1" });
      return JSON.stringify({ agents: [{ terminal: "other/t1", pid: 42 }] });
    };
    expect(await openGuiForFocusedTerminal("worker/t1", 42, run)).toBe(false);
    expect(calls.some(args => args[1] === "app.open")).toBe(false);
  });

  it("does not open even when the selected agent or tab changes", async () => {
    for (const second of [{ agent: "worker/t2", tab: "tab1" }, { agent: "worker/t1", tab: "tab2" }]) {
      let statuses = 0;
      const calls: string[][] = [];
      const run = async (args: string[]) => {
        calls.push(args);
        if (args[0] === "status") return JSON.stringify(++statuses === 1 ? { agent: "worker/t1", tab: "tab1" } : second);
        return JSON.stringify({ agents: [{ terminal: "worker/t1", pid: 42 }] });
      };
      expect(await openGuiForFocusedTerminal("worker/t1", 42, run)).toBe(false);
      expect(calls.some(args => args[1] === "app.open")).toBe(false);
    }
  });

  it("keeps the terminal view when the app or identity is unavailable", async () => {
    expect(await openGuiForFocusedTerminal("worker/t1", 42, async () => { throw new Error("unavailable"); })).toBe(false);
    const run = async (args: string[]) => args[0] === "status" ? JSON.stringify({ agent: "worker/t1", tab: "tab1" }) :
      JSON.stringify({ agents: [{ terminal: "worker/t1", pid: 43 }] });
    expect(await openGuiForFocusedTerminal("worker/t1", 42, run)).toBe(false);
  });
});
