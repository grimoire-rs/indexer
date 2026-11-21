// @vitest-environment jsdom
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Grimoire Authors

// Every artifact kind against every interface the indexer faces. One list drives
// it: `KINDS` from the metadata validator. A kind added there without its cases
// in the other interfaces fails here, in the cell that names the interface.
// A cell either asserts the behaviour or asserts a documented refusal.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { h, render } from "preact";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { KINDS as DATA_KINDS, compileIndex } from "../src/data/index.js";
import { boundRequires, REQUIRES_KINDS } from "../src/emit/records.js";
import { JSON_KINDS, MARKDOWN_KINDS, enrichIndex, type GrimRunner } from "../src/enrich/index.js";
import { MEMBER_KINDS, enrichMarketplace } from "../src/enrich/marketplace.js";
import { KNOWN_KINDS } from "../src/renderer/astro/components/Catalog.js";
import { KIND_MARKS } from "../src/renderer/astro/components/KindMark.js";
import { PackageCard } from "../src/renderer/astro/components/PackageCard.js";
import { PackageRow } from "../src/renderer/astro/components/PackageRow.js";
import { cardPackage } from "../src/renderer/astro/lib/catalog.js";
import { KINDS as SEARCH_KINDS, createSearchIndex } from "../src/renderer/astro/lib/search.js";
import { decodeSearchFile, encodeSearchFile } from "../src/renderer/astro/lib/searchfile.js";
import type { CatalogPackage } from "../src/renderer/types.js";
import { KINDS, validateMetadata, type Kind } from "../src/validate/core/metadata.js";
import { LOCK_KINDS } from "../src/validate/core/marketplace.js";
import { runValidate } from "../src/validate/index.js";
import { makeTree, metadata, stubFetch } from "./validate/helpers.js";

(globalThis as Record<string, unknown>).__GRIMOIRE_BASE__ = "/";

const RENDERER = path.join(path.dirname(fileURLToPath(import.meta.url)), "../src/renderer/astro");
const read = (rel: string) => fs.readFileSync(path.join(RENDERER, rel), "utf8");
const SHA = "@sha256:" + "a".repeat(64);

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "kinds-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  vi.unstubAllGlobals();
});

const owner = { github: "acme", id: 1 };
/** Writes `index/github.com/acme/<name>/metadata.json` for a package of `kind`. */
function addPointer(kind: string, name = `p-${kind}`): string {
  const pkg = path.join(dir, "index/github.com/acme", name);
  fs.mkdirSync(pkg, { recursive: true });
  fs.writeFileSync(
    path.join(pkg, "metadata.json"),
    JSON.stringify({ schema: 1, name, kind, ref: `ghcr.io/acme/${kind}/${name}`, description: `A ${kind}.`, owner }),
  );
  return name;
}

describe("the kind lists agree", () => {
  it("the compiler admits exactly the validator's kinds", () => {
    expect([...DATA_KINDS].sort()).toEqual([...KINDS].sort());
  });
});

describe("validation", () => {
  it.each(KINDS)("validateMetadata accepts a %s pointer", (kind) => {
    const result = validateMetadata(JSON.parse(metadata({ kind, name: "tool" })), "tool");
    expect(result.ok).toBe(true);
  });
});

describe("build", () => {
  it.each(KINDS)("compileIndex puts a %s pointer in all.json with its kind", async (kind) => {
    addPointer(kind);
    const out = path.join(dir, "out");
    await compileIndex({ root: dir, outDir: out });
    const all = JSON.parse(fs.readFileSync(path.join(out, "all.json"), "utf8")) as { kind: string }[];
    expect(all.map((p) => p.kind)).toEqual([kind]);
  });
});

