// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Grimoire Authors

/**
 * Refresh `enrich/<namespace>/<name>/` sidecars from the live registry.
 *
 * The index itself stores only pointers — `metadata.json` carries the ref and
 * who owns it, nothing a reader wants to look at. Title, summary, version,
 * license, keywords, the tag list, the README, the CHANGELOG and the logo all
 * live in the registry. This is the one part of the toolchain that goes and
 * gets them, so the site build stays a pure function of the checkout.
 *
 * Probe first, describe rarely. A package whose artifact digest (`fetch
 * --digest-only`) still equals the stored `contentDigest`, and whose
 * description-companion digest has not moved either, is carried forward
 * verbatim — no `describe`, no download. Only a rotating slice (the ⌈N/7⌉
 * packages described longest ago) is re-described regardless, so an edit the
 * digests cannot see — a support link changed without republishing, a tag
 * added — still lands within about a week. Everything else takes the full
 * path: `describe`, then the companion probe and download.
 *
 * Packages run through a bounded pool. A per-package failure keeps the
 * existing sidecar — stale beats empty — and only a majority failure is
 * reported as an outage.
 */
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

import { findMetadataFiles, namespaceOf } from "../data/index.js";

const execFileAsync = promisify(execFile);

/** Per-`grim`-call ceiling. A description companion is text plus one logo. */
const TIMEOUT_MS = 60_000;
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;

/**
 * A logo filename comes from the registry, which is not ours. Only an
 * alphanumeric extension is ever joined onto a path — `logo.a/b` or
 * `logo.` + traversal must not reach `writeFileSync`.
 */
export const LOGO_EXT = /^[A-Za-z0-9]{1,8}$/;

/** Runs one `grim` subcommand and parses its JSON. Injected so tests need no binary. */
export type GrimRunner = (args: string[]) => Promise<unknown>;

export interface EnrichOptions {
  /** Index repo root — holds `index/`, gains `enrich/`. */
  root: string;
  /** Defaults to spawning `grim` from `PATH`. */
  run?: GrimRunner;
  /** Packages refreshed at once; each runs its `grim` calls in sequence. */
  concurrency?: number;
}

export const DEFAULT_CONCURRENCY = 8;

/** The slice re-described every run: a seventh of the index, so ~a week per full cycle. */
const SLICE_DIVISOR = 7;

export interface EnrichResult {
  total: number;
  enriched: number;
  /** One `"<ref>: <reason>"` per package whose refresh failed. */
  failures: string[];
}

/** One member of a description companion, as `grim fetch --description` reports it. */
interface CompanionFile {
  path: string;
  content: string;
  encoding?: string;
}

export function spawnGrim(bin = "grim"): GrimRunner {
  return async (args) => {
    const { stdout } = await execFileAsync(bin, [...args, "--format", "json"], {
      timeout: TIMEOUT_MS,
      maxBuffer: MAX_OUTPUT_BYTES,
      encoding: "utf8",
    });
    return JSON.parse(stdout);
  };
}

/**
 * The curated fields copied straight across from `describe`, in the order
 * they are written to disk. Every one is optional on the wire: a grim older
 * than the annotation work reports the first five and nothing after them,
 * and `compatibility` is null for every kind but a skill. Absent is absent —
 * no placeholder is written for a field the registry did not report.
 */
const META_KEYS = [
  "title",
  "summary",
  "version",
  "license",
  "created",
  "revision",
  "authors",
  "vendor",
  "url",
  "documentation",
  "compatibility",
];

/**
 * The support channels, in the order `describe` reports them.
 *
 * They come off the *description companion's* manifest rather than the
 * version's, because a maintainer contact belongs to the repository and
 * changes over time. That has no effect on how they are refreshed here:
 * `describe` runs on every pass and is never skipped, so a support link
 * edited without republishing any artifact still lands on the next enrich —
 * it is only the companion *download* and the contents fetch that a digest
 * skips.
 */
const SUPPORT_CHANNELS = ["issues", "chat", "contact", "security"];

