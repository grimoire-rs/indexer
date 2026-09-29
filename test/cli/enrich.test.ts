// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Grimoire Authors

// `enrich --concurrency`: what reaches the refresh loop, and what is refused
// before it starts. The loop itself is covered in `test/enrich/enrich.test.ts`.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { enrich } from "../../src/cli/enrich.js";
import { EXIT } from "../../src/cli/exit.js";
import { DEFAULT_CONCURRENCY, enrichIndex } from "../../src/enrich/index.js";

vi.mock("../../src/enrich/index.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/enrich/index.js")>()),
  enrichIndex: vi.fn(async () => ({ total: 0, enriched: 0, failures: [] })),
}));

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "index-enrich-cli-"));
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.mocked(enrichIndex).mockClear();
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
