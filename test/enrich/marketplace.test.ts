// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Grimoire Authors

// `enrichMarketplace` runs `grim export marketplace` on the index's own
// marketplace.toml and records what the export does not say; the checkpoint
// bridge carries that local tree.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { GrimRunner } from "../../src/enrich/index.js";
import {
  enrichMarketplace,
  MARKETPLACE_EXPORT_TIMEOUT_MS,
  packMarketplace,
  seedMarketplace,
} from "../../src/enrich/marketplace.js";

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "mk-enrich-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const EXPORT = "enrich/marketplace/export";
const META = "enrich/marketplace/meta.json";
const SHA = "@sha256:" + "a".repeat(64);

function put(rel: string, content: string): void {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), content);
}
const meta = () => JSON.parse(fs.readFileSync(path.join(dir, META), "utf8")) as Record<string, unknown>;

const LOCK = [
  "[[plugin]]",
  'name = "dev"',
  "",
  "[[plugin]]",
  'name = "empty"',
  "",
  "[[skill]]",
  'name = "hex"',
  'plugin = "dev"',
  `pinned = "ghcr.io/acme/lore/hex${SHA}"`,
  "",
  "[[mcp]]",
  'name = "srv"',
  'plugin = "dev"',
  `pinned = "ghcr.io/acme/lore/srv${SHA}"`,
  "",
  "[[skill]]",
  'name = "local-only"',
  'plugin = "dev"',
  'path = "./skills/local-only"',
  'hash = "sha256:' + "c".repeat(64) + '"',
  "",
].join("\n");

function curator(lock: string | null = LOCK): void {
  put("marketplace.toml", '[marketplace]\nname = "m"\nrepository = "https://github.com/acme/plugins"\n');
  if (lock !== null) put("marketplace.lock", lock);
}

const REPORT = {
  items: [
    { plugin: "dev", client: "claude", action: "written" },
    { plugin: "gone", client: "claude", action: "removed" },
  ],
  files: [
    { client: null, path: "/x/README.md", action: "written", plugins: [] },
    { client: "cursor", path: "/x/c", action: "written", plugins: ["dev"] },
    { client: "claude", path: "/x/a", action: "unchanged", plugins: ["dev"] },
    { client: "claude", path: "/x/b", action: "written", plugins: ["dev"] },
    { client: "copilot", path: "/x/d", action: "removed", plugins: [] },
    { client: "not-a-client", path: "/x/e", action: "written", plugins: [] },
  ],
};

/** Like grim: writes a tree into the `-o` dir, then reports. `opts` collects the per-call options. */
const reporting = (calls: string[][] = [], effect?: () => void, opts: unknown[] = []): GrimRunner => async (args, o) => {
  calls.push(args);
  opts.push(o);
  const out = args[args.indexOf("-o") + 1]!;
  fs.mkdirSync(path.join(out, ".claude-plugin"), { recursive: true });
  fs.writeFileSync(path.join(out, ".claude-plugin/marketplace.json"), "fresh");
  effect?.();
  return REPORT;
};
const exportFile = (rel: string) => path.join(dir, EXPORT, rel);

