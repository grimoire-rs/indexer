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
 * Work is skipped by digest: `describe` is cheap and runs every time, while
 * the description companion (README/CHANGELOG/logo) is probed with
 * `--digest-only` and only downloaded when that digest moved.
 *
 * A per-package failure keeps the existing sidecar — stale beats empty — and
 * only a majority failure is reported as an outage.
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
const LOGO_EXT = /^[A-Za-z0-9]{1,8}$/;

/** Runs one `grim` subcommand and parses its JSON. Injected so tests need no binary. */
export type GrimRunner = (args: string[]) => Promise<unknown>;

export interface EnrichOptions {
  /** Index repo root — holds `index/`, gains `enrich/`. */
  root: string;
  /** Defaults to spawning `grim` from `PATH`. */
  run?: GrimRunner;
}

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
 * grim's snake_case `describe` payload -> the camelCase fields the renderer
 * reads. Key insertion order is the on-disk order, and these sidecars are
 * committed — keep it stable so a refresh that changed nothing diffs as
 * nothing.
 */
function mapMeta(desc: Record<string, unknown>): Record<string, unknown> {
  const data: Record<string, unknown> = {};
  for (const key of ["title", "summary", "version", "license", "created"]) {
    if (desc[key] != null) data[key] = desc[key];
  }
  data.keywords = desc.keywords ?? [];
  data.tags = desc.tags ?? [];
  data.deprecated = desc.deprecated ?? null; // string | null, always present
  if (desc.replaced_by) data.replacedBy = desc.replaced_by;
  return data;
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
function clearCompanions(dir: string): void {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir)) {
    const low = entry.toLowerCase();
    if (low === "readme.md" || low === "changelog.md" || low.startsWith("logo.")) {
      fs.rmSync(path.join(dir, entry), { force: true });
    }
  }
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

async function enrichOne(
  run: GrimRunner,
  enrichDir: string,
  ref: string,
  namespace: string,
  name: string,
): Promise<void> {
  const out = path.join(enrichDir, namespace, name);
  const dataFile = path.join(out, "data.json");
  const existing: Record<string, unknown> = fs.existsSync(dataFile)
    ? (JSON.parse(fs.readFileSync(dataFile, "utf8")) as Record<string, unknown>)
    : {};

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

  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(dataFile, JSON.stringify(data, null, 1) + "\n");
}

export async function enrichIndex(opts: EnrichOptions): Promise<EnrichResult> {
  const { root } = opts;
  const run = opts.run ?? spawnGrim();
  const indexDir = path.join(root, "index");
  const enrichDir = path.join(root, "enrich");

  const failures: string[] = [];
  const files = findMetadataFiles(indexDir);

  // ponytail: sequential, like the Python it replaces. Each package is a
  // couple of round trips and the digest probe skips almost all of them;
  // batch with a worker pool if an index ever grows into the hundreds.
  for (const file of files) {
    const meta = JSON.parse(fs.readFileSync(file, "utf8")) as { ref: string; name: string };
    try {
      await enrichOne(run, enrichDir, meta.ref, namespaceOf(indexDir, file), meta.name);
    } catch (err) {
      failures.push(`${meta.ref}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return { total: files.length, enriched: files.length - failures.length, failures };
}
