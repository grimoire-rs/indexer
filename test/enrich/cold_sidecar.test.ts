// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Grimoire Authors

// A ref the plane knows nothing of can still have a sidecar on disk, committed
// or left by an earlier run on this machine. The base read it, so an unchanged
// digest kept the date it was first seen; a run with no plane entry still does.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { GrimRunner } from "../../src/enrich/index.js";
import { pipeline } from "./pipeline.js";

const T0 = Date.UTC(2026, 9, 22, 8, 0, 0);
const AT = "2026-10-22T08:00:00Z";
const FIRST_SEEN = "2026-08-01T09:00:00Z";
const REF = "ghcr.io/acme/skills/p000";

let dir: string;

/** An artifact with no `created`, so `updated` is the date the index first saw its digest. */
const registry = (digest: string): GrimRunner => async (args) => {
  if (args[0] === "describe") return { kind: "skill", digest, title: "p000", tags: [], keywords: [], deprecated: null, has_description: false };
  if (args.includes("--digest-only")) return { digest };
  return { content: "# Entry\n" };
};

function seed(): void {
  const pkg = path.join(dir, "index", "github.com/acme", "p000");
  fs.mkdirSync(pkg, { recursive: true });
  fs.writeFileSync(path.join(pkg, "metadata.json"), JSON.stringify({ schema: 1, name: "p000", kind: "skill", ref: REF, description: "d", owner: { id: 1, github: "octocat" } }));
  const sidecar = path.join(dir, "enrich", "github.com/acme", "p000");
  fs.mkdirSync(sidecar, { recursive: true });
  fs.writeFileSync(path.join(sidecar, "data.json"), JSON.stringify({ contentDigest: "sha256:art", updated: FIRST_SEEN, title: "old" }));
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "index-cold-"));
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("a run with no plane entry for a ref that has a sidecar on disk", () => {
  it("keeps the date the digest was first seen while the digest has not moved", async () => {
    seed();
    const p = pipeline(dir, () => T0);

    await p.pass(registry("sha256:art"));

    expect(p.plane.entries.get(REF)!.data).toMatchObject({ updated: FIRST_SEEN });
  });

  it("dates the artifact from this run once its digest moved", async () => {
    seed();
    const p = pipeline(dir, () => T0);

    await p.pass(registry("sha256:other"));

    expect(p.plane.entries.get(REF)!.data).toMatchObject({ updated: AT });
  });

  it("--fresh carries nothing, the sidecar on disk included", async () => {
    seed();
    const p = pipeline(dir, () => T0);

    await p.pass(registry("sha256:art"), { fresh: true });

    expect(p.plane.entries.get(REF)!.data).toMatchObject({ updated: AT });
  });
});
