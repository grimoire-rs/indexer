// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Grimoire Authors

import { describe, expect, it } from "vitest";

import { boundRecord, stripControls } from "../../src/emit/records.js";

const KiB = 1024;
const base = { schema: 1, name: "code-review", kind: "skill", ref: "ghcr.io/acme/code-review", description: "d" };
const bytes = (s: string) => Buffer.byteLength(s);
const bound = (extra: Record<string, unknown>): Record<string, unknown> => boundRecord({ ...base, ...extra });

describe("boundRecord (IX-R30)", () => {
  it("contract:I1 clamps a 1 MiB description to 16 KiB at a character boundary and keeps every key", () => {
    const rec = { ...base, description: "é".repeat(512 * KiB) };
    const out = boundRecord(rec);
    expect(Object.keys(out)).toEqual(Object.keys(rec));
    expect(out.description).toBe("é".repeat(8 * KiB));
  });

  it.each([
    ["summary", KiB],
    ["title", 256],
    ["version", 128],
    ["license", 256],
    ["revision", 128],
    ["vendor", 256],
    ["created", 64],
    ["deprecated", KiB],
    ["replacedBy", 512],
    ["replaced_by", 512],
    ["url", 2 * KiB],
    ["documentation", 2 * KiB],
    ["compatibility", 2 * KiB],
    ["repository", 2 * KiB],
  ])("contract:I1 clamps %s to %i bytes", (field, bound) => {
    const out: Record<string, unknown> = boundRecord({ ...base, [field]: "a".repeat(bound * 4) });
    expect(out[field]).toBe("a".repeat(bound));
  });

  it.each([
    ["keywords", 32, 64],
    ["tags", 128, 64],
    ["authors", 16, 256],
  ])("clamps %s to %i elements of %i bytes", (field, count, item) => {
    const out = bound({ [field]: Array.from({ length: count * 4 }, () => "k".repeat(item * 4)) });
    expect(out[field]).toEqual(Array.from({ length: count }, () => "k".repeat(item)));
  });

  // `describe` reports `authors` as one string, never a list.
  it("clamps an authors string to the 16 x 256 byte total", () => {
    expect(bound({ authors: "a".repeat(10 * KiB) }).authors).toBe("a".repeat(4 * KiB));
  });

  it("clamps each support channel to 2 KiB and keeps the channel set", () => {
    const channels = ["issues", "chat", "contact", "security"];
    const support = Object.fromEntries(channels.map((c) => [c, "s".repeat(8 * KiB)]));
    const out = bound({ support });
    expect(out.support).toEqual(Object.fromEntries(channels.map((c) => [c, "s".repeat(2 * KiB)])));
  });

  it("never splits a code point or a surrogate pair at the cut", () => {
    // 4-byte code points against a 64 B bound that is not a multiple of 4 minus 1.
    const out = bound({ created: "😀".repeat(40) });
    expect(out.created).toBe("😀".repeat(16));
    // 3-byte code points against 128 B: 42 fit (126 B), the 43rd would end at 129.
    expect(bound({ version: "€".repeat(100) }).version).toBe("€".repeat(42));
  });

  it("clamps in place: a field over its bound stays where it was", () => {
    const rec = { ...base, summary: "s".repeat(5 * KiB), tags: ["t"], title: "t" };
    expect(Object.keys(boundRecord(rec))).toEqual(Object.keys(rec));
  });

  it("returns a benign record unchanged", () => {
    const rec = {
      ...base,
      owner: { github: "acme", id: 1 },
      namespace: "github.com/acme",
      title: "code-review",
      summary: "Review a diff.",
      keywords: ["review", "diff"],
      tags: ["latest", "1.2.3"],
      deprecated: null,
      authors: "The Acme Authors",
      support: { issues: "https://example.test/issues" },
      hasReadme: true,
      logo: "/logos/github.com/acme/code-review.png",
    };
    expect(JSON.stringify(boundRecord(rec))).toBe(JSON.stringify(rec));
  });

  it("leaves the identity keys alone, whatever their length", () => {
    const rec = { ...base, ref: `ghcr.io/${"a".repeat(5 * KiB)}`, namespace: "n".repeat(5 * KiB), owner: { id: 1, github: "acme" } };
    expect(boundRecord(rec)).toEqual(rec);
  });

  it("keeps a __proto__ key as an own key", () => {
    const rec = JSON.parse('{"name":"a","__proto__":"x"}') as Record<string, unknown>;
    const out = boundRecord(rec);
    expect(Object.keys(out)).toEqual(["name", "__proto__"]);
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype);
  });

  it("nulls a listed text key whose value has the wrong shape and empties a list, keeping the key", () => {
    const wrong = { title: 5, summary: { a: 1 }, keywords: "x", tags: ["a", 1], support: "x", authors: 7 };
    expect(bound(wrong)).toEqual({ ...base, title: null, summary: null, keywords: [], tags: [], support: null, authors: [] });
    expect(bound({ support: { issues: 5, chat: "c" } }).support).toEqual({ issues: null, chat: "c" });
  });

  it("strips controls from every listed field, keeping tab and line feed in description and deprecated only", () => {
    const out = bound({
      description: "a\tb\nc‮d",
      deprecated: "x\ny​z",
      summary: "s\nt\u0007u",
      keywords: ["k⁦w"],
      support: { issues: "i؜j" },
      authors: "a᠎b",
    });
    expect(out).toMatchObject({
      description: "a\tb\ncd",
      deprecated: "x\nyz",
      summary: "stu",
      keywords: ["kw"],
      support: { issues: "ij" },
      authors: "ab",
    });
  });

  it("strips before it cuts, so invisible characters do not spend the bound", () => {
    expect(bound({ title: `${"​".repeat(300)}title` }).title).toBe("title");
  });

  it("leaves no dangling tag characters when the cut lands inside a flag tag sequence", () => {
    const flag = "\u{1F3F4}\u{E0067}\u{E0062}\u{E0065}\u{E006E}\u{E0067}\u{E007F}";
    // 'created' is 64 B: 52 B of text, then the flag glyph (4 B) and two of its 4 B tags.
    const out = bound({ created: `${"a".repeat(52)}${flag}` }).created as string;
    expect(out).toContain("\u{1F3F4}");
    expect(out).not.toMatch(/[\u{E0001}\u{E0020}-\u{E007F}]/u);
    expect(bytes(out)).toBeLessThanOrEqual(64);
  });

  it("is idempotent, so a record clamped on ingest emits unchanged", () => {
    const rec: Record<string, unknown> = {
      ...base,
      description: `${"d\n".repeat(20 * KiB)}‮`,
      keywords: Array.from({ length: 100 }, (_, i) => `kw${i}​${"x".repeat(100)}`),
      support: { issues: "i".repeat(5 * KiB), extra: "e".repeat(3 * KiB) },
      authors: "a".repeat(9 * KiB),
      "created⁦": "c",
    };
    for (let i = 0; i < 20; i++) rec[`extra${i}`] = i % 2 ? "x".repeat(2 * KiB) : ["y".repeat(300), "z", "w".repeat(256)];
    rec.matrix = { a: 1 };
    rec.big = { pad: "p".repeat(10 * KiB) };
    const once = boundRecord(rec);
    expect(boundRecord(once)).toEqual(once);
    expect(JSON.stringify(boundRecord(once))).toBe(JSON.stringify(once));
  });
});

