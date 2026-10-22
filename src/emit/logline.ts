// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Grimoire Authors

// IX-R23; spec §5.9. The line and its warnings are log text, not a contract:
// nothing here changes a published byte or the exit status.
import fs from "node:fs";
import path from "node:path";

import type { SyncConfig } from "../config.js";
import type { SiteFacts } from "../renderer/types.js";
import { BUDGET_MAX_MS, MINUTE_MS } from "../state/detect.js";
import { STATE_DIR, readHandoff, type HandoffCounters } from "../state/handoff.js";
import { sha256Hex } from "./digest.js";
import type { BlobRef, Root } from "./root.js";

/** grim's `INDEX_BODY_LIMIT`, inflated and downloaded: `all.json` past it is unreadable to a shipped grim. */
export const GRIM_BODY_CAP = 128 * 1024 * 1024;
/** The design ceiling of the flat layout (§1). */
export const ENTRY_CEILING = 100_000;
/** Early warning for any one state file; the hard cap is 16 MiB (P-10). */
export const STATE_FILE_WARN = 12 * 1024 * 1024;
/** Scale trigger D: the first search downloads the gzip whole, so it warns at 6 MiB and is an error at 8. */
export const SEARCH_WIRE_WARN = 6 * 1024 * 1024;
export const SEARCH_WIRE_ERROR = 8 * 1024 * 1024;
/** Scale trigger E: the deploy host's limits with headroom, decimal like the host's own figures. */
export const SITE_BYTES_CEILING = 800 * 1000 * 1000;
export const SITE_FILES_CEILING = 160 * 1000;
const WARN_PERCENT = 80;
const FULL_BUDGET_MIN = BUDGET_MAX_MS / MINUTE_MS;

export interface StateFile {
  /** From the index root, `/`-separated. */
  path: string;
  bytes: number;
}

/** What the site step produced and `dist/` weighs, as plain values. */
export interface SiteReport {
  search: BlobRef | null;
  /** Gzip bytes of the `c/q` file; `0` without one. */
  searchWire: number;
  /** Sum of the regular files in `dist/`. */
  siteBytes: number;
  siteFiles: number;
  astroMs: number;
  astroDirBytes: number;
  pagesCut: number;
  pagesHardCut: number;
  /** Pages still over their size cap after the hard cut. */
  overCap: readonly string[];
}

/** What `build` measured, as plain values so the line and the warnings are pure. */
export interface BuildReport {
  layout: SyncConfig["layout"];
  legacy: boolean;
  generation: number;
  /** The inflated `all.json` bytes and their gzip, whatever the layout. */
  flat: { sha256: string; bytes: number; gzip: number };
  stats: BlobRef | null;
  enrichPlane: BlobRef | null;
  entries: number;
  /** `null` without a hand-off. */
  counters: HandoffCounters | null;
  largestStateFile: StateFile | null;
  site: SiteReport;
}

export interface BuildWarning {
  level: "warn" | "error";
  text: string;
}

const NO_COUNTERS: Omit<HandoffCounters, "enrich"> = {
  retained_files: 0, retained_skipped: 0, probed: 0, deep: 0, calls: 0,
  probe_ms_p50: 0, deep_ms_p50: 0, budget_min: 0, throttled: 0, backoff_refs: 0, failed_buckets: 0,
};

/** The §5.9 line, field for field. An absent digest reads `-`, and an absent search file `none`. */
export function formatBuildLine(r: BuildReport): string {
  const c = r.counters ?? NO_COUNTERS;
  const s = r.site;
  return [
    "grim-indexer: built",
    `layout=${r.layout} legacy=${r.legacy} generation=${r.generation}`,
    `flat sha256=${r.flat.sha256} bytes=${r.flat.bytes} gzip=${r.flat.gzip}`,
    `stats sha256=${r.stats?.sha256 ?? "-"} bytes=${r.stats?.size ?? 0}`,
    `planes enrich=${r.enrichPlane?.sha256 ?? "-"}`,
    `retained files=${c.retained_files} skipped=${c.retained_skipped}`,
    `probed=${c.probed} deep=${c.deep} calls=${c.calls} probe_ms_p50=${c.probe_ms_p50} deep_ms_p50=${c.deep_ms_p50}`,
    `budget_min=${c.budget_min} throttled=${c.throttled} backoff_refs=${c.backoff_refs}`,
    `enrich=${r.counters?.enrich ?? "none"} failed_buckets=${c.failed_buckets}`,
    `search=${s.search?.sha256 ?? "none"} search_wire=${s.searchWire}`,
    `site_bytes=${s.siteBytes} site_files=${s.siteFiles} astro_ms=${Math.round(s.astroMs)} astro_dir_bytes=${s.astroDirBytes}`,
    `pages_cut=${s.pagesCut} pages_hard_cut=${s.pagesHardCut}`,
  ].join(" ");
}

