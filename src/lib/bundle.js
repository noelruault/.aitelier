/* Decoder for `_bundle.br`, the publisher-optional fast-path artifact.
 *
 * Wire format (see scripts/build-bundle.ts):
 *   brotli( [u16 LE path_len][utf8 path][u32 LE body_len][bytes body] )*
 *
 * Repeating frames, no terminator. Decoder reads until the buffer is
 * exhausted. Binary-safe: callers receive raw `Uint8Array` bodies and pass
 * them through `TextDecoder` when they know the content is text.
 *
 * Browser support: `DecompressionStream("brotli")` ships in Chrome 122+,
 * Firefox 122+, Safari 17.5+ (all well before our 2026 baseline). The
 * caller is responsible for handling decode failures - typically by
 * falling back to the recursive-tree path. */

export async function fetchBundle(url, fetchOpts) {
  const res = await fetch(url, fetchOpts || {});
  if (!res.ok) {
    const err = new Error(`bundle fetch ${url}: ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return decodeBundle(res.body);
}

export async function decodeBundle(stream) {
  const decoded = stream.pipeThrough(new DecompressionStream("brotli"));
  const raw = new Uint8Array(await new Response(decoded).arrayBuffer());
  return parseFrames(raw);
}

/* Parse the raw (decompressed) frames into a Map<path, utf8 string>. We
 * decode bodies as utf8 at parse time because every entity we ship today
 * is text (markdown, JSON, scripts). If a future entity type carries raw
 * bytes, swap this for a `parseFramesBytes` that returns Uint8Array values. */
export function parseFrames(buf) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const td = new TextDecoder();
  const out = new Map();
  let i = 0;
  while (i < buf.length) {
    if (i + 2 > buf.length) throw new Error("bundle: truncated path_len");
    const pathLen = dv.getUint16(i, true); i += 2;
    if (i + pathLen > buf.length) throw new Error("bundle: truncated path");
    const path = td.decode(buf.subarray(i, i + pathLen)); i += pathLen;
    if (i + 4 > buf.length) throw new Error("bundle: truncated body_len");
    const bodyLen = dv.getUint32(i, true); i += 4;
    if (i + bodyLen > buf.length) throw new Error("bundle: truncated body");
    const body = td.decode(buf.subarray(i, i + bodyLen)); i += bodyLen;
    out.set(path, body);
  }
  return out;
}

if (typeof window !== "undefined") {
  window.__bundleDecode = { fetchBundle, decodeBundle, parseFrames };
}
