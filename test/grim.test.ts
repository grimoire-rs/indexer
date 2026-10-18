// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Grimoire Authors

// The grim version floor and the per-feature versions above it.
import { describe, expect, it } from "vitest";

import {
  MARKETPLACE_GRIM_VERSION,
  MINIMUM_GRIM_VERSION,
  grimTooOld,
  isNewerVersion,
  parseGrimVersion,
  supportsMarketplaceExport,
  tooOldMessage,
} from "../src/grim.js";

describe("grim versions", () => {
  it("compares x.y.z numerically, not as text", () => {
    expect(isNewerVersion("0.10.0", "0.9.9")).toBe(true);
    expect(isNewerVersion("0.9.9", "0.10.0")).toBe(false);
    expect(isNewerVersion("1.2.3", "1.2.3")).toBe(false);
  });

  it("reads the version out of `grim --version`", () => {
    expect(parseGrimVersion("grim 0.14.3\n")).toBe("0.14.3");
    expect(parseGrimVersion("grim\n")).toBe("");
  });

  it("refuses below the floor, and an unparseable version", () => {
    expect(grimTooOld(MINIMUM_GRIM_VERSION)).toBe(false);
    expect(grimTooOld("0.8.4")).toBe(true);
    expect(grimTooOld("")).toBe(true);
  });

  it("gates the marketplace export on its own version", () => {
    expect(supportsMarketplaceExport("0.14.3")).toBe(false);
    expect(supportsMarketplaceExport(MARKETPLACE_GRIM_VERSION)).toBe(true);
    expect(isNewerVersion(MARKETPLACE_GRIM_VERSION, MINIMUM_GRIM_VERSION)).toBe(true);
  });

  it("names the binary and the version it needs", () => {
    expect(tooOldMessage("/usr/bin/grim", "0.8.4")).toContain(`grim 0.8.4 at /usr/bin/grim is too old — the indexer needs ${MINIMUM_GRIM_VERSION}`);
    expect(tooOldMessage("grim", "")).toContain("grim of unknown version");
  });
});
