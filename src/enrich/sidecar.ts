// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Grimoire Authors

/**
 * What a sidecar directory may hold, and how a restored one is made to agree
 * with itself. Shared by the plane restore (`../state/restore.ts`) and the
 * plane collector (`../state/entries.ts`), so the allow-list has one home.
 */
import fs from "node:fs";
import path from "node:path";

import { serializeDeterministic } from "../emit/serialize.js";
import { PACKAGE_LOGOS, logoExtType, logoOk } from "../logo.js";
import type { KeyOrder } from "../state/plane.js";

/**
 * The curated fields copied straight across from `describe`, in the order
 * they are written to disk. Every one is optional on the wire: a grim older
 * than the annotation work reports the first five and nothing after them,
 * and `compatibility` is null for every kind but a skill. Absent is absent —
 * no placeholder is written for a field the registry did not report.
 */
export const META_KEYS = [
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
 * changes over time. No digest sees an edit to one, so only a rotation's deep
 * enrich picks it up: within seven windows, never later.
 */
export const SUPPORT_CHANNELS = ["issues", "chat", "contact", "security"];

/** Every key `enrich` writes into `data.json`, in the order it writes them. */
const SIDECAR_KEYS = [...META_KEYS, "support", "keywords", "tags", "deprecated", "replacedBy", "hasReadme", "hasChangelog", "logo", "contentDigest", "hasContents", "updated"];

const inOrder = (o: Record<string, unknown>, order: readonly string[]): Record<string, unknown> => {
  const rank = (key: string): number => {
    const at = order.indexOf(key);
    return at < 0 ? order.length : at;
  };
  // A stable sort: a key `enrich` does not write keeps its place after the others.
  return Object.fromEntries(Object.entries(o).sort(([a], [b]) => rank(a) - rank(b)));
};

/**
 * `data` with its keys, and a `support` block's channels, in the order `enrich`
 * writes them. The plane stores every object byte-sorted, and a sidecar's key
 * order is its record's in `all.json`, so a restored sidecar needs it back to
 * publish the bytes the fresh one did. `order` is the entry's carried order
 * (`keyOrderIfNeeded`): it ranks every key it names, and the rest follow in
 * `enrich`'s order.
 */
export function inSidecarOrder(data: Record<string, unknown>, order?: KeyOrder): Record<string, unknown> {
  const out = inOrder(data, SIDECAR_KEYS);
  const { support } = out;
  if (support !== null && typeof support === "object" && !Array.isArray(support)) out.support = inOrder(support as Record<string, unknown>, SUPPORT_CHANNELS);
  return order === undefined ? out : (reorder(out, order) as Record<string, unknown>);
}

/** `v` with every object's keys in `node`'s order; a key it does not name follows, and nothing is ever added. */
function reorder(v: unknown, node: KeyOrder | null | undefined): unknown {
  if (node === null || node === undefined || typeof v !== "object" || v === null) return v;
  if (Array.isArray(v)) return v.map((item, i) => reorder(item, node.c?.[i]));
  const keys = node.k ?? [];
  const at = new Map(keys.map((key, i) => [key, i]));
  const rank = (key: string): number => at.get(key) ?? keys.length;
  const sorted = Object.entries(v).sort(([a], [b]) => rank(a) - rank(b));
  return Object.fromEntries(sorted.map(([key, child]) => [key, reorder(child, node.c?.[at.get(key) ?? -1])]));
}

function orderOf(v: unknown): KeyOrder | undefined {
  if (typeof v !== "object" || v === null) return undefined;
  const c = (Array.isArray(v) ? v : Object.values(v)).map((child: unknown) => orderOf(child) ?? null);
  const nested = c.some((n) => n !== null);
  if (Array.isArray(v)) return nested ? { c } : undefined;
  return { k: Object.keys(v), ...(nested ? { c } : {}) };
}

/**
 * The order `data` must carry through the plane, or `undefined` when
 * `inSidecarOrder` already restores it from the shard's sorted copy, which is
 * every sidecar `enrich` writes: carrying it for those would grow every shard.
 */
export function keyOrderIfNeeded(data: Record<string, unknown>): KeyOrder | undefined {
  const restored = inSidecarOrder(JSON.parse(serializeDeterministic(data)) as Record<string, unknown>);
  return JSON.stringify(restored) === JSON.stringify(data) ? undefined : orderOf(data);
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

/** Both spellings, so a kind that changes shape upstream cannot leave the old one behind. */
export function clearContents(dir: string): void {
  for (const name of ["contents.md", "contents.json"]) {
    fs.rmSync(path.join(dir, name), { force: true });
  }
}

/** A package's sidecar emptied: no `data.json`, no companion, no contents. What the offline build then reads is a bare pointer. */
export function clearSidecar(dir: string): void {
  fs.rmSync(path.join(dir, "data.json"), { force: true });
  clearCompanions(dir);
  clearContents(dir);
}

/**
 * Every sidecar file a restore carries, and the only names it will write. The
 * set is the one `clearCompanions` and `clearContents` already enforce; a logo
 * is handled separately because its extension varies.
 */
export const COMPANION_FILES = ["readme.md", "changelog.md", "contents.md", "contents.json"];

/**
 * `<enrichDir>/<namespace>/<name>`, or `null` when `name` is not a single path
 * segment. `name` is read out of a `metadata.json`, and the plane restore and the
 * hand-off both read and write under the result: a `../` name would aim them
 * outside `enrich/`.
 */
export function sidecarDir(enrichDir: string, namespace: string, name: string): string | null {
  if (name === "" || name === "." || name === ".." || /[\\/]/.test(name)) return null;
  return path.join(enrichDir, namespace, name);
}

/**
 * The `logo.<ext>` in a sidecar directory, if there is exactly one whose
 * extension is acceptable.
 *
 * "Exactly one" is load-bearing on the read side: two logos mean the directory
 * disagrees with itself about which one `data.logo` names, and a record that
 * cannot say which file it meant has not earned the digest that would stop the
 * companion being re-fetched.
 */
export function soleLogo(dir: string): string | undefined {
  if (!fs.existsSync(dir)) return undefined;
  const found = fs
    .readdirSync(dir)
    .filter((entry) => entry.toLowerCase().startsWith("logo."))
    .filter((entry) => logoExtType(entry.slice(entry.indexOf(".") + 1), PACKAGE_LOGOS) !== null);
  return found.length === 1 ? found[0] : undefined;
}

/** The site build parses `contents.json`; ingest refuses a file that is not JSON, so a restore must too. */
function parses(bytes: Buffer): boolean {
  try {
    JSON.parse(bytes.toString("utf8"));
    return true;
  } catch {
    return false;
  }
}

/**
 * Write one package's files, and return the names that actually landed.
 *
 * Filenames are chosen from [`COMPANION_FILES`] and `logo.<ext>` for an
 * extension [`logoOk`] accepts together with the bytes — never echoed from the
 * cache — and the directory comes from the index's own tree, so no part of a
 * path here is attacker-controlled. A logo that fails is not written, so
 * `reconcile` sees no logo and drops the record's claim to one.
 */
export function writeSidecarFiles(dir: string, files: ReadonlyMap<string, Buffer>): Set<string> {
  const written = new Set<string>();
  fs.mkdirSync(dir, { recursive: true });
  clearCompanions(dir);
  clearContents(dir);

  for (const [name, bytes] of files) {
    const low = name.toLowerCase();
    const logo = low.startsWith("logo.") && logoOk(low.slice(low.indexOf(".") + 1), bytes, PACKAGE_LOGOS);
    if (!COMPANION_FILES.includes(low) && !logo) continue;
    if (low === "contents.json" && !parses(bytes)) continue;
    fs.writeFileSync(path.join(dir, low), bytes);
    written.add(low);
  }
  return written;
}

/**
 * Bring a restored `data.json` back into agreement with what is on disk, and
 * drop the digest that guards anything it got wrong.
 *
 * Recomputing the flags alone is not enough, and this is the case worth
 * catching: a record that claims `hasReadme: true`, has no `readme.md` and
 * carries a `descDigest` that still matches upstream would leave the site
 * *self-consistent* — no README, no flag saying there is one — while
 * `enrichOne`'s digest comparison keeps skipping the download. The README
 * would never come back until the artifact happened to move on its own.
 *
 * Dropping the digest costs nothing and needs no new machinery: an absent
 * `descDigest` makes the probe comparison false and takes the download branch,
 * and an absent `contentDigest` makes `moved` true, re-stamping `updated` —
 * which is right, because an entry that misdescribed its own files has not
 * earned trust in its date either. A healthy package pays nothing.
 */
export function reconcile(
  data: Record<string, unknown>,
  dir: string,
  namespace: string,
  name: string,
  written: Set<string>,
): void {
  const logoFile = soleLogo(dir);
  const logo = logoFile ? `/logos/${namespace}/${name}.${logoFile.slice(logoFile.indexOf(".") + 1)}` : undefined;
  const actual = {
    hasReadme: written.has("readme.md"),
    hasChangelog: written.has("changelog.md"),
    hasContents: written.has("contents.md") || written.has("contents.json"),
  };

  // `=== true` rather than a bare compare: an absent flag means "no such file",
  // which is the same claim as `false`. Treating absence as a disagreement
  // would drop a perfectly good digest on every sidecar written before a flag
  // existed, and re-download the file it was still guarding.
  const companionLied =
    (data.hasReadme === true) !== actual.hasReadme ||
    (data.hasChangelog === true) !== actual.hasChangelog ||
    (data.logo ?? undefined) !== logo;
  const contentsLied = (data.hasContents === true) !== actual.hasContents;

  data.hasReadme = actual.hasReadme;
  data.hasChangelog = actual.hasChangelog;
  data.hasContents = actual.hasContents;
  if (logo) data.logo = logo;
  else delete data.logo;

  if (companionLied) delete data.descDigest;
  if (contentsLied) delete data.contentDigest;
}
