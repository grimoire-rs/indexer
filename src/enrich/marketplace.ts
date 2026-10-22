// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Grimoire Authors

/**
 * The marketplace the index repo itself declares: `<root>/marketplace.toml`,
 * exported by `grim export marketplace` during enrich. The site build reads
 * the result through `../marketplace/read.ts` and never touches the network.
 *
 *   `enrich/marketplace/export/`   the exported tree (C-006)
 *   `enrich/marketplace/meta.json` `{repository?, clients, members}`
 */
import fs from "node:fs";
import path from "node:path";

import { parse } from "smol-toml";

import { MARKETPLACE_CLIENTS, type MarketplaceClient } from "../config.js";
import type { MarketplaceMeta } from "../marketplace/read.js";
import type { GrimRunner } from "./index.js";

/** Where the exported tree and `meta.json` live under the index root. */
export const MARKETPLACE_DIR = path.join("enrich", "marketplace");
const EXPORT_DIR = "export";
const META_FILE = "meta.json";
const MEMBER_KINDS = ["skill", "rule", "agent", "mcp", "hook"] as const;

/** `grim export marketplace` fetches every member, so it gets far more than the shared per-call ceiling. */
export const MARKETPLACE_EXPORT_TIMEOUT_MS = 10 * 60_000;

export interface MarketplaceEnrichResult {
  /** `false` when there is no `marketplace.toml` or the export failed (previous export kept). */
  exported: boolean;
  plugins: number;
  warnings: string[];
  meta?: MarketplaceMeta;
}

const asRecord = (v: unknown): Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
const rows = (v: unknown): Record<string, unknown>[] => (Array.isArray(v) ? v.map(asRecord) : []);

function readOrNull(file: string): Buffer | null {
  try {
    return fs.readFileSync(file);
  } catch {
    return null;
  }
}

/** `repo` of `repo[:tag][@digest]`, tolerating a registry port (`host:5000/x`). */
const bareRef = (pinned: string): string =>
  pinned.replace(/@[a-z0-9]+:[0-9a-f]+$/, "").replace(/:[^/:]+$/, "");

/** Bundle provenance of a lock row: the `bundle` repo, or every `bundles[].repo`. */
function bundleRepos(row: Record<string, unknown>): string[] {
  const repos = rows(row.bundles).map((b) => b.repo);
  if (typeof row.bundle === "string") repos.push(row.bundle);
  return repos.filter((r): r is string => typeof r === "string" && r !== "");
}

/**
 * The lock's registry members per plugin. A member that came in through a
 * bundle is listed as that bundle (`kind: "bundle"`, `ref` = the repo the lock
 * records), once, and its constituents are not: the bundle is the indexed
 * package the plugin page links. Path members have no `pinned` and are dropped.
 * Keyed by null-prototype objects: plugin names are untrusted (`__proto__`).
 */
function lockMembers(lock: Buffer): MarketplaceMeta["members"] {
  const members: MarketplaceMeta["members"] = Object.create(null);
  const doc = asRecord(parse(lock.toString("utf8")));
  for (const { name } of rows(doc.plugin)) if (typeof name === "string") members[name] = [];
  const bundled = new Set<string>();
  for (const kind of MEMBER_KINDS) {
    for (const row of rows(doc[kind])) {
      const { name, plugin, pinned } = row;
      if (typeof name !== "string" || typeof plugin !== "string" || typeof pinned !== "string") continue;
      const list = (members[plugin] ??= []);
      const bundles = bundleRepos(row);
      if (bundles.length === 0) {
        list.push({ kind, name, ref: bareRef(pinned) });
        continue;
      }
      for (const repo of bundles) {
        if (bundled.has(`${plugin}\0${repo}`)) continue;
        bundled.add(`${plugin}\0${repo}`);
        list.push({ kind: "bundle", name: repo.slice(repo.lastIndexOf("/") + 1), ref: repo });
      }
    }
  }
  return members;
}

