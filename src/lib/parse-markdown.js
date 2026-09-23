import { escapeHtml } from "./util.js";

/* Mini markdown renderer. Enough for skill/agent body display.
 * Supports:
 *  - # H1 / ## H2 / ### H3
 *  - paragraphs separated by blank lines
 *  - - bullet lists, 1. numbered lists
 *  - ```fenced code``` blocks (single language ignored)
 *  - `inline code`
 *  - **bold** and *italic*
 *  - [text](url) links
 *  - --- horizontal rule
 * Returns an HTML string. Inputs are escaped before formatting tokens
 * are applied, so no XSS via untrusted markdown. */

export function renderMarkdown(src) {
  if (!src) return "";
  const lines = String(src).split("\n");
  let out = [];
  let i = 0;
  let inCode = false;
  let codeBuf = [];
  // Stack supports nested lists. Each frame: { kind, indent, items: [{ text, children: "" }] }
  let listStack = [];

  function renderFrame(frame) {
    return `<${frame.kind}>` + frame.items.map(it => `<li>${it.text}${it.children || ""}</li>`).join("") + `</${frame.kind}>`;
  }
  function popFrame() {
    const done = listStack.pop();
    const html = renderFrame(done);
    if (listStack.length) {
      const parent = listStack[listStack.length - 1];
      const last = parent.items[parent.items.length - 1];
      last.children += html;
    } else {
      out.push(html);
    }
  }
  function flushList() {
    while (listStack.length) popFrame();
  }

  while (i < lines.length) {
    const raw = lines[i];
    const line = raw.trimEnd();

    if (line.startsWith("```")) {
      if (inCode) {
        flushList();
        out.push(`<pre class="md-code"><code>${escapeHtml(codeBuf.join("\n"))}</code></pre>`);
        codeBuf = [];
        inCode = false;
      } else {
        flushList();
        inCode = true;
      }
      i++;
      continue;
    }
    if (inCode) {
      codeBuf.push(raw);
      i++;
      continue;
    }
    if (/^---+\s*$/.test(line)) {
      flushList();
      out.push(`<hr class="md-rule">`);
      i++;
      continue;
    }
    const heading = line.match(/^(#{1,4})\s+(.*)$/);
    if (heading) {
      flushList();
      const level = heading[1].length;
      const text = inlineFmt(heading[2]);
      out.push(`<h${level + 2} class="md-h${level}">${text}</h${level + 2}>`);
      i++;
      continue;
    }
    const bullet = line.match(/^(\s*)[-*]\s+(.*)$/);
    const numbered = line.match(/^(\s*)\d+\.\s+(.*)$/);
    if (bullet || numbered) {
      const indent = (bullet || numbered)[1].length;
      const kind = bullet ? "ul" : "ol";
      const text = inlineFmt((bullet || numbered)[2]);
      while (listStack.length && listStack[listStack.length - 1].indent > indent) popFrame();
      const top = listStack[listStack.length - 1];
      if (!top || top.indent < indent) {
        listStack.push({ kind, indent, items: [{ text, children: "" }] });
      } else if (top.kind !== kind) {
        popFrame();
        listStack.push({ kind, indent, items: [{ text, children: "" }] });
      } else {
        top.items.push({ text, children: "" });
      }
      i++;
      continue;
    }
    if (line === "") {
      flushList();
      i++;
      continue;
    }
    // Indented continuation of the last list item (lazy multi-line items).
    if (listStack.length && /^\s+\S/.test(raw)) {
      const top = listStack[listStack.length - 1];
      const last = top.items[top.items.length - 1];
      last.text += " " + inlineFmt(line.trim());
      i++;
      continue;
    }
    // Gather a paragraph until blank or special line.
    const para = [line];
    let j = i + 1;
    while (j < lines.length) {
      const next = lines[j].trimEnd();
      if (next === "" || /^(#{1,4}\s|```|---|\s*[-*]\s|\s*\d+\.\s)/.test(next)) break;
      para.push(next);
      j++;
    }
    flushList();
    out.push(`<p class="md-p">${inlineFmt(para.join(" "))}</p>`);
    i = j;
  }
  flushList();
  if (inCode) out.push(`<pre class="md-code"><code>${escapeHtml(codeBuf.join("\n"))}</code></pre>`);
  return out.join("\n");
}

export function inlineFmt(text) {
  // Escape first, then apply formatting tokens.
  let s = escapeHtml(text);
  // Inline code with backticks
  s = s.replace(/`([^`]+)`/g, '<code class="md-inline-code">$1</code>');
  // Bold **x**
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  // Italic *x* (avoid clashing with ** by negative lookbehind not supported in old browsers; rely on ** consumed first)
  s = s.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>');
  // Links [text](url)
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  return s;
}
