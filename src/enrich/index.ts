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
 * Probe first, describe rarely, and by bucket: the pointers fall into 256
 * buckets, each stamped with when it was last checked and last fully
 * re-described (`../state/detect.ts` decides). A bucket inside its window costs
 * nothing; a due one costs two `fetch --digest-only` calls per ref, compared with
 * the `input` the entry was built from; a ref that cannot be compared — new,
 * pointer-only, in a rotation, short a blob — goes straight to the three-call
 * deep path. A run past its time budget starts no further ref.
 *
 * Packages run through a bounded pool. A per-package failure keeps the
 * existing sidecar — stale beats empty — and backs the ref off (IX-R40); a ref
 * that keeps failing for 30 days goes pointer-only (IX-R51). When half or more
 * of the refs a build tried failed, the build was an outage: nobody is backed
 * off and no bucket holding a failure is stamped.
 */
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

import { findMetadataFiles, namespaceOf } from "../data/index.js";
import { clampData } from "../emit/records.js";
import { parseGrimVersion } from "../grim.js";
import { PACKAGE_LOGOS, logoOk } from "../logo.js";
import { BLOB_CAP, blobRefOf, type BlobStore } from "../state/blobstore.js";
import {
  bucketNumber,
  bucketOrder,
  backoffOf,
  budgetFor,
  cutDue,
  entryInput,
  isArmed,
  isDue,
  isRot,
  median,
  memoized,
  overflowing,
  planRef,
  pointerOnly,
  pointersDigest,
  rotationMs,
  stampBucket,
  type EnrichCounters,
  type PlaneState,
} from "../state/detect.js";
import { dedupeByRef } from "../emit/dedupe.js";
import { collectEntries, readData } from "../state/entries.js";
import { SHARD_CAP, bucketOf, type BucketStamp, type EnrichEntry } from "../state/plane.js";
import { META_KEYS, SUPPORT_CHANNELS, clearCompanions, clearContents, clearSidecar, sidecarDir } from "./sidecar.js";

const execFileAsync = promisify(execFile);

/** Per-`grim`-call ceiling. A description companion is text plus one logo. */
const TIMEOUT_MS = 60_000;
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
/** grim's exit status for "no such artifact or companion". */
const GRIM_NOT_FOUND = 79;

/** Runs one `grim` subcommand and parses its JSON. Injected so tests need no binary. */
export type GrimRunner = (args: string[], opts?: { timeoutMs?: number }) => Promise<unknown>;

export interface EnrichOptions {
  /** Index repo root — holds `index/`, gains `enrich/`. */
  root: string;
  /** Defaults to spawning `grim` from `PATH`. */
  run?: GrimRunner;
  /** Packages refreshed at once; each runs its `grim` calls in sequence. */
  concurrency?: number;
  /** The enrich plane the run starts from; none is a cold build, every ref deep. */
  plane?: PlaneState;
  /** Where fetched files land as they arrive, and what "a blob is missing" is judged against. */
  store?: BlobStore;
  /** `sync.revalidate`, in milliseconds. */
  revalidateMs?: number;
  /** `CI_JOB_TIMEOUT` in seconds: the time budget is whatever it leaves after the stages that follow. */
  jobTimeoutSeconds?: number;
  /** `--purge`: a blob digest, or a ref (resolved through its entry's `files`). */
  purge?: PurgeTarget;
  /** Milliseconds; injected so a test owns time. */
  clock?: () => number;
  /** Milliseconds: when the run began, if before this call (the CLI restores state first). The budget and the stamps count from here. */
  startedAt?: number;
  /** `--fresh`: a ref that fails is rebuilt from nothing, so it keeps none of the carried entry. */
  fresh?: boolean;
}

/** What `--purge` names, as `parsePurge` validated it. */
export type PurgeTarget = { digest: string } | { ref: string };

export const DEFAULT_CONCURRENCY = 8;

const DEFAULT_REVALIDATE_MS = 3_600_000;

/**
 * Stamped on every bucket and folded into every entry's `input`. Bump it on any
 * change to what a deep enrich writes (a sidecar key, a companion file): every
 * ref is then rebuilt, three calls each, instead of being carried forward stale.
 */
