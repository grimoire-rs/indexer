// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Grimoire Authors

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { run } from "../../src/cli/main.js";
import { SiteConfigError, loadConfig, parseSync } from "../../src/config.js";

afterEach(() => {
  vi.restoreAllMocks();
});

const MIN = 60_000;
const defaults = { layout: "flat", legacy: true, revalidateMs: 60 * MIN };

describe("parseSync (spec §5.7)", () => {
  it.each([undefined, {}, { layout: undefined }])("contract:I1 defaults to flat, legacy, 1h for %j", (raw) => {
    expect(parseSync(raw)).toEqual(defaults);
  });

  it("contract:I1 accepts anchored and the revalidate bounds 15m and 7d", () => {
    expect(parseSync({ layout: "anchored" })).toEqual({ ...defaults, layout: "anchored" });
    expect(parseSync({ revalidate: "15m" }).revalidateMs).toBe(15 * MIN);
    expect(parseSync({ revalidate: "168h" }).revalidateMs).toBe(168 * 60 * MIN);
    expect(parseSync({ revalidate: "7d" }).revalidateMs).toBe(7 * 24 * 60 * MIN);
    expect(parseSync({ revalidate: "10080m" }).revalidateMs).toBe(7 * 24 * 60 * MIN);
    expect(parseSync({ revalidate: "90m" }).revalidateMs).toBe(90 * MIN);
  });

  it("contract:I1 accepts legacy: false with anchored", () => {
    expect(parseSync({ layout: "anchored", legacy: false }).legacy).toBe(false);
  });

  it.each([
    ["the reserved layout tree", { layout: "tree" }, /layout/],
    ["an unknown layout", { layout: "flatten" }, /layout/],
    ["legacy: false with layout flat", { legacy: false }, /layout.*legacy|legacy.*layout/],
    ["a non-boolean legacy", { legacy: "no" }, /legacy/],
    ["revalidate under 15m", { revalidate: "14m" }, /revalidate/],
    ["revalidate over 7d", { revalidate: "8d" }, /revalidate/],
    ["revalidate 0h", { revalidate: "0h" }, /revalidate/],
    ["revalidate over 7d in hours", { revalidate: "169h" }, /revalidate/],
    ["revalidate over 7d in minutes", { revalidate: "10081m" }, /revalidate/],
    ["a leading zero in revalidate", { revalidate: "015m" }, /revalidate/],
    ["revalidate without a unit", { revalidate: "60" }, /revalidate/],
    ["a null revalidate", { revalidate: null }, /revalidate/],
    ["a null layout", { layout: null }, /layout/],
    ["a compound revalidate", { revalidate: "1h30m" }, /revalidate/],
    ["a numeric revalidate", { revalidate: 3600 }, /revalidate/],
    ["a string sync", "flat", /sync/],
    ["an array sync", [], /sync/],
    ["a null sync", null, /sync/],
  ])("contract:I1 exits 65 (SiteConfigError) for %s", (_name, raw, key) => {
    expect(() => parseSync(raw)).toThrow(SiteConfigError);
    expect(() => parseSync(raw)).toThrow(key);
  });

  it("contract:I1 warns on an unknown key inside sync and still resolves", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(parseSync({ layuot: "anchored" })).toEqual(defaults);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("layuot"));
  });
});

describe("loadConfig", () => {
  let dir: string;

  const write = (config: unknown) => fs.writeFileSync(path.join(dir, "index.config.json"), JSON.stringify(config));

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "index-sync-"));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("contract:I1 knows sync: no unknown-key warning for it", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    write({ sync: { layout: "anchored" } });
    await loadConfig(dir);
    expect(warn).not.toHaveBeenCalledWith(expect.stringContaining("`sync`"));
  });

  it("IX-R01 carries the resolved sync block", async () => {
    write({ sync: { layout: "anchored", legacy: false, revalidate: "2h" } });
    expect((await loadConfig(dir)).sync).toEqual({ layout: "anchored", legacy: false, revalidateMs: 120 * MIN });
  });

  it.each([
    ["a file with no sync key", {}],
    ["no file at all", undefined],
  ])("IX-R01 carries the defaults for %s", async (_name, config) => {
    if (config !== undefined) write(config);
    expect((await loadConfig(dir)).sync).toEqual(defaults);
  });

  it("IX-R01 rejects an invalid sync block with the file name in the message", async () => {
    write({ sync: { legacy: false } });
    await expect(loadConfig(dir)).rejects.toThrow(/^index\.config\.json: .*legacy/);
  });

  // §5.7: an older indexer has no `sync` in KNOWN_KEYS and builds flat. This is
  // the text it prints for an unread key, which the docs quote.
  it("IX-R01 pins the unknown-key warning an older indexer prints for sync", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    write({ syncs: {} });
    await loadConfig(dir);
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/^warn: index\.config\.json sets `syncs`, which nothing reads/));
  });

  it("IX-R01 warns for an unknown key inside sync with the same text", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    write({ sync: { layuot: "anchored" } });
    await loadConfig(dir);
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/^warn: index\.config\.json sets `sync\.layuot`, which nothing reads/));
  });

  it.each([
    ["the reserved layout tree", { layout: "tree" }],
    ["legacy: false with layout flat", { legacy: false }],
  ])("IX-R01 build exits 65 for %s", async (_name, sync) => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const errors: string[] = [];
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => errors.push(args.map(String).join(" ")));
    write({ sync });
    expect(await run(["node", "grim-indexer", "build", dir])).toBe(65);
    expect(errors.join("\n")).toMatch(/sync/);
    // The first `build` in a worker imports the renderer, which outlasts the 5 s default on a loaded runner.
  }, 60_000);
});
