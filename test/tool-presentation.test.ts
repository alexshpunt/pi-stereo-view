import type { ToolInfo } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { expect, test } from "vitest";
import { toolPresentations } from "../src/tool-presentation.js";

function fixture() {
  const source: ToolInfo = {
    name: "fixture_read",
    description: "Read fixture resources.",
    parameters: Type.Object({ path: Type.String() }),
    exposure: "direct",
    namespace: { name: "ide_fixture", description: "Fixture resources." },
    sourceInfo: { path: "fixture", source: "inline", scope: "temporary", origin: "top-level" },
  };
  const alias: ToolInfo = {
    name: "mcp__connector__unrelated_suffix",
    description: source.description,
    parameters: structuredClone(source.parameters),
    exposure: "direct",
    sourceInfo: source.sourceInfo,
  };
  return { source, alias };
}
const original = (tool: ToolInfo) => ({ name: tool.name, key: tool.name });

function builtinFixture() {
  const { source, alias } = fixture();
  source.name = "codemode";
  delete source.namespace;
  source.sourceInfo = { ...source.sourceInfo, source: "builtin", path: "builtin:codemode" };
  return { source, alias };
}

test("a verified builtin forwarding alias shares the shipped tool identity", () => {
  const { source, alias } = builtinFixture();
  expect(toolPresentations([source, alias])(alias.name)).toEqual(original(source));
});

test("a unique verified forwarding alias shares the native tool identity", () => {
  const { source, alias } = fixture();
  const resolve = toolPresentations([source, alias]);
  expect(resolve(alias.name)).toEqual(original(source));
  expect(resolve(source.name)).toEqual(original(source));
});

const rejectedContracts: { reason: string; change: (pair: ReturnType<typeof fixture>) => void }[] = [
  { reason: "a hidden alias", change: ({ alias }) => { alias.exposure = "hidden"; } },
  { reason: "a server-owned alias", change: ({ alias }) => { alias.namespace = { name: "mcp_remote", description: "Remote fixture." }; } },
  { reason: "a hidden source", change: ({ source }) => { source.exposure = "hidden"; } },
  { reason: "an unnamespaced extension source", change: ({ source }) => { delete source.namespace; } },
  { reason: "a foreign source namespace", change: ({ source }) => { source.namespace = { name: "other_fixture", description: "Other fixture." }; } },
  { reason: "a changed source description", change: ({ source }) => { source.description += " Changed."; } },
  { reason: "a changed alias description", change: ({ alias }) => { alias.description += " Changed."; } },
  { reason: "a changed source schema", change: ({ source }) => { source.parameters = Type.Object({ path: Type.Number() }); } },
  { reason: "a changed alias schema", change: ({ alias }) => { alias.parameters = Type.Object({ path: Type.Number() }); } },
  { reason: "a non-MCP tool", change: ({ alias }) => { alias.name = "other_fixture_alias"; } },
  { reason: "a matching suffix without the contract", change: ({ source, alias }) => { alias.name = `mcp__connector__${source.name}`; alias.description += " Unrelated."; } },
];
test.each(rejectedContracts)("$reason retains its original identity", ({ change }) => {
  const pair = fixture();
  change(pair);
  expect(toolPresentations([pair.source, pair.alias])(pair.alias.name)).toEqual(original(pair.alias));
});

test.each(["direct", "deferred", "model-only"] as const)("a visible %s forwarding alias keeps its verified identity", exposure => {
  const { source, alias } = fixture();
  alias.exposure = exposure;
  source.exposure = exposure;
  expect(toolPresentations([source, alias])(alias.name)).toEqual(original(source));
});

test("ambiguous source contracts never merge different tools", () => {
  const { source, alias } = fixture();
  const other = { ...source, name: "other_fixture_read" };
  expect(toolPresentations([source, other, alias])(alias.name)).toEqual(original(alias));
});

test("hidden and nonmatching sources do not make a verified alias ambiguous", () => {
  const { source, alias } = fixture();
  const hidden: ToolInfo = { ...source, name: "hidden_fixture_read", exposure: "hidden" };
  const unrelated = { ...source, name: "unrelated_fixture_read", parameters: Type.Object({ different: Type.Boolean() }) };
  expect(toolPresentations([source, hidden, unrelated, alias])(alias.name)).toEqual(original(source));
});

test("aliases of the same verified source share a key despite different suffixes", () => {
  const { source, alias } = fixture();
  const other = { ...alias, name: "mcp__another_connector__another_suffix" };
  const resolve = toolPresentations([source, alias, other]);
  expect(resolve(alias.name)).toEqual(original(source));
  expect(resolve(other.name)).toEqual(original(source));
});

const invalidBuiltins: { reason: string; change: (source: ToolInfo) => void }[] = [
  { reason: "a builtin with another name", change: source => { source.name = "other_fixture_builtin"; } },
  { reason: "an extension with the builtin name", change: source => { source.sourceInfo = { ...source.sourceInfo, source: "inline" }; } },
  { reason: "a builtin from another path", change: source => { source.sourceInfo = { ...source.sourceInfo, path: "builtin:other_fixture" }; } },
];
test.each(invalidBuiltins)("$reason does not impersonate the shipped source", ({ change }) => {
  const { source, alias } = builtinFixture();
  change(source);
  expect(toolPresentations([source, alias])(alias.name)).toEqual(original(alias));
});

test("a new catalogue snapshot recognizes late aliases without changing an older snapshot", () => {
  const { source, alias } = fixture();
  const tools = [source];
  const before = toolPresentations(tools);
  tools.push(alias);
  expect(before(alias.name)).toEqual(original(alias));
  expect(toolPresentations(tools)(alias.name)).toEqual(original(source));
});

test("unknown and ordinary tools retain their own identities", () => {
  const { source, alias } = fixture();
  const resolve = toolPresentations([source]);
  expect(resolve(alias.name)).toEqual(original(alias));
  expect(resolve(source.name)).toEqual(original(source));
  const unknown = "extension_fixture_unregistered";
  expect(resolve(unknown)).toEqual({ name: unknown, key: unknown });
});