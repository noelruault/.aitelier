import { describe, expect, test } from "bun:test";
import {
  isServerDerivedPath,
  isMainContentFile,
  sidecarKeyFor,
  mergeSidecar,
  capAnonymous,
} from "../worker/src/library.ts";

/* Pure write-path helpers from library.ts: the 403 server-derived guard, the
 * main-file detector that decides when to stamp, sidecar-key derivation, and
 * the sidecar merge (created_by immutability, contributor dedup, anonymous
 * cap). See .plans/user-management.md §4 / §8 / §9 / §11.8. */

describe("isServerDerivedPath (403 guard)", () => {
  test("blocks flat + folder sidecar shapes", () => {
    expect(isServerDerivedPath("prompts/foo.aitelier.json")).toBe(true);
    expect(isServerDerivedPath("skills/foo/aitelier.json")).toBe(true);
  });
  test("blocks flat + folder history-log shapes", () => {
    expect(isServerDerivedPath("prompts/foo.history.jsonl")).toBe(true);
    expect(isServerDerivedPath("skills/foo/history.jsonl")).toBe(true);
  });
  test("allows real content paths", () => {
    expect(isServerDerivedPath("prompts/foo.md")).toBe(false);
    expect(isServerDerivedPath("skills/foo/SKILL.md")).toBe(false);
    expect(isServerDerivedPath("skills/foo/scripts/run.py")).toBe(false);
  });
});

describe("isMainContentFile (when to stamp)", () => {
  test("flat entity main", () => {
    expect(isMainContentFile("prompts/foo.md")).toBe(true);
  });
  test("grouped entity mains", () => {
    expect(isMainContentFile("skills/foo/SKILL.md")).toBe(true);
    expect(isMainContentFile("agents/foo/AGENT.md")).toBe(true);
    expect(isMainContentFile("hooks/foo/hook.json")).toBe(true);
  });
  test("attachments are not main", () => {
    expect(isMainContentFile("skills/foo/scripts/run.py")).toBe(false);
    expect(isMainContentFile("skills/foo/reference/notes.md")).toBe(false);
  });
});

describe("sidecarKeyFor", () => {
  test("flat -> <slug>.aitelier.json", () => {
    expect(sidecarKeyFor("prompts/foo.md")).toBe("prompts/foo.aitelier.json");
  });
  test("grouped -> <slug>/aitelier.json (main or attachment both map to entity sidecar)", () => {
    expect(sidecarKeyFor("skills/foo/SKILL.md")).toBe("skills/foo/aitelier.json");
    expect(sidecarKeyFor("skills/foo/scripts/run.py")).toBe("skills/foo/aitelier.json");
  });
});

const STAMP = (id, at) => ({ id, label: id ? id.split("@")[0] : null, at, provider: id ? "cloudflare-access" : "none" });

describe("mergeSidecar", () => {
  test("brand-new sidecar sets created_by + last_updated_by + first contributor", () => {
    const m = mergeSidecar({}, {
      folder: "prompts", slug: "foo", contentSha: "sha1",
      stamp: STAMP("alice@x.com", "2026-01-01T00:00:00Z"), existed: false,
    });
    expect(m.id).toBe("foo");
    expect(m.type).toBe("prompts");
    expect(m.content_sha256).toBe("sha1");
    expect(m.created_by.id).toBe("alice@x.com");
    expect(m.last_updated_by.id).toBe("alice@x.com");
    expect(m.contributors).toHaveLength(1);
    expect(m.contributors[0]).toMatchObject({ id: "alice@x.com", count: 1 });
  });

  test("pre-v1 sidecar lacking created_by keeps it absent (no fabricated creator)", () => {
    const m = mergeSidecar({ tags: ["x"], category: "c" }, {
      folder: "prompts", slug: "foo", contentSha: "sha2",
      stamp: STAMP("bob@x.com", "2026-01-02T00:00:00Z"), existed: true,
    });
    expect("created_by" in m).toBe(false);
    expect(m.tags).toEqual(["x"]);            // existing keys preserved
    expect(m.category).toBe("c");
    expect(m.last_updated_by.id).toBe("bob@x.com");
  });

  test("created_by never overwritten on subsequent writes", () => {
    const m = mergeSidecar(
      { created_by: STAMP("alice@x.com", "2026-01-01T00:00:00Z"), contributors: [{ id: "alice@x.com", label: "alice", first_at: "2026-01-01T00:00:00Z", last_at: "2026-01-01T00:00:00Z", count: 1, provider: "cloudflare-access" }] },
      { folder: "prompts", slug: "foo", contentSha: "sha3", stamp: STAMP("bob@x.com", "2026-01-03T00:00:00Z"), existed: true },
    );
    expect(m.created_by.id).toBe("alice@x.com");
    expect(m.last_updated_by.id).toBe("bob@x.com");
    expect(m.contributors).toHaveLength(2);
    expect(m.contributors[0].id).toBe("bob@x.com"); // newest last_at first
  });

  test("repeat author bumps count + last_at, no dup row", () => {
    const m = mergeSidecar(
      { created_by: STAMP("alice@x.com", "2026-01-01T00:00:00Z"), contributors: [{ id: "alice@x.com", label: "alice", first_at: "2026-01-01T00:00:00Z", last_at: "2026-01-01T00:00:00Z", count: 1, provider: "cloudflare-access" }] },
      { folder: "prompts", slug: "foo", contentSha: "sha4", stamp: STAMP("alice@x.com", "2026-02-01T00:00:00Z"), existed: true },
    );
    expect(m.contributors).toHaveLength(1);
    expect(m.contributors[0].count).toBe(2);
    expect(m.contributors[0].last_at).toBe("2026-02-01T00:00:00Z");
    expect(m.contributors[0].first_at).toBe("2026-01-01T00:00:00Z");
  });

  test("anonymous writes never dedupe (one row per write)", () => {
    let doc = {};
    doc = mergeSidecar(doc, { folder: "prompts", slug: "foo", contentSha: "s", stamp: STAMP(null, "2026-01-01T00:00:00Z"), existed: false });
    doc = mergeSidecar(doc, { folder: "prompts", slug: "foo", contentSha: "s", stamp: STAMP(null, "2026-01-02T00:00:00Z"), existed: true });
    expect(doc.contributors).toHaveLength(2);
    expect(doc.contributors.every(c => c.id === null)).toBe(true);
  });
});

describe("capAnonymous", () => {
  test("keeps all authenticated, caps anonymous to max (newest first)", () => {
    const list = [];
    for (let i = 0; i < 60; i++) list.push({ id: null, label: null, first_at: "", last_at: `a${String(i).padStart(3, "0")}`, count: 1, provider: "none" });
    list.push({ id: "alice@x.com", label: "alice", first_at: "", last_at: "z", count: 3, provider: "cloudflare-access" });
    // sort desc like mergeSidecar does
    list.sort((a, b) => String(b.last_at).localeCompare(String(a.last_at)));
    const capped = capAnonymous(list, 50);
    expect(capped.filter(c => c.id != null)).toHaveLength(1);   // authenticated kept
    expect(capped.filter(c => c.id == null)).toHaveLength(50);  // anonymous capped
  });
});
