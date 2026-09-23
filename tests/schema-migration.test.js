import { describe, expect, test } from "bun:test";
import { humanizeName } from "../src/lib/util.js";
import { buildAgent, buildPrompt, buildSkill, buildHook } from "../src/data/load-entities.js";
import { parseFrontmatter } from "../src/lib/parse-frontmatter.js";
import { parseHookManpage, buildStructured, safeRegex, findScriptRefs } from "../src/lib/parse-manpage-hook.js";

/* Phase 1 schema migration. Covers humanizeName, sidecar merging, and the
 * dual-read fallback that keeps unmigrated seeds rendering. */

describe("humanizeName", () => {
  test("kebab-case to Title Case", () => {
    expect(humanizeName("code-reviewer")).toBe("Code Reviewer");
    expect(humanizeName("go-hot-pot-jo")).toBe("Go Hot Pot Jo");
  });
  test("single word", () => {
    expect(humanizeName("simple")).toBe("Simple");
  });
  test("empty / nullish", () => {
    expect(humanizeName("")).toBe("");
    expect(humanizeName(undefined)).toBe("");
    expect(humanizeName(null)).toBe("");
  });
  test("strips empty segments from leading/trailing/double dashes", () => {
    expect(humanizeName("--code--reviewer-")).toBe("Code Reviewer");
  });
});

describe("parseFrontmatter: block scalars", () => {
  test("folded scalar (>) joins lines with spaces", () => {
    const md = "---\nname: x\ndescription: >\n  Line one\n  line two.\n---\nbody";
    const { meta } = parseFrontmatter(md);
    expect(meta.description).toBe("Line one line two.");
  });
  test("folded scalar keeps blank lines as paragraph breaks", () => {
    const md = "---\ndescription: >\n  Para one.\n\n  Para two.\n---\n";
    const { meta } = parseFrontmatter(md);
    expect(meta.description).toBe("Para one.\nPara two.");
  });
  test("literal scalar (|) keeps line breaks", () => {
    const md = "---\nscript: |\n  line1\n  line2\n---\n";
    const { meta } = parseFrontmatter(md);
    expect(meta.script).toBe("line1\nline2");
  });
  test("chomping indicators (>-, |-) accepted", () => {
    const md = "---\na: >-\n  one\n  two\nb: |-\n  x\n---\n";
    const { meta } = parseFrontmatter(md);
    expect(meta.a).toBe("one two");
    expect(meta.b).toBe("x");
  });
  test("block scalar stops at next top-level key", () => {
    const md = "---\ndescription: >\n  folded text\nname: real-name\n---\n";
    const { meta } = parseFrontmatter(md);
    expect(meta.description).toBe("folded text");
    expect(meta.name).toBe("real-name");
  });
});

describe("buildAgent: Claude-spec frontmatter + sidecar", () => {
  test("reads name/description, leaves category undefined without sidecar", () => {
    const md = "---\nname: code-reviewer\ndescription: Reviews code\n---\nbody";
    const e = buildAgent(parseFrontmatter(md), "code-reviewer", null);
    expect(e.name).toBe("code-reviewer");
    expect(e.id).toBe("code-reviewer");
    expect(e.description).toBe("Reviews code");
    expect(e.category).toBeUndefined();
    expect(e.tags).toEqual([]);
  });
  test("sidecar supplies category / tags / source", () => {
    const md = "---\nname: code-reviewer\ndescription: Reviews code\n---\nbody";
    const sidecar = { category: "review", tags: ["code", "quality"], source: "builtin" };
    const e = buildAgent(parseFrontmatter(md), "code-reviewer", sidecar);
    expect(e.category).toBe("review");
    expect(e.tags).toEqual(["code", "quality"]);
    expect(e.source).toBe("builtin");
  });
});