export const ENRICHER_VERSION = "1";

/** What an entry keeps besides its data and files: the bookkeeping the next run compares against. */
export type RefState = Pick<EnrichEntry, "failing_since" | "failures" | "input" | "last_failure_at">;

export interface EnrichResult {
  total: number;
  enriched: number;
  /** One `"<ref>: <reason>"` per package whose refresh failed. */
  failures: string[];
  /** What the plane will hold, by ref: the sidecars as the run left them, with the failure memo applied. */
  entries: Map<string, EnrichEntry>;
  /** Every bucket's stamp after the run. */
  stamps: Record<string, Partial<BucketStamp>>;
  counters: EnrichCounters;
}

/** One member of a description companion, as `grim fetch --description` reports it. */
interface CompanionFile {
  path: string;
  content: string;
  encoding?: string;
}

/**
 * The version `<bin> --version` reports (`""` when it names none), or
 * `undefined` when `bin` is not installed. Any other failure throws.
 */
export async function grimVersion(bin = "grim"): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync(bin, ["--version"], {
      timeout: TIMEOUT_MS,
      maxBuffer: 64 * 1024,
      encoding: "utf8",
    });
    return parseGrimVersion(stdout);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
}

export function spawnGrim(bin = "grim"): GrimRunner {
  return async (args, opts) => {
    const { stdout } = await execFileAsync(bin, [...args, "--format", "json"], {
      timeout: opts?.timeoutMs ?? TIMEOUT_MS,
      maxBuffer: MAX_OUTPUT_BYTES,
      encoding: "utf8",
    });
    return JSON.parse(stdout);
  };
}



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
function rfc3339(ms: number): string {
  return new Date(ms).toISOString().replace(/\.\d+Z$/, "Z");
}

function decode(member: CompanionFile): Buffer {
  return member.encoding === "base64"
    ? Buffer.from(member.content, "base64")
    : Buffer.from(member.content, "utf8");
}

/**
 * Kinds whose payload is the artifact's own entry-point markdown — a skill's
 * `SKILL.md`, a rule or an agent's single file. A bundle's member list and an
 * MCP descriptor are JSON, and everything else is left alone rather than
 * guessed at.
 */
const MARKDOWN_KINDS = new Set(["skill", "rule", "agent"]);
const JSON_KINDS = new Set(["bundle", "mcp"]);

const capped = (bytes: Buffer): Buffer => (bytes.length > BLOB_CAP ? bytes.subarray(0, BLOB_CAP) : bytes);

/** Hands a fetched file's bytes to the blob store the moment they land on disk. */
type Keep = (bytes: Buffer) => void;

/**
 * The artifact payload itself, written as the sidecar the "contents" tab
 * reads. One extra `fetch` per deep enrich.
 */
async function writeContents(
  run: GrimRunner,
  out: string,
  ref: string,
  kind: string,
  keep: Keep,
): Promise<boolean> {
  const markdown = MARKDOWN_KINDS.has(kind);
  if (!markdown && !JSON_KINDS.has(kind)) return false;

  const fetched = (await run(["fetch", ref])) as { content?: string };
  const content = fetched.content;
  if (typeof content !== "string" || content.trim() === "") return false;

  fs.mkdirSync(out, { recursive: true });
  clearContents(out);
  if (markdown) {
    // Capped before the write: the tree must hold what the blob store holds, or a restored rebuild differs from this one.
    const bytes = capped(Buffer.from(content));
    fs.writeFileSync(path.join(out, "contents.md"), bytes);
    keep(bytes);
    return true;
  }
  // A truncated JSON file would fail the site build that parses it, so an oversized one is dropped.
  if (Buffer.byteLength(content) > BLOB_CAP) return false;
  // Reject anything that is not the JSON it claims to be rather than writing
  // a file the site build would then fail to parse.
  try {
    JSON.parse(content);
  } catch {
    return false;
  }
  fs.writeFileSync(path.join(out, "contents.json"), content);
  keep(Buffer.from(content));
  return true;
}

