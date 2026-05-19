/* Hook manpage view-model. Phase 2: hooks are folder-shaped, with
 * `hooks/<name>/hook.json` carrying the verbatim settings.json snippet,
 * optional `scripts/` for supporting executables, and optional
 * `README.md` for prose.
 *
 *   parseHookManpage(hook) -> {
 *     meta,                       // metadata table rows
 *     body,                       // prose (README.md content) - empty on shape A/B
 *     snippet, snippetValid,      // raw hook.json + JSON.parse success
 *     installPath,                // where to merge the snippet
 *     structured: {               // decomposed hook.json
 *       event,                    // top-level key inside `hooks` (PreToolUse, ...)
 *       eventKnown,               // boolean - false → unknown event yellow badge
 *       matcher,                  // outer matcher string (regex)
 *       matcherValid,             // boolean - false → red badge
 *       entries: [                // inner hooks[]
 *         { type, command, args, if }
 *       ]
 *     },
 *     scriptRefs                  // [{ scriptPath, attachmentPath }] for cross-linking
 *   }
 *
 * Legacy flat hooks (Phase 1 shape: hooks/<name>.md with frontmatter +
 * fenced JSON) still parse via the old path so an unmigrated fork keeps
 * rendering. hook.snippetRaw (set by buildHook when the canonical file
 * is hook.json) takes precedence over the markdown-body extraction. */

const KNOWN_EVENTS = new Set([
  "PreToolUse", "PostToolUse", "UserPromptSubmit", "Stop", "SubagentStop",
  "Notification", "PreCompact", "SessionStart", "SessionEnd",
  "ConfigChange", "CwdChanged", "FileChanged"
]);

export function parseHookManpage(hook) {
  if (!hook) {
    return {
      meta: [], body: "", snippet: "", snippetValid: false, installPath: "",
      structured: null, scriptRefs: []
    };
  }
  const snippet = hook.snippetRaw || extractFirstJsonFence(hook.body || "");
  const snippetValid = snippet ? safeParseJson(snippet) : false;
  const structured = snippetValid ? buildStructured(snippet) : null;
  const installPath = resolveInstallPath(hook);
  const event = structured ? structured.event : (hook.event || "");
  const matcher = structured ? structured.matcher : (hook.matcher || "");
  const meta = [
    ["Event", event || "-"],
    ["Matcher", matcher || "-"],
    ["Scope", hook.installScope || "-"],
    ["Path", installPath || "-"],
    ["Category", hook.category || "-"],
    ["Tags", (hook.tags || []).join(", ") || "-"],
    ["Source", hook.source || "builtin"]
  ];
  return {
    meta,
    body: hook.body || hook.description || "",
    snippet,
    snippetValid,
    installPath,
    structured,
    scriptRefs: structured ? findScriptRefs(structured, hook) : []
  };
}

/* Decompose hook.json. Picks the first event group + first inner hook for
 * the headline view; multi-entry hook.json renders all entries in the
 * structured section. */
export function buildStructured(rawJson) {
  let obj;
  try { obj = JSON.parse(rawJson); } catch { return null; }
  const hooksMap = obj && typeof obj === "object" ? obj.hooks : null;
  if (!hooksMap || typeof hooksMap !== "object") return null;
  const eventKeys = Object.keys(hooksMap);
  if (!eventKeys.length) return null;
  const event = eventKeys[0];
  const eventKnown = KNOWN_EVENTS.has(event);
  const group = Array.isArray(hooksMap[event]) ? hooksMap[event][0] : null;
  if (!group || typeof group !== "object") {
    return { event, eventKnown, matcher: "", matcherValid: true, entries: [] };
  }
  const matcher = typeof group.matcher === "string" ? group.matcher : "";
  const matcherValid = matcher ? safeRegex(matcher) : true;
  const inner = Array.isArray(group.hooks) ? group.hooks : [];
  const entries = inner.map(h => ({
    type: String(h && h.type || "command"),
    command: typeof h.command === "string" ? h.command : "",
    args: Array.isArray(h.args) ? h.args.map(String) : [],
    if: typeof h.if === "string" ? h.if : ""
  }));
  return { event, eventKnown, matcher, matcherValid, entries };
}

/* Detect ${CLAUDE_PROJECT_DIR}/.claude/hooks/<name>/<rel> or
 * ~/.claude/hooks/<name>/<rel> references inside any command string and
 * map them to attachment paths surfaced by the manifest. */
export function findScriptRefs(structured, hook) {
  if (!structured) return [];
  const name = hook && hook.name;
  if (!name) return [];
  const refs = [];
  const seen = new Set();
  const re = /(?:\$\{CLAUDE_PROJECT_DIR\}|~)\/\.claude\/hooks\/([A-Za-z0-9._-]+)\/([A-Za-z0-9._/-]+)/g;
  for (const entry of structured.entries) {
    const cmd = entry.command || "";
    let m;
    while ((m = re.exec(cmd))) {
      const [, slug, rel] = m;
      if (slug !== name) continue;
      const attachmentPath = `hooks/${slug}/${rel}`;
      if (seen.has(attachmentPath)) continue;
      seen.add(attachmentPath);
      refs.push({ scriptPath: m[0], attachmentPath });
    }
  }
  return refs;
}

/* Fallback used for legacy flat hooks/<name>.md. The body holds the
 * fenced JSON block; we walk markdown line-by-line and lift the first
 * ```json``` block under a `## settings.json snippet` heading. */
export function extractFirstJsonFence(body) {
  const lines = String(body).split(/\r?\n/);
  let inFence = false;
  let lang = "";
  let buf = [];
  let inSettingsSection = false;
  let firstAnyJson = "";
  for (const ln of lines) {
    const headingMatch = ln.match(/^##\s+(.+?)\s*$/);
    if (headingMatch && !inFence) {
      inSettingsSection = /settings\.json\s+snippet/i.test(headingMatch[1]);
      continue;
    }
    const fenceMatch = ln.match(/^\s*```(\w*)\s*$/);
    if (fenceMatch) {
      if (!inFence) {
        inFence = true;
        lang = fenceMatch[1].toLowerCase();
        buf = [];
      } else {
        const block = buf.join("\n").trim();
        if (lang === "json" || lang === "jsonc") {
          if (inSettingsSection) return block;
          if (!firstAnyJson) firstAnyJson = block;
        }
        inFence = false;
        lang = "";
        buf = [];
      }
      continue;
    }
    if (inFence) buf.push(ln);
  }
  return firstAnyJson;
}

export function safeParseJson(s) {
  try { JSON.parse(s); return true; } catch { return false; }
}

export function safeRegex(s) {
  try { new RegExp(s); return true; } catch { return false; }
}

export function resolveInstallPath(hook) {
  if (hook.installPath) return hook.installPath;
  if (hook.installScope === "user") return "~/.claude/settings.json";
  if (hook.installScope === "project") return "<repo>/.claude/settings.json";
  return "";
}
