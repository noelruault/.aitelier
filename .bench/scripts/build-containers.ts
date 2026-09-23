#!/usr/bin/env bun
/**
 * build-containers.ts - pack the Aitelier entity corpus into the 5
 * candidate container formats. Output goes to .bench/artifacts/.
 *
 * Usage:  bun run .bench/scripts/build-containers.ts
 */

import { readdirSync, readFileSync, writeFileSync, statSync, mkdirSync } from "fs";
import { join, relative } from "path";

const REPO = "/Users/noelruault/go/src/github.com/noelruault/aitelier";
const ART = join(REPO, ".bench/artifacts");
const ROOTS = ["prompts", "skills", "agents", "hooks"];
const ALLOW = new Set([".md", ".sh", ".py", ".js", ".ts", ".json", ".yaml", ".yml", ".txt", ".toml"]);

mkdirSync(ART, { recursive: true });

function walk(dir: string, out: string[] = []) {
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, ent.name);
    if (ent.isDirectory()) walk(p, out);
    else if (ent.isFile()) {
      const dot = ent.name.lastIndexOf(".");
      const ext = dot >= 0 ? ent.name.slice(dot) : "";
      if (ALLOW.has(ext)) out.push(p);
    }
  }
  return out;
}

const files: { path: string; bytes: Buffer }[] = [];
for (const r of ROOTS) {
  for (const abs of walk(join(REPO, r)).sort()) {
    files.push({ path: relative(REPO, abs), bytes: readFileSync(abs) });
  }
}

let raw_total = 0;
for (const f of files) raw_total += f.bytes.length;
console.log(`# files=${files.length} raw_total=${raw_total} bytes`);

// 1. json-object: { "path/foo.md": "raw text", … }
{
  const o: Record<string, string> = {};
  for (const f of files) o[f.path] = f.bytes.toString("utf8");
  writeFileSync(join(ART, "bundle.json"), JSON.stringify(o));
}

// 2. ndjson: one {"path":..,"body":..} per line
{
  const lines: string[] = [];
  for (const f of files) {
    lines.push(JSON.stringify({ path: f.path, body: f.bytes.toString("utf8") }));
  }
  writeFileSync(join(ART, "bundle.ndjson"), lines.join("\n") + "\n");
}

// 3. sentinel-cat: \0path\0length\0body... repeating
//    NUL is safe: paths and bodies are utf-8 text or shell that never contain \0.
//    length is decimal ASCII for trivial parse.
{
  const chunks: Buffer[] = [];
  for (const f of files) {
    chunks.push(Buffer.from("\0" + f.path + "\0" + f.bytes.length + "\0"));
    chunks.push(f.bytes);
  }
  writeFileSync(join(ART, "bundle.cat"), Buffer.concat(chunks));
}

// 4. len-prefixed: [u16 LE path_len][path utf8][u32 LE body_len][body bytes]
{
  const chunks: Buffer[] = [];
  for (const f of files) {
    const pathBuf = Buffer.from(f.path, "utf8");
    const head = Buffer.alloc(6);
    head.writeUInt16LE(pathBuf.length, 0);
    head.writeUInt32LE(f.bytes.length, 2);
    chunks.push(head, pathBuf, f.bytes);
  }
  writeFileSync(join(ART, "bundle.lp"), Buffer.concat(chunks));
}

// 5. tar (ustar). 512-byte header + body padded to 512.
{
  function pad(b: Buffer, mult = 512): Buffer {
    const r = b.length % mult;
    if (r === 0) return b;
    return Buffer.concat([b, Buffer.alloc(mult - r)]);
  }
  function octal(n: number, len: number): string {
    return n.toString(8).padStart(len - 1, "0") + "\0";
  }
  function field(s: string, len: number): Buffer {
    const b = Buffer.alloc(len);
    Buffer.from(s, "ascii").copy(b);
    return b;
  }
  const chunks: Buffer[] = [];
  for (const f of files) {
    if (f.path.length > 99) throw new Error("path too long for ustar: " + f.path);
    const header = Buffer.alloc(512);
    field(f.path, 100).copy(header, 0);          // name
    field("0000644 ", 8).copy(header, 100);      // mode (with trailing space and NUL)
    field("0000000 ", 8).copy(header, 108);      // uid
    field("0000000 ", 8).copy(header, 116);      // gid
    field(octal(f.bytes.length, 12), 12).copy(header, 124); // size
    field(octal(Math.floor(Date.now() / 1000), 12), 12).copy(header, 136); // mtime
    field("        ", 8).copy(header, 148);      // chksum placeholder
    header[156] = 0x30;                          // typeflag '0' = regular
    field("ustar  ", 8).copy(header, 257);       // magic + version (GNU-ish)
    // Checksum: sum of unsigned bytes of header with chksum = spaces (already so)
    let sum = 0;
    for (let i = 0; i < 512; i++) sum += header[i];
    field(sum.toString(8).padStart(6, "0") + "\0 ", 8).copy(header, 148);
    chunks.push(header, pad(f.bytes));
  }
  // Two zero blocks to terminate
  chunks.push(Buffer.alloc(1024));
  writeFileSync(join(ART, "bundle.tar"), Buffer.concat(chunks));
}

// Report sizes
const fs = readdirSync(ART).filter((n) => n.startsWith("bundle."));
console.log("\n# raw container sizes (no codec)");
for (const n of fs.sort()) {
  const p = join(ART, n);
  const s = statSync(p).size;
  console.log(`${n.padEnd(20)} ${s.toString().padStart(8)} bytes  (${((s / raw_total) * 100).toFixed(1)}% of raw)`);
}