/** Writes the companion members we render, ignoring anything else in the tree. */
function writeCompanions(
  dir: string,
  namespace: string,
  name: string,
  files: CompanionFile[],
  keep: Keep,
): { hasReadme: boolean; hasChangelog: boolean; logo?: string } {
  let hasReadme = false;
  let hasChangelog = false;
  let logo: string | undefined;

  for (const member of files) {
    const low = member.path.toLowerCase();
    if (low === "readme.md") {
      const bytes = capped(decode(member));
      fs.writeFileSync(path.join(dir, "readme.md"), bytes);
      keep(bytes);
      hasReadme = true;
    } else if (low === "changelog.md") {
      const bytes = capped(decode(member));
      fs.writeFileSync(path.join(dir, "changelog.md"), bytes);
      keep(bytes);
      hasChangelog = true;
    } else if (low.startsWith("logo.")) {
      // The name comes from the registry: only an extension `logoOk` knows is ever joined onto a path.
      const ext = member.path.slice(member.path.lastIndexOf(".") + 1);
      const bytes = decode(member);
      if (!logoOk(ext, bytes, PACKAGE_LOGOS)) continue;
      fs.writeFileSync(path.join(dir, `logo.${ext}`), bytes);
      keep(bytes);
      logo = `/logos/${namespace}/${name}.${ext}`;
    }
  }
  return { hasReadme, hasChangelog, logo };
}


interface Pkg {
  /** Position in the pointer walk, so failures report in index order whatever the pool does. */
  index: number;
  ref: string;
  name: string;
  namespace: string;
  pointer: { path: string; bytes: Buffer };
  /** The parsed pointer: what `compileIndex` lays over the sidecar. */
  meta: Record<string, unknown>;
}

/** Every pointer in the walk, in path order. */
function walkPointers(indexDir: string): Pkg[] {
  return findMetadataFiles(indexDir).map((file, index) => {
    const bytes = fs.readFileSync(file);
    const meta = JSON.parse(bytes.toString("utf8")) as Record<string, unknown> & { ref: string; name: string };
    const rel = path.relative(indexDir, file).split(path.sep).join("/");
    return { index, ref: meta.ref, name: meta.name, namespace: namespaceOf(indexDir, file), pointer: { path: rel, bytes }, meta };
  });
}

/**
 * grim reports a 429 only through its stderr, which `execFile` folds into the
 * message after the command line. The command line names the ref, so it is not
 * searched: a package called `app-429` is not a throttled registry.
 */
const isThrottled = (err: unknown): boolean => {
  const message = err instanceof Error ? err.message : String(err);
  return /\bhttp\s*429\b|\b429 too many requests\b|too many requests/i.test(message.split("\n").slice(1).join("\n"));
};

/** Counts and times every grim call, probe and deep apart, and counts the 429s among the failures. */
class CallLog {
  calls = 0;
  throttled = 0;
  private readonly ms = { probe: [] as number[], deep: [] as number[] };

  constructor(
    private readonly run: GrimRunner,
    private readonly clock: () => number,
  ) {}

  runner(kind: "probe" | "deep"): GrimRunner {
    return async (args, opts) => {
      const start = this.clock();
      this.calls += 1;
      try {
        return await this.run(args, opts);
      } catch (err) {
        if (isThrottled(err)) this.throttled += 1;
        throw err;
      } finally {
        this.ms[kind].push(this.clock() - start);
      }
    };
  }

  median(kind: "probe" | "deep"): number {
    return Math.round(median(this.ms[kind]));
  }
}

/** One bucket's standing in this run. */
interface BucketRun {
  id: string;
  due: boolean;
  rot: boolean;
  pointers: string;
  /** False once the budget cut a ref of it short. */
  ok: boolean;
  failed: boolean;
  /** Refs outside their backoff, and how many of them went deep and succeeded. */
  eligible: number;
  deepDone: number;
}

interface Work {
  pkg: Pkg;
  bucket: BucketRun;
  entry: EnrichEntry | undefined;
  plan: "probe" | "deep";
}

const stateOf = (e: EnrichEntry): RefState => ({ failing_since: e.failing_since, failures: e.failures, input: e.input, last_failure_at: e.last_failure_at });