const atWarnLevel = (value: number, cap: number): boolean => value * 100 >= cap * WARN_PERCENT;
const percentOf = (value: number, cap: number): number => Math.floor((value * 100) / cap);

/**
 * The §5.9 budget warnings, in the spec's order. The shard warning
 * (`emitPlane`) and the missing-anchor warning (`applyLegacy`) are printed where
 * they are decided and are not repeated here. The counters' warnings need a
 * hand-off: without one they are all zeros, which would read as a short budget.
 */
export function budgetWarnings(r: BuildReport): BuildWarning[] {
  const out: BuildWarning[] = [];
  const warn = (text: string): number => out.push({ level: "warn", text });
  const error = (text: string): number => out.push({ level: "error", text });
  const c = r.counters;

  const big = r.largestStateFile;
  if (big !== null && big.bytes >= STATE_FILE_WARN) {
    warn(`state file ${big.path} is ${big.bytes} bytes, past the ${STATE_FILE_WARN} byte early warning (a state file is capped at 16 MiB)`);
  }
  if (c !== null && c.retained_skipped > 0) {
    warn(
      `the stage skipped ${c.retained_skipped} file(s) of the previous closure (missing or failing verification) — ` +
        `a stale-edge root can name a file the deploy no longer carries`,
    );
  }
  const { bytes } = r.flat;
  if (bytes > GRIM_BODY_CAP) error(`all.json is ${bytes} bytes, over grim's ${GRIM_BODY_CAP} byte body cap — a shipped grim cannot read it`);
  else if (atWarnLevel(bytes, GRIM_BODY_CAP)) warn(`all.json is ${bytes} bytes, ${percentOf(bytes, GRIM_BODY_CAP)}% of grim's ${GRIM_BODY_CAP} byte body cap`);
  if (r.entries > ENTRY_CEILING) error(`${r.entries} entries, over the ${ENTRY_CEILING} ceiling — the flat layout no longer fits one file`);
  else if (atWarnLevel(r.entries, ENTRY_CEILING)) warn(`${r.entries} entries, ${percentOf(r.entries, ENTRY_CEILING)}% of the ${ENTRY_CEILING} ceiling`);
  if (c?.enrich === "budget") warn(`enrich stopped at its ${c.budget_min} min time budget — the buckets it skipped run first next time`);
  if (c !== null && c.throttled > 0) warn(`the registry throttled ${c.throttled} call(s) (429)`);
  if (c !== null && c.budget_min < FULL_BUDGET_MIN) {
    warn(`the enrich time budget was ${c.budget_min} min, under the usual ${FULL_BUDGET_MIN} because the job timeout is short — re-render required`);
  }

  const site = r.site;
  const wire = `the search file is ${site.searchWire} bytes gzipped, past the`;
  if (site.searchWire >= SEARCH_WIRE_ERROR) error(`${wire} ${SEARCH_WIRE_ERROR} byte limit (scale trigger D) — the first search downloads all of it`);
  else if (site.searchWire >= SEARCH_WIRE_WARN) warn(`${wire} ${SEARCH_WIRE_WARN} byte early warning (scale trigger D) — the first search downloads all of it`);
  if (site.siteBytes >= SITE_BYTES_CEILING) error(`the site is ${site.siteBytes} bytes, past the ${SITE_BYTES_CEILING} byte deploy ceiling (scale trigger E)`);
  if (site.siteFiles >= SITE_FILES_CEILING) error(`the site is ${site.siteFiles} files, past the ${SITE_FILES_CEILING} file deploy ceiling (scale trigger E)`);
  for (const page of site.overCap) warn(`${page} is still over its size cap after the hard cut`);
  return out;
}

