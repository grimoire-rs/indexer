// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Grimoire Authors

// `devSite` — the one command whose whole job is the review loop for a
// branding change, and the half of the renderer with no coverage at all
// before this file.
//
// Everything here is a filesystem assertion. Astro's dev server does not
// route correctly nested inside vitest's own Vite — `scripts/dev.mjs
// --smoke` owns that half, and a `fetch` here 404s on a server that booted
// perfectly well. What this file asserts instead is what `watchTheme` and
// `stop()` do to the tree, which is where every contract below lives.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { devSite, THEME_DIR } from "../../src/renderer/index.js";
import type { SiteConfig } from "../../src/config.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(HERE, "fixture");
/** The working tree's own Astro sources — what `scripts/dev.mjs` passes. */
const LIVE_SRC = path.join(HERE, "../../src/renderer/astro");

const config: SiteConfig = {
  site: "https://index.example.test",
  brand: "acme package index",
};

const servers: { stop(): Promise<void> }[] = [];
const roots: string[] = [];
const cwd = process.cwd();

/**
 * A bare index repo, in the shipping shape: no `node_modules` on its parent
 * chain, no `theme/`. The scratch root is registered for teardown before
 * anything can throw, so an assertion failure never leaves one behind.
 */
async function indexRepo(): Promise<{ root: string; outDir: string }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "index-dev-"));
  roots.push(root);
  const outDir = path.join(root, "dist");
  await fs.cp(FIXTURE, root, { recursive: true });
  await fs.mkdir(outDir, { recursive: true });
  await fs.rename(path.join(root, "all.json"), path.join(outDir, "all.json"));
  return { root, outDir };
}

/** Boot a dev server, registered for teardown before it can be lost. */
async function start(opts: Parameters<typeof devSite>[0]) {
  const server = await devSite(opts);
  servers.push(server);
  return server;
}

/** The `.index-*` scratch dirs `stage` left in an index repo. */
async function stagedDirs(root: string): Promise<string[]> {
  return (await fs.readdir(root)).filter((n) => n.startsWith(".index-"));
}

/** The one staged `src/` a running dev server is serving from. */
async function stagedSrc(root: string): Promise<string> {
  const [dir, ...rest] = await stagedDirs(root);
  expect(dir, "dev must have staged exactly one scratch dir").toBeDefined();
  expect(rest, "dev must have staged exactly one scratch dir").toEqual([]);
  return path.join(root, dir!, "src");
}

const exists = (p: string) => fs.stat(p).then(() => true, () => false);

/**
 * Poll until `check` holds. The mirror is a watcher event feeding a
 * serialized copy queue, so there is nothing to await — and a fixed sleep
 * either flakes or wastes the difference.
 */