describe("dual-read fallback (unmigrated seeds)", () => {
  test("falls back to id/summary when name/description absent", () => {
    const md = "---\nid: old-agent\ntitle: Old Agent\nsummary: Legacy summary\n---\nbody";
    const e = buildAgent(parseFrontmatter(md), "old-agent", null);
    expect(e.name).toBe("old-agent");
    expect(e.description).toBe("Legacy summary");
  });
  test("falls back to filename slug when frontmatter has neither", () => {
    const md = "---\nmodel: opus\n---\nbody";
    const e = buildAgent(parseFrontmatter(md), "fallback-slug", null);
    expect(e.name).toBe("fallback-slug");
  });
});

describe("buildPrompt: multi-step via sidecar", () => {
  test("sidecar.steps drives the multi-step view", () => {
    const md = "---\nname: workflow\ndescription: A workflow\n---\nfirst step body";
    const sidecar = {
      category: "workflow",
      steps: [
        { label: "Step 1", body: "first" },
        { label: "Step 2", body: "second" }
      ]
    };
    const e = buildPrompt(parseFrontmatter(md), "workflow", sidecar);
    expect(e.steps).toHaveLength(2);
    expect(e.steps[0].label).toBe("Step 1");
    expect(e.body).toBe("first step body");
  });
  test("single-step prompt has no steps array", () => {
    const md = "---\nname: simple\ndescription: One-shot\n---\nbody only";
    const e = buildPrompt(parseFrontmatter(md), "simple", null);
    expect(e.steps).toBeUndefined();
    expect(e.body).toBe("body only");
  });
  test("legacy multi_step frontmatter still splits the body when no sidecar", () => {
    const md = "---\nname: legacy\nmulti_step: true\ndescription: legacy multi\n---\n## Step 1, intro\nbody1\n\n## Step 2, follow\nbody2";
    const e = buildPrompt(parseFrontmatter(md), "legacy", null);
    expect(e.steps).toHaveLength(2);
  });
});

describe("buildSkill: derived slash", () => {
  test("slash derives from name when frontmatter does not carry one", () => {
    const md = "---\nname: my-skill\ndescription: skill body\n---\nbody";
    const e = buildSkill(parseFrontmatter(md), "my-skill", null);
    expect(e.slash).toBe("/my-skill");
  });
  test("explicit slash in frontmatter wins (legacy)", () => {
    const md = "---\nname: my-skill\nslash: /custom\ndescription: x\n---\nbody";
    const e = buildSkill(parseFrontmatter(md), "my-skill", null);
    expect(e.slash).toBe("/custom");
  });
});

describe("buildHook (Phase 1 legacy): reads frontmatter when no JSON shape detected", () => {
  test("legacy flat hook reads event/matcher from frontmatter", () => {
    // install is a nested map - our YAML parser does not support nested
    // maps, so installScope/installPath stay empty here; pre-Phase-1
    // limitation, out of scope for the migration.
    const md = "---\nname: prevent-rm-rf\ndescription: blocks rm -rf\nevent: PreToolUse\nmatcher: Bash\n---\nbody";
    const sidecar = { category: "security", tags: ["safety"] };
    const parsed = parseFrontmatter(md);
    parsed.__rawSource = md;
    const e = buildHook(parsed, "prevent-rm-rf", sidecar, null);
    expect(e.name).toBe("prevent-rm-rf");
    expect(e.description).toBe("blocks rm -rf");
    expect(e.event).toBe("PreToolUse");
    expect(e.matcher).toBe("Bash");
    expect(e.category).toBe("security");
    expect(e.tags).toEqual(["safety"]);
    expect(e.snippetRaw).toBeUndefined();
  });
});

