// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Grimoire Authors

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { compileIndex, IndexValidationError, vetLogo } from "../../src/data/index.js";

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");

let outDir: string;

beforeEach(() => {
  outDir = fs.mkdtempSync(path.join(os.tmpdir(), "index-test-"));
});

afterEach(() => {
  fs.rmSync(outDir, { recursive: true, force: true });
});

describe("compileIndex", () => {
  it("compiles a marketplace-only repo with no index/ directory", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "index-empty-"));
    try {
      const result = await compileIndex({ root, outDir });
      expect(result).toEqual({ count: 0, namespaces: [] });
      expect(JSON.parse(fs.readFileSync(path.join(outDir, "all.json"), "utf8"))).toEqual([]);
      expect(fs.existsSync(path.join(outDir, "index"))).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("compiles a valid tree, merging the enrichment sidecar and copying the logo", async () => {
    const result = await compileIndex({ root: path.join(FIXTURES, "valid"), outDir });

    expect(result).toEqual({ count: 1, namespaces: ["github.com/acme"] });

    const all = JSON.parse(fs.readFileSync(path.join(outDir, "all.json"), "utf8"));
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({
      schema: 1,
      name: "foo",
      kind: "skill",
      ref: "ghcr.io/acme/skills/foo",
      description: "A test skill.",
      namespace: "github.com/acme",
      summary: "Enriched summary", // sidecar field survives
      version: "1.2.3",
    });
    // internal change-probe bookkeeping never ships
    expect(all[0]).not.toHaveProperty("descDigest");
    // …and so does the slice bookkeeping, or every re-describe would churn all.json
    expect(all[0]).not.toHaveProperty("describedAt");

    // index/ is copied verbatim
    expect(
      fs.existsSync(path.join(outDir, "index", "github.com", "acme", "foo", "metadata.json")),
    ).toBe(true);

    // logo copied to dist/logos/<ns>/<name>.<ext>
    expect(fs.existsSync(path.join(outDir, "logos", "github.com", "acme", "foo.png"))).toBe(true);

    // The enrichment checkpoint, published beside all.json. It carries the
    // `descDigest` all.json strips — that is the whole point, since it is what
    // the next run's `enrich --seed` compares against.
    const checkpoint = JSON.parse(fs.readFileSync(path.join(outDir, "enrich.json"), "utf8")) as {
      schema_version: number;
      packages: Record<string, { data: Record<string, unknown> }>;
    };
    expect(checkpoint.schema_version).toBe(1);
    expect(checkpoint.packages["github.com/acme/foo"].data).toHaveProperty("descDigest");
    expect(checkpoint.packages["github.com/acme/foo"].data).toHaveProperty("describedAt");
  });

  // An index with nothing enriched yet publishes no checkpoint at all: an
  // absent document and an empty one read identically, and not writing keeps
  // `dist/` honest about what this build actually had.
  it("publishes no checkpoint when nothing is enriched", async () => {
    await compileIndex({ root: path.join(FIXTURES, "no-enrich"), outDir });

    expect(fs.existsSync(path.join(outDir, "all.json"))).toBe(true);
    expect(fs.existsSync(path.join(outDir, "enrich.json"))).toBe(false);
  });

  it("lets index metadata win over the sidecar on key overlap", async () => {
    await compileIndex({ root: path.join(FIXTURES, "valid"), outDir });
    const all = JSON.parse(fs.readFileSync(path.join(outDir, "all.json"), "utf8"));
    // "name" is present in both index metadata and (implicitly) derived fields;
    // the index-owned description always wins — sidecar never carries description.
    expect(all[0].description).toBe("A test skill.");
  });

  it("degrades cleanly when enrich/ is missing entirely", async () => {
    const result = await compileIndex({ root: path.join(FIXTURES, "no-enrich"), outDir });
    expect(result.count).toBe(1);
    const all = JSON.parse(fs.readFileSync(path.join(outDir, "all.json"), "utf8"));
    expect(all[0]).toMatchObject({ name: "foo", namespace: "github.com/acme" });
    expect(fs.existsSync(path.join(outDir, "logos"))).toBe(false);
  });

  it("degrades cleanly when a logo key points at a missing file", async () => {
    const result = await compileIndex({ root: path.join(FIXTURES, "missing-logo-file"), outDir });
    expect(result.count).toBe(1);
    expect(fs.existsSync(path.join(outDir, "logos"))).toBe(false);
    const all = JSON.parse(fs.readFileSync(path.join(outDir, "all.json"), "utf8"));
    expect(all[0].logo).toBe("/logos/github.com/acme/foo.png"); // field kept, file just absent
  });

  it("rejects an unsupported schema version", async () => {
    await expect(
      compileIndex({ root: path.join(FIXTURES, "schema-mismatch"), outDir }),
    ).rejects.toThrow(IndexValidationError);
  });

  it("rejects a name that doesn't match its directory", async () => {
    await expect(
      compileIndex({ root: path.join(FIXTURES, "name-mismatch"), outDir }),
    ).rejects.toThrow(/name .* != directory/);
  });

  it("compiles a hook pointer", async () => {
    await compileIndex({ root: path.join(FIXTURES, "hook-kind"), outDir });

    const all = JSON.parse(fs.readFileSync(path.join(outDir, "all.json"), "utf8"));
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ name: "foo", kind: "hook" });
  });

  it("rejects an unknown kind", async () => {
    await expect(
      compileIndex({ root: path.join(FIXTURES, "bad-kind"), outDir }),
    ).rejects.toThrow(/kind must be one of/);
  });

  it("rejects an owner missing 'id'", async () => {
    await expect(
      compileIndex({ root: path.join(FIXTURES, "owner-missing-id"), outDir }),
    ).rejects.toThrow(/owner must be an object/);
  });
});

