import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Container, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

/** An independent extension owns an opaque final panel without standard tool components. */
export default function foreignNestedPanel(pi: ExtensionAPI): void {
  let childId = "";
  let parentId = "";
  pi.on("tool_execution_start", event => {
    if (event.toolName === "foreign_leaf" && event.parentToolCallId) {
      childId = event.toolCallId; parentId = event.parentToolCallId;
    }
  });
  pi.on("message_end", event => {
    if (event.message.role === "toolResult" && event.message.toolCallId === parentId && childId)
      pi.appendEntry("foreign-final-result", { parentToolCallId: parentId, childId });
  });
  pi.registerEntryRenderer<{ parentToolCallId: string; childId: string }>("foreign-final-result", (entry, options) => {
    const panel = new Container();
    if (!options.expanded || !entry.data) return panel;
    panel.addChild(new Text("FINAL-FOREIGN-FIXTURE", 0, 0));
    panel.addChild(new Text("EXTRA-FOREIGN-FIXTURE", 0, 0));
    return panel;
  });
  pi.registerTool({ name: "foreign_leaf", label: "Foreign leaf", description: "Return a provisional fixture.", parameters: Type.Object({}),
    async execute() { return { content: [{ type: "text", text: "PROVISIONAL-FOREIGN-FIXTURE" }], details: {} }; } });
  pi.registerTool({ name: "foreign_parent", label: "Foreign parent", description: "Execute the foreign fixture.", parameters: Type.Object({}),
    async execute(_id, _args, _signal, _update, ctx) { await ctx.executeTool("foreign_leaf", {}); return { content: [{ type: "text", text: "PARENT-FOREIGN-FIXTURE" }], details: {} }; } });
}