describe("marketplace members", () => {
  // Refusal, bundle: grim's marketplace.lock has no [[bundle]] table (grim
  // src/lock/grimoire_lock.rs refuses one); a bundle is reached through its
  // members' `bundle` provenance (`bundleRepos` in enrich/marketplace.ts).
  const withoutBundle = KINDS.filter((k) => k !== "bundle");

  it("the gate and enrich read every kind but bundle", () => {
    expect([...LOCK_KINDS].sort()).toEqual([...withoutBundle].sort());
    expect([...MEMBER_KINDS].sort()).toEqual([...withoutBundle].sort());
  });

  it.each(withoutBundle)("enrich lists a [[%s]] row as a member", async (kind) => {
    fs.writeFileSync(path.join(dir, "marketplace.toml"), '[marketplace]\nname = "m"\nrepository = "https://github.com/acme/plugins"\n');
    fs.writeFileSync(
      path.join(dir, "marketplace.lock"),
      `[[plugin]]\nname = "dev"\n\n[[${kind}]]\nname = "n"\nplugin = "dev"\npinned = "ghcr.io/acme/n${SHA}"\n`,
    );
    const run: GrimRunner = async (args) => {
      const out = args[args.indexOf("-o") + 1]!;
      fs.mkdirSync(path.join(out, ".claude-plugin"), { recursive: true });
      fs.writeFileSync(path.join(out, ".claude-plugin/marketplace.json"), "x");
      return { items: [], files: [] };
    };
    await enrichMarketplace(dir, run);
    const meta = JSON.parse(fs.readFileSync(path.join(dir, "enrich/marketplace/meta.json"), "utf8")) as { members: Record<string, unknown> };
    expect(meta.members.dev).toEqual([{ kind, name: "n", ref: "ghcr.io/acme/n" }]);
  });

  it.each(withoutBundle)("the gate holds a [[%s]] member to the index", async (kind) => {
    stubFetch(() => null);
    const prTree = await makeTree({
      "marketplace.lock": `[metadata]\nlock_version = 1\n\n[[plugin]]\nname = "dev"\ndeclaration_hash = "sha256:0"\n\n[[${kind}]]\nname = "n"\nplugin = "dev"\npinned = "reg.example.com/acme/missing${SHA}"\n`,
    });
    const result = await runValidate({
      forge: "github",
      root: await makeTree({}),
      prTree,
      changedFiles: ["marketplace.lock"],
      author: { login: "acme", id: "7" },
      apiBase: "https://api.test",
    });
    expect(result.reasons.some((r) => r.includes("reg.example.com/acme/missing"))).toBe(true);
  });
});

describe("requires", () => {
  it("lists every kind, in grim's order", () => {
    expect(REQUIRES_KINDS).toEqual(["skill", "rule", "agent", "bundle", "mcp", "hook", "settings", "mod"]);
    expect([...REQUIRES_KINDS].sort()).toEqual([...KINDS].sort());
  });

  it.each(KINDS)("boundRequires keeps a %s entry", (kind) => {
    const entry = { kind, name: "n", id: "./n:1" };
    expect(boundRequires([entry])).toEqual([entry]);
  });
});

/** A fake grim: `describe` reports `describe`, `fetch <ref>` reports `content`; every call is recorded. */
function fakeGrim(describe: Record<string, unknown>, content = "# Entry\n") {
  const calls: string[][] = [];
  const run: GrimRunner = (args) => {
    calls.push(args);
    if (args[0] === "describe") return Promise.resolve({ digest: "sha256:art", keywords: [], tags: [], deprecated: null, has_description: false, ...describe });
    if (args.includes("--digest-only")) return Promise.resolve({ digest: "sha256:art" });
    return Promise.resolve({ content });
  };
  return { run, calls };
}
const enrichKind = async (kind: string, extra: Record<string, unknown> = {}, content?: string) => {
  const name = addPointer(kind);
  const g = fakeGrim({ kind, ...extra }, content);
  await enrichIndex({ root: dir, run: g.run });
  const out = path.join(dir, "enrich/github.com/acme", name);
  return {
    calls: g.calls,
    data: JSON.parse(fs.readFileSync(path.join(out, "data.json"), "utf8")) as Record<string, unknown>,
    has: (file: string) => fs.existsSync(path.join(out, file)),
  };
};

describe("contents", () => {
  // Refusal, hook: a hook's payload is TOML and gets no contents, by design
  // (plan_settings_kind.md D1; test/live/kinds.test.ts hook case).
  const WANT: Record<Kind, "contents.md" | "contents.json" | "none"> = {
    skill: "contents.md",
    rule: "contents.md",
    agent: "contents.md",
    bundle: "contents.json",
    mcp: "contents.json",
    settings: "contents.json",
    mod: "contents.json",
    hook: "none",
  };

  it("the table names every kind, and the enrich sets say the same", () => {
    expect(Object.keys(WANT).sort()).toEqual([...KINDS].sort());
    const md = KINDS.filter((k) => WANT[k] === "contents.md");
    const json = KINDS.filter((k) => WANT[k] === "contents.json");
    expect([...MARKDOWN_KINDS].sort()).toEqual([...md].sort());
    expect([...JSON_KINDS].sort()).toEqual([...json].sort());
  });

  it.each(KINDS)("a deep enrich of a %s writes what the table says", async (kind) => {
    // A JSON body every JSON kind accepts; a mod wraps it with its file list.
    const r = await enrichKind(kind, {}, kind === "mod" || WANT[kind] === "none" ? "schema = 1\n" : WANT[kind] === "contents.json" ? '{"a":1}' : "# Entry\n");
    const want = WANT[kind];
    for (const file of ["contents.md", "contents.json"]) expect(r.has(file)).toBe(file === want);
    expect(r.data.hasContents).toBe(want !== "none");
    const fetchedArtifact = r.calls.some((c) => c[0] === "fetch" && !c.includes("--description") && !c.includes("--digest-only"));
    expect(fetchedArtifact).toBe(want !== "none");
  });
});

