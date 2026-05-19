/* Agent manpage view-model. Agents are .md with frontmatter (model, tools,
 * description) + markdown body. The "spawn syntax" is a code snippet
 * users paste into their AI/LLM conversation when delegating. */

export function parseAgentManpage(agent) {
  if (!agent) return { meta: [], spawn: "", body: "" };
  const meta = [
    ["Model", agent.model || "inherit"],
    ["Tools", agent.tools || "*"],
    ["Category", agent.category || "-"],
    ["Tags", (agent.tags || []).join(", ") || "-"],
    ["Source", agent.source || "builtin"]
  ];
  const spawn = renderSpawnSyntax(agent);
  return { meta, spawn, body: agent.body || agent.description || "" };
}

export function renderSpawnSyntax(agent) {
  return `Agent(
  subagent_type: "${agent.name}",
  prompt: "<your task>",
  isolation: "worktree"     // optional
)`;
}
