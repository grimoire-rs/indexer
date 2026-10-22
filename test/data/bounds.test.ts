// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Grimoire Authors

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { compileIndex } from "../../src/data/index.js";

const KiB = 1024;
const NS = "github.com/acme";

let root: string;
let outDir: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "index-bounds-root-"));
  outDir = fs.mkdtempSync(path.join(os.tmpdir(), "index-bounds-out-"));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(outDir, { recursive: true, force: true });
});

/** One package `foo`. `sidecar` is raw JSON text so a test can store control characters as `\u` escapes. */
function pkg(meta: Record<string, unknown>, sidecar?: string): void {
  const index = path.join(root, "index", NS, "foo");
  fs.mkdirSync(index, { recursive: true });
  fs.writeFileSync(
    path.join(index, "metadata.json"),
    JSON.stringify({ schema: 1, name: "foo", kind: "skill", ref: "ghcr.io/acme/foo", description: "d", owner: { id: 1, github: "acme" }, ...meta }),
  );
  if (sidecar === undefined) return;
  const enrich = path.join(root, "enrich", NS, "foo");
  fs.mkdirSync(enrich, { recursive: true });
  fs.writeFileSync(path.join(enrich, "data.json"), sidecar);
}

async function emitted(): Promise<Record<string, unknown>> {
  await compileIndex({ root, outDir });
  const all = JSON.parse(fs.readFileSync(path.join(outDir, "all.json"), "utf8")) as Record<string, unknown>[];
  expect(all).toHaveLength(1);
  return all[0] ?? {};
}

describe("compileIndex bounds record fields at emit (IX-R30)", () => {
  it("clamps a 1 MiB description to 16 KiB and keeps every key in order", async () => {
    pkg({ description: "é".repeat(512 * KiB) }, JSON.stringify({ title: "t", summary: "s" }));
    const rec = await emitted();
    expect(rec.description).toBe("é".repeat(8 * KiB));
    expect(Object.keys(rec)).toEqual(["title", "summary", "schema", "name", "kind", "ref", "description", "owner", "namespace"]);
  });

  it("clamps a 1 MiB sidecar summary to 1 KiB", async () => {
    pkg({}, JSON.stringify({ summary: "s".repeat(KiB * KiB) }));
    expect((await emitted()).summary).toBe("s".repeat(KiB));
  });

  it("clamps unlisted sidecar keys past the 8 KiB budget in place", async () => {
    const extra = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`extra${i}`, "x".repeat(KiB)]));
    pkg({}, JSON.stringify({ title: "t", ...extra }));
    const rec = await emitted();
    expect(Object.keys(rec)).toEqual(["title", ...Object.keys(extra), "schema", "name", "kind", "ref", "description", "owner", "namespace"]);
    const kept = Object.keys(extra).filter((k) => rec[k] !== "");
    expect(kept).toHaveLength(8);
  });

  it("strips control characters stored as JSON escapes and keeps ZWJ, LRM and a flag tag sequence", async () => {
    const hidden = "\\u202e\\u200b\\u2066\\u0007\\ufeff\\udb40\\udc41"; // the last pair is U+E0041
    const kept = "\\u200d\\u200e\\ud83c\\udff4\\udb40\\udc67\\udb40\\udc62\\udb40\\udc65\\udb40\\udc6e\\udb40\\udc67\\udb40\\udc7f";
    pkg({ description: "l1\nl2\u0000" }, `{"summary":"a${hidden}b${kept}c"}`);
    const rec = await emitted();
    expect(rec.summary).toBe("ab\u200d\u200e\u{1F3F4}\u{E0067}\u{E0062}\u{E0065}\u{E006E}\u{E0067}\u{E007F}c");
    expect(rec.description).toBe("l1\nl2");
  });

  it("keeps a benign record's bytes", async () => {
    pkg({}, JSON.stringify({ title: "foo", summary: "A summary.", keywords: ["a", "b"], tags: ["latest"], deprecated: null }));
    const rec = await emitted();
    expect(rec).toEqual({
      title: "foo",
      summary: "A summary.",
      keywords: ["a", "b"],
      tags: ["latest"],
      deprecated: null,
      schema: 1,
      name: "foo",
      kind: "skill",
      ref: "ghcr.io/acme/foo",
      description: "d",
      owner: { id: 1, github: "acme" },
      namespace: NS,
    });
  });
});
