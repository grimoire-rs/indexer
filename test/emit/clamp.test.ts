// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Grimoire Authors

// IX-R47, V-32: what enrich stores as an entry's `data` is the record text policy
// applied once, on ingest, and `all.json` emit applied to the stored copy gives
// the bytes it would give the raw payload.
import { describe, expect, it } from "vitest";

import { boundRecord, clampData } from "../../src/emit/records.js";

const MiB = 1024 * 1024;

/** The keys `compileIndex` lays over a sidecar: the pointer, then the namespace. */
const overlay = { schema: 1, name: "foo", kind: "skill", ref: "ghcr.io/acme/skills/foo", owner: { id: 1, github: "octocat" }, namespace: "github.com/acme" };

/** `compileIndex`'s merge, then `boundRecord`: what `all.json` carries for a sidecar. */
const emit = (data: Record<string, unknown>, over: Record<string, unknown> = overlay): string => JSON.stringify(boundRecord({ ...data, ...over }));

const strings = (n: number, prefix: string): string[] => Array.from({ length: n }, (_, i) => `${prefix}-${i}`);

describe("clampData (IX-R47)", () => {
  const hostile = (): Record<string, unknown> => ({
    title: "Foo",
    summary: "s".repeat(MiB),
    version: "1.0.0",
    description: "d".repeat(MiB),
    keywords: strings(10_000, "kw"),
    tags: strings(10_000, "tag"),
    extra: "e".repeat(MiB),
    deprecated: null,
  });

  it("bounds a payload with 10,000 keywords and tags, a 1 MiB description and a 1 MiB unlisted key", () => {
    const out = clampData(hostile(), overlay);

    expect(out.keywords).toHaveLength(32);
    expect(out.tags).toHaveLength(128);
    expect(Buffer.byteLength(out.description as string)).toBe(16 * 1024);
    expect(Buffer.byteLength(out.summary as string)).toBe(1024);
    expect(Buffer.byteLength(out.extra as string)).toBe(1024);
    expect(Buffer.byteLength(JSON.stringify(out))).toBeLessThan(64 * 1024);
  });

  it("emits the bytes the raw payload emits", () => {
    const raw = hostile();
    expect(emit(clampData(raw, overlay))).toBe(emit(raw));
  });

  it("keeps the order of the keys it was given", () => {
    const raw = { z: "1", title: "t", a: "2", keywords: ["k"] };
    expect(Object.keys(clampData(raw, overlay))).toEqual(["z", "title", "a", "keywords"]);
  });

  it("is idempotent", () => {
    const once = clampData(hostile(), overlay);
    expect(clampData(once, overlay)).toEqual(once);
    expect(JSON.stringify(clampData(once, overlay))).toBe(JSON.stringify(once));
  });

  it("removes the strip set the way emit does", () => {
    const raw = { title: "a‮b\u0000c", summary: "x\u{e0041}y", keywords: ["k​1"], note: "n\u007fn" };
    const out = clampData(raw, overlay);
    expect(out).toEqual({ title: "abc", summary: "xy", keywords: ["k1"], note: "nn" });
    expect(emit(out)).toBe(emit(raw));
  });

  it("leaves the identity keys out: the pointer supplies every one of them at emit", () => {
    const raw = { title: "t", name: "x".repeat(MiB), owner: { y: "z" }, ref: "r\u{e0041}", schema: 2, kind: "rule", namespace: "n" };
    expect(clampData(raw, overlay)).toEqual({ title: "t" });
    expect(emit(clampData(raw, overlay))).toBe(emit({ title: "t" }));
  });

  describe("unlisted keys share one 8 KiB budget, in the order emit sees them", () => {
    /** Nine 1 KiB strings: one more than the budget holds. */
    const nine = (): Record<string, unknown> => Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`u${i + 1}`, `${i + 1}`.repeat(1024)]));

    it("so clamping the data alone is not enough once the pointer replaces one of them", () => {
      const raw = nine();
      const over = { ...overlay, u1: "tiny" };

      // The pointer's `u1` costs 4 bytes at emit, the data's cost 1 KiB at a clamp that ignores it.
      expect(emit(boundRecord(raw), over)).not.toBe(emit(raw, over));
      expect(emit(clampData(raw, over), over)).toBe(emit(raw, over));
    });

    it("whatever order the pointer's keys come in", () => {
      const raw = nine();
      for (const over of [{ ...overlay, u5: "x", u2: "y" }, { u9: "z", ...overlay }, { ...overlay, u1: "a".repeat(5000) }]) {
        expect(emit(clampData(raw, over), over), JSON.stringify(Object.keys(over))).toBe(emit(raw, over));
      }
    });

    it("and a key the pointer replaces keeps the data's own bounded value, not the pointer's", () => {
      const out = clampData({ title: "A".repeat(1000), u1: "B".repeat(3000) }, { ...overlay, title: "P", u1: "Q" });
      expect(Buffer.byteLength(out.title as string)).toBe(256);
      expect(out.title).toBe("A".repeat(256));
      expect(out.u1).toBe("B".repeat(1024));
    });
  });

  it("keeps a __proto__ key as data", () => {
    const raw = JSON.parse('{"title":"t","__proto__":{"polluted":"x"}}') as Record<string, unknown>;
    const out = clampData(raw, overlay);
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype);
    expect(Object.hasOwn(out, "__proto__")).toBe(true);
    expect(emit(out)).toBe(emit(raw));
  });
});
