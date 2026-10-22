// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Grimoire Authors

// The pure entry/logo helpers the exported marketplace tree is read through
// (`../../src/marketplace/read.ts`).
import { describe, expect, it } from "vitest";

import { MAX_LOGO_BYTES, MAX_PLUGINS, parseMarketplace, validLogo } from "../../src/marketplace/read.js";

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("rest")]);
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>');
const WEBP = Buffer.concat([Buffer.from("RIFF"), Buffer.from([1, 0, 0, 0]), Buffer.from("WEBPVP8 ")]);

describe("parseMarketplace", () => {
  it("keeps name, description, version and a plain relative source", () => {
    const [one] = parseMarketplace({
      plugins: [{ name: "hex", description: "Swarm", version: "1.2.3", source: "./claude/hex" }],
    })!;
    expect(one).toEqual({ plugin: { name: "hex", description: "Swarm", version: "1.2.3" }, source: "claude/hex" });
  });

  it("is null for anything that is not a marketplace document", () => {
    for (const bad of [null, "x", [], {}, { plugins: "no" }]) expect(parseMarketplace(bad)).toBeNull();
  });

  it("drops entries with a name that could escape a path or a shell, and duplicates", () => {
    const out = parseMarketplace({
      plugins: [
        { name: "../etc" },
        { name: "a/b" },
        { name: "-lead" },
        { name: "x".repeat(65) },
        { name: "ok" },
        { name: "ok", description: "second" },
        "string",
        null,
      ],
    })!;
    expect(out.map((p) => p.plugin.name)).toEqual(["ok"]);
    expect(out[0]!.plugin.description).toBe("");
  });

  it("strips control characters and caps description and version", () => {
    const [one] = parseMarketplace({
      plugins: [{ name: "p", description: `a\u001b[31mred\nline${"x".repeat(400)}`, version: "v".repeat(200) }],
    })!;
    expect(one!.plugin.description).not.toMatch(/[\u0000-\u001f]/);
    expect(one!.plugin.description.length).toBeLessThanOrEqual(300);
    expect(one!.plugin.version!.length).toBeLessThanOrEqual(64);
  });

  it("caps the plugin count", () => {
    const plugins = Array.from({ length: MAX_PLUGINS + 50 }, (_, i) => ({ name: `p${i}` }));
    expect(parseMarketplace({ plugins })).toHaveLength(MAX_PLUGINS);
  });

  it.each([["github"], ["../up"], ["./a/../b"], ["/abs"], [{ source: "github", repo: "o/r" }], ["./a b"]])(
    "gives no logo source for %j",
    (source) => {
      expect(parseMarketplace({ plugins: [{ name: "p", source }] })![0]!.source).toBeNull();
    },
  );
});

describe("parseMarketplace metadata", () => {
  const first = (entry: Record<string, unknown>) => parseMarketplace({ plugins: [{ name: "p", ...entry }] })![0]!.plugin;

  it("keeps the entry's own optional fields, as text", () => {
    expect(
      first({
        author: { name: "Ada", email: "ada@example.com", url: "https://example.com/ada" },
        homepage: "https://example.com/home",
        repository: "https://github.com/acme/p",
        documentationUrl: "https://example.com/docs",
        supportUrl: "https://example.com/help",
        license: "MIT",
        category: "tooling",
        keywords: ["a", "b", "a"],
        tags: ["t"],
      }),
    ).toEqual({
      name: "p",
      description: "",
      author: { name: "Ada", url: "https://example.com/ada" },
      homepage: "https://example.com/home",
      repository: "https://github.com/acme/p",
      documentationUrl: "https://example.com/docs",
      supportUrl: "https://example.com/help",
      license: "MIT",
      category: "tooling",
      keywords: ["a", "b"],
      tags: ["t"],
    });
  });

  it("takes an author given as a plain string, and never keeps the email", () => {
    expect(first({ author: "Ada" }).author).toEqual({ name: "Ada" });
    expect(JSON.stringify(first({ author: { name: "Ada", email: "ada@example.com" } }))).not.toContain("example.com");
  });

  it.each([
    ["http", "http://example.com/x"],
    ["javascript", "javascript:alert(1)"],
    ["data", "data:text/html,<script>alert(1)</script>"],
    ["userinfo", "https://user:pw@example.com/x"],
    ["whitespace", "https://example.com/a b"],
    ["a control character", "https://example.com/a\u0000b"],
    ["relative", "/docs"],
    ["too long", `https://example.com/${"x".repeat(300)}`],
    ["not a string", 7],
  ])("drops a %s URL and keeps the entry", (_label, url) => {
    const plugin = first({ homepage: url, repository: url, documentationUrl: url, supportUrl: url, author: { name: "Ada", url } });
    expect(plugin).toEqual({ name: "p", description: "", author: { name: "Ada" } });
  });

  it("caps every text field and the keyword lists, and strips control characters", () => {
    const plugin = first({
      author: "a".repeat(500),
      license: "l".repeat(500),
      category: "c\u001b[31m".repeat(100),
      keywords: Array.from({ length: 40 }, (_, i) => `k${i}`),
      tags: ["t".repeat(500), 5, null, {}],
    });
    expect(plugin.author!.name.length).toBeLessThanOrEqual(100);
    expect(plugin.license!.length).toBeLessThanOrEqual(64);
    expect(plugin.category!.length).toBeLessThanOrEqual(40);
    expect(plugin.category).not.toMatch(/[\u0000-\u001f]/);
    expect(plugin.keywords).toHaveLength(10);
    expect(plugin.tags).toHaveLength(1);
    expect(plugin.tags![0]!.length).toBeLessThanOrEqual(40);
  });

  it("ignores fields of the wrong shape without losing the entry", () => {
    expect(first({ author: 5, keywords: "nope", tags: {}, license: [], category: {}, homepage: {} })).toEqual({
      name: "p",
      description: "",
    });
  });
});

describe("validLogo", () => {
  it("accepts a real png and webp", () => {
    expect(validLogo("png", PNG)).toBe(true);
    expect(validLogo("webp", WEBP)).toBe(true);
  });

  it("rejects bytes that are not the claimed format, and oversize files", () => {
    expect(validLogo("png", Buffer.from("<svg/>"))).toBe(false);
    expect(validLogo("webp", PNG)).toBe(false);
    expect(validLogo("png", WEBP)).toBe(false);
    expect(validLogo("png", Buffer.alloc(0))).toBe(false);
    expect(validLogo("png", Buffer.concat([PNG, Buffer.alloc(MAX_LOGO_BYTES)]))).toBe(false);
  });

  it("never accepts an svg, whatever it contains or is named", () => {
    expect(validLogo("png", SVG)).toBe(false);
    expect(validLogo("webp", SVG)).toBe(false);
    expect(validLogo("png", Buffer.from("<svg><script>alert(1)</script></svg>"))).toBe(false);
  });

  it("takes a png signature followed by html for a png, which is served as image/png", () => {
    expect(validLogo("png", Buffer.concat([PNG, Buffer.from("<html><script>alert(1)</script></html>")]))).toBe(true);
  });
});
