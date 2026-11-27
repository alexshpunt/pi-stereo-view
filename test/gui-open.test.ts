import { describe, expect, it } from "vitest";
import { openGuiForFocusedTerminal } from "../src/gui-open.ts";

describe("opening the experimental GUI", () => {
  it("opens only for the currently focused matching Pi", async () => {
    const calls: string[][] = [];
    const run = async (args: string[]) => {
      calls.push(args);
      if (args[0] === "status") return JSON.stringify({ agent: "worker/t1" });
      if (args[1] === "agent.list") return JSON.stringify({ agents: [{ terminal: "worker/t1", pid: 42, identityCurrent: true }] });
      return "{}";
    };
    expect(await openGuiForFocusedTerminal("t1", 42, run)).toBe(true);
    expect(calls[3]).toEqual(["do", "app.open", JSON.stringify({ mod: "stereo-view", app: "stereo-view", for: "worker/t1" })]);
  });

  it("does not move the user's focus for a background or different Pi", async () => {
    for (const agent of ["worker/t2", null]) {
      const calls: string[][] = [];
      const run = async (args: string[]) => {
        calls.push(args);
        if (args[0] === "status") return JSON.stringify({ agent });
        return JSON.stringify({ agents: [{ terminal: "worker/t1", pid: 42, identityCurrent: true }] });
      };
      expect(await openGuiForFocusedTerminal("t1", 42, run)).toBe(false);
      expect(calls.some(args => args[1] === "app.open")).toBe(false);
    }
  });

  it("accepts a local terminal address and checks focus again before opening", async () => {
    let statuses = 0;
    const calls: string[][] = [];
    const run = async (args: string[]) => {
      calls.push(args);
      if (args[0] === "status") return JSON.stringify({ agent: ++statuses === 1 ? "t1" : "t2" });
      return JSON.stringify({ agents: [{ terminal: "t1", pid: 42, identityCurrent: true }] });
    };
    expect(await openGuiForFocusedTerminal("t1", 42, run)).toBe(false);
    expect(calls).toEqual([["status"], ["do", "agent.list"], ["status"]]);
  });
  it("opens for a focused local Pi even without optional session identity metadata", async () => {
    const calls: string[][] = [];
    const run = async (args: string[]) => {
      calls.push(args);
      if (args[0] === "status") return JSON.stringify({ agent: "t1", tab: "tab1" });
      if (args[1] === "agent.list") return JSON.stringify({ agents: [{ terminal: "t1", pid: 42, identityCurrent: false }] });
      return "{}";
    };
    expect(await openGuiForFocusedTerminal("t1", 42, run)).toBe(true);
    expect(calls.at(-1)?.[1]).toBe("app.open");
  });
  it("keeps the terminal view when the app or matching identity is unavailable", async () => {
    expect(await openGuiForFocusedTerminal("t1", 42, async () => { throw new Error("unavailable"); })).toBe(false);
    const run = async (args: string[]) => args[0] === "status" ? JSON.stringify({ agent: "worker/t1" }) :
      JSON.stringify({ agents: [{ terminal: "worker/t1", pid: 43, identityCurrent: true }] });
    expect(await openGuiForFocusedTerminal("t1", 42, run)).toBe(false);
  });
});
