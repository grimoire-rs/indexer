// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Grimoire Authors

// `enrich --purge` and `--fresh` at the command boundary (IX-R10): a bad purge
// argument is refused before any I/O, and `--fresh` starts cold while the
// generation still follows the published root. What the refresh does with a
// purge target is covered in `test/enrich/purge_run.test.ts`.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { enrich } from "../../src/cli/enrich.js";
import { EXIT } from "../../src/cli/exit.js";
import { enrichIndex, grimVersion, spawnGrim, type GrimRunner } from "../../src/enrich/index.js";
import { MARKETPLACE_GRIM_VERSION } from "../../src/grim.js";
import { STATE_DIR, readHandoff } from "../../src/state/handoff.js";
import { stubFetch } from "../validate/helpers.js";

let grim: GrimRunner;
vi.mock("../../src/enrich/index.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../src/enrich/index.js")>();
  return {
    ...original,
    enrichIndex: vi.fn(original.enrichIndex),
    grimVersion: vi.fn(async (): Promise<string | undefined> => MARKETPLACE_GRIM_VERSION),
    spawnGrim: vi.fn(() => (args: string[], opts?: { timeoutMs?: number }) => grim(args, opts)),
  };
});

const SITE = "https://index.example.test";
const HEX = "ab".repeat(32);

let dir: string;
let calls: string[][];

function addPackage(name: string): void {
  const pkg = path.join(dir, "index", "github.com/acme", name);
  fs.mkdirSync(pkg, { recursive: true });
  fs.writeFileSync(
    path.join(pkg, "metadata.json"),
    JSON.stringify({ schema: 1, name, kind: "skill", ref: `ghcr.io/acme/skills/${name}`, description: "d", owner: { id: 1, github: "o" } }),
  );
}

const describes = (): number => calls.filter((a) => a[0] === "describe").length;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "index-recovery-cli-"));
  calls = [];
  grim = async (args) => {
    calls.push(args);
    if (args[0] === "describe") return { kind: "skill", digest: "sha256:art", title: "T", created: "2026-07-01T00:00:00Z", tags: [], keywords: [], deprecated: null, has_description: true };
    if (args.includes("--digest-only")) return { digest: args.includes("--description") ? "sha256:aaa" : "sha256:art" };
    if (!args.includes("--description")) return { content: "# Entry\n" };
    return { digest: "sha256:aaa", files: [{ path: "README.md", content: "# T\n" }] };
  };
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.mocked(enrichIndex).mockClear();
  vi.mocked(grimVersion).mockClear();
  vi.mocked(spawnGrim).mockClear();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("enrich --purge validation (IX-R10, spec §5.6)", () => {
  it.each([
    ["empty", ""],
    ["a bare sha256: prefix", "sha256:"],
    ["63 hex characters", HEX.slice(1)],
    ["a path", "../x"],
    ["uppercase hex", HEX.toUpperCase()],
  ])("%s exits 65 before any request, grim call or state directory", async (_name, arg) => {
    addPackage("foo");
    // A site that qualifies: were the anchor reached, it would be the first request.
    fs.writeFileSync(path.join(dir, "index.config.json"), JSON.stringify({ site: SITE }));
    const requests = stubFetch(() => null);

    await expect(enrich(dir, { purge: arg })).rejects.toMatchObject({ code: EXIT.data });

    expect(requests).toHaveLength(0);
    expect(grimVersion).not.toHaveBeenCalled();
    expect(spawnGrim).not.toHaveBeenCalled();
    expect(enrichIndex).not.toHaveBeenCalled();
    expect(calls).toHaveLength(0);
    expect(fs.existsSync(path.join(dir, STATE_DIR))).toBe(false);
  });

  it("hands a digest and a ref to the refresh as parsed", async () => {
    await enrich(dir, { purge: HEX });
    await enrich(dir, { purge: "ghcr.io/acme/skills/foo" });

    expect(vi.mocked(enrichIndex).mock.calls.map(([o]) => o.purge)).toEqual([{ digest: HEX }, { ref: "ghcr.io/acme/skills/foo" }]);
  });
});

