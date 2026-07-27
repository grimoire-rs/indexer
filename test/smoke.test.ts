// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Grimoire Authors

// ponytail: proves the vitest harness runs on the bare skeleton. Delete once
// real subcommand tests land.
import { describe, expect, it } from "vitest";

describe("skeleton", () => {
  it("runs", () => {
    expect(true).toBe(true);
  });
});