describe("serves", () => {
  // Contract C2: only a mod carries `serves` today.
  it.each(KINDS)("a %s with the clients annotation gets serves only when it is a mod", async (kind) => {
    const r = await enrichKind(kind, { annotations: { "com.grimoire.mod.clients": "opencode,claude" } });
    if (kind === "mod") expect(r.data.serves).toEqual(["claude", "opencode"]);
    else expect(r.data).not.toHaveProperty("serves");
  });
});

describe("kind mark", () => {
  it.each(KINDS)("%s has an own entry", (kind) => {
    expect(Object.hasOwn(KIND_MARKS, kind)).toBe(true);
  });

  it("no two kinds share a glyph, and none wears the plugin glyph", () => {
    const shape = (kind: string) => JSON.stringify(KIND_MARKS[kind]!.paths);
    const shapes = KINDS.map(shape);
    expect(new Set(shapes).size).toBe(KINDS.length);
    expect(shapes).not.toContain(shape("plugin"));
  });
});

describe("kind colour", () => {
  const tokens = read("styles/tokens.css");
  const base = read("layouts/Base.astro");
  // The light block is the first `:root` that declares the token, the dark one is the later copy.
  const declared = (kind: string) => [...tokens.matchAll(new RegExp(`--grim-color-kind-${kind}:`, "g"))].length;

  it.each(KINDS)("%s has a colour token in the light and the dark block", (kind) => {
    expect(declared(kind)).toBeGreaterThanOrEqual(2);
  });

  it.each(KINDS)("%s has its badge, tile and row rules", (kind) => {
    expect(base).toMatch(new RegExp(`\\.kind-${kind}\\s*\\{[^}]*--grim-color-kind-${kind}`));
    expect(base).toMatch(new RegExp(`\\.tile\\.letter\\)\\[data-kind="${kind}"\\]\\s*\\{[^}]*--grim-color-kind-${kind}`));
    expect(base).toMatch(new RegExp(`\\.t-kind\\[data-kind="${kind}"\\]\\s*\\{[^}]*--grim-color-kind-${kind}`));
  });
});

describe("kind chip and URL filter", () => {
  it("knows the program's kinds, then plugin", () => {
    expect(KNOWN_KINDS).toEqual([...KINDS, "plugin"]);
  });
});

describe("search", () => {
  const records = [...KINDS, "plugin"].map((kind) => ({ ref: `r.test/${kind}`, kind, name: `item-${kind}`, namespace: "acme" }));
  const index = createSearchIndex(records);

  it("has every kind", () => {
    for (const kind of KINDS) expect(SEARCH_KINDS.has(kind)).toBe(true);
  });

  // The kind word, bare, is an exact filter; `settings` also answers to `setting`.
  it.each(KINDS)("the word %s finds only a package of that kind", (kind) => {
    expect([...index.search(kind).keys()]).toEqual([`r.test/${kind}`]);
    expect([...index.search(kind.replace(/s$/, "")).keys()]).toEqual([`r.test/${kind}`]);
  });
});

describe("card and row", () => {
  const mounted: HTMLElement[] = [];
  afterEach(() => {
    for (const host of mounted.splice(0)) render(null, host);
  });
  const pkg = (kind: string) => cardPackage({ namespace: "acme", name: `p-${kind}`, kind, ref: `r.test/${kind}` } as unknown as CatalogPackage);
  const mount = (vnode: ReturnType<typeof h>): HTMLElement => {
    const host = document.createElement("div");
    document.body.append(host);
    mounted.push(host);
    render(vnode, host);
    return host;
  };

  // The card names its kind in words and tints its letter tile by it; only the row (and the page badge) wears the mark.
  it.each(KINDS)("a %s card names its kind and tints its tile", (kind) => {
    const host = mount(
      h(PackageCard, {
        pkg: pkg(kind),
        vscodeExtension: null,
        href: "/p/{namespace}/{name}/",
        activeKeywords: [],
        onToggleKeyword: () => {},
        keywordsExpanded: false,
        onToggleKeywordsExpanded: () => {},
        onKeyDown: () => {},
      }),
    );
    expect(host.querySelector(".kind")?.textContent?.trim()).toBe(kind);
    expect(host.querySelector(`[data-kind="${kind}"]`)).not.toBeNull();
  });

  it.each(KINDS)("a %s row wears its mark", (kind) => {
    const host = mount(h(PackageRow, { pkg: pkg(kind), hasRatings: false, hasDownloads: false, href: "/p/{namespace}/{name}/", onKeyDown: () => {} }));
    const cell = host.querySelector(`.t-kind[data-kind="${kind}"]`);
    expect(cell).not.toBeNull();
    expect(cell?.querySelector(`svg[aria-label="${kind}"]`)).not.toBeNull();
  });
});

describe("search file", () => {
  it.each(KINDS)("round-trips a %s row", (kind) => {
    const row = { ref: `r.test/${kind}`, kind, name: `p-${kind}`, summary: "s", keywords: ["k"] };
    const [back] = decodeSearchFile(JSON.parse(encodeSearchFile([row])));
    expect(back).toEqual(row);
  });
});
