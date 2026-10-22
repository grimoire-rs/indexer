// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Grimoire Authors

// Browser-side fetch of the content-addressed blobs under `/c/`. Stubbed: the
// signatures are the contract, the bodies come with the island that uses them.

/** Every rung of `loadDigest` failed; the caller falls back to what the page rendered. */
export class DigestLadderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DigestLadderError";
  }
}

/**
 * Fetches `url` and parses it as JSON. A non-ok status throws. The body is
 * read chunk by chunk and aborted when no chunk arrives for `stallMs`, so a
 * stall fails the load and a slow steady body finishes. Bytes starting `1f 8b`
 * are inflated with `DecompressionStream`, anything else is taken as the host
 * already decoded it. Inflated bytes past `cap` abort.
 */
export async function fetchJson(
  _url: string,
  _opts: { cap: number; stallMs?: number; cache: RequestCache; signal?: AbortSignal },
): Promise<unknown> {
  throw new Error("not implemented");
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
  _kind: "q" | "f",
  _digest: string,
  _opts: { cap: number; decode: (v: unknown) => T; attr: "search" | "stats" },
): Promise<T> {
  throw new Error("not implemented");
}
