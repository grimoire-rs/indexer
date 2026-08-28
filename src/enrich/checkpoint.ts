// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Grimoire Authors

/**
 * The enrichment checkpoint — `enrich.json`, published beside `all.json` and
 * read back by `grim-indexer enrich --seed`.
 *
 * `enrich` skips work by digest, and every one of those comparisons reads
 * `enrich/<ns>/<name>/data.json` off disk. The scaffolded CI never has that
 * file: the sidecars live only in the deploy job's workspace and are committed
 * nowhere, so every deploy re-downloaded every README, changelog, logo and
 * contents payload, and — worse — re-stamped `updated` on every artifact that
 * carries no `created` of its own.
 *
 * So the live site is the checkpoint, exactly as it already is for ratings
 * (`../ratings/seed.ts`): the build publishes the sidecar tree, and the next
 * run seeds itself from what it published last time. `site` in
 * `index.config.json` is the same validated base URL both read.
 *
 * **This document is not a read contract.** Unlike `stats.json`, nothing
 * outside this package reads it and nothing should code against it.
 *
 * Failure is never fatal here. An unreachable, oversized, unparseable or
 * unrecognised checkpoint warns and seeds nothing, which degrades to exactly
 * the behaviour that shipped before it existed — a full re-enrich. `loadSeed`
 * takes the opposite line because an empty ratings seed *wipes* every
 * published rating; a missing enrich seed only costs bandwidth.
 */
import fs from "node:fs";
import path from "node:path";

// The cycle is deliberate and benign, the same shape `ratings/provider.ts`
// documents: `compileIndex` writes the checkpoint, and the seed reads the
// index tree back to decide what it is allowed to hydrate. Everything crossing
// is a hoisted function declaration, referenced only from inside a closure.
import { findMetadataFiles, namespaceOf } from "../data/index.js";
import { LOGO_EXT, clearCompanions, clearContents } from "./index.js";
import { LARGE_RESPONSE_BYTES, request } from "../validate/adapters/http.js";

/** Published name, and the path `--seed` appends to `site`. */
export const CHECKPOINT_FILE = "enrich.json";

/**
 * The document version.
 *
 * Worth carrying even though nothing outside this package reads it: the reader
 * is always a *different build of this package than the writer* — last week's
 * deploy wrote the file this week's run seeds from — so a format change really
 * does cross a version boundary. An unrecognised version seeds nothing rather
 * than guessing.
 */
export const SCHEMA_VERSION = 1;

/**
 * Every sidecar file the checkpoint carries, and the only names hydration will
 * write. The set is the one `clearCompanions` and `clearContents` already
 * enforce; a logo is handled separately because its extension comes from the
 * registry.
 */
const COMPANION_FILES = ["readme.md", "changelog.md", "contents.md", "contents.json"];

/** One package's checkpoint entry: its sidecar, and the bytes behind it. */
interface CheckpointPackage {
  /** `data.json` verbatim. */
  data: Record<string, unknown>;
  /** Filename -> base64. Omitted when the package has no companion files. */
  files?: Record<string, string>;
}

interface CheckpointDocument {
  schema_version: number;
  /** Keyed `"<namespace>/<name>"`, the same id the content collections use. */
  packages: Record<string, CheckpointPackage>;
}

/** What `compileIndex` hands over — it has already walked the tree. */
export interface CheckpointEntry {
  namespace: string;
  name: string;
  /** `enrich/<namespace>/<name>`, which holds `data.json` and its companions. */
  dir: string;
}

/**
 * The `logo.<ext>` in a sidecar directory, if there is exactly one whose
 * extension is acceptable.
 *
 * "Exactly one" is load-bearing on the read side: two logos mean the directory
 * disagrees with itself about which one `data.logo` names, and a checkpoint
 * that cannot say which file it meant has not earned the digest that would
 * stop the companion being re-fetched.
 */
function soleLogo(dir: string): string | undefined {
  if (!fs.existsSync(dir)) return undefined;
  const found = fs
    .readdirSync(dir)
    .filter((entry) => entry.toLowerCase().startsWith("logo."))
    .filter((entry) => LOGO_EXT.test(entry.slice(entry.indexOf(".") + 1)));
  return found.length === 1 ? found[0] : undefined;
}

