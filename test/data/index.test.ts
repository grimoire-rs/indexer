// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Grimoire Authors

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { compileIndex, IndexValidationError } from "../../src/data/index.js";

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");

let outDir: string;

beforeEach(() => {
  outDir = fs.mkdtempSync(path.join(os.tmpdir(), "index-test-"));
});

afterEach(() => {
  fs.rmSync(outDir, { recursive: true, force: true });
});

describe("compileIndex", () => {
  it("compiles a valid tree, merging the enrichment sidecar and copying the logo", async () => {
    const result = await compileIndex({ root: path.join(FIXTURES, "valid"), outDir });

    expect(result).toEqual({ count: 1, namespaces: ["github.com/acme"] });

    const all = JSON.parse(fs.readFileSync(path.join(outDir, "all.json"), "utf8"));
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({
      schema: 1,
      name: "foo",
      kind: "skill",
      ref: "ghcr.io/acme/skills/foo",
      description: "A test skill.",
      namespace: "github.com/acme",
      summary: "Enriched summary", // sidecar field survives
      version: "1.2.3",
    });
    // internal change-probe bookkeeping never ships
    expect(all[0]).not.toHaveProperty("descDigest");

    // index/ is copied verbatim
    expect(
      fs.existsSync(path.join(outDir, "index", "github.com", "acme", "foo", "metadata.json")),
    ).toBe(true);

    // logo copied to dist/logos/<ns>/<name>.<ext>
    expect(fs.existsSync(path.join(outDir, "logos", "github.com", "acme", "foo.svg"))).toBe(true);
  });

  it("lets index metadata win over the sidecar on key overlap", async () => {
    await compileIndex({ root: path.join(FIXTURES, "valid"), outDir });
    const all = JSON.parse(fs.readFileSync(path.join(outDir, "all.json"), "utf8"));
    // "name" is present in both index metadata and (implicitly) derived fields;
    // the index-owned description always wins — sidecar never carries description.
    expect(all[0].description).toBe("A test skill.");
  });

  it("degrades cleanly when enrich/ is missing entirely", async () => {
    const result = await compileIndex({ root: path.join(FIXTURES, "no-enrich"), outDir });
    expect(result.count).toBe(1);
    const all = JSON.parse(fs.readFileSync(path.join(outDir, "all.json"), "utf8"));
    expect(all[0]).toMatchObject({ name: "foo", namespace: "github.com/acme" });
    expect(fs.existsSync(path.join(outDir, "logos"))).toBe(false);
  });

  it("degrades cleanly when a logo key points at a missing file", async () => {
    const result = await compileIndex({ root: path.join(FIXTURES, "missing-logo-file"), outDir });
    expect(result.count).toBe(1);
    expect(fs.existsSync(path.join(outDir, "logos"))).toBe(false);
    const all = JSON.parse(fs.readFileSync(path.join(outDir, "all.json"), "utf8"));
    expect(all[0].logo).toBe("/logos/github.com/acme/foo.svg"); // field kept, file just absent
  });

  it("rejects an unsupported schema version", async () => {
    await expect(
      compileIndex({ root: path.join(FIXTURES, "schema-mismatch"), outDir }),
    ).rejects.toThrow(IndexValidationError);
  });

  it("rejects a name that doesn't match its directory", async () => {
    await expect(
      compileIndex({ root: path.join(FIXTURES, "name-mismatch"), outDir }),
    ).rejects.toThrow(/name .* != directory/);
  });

  it("rejects an unknown kind", async () => {
    await expect(
      compileIndex({ root: path.join(FIXTURES, "bad-kind"), outDir }),
    ).rejects.toThrow(/kind must be one of/);
  });

  it("rejects an owner missing 'id'", async () => {
    await expect(
      compileIndex({ root: path.join(FIXTURES, "owner-missing-id"), outDir }),
    ).rejects.toThrow(/owner must be an object/);
  });
});
