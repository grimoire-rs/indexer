// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Grimoire Authors

// Expiry sweep for `grim-polyfill<X.Y.Z:` markers (see
// .claude/rules/grim-compat-markers.md). A marker is the price of a branch kept
// for an older grim; this test makes it expire when MINIMUM_GRIM_VERSION
// reaches it, instead of rotting into permanent code nobody dares delete.
import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { MINIMUM_GRIM_VERSION, isNewerVersion } from "../src/grim.js";

const ROOT = path.join(import.meta.dirname, "..");
const SELF = path.basename(import.meta.filename);

/** Assembled rather than written whole, so this file's own text is never a marker. */
const WORD = ["grim", "polyfill"].join("-") + "<";
const WELL_FORMED = new RegExp(WORD + "(\\d+\\.\\d+\\.\\d+):", "g");

function tsFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return tsFiles(full);
    return entry.isFile() && entry.name.endsWith(".ts") && entry.name !== SELF ? [full] : [];
  });
}

const sources = (): [string, string][] =>
  ["src", "test"].flatMap((dir) => tsFiles(path.join(ROOT, dir))).map((f) => [path.relative(ROOT, f), fs.readFileSync(f, "utf8")]);

describe("grim compatibility markers", () => {
  it("every marker names a version the floor has not yet reached", () => {
    const stale = sources().flatMap(([file, source]) =>
      [...source.matchAll(WELL_FORMED)]
        .map((m) => m[1] ?? "")
        .filter((version) => !isNewerVersion(version, MINIMUM_GRIM_VERSION))
        .map((version) => `${file}: ${WORD}${version}`),
    );
    expect(stale, `MINIMUM_GRIM_VERSION is now ${MINIMUM_GRIM_VERSION} — delete the branches these guard`).toEqual([]);
  });

  it("no marker escapes the sweep through a malformed version", () => {
    // A typo like `grim-polyfill<0.15:` never matches the strict pattern, so it would outlive every floor bump.
    const malformed = sources()
      .map(([file, source]) => [file, source.split(WORD).length - 1 - [...source.matchAll(WELL_FORMED)].length] as const)
      .filter(([, n]) => n > 0)
      .map(([file, n]) => `${file}: ${n} malformed`);
    expect(malformed, `markers must read ${WORD}X.Y.Z: exactly`).toEqual([]);
  });
});
