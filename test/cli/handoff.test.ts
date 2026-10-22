// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Grimoire Authors

// `enrich` hands its state to the offline `build` through `<root>/.grim-index-state`
// (spec §6.10). The fake grim here is the same shape `test/enrich/enrich.test.ts`
// uses: nothing touches a registry, so what the second run asks of it is
// directly assertable.
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { enrich } from "../../src/cli/enrich.js";
import { EXIT } from "../../src/cli/exit.js";
import { enrichIndex, grimVersion, type GrimRunner } from "../../src/enrich/index.js";
import { MARKETPLACE_GRIM_VERSION } from "../../src/grim.js";
import { BLOB_CAP } from "../../src/state/blobstore.js";
import { STATE_DIR, readHandoff } from "../../src/state/handoff.js";
import { STATE_KEY_RE } from "../../src/state/statekey.js";
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
const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
const COMPANION = [
  { path: "README.md", content: "# Foo\n" },
  { path: "CHANGELOG.md", content: "## 1.2.3\n" },
  { path: "logo.png", content: PNG.toString("base64"), encoding: "base64" },
];
const DESCRIBE = {
  kind: "skill",
  digest: "sha256:art",
  title: "Foo",
  summary: "A foo.",
  version: "1.2.3",
  license: "Apache-2.0",
  created: "2026-07-01T00:00:00+02:00",
  keywords: ["a"],
  tags: ["1.2.3", "latest"],
  deprecated: null,
  has_description: true,
};

let dir: string;
let calls: string[][];
const state = (...rel: string[]): string => path.join(dir, STATE_DIR, ...rel);
const sha = (b: Uint8Array): string => createHash("sha256").update(b).digest("hex");

function addPackage(name: string, ref: string): void {
  const pkg = path.join(dir, "index", "github.com/acme", name);
  fs.mkdirSync(pkg, { recursive: true });
  fs.writeFileSync(
    path.join(pkg, "metadata.json"),
    JSON.stringify({ schema: 1, name, kind: "skill", ref, description: "d", owner: { id: 1, github: "o" } }),
  );
}

function setSite(site: string): void {
  fs.writeFileSync(path.join(dir, "index.config.json"), JSON.stringify({ site }));
}

function healthyGrim(): GrimRunner {
  return async (args) => {
    calls.push(args);
    if (args[0] === "describe") return { ...DESCRIBE };
    if (args.includes("--digest-only")) return { digest: args.includes("--description") ? "sha256:aaa" : "sha256:art" };
    if (!args.includes("--description")) return { content: "# Entry\n" };
    return { digest: "sha256:aaa", files: COMPANION };
  };
}

/** Every file under `dir` by relative path; `data.json` parsed, so key order is not the claim. */
function tree(base: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!fs.existsSync(base)) return out;
  for (const e of fs.readdirSync(base, { recursive: true, withFileTypes: true })) {
    if (!e.isFile()) continue;
    const file = path.join(e.parentPath, e.name);
    const rel = path.relative(base, file);
    out[rel] = e.name === "data.json" ? JSON.parse(fs.readFileSync(file, "utf8")) : fs.readFileSync(file).toString("base64");
  }
  return out;
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "index-handoff-cli-"));
  calls = [];
  grim = healthyGrim();
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("enrich state directory (IX-R35, V-17)", () => {
  it("V-17 writes <state>/.gitignore containing exactly `*` and leaves user-owned files alone", async () => {
    fs.writeFileSync(path.join(dir, ".gitignore"), "node_modules\n");
    fs.writeFileSync(path.join(dir, "package.json"), '{"name":"x"}\n');

    expect(await enrich(dir, {})).toBe(EXIT.ok);

    expect(fs.readFileSync(state(".gitignore"), "utf8")).toBe("*");
    expect(fs.readFileSync(path.join(dir, ".gitignore"), "utf8")).toBe("node_modules\n");
    expect(fs.readFileSync(path.join(dir, "package.json"), "utf8")).toBe('{"name":"x"}\n');
  });
});

