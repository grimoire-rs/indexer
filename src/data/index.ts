// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Grimoire Authors

// Compiles index/**/metadata.json into a static dist/ tree. TS port of the
// former scripts/build.py (single implementation now — see
// site/src/lib/catalog.ts, which duplicated this same derivation).
import fs from "node:fs";
import path from "node:path";

const KINDS = new Set(["skill", "rule", "agent", "mcp", "bundle"]);
const REQUIRED = ["schema", "name", "kind", "ref", "description", "owner"] as const;

export type PackageKind = "skill" | "rule" | "agent" | "mcp" | "bundle";

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

export async function compileIndex(opts: CompileOptions): Promise<CompileResult> {
  const { root, outDir } = opts;
  const indexDir = path.join(root, "index");
  const enrichDir = path.join(root, "enrich");

  const packages: IndexRecord[] = [];
  const logos: Array<{ src: string; rel: string }> = [];

  for (const file of findMetadataFiles(indexDir)) {
    const meta = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
    validate(root, file, meta);

    const ns = namespaceOf(indexDir, file);
    const withNamespace: Record<string, unknown> = { ...meta, namespace: ns };

    const dataPath = path.join(enrichDir, ns, meta.name as string, "data.json");
    let record: Record<string, unknown> = withNamespace;
    if (fs.existsSync(dataPath)) {
      const sidecar = JSON.parse(fs.readFileSync(dataPath, "utf8")) as Record<string, unknown>;
      const { descDigest: _descDigest, ...enrich } = sidecar; // internal change-probe bookkeeping — never ship
      record = { ...enrich, ...withNamespace }; // index metadata wins on overlap
    }

    if (typeof record.logo === "string") {
      const ext = record.logo.split(".").pop() ?? "";
      const src = path.join(path.dirname(dataPath), `logo.${ext}`);
      if (fs.existsSync(src)) {
        logos.push({ src, rel: `${ns}/${record.name as string}.${ext}` });
      }
    }

    packages.push(record as IndexRecord);
  }

  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });
  fs.cpSync(indexDir, path.join(outDir, "index"), { recursive: true });
  fs.writeFileSync(path.join(outDir, "all.json"), JSON.stringify(packages, null, 1) + "\n");
  for (const { src, rel } of logos) {
    const dst = path.join(outDir, "logos", rel);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(src, dst);
  }

  const namespaces = [...new Set(packages.map((p) => p.namespace))].sort();
  return { count: packages.length, namespaces };
}
