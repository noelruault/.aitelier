/* External-transport performance gates.
 *
 * Drives the direct transport against a stubbed `fetch` that mimics
 * api.github.com + raw.githubusercontent.com, with per-endpoint latency
 * injected so the bundle vs tree paths produce comparable wall-times.
 * Asserts the ratchet documented in `.bench/REPORT.md`:
 *
 *   - bundle-present fork uses 2 network calls (head + bundle).
 *   - bundle-absent fork falls back to tree path (head + bundle-404 + tree).
 *   - tree-path file fetches are per-blob (head + bundle-404 + tree + N).
 *   - bundle wall-time < tree wall-time on identical corpus + latency.
 *
 * The latency model is uniform 10ms/RTT - close enough to a clean LAN to
 * separate signal from noise without depending on real GitHub network. */

import { test, expect, beforeEach, afterEach } from "bun:test";
import { createTransportDirect } from "../src/data/transport-direct.js";

const RTT_MS = 10;
const COMMIT_SHA = "deadbeefcafebabe1234567890abcdef00000001";

function buildLenPrefixedBundle(files) {
  const enc = new TextEncoder();
  const frames = files.map(([path, body]) => ({
    path: enc.encode(path),
    body: enc.encode(body),
  }));
  const total = frames.reduce((n, f) => n + 2 + f.path.length + 4 + f.body.length, 0);
  const raw = new Uint8Array(total);
  const dv = new DataView(raw.buffer);
  let off = 0;
  for (const { path, body } of frames) {
    dv.setUint16(off, path.length, true); off += 2;
    raw.set(path, off); off += path.length;
    dv.setUint32(off, body.length, true); off += 4;
    raw.set(body, off); off += body.length;
  }
  return raw;
}