describe("enrich hand-off (IX-R35)", () => {
  it("writes handoff.json, the plane files and the companions into the store", async () => {
    addPackage("foo", "ghcr.io/acme/skills/foo");
    const before = Math.floor(Date.now() / 1000);

    expect(await enrich(dir, {})).toBe(EXIT.ok);

    const h = readHandoff(dir)!;
    expect(h).not.toBeNull();
    expect(h.generation).toBeGreaterThanOrEqual(before);
    expect(h.state_epoch).toBeGreaterThanOrEqual(before);
    expect(STATE_KEY_RE.test(h.next_key)).toBe(true);
    expect(h.next_key.startsWith(`${h.state_epoch}-`)).toBe(true);
    expect(h.counters.enrich).toBe("complete");

    const index = fs.readFileSync(state("out", "c/p/sha256", `${h.planes.enrich!.sha256}.json`));
    expect(h.planes.enrich).toEqual({ sha256: sha(index), size: index.length });
    expect(fs.readdirSync(state("out", "c/s/sha256"))).toHaveLength(1);
    const plane = JSON.parse(index.toString("utf8")) as { blobs: string; buckets: Record<string, { sha256: string }> };
    expect(h.next_key.endsWith(`-${plane.blobs}`)).toBe(true);

    // The plane files and the three companions are in the store, by digest.
    const store = state("b", "sha256");
    const stored = fs.readdirSync(store, { recursive: true, withFileTypes: true }).filter((e) => e.isFile());
    expect(stored.length).toBeGreaterThanOrEqual(2 + 4); // index, shard, readme, changelog, contents, logo
    expect(fs.existsSync(path.join(store, h.planes.enrich!.sha256.slice(0, 2), h.planes.enrich!.sha256))).toBe(true);
  });

  it("takes the generation one past the published root's", async () => {
    setSite(SITE);
    const published = Math.floor(Date.now() / 1000) + 5000;
    stubFetch(() => ({
      body: JSON.stringify({ flat: null, generated_at: "2026-10-21T08:00:00Z", generation: published, planes: { catalog: null, enrich: null }, schema: 1, search: null, stats: null }),
    }));

    await enrich(dir, {});

    expect(readHandoff(dir)?.generation).toBe(published + 1);
  });

  it("IX-R06 ignores a published generation more than a day ahead, with a warning", async () => {
    setSite(SITE);
    const before = Math.floor(Date.now() / 1000);
    stubFetch(() => ({
      body: JSON.stringify({ flat: null, generated_at: "2026-10-21T08:00:00Z", generation: before + 3 * 86_400, planes: { catalog: null, enrich: null }, schema: 1, search: null, stats: null }),
    }));

    await enrich(dir, {});

    const generation = readHandoff(dir)!.generation;
    expect(generation).toBeGreaterThanOrEqual(before);
    expect(generation).toBeLessThan(before + 86_400);
    expect(vi.mocked(console.warn).mock.calls.flat().join("\n")).toMatch(/published generation/);
  });

  it("still hands off when a majority of packages fail (exit 69), so build deploys what was carried", async () => {
    addPackage("foo", "ghcr.io/acme/skills/foo");
    grim = async () => {
      throw new Error("registry down");
    };

    await expect(enrich(dir, {})).rejects.toMatchObject({ code: EXIT.unavailable });

    expect(readHandoff(dir)).not.toBeNull();
  });

  it("leaves no hand-off from an earlier run when the grim is too old to start", async () => {
    addPackage("foo", "ghcr.io/acme/skills/foo");
    await enrich(dir, {});
    expect(readHandoff(dir)).not.toBeNull();

    vi.mocked(grimVersion).mockResolvedValueOnce("0.1.0");
    await expect(enrich(dir, {})).rejects.toMatchObject({ code: EXIT.unavailable });

    expect(readHandoff(dir)).toBeNull();
    expect(fs.existsSync(state("out"))).toBe(false);
  });

  it("writes no hand-off when the refresh itself throws, and drops a stale one", async () => {
    addPackage("foo", "ghcr.io/acme/skills/foo");
    await enrich(dir, {});
    expect(readHandoff(dir)).not.toBeNull();

    vi.mocked(enrichIndex).mockRejectedValueOnce(new Error("boom"));
    await expect(enrich(dir, {})).rejects.toMatchObject({ code: EXIT.unavailable });

    expect(readHandoff(dir)).toBeNull();
  });
});