// grim 0.14.3 deserializes `all.json` with these fields required: one `null` drops the whole index.
describe("boundRecord fields grim reads as required", () => {
  it.each([
    ["null", null],
    ["a list with a non-string", [1, 2]],
    ["an object", { a: 1 }],
  ])("empties keywords, tags and authors given %s", (_shape, value) => {
    expect(bound({ keywords: value, tags: value, authors: value })).toMatchObject({ keywords: [], tags: [], authors: [] });
  });

  it("empties keywords and tags given a string", () => {
    expect(bound({ keywords: "single", tags: "single" })).toMatchObject({ keywords: [], tags: [] });
  });

  it("empties authors given a number", () => {
    expect(bound({ authors: 5 }).authors).toEqual([]);
  });

  it("keeps an authors string as text, a valid list byte for byte, and an absent list absent", () => {
    expect(bound({ authors: "x" }).authors).toBe("x");
    const rec = { ...base, keywords: ["a"], tags: [], authors: ["b"] };
    expect(JSON.stringify(boundRecord(rec))).toBe(JSON.stringify(rec));
    expect("keywords" in bound({})).toBe(false);
    expect("tags" in bound({ description: undefined })).toBe(false);
  });

  it.each([
    ["ref", 5],
    ["ref", null],
    ["ref", {}],
    ["ref", ["ghcr.io/a/b"]],
    ["name", 5],
    ["name", null],
    ["kind", {}],
    ["namespace", 5],
    ["namespace", null],
    ["namespace", ["ns"]],
  ])("empties the identity string %s given %j", (key, value) => {
    expect(bound({ [key]: value })[key]).toBe("");
  });

  it("keeps schema when it is an integer in the u32 range and zeroes anything else", () => {
    expect(bound({ schema: 2 }).schema).toBe(2);
    expect(bound({ schema: 4294967295 }).schema).toBe(4294967295);
    for (const schema of ["1", null, 1.5, -1, 4294967296, {}, [1], true]) expect(bound({ schema }).schema, String(schema)).toBe(0);
  });

  it("still strips an identity string and leaves a text field's wrong shape null", () => {
    expect(bound({ name: "n\u202E" }).name).toBe("n");
    expect(bound({ description: 123 }).description).toBeNull();
    expect(bound({ title: ["x"] }).title).toBeNull();
  });

  it("is idempotent over a record of every wrong shape", () => {
    const once = bound({ schema: "1", name: 5, kind: null, ref: {}, namespace: [], keywords: "x", tags: null, authors: 5, description: 123 });
    expect(once).toEqual({ schema: 0, name: "", kind: "", ref: "", description: null, namespace: "", keywords: [], tags: [], authors: [] });
    expect(boundRecord(once)).toEqual(once);
    expect(JSON.stringify(boundRecord(once))).toBe(JSON.stringify(once));
  });
});

