// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Grimoire Authors

// `readIndexFile`'s three outcomes are a security contract, not a convenience:
// `missing` means "an owner deleted this" and authorizes a merge, so anything
// that is not provably absent must not land there.
import { describe, expect, it } from "vitest";

import { readIndexFile } from "../../src/validate/adapters/files.js";
import { makeTree } from "./helpers.js";

describe("readIndexFile", () => {
  it("reads a file that is there", async () => {
    const root = await makeTree({ "index/a.json": "{}" });
    expect(await readIndexFile(root, "index/a.json")).toEqual({ kind: "text", text: "{}" });
  });

  it("calls a genuinely absent path missing", async () => {
    const root = await makeTree({});
    expect(await readIndexFile(root, "index/gone.json")).toEqual({ kind: "missing" });
  });

  // A regular file where a directory should be. ENOTDIR is as conclusive as
  // ENOENT — nothing is at that path and nothing can be — so it stays
  // `missing`; a pull request that creates the blocking file also lists it,
  // and the path gate refuses that.
  it("calls a path blocked by a file missing", async () => {
    const root = await makeTree({ "index/pkg": "not a directory" });
    expect(await readIndexFile(root, "index/pkg/metadata.json")).toEqual({ kind: "missing" });
  });

  // The one this file exists for. Every `lstat` errno used to collapse into
  // `missing`, so an unreadable path was indistinguishable from an absent
  // one — and once `missing` came to mean "authorized deletion", that turned
  // a filesystem fault into a pass. ENAMETOOLONG is the errno reachable from
  // a test: the segments are all legal, the resolved path is not.
  it("does not call an unreadable path missing", async () => {
    const root = await makeTree({});
    const tooLong = Array.from({ length: 45 }, () => "x".repeat(100)).join("/");

    const read = await readIndexFile(root, tooLong);

    expect(read.kind, "an errno that is not absence must not read as absence").toBe("error");
    expect(read).toMatchObject({ reason: expect.stringContaining("ENAMETOOLONG") as unknown });
  });

  it("refuses a path that escapes the index root", async () => {
    const root = await makeTree({});
    expect((await readIndexFile(root, "../outside.json")).kind).toBe("error");
  });
});