/**
 * The `support` block, or nothing.
 *
 * A repository publishing no companion reports four nulls, and four nulls
 * are the *absence* of a support block rather than an empty one — writing
 * them would put a key in every sidecar in the index for the sake of the
 * repositories that have nothing to say.
 */
function mapSupport(raw: unknown): Record<string, unknown> | undefined {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const reported = raw as Record<string, unknown>;
  const support: Record<string, unknown> = {};
  for (const channel of SUPPORT_CHANNELS) {
    if (reported[channel] != null) support[channel] = reported[channel];
  }
  return Object.keys(support).length > 0 ? support : undefined;
}

/**
 * grim's snake_case `describe` payload -> the camelCase fields the renderer
 * reads. Key insertion order is the on-disk order, and these sidecars are
 * committed — keep it stable so a refresh that changed nothing diffs as
 * nothing.
 */
function mapMeta(desc: Record<string, unknown>): Record<string, unknown> {
  const data: Record<string, unknown> = {};
  for (const key of META_KEYS) {
    if (desc[key] != null) data[key] = desc[key];
  }
  const support = mapSupport(desc.support);
  if (support) data.support = support;
  data.keywords = desc.keywords ?? [];
  data.tags = desc.tags ?? [];
  data.deprecated = desc.deprecated ?? null; // string | null, always present
  if (desc.replaced_by) data.replacedBy = desc.replaced_by;
  return data;
}

/**
 * RFC 3339 UTC to the second. Milliseconds in a committed file are noise
 * nobody reads and a wider diff when the stamp does move.
 */
function nowRfc3339(): string {
  return new Date().toISOString().replace(/\.\d+Z$/, "Z");
}

function decode(member: CompanionFile): Buffer {
  return member.encoding === "base64"
    ? Buffer.from(member.content, "base64")
    : Buffer.from(member.content, "utf8");
}

/**
 * Drop companion files before rewriting them. Without this, content deleted
 * upstream would render forever — the detail page globs the directory, it does
 * not consult a flag in `data.json`.
 */
export function clearCompanions(dir: string): void {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir)) {
    const low = entry.toLowerCase();
    if (low === "readme.md" || low === "changelog.md" || low.startsWith("logo.")) {
      fs.rmSync(path.join(dir, entry), { force: true });
    }
  }
}

/**
 * Kinds whose payload is the artifact's own entry-point markdown — a skill's
 * `SKILL.md`, a rule or an agent's single file. A bundle's member list and an
 * MCP descriptor are JSON, and everything else is left alone rather than
 * guessed at.
 */
const MARKDOWN_KINDS = new Set(["skill", "rule", "agent"]);
const JSON_KINDS = new Set(["bundle", "mcp"]);

/** Both spellings, so a kind that changes shape upstream cannot leave the old one behind. */
export function clearContents(dir: string): void {
  for (const name of ["contents.md", "contents.json"]) {
    fs.rmSync(path.join(dir, name), { force: true });
  }
}

/**
 * The artifact payload itself, written as the sidecar the "contents" tab
 * reads. One extra `fetch` per package, skipped whenever `describe` reports
 * the digest the last run already stored — which is every run that changed
 * nothing.
 */
async function writeContents(
  run: GrimRunner,
  out: string,
  ref: string,
  kind: string,
): Promise<boolean> {
  const markdown = MARKDOWN_KINDS.has(kind);
  if (!markdown && !JSON_KINDS.has(kind)) return false;

  const fetched = (await run(["fetch", ref])) as { content?: string };
  const content = fetched.content;
  if (typeof content !== "string" || content.trim() === "") return false;

  fs.mkdirSync(out, { recursive: true });
  clearContents(out);
  if (markdown) {
    fs.writeFileSync(path.join(out, "contents.md"), content);
    return true;
  }
  // Reject anything that is not the JSON it claims to be rather than writing
  // a file the site build would then fail to parse.
  try {
    JSON.parse(content);
  } catch {
    return false;
  }
  fs.writeFileSync(path.join(out, "contents.json"), content);
  return true;
}

