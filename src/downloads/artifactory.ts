// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Grimoire Authors

// Download counts out of Artifactory, via AQL.
//
// Everything here was measured against a live instance rather than read from
// docs, and three of the measurements drive the whole shape of the file:
//
//  1. **An OCI repository in Artifactory stores a folder per TAG and a folder
//     per DIGEST**, each holding its own `manifest.json`. A client resolves
//     tag -> digest and then GETs by digest, so on one instance every tag
//     folder read 0 while the digest folders carried the real counts. Neither
//     placement may be assumed.
//  2. **The two are the same bytes, so they share a `sha256`.** Grouping rows
//     on `sha256` and summing the group is therefore correct wherever the hit
//     was recorded — and a floating tag (`latest`, `1`, `1.35`) aliases into
//     the same group rather than forming a second counter, so deduplication
//     falls out of the grouping instead of needing a rule.
//  3. **`stat.downloads` is not admin-gated**, but a missing read permission
//     is *silent*: AQL answers `HTTP 200` with `total: 0` and no error, which
//     is indistinguishable from "nothing has been pulled yet". So every repo
//     key is checked against `GET /api/repositories` before any count is
//     believed — a token without read simply does not see the repo.
//
// Layer blobs are never counted: they read 0 across every version of one
// package and 6 on another, so they measure nothing. `manifest.json` only.
import { CliError, EXIT } from "../cli/exit.js";
import { LARGE_RESPONSE_BYTES, request } from "../validate/adapters/http.js";
import { parseRef } from "../validate/core/metadata.js";

/** One ref's `downloads` stat, in the shape `stats.json` publishes. */
export interface DownloadStat {
  /** Every pull this producer could attribute to the package. */
  total: number;
  /**
   * Per-release counts, keyed by the **semver tag** rather than by digest —
   * which is what makes the detail page's lookup a direct hit against the
   * `tags` array it already has. Absent when no release carried one.
   */
  versions?: Record<string, number>;
  /** When this run read the counters. RFC 3339 UTC, seconds resolution. */
  as_of: string;
}

/**
 * The discovery artifact every `grim` client pulls to find the index at all.
 * It is not a version of anything, and it is not small: on one real repository
 * it carried 1047 pulls against a genuine total of 1416, so counting it would
 * have inflated the published figure by 74%. The single highest-impact
 * exclusion in this file.
 */
const INDEX_TAG = "__grimoire";

/** A complete release tag, prerelease and build metadata included. */
const SEMVER = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)*$/;

/** A digest folder rather than a tag. */
const DIGEST_FOLDER = /^sha256:[0-9a-f]{64}$/;

/** One AQL row, already narrowed out of the wire document. */
interface Row {
  path: string;
  sha256: string;
  downloads: number;
}

/** `1.35.2` as `[1, 35, 2]`. Only ever called on a tag that matched {@link SEMVER}. */
function release(tag: string): number[] {
  return tag.split(/[-+]/)[0]!.split(".").map(Number);
}

/** Greater first, comparing release numbers numerically. */
function semverDescending(a: string, b: string): number {
  const pa = release(a);
  const pb = release(b);
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pb[i]! - pa[i]!;
  }
  // A release and its own prerelease share all three numbers. Code-unit order
  // is enough to make the pick deterministic, which is all that is asked of it.
  return a < b ? 1 : a > b ? -1 : 0;
}

/**
 * One AQL query, bounded and narrowed.
 *
 * `requestJson` cannot be used: it sends no body, so it cannot POST, and its
 * 1 MiB cap is below what a repository of a few hundred artifacts returns.
 * A non-2xx does not throw from `request`, and `status: 0` is its single
 * sentinel for a transport failure, a timeout and an over-cap read alike —
 * none of which says anything about what is published, so all of them fail
 * the run rather than publishing an absence.
 */
