import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function replaceUserMessage(pi: ExtensionAPI): void {
  pi.on("message_end", event => {
    if (event.message.role !== "user") return;
    const message = event.message;
    const prefix = `[${new Date(message.timestamp).toISOString()}]`;
    return { message: { ...message, content: typeof message.content === "string"
      ? prefix + "\n" + message.content
      : [{ type: "text" as const, text: prefix }, ...message.content] } };
  });
}
