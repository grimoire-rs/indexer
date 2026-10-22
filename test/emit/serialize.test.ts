// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Grimoire Authors

import { describe, expect, it } from "vitest";

import { serializeDeterministic } from "../../src/emit/serialize.js";

describe("serializeDeterministic", () => {
  it('IX-R03 P-3 sorts keys in byte order ("0a" before "10", "10" before "2")', () => {
    // JS enumerates the integer-like keys first, so this input arrives as 2, 10, 0a.
    expect(serializeDeterministic({ "2": 3, "10": 2, "0a": 1 })).toBe('{"0a":1,"10":2,"2":3}');
  });

  it("IX-R03 P-3 orders by UTF-8 bytes, not UTF-16 code units", () => {
    // U+FF5E is EF BD 9E, U+1F600 is F0 9F 98 80, but UTF-16 puts the surrogate pair first.
    const keys = Object.keys(JSON.parse(serializeDeterministic({ "\u{1F600}": 1, "～": 2 })));
    expect(keys).toEqual(["～", "\u{1F600}"]);
  });

  it("IX-R03 P-3 does not depend on insertion order, lone surrogates included", () => {
    const forward = { b: 1, a: { "10": 1, "0a": 2 }, "\ud800": 3, "\ud801": 4 };
    const backward = { "\ud801": 4, "\ud800": 3, a: { "0a": 2, "10": 1 }, b: 1 };
    expect(serializeDeterministic(backward)).toBe(serializeDeterministic(forward));
  });

  it("IX-R03 serialize(parse(x)) == x, nested, with no insignificant whitespace", () => {
    const x = '{"0a":[1,{"10":null,"2":"é"}],"b":true}';
    expect(serializeDeterministic(JSON.parse(x))).toBe(x);
  });

  it("IX-R03 P-3 golden bytes of a plane-shaped document", () => {
    const doc = { schema: 1, plane: "enrich", buckets: { "ff": { size: 2 }, "10": { size: 1 }, "0a": { size: 0 } } };
    expect(serializeDeterministic(doc)).toBe(
      '{"buckets":{"0a":{"size":0},"10":{"size":1},"ff":{"size":2}},"plane":"enrich","schema":1}',
    );
  });

  it("IX-R03 skips undefined members, as JSON.stringify does", () => {
    expect(serializeDeterministic({ a: undefined, b: [undefined, 1] })).toBe('{"b":[null,1]}');
  });

  it("IX-R03 ends with one newline only when asked (the root)", () => {
    expect(serializeDeterministic({ a: 1 })).toBe('{"a":1}');
    expect(serializeDeterministic({ a: 1 }, { trailingNewline: true })).toBe('{"a":1}\n');
  });
});
