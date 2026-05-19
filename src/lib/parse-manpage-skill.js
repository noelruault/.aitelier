/* Skill manpage view-model. Skills are .md with frontmatter-like metadata
 * (slash, category, tags, summary) plus a markdown body. Returns the
 * structured pieces the manpage component needs. */

export function parseSkillManpage(skill) {
  if (!skill) return { meta: [], invocation: "", body: "" };
  const meta = [
    ["Invocation", skill.slash || "-"],
    ["Category", skill.category || "-"],
    ["Tags", (skill.tags || []).join(", ") || "-"],
    ["Source", skill.source || "builtin"]
  ];
  return {
    meta,
    invocation: skill.slash || "",
    body: skill.body || skill.description || ""
  };
}
