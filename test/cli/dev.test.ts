// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Grimoire Authors

// `--host`'s translation into Astro's `server.host`. The rejections are in
// `exit-codes.test.ts` with every other usage error; this is the other half —
// the shapes that must survive, because getting one of them wrong binds the
// wrong interface and the symptom is a connection that hangs rather than an
// error anyone sees.
import { describe, expect, it } from "vitest";

import { resolveHost } from "../../src/cli/dev.js";

describe("resolveHost", () => {
  it("leaves the loopback default alone when the flag is absent", () => {
    expect(resolveHost(undefined)).toBeUndefined();
  });

  // Commander hands back `true` for a bare `--host`, which is Astro's own
  // spelling for "every interface" — the form a dev container or a WSL guest
  // needs, and the one the dev server's banner tells people to reach for.
  it("passes the bare flag through as `true`", () => {
    expect(resolveHost(true)).toBe(true);
  });

  it("passes an address through, trimmed", () => {
    expect(resolveHost("0.0.0.0")).toBe("0.0.0.0");
    expect(resolveHost("::")).toBe("::");
    expect(resolveHost("192.168.1.10")).toBe("192.168.1.10");
    expect(resolveHost("dev.internal")).toBe("dev.internal");
    expect(resolveHost("  0.0.0.0  ")).toBe("0.0.0.0");
  });

  it("refuses what cannot be an address", () => {
    for (const bad of ["", "   ", "http://0.0.0.0", "1.2.3.4/24", "a b"]) {
      expect(() => resolveHost(bad), bad).toThrow(/--host/);
    }
  });
});