const FRESH: Pick<RefState, "failing_since" | "failures" | "last_failure_at"> = { failing_since: null, failures: 0, last_failure_at: null };

/** True when any file the entry names is gone from the store or no longer hashes to its name. */
function lacksBlob(entry: EnrichEntry, store: BlobStore | undefined): boolean {
  if (store === undefined) return false;
  return Object.values(entry.files).some((ref) => {
    const got = store.get(ref.sha256);
    return got === null || got.length !== ref.size;
  });
}

interface Plan {
  work: Work[];
  buckets: BucketRun[];
  /** What the refs that need no call carry. */
  states: Map<string, RefState>;
  waiting: number;
}

/**
 * Decide every ref before any call is made: buckets oldest first, and within
 * them the pointer walk's order. Only the budget is left for the moment a ref
 * is about to start.
 */
function planRun(pkgs: Pkg[], plane: PlaneState, store: BlobStore | undefined, now: number, windowMs: number, skip: ReadonlySet<string>): Plan {
  const byBucket = new Map<string, Pkg[]>();
  for (const pkg of pkgs) byBucket.set(bucketOf(pkg.ref), [...(byBucket.get(bucketOf(pkg.ref)) ?? []), pkg]);

  const rotMs = rotationMs(windowMs);
  const out: Plan = { work: [], buckets: [], states: new Map(), waiting: 0 };
  for (const id of bucketOrder([...byBucket.keys()], plane.stamps)) {
    const members = byBucket.get(id)!;
    const stamp = plane.stamps[id];
    const bucket = bucketNumber(id);
    const pointers = pointersDigest(members.map((p) => p.pointer));
    const run: BucketRun = {
      id,
      pointers,
      due: isDue({ now, windowMs, bucket, stamp, pointers, version: ENRICHER_VERSION }),
      rot: isRot({ now, rotationMs: rotMs, bucket, stamp }),
      ok: true,
      failed: false,
      eligible: 0,
      deepDone: 0,
    };
    out.buckets.push(run);

    for (const pkg of members) {
      // Purged refs already ran, ahead of the loop (§6.10): `b minus PR`.
      if (skip.has(pkg.ref)) continue;
      const entry = plane.entries.get(pkg.ref);
      const backoff = entry ? backoffOf(entry, now, windowMs, rotMs) : "none";
      if (backoff === "waiting") out.waiting += 1;
      else run.eligible += 1;
      const plan = planRef({
        entry,
        backoff,
        due: run.due,
        rot: run.rot,
        enricherChanged: stamp?.enricher !== ENRICHER_VERSION,
        missing: () => lacksBlob(entry!, store),
      });
      if (plan === "carry") {
        if (entry) out.states.set(pkg.ref, stateOf(entry));
      } else {
        out.work.push({ pkg, bucket: run, entry, plan });
      }
    }
  }
  return out;
}

/** The input the registry would give the entry now: two cheap calls. `null` when the artifact reports no digest. */
async function probeInput(run: GrimRunner, pkg: Pkg): Promise<string | null> {
  const artifact = (await run(["fetch", pkg.ref, "--digest-only"])) as { digest?: unknown };
  // A package with no companion makes grim exit not-found (79): that is "no digest", the same as the `none` an entry stores. Any other failure is the registry's, and must not read as a moved input.
  const companion = await run(["fetch", pkg.ref, "--description", "--digest-only"]).then(
    (c) => (c as { digest?: unknown }).digest,
    (err: unknown) => {
      if ((err as { code?: unknown } | null)?.code === GRIM_NOT_FOUND) return undefined;
      throw err;
    },
  );
  if (typeof artifact.digest !== "string") return null;
  return entryInput(pkg.pointer.bytes, artifact.digest, typeof companion === "string" ? companion : undefined, ENRICHER_VERSION);
}

/**
 * The three-call path: `describe`, the description companion, the contents. The
 * two digests `input` is built from come back with the first two, so no probe.
 * Returns the new input, or `null` when the registry reported a digest it must be
 * compared on — the entry is then simply deep again next time.
 */
