// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Grimoire Authors

// `grim-indexer probe <site-url>`: after a deploy, ask the live site for the files whose
// `Content-Type` a static host picks by extension, and warn on a wrong one. Warn-only:
// each problem is one `warn:` line on stderr and the exit stays 0, so the CI job that
// runs it can never fail a deploy that already happened. Only a bad invocation exits 64.
import { gunzipSync } from "node:zlib";

import { logoExtType, PACKAGE_LOGOS } from "../logo.js";
import { decodeSearchFile, SEARCH_CAP, type SearchRow } from "../renderer/astro/lib/searchfile.js";
import { ROOT_CAP } from "../state/anchor.js";
import { describeStatus, failureReason, USER_AGENT } from "../validate/adapters/http.js";
import { CliError, EXIT, type ExitCode } from "./exit.js";

const TIMEOUT_MS = 15 * 1000;
const MAX_HOPS = 5;
const MAX_SHOWN = 200;
const SHA256 = /^[0-9a-f]{64}$/;

const GZIP = ["application/gzip", "application/x-gzip"];
const IMAGE = { png: "image/png", jpeg: "image/jpeg", webp: "image/webp", gif: "image/gif" } as const;

interface Typed {
  type: string;
  encoding: string;
}

type Got = ({ ok: true; body: Buffer } & Typed) | { ok: false; why: string };

