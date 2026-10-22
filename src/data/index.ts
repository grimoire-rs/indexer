// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Grimoire Authors

// Compiles index/**/metadata.json into a static dist/ tree. TS port of the
// former scripts/build.py (single implementation now — see
// site/src/lib/catalog.ts, which duplicated this same derivation).
import fs from "node:fs";
import path from "node:path";

import { boundRecord } from "../emit/records.js";
import { MAX_LOGO_BYTES, PACKAGE_LOGOS, logoExtType, logoOk } from "../logo.js";
import { readRegular } from "../marketplace/read.js";

const KINDS = new Set(["skill", "rule", "agent", "mcp", "bundle", "hook"]);
const REQUIRED = ["schema", "name", "kind", "ref", "description", "owner"] as const;

export type PackageKind = "skill" | "rule" | "agent" | "mcp" | "bundle" | "hook";

export interface IndexOwner {
  id: number;
  github?: string;
  login?: string;
}

/**
 * One compiled package record — the frozen public shape of each entry in
 * `dist/all.json`. Index metadata plus (when present) the merged enrichment
 * sidecar; index metadata always wins on key overlap. `[key: string]:
 * unknown` carries enrichment fields (title, summary, version, license,
 * keywords, tags, logo, hasReadme, hasChangelog, …) grim's read side never
 * relies on a closed field set here (additive schema evolution).
 */
export interface IndexRecord {
  [key: string]: unknown;
  schema: 1;
  name: string;
  kind: PackageKind;
  ref: string;
  description: string;
  owner: IndexOwner;
  namespace: string;
}

export interface CompileOptions {
  /** Index repo root (holds `index/` and `enrich/`). Never derived from `__dirname`/`cwd`. */
  root: string;
  /** Directory to write `all.json`, `index/`, and `logos/` into. */
  outDir: string;
}

export interface CompileResult {
  count: number;
  namespaces: string[];
}

/** Thrown for malformed `metadata.json` entries — a data problem, not a bug. */
export class IndexValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IndexValidationError";
  }
}

function shownPath(root: string, file: string): string {
  const rel = path.relative(root, file);
  return rel.startsWith("..") ? file : rel;
}

function fail(root: string, file: string, msg: string): never {
  throw new IndexValidationError(`${shownPath(root, file)}: ${msg}`);
}

function validate(root: string, file: string, meta: Record<string, unknown>): void {
  const missing = REQUIRED.filter((key) => !(key in meta));
  if (missing.length > 0) {
    fail(root, file, `missing keys: ${missing.join(", ")}`);
  }
  if (meta.schema !== 1) {
    fail(root, file, `unsupported schema version ${JSON.stringify(meta.schema)}`);
  }
  if (typeof meta.kind !== "string" || !KINDS.has(meta.kind)) {
    fail(root, file, `kind must be one of ${[...KINDS].sort().join(", ")}`);
  }
  const dirName = path.basename(path.dirname(file));
  if (meta.name !== dirName) {
    fail(root, file, `name ${JSON.stringify(meta.name)} != directory ${JSON.stringify(dirName)}`);
  }
  const owner = meta.owner;
  const ownerValid =
    typeof owner === "object" &&
    owner !== null &&
    !Array.isArray(owner) &&
    "id" in owner &&
    ("github" in owner || "login" in owner);
  if (!ownerValid) {
    fail(root, file, `owner must be an object with 'id' and 'github' or 'login'`);
  }
}

