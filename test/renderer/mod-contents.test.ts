// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Grimoire Authors

import { describe, expect, it } from "vitest";
import { modContents, modEntry, modHarnesses } from "../../src/renderer/astro/lib/mod.js";

const DOC = 'schema = 1\nname = "m"\n\n[claude]\nentry = "m.js"\n\n[opencode]\n';
const FILES = [
  { path: "m/claude/m.js", size: 19 },
  { path: "m/claude/lib/a.js", size: 5 },
  { path: "m/mod.toml", size: 62 },
  { path: "m/zed/m.zed", size: 7 },
];

describe("modContents", () => {
  it("reads the document and the files", () => {
    expect(modContents({ document: DOC, files: FILES })).toEqual({ document: DOC, files: FILES });
  });

  it.each([
    ["no object", null],
    ["an array", []],
    ["no files", { document: DOC }],
    ["files that are not a list", { document: DOC, files: "x" }],
    ["a document that is not text", { document: 7, files: [] }],
  ])("reads %s as no mod section", (_what, data) => {
    expect(modContents(data)).toBeNull();
  });

  it("drops a malformed file entry and keeps the rest", () => {
    const data = { document: DOC, files: [null, { path: 1, size: 2 }, { path: "a/b/c", size: -1 }, { path: "a/b/c", size: "9" }, FILES[0]] };
    expect(modContents(data)?.files).toEqual([FILES[0]]);
  });
});

describe("modHarnesses", () => {
  it("groups by the second segment, sorted, paths below the harness", () => {
    expect(modHarnesses(FILES)).toEqual([
      { name: "claude", files: [{ path: "lib/a.js", size: 5 }, { path: "m.js", size: 19 }] },
      { name: "zed", files: [{ path: "m.zed", size: 7 }] },
    ]);
  });

  it("ignores files with fewer than three segments", () => {
    expect(modHarnesses([{ path: "m/mod.toml", size: 1 }, { path: "x", size: 1 }])).toEqual([]);
  });
});

describe("modEntry", () => {
  it("returns a string entry", () => expect(modEntry(DOC, "claude")).toBe("m.js"));
  it("returns null for a table without an entry, or no table", () => {
    expect(modEntry(DOC, "opencode")).toBeNull();
    expect(modEntry(DOC, "zed")).toBeNull();
  });
  it("returns null for an entry that is not a string", () => expect(modEntry("[claude]\nentry = 3\n", "claude")).toBeNull());
  it("returns undefined for a document that does not parse", () => expect(modEntry("[claude\n", "claude")).toBeUndefined());
  it("does not read an inherited key as a harness", () => expect(modEntry(DOC, "constructor")).toBeNull());
});
