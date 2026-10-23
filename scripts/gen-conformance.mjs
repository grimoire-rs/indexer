#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Grimoire Authors

// The catalog conformance tree, written by the real emitters from a checked-in
// seed and a fixed clock. grim checks the output in and verifies it against
// MANIFEST.json; the indexer's CI regenerates it and diffs the manifest.
//
//   npm run build
//   node scripts/gen-conformance.mjs --out <empty dir>
//   node scripts/gen-conformance.mjs --check <MANIFEST.json>
//   GRIM_CHECKOUT=<grim checkout> node scripts/gen-conformance.mjs --pinned <pin file>
//
// --pinned is --check against the manifest grim has checked in at the release
// tag the pin file names (one `v<major>.<minor>.<patch>` line, IX-R42), resolved
// to the commit it peels to (`git show <commit>:test/data/conformance/MANIFEST.json`),
// and also against the fixture files grim holds there: a file missing or edited
// at the pin fails even when its manifest entry is untouched.
//
// Exit: 0 clean, 1 drift, 64 usage (--pinned: GRIM_CHECKOUT unset), 65 unreadable manifest
// (--pinned: unreadable or malformed pin file), 69 dist/ not built (--pinned: tag unresolvable or tree unreadable).
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { gunzipSync } from "node:zlib";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SEED = path.join(REPO, "test/conformance/seed.mjs");
const EXIT = { ok: 0, drift: 1, usage: 64, data: 65, unavailable: 69 };
const GRIM_TREE = "test/data/conformance";
const GRIM_MANIFEST = `${GRIM_TREE}/MANIFEST.json`;
/** Kept beside the fixture files in grim and listed in no manifest; grim's own check leaves both out. */
const UNLISTED = new Set(["MANIFEST.json", "README.md"]);

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const put = (dir, rel, bytes) => {
  const file = path.join(dir, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, bytes);
};

function indexerSha() {
  try {
    return execFileSync("git", ["-C", REPO, "rev-parse", "HEAD"], { encoding: "utf8", timeout: 10_000, maxBuffer: 1024 }).trim();
  } catch {
    return "unknown";
  }
}

/** The `{ sha256, size }` a manifest lists for a file: over the inflated bytes for a `.gz`, and a marker for one that does not inflate. */
function entryOf(rel, raw) {
  if (!rel.endsWith(".gz")) return { sha256: sha256(raw), size: raw.length };
  try {
    const bytes = gunzipSync(raw);
    return { sha256: sha256(bytes), size: bytes.length };
  } catch {
    return { sha256: "not-a-gzip-stream", size: raw.length };
  }
}

/** `inventory` of the fixture files grim holds at commit `sha`, read from its object database, not its work tree. */
function pinnedInventory(checkout, sha) {
  const git = (...args) => execFileSync("git", ["-C", checkout, ...args], { stdio: ["ignore", "pipe", "pipe"], timeout: 30_000, maxBuffer: 64 * 1024 * 1024 });
  const files = {};
  for (const line of git("ls-tree", "-r", "-z", sha, "--", GRIM_TREE).toString("utf8").split("\0")) {
    const tab = line.indexOf("\t");
    const [, type, oid] = line.slice(0, tab).split(" ");
    const rel = line.slice(tab + 1).slice(GRIM_TREE.length + 1);
    if (type === "blob" && !UNLISTED.has(rel)) files[rel] = entryOf(rel, git("cat-file", "blob", oid));
  }
  return files;
}

/** The manifest grim checked in at the release tag `pinFile` names (at the commit it peels to), and the fixture files it holds there, as `{ text, label, files }`, or the exit code that ends the run. */
function pinnedManifest(pinFile) {
  let tag;
  try {
    tag = fs.readFileSync(pinFile, "utf8").trim();
  } catch (err) {
    console.error(`cannot read the pin file ${pinFile}: ${err.message}`);
    return EXIT.data;
  }
  // A tag is mutable, so the pin names only a release tag: no branch, no SHA, no pre-release.
  if (!/^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(tag)) {
    console.error(`${pinFile} must hold one grim release tag of the form v<major>.<minor>.<patch>, not ${JSON.stringify(tag)}`);
    return EXIT.data;
  }
  const checkout = process.env.GRIM_CHECKOUT;
  if (!checkout) {
    console.error(`set GRIM_CHECKOUT to a grim checkout that contains tag ${tag}`);
    return EXIT.usage;
  }
  try {
    // `refs/tags/` keeps a branch of the same name from standing in; `^{commit}` peels an annotated tag.
    const sha = execFileSync("git", ["-C", checkout, "rev-parse", "--verify", "--end-of-options", `refs/tags/${tag}^{commit}`], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 30_000,
    }).trim();
    const text = execFileSync("git", ["-C", checkout, "show", `${sha}:${GRIM_MANIFEST}`], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 30_000,
      maxBuffer: 16 * 1024 * 1024,
    });
    return { text, label: `grim ${tag} (${sha}):${GRIM_MANIFEST}`, files: pinnedInventory(checkout, sha) };
  } catch (err) {
    console.error(`cannot read ${GRIM_TREE} at grim tag ${tag} in ${checkout}: ${err.message}`);
    return EXIT.unavailable;
  }
}

