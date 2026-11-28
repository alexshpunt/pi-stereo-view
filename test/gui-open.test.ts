import { describe, expect, it } from "vitest";
import { openGuiForFocusedTerminal } from "../src/gui-open.ts";

describe("opening the experimental GUI", () => {
  it("opens only for the currently focused verified address and Pi", async () => {
    const calls: string[][] = [];
    const run = async (args: string[]) => {
      calls.push(args);
      if (args[0] === "status") return JSON.stringify({ agent: "worker/t1", tab: "tab1" });
      if (args[1] === "agent.list") return JSON.stringify({ agents: [{ terminal: "worker/t1", pid: 42 }] });
      return "{}";
    };
    expect(await openGuiForFocusedTerminal("worker/t1", 42, run)).toBe(true);
    expect(calls[3]).toEqual(["do", "app.open", JSON.stringify({ mod: "stereo-view", app: "stereo-view", for: "worker/t1" })]);
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

  it("rechecks the selected agent and tab before opening", async () => {
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
