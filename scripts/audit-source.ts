#!/usr/bin/env bun
/* Supply-chain source audit - the trojan-horse grep checklist from
 * .plans/0010_claude-pe-fork-and-pin.md §2.2, executable.
 *
 * Scans the shipped/executed surface for the primitives a hidden payload
 * needs, and fails loudly when one appears:
 *
 *   1. Dynamic code execution: eval(, new Function
 *   2. Payload decoding: atob(, btoa(, String.fromCharCode
 *   3. Dynamic import with a non-relative specifier
 *   4. Literal http(s) URLs whose host is not on the allow-list
 *      (api.github.com + raw.githubusercontent.com, the external-fork
 *      loader; everything else the app does is same-origin)
 *   5. Trojan Source: Unicode bidi control characters (U+202A-U+202E,
 *      U+2066-U+2069) anywhere in the tree, content included
 *
 * Checks 1-4 strip comment lines first (doc links are not code paths);
 * check 5 runs on raw bytes because hiding in comments is the attack.
 *
 * Run from the repo/site root: `bun run scripts/audit-source.ts [root]`.
 * Exit 0 clean, exit 1 with file:line findings. Consumed by
 * .github/workflows/audit.yml and by publish-library.yml so third-party
 * builds audit the shell (and their own overlaid content) on every run.
 */

import { readFileSync } from "fs";
import { join } from "path";

const ROOT = process.argv[2] ?? join(import.meta.dir, "..");

const ALLOWED_HOSTS = new Set([
  "api.github.com",            // external-fork loader (transport-direct, fork-staleness)
  "raw.githubusercontent.com", // external-fork raw content + bundle
  "github.com",                // navbar "view source" link
]);

// Checks 1-4 cover the shipped/executed surface: the SPA, the snapshot's
// scripts (the whitelist in publish-demo.sh), and the workflows. Local-only
// tooling under scripts/ (setup-access, bench, ...) neither ships nor runs
// in consumer builds. This file is excluded from scanning itself: its
// detection patterns would self-match.
const CODE_GLOBS = ["src/**/*.js", "index.html", "scripts/build-manifest.ts", "scripts/validate-entities.ts", ".github/workflows/*.yml"];
// Check 5 covers the whole tree: a bidi trick in a markdown entity is an
// attack on whoever pastes the prompt.
const BIDI_GLOBS = ["**/*.js", "**/*.ts", "**/*.md", "**/*.yml", "**/*.json", "**/*.html", "**/*.css"];
const SKIP = /(^|\/)(node_modules|\.git)\/|^scripts\/audit-source\.ts$/;

const BIDI = /[‪-‮⁦-⁩]/;
const URL_RE = /https?:\/\/([a-z0-9][a-z0-9.-]*)/gi;

const scan = (globs: string[]) => {
  const seen = new Set<string>();
  for (const g of globs) {
    for (const rel of new Bun.Glob(g).scanSync({ cwd: ROOT })) {
      if (!SKIP.test(rel)) seen.add(rel);
    }
  }
  return [...seen].sort();
};