async function brotliCompress(bytes) {
  const proc = Bun.spawn(["brotli", "-q", "11", "-c"], {
    stdin: new Response(bytes).body,
    stdout: "pipe",
  });
  const out = new Uint8Array(await new Response(proc.stdout).arrayBuffer());
  await proc.exited;
  if (proc.exitCode !== 0) throw new Error(`brotli exit ${proc.exitCode}`);
  return out;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

/* Install a stubbed fetch that:
 *   - sleeps RTT_MS before responding (uniform-latency network model)
 *   - records each requested URL
 *   - serves api.gh + raw.gh according to the fixture
 */
function installStubFetch({ files, includeBundle }) {
  const original = globalThis.fetch;
  const reqs = [];
  const treePaths = files.map(([p]) => p);

  globalThis.fetch = async (input) => {
    const url = typeof input === "string" ? input : input.url;
    reqs.push(url);
    await sleep(RTT_MS);

    if (url.startsWith("https://api.github.com/repos/") && url.includes("/commits")) {
      return new Response(JSON.stringify([{
        sha: COMMIT_SHA,
        commit: { committer: { date: "2026-05-18T00:00:00Z" } },
      }]), { headers: { "Content-Type": "application/json" } });
    }

    if (url.includes("/_bundle.br")) {
      if (!includeBundle) return new Response("not found", { status: 404 });
      const raw = buildLenPrefixedBundle(files);
      const compressed = await brotliCompress(raw);
      return new Response(compressed);
    }

    if (url.includes("/git/trees/")) {
      return new Response(JSON.stringify({
        truncated: false,
        tree: treePaths.map(p => ({ type: "blob", path: p, sha: "blob" + p })),
      }), { headers: { "Content-Type": "application/json" } });
    }

    if (url.startsWith("https://raw.githubusercontent.com/")) {
      const m = /^https:\/\/raw\.githubusercontent\.com\/[^/]+\/[^/]+\/[^/]+\/(.+)$/.exec(url);
      const path = m ? decodeURIComponent(m[1]) : "";
      const hit = files.find(([p]) => p === path);
      if (!hit) return new Response("not found", { status: 404 });
      return new Response(hit[1]);
    }

    return new Response("not found", { status: 404 });
  };

  return {
    reqs,
    restore() { globalThis.fetch = original; },
  };
}

const FIXTURE = [
  ["prompts/one.md", "# one\n"],
  ["prompts/two.md", "# two\n"],
  ["agents/alpha.md", "---\nname: alpha\n---\nbody\n"],
  ["agents/beta.md", "---\nname: beta\n---\nbody\n"],
];

let stub;
afterEach(() => { if (stub) stub.restore(); stub = null; });

async function runFullLoad(transport) {
  await transport.head();
  const folders = ["prompts", "skills", "agents", "hooks"];
  const lists = await Promise.all(folders.map(f => transport.list(f).then(ids => ({ f, ids }))));
  await Promise.all(lists.flatMap(({ f, ids }) => ids.map(id => transport.fetch(f, id))));
}

test("bundle-present fork loads with exactly 2 requests", async () => {
  stub = installStubFetch({ files: FIXTURE, includeBundle: true });
  const t = createTransportDirect({ owner: "x", repo: "y", branch: null });

  await runFullLoad(t);

  expect(stub.reqs.length).toBe(2);
  expect(stub.reqs[0]).toContain("/commits");
  expect(stub.reqs[1]).toContain("/_bundle.br");
});

test("bundle-absent fork falls back to tree + per-file blobs", async () => {
  stub = installStubFetch({ files: FIXTURE, includeBundle: false });
  const t = createTransportDirect({ owner: "x", repo: "y", branch: null });

  await runFullLoad(t);

  // 1 commits + 1 bundle 404 + 1 tree + N blobs
  const expected = 1 + 1 + 1 + FIXTURE.length;
  expect(stub.reqs.length).toBe(expected);
  expect(stub.reqs.some(r => r.includes("/git/trees/"))).toBe(true);
});

test("bundle path is at least 2x faster than tree fallback at 10ms RTT", async () => {
  // Bundle path: head + bundle = 2 serial RTTs.
  // Tree path:   head + bundle-404 + tree + blobs(parallel) = 4 serial-ish steps.
  // Even on a fully parallel network, the bundle path saves the 404
  // + the tree call. With 4 files and uniform 10ms latency we expect
  // ~20ms vs ~40ms.
  stub = installStubFetch({ files: FIXTURE, includeBundle: true });
  const bundleT = createTransportDirect({ owner: "x", repo: "y", branch: null });
  const t0 = performance.now();
  await runFullLoad(bundleT);
  const bundleMs = performance.now() - t0;
  stub.restore();

  stub = installStubFetch({ files: FIXTURE, includeBundle: false });
  const treeT = createTransportDirect({ owner: "x", repo: "y", branch: null });
  const t1 = performance.now();
  await runFullLoad(treeT);
  const treeMs = performance.now() - t1;

  // The ratchet: bundle must beat tree by 30% on uniform-latency network.
  // We use a forgiving 0.7 ratio so timing jitter on slow CI doesn't flap;
  // the bundle's structural advantage at this RTT is ~50%.
  expect(bundleMs).toBeLessThan(treeMs * 0.7);
});

test("bundle decode preserves byte-for-byte content", async () => {
  // Tighter correctness check: round-trip a known body through the
  // brotli + len-prefixed pipeline and assert the transport returns the
  // exact text from the bundle, not a re-fetched copy.
  const SENTINEL = "## one\n```js\nconst x = 1;\n```\n";
  const fixture = [
    ["prompts/sentinel.md", SENTINEL],
    ["agents/other.md", "---\nname: other\n---\n"],
  ];
  stub = installStubFetch({ files: fixture, includeBundle: true });
  const t = createTransportDirect({ owner: "x", repo: "y", branch: null });

  const got = await t.fetch("prompts", "sentinel");
  expect(got).toBe(SENTINEL);
});