/** `{ "<relpath>": { sha256, size } }` for every file under `dir` except the manifest, in path order. A `.gz` file is digested over its inflated bytes, so another zlib cannot fake drift. */
function inventory(dir) {
  const files = {};
  for (const e of fs.readdirSync(dir, { recursive: true, withFileTypes: true })) {
    const file = path.join(e.parentPath, e.name);
    const rel = path.relative(dir, file).split(path.sep).join("/");
    if (!e.isFile() || rel === "MANIFEST.json") continue;
    files[rel] = entryOf(rel, fs.readFileSync(file));
  }
  return Object.fromEntries(Object.entries(files).sort(([a], [b]) => (a < b ? -1 : 1)));
}

/** The enrich entry of one kept pointer; a failing ref is pointer-only with its failure memo. */
function enrichEntry(ref, rec, failing) {
  if (failing) {
    return { data: null, failing_since: "2026-09-20T00:00:00Z", failures: 3, files: {}, input: null, last_failure_at: "2026-09-30T00:00:00Z" };
  }
  const readme = `readme of ${ref}`;
  return {
    data: Object.fromEntries(["created", "updated", "version"].filter((k) => k in rec).map((k) => [k, rec[k]])),
    failing_since: null,
    failures: 0,
    files: { "readme.md": { sha256: sha256(readme), size: Buffer.byteLength(readme) } },
    input: sha256(ref),
    last_failure_at: null,
  };
}

async function generate(mods, seed, out) {
  const { boundRecord, serializeAll, dedupeByRef, emitPublished, emitPlane, bucketOf, nextGeneration, parseSync, serializeDeterministic, statsDocument } = mods;
  const now = new Date(seed.NOW);

  // The order `compileIndex` publishes: its sorted `metadata.json` paths.
  const pointers = seed.records
    .map((rec) => ({ ref: rec.ref, rec, path: `index/${rec.namespace}/${rec.name}/metadata.json` }))
    .sort((a, b) => (a.path < b.path ? -1 : 1));
  const allJson = Buffer.from(serializeAll(pointers.map((p) => boundRecord(p.rec))));
  const statsJson = Buffer.from(`${JSON.stringify(statsDocument(seed.stats, now))}\n`);

  const { kept, warnings } = dedupeByRef(pointers, (p) => p.path);
  for (const w of warnings) console.error(w);
  const entries = new Map(
    kept
      .filter((p) => seed.enriched.includes(p.ref) || seed.failing.includes(p.ref))
      .map((p) => [p.ref, enrichEntry(p.ref, p.rec, seed.failing.includes(p.ref))]),
  );
  // A bucket is stamped only when every ref in it is healthy. The `pointers` digest is a stand-in: this tree carries no pointer bytes.
  const refsByBucket = new Map();
  for (const ref of entries.keys()) refsByBucket.set(bucketOf(ref), [...(refsByBucket.get(bucketOf(ref)) ?? []), ref]);
  const stamps = Object.fromEntries(
    [...refsByBucket]
      .filter(([, refs]) => !refs.some((r) => seed.failing.includes(r)))
      .map(([bucket, refs]) => [bucket, { checked: seed.NOW, deep: seed.NOW, enricher: "0.6.0", pointers: sha256(refs.sort().join("\n")) }]),
  );
  const plane = emitPlane(entries, { stamps, stateEpoch: Math.floor(now.getTime() / 1000), marketplace: null });

  for (const file of plane.files) put(out, file.path, file.bytes);
  put(out, "all.json", allJson);
  put(out, "stats.json", statsJson);
  emitPublished(out, {
    allJson,
    statsJson,
    planeRef: plane.ref,
    generation: nextGeneration(now),
    generatedAt: seed.NOW,
    // legacy: false keeps the tree to the C-011 file set; the unit tests pin the `.gz` siblings.
    sync: parseSync({ layout: "anchored", legacy: false }),
  });

  const manifest = serializeDeterministic({
    schema: 1,
    generator: { indexer_sha: indexerSha(), now: seed.NOW },
    files: inventory(out),
  });
  put(out, "MANIFEST.json", manifest);
}

