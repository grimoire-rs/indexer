// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Grimoire Authors

// IX-R29: a file named by a digest is read over the wire only to be verified against it.
// The plane's site leg, the previous-closure stage and the stats seed each fetch this way;
// what a failure then means (go cold, skip, exit) stays with each of them.
import { randomBytes } from "node:crypto";
import { gunzipSync } from "node:zlib";

import { sha256Hex } from "../emit/digest.js";
import type { BlobRef } from "../emit/root.js";
import { describeStatus, request } from "../validate/adapters/http.js";

/** A cache-busting query value, so an edge still holding the previous generation or a cached 404 is not asked again. */
export const nonce = (): string => randomBytes(8).toString("hex");

/** What one fetch found. */
export type Fetched =
  | { kind: "ok"; bytes: Buffer }
  /** A 404: the file is not published (yet). */
  | { kind: "missing" }
  /** No answer, a redirect, another status, or a body past the cap: nothing about the file came back. */
  | { kind: "unreachable"; reason: string }
  /** A `gz` body that does not inflate to `ref.size`; `cause` is zlib's wording. */
  | { kind: "invalid"; fault: "inflate"; reason: string; cause: string }
  /** Bytes that are not the file `ref` names: the wrong length or the wrong digest. */
  | { kind: "invalid"; fault: "mismatch"; reason: string };

export interface FetchOptions {
  /**
   * `ref` names the inflated bytes of a `.gz` file. A body that starts with the gzip magic is
   * inflated (aborting past `ref.size`); one that does not was already decoded by a host or CDN
   * and is used as it is. Either way it is hashed afterwards, so the wire's claim is never trusted.
   */
  gz?: boolean;
  /** Append a cache-busting nonce to the URL. Default true. */
  bust?: boolean;
}

/**
 * `GET <site>/<path>`: `Accept-Encoding: gzip`, no redirects, at most `cap` bytes on the wire,
 * then verified by size and sha256 against `ref`, which the caller took from a root or an index
 * it already trusts. `path` is built from a validated digest, never from data. Never throws.
 */
export async function fetchByDigest(site: string, path: string, ref: BlobRef, cap: number, opts: FetchOptions = {}): Promise<Fetched> {
  const url = `${site}/${path}${opts.bust === false ? "" : `?${nonce()}`}`;
  // `latin1` is the lossless decode, so the exact bytes come back out of the string.
  const res = await request(url, { "Accept-Encoding": "gzip" }, { maxBytes: cap, encoding: "latin1" });
  if (res.status === 404) return { kind: "missing" };
  if (res.status < 200 || res.status >= 300) return { kind: "unreachable", reason: describeStatus(res) };

  let bytes = Buffer.from(res.body, "latin1");
  if (opts.gz === true && bytes[0] === 0x1f && bytes[1] === 0x8b) {
    try {
      bytes = gunzipSync(bytes, { maxOutputLength: ref.size });
    } catch (err) {
      return { kind: "invalid", fault: "inflate", reason: `did not inflate to ${ref.size} bytes`, cause: (err as Error).message };
    }
  }
  if (bytes.length !== ref.size) return { kind: "invalid", fault: "mismatch", reason: `${bytes.length} bytes, expected ${ref.size}` };
  if (sha256Hex(bytes) !== ref.sha256) return { kind: "invalid", fault: "mismatch", reason: "digest mismatch" };
  return { kind: "ok", bytes };
}