/** Writes the companion members we render, ignoring anything else in the tree. */
function writeCompanions(
  dir: string,
  namespace: string,
  name: string,
  files: CompanionFile[],
): { hasReadme: boolean; hasChangelog: boolean; logo?: string } {
  let hasReadme = false;
  let hasChangelog = false;
  let logo: string | undefined;

  for (const member of files) {
    const low = member.path.toLowerCase();
    if (low === "readme.md") {
      fs.writeFileSync(path.join(dir, "readme.md"), decode(member));
      hasReadme = true;
    } else if (low === "changelog.md") {
      fs.writeFileSync(path.join(dir, "changelog.md"), decode(member));
      hasChangelog = true;
    } else if (low.startsWith("logo.")) {
      const ext = member.path.slice(member.path.lastIndexOf(".") + 1);
      if (!LOGO_EXT.test(ext)) continue;
      fs.writeFileSync(path.join(dir, `logo.${ext}`), decode(member));
      logo = `/logos/${namespace}/${name}.${ext}`;
    }
  }
  return { hasReadme, hasChangelog, logo };
}

type Sidecar = Record<string, unknown>;

/** The stored sidecar, or `{}` for a package never enriched (or one that cannot be read). */
function readSidecar(dataFile: string): Sidecar {
  try {
    return JSON.parse(fs.readFileSync(dataFile, "utf8")) as Sidecar;
  } catch {
    return {};
  }
}

/**
 * True when nothing the digests can see has moved, so the stored sidecar is
 * still the answer. Never throws for a *companion* probe failure — that falls
 * through to the full path, whose `describe` is what notices a withdrawn
 * companion. An artifact probe failure does throw: the full path would only
 * fail the same way, one call later.
 */
async function unchanged(run: GrimRunner, ref: string, existing: Sidecar): Promise<boolean> {
  // No stored digest, nothing to compare against — includes a package never
  // enriched and one whose seed was dropped by `reconcile()`.
  if (typeof existing.contentDigest !== "string") return false;

  const artifact = (await run(["fetch", ref, "--digest-only"])) as { digest?: string };
  if (artifact.digest !== existing.contentDigest) return false;

  // ponytail: a package stored without `descDigest` is never companion-probed
  // here, so a companion published later waits for its slice turn (≤ ~7 runs).
  if (typeof existing.descDigest !== "string") return true;
  try {
    const companion = (await run(["fetch", ref, "--description", "--digest-only"])) as {
      digest?: string;
    };
    return companion.digest === existing.descDigest;
  } catch {
    return false;
  }
}