function stripComment(line: string, rel: string): string {
  if (rel.endsWith(".yml")) return line.replace(/(^|\s)#.*$/, "");
  // JS/TS/HTML: drop full-line comments and JSDoc continuations. Inline
  // trailing comments stay (cheap parser; better a rare false positive
  // than a stripped real call).
  if (/^\s*(\/\/|\/?\*|<!--)/.test(line)) return "";
  return line;
}

type Finding = [string, number, string, string]; // file, line, check, detail
const findings: Finding[] = [];
const checkHits: Record<string, number> = {
  "dynamic code execution": 0,
  "payload decoding": 0,
  "dynamic import": 0,
  "URL allow-list": 0,
  "Trojan Source (bidi)": 0,
};
const allowedUrlSites: string[] = []; // file:line host - the verified-OK URLs
const urlHostCounts = new Map<string, number>();

const hit = (rel: string, line: number, check: string, detail: string) => {
  checkHits[check]++;
  findings.push([rel, line, check, detail]);
};

const codeFiles = scan(CODE_GLOBS);
for (const rel of codeFiles) {
  const lines = readFileSync(join(ROOT, rel), "utf8").split(/\r?\n/);
  lines.forEach((raw, i) => {
    const line = stripComment(raw, rel);
    if (!line) return;
    if (/\beval\s*\(/.test(line)) hit(rel, i + 1, "dynamic code execution", "eval()");
    if (/\bnew\s+Function\b/.test(line)) hit(rel, i + 1, "dynamic code execution", "new Function");
    if (/\b(atob|btoa)\s*\(/.test(line)) hit(rel, i + 1, "payload decoding", "base64 decode/encode");
    if (/String\.fromCharCode/.test(line)) hit(rel, i + 1, "payload decoding", "String.fromCharCode");
    if (/\bimport\s*\(\s*[^"'\s)]/.test(line) || /\bimport\s*\(\s*["'](?!\.{0,2}\/)/.test(line)) {
      hit(rel, i + 1, "dynamic import", "non-relative specifier");
    }
    for (const m of line.matchAll(URL_RE)) {
      const host = m[1].toLowerCase();
      urlHostCounts.set(host, (urlHostCounts.get(host) ?? 0) + 1);
      if (ALLOWED_HOSTS.has(host)) allowedUrlSites.push(`${rel}:${i + 1} -> ${host}`);
      else hit(rel, i + 1, "URL allow-list", `host not allow-listed: ${host}`);
    }
  });
}

const bidiFiles = scan(BIDI_GLOBS);
for (const rel of bidiFiles) {
  const lines = readFileSync(join(ROOT, rel), "utf8").split(/\r?\n/);
  lines.forEach((raw, i) => {
    if (BIDI.test(raw)) hit(rel, i + 1, "Trojan Source (bidi)", "Unicode bidi control character");
  });
}

// ---- Report ----------------------------------------------------------------
const urlsTotal = [...urlHostCounts.values()].reduce((a, b) => a + b, 0);
const hostSummary = [...urlHostCounts.entries()].sort()
  .map(([h, n]) => `${h} x${n}`).join(", ") || "none";

console.log(`audit-source: root ${ROOT}`);
console.log(`  code surface : ${codeFiles.length} files (${CODE_GLOBS.join(", ")})`);
console.log(`  bidi surface : ${bidiFiles.length} files (js/ts/md/yml/json/html/css, full tree)`);
console.log(`  URL literals : ${urlsTotal} seen (${hostSummary})`);
console.log("");
for (const [check, n] of Object.entries(checkHits)) {
  console.log(`  ${(check + " ").padEnd(26, ".")} ${n} finding(s)`);
}
if (allowedUrlSites.length) {
  console.log(`\n  allow-listed URL call sites (verified OK):`);
  for (const s of allowedUrlSites) console.log(`    ${s}`);
}

// GitHub Actions job summary, when running in CI.
const summaryPath = process.env.GITHUB_STEP_SUMMARY;
if (summaryPath) {
  const rows = Object.entries(checkHits).map(([c, n]) => `| ${c} | ${n} |`).join("\n");
  const verdict = findings.length ? `🔴 **${findings.length} finding(s)**` : "🟢 **clean**";
  await Bun.write(summaryPath, [
    `## audit-source: ${verdict}`,
    "",
    `Scanned **${codeFiles.length}** code files, **${bidiFiles.length}** files for bidi controls, verified **${urlsTotal}** URL literals (${hostSummary}).`,
    "",
    "| check | findings |", "|---|---|", rows,
    "",
    findings.length
      ? findings.map(([r, l, c, d]) => `- \`${r}:${l}\` ${c}: ${d}`).join("\n")
      : `Allow-listed URL call sites:\n${allowedUrlSites.map(s => `- \`${s}\``).join("\n")}`,
    "",
  ].join("\n"));
}

if (findings.length) {
  console.error(`\naudit-source: ${findings.length} finding(s)\n`);
  for (const [rel, line, check, detail] of findings) console.error(`  ${rel}:${line}: ${check}: ${detail}`);
  console.error("\nEither remove the primitive or, if structurally legitimate, extend the allow-list in scripts/audit-source.ts with a comment justifying it.");
  process.exit(1);
}
console.log(`\naudit-source: clean (${codeFiles.length} code files, ${bidiFiles.length} bidi-scanned, ${urlsTotal} URLs verified)`);
