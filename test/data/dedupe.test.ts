// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Grimoire Authors

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { compileIndex } from "../../src/data/index.js";
import { dedupeByRef } from "../../src/emit/dedupe.js";

let root: string;
let outDir: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "index-dedupe-root-"));
  outDir = fs.mkdtempSync(path.join(os.tmpdir(), "index-dedupe-out-"));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(outDir, { recursive: true, force: true });
});

function pointer(ns: string, name: string, ref: string): void {
  const dir = path.join(root, "index", ns, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "metadata.json"),
    JSON.stringify({ schema: 1, name, kind: "skill", ref, description: "d", owner: { id: 1, github: "acme" } }),
  );
}

interface Rec {
  ref: string;
  name: string;
  namespace: string;
}
const pathOf = (r: Rec) => `index/${r.namespace}/${r.name}/metadata.json`;

describe("two pointers, one ref (P-11)", () => {
  it("keeps both all.json elements and dedupes to the last in sorted path order", async () => {
    pointer("github.com/acme", "zeta", "ghcr.io/acme/shared");
    pointer("github.com/acme", "alpha", "ghcr.io/acme/shared");
    pointer("github.com/acme", "solo", "ghcr.io/acme/solo");
    await compileIndex({ root, outDir });
    const all = JSON.parse(fs.readFileSync(path.join(outDir, "all.json"), "utf8")) as Rec[];

    expect(all.map((r) => r.name)).toEqual(["alpha", "solo", "zeta"]);

    const { kept, warnings } = dedupeByRef(all, pathOf);
    expect(kept.map((r) => r.name)).toEqual(["solo", "zeta"]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("index/github.com/acme/alpha/metadata.json");
    expect(warnings[0]).toContain("index/github.com/acme/zeta/metadata.json");
  });
});

describe("dedupeByRef (IX-R04)", () => {
  const rec = (namespace: string, name: string, ref: string): Rec => ({ namespace, name, ref });

  it("picks the same winner whatever order the pointers arrive in", () => {
    const a = rec("github.com/acme", "a", "r");
    const b = rec("github.com/acme", "b", "r");
    const c = rec("github.com/beta", "c", "r");
    for (const input of [[a, b, c], [c, b, a], [b, c, a]]) {
      expect(dedupeByRef(input, pathOf).kept).toEqual([c]);
    }
  });

  it("warns once per dropped pointer, naming it and the winner", () => {
    const a = rec("github.com/acme", "a", "r");
    const b = rec("github.com/acme", "b", "r");
    const c = rec("github.com/acme", "c", "r");
    const { warnings } = dedupeByRef([a, b, c], pathOf);
    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toContain("acme/a/");
    expect(warnings[1]).toContain("acme/b/");
    for (const w of warnings) expect(w).toContain("acme/c/");
  });

  it("returns the survivors in sorted path order and warns about nothing when refs are distinct", () => {
    const x = rec("github.com/acme", "x", "r1");
    const y = rec("github.com/acme", "y", "r2");
    expect(dedupeByRef([y, x], pathOf)).toEqual({ kept: [x, y], warnings: [] });
  });

  it("treats refs as case-sensitive strings, like the plane does", () => {
    const a = rec("github.com/acme", "a", "ghcr.io/Acme/x");
    const b = rec("github.com/acme", "b", "ghcr.io/acme/x");
    expect(dedupeByRef([a, b], pathOf).kept).toEqual([a, b]);
  });
});