/**
 * Publish the sidecar tree as one document.
 *
 * Called from `compileIndex`, which has already resolved every namespace and
 * sidecar directory — re-walking the tree here would be a second derivation of
 * the same answer.
 *
 * Base64 for every member, markdown included. `decode()` in `./index.ts`
 * already treats a companion member as arbitrary bytes off a registry, so
 * inlining the markdown as UTF-8 would save a fifth of the file in exchange
 * for a validity branch on data that is not guaranteed to be text.
 */
export function packCheckpoint(outDir: string, entries: readonly CheckpointEntry[]): void {
  const packages: Record<string, CheckpointPackage> = {};

  for (const { namespace, name, dir } of entries) {
    const dataFile = path.join(dir, "data.json");
    if (!fs.existsSync(dataFile)) continue;

    let data: Record<string, unknown>;
    try {
      data = JSON.parse(fs.readFileSync(dataFile, "utf8")) as Record<string, unknown>;
    } catch {
      // A sidecar this build could not read is a sidecar the next run should
      // fetch again, not one to publish half of.
      continue;
    }

    const files: Record<string, string> = {};
    for (const member of COMPANION_FILES) {
      const file = path.join(dir, member);
      if (fs.existsSync(file)) files[member] = fs.readFileSync(file).toString("base64");
    }
    const logo = soleLogo(dir);
    if (logo) files[logo.toLowerCase()] = fs.readFileSync(path.join(dir, logo)).toString("base64");

    const entry: CheckpointPackage = { data };
    if (Object.keys(files).length > 0) entry.files = files;
    packages[`${namespace}/${name}`] = entry;
  }

  // Nothing enriched yet. An absent document and an empty one behave
  // identically to the reader, and not writing keeps `dist/` honest about
  // what this build actually had.
  if (Object.keys(packages).length === 0) return;

  const document: CheckpointDocument = { schema_version: SCHEMA_VERSION, packages };
  const body = JSON.stringify(document) + "\n";
  if (Buffer.byteLength(body) > LARGE_RESPONSE_BYTES) {
    // Silence here would be a permanent, invisible regression: the file
    // publishes fine and every future `--seed` refuses to read it, so the
    // index quietly goes back to re-downloading everything for ever.
    console.warn(
      `warn: ${CHECKPOINT_FILE} is larger than the ${LARGE_RESPONSE_BYTES} byte cap \`enrich --seed\` reads — ` +
        `it will be published but not read back`,
    );
  }
  fs.writeFileSync(path.join(outDir, CHECKPOINT_FILE), body);
}

export interface SeedOptions {
  /** Index repo root — holds `index/`, gains `enrich/`. */
  root: string;
  /** Full URL of the published checkpoint, `<site>/enrich.json`. */
  url: string;
}

/** A parsed document, or `null` with the reason already reported. */
async function loadCheckpoint(url: string): Promise<CheckpointDocument | null> {
  const response = await request(url, {}, { maxBytes: LARGE_RESPONSE_BYTES });

  if (response.status === 404) {
    // The first deploy, and the ordinary case for a young index.
    console.log(`no ${CHECKPOINT_FILE} published yet — enriching everything`);
    return null;
  }
  if (response.status < 200 || response.status >= 300) {
    // `status: 0` lands here too: it is the transport catch and the over-cap
    // read. So does a 3xx — `request()` refuses to follow redirects, so a site
    // whose canonical host redirects pays for the checkpoint on every deploy.
    // Deliberately not guarded with a cross-check against the forge's own
    // Pages URL the way the ratings seed is: a wrong ratings seed empties
    // every published rating, where a missed enrich seed only re-downloads.
    console.warn(`warn: could not read ${url} (HTTP ${response.status}) — enriching everything`);
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(response.body) as unknown;
  } catch (err) {
    console.warn(`warn: ${url} did not parse (${(err as Error).message}) — enriching everything`);
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    console.warn(`warn: ${url} is not a JSON object — enriching everything`);
    return null;
  }

  const doc = parsed as Record<string, unknown>;
  if (doc.schema_version !== SCHEMA_VERSION) {
    console.warn(
      `warn: ${url} declares schema_version ${JSON.stringify(doc.schema_version)}, ` +
        `this build reads ${SCHEMA_VERSION} — enriching everything`,
    );
    return null;
  }
  const packages = doc.packages;
  if (packages === null || typeof packages !== "object" || Array.isArray(packages)) {
    console.warn(`warn: ${url} carries no packages object — enriching everything`);
    return null;
  }

  return { schema_version: SCHEMA_VERSION, packages: packages as Record<string, CheckpointPackage> };
}