describe("enrichMarketplace", () => {
  it("runs grim export marketplace --force into export.next with the long timeout, then swaps it in", async () => {
    curator();
    const calls: string[][] = [];
    const opts: unknown[] = [];
    const result = await enrichMarketplace(dir, reporting(calls, undefined, opts));
    expect(calls).toEqual([
      ["export", "marketplace", "--marketplace", path.join(dir, "marketplace.toml"), "-o", path.join(dir, `${EXPORT}.next`), "--force"],
    ]);
    expect(opts).toEqual([{ timeoutMs: MARKETPLACE_EXPORT_TIMEOUT_MS }]);
    expect(MARKETPLACE_EXPORT_TIMEOUT_MS).toBeGreaterThan(60_000);
    expect(result).toMatchObject({ exported: true, plugins: 1, warnings: [] });
    expect(fs.readFileSync(exportFile(".claude-plugin/marketplace.json"), "utf8")).toBe("fresh");
    expect(fs.readdirSync(path.join(dir, "enrich/marketplace")).sort()).toEqual(["export", "meta.json"]);
  });

  it("replaces the previous export wholesale, so a file the new export dropped is gone", async () => {
    curator();
    put(`${EXPORT}/claude/removed/README.md`, "old");
    await enrichMarketplace(dir, reporting());
    expect(fs.existsSync(exportFile("claude/removed/README.md"))).toBe(false);
  });

  it("writes the repository, the report's distinct exported clients, and the lock's registry members", async () => {
    curator();
    await enrichMarketplace(dir, reporting());
    expect(meta()).toEqual({
      repository: "https://github.com/acme/plugins",
      // null client, removed file and unknown client dropped; order is the config's, not the report's
      clients: ["claude", "cursor"],
      // digest stripped, path member dropped, a plugin without members kept empty
      members: {
        dev: [
          { kind: "skill", name: "hex", ref: "ghcr.io/acme/lore/hex" },
          { kind: "mcp", name: "srv", ref: "ghcr.io/acme/lore/srv" },
        ],
        empty: [],
      },
    });
  });

  it("omits repository when the toml has none, and writes empty members without a lock", async () => {
    put("marketplace.toml", '[marketplace]\nname = "m"\n');
    await enrichMarketplace(dir, reporting());
    expect(meta()).toEqual({ clients: ["claude", "cursor"], members: {} });
  });

  it("does nothing, and never calls grim, without a marketplace.toml", async () => {
    const calls: string[][] = [];
    expect(await enrichMarketplace(dir, reporting(calls))).toEqual({ exported: false, plugins: 0, warnings: [] });
    expect(calls).toEqual([]);
    expect(fs.existsSync(path.join(dir, "enrich"))).toBe(false);
  });

  it("keeps the previous export and meta, and warns instead of throwing, when grim fails", async () => {
    curator();
    put(`${EXPORT}/.claude-plugin/marketplace.json`, "previous");
    put(META, '{"clients":["claude"],"members":{}}');
    const result = await enrichMarketplace(dir, async () => {
      throw new Error("grim exploded");
    });
    expect(result.exported).toBe(false);
    expect(result.warnings).toEqual([expect.stringContaining("grim exploded")]);
    expect(fs.readFileSync(path.join(dir, EXPORT, ".claude-plugin/marketplace.json"), "utf8")).toBe("previous");
    expect(meta()).toEqual({ clients: ["claude"], members: {} });
  });

  it("leaves the previous export and meta untouched when grim dies half-way through writing", async () => {
    curator();
    put(`${EXPORT}/.claude-plugin/marketplace.json`, "previous");
    put(META, '{"clients":["claude"],"members":{}}');
    const result = await enrichMarketplace(dir, async (args) => {
      const out = args[args.indexOf("-o") + 1]!;
      fs.mkdirSync(out, { recursive: true });
      fs.writeFileSync(path.join(out, "half.json"), "half");
      throw new Error("timed out");
    });
    expect(result.exported).toBe(false);
    expect(fs.readFileSync(exportFile(".claude-plugin/marketplace.json"), "utf8")).toBe("previous");
    expect(fs.existsSync(exportFile("half.json"))).toBe(false);
    expect(fs.readdirSync(path.join(dir, "enrich/marketplace")).sort()).toEqual(["export", "meta.json"]);
    expect(meta()).toEqual({ clients: ["claude"], members: {} });
  });

  it("names the missing command when grim is too old to have export marketplace", async () => {
    curator();
    const result = await enrichMarketplace(dir, async () => {
      throw Object.assign(new Error("Command failed: grim export marketplace"), {
        stderr: "error: unrecognized subcommand 'marketplace'",
      });
    });
    expect(result.exported).toBe(false);
    expect(result.warnings).toEqual([expect.stringMatching(/no `export marketplace`.*0\.15\.0/)]);
  });

  it("keeps the new export and still writes meta.json when the lock or the report cannot be parsed", async () => {
    curator("= not toml");
    put(`${EXPORT}/old.json`, "old");
    const result = await enrichMarketplace(dir, async (args) => {
      await reporting()(args);
      return "not a report";
    });
    expect(result).toMatchObject({ exported: true, plugins: 0 });
    expect(result.warnings.join("\n")).toContain("marketplace.lock unreadable");
    expect(result.warnings.join("\n")).not.toContain("keeping the previous");
    expect(fs.existsSync(exportFile("old.json"))).toBe(false);
    expect(meta()).toEqual({ repository: "https://github.com/acme/plugins", clients: [], members: {} });
  });

  it("does not run grim, and keeps the previous export, for a marketplace.toml that does not parse", async () => {
    put("marketplace.toml", "= not toml");
    put(`${EXPORT}/old.json`, "old");
    const calls: string[][] = [];
    const result = await enrichMarketplace(dir, reporting(calls));
    expect(calls).toEqual([]);
    expect(result.warnings).toEqual([expect.stringContaining("keeping the previous one")]);
    expect(fs.existsSync(exportFile("old.json"))).toBe(true);
  });

  it("lists a bundle include once as a bundle member, and not its constituents", async () => {
    const bundled = (name: string, extra: string[]) =>
      ["[[skill]]", `name = "${name}"`, 'plugin = "dev"', `pinned = "ghcr.io/acme/${name}${SHA}"`, ...extra, ""];
    curator(
      [
        '[[plugin]]\nname = "dev"\n',
        ...bundled("direct", []),
        ...bundled("a", ['bundle = "ghcr.io/acme/stack"', 'bundle_tag = "1"']),
        ...bundled("b", ['bundle = "ghcr.io/acme/stack"', 'bundle_tag = "1"']),
        ...bundled("c", ['bundles = [{ repo = "ghcr.io/acme/stack", tag = "1" }, { repo = "ghcr.io/acme/other", tag = "2" }]']),
      ].join("\n"),
    );
    await enrichMarketplace(dir, reporting());
    expect(meta().members).toEqual({
      dev: [
        { kind: "skill", name: "direct", ref: "ghcr.io/acme/direct" },
        { kind: "bundle", name: "stack", ref: "ghcr.io/acme/stack" },
        { kind: "bundle", name: "other", ref: "ghcr.io/acme/other" },
      ],
    });
  });

  it.each([
    ["a port and a digest", "localhost:5000/acme/x@sha256:" + "a".repeat(64), "localhost:5000/acme/x"],
    ["a tag and a digest", "ghcr.io/acme/x:1@sha256:" + "a".repeat(64), "ghcr.io/acme/x"],
    ["a port, a tag and a sha512 digest", "h:5000/acme/x:2@sha512:" + "b".repeat(128), "h:5000/acme/x"],
  ])("strips the digest and tag of a pinned ref with %s", async (_label, pinned, ref) => {
    curator(`[[plugin]]\nname = "dev"\n\n[[skill]]\nname = "x"\nplugin = "dev"\npinned = "${pinned}"\n`);
    await enrichMarketplace(dir, reporting());
    expect(meta().members).toEqual({ dev: [{ kind: "skill", name: "x", ref }] });
  });

  it("keys members by plugin name safely, even for __proto__ and constructor", async () => {
    const plugins = ["__proto__", "constructor", "toString"];
    curator(
      plugins
        .flatMap((name) => [
          `[[plugin]]\nname = "${name}"\n`,
          `[[skill]]\nname = "s"\nplugin = "${name}"\npinned = "ghcr.io/acme/s${SHA}"\n`,
        ])
        .join("\n"),
    );
    const result = await enrichMarketplace(dir, reporting());
    expect(result.exported).toBe(true);
    const members = meta().members as object;
    expect(Object.getOwnPropertyNames(members).sort()).toEqual([...plugins].sort());
    expect(Object.getPrototypeOf(members)).toBe(Object.prototype);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    for (const name of plugins) expect(Object.getOwnPropertyDescriptor(members, name)?.value).toHaveLength(1);
  });

  it("warns when grim rewrote marketplace.lock, and stays quiet when it did not", async () => {
    curator();
    const stale = await enrichMarketplace(dir, reporting([], () => put("marketplace.lock", LOCK + "\n# new\n")));
    expect(stale.warnings).toEqual(["marketplace.lock was stale; run grim update --marketplace and commit it"]);
    expect((await enrichMarketplace(dir, reporting())).warnings).toEqual([]);
  });

  it("warns when grim created a lock that did not exist", async () => {
    curator(null);
    const result = await enrichMarketplace(dir, reporting([], () => put("marketplace.lock", LOCK)));
    expect(result.warnings).toHaveLength(1);
    expect(meta().members).toHaveProperty("dev");
  });
});

