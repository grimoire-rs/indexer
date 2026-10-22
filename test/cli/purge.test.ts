// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Grimoire Authors

import { describe, expect, it } from "vitest";

import { parsePurge } from "../../src/cli/enrich.js";
import { CliError, EXIT } from "../../src/cli/exit.js";

const HEX = "ab".repeat(32);

describe("parsePurge (IX-R10, spec §5.6)", () => {
  it("64 lowercase hex is a blob digest", () => {
    expect(parsePurge(HEX)).toEqual({ digest: HEX });
  });

  it("a well-formed <host>/<repository> is a ref", () => {
    expect(parsePurge("ghcr.io/acme/code-review")).toEqual({ ref: "ghcr.io/acme/code-review" });
  });

  it.each([
    ["empty", ""],
    ["a bare sha256: prefix", "sha256:"],
    ["63 hex characters", HEX.slice(1)],
    ["65 hex characters", `${HEX}a`],
    ["uppercase hex", HEX.toUpperCase()],
    ["a path", "../x"],
  ])("%s is exit 65, thrown synchronously before any I/O", (_name, arg) => {
    let thrown: unknown;
    try {
      parsePurge(arg);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(CliError);
    expect((thrown as CliError).code).toBe(EXIT.data);
  });
});