async function deepEnrich(
  run: GrimRunner,
  io: { enrichDir: string; keep: Keep; at: string },
  pkg: Pkg,
  existing: Record<string, unknown>,
): Promise<string | null> {
  const out = sidecarDir(io.enrichDir, pkg.namespace, pkg.name);
  if (out === null) throw new Error(`the pointer's name ${JSON.stringify(pkg.name)} is not a single path segment`);
  const desc = (await run(["describe", pkg.ref])) as Record<string, unknown>;
  const data = mapMeta(desc);
  const digest = typeof desc.digest === "string" ? desc.digest : null;

  let companion: string | undefined;
  if (desc.has_description) {
    const fetched = (await run(["fetch", pkg.ref, "--description"])) as { digest?: unknown; files: CompanionFile[] };
    fs.mkdirSync(out, { recursive: true });
    clearCompanions(out);
    const written = writeCompanions(out, pkg.namespace, pkg.name, fetched.files, io.keep);
    data.hasReadme = written.hasReadme;
    data.hasChangelog = written.hasChangelog;
    if (written.logo) data.logo = written.logo;
    if (typeof fetched.digest === "string") companion = fetched.digest;
  } else {
    // The companion is gone entirely; clear what it left behind.
    clearCompanions(out);
    data.hasReadme = false;
    data.hasChangelog = false;
  }

  const kind = typeof desc.kind === "string" ? desc.kind : "";
  const written = await writeContents(run, out, pkg.ref, kind, io.keep);
  if (!written) clearContents(out);
  if (digest) data.contentDigest = digest;
  data.hasContents = written;

  // Recency is an indexer-side join: the artifact's `created` when it has one, else when this
  // index first saw the current digest. The carried entry is the only state that can answer
  // "first", so the stamp is re-taken only when the digest moved; a fresh one every run would
  // date every undated package to the last enrich.
  const moved = digest !== null && digest !== existing.contentDigest;
  data.updated =
    typeof data.created === "string" ? data.created : !moved && typeof existing.updated === "string" ? existing.updated : io.at;

  // IX-R47: the sidecar is stored, and built from, within the record text bounds `all.json` applies.
  const stored = clampData(data, { ...pkg.meta, namespace: pkg.namespace });
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, "data.json"), JSON.stringify(stored, null, 1) + "\n");

  if (digest === null || (desc.has_description && companion === undefined)) return null;
  return entryInput(pkg.pointer.bytes, digest, companion, ENRICHER_VERSION);
}

/**
 * `PD` and `PR` of §6.10. A digest names itself; a ref names the digests its
 * entry's `files` carry. Every ref whose entry names one of those digests is
 * rebuilt too, the named ref included.
 */
function resolvePurge(target: PurgeTarget | undefined, entries: ReadonlyMap<string, EnrichEntry>): { digests: Set<string>; refs: Set<string> } {
  const digests = new Set<string>();
  const refs = new Set<string>();
  if (target === undefined) return { digests, refs };
  if ("digest" in target) digests.add(target.digest);
  else {
    refs.add(target.ref);
    for (const f of Object.values(entries.get(target.ref)?.files ?? {})) digests.add(f.sha256);
  }
  for (const [ref, entry] of entries) {
    if (Object.values(entry.files).some((f) => digests.has(f.sha256))) refs.add(ref);
  }
  return { digests, refs };
}

/** Runs `fn` over `items` with at most `limit` in flight, taking them in order. */
export async function pool<T>(items: readonly T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) await fn(items[next++]!);
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