describe("the dev fixture", () => {
  const FX = fileURLToPath(new URL("../fixtures/dev", import.meta.url));

  it("has the meta.json that enriching its marketplace.toml and lock produces", async () => {
    for (const f of ["marketplace.toml", "marketplace.lock"]) put(f, fs.readFileSync(path.join(FX, f), "utf8"));
    const clients = ["claude", "copilot", "codex", "qoder"].map((client) => ({ client, action: "written" }));
    await enrichMarketplace(dir, async (args) => {
      await reporting()(args);
      return { files: clients, items: [] };
    });
    expect(meta()).toEqual(JSON.parse(fs.readFileSync(path.join(FX, "enrich/marketplace/meta.json"), "utf8")));
    expect((meta().members as Record<string, { kind: string }[]>).hex!.map((m) => m.kind)).toContain("bundle");
  });
});

describe("the checkpoint carries the local marketplace tree", () => {
  const fresh = () => fs.mkdtempSync(path.join(os.tmpdir(), "mk-seed-"));

  it("packs meta.json and the export tree, and seeds them into an empty dir", async () => {
    curator();
    await enrichMarketplace(dir, reporting([], () => put(`${EXPORT}.next/claude/dev/skills/hex/SKILL.md`, "# hex")));
    const packed = packMarketplace(path.join(dir, "enrich/marketplace"));
    expect(Object.keys(packed?.files ?? {}).sort()).toEqual([
      "export/.claude-plugin/marketplace.json",
      "export/claude/dev/skills/hex/SKILL.md",
      "meta.json",
    ]);

    const target = fresh();
    try {
      expect(seedMarketplace(target, JSON.parse(JSON.stringify(packed)))).toBe(true);
      expect(fs.readFileSync(path.join(target, "export/claude/dev/skills/hex/SKILL.md"), "utf8")).toBe("# hex");
      expect(JSON.parse(fs.readFileSync(path.join(target, "meta.json"), "utf8"))).toEqual(meta());
      // the checkpoint fills gaps; it never overwrites
      expect(seedMarketplace(target, packed)).toBe(false);
    } finally {
      fs.rmSync(target, { recursive: true, force: true });
    }
  });

  it("packs nothing without a meta.json", () => {
    expect(packMarketplace(path.join(dir, "enrich/marketplace"))).toBeNull();
    put(`${EXPORT}/x`, "y");
    expect(packMarketplace(path.join(dir, "enrich/marketplace"))).toBeNull();
  });

  it("refuses Windows separators, drive and stream names, and directory entries", () => {
    const b64 = (s: string) => Buffer.from(s).toString("base64");
    const target = fresh();
    try {
      for (const bad of ["export/a\\..\\..\\x", "export\\a", "export/C:/x", "export/a:stream", "export/", "export/a/", "export/a\0b"]) {
        expect(seedMarketplace(target, { files: { "meta.json": b64("{}"), [bad]: b64("x") } })).toBe(true);
        expect(fs.readdirSync(target)).toEqual(["meta.json"]);
        fs.rmSync(path.join(target, "meta.json"));
      }
    } finally {
      fs.rmSync(target, { recursive: true, force: true });
    }
  });

  it("returns false instead of throwing, and leaves no live tree, when entries clash", () => {
    const b64 = (s: string) => Buffer.from(s).toString("base64");
    const target = fresh();
    try {
      const files = { "meta.json": b64("{}"), "export/a": b64("x"), "export/a/b": b64("y") };
      expect(seedMarketplace(target, { files })).toBe(false);
      expect(fs.existsSync(path.join(target, "meta.json"))).toBe(false);
      expect(fs.existsSync(path.join(target, "export"))).toBe(false);
    } finally {
      fs.rmSync(target, { recursive: true, force: true });
    }
  });

  it("refuses paths outside meta.json and export/, a missing meta.json, and the legacy shape", () => {
    const b64 = (s: string) => Buffer.from(s).toString("base64");
    const target = fresh();
    try {
      for (const bad of ["../escape", "export/../../escape", "/abs", "plugins.json", "docs/x/readme.md", "export//x"]) {
        expect(seedMarketplace(target, { files: { "meta.json": b64("{}"), [bad]: b64("x") } })).toBe(true);
        expect(fs.readdirSync(target)).toEqual(["meta.json"]);
        fs.rmSync(path.join(target, "meta.json"));
      }
      expect(seedMarketplace(target, { files: { "export/a": b64("x") } })).toBe(false);
      expect(seedMarketplace(target, { data: { url: "u", plugins: [] }, files: { "hex.png": b64("x") } })).toBe(false);
      expect(seedMarketplace(target, "nonsense")).toBe(false);
      expect(fs.readdirSync(target)).toEqual([]);
    } finally {
      fs.rmSync(target, { recursive: true, force: true });
    }
  });
});
