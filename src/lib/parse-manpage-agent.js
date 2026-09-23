/* Agent manpage view-model. Agents are .md with frontmatter (model, tools,
 * description) + markdown body. */

export function parseAgentManpage(agent) {
  if (!agent) return { meta: [], body: "" };
  const meta = [
    ["Model", agent.model || "inherit"],
    ["Tools", agent.tools || "*"],
    ["Category", agent.category || "-"],
    ["Tags", (agent.tags || []).join(", ") || "-"],
    ["Source", agent.source || "builtin"]
  ];
  return { meta, body: agent.body || agent.description || "" };
}