/** One line per path whose entry differs between two `files` maps; `what` names the second ("regenerated", "pinned"). */
function drift(want, got, what) {
  const [w, g] = [new Map(Object.entries(want)), new Map(Object.entries(got))];
  const lines = [];
  for (const rel of new Set([...w.keys(), ...g.keys()])) {
    const [a, b] = [w.get(rel), g.get(rel)];
    if (a === undefined) lines.push(`${rel}: the manifest does not list it`);
    else if (b === undefined) lines.push(`${rel}: the ${what} tree does not have it`);
    else if (a?.sha256 !== b.sha256 || a?.size !== b.size) lines.push(`${rel}: differs (manifest ${a?.sha256} ${a?.size}, ${what} ${b.sha256} ${b.size})`);
  }
  return lines.sort();
}

async function main(argv) {
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        out: { type: "string" },
        check: { type: "string" },
        pinned: { type: "string" },
        dist: { type: "string", default: path.join(REPO, "dist") },
      },
    }));
  } catch (err) {
    console.error(`${err.message}\nusage: gen-conformance.mjs (--out <empty dir> | --check <MANIFEST.json> | --pinned <pin file>) [--dist <built indexer>]`);
    return EXIT.usage;
  }
  if ([values.out, values.check, values.pinned].filter((v) => v !== undefined).length !== 1) {
    console.error("pass exactly one of --out <dir>, --check <MANIFEST.json> and --pinned <pin file>");
    return EXIT.usage;
  }

  // Resolved before the indexer loads: its failures need no built dist.
  let pinned;
  if (values.pinned !== undefined) {
    pinned = pinnedManifest(values.pinned);
    if (typeof pinned === "number") return pinned;
  }

  const load = (rel) => import(pathToFileURL(path.join(path.resolve(values.dist), rel)).href);
  let mods;
  try {
    const [records, dedupe, root, plane, config, serialize, data, stats] = await Promise.all(
      ["emit/records", "emit/dedupe", "emit/root", "state/plane", "config", "emit/serialize", "data/index", "ratings/seed"].map((m) => load(`${m}.js`)),
    );
    mods = {
      boundRecord: records.boundRecord,
      dedupeByRef: dedupe.dedupeByRef,
      emitPublished: root.emitPublished,
      nextGeneration: root.nextGeneration,
      bucketOf: plane.bucketOf,
      emitPlane: plane.emitPlane,
      parseSync: config.parseSync,
      serializeDeterministic: serialize.serializeDeterministic,
      serializeAll: data.serializeAll,
      statsDocument: stats.statsDocument,
    };
  } catch (err) {
    console.error(`cannot load the built indexer from ${values.dist}: run \`npm run build\` first (${err.message})`);
    return EXIT.unavailable;
  }
  const seed = await import(pathToFileURL(SEED).href);

  if (values.out !== undefined) {
    const out = path.resolve(values.out);
    if (fs.existsSync(out) && fs.readdirSync(out).length > 0) {
      console.error(`${out} is not empty: a stale file would be missing from the manifest`);
      return EXIT.usage;
    }
    await generate(mods, seed, out);
    console.log(`${Object.keys(inventory(out)).length + 1} files in ${out}`);
    return EXIT.ok;
  }

  const source = pinned?.label ?? values.check;
  let want;
  try {
    want = JSON.parse(pinned?.text ?? fs.readFileSync(values.check, "utf8"));
  } catch (err) {
    console.error(`cannot read the manifest ${source}: ${err.message}`);
    return EXIT.data;
  }
  if (typeof want?.files !== "object" || want.files === null || Array.isArray(want.files)) {
    console.error(`${source} has no "files" object`);
    return EXIT.data;
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gen-conformance-"));
  try {
    await generate(mods, seed, tmp);
    const got = JSON.parse(fs.readFileSync(path.join(tmp, "MANIFEST.json"), "utf8"));
    // `generator.indexer_sha` differs by commit by design, so it is not compared.
    const lines = drift(want.files, got.files, "regenerated");
    // The files grim holds equal the manifest and the manifest equals the regenerated tree, so they equal what this indexer emits.
    if (pinned !== undefined) lines.push(...drift(want.files, pinned.files, "pinned"));
    if (want.schema !== got.schema) lines.unshift(`schema: the manifest has ${JSON.stringify(want.schema)}, regenerated ${got.schema}`);
    for (const line of lines) console.error(line);
    return lines.length === 0 ? EXIT.ok : EXIT.drift;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

process.exitCode = await main(process.argv.slice(2));