/** Distinct clients the export has files for (a removed file is gone), and the plugins it covers. */
function readReport(report: unknown): { clients: MarketplaceClient[]; plugins: number } {
  const doc = asRecord(report);
  const clients = new Set<string>();
  for (const { client, action } of rows(doc.files)) {
    if (typeof client === "string" && action !== "removed") clients.add(client);
  }
  const plugins = new Set<string>();
  for (const { plugin, action } of rows(doc.items)) {
    if (typeof plugin === "string" && action !== "removed") plugins.add(plugin);
  }
  return {
    clients: MARKETPLACE_CLIENTS.filter((c) => clients.has(c)),
    plugins: plugins.size,
  };
}

/** Run `step`, turning a throw into a warning and `fallback`. */
function degrade<T>(warnings: string[], what: string, fallback: T, step: () => T): T {
  try {
    return step();
  } catch (err) {
    warnings.push(`${what}: ${err instanceof Error ? err.message : String(err)}`);
    return fallback;
  }
}

/**
 * C-006: when `<root>/marketplace.toml` exists, run `grim export marketplace
 * --marketplace <root>/marketplace.toml -o <dir>/export.next --force` through
 * `run`, then swap `export.next` over `export/` and write `meta.json`
 * (`[marketplace].repository`, the clients the export wrote files for, and the
 * lock's members per plugin, see `lockMembers`). The previous export and meta
 * stay in place until grim has succeeded, so a crash, timeout or old `grim`
 * never leaves a half-new tree. Never throws: a failure is a warning.
 */
export async function enrichMarketplace(root: string, run: GrimRunner): Promise<MarketplaceEnrichResult> {
  const toml = path.join(root, "marketplace.toml");
  const lockFile = path.join(root, "marketplace.lock");
  if (!fs.existsSync(toml)) return { exported: false, plugins: 0, warnings: [] };

  const warnings: string[] = [];
  const kept = (why: string): MarketplaceEnrichResult => ({
    exported: false,
    plugins: 0,
    warnings: [`marketplace export failed, keeping the previous one: ${why}`],
  });
  const dir = path.join(root, MARKETPLACE_DIR);
  const next = path.join(dir, `${EXPORT_DIR}.next`);
  const prev = path.join(dir, `${EXPORT_DIR}.prev`);
  const metaNext = path.join(dir, `${META_FILE}.next`);

  let declared: Record<string, unknown>;
  try {
    declared = asRecord(asRecord(parse(fs.readFileSync(toml, "utf8"))).marketplace);
  } catch (err) {
    return kept(`marketplace.toml: ${err instanceof Error ? err.message : String(err)}`);
  }

  const lockBefore = readOrNull(lockFile);
  try {
    fs.mkdirSync(dir, { recursive: true });
    // A run killed between the two swap renames leaves only `.prev`; put it back before anything else.
    if (!fs.existsSync(path.join(dir, EXPORT_DIR)) && fs.existsSync(prev)) fs.renameSync(prev, path.join(dir, EXPORT_DIR));
    fs.rmSync(next, { recursive: true, force: true });
    const report = await run(["export", "marketplace", "--marketplace", toml, "-o", next, "--force"], {
      timeoutMs: MARKETPLACE_EXPORT_TIMEOUT_MS,
    });

    const lockAfter = readOrNull(lockFile);
    if (!(lockBefore === null ? lockAfter === null : lockAfter !== null && lockBefore.equals(lockAfter))) {
      warnings.push("marketplace.lock was stale; run grim update --marketplace and commit it");
    }

    // grim succeeded, so a parse failure from here degrades the metadata and never discards the export.
    const { clients, plugins } = degrade(warnings, "marketplace export report unreadable", { clients: [], plugins: 0 }, () =>
      readReport(report),
    );
    const members = degrade(warnings, "marketplace.lock unreadable, no plugin contents", Object.create(null), () =>
      lockAfter ? lockMembers(lockAfter) : Object.create(null),
    );
    const meta: MarketplaceMeta = {
      ...(typeof declared.repository === "string" ? { repository: declared.repository } : {}),
      clients,
      members,
    };

    // Everything that can fail is done; the two renames are the whole swap.
    fs.writeFileSync(metaNext, JSON.stringify(meta, null, 1) + "\n");
    fs.rmSync(prev, { recursive: true, force: true });
    const hadExport = fs.existsSync(path.join(dir, EXPORT_DIR));
    if (hadExport) fs.renameSync(path.join(dir, EXPORT_DIR), prev);
    try {
      fs.renameSync(next, path.join(dir, EXPORT_DIR));
      fs.renameSync(metaNext, path.join(dir, META_FILE));
    } catch (err) {
      fs.rmSync(path.join(dir, EXPORT_DIR), { recursive: true, force: true });
      if (hadExport) fs.renameSync(prev, path.join(dir, EXPORT_DIR));
      throw err;
    }
    fs.rmSync(prev, { recursive: true, force: true });
    return { exported: true, plugins, warnings, meta };
  } catch (err) {
    fs.rmSync(next, { recursive: true, force: true });
    fs.rmSync(metaNext, { force: true });
    return kept(err instanceof Error ? err.message : String(err));
  }
}