/** The line to stdout, each warning to stderr; an error-level one is still only a line. */
export function printBuild(r: BuildReport): void {
  console.log(formatBuildLine(r));
  for (const w of budgetWarnings(r)) (w.level === "error" ? console.error : console.warn)(`${w.level}: ${w.text}`);
}

/** The flat, stats and search blobs, which P-10 exempts from the state-file cap; the previous-closure stage keeps them under `retained/`. */
const P10_EXEMPT = /^(retained\/)?c\/[fq]\//;

/** The largest regular file under `<state>/out/` that P-10 counts, or `null`; a symlink is not one. */
export function largestStateFile(root: string): StateFile | null {
  const out = path.join(root, STATE_DIR, "out");
  if (!fs.existsSync(out)) return null;
  let largest: StateFile | null = null;
  for (const entry of fs.readdirSync(out, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const file = path.join(entry.parentPath, entry.name);
    if (P10_EXEMPT.test(path.relative(out, file).split(path.sep).join("/"))) continue;
    const bytes = fs.statSync(file).size;
    if (largest === null || bytes > largest.bytes) {
      largest = { path: path.relative(root, file).split(path.sep).join("/"), bytes };
    }
  }
  return largest;
}

/** Under `layout: flat` the root names no flat blob, and `legacy: true` (the only option there) keeps `all.json` and its sibling. */
function measureFlat(dist: string, root: Root): BuildReport["flat"] {
  if (root.flat !== null) {
    const blob = path.join(dist, "c", "f", "sha256", `${root.flat.sha256}.json.gz`);
    return { sha256: root.flat.sha256, bytes: root.flat.size, gzip: fs.statSync(blob).size };
  }
  const all = fs.readFileSync(path.join(dist, "all.json"));
  return {
    sha256: sha256Hex(all),
    bytes: all.length,
    gzip: fs.statSync(path.join(dist, "all.json.gz")).size,
  };
}

/** The regular files under `dist/` and their bytes; a symlink is not one. */
export function measureDist(dist: string): { bytes: number; files: number } {
  let bytes = 0;
  let files = 0;
  for (const entry of fs.readdirSync(dist, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    files += 1;
    bytes += fs.statSync(path.join(entry.parentPath, entry.name)).size;
  }
  return { bytes, files };
}

export interface BuildFacts {
  root: string;
  dist: string;
  sync: SyncConfig;
  /** What `publishDist` returned. */
  published: Root;
  /** Packages in `all.json`. */
  entries: number;
  /** What `buildSite` measured; its `search` is `published.search`. */
  site: Pick<SiteFacts, "astroMs" | "astroDirBytes" | "pages">;
}

/** Print the §5.9 line and its warnings. Runs last, so `dist/` is final; reads no network. */
export function reportBuild(facts: BuildFacts): void {
  const { published: p, site } = facts;
  const { bytes, files } = measureDist(facts.dist);
  printBuild({
    layout: facts.sync.layout,
    legacy: facts.sync.legacy,
    generation: p.generation,
    flat: measureFlat(facts.dist, p),
    stats: p.stats,
    enrichPlane: p.planes.enrich,
    entries: facts.entries,
    counters: readHandoff(facts.root)?.counters ?? null,
    largestStateFile: largestStateFile(facts.root),
    site: {
      search: p.search,
      searchWire: p.search === null ? 0 : fs.statSync(path.join(facts.dist, "c", "q", "sha256", `${p.search.sha256}.json.gz`)).size,
      siteBytes: bytes,
      siteFiles: files,
      astroMs: site.astroMs,
      astroDirBytes: site.astroDirBytes,
      pagesCut: site.pages.cut,
      pagesHardCut: site.pages.hardCut,
      overCap: site.pages.overCap,
    },
  });
}
