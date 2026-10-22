// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Grimoire Authors

// IX-R08, IX-R28, IX-R29; spec §6.10 "site := explicit config.site". The one
// network read `enrich` makes of its own state: the published root, which
// names every digest the build may trust.

import type { BlobRef, Root } from "../emit/root.js";
import { describeStatus, request } from "../validate/adapters/http.js";
import { asBlobRef } from "./blobstore.js";
import { nonce } from "./fetch.js";

/** The root is a few hundred bytes (§5.1). */
export const ROOT_CAP = 64 * 1024;

const LOOPBACK = /^(localhost|127(\.\d{1,3}){3}|\[::1\])$/;

/**
 * The base URL `enrich` may read state from, or `undefined` with a warning.
 *
 * `site` must be the explicit `loadConfig` value, never `resolveConfig`'s
 * default, which names somebody else's index. Plaintext is accepted only for a
 * loopback host: anywhere else a path attacker could rewrite the root, and with
 * it every digest the build then trusts.
 */
export function anchorSite(site: string | undefined): string | undefined {
  if (site === undefined) {
    console.warn("warn: no `site` in index.config.json — building cold, with no published root to anchor on");
    return undefined;
  }
  let url: URL;
  try {
    url = new URL(site);
  } catch {
    console.warn(`warn: \`site\` ${JSON.stringify(site)} is not a URL — building cold`);
    return undefined;
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && LOOPBACK.test(url.hostname))) {
    console.warn(`warn: \`site\` ${site} is neither https nor a loopback http URL — building cold`);
    return undefined;
  }
  return site.replace(/\/+$/, "");
}

/** The fields this build reads, each checked; anything else in the document is ignored. */
function parseRoot(text: string): Root | null {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    return null;
  }
  if (doc === null || typeof doc !== "object" || Array.isArray(doc)) return null;
  const r = doc as Record<string, unknown>;
  const planes = r.planes as Record<string, unknown> | null | undefined;
  if (r.schema !== 1 || typeof r.generation !== "number" || !Number.isSafeInteger(r.generation) || r.generation < 0) return null;
  if (planes === null || typeof planes !== "object" || Array.isArray(planes)) return null;

  // `undefined` is an invalid slot; `null` is a valid empty one.
  const slot = (v: unknown): BlobRef | null | undefined => (v === null ? null : (asBlobRef(v) ?? undefined));
  const enrich = slot(planes.enrich);
  const flat = slot(r.flat);
  const stats = slot(r.stats);
  if (enrich === undefined || flat === undefined || stats === undefined) return null;
  return {
    flat,
    generated_at: typeof r.generated_at === "string" ? r.generated_at : "",
    generation: r.generation,
    planes: { catalog: null, enrich },
    schema: 1,
    search: asBlobRef(r.search),
    stats,
  };
}

/**
 * {@link readRootStrict} for `enrich`: a 404 is a first deploy and silent; any
 * other failure warns. Never throws: an anchor that cannot be read means a cold
 * build, not a failed one (IX-R28).
 */
export async function readRoot(site: string): Promise<Root | null> {
  let read: RootRead;
  try {
    read = await readRootStrict(site);
  } catch (err) {
    // `request` reports a dead socket as status 0; this keeps a throw from escaping into a failed `enrich`.
    console.warn(`warn: could not read a root from ${site}/c/root.json (${err instanceof Error ? err.message : String(err)}) — building cold`);
    return null;
  }
  if (read.kind === "root") return read.root;
  if (read.kind !== "absent") console.warn(`warn: could not read a root from ${site}/c/root.json (${read.why}) — building cold`);
  return null;
}

/** What `readRootStrict` found. `why` says what was seen: an HTTP status, or the cause of no answer at all. */
export type RootRead =
  | { kind: "root"; root: Root }
  | { kind: "absent" }
  | { kind: "unreadable"; status: number; why: string }
  | { kind: "invalid"; status: number; why: string };

/**
 * `GET <site>/c/root.json?<nonce>`, every answer reported (IX-R49), for a
 * producer that must not guess. The nonce defeats an edge that still holds the
 * previous generation (V-24). A 404 is `absent`, a 2xx that is not a root is
 * `invalid`, and anything else is `unreadable`. Nothing is logged and nothing
 * is mapped to a cold build, because the caller publishes what it reads.
 */
export async function readRootStrict(site: string): Promise<RootRead> {
  const url = `${site}/c/root.json?${nonce()}`;
  const response = await request(url, { "Accept-Encoding": "gzip" }, { maxBytes: ROOT_CAP });
  if (response.status === 404) return { kind: "absent" };
  if (response.status < 200 || response.status >= 300) return { kind: "unreadable", status: response.status, why: describeStatus(response) };
  const root = parseRoot(response.body);
  return root === null ? { kind: "invalid", status: response.status, why: describeStatus(response) } : { kind: "root", root };
}

/** `readRoot` for a `site` that qualifies; no request otherwise. */
export async function anchorRoot(site: string | undefined): Promise<Root | null> {
  const base = anchorSite(site);
  return base === undefined ? null : readRoot(base);
}
