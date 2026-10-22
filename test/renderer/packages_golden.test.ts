// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Grimoire Authors

// C-010: an index with no marketplace serves `/` and `/p/` byte-for-byte as it
// did before the marketplace existed. The goldens under `golden/` are the
// pages built from base commit 0d15844, normalized below; substring checks
// elsewhere cannot see a stray attribute or a moved style block.
//
// Regenerate (only when a package-page change is intended): run this file with
// `GOLDEN_WRITE=1`, review `git diff test/renderer/golden`, commit.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildSite } from "../../src/renderer/index.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(HERE, "fixture");
const GOLDEN = path.join(HERE, "golden");

/** The pages pinned: the catalog root and one package page. */
const PAGES = { "index.html": "packages-index.html", "p/github.com/acme/code-review/index.html": "packages-detail.html" };

/** Drops what changes per build: temp paths baked into dev bundles, build time, island ids, content hashes. */
function normalize(html: string): string {
  return html
    .replace(/\/[^"'`\s]*?\/\.index-[A-Za-z0-9]+/g, "<STAGE>")
    .replace(/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ/g, (t) => (t === "2026-08-02T11:15:00Z" ? t : "<NOW>"))
    .replace(/uid="[A-Za-z0-9]+"/g, 'uid="<UID>"')
    .replace(/(\/_astro\/[A-Za-z0-9_]+)\.[A-Za-z0-9_-]{8}\.(js|css)/g, "$1.<HASH>.$2");
}

let root: string;
let outDir: string;

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "mk-golden-"));
  outDir = path.join(root, "dist");
  await fs.cp(FIXTURE, root, { recursive: true });
  await fs.mkdir(outDir, { recursive: true });
  await fs.rename(path.join(root, "all.json"), path.join(outDir, "all.json"));
  const config = JSON.parse(await fs.readFile(path.join(root, "index.config.json"), "utf8"));
  await buildSite({ root, outDir, config: { ...config, nav: null } });
}, 600_000);

afterAll(async () => {
  if (root) await fs.rm(root, { recursive: true, force: true });
});

describe("packages mode against the pre-marketplace pages", () => {
  it.each(Object.entries(PAGES))("serves %s byte-identical to base", async (page, golden) => {
    const built = normalize(await fs.readFile(path.join(outDir, page), "utf8"));
    if (process.env.GOLDEN_WRITE) {
      await fs.mkdir(GOLDEN, { recursive: true });
      await fs.writeFile(path.join(GOLDEN, golden), built);
      return;
    }
    expect(built).toBe(await fs.readFile(path.join(GOLDEN, golden), "utf8"));
  });
});
