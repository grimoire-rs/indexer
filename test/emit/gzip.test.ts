// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Grimoire Authors

import { gunzipSync } from "node:zlib";

import { describe, expect, it } from "vitest";

import { gzipDeterministic } from "../../src/emit/gzip.js";

const input = new TextEncoder().encode("grim ".repeat(2000));

describe("gzipDeterministic", () => {
  it("IX-R52 equal input gives equal bytes", () => {
    expect(gzipDeterministic(input).equals(gzipDeterministic(input))).toBe(true);
  });

  it("IX-R52 header is deflate, no name or comment, mtime 0, level 9, OS byte 0xff", () => {
    const header = [...gzipDeterministic(input).subarray(0, 10)];
    expect(header).toEqual([0x1f, 0x8b, 0x08, 0x00, 0, 0, 0, 0, 0x02, 0xff]);
  });

  it("IX-R52 V-42 inflates back to the input", () => {
    expect(gunzipSync(gzipDeterministic(input)).equals(Buffer.from(input))).toBe(true);
  });

  it("IX-R52 compresses the empty input to a valid member", () => {
    expect(gunzipSync(gzipDeterministic(new Uint8Array())).length).toBe(0);
  });
});
