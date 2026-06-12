/* Tiny YAML frontmatter parser. Handles only the shapes our entity markdowns
 * use: scalars (quoted or bare), flow lists `[a, b]`, block lists (next lines
 * starting with `- `), block scalars (`>` folded, `|` literal, with optional
 * `-`/`+` chomping), booleans, integers, floats. Anchors / nested maps are
 * not supported.
 *
 *   parseFrontmatter(text) -> { meta, body }
 *   parseSteps(body) -> [{ label, body }]  (for multi-step prompts)
 */

export function parseFrontmatter(text) {
  const t = String(text);
  const m = t.match(/^---\s*\r?\n([\s\S]*?)\r?\n---\s*\r?\n?([\s\S]*)$/);
  if (!m) return { meta: {}, body: t };
  return { meta: parseYamlScalarMap(m[1]), body: m[2] };
}

export function parseYamlScalarMap(src) {
  const out = {};
  const lines = src.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim() || line.trim().startsWith("#")) continue;
    const km = line.match(/^([A-Za-z_][A-Za-z0-9_-]*):\s*(.*)$/);
    if (!km) continue;
    const key = km[1];
    const val = km[2];
    const block = val.trim().match(/^([>|])([+-])?\s*(?:#.*)?$/);
    if (block) {
      const collected = [];
      while (i + 1 < lines.length && (lines[i + 1].trim() === "" || /^\s/.test(lines[i + 1]))) {
        i++;
        collected.push(lines[i]);
      }
      out[key] = foldBlockScalar(collected, block[1]);
      continue;
    }
    if (val.trim() === "") {
      // Block list on following lines
      const list = [];
      while (i + 1 < lines.length && /^\s*-\s+/.test(lines[i + 1])) {
        i++;
        list.push(coerceScalar(lines[i].replace(/^\s*-\s+/, "").trim()));
      }
      out[key] = list;
      continue;
    }
    const trimmed = val.trim();
    if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
      out[key] = splitFlowList(trimmed.slice(1, -1)).map(coerceScalar);
      continue;
    }
    out[key] = coerceScalar(trimmed);
  }
  return out;
}

/* Join the indented lines of a block scalar. `>` folds line breaks into
 * spaces (blank lines become paragraph breaks); `|` keeps them literal.
 * Chomping indicators only affect trailing newlines, which we trim away
 * anyway: frontmatter values are display strings, not byte-exact docs. */
function foldBlockScalar(rawLines, style) {
  const nonBlank = rawLines.filter(l => l.trim() !== "");
  if (!nonBlank.length) return "";
  const indent = Math.min(...nonBlank.map(l => l.match(/^\s*/)[0].length));
  const lines = rawLines.map(l => (l.trim() === "" ? "" : l.slice(indent)));
  while (lines.length && lines[lines.length - 1] === "") lines.pop();
  if (style === "|") return lines.join("\n");
  let out = "";
  for (const ln of lines) {
    if (ln === "") out += "\n";
    else out += (out === "" || out.endsWith("\n") ? "" : " ") + ln;
  }
  return out;
}

export function splitFlowList(inner) {
  // Naive split on commas not inside quotes
  const items = [];
  let buf = "";
  let q = null;
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i];
    if (q) {
      buf += c;
      if (c === q) q = null;
      continue;
    }
    if (c === '"' || c === "'") { q = c; buf += c; continue; }
    if (c === ",") { items.push(buf); buf = ""; continue; }
    buf += c;
  }
  if (buf.trim()) items.push(buf);
  return items.map(s => s.trim()).filter(Boolean);
}

export function coerceScalar(s) {
  if (s.length >= 2 && ((s[0] === '"' && s[s.length - 1] === '"') || (s[0] === "'" && s[s.length - 1] === "'"))) {
    return s.slice(1, -1);
  }
  if (s === "true") return true;
  if (s === "false") return false;
  if (s === "null" || s === "~") return null;
  if (/^-?\d+$/.test(s)) return parseInt(s, 10);
  if (/^-?\d+\.\d+$/.test(s)) return parseFloat(s);
  return s;
}

/* Multi-step prompt body splitter. Headings of the form
 *   ## Step <n>, <label>
 * delimit steps. Anything before the first such heading is dropped. */
export function parseSteps(body) {
  const lines = String(body).split(/\r?\n/);
  const steps = [];
  let cur = null;
  for (const ln of lines) {
    const m = ln.match(/^##\s+Step\s+(\d+)[,:]?\s*(.*)$/);
    if (m) {
      if (cur) { cur.body = cur.body.trim(); steps.push(cur); }
      const label = m[2].trim() ? `Step ${m[1]}, ${m[2].trim()}` : `Step ${m[1]}`;
      cur = { label, body: "" };
    } else if (cur) {
      cur.body += ln + "\n";
    }
  }
  if (cur) { cur.body = cur.body.trim(); steps.push(cur); }
  return steps;
}
