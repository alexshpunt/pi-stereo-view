// LPT-1943: line-level markdown styling for the tree panel. The rows are already wrapped text; a row's style comes from
// its own first characters plus the code-fence state carried down the item, so no inline parsing is needed (and a
// visible range of a few items stays well under a millisecond).

/** @typedef {"plain"|"h1"|"h2"|"h3"|"quote"|"code"|"fence"|"rule"} MdStyle */

/**
 * @param {readonly string[]} rows wrapped rows of one markdown body
 * @returns {{ text: string, style: MdStyle }[]}
 */
export function styleMarkdown(rows) {
  const out = [];
  let fenced = false;
  for (const text of rows) {
    if (/^\s{0,3}(```|~~~)/.test(text)) { fenced = !fenced; out.push({ text, style: "fence" }); continue; }
    if (fenced) { out.push({ text, style: "code" }); continue; }
    let style = "plain";
    if (text.startsWith("# ")) style = "h1";
    else if (text.startsWith("## ")) style = "h2";
    else if (/^#{3,6} /.test(text)) style = "h3";
    else if (text.startsWith("> ")) style = "quote";
    else if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(text)) style = "rule";
    out.push({ text, style });
  }
  return out;
}
