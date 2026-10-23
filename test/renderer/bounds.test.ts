// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Grimoire Authors

import { escapeHTML } from "astro/runtime/server/index.js";
import { describe, expect, it } from "vitest";
import { boundBytes, boundedUrl, boundLines, boundList, keywordParam } from "../../src/renderer/astro/lib/bounds.js";

const bytes = (s: string) => new TextEncoder().encode(s).length;

describe("boundList", () => {
  it("keeps a short list whole", () => {
    expect(boundList([1, 2, 3], 32)).toEqual({ shown: [1, 2, 3], more: 0 });
  });

  it("keeps exactly the limit whole and counts the rest", () => {
    const items = Array.from({ length: 40 }, (_, i) => i);
    expect(boundList(items, 32)).toEqual({ shown: items.slice(0, 32), more: 8 });
    expect(boundList(items.slice(0, 32), 32).more).toBe(0);
  });

  it("defaults to 32", () => {
    expect(boundList(Array.from({ length: 33 }, (_, i) => i)).shown).toHaveLength(32);
  });
});

describe("boundBytes", () => {
  it("returns text within the budget untouched", () => {
    expect(boundBytes("short", 1024)).toBe("short");
    expect(boundBytes("a".repeat(1024), 1024)).toBe("a".repeat(1024));
  });

  it("cuts ASCII to the budget, ellipsis included", () => {
    const out = boundBytes("a".repeat(2000), 1024);
    expect(bytes(out)).toBe(1024);
    expect(out.endsWith("…")).toBe(true);
  });

  it("never splits a multi-byte code point or a surrogate pair", () => {
    for (const unit of ["é", "€", "😀", "é€😀"]) {
      for (let max = 3; max < 40; max++) {
        const out = boundBytes(unit.repeat(50), max);
        expect(bytes(out), `${unit} @ ${max}`).toBeLessThanOrEqual(max);
        expect(Buffer.from(out, "utf8").toString("utf8"), `${unit} @ ${max}`).toBe(out);
        expect(out.endsWith("…")).toBe(true);
      }
    }
  });

  it("defaults to 1,024 bytes", () => {
    expect(bytes(boundBytes("😀".repeat(500)))).toBeLessThanOrEqual(1024);
  });

  // Astro prints `& < > ' "` as `&amp; &lt; &gt; &#39; &quot;`, so the bound is on that.
  it.each(["&", "<", ">", "'", '"'])("budgets %s at its entity, so the escaped output stays in the bound", (ch) => {
    const out = boundBytes(ch.repeat(2000), 1024);
    expect(bytes(escapeHTML(out))).toBeLessThanOrEqual(1024);
    expect(bytes(escapeHTML(out))).toBeGreaterThan(1024 - 6 - 3);
    expect(out.endsWith("…")).toBe(true);
  });

  it("keeps text whose escaped form fits, and cuts text whose escaped form does not", () => {
    expect(boundBytes('"'.repeat(10), 60)).toBe('"'.repeat(10));
    expect(boundBytes('"'.repeat(11), 60)).not.toBe('"'.repeat(11));
  });
});

describe("boundLines", () => {
  const json = JSON.stringify({ a: "x".repeat(30), b: ["y".repeat(30), "z".repeat(30)] }, null, 2);

  it("returns text within the budget untouched", () => {
    expect(boundLines(json, 4096)).toEqual({ text: json, cut: false });
  });

  it("cuts between lines, within the budget", () => {
    const out = boundLines(json, 60);
    expect(out.cut).toBe(true);
    expect(bytes(out.text)).toBeLessThanOrEqual(60);
    expect(json.startsWith(out.text + "\n")).toBe(true);
  });

  it("cuts a single over-long line at a code point instead of returning nothing", () => {
    const out = boundLines("😀".repeat(100), 21);
    expect(out.cut).toBe(true);
    expect(bytes(out.text)).toBeLessThanOrEqual(21);
    expect(Buffer.from(out.text, "utf8").toString("utf8")).toBe(out.text);
    expect(out.text.length).toBeGreaterThan(0);
  });
});

describe("keywordParam", () => {
  it("leaves non-ASCII characters unescaped, at their UTF-8 length", () => {
    expect(keywordParam("café-日本語-😀")).toBe("café-日本語-😀");
    expect(bytes(keywordParam("日本語"))).toBe(9);
  });

  it("still escapes URL-syntax and unsafe ASCII", () => {
    expect(keywordParam('a&b#c%d+e?f/g h"i\'j<k>l=m,n')).toBe(encodeURIComponent('a&b#c%d+e?f/g h"i\'j<k>l=m,n'));
    expect(keywordParam("a&b")).toBe("a%26b");
  });

  it("escapes controls, separators and format characters", () => {
    for (const ch of ["\u0085", "\u00a0", "\u2028", "\u202e", "\u200b"]) {
      expect(keywordParam(ch), JSON.stringify(ch)).toBe(encodeURIComponent(ch));
    }
  });

  it("round-trips through URLSearchParams, as the home page reads it", () => {
    for (const k of ["cli", "café", "日本語", "a&b=c#d", "100%", "😀 party", "x+y", "a,b", "\u00a0pad"]) {
      expect(new URLSearchParams(`kw=${keywordParam(k)}`).get("kw"), k).toBe(k);
      expect(new URL(`https://x.test/?kw=${keywordParam(k)}`).searchParams.get("kw"), k).toBe(k);
    }
  });
});

describe("boundedUrl", () => {
  it("links a short allowlisted URL as written", () => {
    expect(boundedUrl("https://github.com/acme/tool")).toBe("https://github.com/acme/tool");
  });

  it("drops a URL over 512 bytes, one at it stays, and one with a scheme the allowlist refuses", () => {
    const at = "https://acme.example/" + "p".repeat(512 - "https://acme.example/".length);
    expect(boundedUrl(at)).toBe(at);
    expect(boundedUrl(`${at}p`)).toBeNull();
    expect(boundedUrl("javascript:alert(1)")).toBeNull();
    expect(boundedUrl(undefined)).toBeNull();
  });
});
