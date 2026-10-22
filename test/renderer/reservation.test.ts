// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Grimoire Authors

// `c/` and `browse/` belong to the catalog plane in every layout. An
// operator-owned file, or a file of the configured theme package, that would
// publish under either exits 65 before Astro runs, naming the file and the move.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { run } from "../../src/cli/main.js";
import { RenderInputError, assertReservedPaths, buildSite } from "../../src/renderer/index.js";

let root: string;

function put(rel: string): void {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "x");
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "index-reserved-"));
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

describe("reserved c/ and browse/ (IX-R02)", () => {
  it.each([
    ["public/c/x", "public/c/x"],
    ["public/browse/x", "public/browse/x"],
    ["theme/pages/c/x.astro", "theme/pages/c/x.astro"],
    ["theme/pages/browse/index.astro", "theme/pages/browse/index.astro"],
    ["a page that is the reserved route itself", "theme/pages/c.astro"],
    ["a markdown page at the reserved route", "theme/pages/browse.md"],
    ["a file named c in public/", "public/c"],
    ["a differently-cased reserved directory", "public/C/x"],
  ])("rejects %s, naming the file and the move", async (_name, file) => {
    put(file);
    const err = await assertReservedPaths(root).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RenderInputError);
    expect((err as Error).message).toContain(file);
    expect((err as Error).message).toMatch(/reserved/);
    expect((err as Error).message).toMatch(/move/);
  });

  it("names every colliding file", async () => {
    put("public/c/a");
    put("public/browse/b");
    put("theme/pages/c/p.astro");
    const err = (await assertReservedPaths(root).catch((e: unknown) => e)) as Error;
    for (const file of ["public/c/a", "public/browse/b", "theme/pages/c/p.astro"]) {
      expect(err.message).toContain(file);
    }
  });

  it("passes a clean layer, similar names, and the output directory", async () => {
    for (const file of [
      "public/favicon.svg",
      "public/c.json",
      "public/cards/x",
      "public/browser/x",
      "theme/pages/setup.astro",
      "theme/pages/cart.astro",
      "theme/pages/c.json.ts",
      "theme/components/c/Card.astro",
      // The plane's own output: `outDir` is the build's last `public/` layer.
      "dist/c/root.json",
      "dist/browse/index.html",
    ]) {
      put(file);
    }
    await expect(assertReservedPaths(root)).resolves.toBeUndefined();
  });

  it("passes a root with no public/ or theme/ at all", async () => {
    await expect(assertReservedPaths(root)).resolves.toBeUndefined();
  });

  describe("in a theme package", () => {
    const NAME = "@acme/theme";
    let pkg: string;

    /** `files` in the package a build resolves from `root`; `linked` puts it behind a link, as pnpm does. */
    function install(files: string[], linked = false): void {
      const real = path.join(root, linked ? ".store/acme-theme" : "node_modules/@acme/theme");
      fs.mkdirSync(real, { recursive: true });
      fs.writeFileSync(path.join(real, "package.json"), JSON.stringify({ name: NAME }));
      for (const rel of files) {
        fs.mkdirSync(path.dirname(path.join(real, rel)), { recursive: true });
        fs.writeFileSync(path.join(real, rel), "x");
      }
      if (linked) {
        fs.mkdirSync(path.join(root, "node_modules/@acme"), { recursive: true });
        fs.symlinkSync(real, path.join(root, "node_modules/@acme/theme"), "junction");
      }
      pkg = real;
    }

    const build = (): Promise<unknown> => buildSite({ root, outDir: path.join(root, "dist"), config: { theme: NAME } }).catch((e: unknown) => e);

    it.each([
      ["public/c/root.json", `${NAME}/public/c/root.json`],
      ["public/browse/x", `${NAME}/public/browse/x`],
      ["theme/pages/browse/index.astro", `${NAME}/theme/pages/browse/index.astro`],
      ["theme/pages/c.astro", `${NAME}/theme/pages/c.astro`],
    ])("rejects %s, naming the file and the move, before anything is staged", async (file, named) => {
      for (const linked of [false, true]) {
        fs.rmSync(path.join(root, "node_modules"), { recursive: true, force: true });
        fs.rmSync(path.join(root, ".store"), { recursive: true, force: true });
        install([file], linked);
        const err = await build();
        expect(err, `linked: ${linked}`).toBeInstanceOf(RenderInputError);
        expect((err as Error).message).toContain(named);
        expect((err as Error).message).toMatch(/reserved/);
        expect((err as Error).message).toMatch(/move/);
        expect(fs.readdirSync(root).filter((name) => name.startsWith(".index-"))).toEqual([]);
      }
    });

    it("names the package's files beside the operator's own", async () => {
      put("public/c/a");
      install(["theme/pages/browse/index.astro"]);
      const err = (await build()) as Error;
      expect(err.message).toContain("public/c/a");
      expect(err.message).toContain(`${NAME}/theme/pages/browse/index.astro`);
    });

    it("passes a package that keeps to its own paths", async () => {
      install(["public/favicon.svg", "public/cards/x", "theme/pages/setup.astro", "theme/components/c/Card.astro", "theme.css"]);
      await expect(assertReservedPaths(root, { name: NAME, dir: pkg })).resolves.toBeUndefined();
    });
  });

  it("fails buildSite before it stages anything", async () => {
    put("public/c/x");
    const outDir = path.join(root, "dist");
    await expect(buildSite({ root, outDir, config: {} })).rejects.toBeInstanceOf(RenderInputError);
    expect(fs.readdirSync(root).filter((name) => name.startsWith(".index-"))).toEqual([]);
  });

  it("makes `build` exit 65", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const errors: string[] = [];
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => errors.push(args.map(String).join(" ")));
    await run(["node", "grim-indexer", "init", root, "--quick", "--no-git", "--no-install", "--name", "acme", "--base-url", "https://index.acme.test"]);
    put("public/c/x");

    expect(await run(["node", "grim-indexer", "build", root])).toBe(65);
    expect(errors.join("\n")).toContain("public/c/x");
  }, 60_000);
});