// ---- checkpoint bridge ----------------------------------------------------

/** What the enrich plane carries for the marketplace: every file of the local tree, base64, by relative path. */
export interface MarketplaceCheckpoint {
  files: Record<string, string>;
}

/** Most files a checkpoint will restore; an export tree is a few hundred. */
const MAX_FILES = 5000;

/** `meta.json` or a file under `export/`, as a normal relative path; nothing else is ever written back. */
function safeRel(rel: string): boolean {
  // A backslash is a separator on Windows (`a\..\..\x`), a trailing slash names a directory, `:` a drive or stream.
  if (/[\\\0:]/.test(rel) || rel.endsWith("/")) return false;
  const normal = path.posix.normalize(rel);
  return normal === rel && (rel === META_FILE || (rel.startsWith(`${EXPORT_DIR}/`) && !rel.split("/").includes("..")));
}

/** The local tree as one checkpoint member, or null when there is no `meta.json`. */
export function packMarketplace(dir: string): MarketplaceCheckpoint | null {
  if (!fs.existsSync(path.join(dir, META_FILE))) return null;
  const files: Record<string, string> = {};
  for (const entry of fs.readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const rel = path.relative(dir, path.join(entry.parentPath, entry.name)).split(path.sep).join("/");
    if (safeRel(rel)) files[rel] = fs.readFileSync(path.join(dir, rel)).toString("base64");
  }
  return { files };
}

/**
 * Restore the tree from a checkpoint member, and say whether it did. Never
 * throws, never overwrites an existing `meta.json` (the checkpoint fills gaps), writes only
 * `meta.json` and files under `export/`, and writes `meta.json` last so a
 * partial restore is not mistaken for a whole one.
 */
export function seedMarketplace(dir: string, member: unknown): boolean {
  if (fs.existsSync(path.join(dir, META_FILE))) return false;
  const given = asRecord(asRecord(member).files);
  const rels = Object.keys(given).filter((rel) => safeRel(rel) && typeof given[rel] === "string");
  if (!rels.includes(META_FILE) || rels.length > MAX_FILES) return false;
  try {
    for (const rel of rels.sort((a, b) => Number(a === META_FILE) - Number(b === META_FILE))) {
      const file = path.join(dir, rel);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, Buffer.from(given[rel] as string, "base64"));
    }
  } catch {
    // A clashing entry (`export/a` file and `export/a/b`): drop the partial tree; meta.json is written last, so none is live.
    fs.rmSync(path.join(dir, EXPORT_DIR), { recursive: true, force: true });
    return false;
  }
  return true;
}
