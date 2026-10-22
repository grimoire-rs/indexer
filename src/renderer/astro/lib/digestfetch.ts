// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Grimoire Authors

// Browser-side fetch of the content-addressed blobs under `/c/`. Imports
// nothing from `node:`: it ships in the island's bundle.
import { withBase } from "./base.js";

/** Longest silence tolerated between two body chunks. */
const STALL_MS = 15 * 1000;

/** The home page is read for one attribute; a page past this is not the page. */
const HOME_CAP = 1024 * 1024;

const DIGEST = /^[0-9a-f]{64}$/;

/** Every rung of `loadDigest` failed; the caller falls back to what the page rendered. */
export class DigestLadderError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "DigestLadderError";
  }
}

/** Reads `reader` to the end, throwing once more than `cap` bytes arrived. */
async function readAll(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  cap: number,
  onChunk: () => void,
  what: string,
): Promise<Uint8Array<ArrayBuffer>> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    onChunk();
    size += value.length;
    if (size > cap) {
      await reader.cancel();
      throw new Error(`${what}: over the ${cap} byte cap`);
    }
    chunks.push(value);
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
}

/**
 * Fetches `url` and parses it as JSON. A non-ok status throws. The body is
 * read chunk by chunk and aborted when no chunk arrives for `stallMs`, so a
 * stall fails the load and a slow steady body finishes. Bytes starting `1f 8b`
 * are inflated with `DecompressionStream`, anything else is taken as the host
 * already decoded it. Inflated bytes past `cap` abort.
 */
export async function fetchJson(
  url: string,
  { cap, stallMs = STALL_MS, cache, signal }: {
    cap: number;
    stallMs?: number;
    cache: RequestCache;
    signal?: AbortSignal;
  },
): Promise<unknown> {
  const stall = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  // Re-armed per chunk, so the deadline is for silence, not for the whole body.
  const arm = (): void => {
    clearTimeout(timer);
    timer = setTimeout(() => stall.abort(new Error(`${url}: no data for ${stallMs} ms`)), stallMs);
  };
  arm();
  try {
    const response = await fetch(url, {
      cache,
      signal: signal ? AbortSignal.any([stall.signal, signal]) : stall.signal,
    });
    if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
    const reader = response.body?.getReader();
    if (!reader) throw new Error(`${url}: no response body`);
    // A gzip body is also held to `cap` on the wire: it is never larger than
    // what it inflates to, bar a few bytes of framing.
    let bytes = await readAll(reader, cap, arm, url);
    clearTimeout(timer);
    if (bytes[0] === 0x1f && bytes[1] === 0x8b) {
      const inflated = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
      bytes = await readAll(inflated.getReader(), cap, () => undefined, url);
    }
    const value: unknown = JSON.parse(new TextDecoder().decode(bytes));
    return value;
  } catch (err) {
    stall.abort();
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/** The digest the home page currently names for `attr`, or throws. */
async function currentDigest(attr: string): Promise<string> {
  const response = await fetch(withBase("/"), {
    cache: "reload",
    signal: AbortSignal.timeout(STALL_MS),
  });
  if (!response.ok) throw new Error(`home page: HTTP ${response.status}`);
  const reader = response.body?.getReader();
  if (!reader) throw new Error("home page: no response body");
  const page = new TextDecoder().decode(await readAll(reader, HOME_CAP, () => undefined, "home page"));
  const match = new RegExp(`data-grim-${attr}="([0-9a-f]{64})"`).exec(page);
  if (!match?.[1]) throw new Error(`home page names no ${attr} digest`);
  return match[1];
}

/**
 * Loads `/c/<kind>/sha256/<digest>.json.gz` and runs it through `decode`.
 * Rung 1 is `force-cache`; any failure retries with `cache: "reload"`; a
 * second failure reads the current digest from the `data-grim-<attr>`
 * attribute of a freshly fetched `index.html` and fetches that. Every URL goes
 * through `withBase`, and `/all.json` is never requested. All rungs failing
 * throws `DigestLadderError`.
 */
export async function loadDigest<T>(
  kind: "q" | "f",
  digest: string,
  { cap, decode, attr }: { cap: number; decode: (v: unknown) => T; attr: "search" | "stats" },
): Promise<T> {
  // Checked before it is spliced into a URL.
  if (!DIGEST.test(digest)) throw new DigestLadderError(`${kind}: not a sha256 hex digest`);

  const attempt = async (d: string, cache: RequestCache): Promise<T> =>
    decode(await fetchJson(withBase(`/c/${kind}/sha256/${d}.json.gz`), { cap, cache }));

  let cause: unknown;
  const rungs: Array<() => Promise<T>> = [
    () => attempt(digest, "force-cache"),
    () => attempt(digest, "reload"),
    async () => {
      const fresh = await currentDigest(attr);
      // Rung 2 already fetched this digest with a reload; a third try is the same request.
      if (fresh === digest) throw cause;
      return attempt(fresh, "force-cache");
    },
  ];
  for (const rung of rungs) {
    try {
      return await rung();
    } catch (err) {
      cause = err;
    }
  }
  throw new DigestLadderError(`${kind}/${digest}: every rung failed`, { cause });
}