describe("enrich counters and time budget (IX-R43, spec §5.9)", () => {
  it("hands the refresh's counters to the build", async () => {
    addPackage("foo", "ghcr.io/acme/skills/foo");

    await enrich(dir, {});

    expect(readHandoff(dir)!.counters).toMatchObject({ probed: 0, deep: 1, calls: 3, enrich: "complete", budget_min: 85, throttled: 0 });
  });

  it("a job timeout with no room left starts no ref, hands off, and says the budget ran out", async () => {
    vi.stubEnv("CI_JOB_TIMEOUT", "60");
    addPackage("foo", "ghcr.io/acme/skills/foo");

    expect(await enrich(dir, {})).toBe(EXIT.ok);

    expect(calls).toEqual([]);
    expect(readHandoff(dir)!.counters).toMatchObject({ enrich: "budget", budget_min: 0, deep: 0 });
    const warned = vi.mocked(console.warn).mock.calls.flat().join("\n");
    expect(warned).toMatch(/re-render required/);
    expect(warned).toMatch(/budget ran out/);
  });
});

describe("enrich --seed restores the published plane (IX-R36, V-29)", () => {
  const rootBody = (enrichRef: unknown, generation = 1_792_000_000): string =>
    JSON.stringify({ flat: null, generated_at: "2026-10-21T08:00:00Z", generation, planes: { catalog: null, enrich: enrichRef }, schema: 1, search: null, stats: null });

  it("reads the root, restores enrich/ from the store, and downloads nothing that did not move", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-21T08:00:00Z"));
    setSite(SITE);
    addPackage("foo", "ghcr.io/acme/skills/foo");
    stubFetch(() => null); // first deploy: no root yet
    await enrich(dir, { seed: true });
    const first = tree(path.join(dir, "enrich"));
    expect(Object.keys(first).sort()).toEqual([
      "github.com/acme/foo/changelog.md",
      "github.com/acme/foo/contents.md",
      "github.com/acme/foo/data.json",
      "github.com/acme/foo/logo.png",
      "github.com/acme/foo/readme.md",
    ]);
    const published = readHandoff(dir)!.planes.enrich;

    // A fresh checkout: no enrich/, the blob store restored from CI cache.
    fs.rmSync(path.join(dir, "enrich"), { recursive: true });
    fs.rmSync(state("out"), { recursive: true });
    calls.length = 0;
    const fetched = stubFetch(() => ({ body: rootBody(published) }));

    await enrich(dir, { seed: true });

    expect(fetched).toHaveLength(1);
    expect(fetched[0]?.url).toMatch(/^https:\/\/index\.example\.test\/c\/root\.json\?/);
    expect(tree(path.join(dir, "enrich"))).toEqual(first);
    expect(calls.filter((a) => a[0] === "fetch" && !a.includes("--digest-only"))).toEqual([]);
  });

  it("a companion over the blob cap is written capped, so a restored rebuild is byte-identical", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-21T08:00:00Z"));
    const big = "x".repeat(BLOB_CAP + 512 * 1024);
    grim = async (args) => {
      calls.push(args);
      if (args[0] === "describe") return { ...DESCRIBE };
      if (args.includes("--digest-only")) return { digest: args.includes("--description") ? "sha256:aaa" : "sha256:art" };
      if (!args.includes("--description")) return { content: "# Entry\n" };
      return { digest: "sha256:aaa", files: [{ path: "README.md", content: big }, { path: "CHANGELOG.md", content: big }] };
    };
    setSite(SITE);
    addPackage("foo", "ghcr.io/acme/skills/foo");
    stubFetch(() => null);
    await enrich(dir, { seed: true });
    const first = tree(path.join(dir, "enrich"));
    expect(fs.statSync(path.join(dir, "enrich/github.com/acme/foo/readme.md")).size).toBe(BLOB_CAP);
    const published = readHandoff(dir)!.planes.enrich;

    fs.rmSync(path.join(dir, "enrich"), { recursive: true });
    fs.rmSync(state("out"), { recursive: true });
    calls.length = 0;
    stubFetch(() => ({ body: rootBody(published) }));
    await enrich(dir, { seed: true });

    expect(tree(path.join(dir, "enrich"))).toEqual(first);
    expect(calls.filter((a) => a[0] === "fetch" && !a.includes("--digest-only"))).toEqual([]);
  });

  it("starts the enrich budget before the restore, so a slow restore spends it", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-21T08:00:00Z"));
    // 40 min of job leaves 5 min of budget after the 35 min reserve.
    vi.stubEnv("CI_JOB_TIMEOUT", String(40 * 60));
    setSite(SITE);
    addPackage("foo", "ghcr.io/acme/skills/foo");
    stubFetch(() => {
      vi.setSystemTime(new Date("2026-10-21T08:06:00Z"));
      return null;
    });

    await enrich(dir, {});

    expect(calls.filter((a) => a[0] === "describe")).toEqual([]);
  });

  it("hands --fresh to the refresh, which needs it to drop a failing ref's old sidecar", async () => {
    addPackage("foo", "ghcr.io/acme/skills/foo");

    await enrich(dir, { fresh: true });
    await enrich(dir, {});

    const [fresh, plain] = vi.mocked(enrichIndex).mock.calls.slice(-2);
    expect(fresh?.[0].fresh).toBe(true);
    expect(plain?.[0].fresh).toBe(false);
  });

  it("restores without --seed too: the anchor read happens whenever the site qualifies", async () => {
    setSite(SITE);
    addPackage("foo", "ghcr.io/acme/skills/foo");
    stubFetch(() => null);
    await enrich(dir, {});
    const published = readHandoff(dir)!.planes.enrich;
    fs.rmSync(path.join(dir, "enrich"), { recursive: true });
    calls.length = 0;
    const fetched = stubFetch(() => ({ body: rootBody(published) }));

    await enrich(dir, {});

    expect(fetched).toHaveLength(1);
    expect(calls.filter((a) => a[0] === "fetch" && !a.includes("--digest-only"))).toEqual([]);
  });

  it.each([
    ["no site", undefined],
    ["an http site that is not loopback", "http://index.example.test"],
  ])("IX-R28 builds cold with no request when there is %s", async (_name, site) => {
    if (site) setSite(site);
    addPackage("foo", "ghcr.io/acme/skills/foo");
    const fetched = stubFetch(() => ({ body: rootBody(null) }));

    expect(await enrich(dir, { seed: true })).toBe(EXIT.ok);

    expect(fetched).toEqual([]);
    expect(readHandoff(dir)).not.toBeNull();
  });

  it("IX-R28 an unusable restored store still enriches everything and hands off", async () => {
    setSite(SITE);
    addPackage("foo", "ghcr.io/acme/skills/foo");
    // The root names a plane the store does not hold.
    stubFetch(() => ({ body: rootBody({ sha256: "c".repeat(64), size: 10 }) }));

    expect(await enrich(dir, { seed: true })).toBe(EXIT.ok);

    expect(fs.existsSync(path.join(dir, "enrich/github.com/acme/foo/readme.md"))).toBe(true);
    expect(readHandoff(dir)).not.toBeNull();
  });
});
