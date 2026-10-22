// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Grimoire Authors

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { STATE_DIR, readHandoff, type Handoff } from "../../src/state/handoff.js";

const handoff: Handoff = {
  generation: 1_792_560_000,
  planes: { enrich: { sha256: "7".repeat(64), size: 66_000 } },
  state_epoch: 1_792_000_000,
  next_key: `1792000000-${"b".repeat(64)}`,
  counters: {
    retained_files: 262,
    retained_skipped: 0,
    probed: 17_143,
    deep: 2_857,
    calls: 42_857,
    probe_ms_p50: 300,
    deep_ms_p50: 300,
    budget_min: 85,
    throttled: 0,
    backoff_refs: 0,
    enrich: "complete",
    failed_buckets: 0,
  },
};

let root: string;
const write = (text: string): void => {
  fs.mkdirSync(path.join(root, STATE_DIR, "out"), { recursive: true });
  fs.writeFileSync(path.join(root, STATE_DIR, "out", "handoff.json"), text);
};

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "index-handoff-"));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("readHandoff (IX-R35)", () => {
  it("contract:I2 STATE_DIR is .grim-index-state and the hand-off is <state>/out/handoff.json", () => {
    expect(STATE_DIR).toBe(".grim-index-state");
    write(JSON.stringify(handoff));
    expect(readHandoff(root)).toEqual(handoff);
  });

  it("contract:I2 returns null when there is no hand-off", () => {
    expect(readHandoff(root)).toBeNull();
  });

  it.each([
    ["unparseable JSON", "{"],
    ["a non-object", "[]"],
    ["a non-integer generation", JSON.stringify({ ...handoff, generation: "1" })],
    ["an untyped planes.enrich", JSON.stringify({ ...handoff, planes: { enrich: "x" } })],
    ["a missing state_epoch", JSON.stringify({ ...handoff, state_epoch: undefined })],
    ["a generation more than a day ahead of the clock", JSON.stringify({ ...handoff, generation: Math.floor(Date.now() / 1000) + 2 * 86_400 })],
    ["the largest safe generation", JSON.stringify({ ...handoff, generation: Number.MAX_SAFE_INTEGER })],
  ])("contract:I2 returns null for %s, so build warns and deploys", (_name, text) => {
    write(text);
    expect(readHandoff(root)).toBeNull();
  });
});

describe("readHandoff (generation)", () => {
  it("accepts a generation within the day of skew the root allows", () => {
    const generation = Math.floor(Date.now() / 1000) + 3600;
    write(JSON.stringify({ ...handoff, generation }));
    expect(readHandoff(root)?.generation).toBe(generation);
  });
});
