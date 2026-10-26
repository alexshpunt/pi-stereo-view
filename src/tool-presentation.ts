import { isDeepStrictEqual } from "node:util";
import type { ToolInfo } from "@earendil-works/pi-coding-agent";

export interface ToolPresentation { name: string; key: string }

/** Resolve presentation only; native execution and renderer ownership stay unchanged. */
export function toolPresentations(tools: readonly ToolInfo[]): (name: string) => ToolPresentation {
  const catalogue = new Map(tools.map(tool => [tool.name, tool]));
  const sources = tools.filter(tool => tool.exposure !== "hidden" && (
    tool.namespace?.name.startsWith("ide_") === true ||
    (tool.name === "codemode" && tool.sourceInfo.source === "builtin" && tool.sourceInfo.path === "builtin:codemode")
  ));
  const cache = new Map<string, ToolPresentation>();
  return name => {
    const cached = cache.get(name);
    if (cached) return cached;
    let canonical = name;
    const alias = catalogue.get(name);
    // Local forwarding aliases opt into IDE's description/schema contract.
    if (name.startsWith("mcp__") && alias && !alias.namespace && alias.exposure !== "hidden") {
      const matches = sources.filter(tool => tool.description === alias.description && isDeepStrictEqual(tool.parameters, alias.parameters));
      if (matches.length === 1) canonical = matches[0].name;
    }
    const presentation = { name: canonical, key: canonical };
    cache.set(name, presentation);
    return presentation;
  };
}
