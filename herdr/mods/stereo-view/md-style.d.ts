export type MdStyle = "plain" | "h1" | "h2" | "h3" | "quote" | "code" | "fence" | "rule";
export function styleMarkdown(rows: readonly string[]): { text: string; style: MdStyle }[];