describe("boundRecord unlisted keys (IX-R30)", () => {
  const unlistedBytes = (out: Record<string, unknown>) =>
    Object.entries(out)
      .filter(([k]) => k.startsWith("extra"))
      .reduce((n, [, v]) => n + (typeof v === "string" ? bytes(v) : Array.isArray(v) ? v.reduce((m: number, s: string) => m + bytes(s), 0) : 0), 0);

  it("contract:I1 clamps unlisted keys past the 8 KiB budget in place, never dropping one", () => {
    const rec: Record<string, unknown> = { ...base };
    for (let i = 0; i < 20; i++) rec[`extra${i}`] = "x".repeat(KiB);
    const out = boundRecord(rec);
    expect(Object.keys(out)).toEqual(Object.keys(rec));
    expect(unlistedBytes(out)).toBeLessThanOrEqual(8 * KiB);
  });

  it("spends the budget in key order and clamps the rest down to an empty string", () => {
    const rec: Record<string, unknown> = { ...base };
    for (let i = 0; i < 10; i++) rec[`extra${i}`] = "x".repeat(KiB);
    const out = boundRecord(rec);
    for (let i = 0; i < 8; i++) expect(out[`extra${i}`]).toBe("x".repeat(KiB));
    expect(out.extra8).toBe("");
    expect(out.extra9).toBe("");
  });

  it("cuts the string that straddles the budget to what fits", () => {
    const rec: Record<string, unknown> = { ...base };
    for (let i = 0; i < 7; i++) rec[`extra${i}`] = "x".repeat(KiB);
    rec.extra7 = "y".repeat(3 * KiB);
    rec.extra8 = "z";
    const out = boundRecord(rec);
    expect(out.extra7).toBe("y".repeat(KiB));
    expect(out.extra8).toBe("");
  });

  it("clamps an unlisted string to 1 KiB", () => {
    expect(bound({ extraS: "s".repeat(4 * KiB) }).extraS).toBe("s".repeat(KiB));
  });

  it("clamps an unlisted array to 32 elements of 256 B", () => {
    const out = bound({ extraA: Array.from({ length: 40 }, () => "a".repeat(300)) });
    expect(out.extraA).toEqual(Array.from({ length: 32 }, () => "a".repeat(256)));
  });

  it("cuts an unlisted array at the first element that no longer fits", () => {
    const rec: Record<string, unknown> = { ...base };
    for (let i = 0; i < 7; i++) rec[`extra${i}`] = "x".repeat(KiB);
    rec.extra7 = "x".repeat(KiB - 300); // 300 B of budget left
    rec.extraA = ["a".repeat(256), "b".repeat(256), "c"];
    expect(boundRecord(rec).extraA).toEqual(["a".repeat(256)]);
  });

  it("clamps an unlisted array past the budget down to []", () => {
    const rec: Record<string, unknown> = { ...base };
    for (let i = 0; i < 8; i++) rec[`extra${i}`] = "x".repeat(KiB);
    rec.extraA = ["a"];
    expect(boundRecord(rec).extraA).toEqual([]);
  });

  it("nulls any other unlisted value that no longer fits, and keeps one that does", () => {
    const rec: Record<string, unknown> = { ...base, extraFlag: true };
    for (let i = 0; i < 8; i++) rec[`extra${i}`] = "x".repeat(KiB);
    rec.extraObj = { a: 1 };
    rec.extraNum = 7;
    const out = boundRecord(rec);
    expect(out.extraFlag).toBe(true);
    expect(out.extraObj).toBeNull();
    expect(out.extraNum).toBeNull();
  });

  it("applies the unlisted default to a support channel nobody listed", () => {
    const out = bound({ support: { issues: "i", forum: "f".repeat(4 * KiB) } });
    expect(out.support).toEqual({ issues: "i", forum: "f".repeat(KiB) });
  });

  it("counts only unlisted keys against the budget", () => {
    const out = bound({ description: "d".repeat(16 * KiB), summary: "s".repeat(KiB), extra: "x".repeat(KiB) });
    expect(out.extra).toBe("x".repeat(KiB));
  });
});

