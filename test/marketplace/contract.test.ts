// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Grimoire Authors

// Pins the seams between the four marketplace pipelines (enrich, reader, pages,
// gate) from the plan's contracts C-006…C-009, not from any implementation. The
// stubs throw `not implemented` until each pipeline lands, so the enrich and
// reader cases are red by design on the contract-wave commit.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { NavLink } from "../../src/config.js";
import type { GrimRunner } from "../../src/enrich/index.js";
import { enrichMarketplace } from "../../src/enrich/marketplace.js";
import { readMarketplace, siteMode, type LocalMarketplace } from "../../src/marketplace/read.js";
import { navFor } from "../../src/renderer/astro/lib/nav.js";

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "mk-contract-"));
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function write(rel: string, content: string | Buffer): void {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("rest")]);
const EXPORT = "enrich/marketplace/export";

const marketplace: LocalMarketplace = {
  name: "acme-plugins",
  repository: "https://github.com/acme/plugins",
  clients: ["claude"],
  plugins: [],
  docs: {},
  logos: {},
};
const listedMarketplace: LocalMarketplace = {
  ...marketplace,
  plugins: [{ name: "dev", description: "d", members: [] }],
};

describe("C-008 siteMode", () => {
  // Third argument: how many plugins the pages actually list (those with an install command).
  it.each([
    [0, null, 0, "packages"],
    [12, null, 0, "packages"],
    [0, listedMarketplace, 1, "marketplace"],
    [1, listedMarketplace, 1, "both"],
    [12, listedMarketplace, 1, "both"],
    // A marketplace that lists nothing never takes over a zero-package index.
    [0, marketplace, 0, "packages"],
    [0, listedMarketplace, 0, "packages"],
    [3, listedMarketplace, 0, "both"],
  ] as const)("%i packages, marketplace %# with %i listed -> %s", (count, mk, listed, expected) => {
    expect(siteMode(count, mk === null ? null : mk, listed)).toBe(expected);
  });
});

describe("C-009 navFor", () => {
  const DOCS = "https://grimoire.rs";
  const REPO = "https://gitlab.com/acme/index";
  const explicit: NavLink[] = [{ label: "setup", href: "/setup/" }];
  const docsRepo = [
    { label: "docs", href: DOCS },
    { label: "gitlab", href: REPO },
  ];

  it("an explicit nav wins in every mode, even an empty one", () => {
    for (const mode of ["packages", "both", "marketplace"] as const) {
      expect(navFor(explicit, DOCS, REPO, mode)).toEqual(explicit);
      expect(navFor([], DOCS, REPO, mode)).toEqual([]);
    }
  });

  it("both: packages at /, marketplace at /marketplace/, then docs and the forge", () => {
    expect(navFor(null, DOCS, REPO, "both")).toEqual([
      { label: "packages", href: "/" },
      { label: "marketplace", href: "/marketplace/" },
      ...docsRepo,
    ]);
  });

  it.each(["packages", "marketplace"] as const)("%s: docs and the forge only", (mode) => {
    expect(navFor(null, DOCS, REPO, mode)).toEqual(docsRepo);
  });

  it("drops what is not configured, and names an unknown forge by host", () => {
    expect(navFor(null, null, null, "both")).toEqual([
      { label: "packages", href: "/" },
      { label: "marketplace", href: "/marketplace/" },
    ]);
    expect(navFor(null, null, "https://git.acme.test/x", "packages")).toEqual([
      { label: "git.acme.test", href: "https://git.acme.test/x" },
    ]);
  });
});

describe("C-007 readMarketplace", () => {
  const INDEXED = { ref: "ghcr.io/acme/lore/hex", namespace: "acme", name: "hex" };

  // C-005: the marketplace exists iff the manifest does.
  beforeEach(() => write("marketplace.toml", '[marketplace]\nname = "acme-plugins"\n'));

  function claudeTree(): void {
    write(
      `${EXPORT}/.claude-plugin/marketplace.json`,
      JSON.stringify({
        name: "acme-plugins",
        plugins: [{ name: "dev", description: "Dev tools", version: "1.0.0", source: "./claude/dev" }],
      }),
    );
    write(`${EXPORT}/claude/dev/README.md`, "# dev\n");
    write(`${EXPORT}/claude/dev/CHANGELOG.md`, "## 1.0.0\n");
    write(`${EXPORT}/claude/dev/assets/logo.png`, PNG);
    write(
      "enrich/marketplace/meta.json",
      JSON.stringify({
        repository: "https://github.com/acme/plugins",
        members: {
          dev: [
            { kind: "skill", name: "hex", ref: "ghcr.io/acme/lore/hex" },
            { kind: "rule", name: "style", ref: "ghcr.io/other/lore/style" },
          ],
        },
      }),
    );
  }

  it("is null when nothing was exported", () => {
    expect(readMarketplace(root)).toBeNull();
  });

  it("reads the Claude marketplace file, its plugin docs and logo, and meta.json", () => {
    claudeTree();
    const mk = readMarketplace(root, [INDEXED]);
    expect(mk).toMatchObject({
      name: "acme-plugins",
      repository: "https://github.com/acme/plugins",
      clients: ["claude"],
      docs: { dev: { readme: true, changelog: true } },
    });
    expect(Object.keys(mk?.logos ?? {})).toEqual(["dev"]);
    expect(mk?.plugins).toHaveLength(1);
    expect(mk?.plugins[0]).toMatchObject({ name: "dev", description: "Dev tools", version: "1.0.0" });
  });

  it("links a member only when its ref equals an indexed package's ref", () => {
    claudeTree();
    expect(readMarketplace(root, [INDEXED])?.plugins[0]?.members).toEqual([
      { kind: "skill", name: "hex", ref: "ghcr.io/acme/lore/hex", href: "/p/acme/hex/" },
      { kind: "rule", name: "style", ref: "ghcr.io/other/lore/style" },
    ]);
    // No package list given: nothing is indexed, nothing links.
    expect(readMarketplace(root)?.plugins[0]?.members.every((m) => m.href === undefined)).toBe(true);
  });

  it("has a null repository when meta.json names none", () => {
    claudeTree();
    write("enrich/marketplace/meta.json", JSON.stringify({ members: {} }));
    expect(readMarketplace(root)).toMatchObject({ repository: null });
  });

  it("falls back to .qoder-plugin/ when there is no Claude file", () => {
    write(
      `${EXPORT}/.qoder-plugin/marketplace.json`,
      JSON.stringify({ name: "acme-plugins", plugins: [{ name: "dev", description: "d", source: "./qoder/dev" }] }),
    );
    write("enrich/marketplace/meta.json", JSON.stringify({ members: {} }));
    const mk = readMarketplace(root);
    expect(mk?.name).toBe("acme-plugins");
    expect(mk?.clients).toEqual(["qoder"]);
    expect(mk?.plugins.map((p) => p.name)).toEqual(["dev"]);
  });

  it("skips a plugin whose source escapes the export dir, keeping the rest", () => {
    claudeTree();
    write(
      `${EXPORT}/.claude-plugin/marketplace.json`,
      JSON.stringify({
        name: "acme-plugins",
        plugins: [
          { name: "evil", description: "x", source: "./../../outside" },
          { name: "dev", description: "d", source: "./claude/dev" },
        ],
      }),
    );
    expect(readMarketplace(root)?.plugins.map((p) => p.name)).toEqual(["dev"]);
  });
});