describe("enrich --fresh (IX-R10, IX-R06)", () => {
  it("starts cold with every ref deep and an empty store, yet the generation is published + 1 while the clock is behind", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(Date.UTC(2026, 9, 22, 8, 30, 0)));
    addPackage("foo");
    addPackage("bar");
    await enrich(dir, {});
    const plane = readHandoff(dir)!.planes.enrich;
    expect(describes()).toBe(2);

    fs.writeFileSync(path.join(dir, "index.config.json"), JSON.stringify({ site: SITE }));
    const published = Math.floor(Date.now() / 1000) + 5000;
    stubFetch(() => ({
      body: JSON.stringify({ flat: null, generated_at: "2026-10-21T08:00:00Z", generation: published, planes: { catalog: null, enrich: plane }, schema: 1, search: null, stats: null }),
    }));

    // Control: the same state, not fresh, is warm and costs no call.
    calls = [];
    await enrich(dir, {});
    expect(calls).toHaveLength(0);
    expect(vi.mocked(enrichIndex).mock.calls.at(-1)![0].plane).toBeDefined();

    calls = [];
    await enrich(dir, { fresh: true });

    expect(vi.mocked(enrichIndex).mock.calls.at(-1)![0].plane).toBeUndefined();
    expect(describes()).toBe(2);
    expect(calls).toHaveLength(6);
    expect(readHandoff(dir)!.generation).toBe(published + 1);
  });

  it("empties the blob store before the run, so a blob nobody refetched is gone", async () => {
    const stale = path.join(dir, STATE_DIR, "b", "sha256", "ab", HEX);
    fs.mkdirSync(path.dirname(stale), { recursive: true });
    fs.writeFileSync(stale, "old");

    await enrich(dir, { fresh: true });

    expect(fs.existsSync(stale)).toBe(false);
  });
});

describe("enrich state_epoch (IX-R10, IX-R27)", () => {
  const DAY = 24 * 60 * 60;
  const T0 = Date.UTC(2026, 9, 22, 8, 30, 0);
  const at = (days: number): void => void vi.setSystemTime(new Date(T0 + days * DAY * 1000));
  const epochNow = (): number => Math.floor(Date.now() / 1000);

  /** A first run at T0 whose plane the site then publishes; each case then runs at its own time. */
  async function published(): Promise<number> {
    vi.useFakeTimers({ toFake: ["Date"] });
    at(0);
    addPackage("foo");
    await enrich(dir, {});
    const first = readHandoff(dir)!;
    fs.writeFileSync(path.join(dir, "index.config.json"), JSON.stringify({ site: SITE }));
    stubFetch(() => ({
      body: JSON.stringify({ flat: null, generated_at: "2026-10-21T08:00:00Z", generation: first.generation, planes: { catalog: null, enrich: first.planes.enrich }, schema: 1, search: null, stats: null }),
    }));
    return first.state_epoch;
  }

  it("keeps the published epoch while it is under 7 days old", async () => {
    const epoch = await published();
    at(6);
    await enrich(dir, {});
    expect(readHandoff(dir)!.state_epoch).toBe(epoch);
    expect(readHandoff(dir)!.next_key.split("-")[0]).toBe(String(epoch));
  });

  it("renews it once it is older than 7 days", async () => {
    await published();
    at(8);
    await enrich(dir, {});
    expect(readHandoff(dir)!.state_epoch).toBe(epochNow());
  });

  it("renews a published epoch dated in the future instead of carrying it for ever", async () => {
    const epoch = await published();
    at(-2);
    await enrich(dir, {});
    expect(readHandoff(dir)!.state_epoch).toBe(epochNow());
    expect(readHandoff(dir)!.state_epoch).not.toBe(epoch);
  });

  it("starts a new epoch on --fresh", async () => {
    const epoch = await published();
    at(1);
    await enrich(dir, { fresh: true });
    expect(readHandoff(dir)!.state_epoch).toBe(epochNow());
    expect(readHandoff(dir)!.state_epoch).not.toBe(epoch);
  });

  it("starts a new epoch on --purge, though the plane is kept", async () => {
    const epoch = await published();
    at(1);
    await enrich(dir, { purge: "ghcr.io/acme/skills/foo" });
    expect(vi.mocked(enrichIndex).mock.calls.at(-1)![0].plane).toBeDefined();
    expect(readHandoff(dir)!.state_epoch).toBe(epochNow());
    expect(readHandoff(dir)!.state_epoch).not.toBe(epoch);
  });
});