describe("boundRecord nested and identity values (IX-R30)", () => {
  const HIDDEN = /[\u{E0001}\u{E0020}-\u{E007F}\u202A-\u202E]/u;
  /** `{a:{a:...1}}`, `depth` objects deep. */
  const nest = (depth: number): unknown => (depth === 0 ? 1 : { a: nest(depth - 1) });

  it("contract:I1 strips the text nested under an unlisted key, in a list of objects and under an unlisted support channel", () => {
    const out = bound({
      extra: { n: "a\u{E0041}b", deeper: { list: ["c\u202Ed"] } },
      extraList: [{ t: "hi\u{E0041}" }],
      support: { weird: { n: "x\u202E" } },
    });
    expect(out).toMatchObject({
      extra: { n: "ab", deeper: { list: ["cd"] } },
      extraList: [{ t: "hi" }],
      support: { weird: { n: "x" } },
    });
    expect(JSON.stringify(out)).not.toMatch(HIDDEN);
  });

  it("leaves no unpaired surrogate in a listed field, a nested value, a nested key or an identity key", () => {
    const out = bound({
      summary: "x\ud800y",
      keywords: ["k\udc00"],
      extra: { "k\ud800": ["a\udfffb"] },
      support: { issues: "i\ud800", weird: { n: "w\udc00" } },
    });
    out.name = boundRecord({ ...base, name: "n\ud800" }).name;
    expect(out).toMatchObject({ summary: "xy", keywords: ["k"], extra: { k: ["ab"] }, support: { issues: "i", weird: { n: "w" } }, name: "n" });
    // The escape a lone surrogate takes in JSON, which serde_json rejects: grim would lose the whole catalog.
    expect(JSON.stringify(out)).not.toMatch(/\\ud[89a-f][0-9a-f]{2}/i);
  });

  it("strips the keys of a nested object too", () => {
    expect(bound({ extra: { "k\u{E0041}": 1 } }).extra).toEqual({ k: 1 });
  });

  it("keeps an operator's nested metadata byte for byte, up to sixteen levels, and nulls the whole value past it", () => {
    const six = { a: [{ b: { c: [{ d: "e" }] } }] };
    expect(JSON.stringify(bound({ extra: six }).extra)).toBe(JSON.stringify(six));
    expect(bound({ extra: nest(16) }).extra).toEqual(nest(16));
    expect(bound({ extra: nest(17) }).extra).toBeNull();
    expect(bound({ extra: JSON.parse("[".repeat(17) + "]".repeat(17)) }).extra).toBeNull();
    expect(bound({ extra: JSON.parse("[".repeat(16) + "]".repeat(16)) }).extra).toEqual(JSON.parse("[".repeat(16) + "]".repeat(16)));
  });

  it("nulls a value nested thousands of levels deep and charges nothing for it", () => {
    let deep: unknown = 1;
    for (let i = 0; i < 3500; i++) deep = [deep];
    const out = bound({ extra: deep, after: "kept" });
    expect(out.extra).toBeNull();
    expect(out.after).toBe("kept");
    expect(() => JSON.stringify(out)).not.toThrow();
  });

  it("counts the serialized bytes of a nested value against the unlisted budget", () => {
    const out = bound({ big: { pad: "p".repeat(9 * KiB) }, small: { pad: "p" } });
    expect(out.big).toBeNull();
    expect(out.small).toEqual({ pad: "p" });
  });

  it("strips an identity string but never cuts it", () => {
    const ref = `ghcr.io/${"a".repeat(5 * KiB)}`;
    const out = bound({ ref: `${ref}\u{E0041}`, name: "n\u202E", namespace: `${"n".repeat(5 * KiB)}\u200B` });
    expect(out).toMatchObject({ ref, name: "n", namespace: "n".repeat(5 * KiB) });
  });

  it("bounds an owner like any unlisted value", () => {
    expect(bound({ owner: { id: 1, github: "a\u{E0041}" } }).owner).toEqual({ id: 1, github: "a" });
    const out = bound({ owner: { id: 1, github: "acme", x: "a".repeat(60_000) } });
    expect(out.owner).toBeNull();
    expect(Buffer.byteLength(JSON.stringify(out))).toBeLessThan(KiB);
  });

  it("keeps an owner whole when earlier unlisted keys spend the whole unlisted budget", () => {
    const filler = Object.fromEntries(Array.from({ length: 8 }, (_, i) => [`x-${i}`, "f".repeat(KiB - 1)]));
    const owner = { id: 1, github: "a" };
    const out = boundRecord({ ...filler, ...base, owner, namespace: "ns" });
    expect(out.owner).toEqual(owner);
    // The owner has a budget of its own, so it also takes nothing from the keys after it.
    expect(boundRecord({ ...base, owner, "x-late": "l".repeat(KiB - 1) })["x-late"]).toBe("l".repeat(KiB - 1));
  });
});

