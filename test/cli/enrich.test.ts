// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Grimoire Authors

// `enrich --concurrency` and the grim version gate: what reaches the refresh
// loop, and what is refused before it starts. The loop itself is covered in
// `test/enrich/enrich.test.ts`.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { enrich } from "../../src/cli/enrich.js";
import { EXIT } from "../../src/cli/exit.js";
import { DEFAULT_CONCURRENCY, enrichIndex, grimVersion } from "../../src/enrich/index.js";
import { MARKETPLACE_GRIM_VERSION, MINIMUM_GRIM_VERSION } from "../../src/grim.js";

vi.mock("../../src/enrich/index.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/enrich/index.js")>()),
  enrichIndex: vi.fn(async () => ({
    total: 0,
    enriched: 0,
    failures: [],
    entries: new Map(),
    stamps: {},
    counters: { probed: 0, deep: 0, calls: 0, probe_ms_p50: 0, deep_ms_p50: 0, budget_min: 85, throttled: 0, backoff_refs: 0, enrich: "complete" as const },
  })),
  grimVersion: vi.fn(async (): Promise<string | undefined> => MARKETPLACE_GRIM_VERSION),
}));

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "index-enrich-cli-"));
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.mocked(enrichIndex).mockClear();
  vi.mocked(grimVersion).mockReset().mockResolvedValue(MARKETPLACE_GRIM_VERSION);
  fs.rmSync(dir, { recursive: true, force: true });
});

const reached = (): number | undefined => vi.mocked(enrichIndex).mock.calls[0]?.[0].concurrency;

describe("enrich --concurrency", () => {
  it("leaves the default of 8 to the refresh loop when the flag is absent", async () => {
    expect(await enrich(dir, {})).toBe(EXIT.ok);
    expect(reached()).toBeUndefined();
    expect(DEFAULT_CONCURRENCY).toBe(8);
  });

  it("passes a whole number through", async () => {
    expect(await enrich(dir, { concurrency: "3" })).toBe(EXIT.ok);
    expect(reached()).toBe(3);
  });

  it.each(["0", "-1", "1.5", "1e1", "0x10", "abc", "", " 3", "3 ", "+3"])(
    "refuses %j as a usage error before enriching anything",
    async (value) => {
      await expect(enrich(dir, { concurrency: value })).rejects.toMatchObject({ code: EXIT.usage });
      expect(enrichIndex).not.toHaveBeenCalled();
    },
  );
});

describe("enrich grim version gate", () => {
  const marketplace = (): void => fs.writeFileSync(path.join(dir, "marketplace.toml"), "[marketplace]\nname = \"m\"\n");

  it("refuses a grim below the floor before enriching anything", async () => {
    vi.mocked(grimVersion).mockResolvedValue("0.8.4");
    await expect(enrich(dir, { grim: "/opt/grim" })).rejects.toMatchObject({
      code: EXIT.unavailable,
      message: expect.stringContaining(`grim 0.8.4 at /opt/grim is too old — the indexer needs ${MINIMUM_GRIM_VERSION}`),
    });
    expect(enrichIndex).not.toHaveBeenCalled();
  });

  it("refuses a grim that cannot state its version", async () => {
    vi.mocked(grimVersion).mockResolvedValue("");
    await expect(enrich(dir, {})).rejects.toMatchObject({ code: EXIT.unavailable });
  });

  it("refuses a grim without export marketplace when the index has a marketplace.toml", async () => {
    marketplace();
    vi.mocked(grimVersion).mockResolvedValue("0.14.3");
    await expect(enrich(dir, {})).rejects.toMatchObject({
      code: EXIT.unavailable,
      message: expect.stringContaining(`marketplace.toml needs ${MARKETPLACE_GRIM_VERSION}`),
    });
    expect(enrichIndex).not.toHaveBeenCalled();
  });

  it("accepts that grim when the index has no marketplace", async () => {
    vi.mocked(grimVersion).mockResolvedValue("0.14.3");
    expect(await enrich(dir, {})).toBe(EXIT.ok);
    expect(enrichIndex).toHaveBeenCalled();
  });

  it("leaves a missing grim to the refresh loop", async () => {
    vi.mocked(grimVersion).mockResolvedValue(undefined);
    expect(await enrich(dir, {})).toBe(EXIT.ok);
    expect(enrichIndex).toHaveBeenCalled();
  });

  it("maps a failing --version probe to unavailable", async () => {
    vi.mocked(grimVersion).mockRejectedValue(new Error("timed out"));
    await expect(enrich(dir, {})).rejects.toMatchObject({ code: EXIT.unavailable, message: expect.stringContaining("timed out") });
  });
});

describe("enrich time budget and window (IX-R43)", () => {
  const options = (): { jobTimeoutSeconds?: number; revalidateMs?: number } => vi.mocked(enrichIndex).mock.calls[0]![0];

  it("passes CI_JOB_TIMEOUT through in seconds", async () => {
    vi.stubEnv("CI_JOB_TIMEOUT", "3600");
    expect(await enrich(dir, {})).toBe(EXIT.ok);
    expect(options().jobTimeoutSeconds).toBe(3600);
  });

  it.each(["", "0", "-1", "soon", "1e3"])("treats CI_JOB_TIMEOUT=%j as no timeout", async (value) => {
    vi.stubEnv("CI_JOB_TIMEOUT", value);
    await enrich(dir, {});
    expect(options().jobTimeoutSeconds).toBeUndefined();
  });

  it("passes sync.revalidate through in milliseconds, one hour by default", async () => {
    await enrich(dir, {});
    expect(options().revalidateMs).toBe(3_600_000);

    fs.writeFileSync(path.join(dir, "index.config.json"), JSON.stringify({ sync: { revalidate: "6h" } }));
    vi.mocked(enrichIndex).mockClear();
    await enrich(dir, {});
    expect(options().revalidateMs).toBe(6 * 3_600_000);
  });
});

describe("enrich exit 69 (IX-R40)", () => {
  const counters = { probed: 0, deep: 0, calls: 0, probe_ms_p50: 0, deep_ms_p50: 0, budget_min: 85, throttled: 0, backoff_refs: 0, enrich: "complete" as const };
  const ran = (total: number, failed: number) =>
    vi.mocked(enrichIndex).mockResolvedValueOnce({
      total,
      enriched: total - failed,
      failures: Array.from({ length: failed }, (_, i) => `ghcr.io/acme/p${i}: registry 503`),
      entries: new Map(),
      stamps: {},
      counters,
    });

  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  it("counts every package in the walk, so half of them failing is still exit 0", async () => {
    ran(100, 50);
    expect(await enrich(dir, {})).toBe(EXIT.ok);
  });

  it("fails the run past half of the walk, with its message", async () => {
    ran(100, 51);
    await expect(enrich(dir, {})).rejects.toMatchObject({
      code: EXIT.unavailable,
      message: expect.stringContaining("51/100 package(s) failed"),
    });
  });

  it("does not fail an incremental run that attempted few refs and lost most of them: 60 failed of the 100 it tried, 300 in the walk", async () => {
    ran(300, 60);
    expect(await enrich(dir, {})).toBe(EXIT.ok);
  });
});
