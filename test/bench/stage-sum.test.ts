// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Grimoire Authors

import { describe, expect, it } from "vitest";

// @ts-expect-error -- a plain .mjs benchmark helper, no declaration file
import { NFR1, stageSum } from "../../scripts/lib/stage-sum.mjs";

describe("stageSum (V-19, NFR-1)", () => {
  it("passes a leg that fits every slot and sums to the 115 minute total", () => {
    expect(stageSum(85, 15)).toEqual({ sum: NFR1.totalMin, ok: true });
    expect(stageSum(0, 0)).toEqual({ sum: 15, ok: true });
  });

  it("fails an enrich stage past its 85 minute slot, even when the total would hold", () => {
    expect(stageSum(86, 1).ok).toBe(false);
  });

  it("fails a build past its 15 minute slot", () => {
    expect(stageSum(10, 16).ok).toBe(false);
  });
});