async function enrichOne(
  run: GrimRunner,
  enrichDir: string,
  ref: string,
  namespace: string,
  name: string,
  existing: Sidecar,
  inSlice: boolean,
): Promise<void> {
  const out = path.join(enrichDir, namespace, name);
  const dataFile = path.join(out, "data.json");

  // Carried forward verbatim: the file is not even rewritten, so `describedAt`
  // keeps dating the last real describe.
  if (!inSlice && (await unchanged(run, ref, existing))) return;

  const desc = (await run(["describe", ref])) as Record<string, unknown>;
  const data = mapMeta(desc);

  if (desc.has_description) {
    const probe = (await run(["fetch", ref, "--description", "--digest-only"])) as {
      digest: string;
    };
    if (probe.digest === existing.descDigest) {
      // Unchanged: carry the cached companion state forward, download nothing.
      data.descDigest = probe.digest;
      data.hasReadme = existing.hasReadme ?? false;
      data.hasChangelog = existing.hasChangelog ?? false;
      if (existing.logo) data.logo = existing.logo;
    } else {
      fs.mkdirSync(out, { recursive: true });
      const fetched = (await run(["fetch", ref, "--description"])) as { files: CompanionFile[] };
      clearCompanions(out);
      const written = writeCompanions(out, namespace, name, fetched.files);
      data.descDigest = probe.digest;
      data.hasReadme = written.hasReadme;
      data.hasChangelog = written.hasChangelog;
      if (written.logo) data.logo = written.logo;
    }
  } else {
    // The companion is gone entirely; clear what it left behind.
    clearCompanions(out);
    data.hasReadme = false;
    data.hasChangelog = false;
  }

  // `describe` already reports the artifact digest, so the contents fetch
  // needs no probe of its own — an unchanged digest means the sidecar on
  // disk is still the answer.
  const digest = typeof desc.digest === "string" ? desc.digest : null;
  if (digest && digest === existing.contentDigest) {
    data.contentDigest = digest;
    data.hasContents = existing.hasContents ?? false;
  } else {
    const kind = typeof desc.kind === "string" ? desc.kind : "";
    const written = await writeContents(run, out, ref, kind);
    if (!written) clearContents(out);
    if (digest) data.contentDigest = digest;
    data.hasContents = written;
  }

  // Recency is an indexer-side join, not something grim publishes: `describe`
  // runs here per package on every pass, so nothing upstream has to carry a
  // second date. The artifact's own `created` is it whenever there is one —
  // it is the commit date, so a re-publish of the same commit keeps the same
  // answer. An artifact published outside a repository (or with `--no-git`)
  // has none, and then recency is when *this index* first saw the current
  // digest. The digest bookkeeping above is the only state that can answer
  // "first", so the stamp rides with it and is re-taken only when the
  // artifact actually moved — a fresh stamp every run would churn a
  // committed file and date every package to the last enrich.
  const moved = digest !== null && digest !== existing.contentDigest;
  data.updated =
    typeof data.created === "string"
      ? data.created
      : !moved && typeof existing.updated === "string"
        ? existing.updated
        : nowRfc3339();
  // Last key, so a sidecar written before the field existed diffs by one line.
  // It is bookkeeping for the slice below — `compileIndex` strips it from
  // `all.json`.
  data.describedAt = nowRfc3339();

  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(dataFile, JSON.stringify(data, null, 1) + "\n");
}

/**
 * The packages to re-describe this run regardless of their digests: ⌈N/7⌉ of
 * them, oldest `describedAt` first, a package with none ahead of every dated
 * one, ties broken by `<namespace>/<name>`. RFC 3339 UTC strings sort
 * lexicographically, and `""` sorts before any of them.
 */
function pickSlice(entries: Array<{ id: string; existing: Sidecar }>): Set<string> {
  const stamp = (e: { existing: Sidecar }): string =>
    typeof e.existing.describedAt === "string" ? e.existing.describedAt : "";
  const size = Math.ceil(entries.length / SLICE_DIVISOR);
  return new Set(
    [...entries]
      .sort((a, b) => stamp(a).localeCompare(stamp(b)) || a.id.localeCompare(b.id))
      .slice(0, size)
      .map((e) => e.id),
  );
}

export async function enrichIndex(opts: EnrichOptions): Promise<EnrichResult> {
  const { root } = opts;
  const run = opts.run ?? spawnGrim();
  const concurrency = Math.max(1, Math.floor(opts.concurrency ?? DEFAULT_CONCURRENCY));
  const indexDir = path.join(root, "index");
  const enrichDir = path.join(root, "enrich");

  const files = findMetadataFiles(indexDir);
  const packages = files.map((file) => {
    const meta = JSON.parse(fs.readFileSync(file, "utf8")) as { ref: string; name: string };
    const namespace = namespaceOf(indexDir, file);
    const existing = readSidecar(path.join(enrichDir, namespace, meta.name, "data.json"));
    return { ref: meta.ref, name: meta.name, namespace, id: `${namespace}/${meta.name}`, existing };
  });
  const slice = pickSlice(packages);

  // Indexed slots, so the failure list keeps index order however the pool
  // happens to finish.
  const failed: Array<string | undefined> = new Array(packages.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < packages.length) {
      const i = next++;
      const pkg = packages[i]!;
      try {
        await enrichOne(run, enrichDir, pkg.ref, pkg.namespace, pkg.name, pkg.existing, slice.has(pkg.id));
      } catch (err) {
        failed[i] = `${pkg.ref}: ${err instanceof Error ? err.message : String(err)}`;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, packages.length) }, worker));

  const failures = failed.filter((f): f is string => f !== undefined);
  return { total: files.length, enriched: files.length - failures.length, failures };
}
