// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Grimoire Authors

// The plane's shards write every object in byte-sorted key order, and the key order
// of an `all.json` record is its sidecar's: a ref restored from the plane must
// publish the record `enrich` wrote.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { compileIndex } from "../../src/data/index.js";
import type { GrimRunner } from "../../src/enrich/index.js";
import { hydrate } from "../../src/state/restore.js";
import { pipeline } from "../enrich/pipeline.js";

const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex").toString("base64");

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "index-roundtrip-"));
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(dir, { recursive: true, force: true });
});

/** Every field `describe` can report, so every key `enrich` writes is in the sidecar. */
const run: GrimRunner = async (args) => {
  if (args[0] === "describe") {
    return {
      kind: "skill",
      digest: "sha256:art",
      title: "T",
      summary: "S",
      version: "1.0.0",
      license: "MIT",
      created: "2026-07-01T00:00:00Z",
      revision: "abc",
      authors: ["a"],
      vendor: "v",
      url: "https://example.org/u",
      documentation: "https://example.org/d",
      compatibility: "any",
      support: { issues: "https://example.org/i", chat: "https://example.org/c", contact: "a@example.org", security: "https://example.org/s" },
      keywords: ["k"],
      tags: ["latest"],
      deprecated: null,
      replaced_by: "ghcr.io/acme/skills/other",
      has_description: true,
    };
  }
  if (args.includes("--digest-only")) return { digest: "sha256:art" };
  if (args.includes("--description")) {
    return { digest: "sha256:cmp", files: [{ path: "README.md", content: "# r\n" }, { path: "CHANGELOG.md", content: "# c\n" }, { path: "logo.png", content: PNG, encoding: "base64" }] };
  }
  return { content: "# Entry\n" };
};

describe("a sidecar restored from the plane", () => {
  it("contract:I1 IX-R03 publishes the all.json bytes `enrich` would have, key order included", async () => {
    const pkg = path.join(dir, "index", "github.com/acme", "foo");
    fs.mkdirSync(pkg, { recursive: true });
    fs.writeFileSync(
      path.join(pkg, "metadata.json"),
      JSON.stringify({ schema: 1, name: "foo", kind: "skill", ref: "ghcr.io/acme/skills/foo", description: "d", owner: { id: 1, github: "o" } }),
    );
    const p = pipeline(dir, () => Date.UTC(2026, 9, 22, 8, 0, 0));
    await p.pass(run);
    await compileIndex({ root: dir, outDir: path.join(dir, "out-fresh") });

    fs.rmSync(path.join(dir, "enrich"), { recursive: true });
    expect(hydrate(dir, p.store, p.plane)).toBe(1);
    await compileIndex({ root: dir, outDir: path.join(dir, "out-restored") });

    const bytes = (out: string): string => fs.readFileSync(path.join(dir, out, "all.json"), "utf8");
    expect(JSON.parse(bytes("out-fresh"))[0]).toMatchObject({ replacedBy: expect.any(String), logo: expect.any(String) });
    expect(bytes("out-restored")).toBe(bytes("out-fresh"));
    // Carrying an order costs every shard bytes, so a sidecar `enrich` wrote carries none.
    expect(p.plane.entries.get("ghcr.io/acme/skills/foo")).not.toHaveProperty("order");
  });

  it("contract:I1 IX-R03 keeps the order of custom top-level fields and of a nested free-form object", async () => {
    const pkg = path.join(dir, "index", "github.com/acme", "foo");
    fs.mkdirSync(pkg, { recursive: true });
    fs.writeFileSync(
      path.join(pkg, "metadata.json"),
      JSON.stringify({ schema: 1, name: "foo", kind: "skill", ref: "ghcr.io/acme/skills/foo", description: "d", owner: { id: 1, github: "o" } }),
    );
    const clock = () => Date.UTC(2026, 9, 22, 8, 0, 0);
    const p = pipeline(dir, clock);
    await p.pass(run);

    // `enrich` writes only its allow-list, so a custom field comes from a sidecar something else wrote: a
    // committed or hand-edited one. The pass that follows carries it into the plane untouched.
    const sidecar = path.join(dir, "enrich", "github.com/acme", "foo", "data.json");
    const written = JSON.parse(fs.readFileSync(sidecar, "utf8")) as Record<string, unknown>;
    const { title, ...rest } = written;
    const custom = { zeta: 1, title, extra: { z: 1, a: [{ y: 2, b: 1 }, 3], m: { q: 1, c: 2 } }, ...rest, alpha: "a", support: { security: "https://example.org/s", issues: "https://example.org/i", x: { n: 1, d: 2 } } };
    fs.writeFileSync(sidecar, JSON.stringify(custom, null, 1) + "\n");
    await p.pass(run);
    await compileIndex({ root: dir, outDir: path.join(dir, "out-fresh") });

    fs.rmSync(path.join(dir, "enrich"), { recursive: true });
    expect(hydrate(dir, p.store, p.plane)).toBe(1);
    await compileIndex({ root: dir, outDir: path.join(dir, "out-restored") });

    const bytes = (out: string): string => fs.readFileSync(path.join(dir, out, "all.json"), "utf8");
    expect(bytes("out-fresh")).toContain('"extra"');
    expect(bytes("out-restored")).toBe(bytes("out-fresh"));
  });
});
