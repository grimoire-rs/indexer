// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Grimoire Authors

import { describe, expect, it } from "vitest";

import { EPOCH_RENEW_SECONDS, STATE_KEY_RE, formatKey, nextEpoch } from "../../src/state/statekey.js";

const HEX = "a".repeat(64);

describe("STATE_KEY_RE", () => {
  it("accepts <epoch>-<64 lowercase hex>", () => {
    expect(STATE_KEY_RE.test(`1-${HEX}`)).toBe(true);
    expect(STATE_KEY_RE.test(`${"9".repeat(16)}-${HEX}`)).toBe(true);
  });

  it.each([
    ["an epoch carrying a newline and an assignment", `1\nX=y-${HEX}`],
    ["17 epoch digits", `${"1".repeat(17)}-${HEX}`],
    ["63 hex characters", `1-${"a".repeat(63)}`],
    ["65 hex characters", `1-${"a".repeat(65)}`],
    ["uppercase hex", `1-${"A".repeat(64)}`],
    ["no epoch", `-${HEX}`],
    ["a trailing newline", `1-${HEX}\n`],
  ])("rejects %s", (_name, key) => {
    expect(STATE_KEY_RE.test(key)).toBe(false);
  });
});

describe("state_epoch", () => {
  const now = 1_792_000_000;

  it("contract:I2 nextEpoch keeps a published epoch younger than 7 days", () => {
    expect(nextEpoch(now - 3600, now, false)).toBe(now - 3600);
  });

  it("contract:I2 nextEpoch renews when absent, older than 7 days, or on --fresh and --purge", () => {
    expect(nextEpoch(undefined, now, false)).toBe(now);
    expect(nextEpoch(now - EPOCH_RENEW_SECONDS - 1, now, false)).toBe(now);
    expect(nextEpoch(now - 3600, now, true)).toBe(now);
  });

  it("renews strictly after 7 days, not at exactly 7 days", () => {
    expect(nextEpoch(now - EPOCH_RENEW_SECONDS, now, false)).toBe(now - EPOCH_RENEW_SECONDS);
    expect(nextEpoch(now - EPOCH_RENEW_SECONDS + 1, now, false)).toBe(now - EPOCH_RENEW_SECONDS + 1);
    expect(nextEpoch(now - EPOCH_RENEW_SECONDS - 1, now, false)).toBe(now);
  });

  it("renews an epoch more than a day in the future, and keeps one within the day", () => {
    expect(nextEpoch(now + 86_400, now, false)).toBe(now + 86_400);
    expect(nextEpoch(now + 86_401, now, false)).toBe(now);
    expect(nextEpoch(Number.MAX_SAFE_INTEGER, now, false)).toBe(now);
  });

  it("renews on --fresh and --purge even for a young epoch", () => {
    expect(nextEpoch(now - 1, now, true)).toBe(now);
  });

  it.each([
    ["a string with an assignment", "1\nX=y"],
    ["a fraction", 1.5],
    ["a negative", -1],
    ["2^53", 2 ** 53],
    ["null", null],
    ["NaN", Number.NaN],
    ["a numeric string", "5"],
  ])("throws on %s, renew or not", (_name, bad) => {
    expect(() => nextEpoch(bad, now, false)).toThrow();
    expect(() => nextEpoch(bad, now, true)).toThrow();
  });

  it("contract:I2 nextEpoch throws on an epoch that is not a safe integer", () => {
    expect(() => nextEpoch("1\nX=y", now, false)).toThrow();
    expect(() => nextEpoch(2 ** 53, now, false)).toThrow();
  });

  it("contract:I2 formatKey returns a key STATE_KEY_RE accepts and refuses anything else", () => {
    expect(STATE_KEY_RE.test(formatKey(now, HEX))).toBe(true);
    expect(() => formatKey(now, "not-hex")).toThrow();
  });
});