// A logo is served as a static file on the index origin, so what is published
// under `logos/` is decided by its bytes and extension, never by what the
// sidecar or a contributor's metadata claims.
describe("compileIndex logos", () => {
  const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
  const JPEG = Buffer.from("ffd8ffe000104a464946", "hex");
  const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
  const POLYGLOT = Buffer.concat([PNG, Buffer.from("<html><script>alert(1)</script></html>")]);
  const NS = "github.com/acme";

  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "index-logos-"));
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(root, { recursive: true, force: true });
  });

  /** One package `foo`; `logo` is what its sidecar declares, `file` the bytes shipped under `logo.<ext>`. */
  function pkg(opts: { logo?: unknown; file?: [string, Buffer]; meta?: Record<string, unknown> }): void {
    const index = path.join(root, "index", NS, "foo");
    fs.mkdirSync(index, { recursive: true });
    fs.writeFileSync(
      path.join(index, "metadata.json"),
      JSON.stringify({
        schema: 1,
        name: "foo",
        kind: "skill",
        ref: "ghcr.io/acme/foo",
        description: "d",
        owner: { id: 1, github: "acme" },
        ...opts.meta,
      }),
    );
    const enrich = path.join(root, "enrich", NS, "foo");
    fs.mkdirSync(enrich, { recursive: true });
    fs.writeFileSync(
      path.join(enrich, "data.json"),
      JSON.stringify(opts.logo === undefined ? {} : { logo: opts.logo }),
    );
    if (opts.file) fs.writeFileSync(path.join(enrich, opts.file[0]), opts.file[1]);
  }

  async function compile(): Promise<{ logo: unknown }> {
    await compileIndex({ root, outDir });
    return (JSON.parse(fs.readFileSync(path.join(outDir, "all.json"), "utf8")) as { logo: unknown }[])[0];
  }
  const published = (name: string) => fs.existsSync(path.join(outDir, "logos", NS, name));

  it("publishes a png under its declared path", async () => {
    pkg({ logo: `/logos/${NS}/foo.png`, file: ["logo.png", PNG] });
    expect((await compile()).logo).toBe(`/logos/${NS}/foo.png`);
    expect(fs.readFileSync(path.join(outDir, "logos", NS, "foo.png"))).toEqual(PNG);
  });

  it("keeps a .jpeg declared extension for jpeg bytes", async () => {
    pkg({ logo: `/logos/${NS}/foo.jpeg`, file: ["logo.jpeg", JPEG] });
    expect((await compile()).logo).toBe(`/logos/${NS}/foo.jpeg`);
    expect(published("foo.jpeg")).toBe(true);
  });

  it("nulls an svg logo and publishes nothing", async () => {
    pkg({ logo: `/logos/${NS}/foo.svg`, file: ["logo.svg", SVG] });
    expect((await compile()).logo).toBeNull();
    expect(fs.existsSync(path.join(outDir, "logos"))).toBe(false);
  });

  it("nulls a logo whose bytes are not the type its extension names", async () => {
    pkg({ logo: `/logos/${NS}/foo.png`, file: ["logo.png", JPEG] });
    expect((await compile()).logo).toBeNull();
    expect(published("foo.png")).toBe(false);
  });

  it("nulls a logo over the size cap", async () => {
    pkg({ logo: `/logos/${NS}/foo.png`, file: ["logo.png", Buffer.concat([PNG, Buffer.alloc(1024 * 1024)])] });
    expect((await compile()).logo).toBeNull();
    expect(published("foo.png")).toBe(false);
  });

  it("publishes a png+html polyglot only as .png, so the host serves it as an image", async () => {
    pkg({ logo: `/logos/${NS}/foo.png`, file: ["logo.png", POLYGLOT] });
    expect((await compile()).logo).toBe(`/logos/${NS}/foo.png`);
    expect(published("foo.png")).toBe(true);
    expect(fs.readdirSync(path.join(outDir, "logos", NS))).toEqual(["foo.png"]);
  });

  it("refuses the same polyglot under an html or svg extension", async () => {
    pkg({ logo: `/logos/${NS}/foo.html`, file: ["logo.html", POLYGLOT] });
    expect((await compile()).logo).toBeNull();
    expect(fs.existsSync(path.join(outDir, "logos"))).toBe(false);
  });

  it("nulls a declared logo with a disallowed extension even when no file was shipped", async () => {
    pkg({ logo: `/logos/${NS}/foo.svg` });
    expect((await compile()).logo).toBeNull();
  });

  it("keeps a declared allowed logo whose file was never shipped", async () => {
    pkg({ logo: `/logos/${NS}/foo.png` });
    expect((await compile()).logo).toBe(`/logos/${NS}/foo.png`);
    expect(fs.existsSync(path.join(outDir, "logos"))).toBe(false);
  });

  it("does not follow a symlinked logo out of the enrich tree", async () => {
    pkg({ logo: `/logos/${NS}/foo.png` });
    const secret = path.join(root, "secret.png");
    fs.writeFileSync(secret, PNG);
    fs.symlinkSync(secret, path.join(root, "enrich", NS, "foo", "logo.png"));
    expect((await compile()).logo).toBeNull();
    expect(published("foo.png")).toBe(false);
  });

  // Every vetted logo waits for the write loop, which at the design point is up
  // to one buffer per package, so the wait holds a path and the bytes are read
  // again, and checked again, when they are written.
  it("keeps a path, not the bytes, of a logo it has vetted", () => {
    pkg({ logo: `/logos/${NS}/foo.png`, file: ["logo.png", PNG] });
    const vetted = vetLogo(`/logos/${NS}/foo.png`, path.join(root, "enrich", NS, "foo"), NS, "foo");
    expect(vetted.file).toBeDefined();
    expect(Object.values(vetted.file!).filter((v) => typeof v !== "string")).toEqual([]);
  });

  // The check and the write are two reads. The bytes that were vetted are not
  // the bytes published if the file moved in between, so the build refuses.
  it.each([
    ["rewritten as an svg", (file: string) => fs.writeFileSync(file, SVG)],
    ["replaced by a symlink to a png", (file: string) => {
      const target = path.join(root, "elsewhere.png");
      fs.writeFileSync(target, PNG);
      fs.rmSync(file);
      fs.symlinkSync(target, file);
    }],
  ])("refuses a logo that was %s after it was vetted", async (_name, swap) => {
    pkg({ logo: `/logos/${NS}/foo.png`, file: ["logo.png", PNG] });
    const logoFile = path.join(root, "enrich", NS, "foo", "logo.png");
    const write = fs.writeFileSync;
    // `all.json` is written after the records are vetted and before any logo is.
    vi.spyOn(fs, "writeFileSync").mockImplementation((file, ...rest) => {
      if (String(file).endsWith("all.json")) swap(logoFile);
      return write(file, ...(rest as [never]));
    });

    await expect(compileIndex({ root, outDir })).rejects.toThrow(/foo\.png: logo changed after it was checked/);
    expect(published("foo.png")).toBe(false);
  });

  // A stale sidecar is still a file in the tree the site is built from.
  it("removes every sidecar logo that is not an allowed image, and keeps the one that is", async () => {
    pkg({ logo: `/logos/${NS}/foo.png`, file: ["logo.png", PNG] });
    const dir = path.join(root, "enrich", NS, "foo");
    fs.writeFileSync(path.join(dir, "logo.svg"), SVG);
    fs.writeFileSync(path.join(dir, "logo.jpeg"), PNG);
    const secret = path.join(root, "secret.gif");
    fs.writeFileSync(secret, Buffer.from("GIF89a"));
    fs.symlinkSync(secret, path.join(dir, "logo.gif"));

    expect((await compile()).logo).toBe(`/logos/${NS}/foo.png`);
    expect(fs.readdirSync(dir).filter((f) => f.startsWith("logo.")).sort()).toEqual(["logo.png"]);
    expect(fs.existsSync(secret)).toBe(true);
  });

  it("removes a stale svg sidecar that no record declares", async () => {
    pkg({ file: ["logo.svg", SVG] });
    await compile();
    expect(fs.existsSync(path.join(root, "enrich", NS, "foo", "logo.svg"))).toBe(false);
  });

  it("removes the stale svg of a package no longer in the index, and leaves the marketplace tree alone", async () => {
    pkg({});
    const gone = path.join(root, "enrich", NS, "gone");
    fs.mkdirSync(gone, { recursive: true });
    fs.writeFileSync(path.join(gone, "data.json"), "{}");
    fs.writeFileSync(path.join(gone, "logo.svg"), SVG);
    const plugin = path.join(root, "enrich", "marketplace", "export", "claude", "p", "assets");
    fs.mkdirSync(plugin, { recursive: true });
    fs.writeFileSync(path.join(plugin, "logo.svg"), SVG);

    await compile();
    expect(fs.existsSync(path.join(gone, "logo.svg"))).toBe(false);
    expect(fs.existsSync(path.join(plugin, "logo.svg"))).toBe(true);
  });

  // Index metadata wins over the sidecar on overlap, so a contributor's
  // `metadata.json` can set `logo` itself.
  it("forces a metadata-supplied logo to the path of the file that passed", async () => {
    pkg({ meta: { logo: "https://evil.example/x.png" }, file: ["logo.png", PNG] });
    expect((await compile()).logo).toBe(`/logos/${NS}/foo.png`);
  });

  it("nulls a metadata-supplied logo that points anywhere else", async () => {
    for (const logo of ["https://evil.example/x.png", "/logos/github.com/other/bar.png", "/logo.png", 5, {}]) {
      fs.rmSync(root, { recursive: true, force: true });
      pkg({ meta: { logo } });
      expect((await compile()).logo, JSON.stringify(logo)).toBeNull();
    }
  });
});
