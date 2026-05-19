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
  let listBuf = null; // { kind: "ul" | "ol", items: [] }

  function flushList() {
    if (!listBuf) return;
    const tag = listBuf.kind;
    out.push(`<${tag}>` + listBuf.items.map(it => `<li>${it}</li>`).join("") + `</${tag}>`);
    listBuf = null;
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
    const bullet = line.match(/^[-*]\s+(.*)$/);
    const numbered = line.match(/^\d+\.\s+(.*)$/);
    if (bullet) {
      if (!listBuf || listBuf.kind !== "ul") { flushList(); listBuf = { kind: "ul", items: [] }; }
      listBuf.items.push(inlineFmt(bullet[1]));
      i++;
      continue;
    }
    if (numbered) {
      if (!listBuf || listBuf.kind !== "ol") { flushList(); listBuf = { kind: "ol", items: [] }; }
      listBuf.items.push(inlineFmt(numbered[1]));
      i++;
      continue;
    }
    if (line === "") {
      flushList();
      i++;
      continue;
    }
    // Gather a paragraph until blank or special line.
    const para = [line];
    let j = i + 1;
    while (j < lines.length) {
      const next = lines[j].trimEnd();
      if (next === "" || /^(#{1,4}\s|```|---|[-*]\s|\d+\.\s)/.test(next)) break;
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
