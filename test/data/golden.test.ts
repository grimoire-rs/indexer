// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Grimoire Authors

/**
 * `all.json` is a frozen public URL. Every grim, every extension and every
 * mirror in existence reads it, so its bytes — key order, indentation, the
 * trailing newline, the fields present — are the contract, not just its
 * parsed shape.
 *
 * `test/data/golden/all.json` was captured from `compileIndex` **before** the
 * ratings feature existed and is committed as-is. The ratings work deliberately
 * left `compileIndex` untouched and joined the sidecar downstream in
 * `buildSite`; this is what turns that intent into something a build can fail
 * on. Any later edit that changes what `compileIndex` writes — an added field,
 * a reordered spread, a different `JSON.stringify` indent — breaks this test
 * with a byte diff, and updating the golden to match is a Principle 9 decision
 * for a human, not a fix.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, expect, it } from "vitest";

import { compileIndex } from "../../src/data/index.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(HERE, "fixtures", "valid");
const GOLDEN = path.join(HERE, "golden", "all.json");

let outDir: string;

beforeEach(() => {
  outDir = fs.mkdtempSync(path.join(os.tmpdir(), "index-golden-"));
});

afterEach(() => {
  fs.rmSync(outDir, { recursive: true, force: true });
});

it("writes all.json byte-for-byte as it did before ratings existed", async () => {
  await compileIndex({ root: FIXTURE, outDir });

  // Buffers, not parsed objects: a `toEqual` on the parse would pass through
  // a reordered key or a lost newline, which is exactly the class of change
  // this exists to catch.
  const written = fs.readFileSync(path.join(outDir, "all.json"));
  const golden = fs.readFileSync(GOLDEN);
  // Compared as text first — a byte diff should read as a diff, not as two
  // hex dumps — then as bytes, which is the assertion that actually binds.
  expect(written.toString("utf8")).toBe(golden.toString("utf8"));
  expect(written.equals(golden)).toBe(true);
});
