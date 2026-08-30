// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Grimoire Authors

// The two `watchTheme` failure branches C-005 names, neither of which has a
// seam from outside: the `'error'` event on the underlying watcher, and a
// `watch()` that throws for a reason other than a missing directory.
//
// Both are reached by replacing exactly one thing — `node:fs`'s named
// `watch`, and only for the theme directory. Everything else in `node:fs`,
// the default export included, stays real, so Vite's own watcher is
// untouched. Its own file because `vi.mock` is module-scoped: `dev.test.ts`
// needs the real `watch` to assert real mirroring.
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
// `vi.mock` below is hoisted above this import, so it is the mocked `node:fs`
// this module resolves against.
import { devSite, THEME_DIR } from "../../src/renderer/index.js";
import type { SiteConfig } from "../../src/config.js";

// Hoisted: `vi.mock`'s factory is lifted above every import, so a plain
// module-level `const` does not exist yet when it runs.
const fake = vi.hoisted(() => ({
  /** Set to the theme path the test wants intercepted; everything else is real. */
  target: null as string | null,
  /** Thrown from `watch()` instead of returning a watcher, when set. */
  failWith: null as Error | null,
  /** The handler `watchTheme` passed in — the test drives the mirror with it. */
  listener: null as ((event: string, name: string) => void) | null,
  /** The handle `watchTheme` attached its `'error'` listener to. */
  watcher: null as EventEmitter | null,
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    watch: (target: unknown, options: unknown, listener: unknown) => {
      if (fake.target === null || String(target) !== fake.target) {
        return (actual.watch as (...a: unknown[]) => unknown)(target, options, listener);
      }
      if (fake.failWith) throw fake.failWith;
      fake.listener = listener as (event: string, name: string) => void;
      const watcher = Object.assign(new EventEmitter(), { close: () => {} });
      fake.watcher = watcher;
      return watcher;
    },
  };
});

const FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixture");
const config: SiteConfig = { site: "https://index.example.test", brand: "acme package index" };

const servers: { stop(): Promise<void> }[] = [];
const roots: string[] = [];
const cwd = process.cwd();

async function bootedAgainstFakeWatcher(port: number): Promise<{ root: string; src: string }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "index-devfault-"));
  roots.push(root);
  const outDir = path.join(root, "dist");
  await fs.cp(FIXTURE, root, { recursive: true });
  await fs.mkdir(outDir, { recursive: true });
  await fs.rename(path.join(root, "all.json"), path.join(outDir, "all.json"));
  fake.target = path.join(root, THEME_DIR);
  const server = await devSite({ root, outDir, config, port });
  servers.push(server);
  const staged = (await fs.readdir(root)).filter((n) => n.startsWith(".index-"));
  return { root, src: path.join(root, staged[0] ?? "missing", "src") };
}

const exists = (p: string) => fs.stat(p).then(() => true, () => false);

async function waitFor(check: () => Promise<boolean>, ms = 10_000): Promise<boolean> {
  const deadline = Date.now() + ms;
  for (;;) {
    if (await check()) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

afterEach(async () => {
  for (const server of servers.splice(0)) await server.stop().catch(() => {});
  process.chdir(cwd);
  // `maxRetries` is load-bearing, not defensive noise. Vite's dependency
  // optimizer is still bundling when `stop()` deletes the staged tree, and it
  // recreates `<staged>/node_modules/.vite/deps_temp_<hash>/` afterwards —
  // `astro`'s `stop()` is `viteServer.close()`, which does not await it. That
  // lands a fresh child between this `rm`'s directory read and its final
  // `rmdir`, which is ENOTEMPTY, and is exactly the error Node documents
  // these two options for. It fails about one run in five without them.
  //
  // The same retry inside `stop()` would be cargo cult: there the straggler
  // writes after `rm` has already returned, so there is nothing left to retry.
  await Promise.all(
    roots.splice(0).map((r) => fs.rm(r, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })),
  );
  fake.target = null;
  fake.failWith = null;
  fake.listener = null;
  fake.watcher = null;
  vi.restoreAllMocks();
});

describe("a watcher fault", () => {
  it("logs it and disables mirroring, without taking the server down", async () => {
    const stderr: string[] = [];
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      stderr.push(args.map((a) => (typeof a === "string" ? a : String(a))).join(" "));
    });
    const { root, src } = await bootedAgainstFakeWatcher(4351);
    expect(fake.listener, "watchTheme must have attached a handler").not.toBeNull();
    expect(fake.watcher, "watchTheme must have attached an 'error' listener").not.toBeNull();

    // Mirroring works to begin with, or nothing below distinguishes
    // "disabled" from "never worked".
    await fs.mkdir(path.join(root, THEME_DIR, "pages"), { recursive: true });
    await fs.writeFile(path.join(root, THEME_DIR, "pages/before.astro"), "<p>before</p>\n");
    fake.listener!("change", "pages/before.astro");
    expect(await waitFor(() => exists(path.join(src, "pages/before.astro")))).toBe(true);

    const before = stderr.length;
    // The platform's recursive-watch backend giving up. It must degrade the
    // dev server to "restart to resync", not take it down.
    expect(() => fake.watcher!.emit("error", new Error("EMFILE: too many open files"))).not.toThrow();
    expect(stderr.slice(before).join("\n"), "the fault must reach stderr").toMatch(/EMFILE/);

    await fs.writeFile(path.join(root, THEME_DIR, "pages/after.astro"), "<p>after</p>\n");
    fake.listener!("change", "pages/after.astro");
    // Absence needs a settle rather than a poll: give the copy every chance
    // the mirrored one above actually took.
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(
      await exists(path.join(src, "pages/after.astro")),
      "mirroring must be disabled after the fault",
    ).toBe(false);

    // And the server is still up: `stop()` still tears its tree down.
    await expect(servers[0]!.stop()).resolves.toBeUndefined();
  }, 120_000);

  it("logs a watch() that fails for a reason other than a missing directory", async () => {
    const stderr: string[] = [];
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      stderr.push(args.map((a) => (typeof a === "string" ? a : String(a))).join(" "));
    });
    // ENOENT used to be the whole meaning of this catch — "no theme/, the
    // normal case". `ensureThemeDir` guarantees the directory now, so what
    // is left is a real fault, and swallowing it into a silent `null` is
    // what C-005 forbids.
    fake.failWith = Object.assign(new Error("EMFILE: too many open files, watch"), {
      code: "EMFILE",
    });
    await expect(bootedAgainstFakeWatcher(4352), "dev must still boot").resolves.toBeDefined();
    expect(stderr.join("\n")).toMatch(/EMFILE/);
  }, 120_000);
});