/**
 * Write one package's files, and return the names that actually landed.
 *
 * Filenames are chosen from [`COMPANION_FILES`] and `logo.<ext>` gated on
 * [`LOGO_EXT`] — never echoed from the document — and the directory comes from
 * the index's own tree, so no part of a path here is attacker-controlled.
 */
function hydrateFiles(dir: string, files: Record<string, unknown>): Set<string> {
  const written = new Set<string>();
  fs.mkdirSync(dir, { recursive: true });
  clearCompanions(dir);
  clearContents(dir);

  for (const [name, content] of Object.entries(files)) {
    if (typeof content !== "string") continue;
    const low = name.toLowerCase();
    const logo = low.startsWith("logo.") && LOGO_EXT.test(low.slice(low.indexOf(".") + 1));
    if (!COMPANION_FILES.includes(low) && !logo) continue;
    fs.writeFileSync(path.join(dir, low), Buffer.from(content, "base64"));
    written.add(low);
  }
  return written;
}

/**
 * Bring a hydrated `data.json` back into agreement with what is on disk, and
 * drop the digest that guards anything it got wrong.
 *
 * Recomputing the flags alone is not enough, and this is the case worth
 * catching: a document that claims `hasReadme: true`, carries no `readme.md`
 * and carries a `descDigest` that still matches upstream would leave the site
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
function reconcile(
  data: Record<string, unknown>,
  dir: string,
  namespace: string,
  name: string,
  written: Set<string>,
): void {
  const logoFile = soleLogo(dir);
  const logo = logoFile
    ? `/logos/${namespace}/${name}.${logoFile.slice(logoFile.indexOf(".") + 1)}`
    : undefined;
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

/**
 * Restore `enrich/` from the published checkpoint, and report how many
 * packages it seeded.
 *
 * Never throws. Every failure path warns and returns 0, which leaves the run
 * doing exactly what it did before this existed.
 *
 * The iteration is over the **index**, never the document's keys: a package
 * the index does not list is not seeded at all, so a key naming a path outside
 * the tree describes a package that is simply never looked up. A sidecar that
 * already exists on disk always wins — the checkpoint fills gaps, it does not
 * overwrite a committed or freshly-enriched tree.
 */
export async function seedFromCheckpoint(opts: SeedOptions): Promise<number> {
  const indexDir = path.join(opts.root, "index");
  const enrichDir = path.join(opts.root, "enrich");

  const document = await loadCheckpoint(opts.url);
  if (!document) return 0;

  let seeded = 0;
  for (const file of findMetadataFiles(indexDir)) {
    let name: string;
    try {
      ({ name } = JSON.parse(fs.readFileSync(file, "utf8")) as { name: string });
    } catch {
      continue; // `compileIndex` reports a malformed entry properly; not this.
    }
    if (typeof name !== "string" || name === "") continue;

    const namespace = namespaceOf(indexDir, file);
    const dir = path.join(enrichDir, namespace, name);
    if (fs.existsSync(path.join(dir, "data.json"))) continue;

    const entry = document.packages[`${namespace}/${name}`] as CheckpointPackage | undefined;
    if (entry === undefined) continue;
    const data: unknown = entry.data;
    if (data === null || typeof data !== "object" || Array.isArray(data)) continue;

    const files: unknown = entry.files;
    const record = data as Record<string, unknown>;
    const written = hydrateFiles(
      dir,
      files !== null && typeof files === "object" && !Array.isArray(files)
        ? (files as Record<string, unknown>)
        : {},
    );
    reconcile(record, dir, namespace, name, written);
    fs.writeFileSync(path.join(dir, "data.json"), JSON.stringify(record, null, 1) + "\n");
    seeded += 1;
  }

  return seeded;
}