describe("stripControls (IX-R30, C-005)", () => {
  // The edges of each range in the spec's strip set.
  const stripped = [
    0x00, 0x1f, 0x7f, 0x80, 0x9f, 0x61c, 0x180e, 0x200b, 0x2060, 0x2064, 0x202a, 0x202e, 0x2066, 0x2069, 0xfeff,
    0xfff9, 0xfffb, 0xe0001, 0xe0020, 0xe007f,
  ].map((cp) => [cp.toString(16), cp] as const);

  it.each(stripped)("contract:I1 strips U+%s, multiline or not", (_hex, cp) => {
    const text = `a${String.fromCodePoint(cp)}b`;
    expect(stripControls(text, false)).toBe("ab");
    expect(stripControls(text, true)).toBe("ab");
  });

  // One interior member per class, so a range written one short fails here.
  it.each([0x08, 0x0b, 0x0d, 0x85, 0x2062, 0x202c, 0x2067, 0xfffa, 0xe0041, 0xe007e])(
    "strips interior U+%i",
    (cp) => {
      expect(stripControls(`a${String.fromCodePoint(cp)}b`, true)).toBe("ab");
    },
  );

  it("strips an unpaired surrogate, which JSON writes as an escape grim's parser rejects, and keeps a pair", () => {
    expect(stripControls("a\ud800b\udc00c", false)).toBe("abc");
    expect(stripControls("a\udfffb\ud800", true)).toBe("ab");
    expect(stripControls("a\u{1F600}b", false)).toBe("a\u{1F600}b");
  });

  it("contract:I1 keeps tab and line feed only in a multiline field", () => {
    expect(stripControls("a\tb\nc", true)).toBe("a\tb\nc");
    expect(stripControls("a\tb\nc", false)).toBe("abc");
  });

  it("contract:I1 keeps ZWNJ, ZWJ, LRM, RLM, a ZWJ emoji and a well-formed flag tag sequence", () => {
    const kept = "a‌‍‎‏👨‍👩\u{1F3F4}\u{E0067}\u{E0062}\u{E0065}\u{E006E}\u{E0067}\u{E007F}b";
    expect(stripControls(kept, false)).toBe(kept);
  });

  it.each([
    ["ZWNJ", "‌"],
    ["ZWJ", "‍"],
    ["LRM", "‎"],
    ["RLM", "‏"],
  ])("keeps %s", (_name, ch) => {
    expect(stripControls(`a${ch}b`, false)).toBe(`a${ch}b`);
  });

  const flag = (tags: string) => `\u{1F3F4}${[...tags].map((c) => String.fromCodePoint(0xe0000 + c.charCodeAt(0))).join("")}\u{E007F}`;

  it("keeps a flag sequence of 3 to 7 tag digits or lowercase letters", () => {
    for (const tags of ["gbe", "gbeng", "usca1", "abcdefg", "123"]) {
      expect(stripControls(`x${flag(tags)}y`, false)).toBe(`x${flag(tags)}y`);
    }
  });

  it("strips the tags of a malformed flag sequence and keeps the flag glyph", () => {
    for (const tags of ["gb", "abcdefgh", "GBENG", "gb-en"]) {
      expect(stripControls(`x${flag(tags)}y`, false)).toBe("x\u{1F3F4}y");
    }
    // No cancel tag.
    expect(stripControls("x\u{1F3F4}\u{E0067}\u{E0062}\u{E0065}y", false)).toBe("x\u{1F3F4}y");
    // A tag run with no flag in front of it.
    expect(stripControls(`x${flag("gbeng").slice(2)}y`, false)).toBe("xy");
  });
});