async function aql(baseUrl: string, token: string, repo: string): Promise<Row[]> {
  // `repo` reached here through `parseRef`, whose repository grammar admits
  // no quote and no backslash; `JSON.stringify` is the belt to that braces.
  //
  // `repo`, `path` and `name` are in `.include()` because a non-admin query
  // without all three is rejected outright: "For permissions reasons AQL items
  // domain demands the following fields: repo, path and name."
  const query =
    `items.find({"repo":${JSON.stringify(repo)},"name":{"$match":"*manifest.json"}})` +
    `.include("repo","path","name","sha256","stat.downloads")`;

  const response = await request(
    `${baseUrl}/api/search/aql`,
    { Authorization: `Bearer ${token}`, "Content-Type": "text/plain" },
    { method: "POST", body: query, maxBytes: LARGE_RESPONSE_BYTES },
  );
  if (response.status < 200 || response.status >= 300) {
    throw new CliError(
      `downloads: AQL against ${repo} failed (HTTP ${response.status}) — ` +
        `refusing to publish a sidecar that would empty every download count`,
      EXIT.unavailable,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(response.body) as unknown;
  } catch (err) {
    throw new CliError(
      `downloads: the AQL reply for ${repo} did not parse (${(err as Error).message})`,
      EXIT.unavailable,
    );
  }
  const results = (parsed as { results?: unknown } | null)?.results;
  if (!Array.isArray(results)) {
    throw new CliError(`downloads: the AQL reply for ${repo} carries no \`results\` array`, EXIT.unavailable);
  }

  const rows: Row[] = [];
  for (const entry of results) {
    if (entry === null || typeof entry !== "object") continue;
    const row = entry as Record<string, unknown>;
    // `stats` comes back as an ARRAY, and `stat.downloaded` is absent
    // altogether when the count is 0 — measured, not assumed.
    const stats = row.stats;
    const first = Array.isArray(stats) && stats.length > 0 ? (stats[0] as Record<string, unknown>) : undefined;
    const downloads = typeof first?.downloads === "number" ? first.downloads : 0;
    if (typeof row.path !== "string" || typeof row.sha256 !== "string") continue;
    rows.push({ path: row.path, sha256: row.sha256, downloads });
  }
  return rows;
}

/**
 * Every repository key the token can actually read.
 *
 * This is the disambiguator for measurement 3 above, and it runs once per run
 * rather than once per artifact: AQL cannot tell "no pulls yet" from "no read
 * permission", and this call can — a repo the token cannot read is simply
 * absent from the list.
 */
async function readableRepos(baseUrl: string, token: string): Promise<Set<string>> {
  const response = await request(`${baseUrl}/api/repositories`, {
    Authorization: `Bearer ${token}`,
  });
  if (response.status < 200 || response.status >= 300) {
    throw new CliError(
      `downloads: could not list repositories at ${baseUrl} (HTTP ${response.status})`,
      EXIT.unavailable,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(response.body) as unknown;
  } catch (err) {
    throw new CliError(
      `downloads: the repository list at ${baseUrl} did not parse (${(err as Error).message})`,
      EXIT.unavailable,
    );
  }
  if (!Array.isArray(parsed)) {
    throw new CliError(`downloads: the repository list at ${baseUrl} is not an array`, EXIT.unavailable);
  }
  const keys = new Set<string>();
  for (const entry of parsed) {
    const key = (entry as { key?: unknown } | null)?.key;
    if (typeof key === "string") keys.add(key);
  }
  return keys;
}

/**
 * Fold one artifact's rows into its published stat.
 *
 * The five steps are the measured algorithm, in order:
 *
 *  1. group on `sha256` and sum — see measurement 2;
 *  2. a `sha256:<digest>` folder is not a tag, so it never names a release;
 *  3. drop {@link INDEX_TAG}, and then drop any group left with no tag at all
 *     (~30 of them on one real repository, one pull each: description
 *     companions and orphaned pushes, none of them a release);
 *  4. a group carrying a complete semver tag is that release, labelled by the
 *     most specific tag in it — `1.35.2`, never the `1.35`/`latest` aliases
 *     that share the group and are therefore already summed in;
 *  5. `total` is every kept group, channel tags (`canary`) included. Real
 *     traffic with no release to attribute it to belongs in the total, not
 *     nowhere.
 */
function fold(rows: readonly Row[], asOf: string): DownloadStat {
  const groups = new Map<string, { tags: Set<string>; downloads: number }>();
  for (const row of rows) {
    let group = groups.get(row.sha256);
    if (!group) {
      group = { tags: new Set(), downloads: 0 };
      groups.set(row.sha256, group);
    }
    group.downloads += row.downloads;
    const tag = row.path.slice(row.path.lastIndexOf("/") + 1);
    if (!DIGEST_FOLDER.test(tag) && tag !== INDEX_TAG) group.tags.add(tag);
  }

  let total = 0;
  // A Map, never a plain object: the keys come off the wire. Only tags matching
  // `SEMVER` ever reach the published object, so `__proto__` cannot be one.
  const versions = new Map<string, number>();
  for (const group of groups.values()) {
    if (group.tags.size === 0) continue;
    total += group.downloads;
    const release = [...group.tags].filter((t) => SEMVER.test(t)).sort(semverDescending)[0];
    if (release !== undefined) versions.set(release, group.downloads);
  }

  const stat: DownloadStat = { total, as_of: asOf };
  if (versions.size > 0) {
    // Sorted so a re-run over unchanged counters produces unchanged bytes.
    stat.versions = Object.fromEntries([...versions].sort(([a], [b]) => semverDescending(a, b)));
  }
  return stat;
}

export interface CollectOptions {
  baseUrl: string;
  token: string;
  /** Every ref in `index/`, already `parseRef`-valid. */
  refs: readonly string[];
  /** The run's clock. Injected so a test can pin `as_of`. */
  now?: Date;
}

/**
 * Read download counts for every ref this Artifactory instance holds.
 *
 * A ref on a different host is skipped rather than failed: an index may list
 * artifacts from several registries, and only one of them is the instance
 * being counted. A ref whose repository key the token cannot read **fails the
 * run** — that is measurement 3, and the alternative is publishing a zero that
 * looks like a fact.
 *
 * An artifact the instance returns no rows for is absent from the result, not
 * zero: absent means unknown, and `mergeStats` drops the key rather than
 * publishing a count nobody measured.
 */
export async function collectDownloads(opts: CollectOptions): Promise<Record<string, DownloadStat>> {
  const host = new URL(opts.baseUrl).host.toLowerCase();

  // repo key -> (image path -> ref). Both derived from the ref alone: the
  // first segment of the OCI repository is the Artifactory repository key and
  // the rest is the image path, which is all `parseRef` has to give and all
  // this needs. `kind` is deliberately not read — it is a sibling field on the
  // metadata, not something a ref encodes, and real indexes disagree about
  // whether a plural path segment is even present.
  const wanted = new Map<string, Map<string, string>>();
  for (const ref of opts.refs) {
    const parsed = parseRef(ref);
    if (!parsed.ok) continue;
    if (parsed.value.host.toLowerCase() !== host) continue;
    const slash = parsed.value.repository.indexOf("/");
    if (slash <= 0) continue;
    const repo = parsed.value.repository.slice(0, slash);
    const image = parsed.value.repository.slice(slash + 1);
    let byImage = wanted.get(repo);
    if (!byImage) {
      byImage = new Map();
      wanted.set(repo, byImage);
    }
    byImage.set(image, ref);
  }
  if (wanted.size === 0) return {};

  const readable = await readableRepos(opts.baseUrl, opts.token);
  for (const repo of wanted.keys()) {
    if (!readable.has(repo)) {
      throw new CliError(
        `downloads: the credential cannot read ${repo} on ${opts.baseUrl} — ` +
          // No `from "…"` in this string: pack-smoke scans the built JS for
          // import specifiers, and that spelling reads as one.
          `grant it read on that repository. AQL would answer HTTP 200 with no rows, ` +
          `which reads exactly like "nothing has been pulled yet"`,
        EXIT.unavailable,
      );
    }
  }

  const asOf = (opts.now ?? new Date()).toISOString().replace(/\.\d+Z$/, "Z");
  const fresh: Record<string, DownloadStat> = {};
  for (const [repo, byImage] of wanted) {
    // One query per repository key rather than per artifact: every row carries
    // its own path, so one pass buckets them all and an index with 200
    // artifacts in one repository costs one request instead of 200.
    const bucketed = new Map<string, Row[]>();
    for (const row of await aql(opts.baseUrl, opts.token, repo)) {
      // `<image path>/<tag or digest>/manifest.json`, so the tag is the last
      // segment of `path` and the image path is everything before it. A row
      // with no separator sits at the repository root and belongs to no
      // artifact this index lists.
      const cut = row.path.lastIndexOf("/");
      if (cut <= 0) continue;
      const ref = byImage.get(row.path.slice(0, cut));
      if (ref === undefined) continue;
      const rows = bucketed.get(ref);
      if (rows) rows.push(row);
      else bucketed.set(ref, [row]);
    }
    for (const [ref, rows] of bucketed) fresh[ref] = fold(rows, asOf);
  }
  return fresh;
}