describe("C-006 enrichMarketplace", () => {
  const LOCK = [
    "[metadata]",
    "lock_version = 1",
    "",
    "[[plugin]]",
    'name = "dev"',
    'declaration_hash = "sha256:aa"',
    "",
    "[[skill]]",
    'name = "hex"',
    'plugin = "dev"',
    'pinned = "ghcr.io/acme/lore/hex@sha256:' + "a".repeat(64) + '"',
    "",
    "[[rule]]",
    'name = "style"',
    'plugin = "dev"',
    'pinned = "ghcr.io/other/lore/style@sha256:' + "b".repeat(64) + '"',
    "",
    "[[skill]]",
    'name = "local-only"',
    'plugin = "dev"',
    'path = "./skills/local-only"',
    'hash = "sha256:' + "c".repeat(64) + '"',
    "",
  ].join("\n");

  function curatorFiles(): void {
    write(
      "marketplace.toml",
      '[marketplace]\nname = "acme-plugins"\nrepository = "https://github.com/acme/plugins"\n\n[plugins.dev]\ndescription = "Dev tools"\n',
    );
    write("marketplace.lock", LOCK);
  }

  /** Stands in for `grim export marketplace`: records the call and lays down a minimal export tree. */
  function fakeGrim(calls: string[][]): GrimRunner {
    return async (args) => {
      calls.push(args);
      // Writes where `-o` points, as grim does.
      const out = path.relative(root, args[args.indexOf("-o") + 1] ?? "");
      write(
        `${out}/.claude-plugin/marketplace.json`,
        JSON.stringify({ name: "acme-plugins", plugins: [{ name: "dev", description: "d", source: "./claude/dev" }] }),
      );
      return { files: [] };
    };
  }

  it("runs grim export marketplace into enrich/marketplace/export and writes meta.json", async () => {
    curatorFiles();
    const calls: string[][] = [];
    await enrichMarketplace(root, fakeGrim(calls));

    expect(calls).toHaveLength(1);
    const args = calls[0] ?? [];
    expect(args.slice(0, 2)).toEqual(["export", "marketplace"]);
    expect(args).toContain("--force");
    expect(args[args.indexOf("--marketplace") + 1]).toBe(path.join(root, "marketplace.toml"));
    // grim writes a staging tree that replaces EXPORT only on success.
    expect(args[args.indexOf("-o") + 1]).toBe(path.join(root, `${EXPORT}.next`));

    const meta = JSON.parse(fs.readFileSync(path.join(root, "enrich/marketplace/meta.json"), "utf8")) as {
      repository?: string;
      members: Record<string, { kind: string; name: string; ref: string }[]>;
    };
    expect(meta.repository).toBe("https://github.com/acme/plugins");
    // `ref` is `pinned` minus the digest; the path member is dropped.
    expect(Object.keys(meta.members)).toEqual(["dev"]);
    expect([...(meta.members.dev ?? [])].sort((a, b) => a.name.localeCompare(b.name))).toEqual([
      { kind: "skill", name: "hex", ref: "ghcr.io/acme/lore/hex" },
      { kind: "rule", name: "style", ref: "ghcr.io/other/lore/style" },
    ]);
  });

  it("does nothing, and never calls grim, without a marketplace.toml", async () => {
    const calls: string[][] = [];
    await enrichMarketplace(root, fakeGrim(calls));
    expect(calls).toEqual([]);
    expect(fs.existsSync(path.join(root, "enrich/marketplace/meta.json"))).toBe(false);
  });

  it("keeps the previous export and does not throw when grim fails", async () => {
    curatorFiles();
    write(`${EXPORT}/.claude-plugin/marketplace.json`, '{"name":"previous","plugins":[]}');
    const failing: GrimRunner = async () => {
      throw new Error("grim exploded");
    };
    await expect(enrichMarketplace(root, failing)).resolves.toBeDefined();
    expect(fs.readFileSync(path.join(root, EXPORT, ".claude-plugin/marketplace.json"), "utf8")).toContain("previous");
  });
});