describe("buildHook (Phase 2 folder shape): hook.json + sidecar + prose", () => {
  const hookJson = JSON.stringify({
    hooks: {
      PreToolUse: [
        { matcher: "Bash", hooks: [{ type: "command", command: "echo hi" }] }
      ]
    }
  });
  const sidecar = {
    name: "prevent-rm-rf",
    description: "Blocks rm -rf",
    category: "security",
    tags: ["safety"],
    source: "builtin",
    install: { scope: "user", path: "~/.claude/settings.json" }
  };
  test("snippetRaw + body set from hook.json + README.md", () => {
    const parsed = { meta: {}, body: hookJson, __rawSource: hookJson };
    const e = buildHook(parsed, "prevent-rm-rf", sidecar, "Prose body.");
    expect(e.name).toBe("prevent-rm-rf");
    expect(e.description).toBe("Blocks rm -rf");
    expect(e.installScope).toBe("user");
    expect(e.installPath).toBe("~/.claude/settings.json");
    expect(e.snippetRaw).toBe(hookJson);
    expect(e.body).toBe("Prose body.");
    expect(e.category).toBe("security");
  });
  test("shape A: no prose → body empty, Description section will be skipped", () => {
    const parsed = { meta: {}, body: hookJson, __rawSource: hookJson };
    const e = buildHook(parsed, "prevent-rm-rf", sidecar, null);
    expect(e.body).toBe("");
  });
  test("default install scope is user when sidecar omits install", () => {
    const parsed = { meta: {}, body: hookJson, __rawSource: hookJson };
    const minimal = { name: "x", description: "y" };
    const e = buildHook(parsed, "x", minimal, null);
    expect(e.installScope).toBe("user");
  });
});

describe("parseHookManpage / buildStructured", () => {
  const hookJson = JSON.stringify({
    hooks: {
      PreToolUse: [
        { matcher: "Bash", hooks: [{ type: "command", command: "echo hi", args: ["a", "b"] }] }
      ]
    }
  });
  test("structured decomposition exposes event/matcher/entries", () => {
    const s = buildStructured(hookJson);
    expect(s.event).toBe("PreToolUse");
    expect(s.eventKnown).toBe(true);
    expect(s.matcher).toBe("Bash");
    expect(s.matcherValid).toBe(true);
    expect(s.entries).toHaveLength(1);
    expect(s.entries[0].command).toBe("echo hi");
    expect(s.entries[0].args).toEqual(["a", "b"]);
  });
  test("unknown event flagged via eventKnown=false", () => {
    const s = buildStructured(JSON.stringify({ hooks: { ImaginaryEvent: [{ matcher: "x", hooks: [] }] } }));
    expect(s.event).toBe("ImaginaryEvent");
    expect(s.eventKnown).toBe(false);
  });
  test("bad regex matcher flagged via matcherValid=false", () => {
    const s = buildStructured(JSON.stringify({ hooks: { Stop: [{ matcher: "[", hooks: [] }] } }));
    expect(s.matcherValid).toBe(false);
  });
  test("invalid JSON returns null", () => {
    expect(buildStructured("not json")).toBeNull();
  });
  test("safeRegex helper", () => {
    expect(safeRegex("Bash")).toBe(true);
    expect(safeRegex("[")).toBe(false);
  });
  test("parseHookManpage prefers snippetRaw over markdown extraction", () => {
    const hook = {
      name: "h", description: "", body: "", snippetRaw: hookJson,
      installScope: "user", tags: []
    };
    const vm = parseHookManpage(hook);
    expect(vm.snippet).toBe(hookJson);
    expect(vm.structured.event).toBe("PreToolUse");
    expect(vm.snippetValid).toBe(true);
  });
});

describe("findScriptRefs cross-linking", () => {
  test("matches CLAUDE_PROJECT_DIR and ~ script paths owned by this hook", () => {
    const structured = {
      event: "PreToolUse", eventKnown: true, matcher: "Bash", matcherValid: true,
      entries: [
        { type: "command", command: "${CLAUDE_PROJECT_DIR}/.claude/hooks/my-hook/scripts/run.sh && ~/.claude/hooks/my-hook/scripts/run.sh", args: [], if: "" }
      ]
    };
    const refs = findScriptRefs(structured, { name: "my-hook" });
    expect(refs).toHaveLength(1);
    expect(refs[0].attachmentPath).toBe("hooks/my-hook/scripts/run.sh");
  });
  test("ignores script paths owned by another hook slug", () => {
    const structured = {
      event: "Stop", eventKnown: true, matcher: "", matcherValid: true,
      entries: [{ type: "command", command: "${CLAUDE_PROJECT_DIR}/.claude/hooks/other-hook/scripts/run.sh", args: [], if: "" }]
    };
    expect(findScriptRefs(structured, { name: "my-hook" })).toEqual([]);
  });
});