/** The site as a base URL with a trailing slash, so a sub-path site resolves under it. */
function siteBase(raw: string): URL {
  const usage = (why: string) => new CliError(`probe: ${why}`, EXIT.usage);
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw usage(`not a URL: ${raw}`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw usage(`not an http(s) URL: ${raw}`);
  // Every warning prints the URL, and a credential in it would land in the CI log.
  if (url.username !== "" || url.password !== "") throw usage("the URL must not carry credentials");
  url.search = "";
  url.hash = "";
  if (!url.pathname.endsWith("/")) url.pathname += "/";
  return url;
}

/** Host-served text as printable ASCII, capped: a newline or ESC in a warning could forge a CI log command. */
const shown = (s: string): string => s.replace(/[^\x20-\x7e]/g, "?").slice(0, MAX_SHOWN);

/** The body, or `null` once it passes `cap` bytes. */
async function readCapped(res: Response, cap: number): Promise<Buffer | null> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of res.body ?? []) {
    size += chunk.byteLength;
    if (size > cap) return null;
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/**
 * GET `url`, following redirects that stay on its origin. `cap` 0 reads the headers
 * and drops the body, which is all a type check needs from a logo, a blob or a page.
 */
async function get(url: URL, cap: number): Promise<Got> {
  const signal = AbortSignal.timeout(TIMEOUT_MS);
  try {
    let at = url;
    for (let hop = 0; hop <= MAX_HOPS; hop++) {
      const res = await fetch(at, { redirect: "manual", headers: { "User-Agent": USER_AGENT }, signal });
      const location = res.headers.get("location");
      if (res.status >= 300 && res.status < 400 && location !== null) {
        await res.body?.cancel();
        const next = new URL(location, at);
        // A `Location` is the host's to choose; following it off-origin probes something else.
        if (next.origin !== url.origin) return { ok: false, why: `a redirect to ${next.origin}, off the site origin` };
        at = next;
        continue;
      }
      if (res.status < 200 || res.status >= 300) {
        await res.body?.cancel();
        return { ok: false, why: describeStatus(res) };
      }
      const type = (res.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
      const encoding = (res.headers.get("content-encoding") ?? "").trim().toLowerCase();
      if (cap === 0) {
        await res.body?.cancel();
        return { ok: true, type, encoding, body: Buffer.alloc(0) };
      }
      const body = await readCapped(res, cap);
      return body === null ? { ok: false, why: `a body over the ${cap} byte cap` } : { ok: true, type, encoding, body };
    }
    return { ok: false, why: `more than ${MAX_HOPS} redirects` };
  } catch (err) {
    return { ok: false, why: describeStatus({ status: 0, reason: failureReason(err, TIMEOUT_MS) }) };
  }
}

/** A `.json.gz` file: a gzip type, or JSON the host marked `Content-Encoding: gzip`. */
const isGzip = (got: Typed): boolean => GZIP.includes(got.type) || (got.type === "application/json" && got.encoding === "gzip");

const describe = (got: Typed): string =>
  `${got.type === "" ? "no Content-Type" : got.type}${got.encoding === "" ? "" : ` with Content-Encoding: ${got.encoding}`}`;

/** The digest of a `{sha256, size}` ref, or null when it is absent or not 64 lowercase hex. */
function digestOf(ref: unknown): string | null {
  const sha = typeof ref === "object" && ref !== null ? (ref as { sha256?: unknown }).sha256 : undefined;
  return typeof sha === "string" && SHA256.test(sha) ? sha : null;
}

export async function probe(siteUrl: string): Promise<ExitCode> {
  const base = siteBase(siteUrl);
  let warnings = 0;
  let requests = 0;
  const warn = (url: URL, expected: string, actual: string): void => {
    warnings++;
    console.error(`warn: ${shown(url.href)}: expected ${expected}, got ${shown(actual)}`);
  };
  /** A URL the host chose can name another origin; the runner would fetch it from inside the network. */
  const inside = (url: URL): boolean => url.origin === base.origin && url.pathname.startsWith(base.pathname);
  /** One request. Warns when it fails or answers the wrong type; returns the body unless it failed. */
  const check = async (url: URL, expected: string, ok: (got: Typed) => boolean, cap = 0): Promise<Buffer | null> => {
    if (!inside(url)) {
      warn(url, expected, "a URL outside the site, not requested");
      return null;
    }
    requests++;
    const got = await get(url, cap);
    if (!got.ok) {
      warn(url, expected, got.why);
      return null;
    }
    if (!ok(got)) warn(url, expected, describe(got));
    return got.body;
  };
  const at = (rel: string): URL => new URL(rel, base);

  const checks = async (): Promise<void> => {
    const rootUrl = at("c/root.json");
    const rootBytes = await check(rootUrl, "application/json", (g) => g.type === "application/json", ROOT_CAP);
    if (rootBytes === null) return;
    let root: unknown;
    try {
      root = JSON.parse(rootBytes.toString("utf8"));
    } catch {
      root = null;
    }
    if (typeof root !== "object" || root === null || Array.isArray(root)) {
      warn(rootUrl, "a JSON object", "a body that is not one");
      return;
    }
    const members = root as Record<string, unknown>;

    // Neither `stats` nor `flat` is a legitimate root (a flat-layout site with no stats): nothing to ask for.
    const blob = digestOf(members.stats) ?? digestOf(members.flat);
    if (blob !== null) await check(at(`c/f/sha256/${blob}.json.gz`), GZIP.join(" or "), isGzip);

    const search = digestOf(members.search);
    if (search === null) {
      warn(rootUrl, 'a "search" member naming the search file', "none");
      return;
    }
    const searchUrl = at(`c/q/sha256/${search}.json.gz`);
    const searchBytes = await check(searchUrl, GZIP.join(" or "), isGzip, SEARCH_CAP);
    if (searchBytes === null) return;
    let rows: SearchRow[];
    try {
      // A host that sent `Content-Encoding: gzip` was already undone by `fetch`.
      const gz = searchBytes[0] === 0x1f && searchBytes[1] === 0x8b;
      const inflated = gz ? gunzipSync(searchBytes, { maxOutputLength: SEARCH_CAP }) : searchBytes;
      rows = decodeSearchFile(JSON.parse(inflated.toString("utf8")));
    } catch (err) {
      warn(searchUrl, "a search file", err instanceof Error ? err.message : String(err));
      return;
    }

    // One of each proves the host's extension table. A catalog with no logo has none to ask for.
    const logo = rows.find((row) => typeof row.logo === "string" && row.logo !== "")?.logo;
    if (typeof logo === "string") {
      const url = at(logo.replace(/^\/+/, ""));
      const kind = logoExtType(url.pathname.slice(url.pathname.lastIndexOf(".") + 1), PACKAGE_LOGOS);
      const allowed: string[] = kind === null ? Object.values(IMAGE) : [IMAGE[kind]];
      await check(url, allowed.join(" or "), (g) => allowed.includes(g.type));
    }

    for (const { namespace, name } of rows) {
      if (typeof namespace !== "string" || typeof name !== "string") continue;
      // A namespace is a path (`github.com/acme`), and the site serves it as nested directories.
      const dir = namespace.split("/").map(encodeURIComponent).join("/");
      await check(at(`p/${dir}/${encodeURIComponent(name)}/`), "text/html", (g) => g.type === "text/html");
      break;
    }
  };

  try {
    await checks();
  } catch (err) {
    // A value the host served can still break URL parsing; the probe never fails the run for it.
    warn(base, "the checks to finish", err instanceof Error ? err.message : String(err));
  }
  console.log(`probe: ${base.href}: ${requests} request(s), ${warnings} warning(s)`);
  return EXIT.ok;
}
