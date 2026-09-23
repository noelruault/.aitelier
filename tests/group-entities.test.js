import { describe, expect, test } from "bun:test";
import {
  ENTITY_FOLDERS,
  emptyGrouping,
  fromFlatPaths,
  fromWorkerGrouped,
  findEntityShape,
  mainFileFor
} from "../src/lib/group-entities.js";

describe("ENTITY_FOLDERS", () => {
  test("covers the four entity types", () => {
    expect(ENTITY_FOLDERS).toEqual(["prompts", "skills", "agents", "hooks"]);
  });
});

describe("mainFileFor", () => {
  test("returns the canonical entity filename for folder-shape types", () => {
    expect(mainFileFor("skills")).toBe("SKILL.md");
    expect(mainFileFor("agents")).toBe("AGENT.md");
    expect(mainFileFor("hooks")).toBe("hook.json");
  });
  test("returns empty string for prompts (single-file only)", () => {
    expect(mainFileFor("prompts")).toBe("");
  });
});

describe("emptyGrouping", () => {
  test("returns one empty array per entity folder", () => {
    expect(emptyGrouping()).toEqual({ prompts: [], skills: [], agents: [], hooks: [] });
  });
});

describe("fromFlatPaths", () => {
  test("groups single-file entities by folder", () => {
    const out = fromFlatPaths([
      "prompts/naming.md",
      "skills/simple.md",
      "agents/reviewer.md",
      "hooks/prevent-rm-rf.md"
    ]);
    expect(out.prompts.map(e => e.slug)).toEqual(["naming"]);
    expect(out.skills.map(e => e.kind)).toEqual(["file"]);
    expect(out.agents[0].main).toBe("agents/reviewer.md");
    expect(out.hooks[0].slug).toBe("prevent-rm-rf");
  });

  test("identifies folder-shape skills via SKILL.md", () => {
    const out = fromFlatPaths([
      "skills/complex/SKILL.md",
      "skills/complex/scripts/setup.sh",
      "skills/complex/scripts/run.py"
    ], () => 42);
    expect(out.skills).toHaveLength(1);
    const ent = out.skills[0];
    expect(ent.kind).toBe("folder");
    expect(ent.main).toBe("skills/complex/SKILL.md");
    expect(ent.attachments).toEqual([
      { path: "skills/complex/scripts/run.py", size: 42 },
      { path: "skills/complex/scripts/setup.sh", size: 42 }
    ]);
  });

  test("identifies folder-shape hooks via hook.json", () => {
    const out = fromFlatPaths([
      "hooks/big-hook/hook.json",
      "hooks/big-hook/scripts/prevent-rm-rf.js",
      "hooks/big-hook/README.md"
    ]);
    expect(out.hooks).toHaveLength(1);
    expect(out.hooks[0].kind).toBe("folder");
    expect(out.hooks[0].main).toBe("hooks/big-hook/hook.json");
    expect(out.hooks[0].attachments.map(a => a.path)).toEqual([
      "hooks/big-hook/README.md",
      "hooks/big-hook/scripts/prevent-rm-rf.js"
    ]);
  });

  test("excludes server-derived sidecars and history logs from attachments", () => {
    const out = fromFlatPaths([
      "skills/complex/SKILL.md",
      "skills/complex/aitelier.json",
      "skills/complex/history.jsonl",
      "skills/complex/complex.history.jsonl",
      "skills/complex/scripts/run.py"
    ], () => 42);
    expect(out.skills[0].attachments.map(a => a.path)).toEqual([
      "skills/complex/scripts/run.py"
    ]);
  });

  test("ignores folder shape under prompts/", () => {
    const out = fromFlatPaths([
      "prompts/keep.md",
      "prompts/ignored/SKILL.md",
      "prompts/ignored/scripts/run.py"
    ]);
    expect(out.prompts.map(e => e.slug)).toEqual(["keep"]);
  });

  test("drops folder entries with no main file (skipped, not errored)", () => {
    const out = fromFlatPaths([
      "skills/orphan/scripts/run.py"
    ]);
    expect(out.skills).toEqual([]);
  });

  test("flags slug collisions when both shapes exist", () => {
    const out = fromFlatPaths([
      "skills/foo.md",
      "skills/foo/SKILL.md",
      "skills/foo/scripts/run.py"
    ]);
    expect(out.skills).toHaveLength(2);
    expect(out.skills.every(e => e.collision === true)).toBe(true);
  });

  test("sorts entities by slug and attachments by path", () => {
    const out = fromFlatPaths([
      "skills/b.md",
      "skills/a/SKILL.md",
      "skills/a/z.sh",
      "skills/a/a.sh"
    ]);
    expect(out.skills.map(e => e.slug)).toEqual(["a", "b"]);
    expect(out.skills[0].attachments.map(a => a.path)).toEqual([
      "skills/a/a.sh",
      "skills/a/z.sh"
    ]);
  });

  test("ignores junk input", () => {
    expect(fromFlatPaths(null)).toEqual(emptyGrouping());
    expect(fromFlatPaths(undefined)).toEqual(emptyGrouping());
    expect(fromFlatPaths(["no-slash"]).skills).toEqual([]);
    expect(fromFlatPaths([""]).skills).toEqual([]);
  });
});

describe("fromWorkerGrouped", () => {
  test("normalises the Worker payload into the canonical shape", () => {
    const out = fromWorkerGrouped({
      prompts: [{ slug: "naming", kind: "file", main: "prompts/naming.md", attachments: [] }],
      skills:  [{ slug: "x", kind: "folder", main: "skills/x/SKILL.md", attachments: [
        { path: "skills/x/scripts/run.py", size: 10 }
      ] }],
      agents:  [],
      hooks:   [{ slug: "h", kind: "file", main: "hooks/h.md", attachments: [] }]
    });
    expect(out.prompts).toHaveLength(1);
    expect(out.skills[0].attachments[0]).toEqual({ path: "skills/x/scripts/run.py", size: 10 });
    expect(out.hooks[0].slug).toBe("h");
  });

  test("filters entries without a slug or main path", () => {
    const out = fromWorkerGrouped({
      skills: [
        { slug: "", main: "skills/empty.md" },
        { slug: "ok", main: "" }
      ]
    });
    expect(out.skills).toEqual([]);
  });

  test("defaults missing collections to empty arrays", () => {
    expect(fromWorkerGrouped({})).toEqual(emptyGrouping());
    expect(fromWorkerGrouped(null)).toEqual(emptyGrouping());
  });

  test("preserves the collision flag from the Worker", () => {
    const out = fromWorkerGrouped({
      skills: [{ slug: "dup", kind: "file", main: "skills/dup.md", collision: true, attachments: [] }]
    });
    expect(out.skills[0].collision).toBe(true);
  });
});

describe("findEntityShape", () => {
  test("returns the matching entry or null", () => {
    const grouped = fromFlatPaths(["skills/foo.md", "skills/bar/SKILL.md"]);
    expect(findEntityShape(grouped, "skills", "foo").kind).toBe("file");
    expect(findEntityShape(grouped, "skills", "bar").kind).toBe("folder");
    expect(findEntityShape(grouped, "skills", "missing")).toBeNull();
    expect(findEntityShape(grouped, "unknown", "x")).toBeNull();
  });
});