async function waitFor(check: () => Promise<boolean>, ms = 10_000): Promise<boolean> {
  const deadline = Date.now() + ms;
  for (;;) {
    if (await check()) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/** Write a file under `theme/`, creating the directories it needs. */
async function writeTheme(root: string, rel: string, body: string): Promise<void> {
  const file = path.join(root, THEME_DIR, rel);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, body);
}

// Teardown is the test's own job here: a leaked server holds a port and a
// chdir for the rest of the run, and vitest reports neither.
afterEach(async () => {
  vi.restoreAllMocks();
  for (const server of servers.splice(0)) await server.stop().catch(() => {});
  process.chdir(cwd);
  await Promise.all(roots.splice(0).map((r) => fs.rm(r, { recursive: true, force: true })));
});

describe("DevServer.stop()", () => {
  it("is idempotent — a second call re-runs no teardown", async () => {
    // C-006. `srcDir` deliberately: it is the one path with no theme
    // watcher, so what this measures is `stop()` and nothing else.
    const { root, outDir } = await indexRepo();
    const server = await start({ root, outDir, config, srcDir: LIVE_SRC, port: 4341 });
    const [staged] = await stagedDirs(root);
    expect(staged).toBeDefined();
    const stagedDir = path.join(root, staged!);

    await server.stop();
    expect(await stagedDirs(root), "the first stop() removes the staged tree").toEqual([]);

    // Stand a directory back up at the same path. A second `stop()` that
    // re-runs teardown deletes it; an idempotent one cannot see it at all.
    // This is the assertion, not "the second call resolves" — it already
    // resolves today, and still removes the tree a second time.
    await fs.mkdir(stagedDir, { recursive: true });
    await fs.writeFile(path.join(stagedDir, "sentinel"), "written after the first stop\n");

    await expect(server.stop()).resolves.toBeUndefined();
    expect(
      await exists(path.join(stagedDir, "sentinel")),
      "a second stop() must not remove the tree again",
    ).toBe(true);
  }, 120_000);
});

describe("watchTheme", () => {
  it("creates theme/ so one added after dev starts still mirrors", async () => {
    // C-005 / S-006. Nothing was watching for `theme/` to appear, so a
    // directory created after boot was 404 forever, silently.
    const { root, outDir } = await indexRepo();
    expect(await exists(path.join(root, THEME_DIR)), "the fixture ships no theme/").toBe(false);

    await start({ root, outDir, config, port: 4342 });
    const theme = path.join(root, THEME_DIR);
    expect((await fs.stat(theme)).isDirectory(), "dev must create theme/ to watch it").toBe(true);

    const src = await stagedSrc(root);
    await writeTheme(root, "pages/late.astro", "<p data-testid=\"late-page\">late</p>\n");
    // One observation, not two. A single save fires several watch events, and
    // each queues an `fs.cp` with `force: true`, which unlinks the target
    // before rewriting it — so a separate `readFile` after an `exists` poll
    // can land in a later copy's unlink window and get ENOENT on a file that
    // is arriving correctly. Waiting on the content is also the assertion
    // worth making: that the page mirrored, not merely that a name appeared.
    expect(
      await waitFor(async () =>
        (await fs.readFile(path.join(src, "pages/late.astro"), "utf8").catch(() => "")).includes(
          "late-page",
        ),
      ),
      "a page added after boot must reach the staged tree",
    ).toBe(true);
  }, 120_000);

  it("refuses a denied path in the dev mirror too", async () => {
    // C-001's other writer. A deny-list only the build honours lets an
    // author develop against `dev`, watch the denied file take effect,
    // ship it, and have the build drop it in silence.
    // Spy on `console.error` itself, not on the stream: vitest replaces
    // `console` with a reporter-bound object, so a stream-only spy captures
    // nothing and the assertion below would pass against no output at all.
    const stderr: string[] = [];
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      stderr.push(args.map((a) => (typeof a === "string" ? a : String(a))).join(" "));
    });

    const { root, outDir } = await indexRepo();
    await start({ root, outDir, config, port: 4343 });
    const theme = path.join(root, THEME_DIR);
    const src = await stagedSrc(root);

    // Shape one: a whole prepared subtree moved in. `fs.watch` adds a
    // per-directory watch only once a subtree exists, so this fires ONE
    // event naming `lib` and none for anything inside it — which is why
    // the rule has to be `fs.cp`'s per-entry filter and not a test on the
    // event path.
    const prepared = await fs.mkdtemp(path.join(os.tmpdir(), "index-dev-prep-"));
    roots.push(prepared);
    for (const [dir, file] of [
      ["lib", "moved.ts"],
      ["extra", "note.ts"],
    ]) {
      await fs.mkdir(path.join(prepared, dir!), { recursive: true });
      await fs.writeFile(path.join(prepared, dir!, file!), `export const x = "${dir!}";\n`);
    }
    await fs.rename(path.join(prepared, "lib"), path.join(theme, "lib"));
    await fs.rename(path.join(prepared, "extra"), path.join(theme, "extra"));

    // Shape two: an ordinary save inside a denied directory that now exists.
    await writeTheme(root, "lib/written.ts", 'export const x = "written";\n');
    // The sentinel goes last, so the queue has drained past both shapes by
    // the time it lands — the copy queue is serialized in event order.
    await writeTheme(root, "pages/sentinel.astro", "<p>sentinel</p>\n");

    expect(
      await waitFor(
        async () =>
          (await exists(path.join(src, "pages/sentinel.astro"))) &&
          (await exists(path.join(src, "extra/note.ts"))),
      ),
      "the allowed paths must mirror, or the denied assertions below prove nothing",
    ).toBe(true);

    // The author has to be told why. A dev mirror that refuses a path in
    // silence is the build defect read backwards — the file simply does not
    // take effect and nothing says so — and dev is where an author meets it
    // first, since dev is where the theme gets written.
    //
    // One line names the RULE, not each path that tripped it. Unlike the
    // build, whose copy root is `theme/` and whose filter therefore judges
    // `lib` once, the dev copy root is whatever the watcher named, so the
    // filter is asked about `lib`, `lib/moved.ts` and `lib/written.ts` in
    // turn. All three are the same refusal.
    const denyLines = stderr.filter((l) => l.includes("not mirrored"));
    expect(denyLines, "one line naming the deny entry, not one per path").toEqual([
      `${THEME_DIR}/lib: not mirrored — grimoire-indexer keeps its own copy of this path`,
    ]);

    // Saving the same denied path again must not print it again.
    await writeTheme(root, "lib/written.ts", 'export const x = "written twice";\n');
    await writeTheme(root, "pages/second.astro", "<p>second</p>\n");
    expect(await waitFor(() => exists(path.join(src, "pages/second.astro")))).toBe(true);
    expect(
      stderr.filter((l) => l.includes("not mirrored")).length,
      "a re-save of a denied path must not reprint",
    ).toBe(1);

    expect(await exists(path.join(src, "lib/moved.ts")), "a moved-in denied subtree").toBe(false);
    expect(await exists(path.join(src, "lib/written.ts")), "a save under a denied dir").toBe(false);
    // And the shipped helper is still the shipped one, not merged over.
    expect(await fs.readFile(path.join(src, "lib/data.ts"), "utf8")).toContain("__GRIMOIRE_DATA__");
  }, 120_000);

  it("removes the theme/ it created when close() leaves it empty", async () => {
    // Running `dev` against an index with no theme must not litter that
    // repo with an empty directory it never asked for.
    const { root, outDir } = await indexRepo();
    const server = await start({ root, outDir, config, port: 4344 });
    expect(await exists(path.join(root, THEME_DIR))).toBe(true);
    await server.stop();
    expect(await exists(path.join(root, THEME_DIR)), "an empty theme/ goes again").toBe(false);
  }, 120_000);

  it("keeps a theme/ the author put a file into", async () => {
    // The guard is `fs.rmdir` without `recursive` failing on a non-empty
    // directory — so the author's own file is what stops the removal, and
    // `stop()` still resolves.
    const { root, outDir } = await indexRepo();
    const server = await start({ root, outDir, config, port: 4345 });
    const src = await stagedSrc(root);
    await writeTheme(root, "pages/kept.astro", "<p>kept</p>\n");
    expect(await waitFor(() => exists(path.join(src, "pages/kept.astro")))).toBe(true);

    await expect(server.stop()).resolves.toBeUndefined();
    expect(await exists(path.join(root, THEME_DIR, "pages/kept.astro"))).toBe(true);
  }, 120_000);
});