export function findMetadataFiles(indexDir: string): string[] {
  if (!fs.existsSync(indexDir)) return [];
  const entries = fs.readdirSync(indexDir, { recursive: true, withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    if (entry.isFile() && entry.name === "metadata.json") {
      files.push(path.join(entry.parentPath, entry.name));
    }
  }
  return files.sort();
}

/**
 * Namespace of a `metadata.json`, derived from its path under `index/` —
 * `index/github.com/acme/foo/metadata.json` -> `github.com/acme`. The single
 * definition: `enrich` writes sidecars keyed on it and the compiler reads them
 * back, so a second derivation is a silent mismatch waiting to happen.
 */
export function namespaceOf(indexDir: string, file: string): string {
  return path
    .relative(indexDir, path.dirname(path.dirname(file)))
    .split(path.sep)
    .join("/");
}

/**
 * The `logo` a record may publish, and the file to publish it from.
 *
 * `declared` is untrusted: the sidecar came off a registry or a checkpoint, and
 * index metadata, which wins over the sidecar, is a contributor's. The result
 * is therefore never the declared string but the canonical path of a file that
 * passed `logoOk`, or null. A declared logo whose file was never shipped keeps
 * its canonical path, the "declared but not shipped" state the cards render as a
 * placeholder; any other path for it is null.
 */
export function vetLogo(
  declared: unknown,
  sidecarDir: string,
  ns: string,
  name: string,
): { logo: string | null; file?: { rel: string; src: string; ext: string } } {
  if (typeof declared !== "string") return { logo: null };
  const ext = declared.split(".").pop() ?? "";
  if (logoExtType(ext, PACKAGE_LOGOS) === null) return { logo: null };

  const rel = `${ns}/${name}.${ext}`;
  const src = path.join(sidecarDir, `logo.${ext}`);
  const read = readRegular(src, MAX_LOGO_BYTES);
  if ("why" in read) {
    if (read.why === "missing") return { logo: declared === `/logos/${rel}` ? declared : null };
    console.warn(`warn: ${ns}/${name}: dropped its logo (${read.why})`);
    return { logo: null };
  }
  if (!logoOk(ext, read.bytes, PACKAGE_LOGOS)) {
    console.warn(`warn: ${ns}/${name}: dropped its logo (not a ${ext} image)`);
    return { logo: null };
  }
  // The path, not the bytes: they are read and checked again when written, so a
  // build over the 20,000-entry design point never holds every logo at once.
  return { logo: `/logos/${rel}`, file: { rel, src, ext } };
}

/**
 * Removes each sidecar `logo.*` that is not an allowed image. Nothing
 * publishes one any more, but a stale file stays in the tree the site and
 * the checkpoint are built from, and `enrich` clears it only on a re-run.
 */
function sweepLogos(dir: string, id: string): void {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir)) {
    if (!entry.toLowerCase().startsWith("logo.")) continue;
    const file = path.join(dir, entry);
    const read = readRegular(file, MAX_LOGO_BYTES);
    if ("bytes" in read && logoOk(path.extname(entry).slice(1), read.bytes, PACKAGE_LOGOS)) continue;
    fs.rmSync(file, { recursive: true, force: true });
    console.warn(`warn: ${id}: removed sidecar ${entry} (not an allowed image)`);
  }
}

export async function compileIndex(opts: CompileOptions): Promise<CompileResult> {
  const { root, outDir } = opts;
  const indexDir = path.join(root, "index");
  const enrichDir = path.join(root, "enrich");

  const packages: IndexRecord[] = [];
  const logos: Array<{ rel: string; src: string; ext: string }> = [];

  for (const file of findMetadataFiles(indexDir)) {
    const meta = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
    validate(root, file, meta);

    const ns = namespaceOf(indexDir, file);
    const withNamespace: Record<string, unknown> = { ...meta, namespace: ns };

    const dataPath = path.join(enrichDir, ns, meta.name as string, "data.json");
    let record: Record<string, unknown> = withNamespace;
    if (fs.existsSync(dataPath)) {
      const sidecar = JSON.parse(fs.readFileSync(dataPath, "utf8")) as Record<string, unknown>;
      // internal change-probe / slice bookkeeping — never ship
      const { descDigest: _descDigest, describedAt: _describedAt, ...enrich } = sidecar;
      record = { ...enrich, ...withNamespace }; // index metadata wins on overlap
    }

    if (record.logo !== undefined && record.logo !== null) {
      const vetted = vetLogo(record.logo, path.dirname(dataPath), ns, meta.name as string);
      record.logo = vetted.logo;
      if (vetted.file) logos.push(vetted.file);
    }

    packages.push(boundRecord(record) as IndexRecord);
  }

  // Every sidecar, a de-indexed package's too: the site's content glob reads all of `enrich/`.
  if (fs.existsSync(enrichDir)) {
    for (const rel of fs.readdirSync(enrichDir, { recursive: true, encoding: "utf8" })) {
      if (path.basename(rel) !== "data.json" || rel.split(path.sep)[0] === "marketplace") continue;
      sweepLogos(path.join(enrichDir, path.dirname(rel)), path.dirname(rel).split(path.sep).join("/"));
    }
  }

  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });
  // A marketplace-only repo has no `index/`.
  if (fs.existsSync(indexDir)) fs.cpSync(indexDir, path.join(outDir, "index"), { recursive: true });
  fs.writeFileSync(path.join(outDir, "all.json"), JSON.stringify(packages, null, 1) + "\n");
  for (const { rel, src, ext } of logos) {
    // Read and checked in one step: what is published is the bytes that pass here.
    const read = readRegular(src, MAX_LOGO_BYTES);
    if ("why" in read || !logoOk(ext, read.bytes, PACKAGE_LOGOS)) {
      throw new Error(`${rel}: logo changed after it was checked`);
    }
    const dst = path.join(outDir, "logos", rel);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.writeFileSync(dst, read.bytes);
  }

  const namespaces = [...new Set(packages.map((p) => p.namespace))].sort();
  return { count: packages.length, namespaces };
}