export async function enrichIndex(opts: EnrichOptions): Promise<EnrichResult> {
  const { root, store } = opts;
  const clock = opts.clock ?? Date.now;
  const started = opts.startedAt ?? clock();
  // Whole seconds: a stamp is written to the second, and a window test on the unrounded start would call a bucket due again for the fraction it lost.
  const now = Math.floor(started / 1000) * 1000;
  const at = rfc3339(now);
  const windowMs = opts.revalidateMs ?? DEFAULT_REVALIDATE_MS;
  const concurrency = Math.max(1, Math.floor(opts.concurrency ?? DEFAULT_CONCURRENCY));
  const plane: PlaneState = opts.plane ?? { entries: new Map(), stamps: {} };
  const enrichDir = path.join(root, "enrich");

  const budget = budgetFor(started, opts.jobTimeoutSeconds);
  if (budget.rerender) {
    console.warn(
      `warn: the job timeout (${opts.jobTimeoutSeconds} s) leaves ${budget.minutes} min of enrich budget, under the usual 85 — re-render required`,
    );
  }

  const all = walkPointers(path.join(root, "index"));
  // Last package per ref in sorted path order: the plane holds one entry for a ref, whichever
  // pointer names it (IX-R04). `all.json` still carries every pointer.
  const { kept: pkgs, warnings } = dedupeByRef(all, (p) => p.pointer.path);
  for (const w of warnings) console.warn(w);
  const log = new CallLog(opts.run ?? spawnGrim(), clock);
  const probeRun = log.runner("probe");
  const deepRun = log.runner("deep");
  const keep: Keep = (bytes) => void store?.put(bytes);

  // `PD` and `PR` (§6.10): the blobs to drop, and the refs that must be rebuilt without them.
  const { refs: purged, digests: purgedDigests } = resolvePurge(opts.purge, plane.entries);
  for (const sha256 of purgedDigests) store?.delete(sha256);

  const plan = planRun(pkgs, plane, store, now, windowMs, purged);
  const states = plan.states;
  const failed = new Map<number, string>();
  /** `A` and `F` of spec §6.10: the refs this build tried, and the ones that failed. */
  const attempted = new Set<string>();
  const failedRefs = new Set<string>();
  let probed = 0;
  let deep = 0;
  let budgetHit = false;
  const bucketRuns = new Map(plan.buckets.map((b) => [b.id, b]));
  const byRef = new Map(pkgs.map((p) => [p.ref, p]));
  // A ref the plane has no entry for may still have a sidecar on disk, committed or left by an earlier run here: it remembers when its digest was first seen. `--fresh` carries nothing.
  const onDisk = (pkg: Pkg): Record<string, unknown> => {
    const dir = opts.fresh ? null : sidecarDir(enrichDir, pkg.namespace, pkg.name);
    return (dir === null ? null : readData(path.join(dir, "data.json"))) ?? {};
  };
  const pointersOf = new Map<string, Pkg[]>();
  for (const p of all) pointersOf.set(p.ref, [...(pointersOf.get(p.ref) ?? []), p]);
  // Every pointer naming the ref, not only the one the plane keeps: `collectEntries` reads them all, so a twin left alone would carry the cleared data back.
  const empty = (ref: string): void => {
    for (const pkg of pointersOf.get(ref) ?? []) {
      const dir = sidecarDir(enrichDir, pkg.namespace, pkg.name);
      if (dir !== null) clearSidecar(dir);
    }
  };

  // Purge first: no backoff, no budget gate. A success is a fresh entry; a failure
  // leaves nothing of the purged data behind, so the ref is emitted pointer-only.
  const toPurge = pkgs.filter((p) => purged.has(p.ref));
  if (opts.purge !== undefined && toPurge.length === 0) console.warn("warn: --purge matched no ref in the pointer walk — nothing to rebuild");
  await pool(toPurge, concurrency, async (pkg) => {
    attempted.add(pkg.ref);
    deep += 1;
    try {
      // `{}`, not the carried data: the purged entry must not seed the new one (its `updated` included).
      const input = await deepEnrich(deepRun, { enrichDir, keep, at }, pkg, {});
      states.set(pkg.ref, { ...FRESH, input });
    } catch (err) {
      empty(pkg.ref);
      bucketRuns.get(bucketOf(pkg.ref))!.failed = true;
      failedRefs.add(pkg.ref);
      failed.set(pkg.index, `${pkg.ref}: ${err instanceof Error ? err.message : String(err)}`);
    }
  });

  await pool(plan.work, concurrency, async ({ pkg, bucket, entry, plan: how }) => {
    const carry = (): void => void (entry && states.set(pkg.ref, stateOf(entry)));
    // Gated per ref, before its first call: the budget covers probes too, and a ref already started finishes.
    if (clock() >= budget.endMs) {
      bucket.ok = false;
      budgetHit = true;
      return carry();
    }
    attempted.add(pkg.ref);
    try {
      let input: string | null = null;
      let goDeep = how === "deep";
      if (!goDeep) {
        probed += 1;
        input = await probeInput(probeRun, pkg);
        goDeep = input === null || input !== entry!.input;
      }
      if (goDeep) {
        deep += 1;
        input = await deepEnrich(deepRun, { enrichDir, keep, at }, pkg, entry === undefined ? onDisk(pkg) : (entry.data ?? {}));
        bucket.deepDone += 1;
      }
      states.set(pkg.ref, { ...FRESH, input: goDeep ? input : entry!.input });
    } catch (err) {
      bucket.failed = true;
      failedRefs.add(pkg.ref);
      failed.set(pkg.index, `${pkg.ref}: ${err instanceof Error ? err.message : String(err)}`);
      carry();
    }
  });

  const entries = collectEntries(root, store ? (bytes) => store.put(bytes) : (bytes) => blobRefOf(bytes), states);

  // `--fresh` carries nothing: a ref that failed must not publish the sidecar the checkout still holds from before.
  if (opts.fresh) {
    for (const ref of failedRefs) {
      entries.delete(ref);
      empty(ref);
    }
  }

  // A failed ref with nothing stored is sized as the pointer-only entry it will become.
  const provisional = [...failedRefs].filter((ref) => !entries.has(ref));
  for (const ref of provisional) entries.set(ref, pointerOnly(FRESH));

  // IX-R47, before the plane is built: a shard that would pass its cap sheds the entries with the most data. Each one counts as attempted and failed.
  for (const ref of overflowing(entries, failedRefs, at)) {
    entries.set(ref, pointerOnly(entries.get(ref)!));
    empty(ref);
    attempted.add(ref);
    failedRefs.add(ref);
    bucketRuns.get(bucketOf(ref))!.failed = true;
    failed.set(byRef.get(ref)!.index, `${ref}: its enrich shard passes ${SHARD_CAP} bytes, so the entry is degraded to pointer-only`);
  }

  // IX-R40: fewer than half of the refs tried failing means the failures are theirs; otherwise the build was an outage and blames none of them.
  const armed = isArmed(attempted.size, failedRefs.size);
  if (armed) {
    for (const ref of failedRefs) entries.set(ref, memoized(entries.get(ref), at));
    // IX-R51: continuous failure on armed builds only, so an outage build never starts the clock, advances it or cuts.
    for (const ref of failedRefs) {
      const entry = entries.get(ref)!;
      if (!cutDue(entry, now)) continue;
      entries.set(ref, pointerOnly(entry));
      empty(ref);
      // An entry already cut stays cut on every retry; only the build that cuts it announces it.
      if (entry.data !== null) console.warn(`warn: ${ref}: failing since ${entry.failing_since} (30 days or more) — now pointer-only`);
    }
  } else {
    for (const ref of provisional) entries.delete(ref);
  }

  const stamps: Record<string, Partial<BucketStamp>> = {};
  for (const b of plan.buckets) {
    const stamp = stampBucket(plane.stamps[b.id], {
      due: b.due,
      rot: b.rot,
      allDeep: b.eligible > 0 && b.deepDone === b.eligible,
      ok: b.ok,
      failed: b.failed && !armed,
      at,
      pointers: b.pointers,
      version: ENRICHER_VERSION,
    });
    if (stamp !== undefined) stamps[b.id] = stamp;
  }

  const failures = [...failed].sort(([a], [b]) => a - b).map(([, message]) => message);
  return {
    total: all.length,
    enriched: all.length - failures.length,
    failures,
    entries,
    stamps,
    counters: {
      probed,
      deep,
      calls: log.calls,
      probe_ms_p50: log.median("probe"),
      deep_ms_p50: log.median("deep"),
      budget_min: budget.minutes,
      throttled: log.throttled,
      backoff_refs: plan.waiting,
      enrich: budgetHit ? "budget" : "complete",
    },
  };
}
