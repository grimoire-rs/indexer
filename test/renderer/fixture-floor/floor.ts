// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Grimoire Authors

// The floor fixture: the small records checked in beside this file, plus the
// records at every `src/emit/records.ts` bound, which are built here because
// 5,000 members and a 1 MiB descriptor are not something to commit. The tests
// that need a built floor site share `buildFloor`.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildSite } from "../../../src/renderer/index.js";
import type { SiteConfig } from "../../../src/config.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const KiB = 1024;

export const NS = "github.com/acme";
/** Package page paths, relative to the output dir. */
export const PAGES = {
  small: `p/${NS}/floor-small/index.html`,
  bundle: `p/${NS}/floor-bundle/index.html`,
  maxBundle: `p/${NS}/floor-max-bundle/index.html`,
  maxMcp: `p/${NS}/floor-max-mcp/index.html`,
  readme: `p/${NS}/floor-readme/index.html`,
  quotes: `p/${NS}/floor-quotes/index.html`,
  plugin: "marketplace/bigplug/index.html",
} as const;
/** The record fields' emit bounds, for the assertions. */
export const BOUNDS = { tags: 128, members: 5000 } as const;

/** `s` repeated and cut to exactly `bytes` ASCII bytes. */
const fill = (s: string, bytes: number) => s.repeat(Math.ceil(bytes / s.length)).slice(0, bytes);

/** A markdown document of about `bytes`: headings and paragraphs, so a cut has block boundaries to land on. */
export function markdown(bytes: number): string {
  const para = "Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore.";
  let out = "";
  for (let i = 0; out.length < bytes; i++) out += `## Section ${i}\n\n${para} ${para}\n\n`;
  return out;
}

/** A record with every listed field at its emit bound. */
function maxRecord(kind: "bundle" | "mcp", name: string): Record<string, unknown> {
  const url = (host: string) => `https://${host}/` + fill("p", 2 * KiB - `https://${host}/`.length);
  const tags = Array.from({ length: BOUNDS.tags }, (_, i) => fill(`1.${i}.0-`, 7).padEnd(64, "x"));
  tags[0] = "latest";
  tags[1] = "1.0.0";
  return {
    schema: 1,
    name,
    kind,
    ref: `ghcr.io/acme/${name}`,
    namespace: NS,
    owner: { github: "acme", id: 1 },
    title: fill("T", 256),
    description: fill("A description sentence that fills the bound.\n", 16 * KiB),
    summary: fill("A summary sentence. ", KiB),
    repository: url("github.com"),
    url: url("acme.example"),
    documentation: url("docs.acme.example"),
    compatibility: fill("claude-code, ", 2 * KiB),
    version: "1.0.0",
    license: fill("L", 256),
    revision: "3f1c0d9a7b2e5148c6d0a94f2b7e8c1d5a6f0b39",
    vendor: fill("V", 256),
    authors: Array.from({ length: 16 }, (_, i) => fill(`Author ${i} `, 240)).join(", "),
    created: "2026-07-01T10:00:00+00:00",
    keywords: Array.from({ length: 32 }, (_, i) => fill(`kw${i}-`, 64)),
    tags,
    deprecated: fill("Deprecated; use the replacement. ", KiB),
    replacedBy: fill("r", 512),
    support: {
      issues: url("github.com"),
      chat: url("chat.acme.example"),
      contact: "support@acme.example",
      security: url("github.com"),
    },
    hasReadme: true,
    hasChangelog: true,
    updated: "2026-07-01T10:00:00+00:00",
  };
}

/** `maxRecord` with every free-text field made of `"`, which Astro prints as the six bytes of `&quot;`. */
function quotesRecord(name: string): Record<string, unknown> {
  const q = (bytes: number) => fill('"', bytes);
  return {
    ...maxRecord("bundle", name),
    title: q(256),
    description: q(16 * KiB),
    summary: q(KiB),
    compatibility: q(2 * KiB),
    license: q(256),
    vendor: q(256),
    authors: q(16 * 240),
    keywords: Array.from({ length: 32 }, () => q(64)),
    deprecated: q(KiB),
    replacedBy: q(512),
  };
}

/** A descriptor whose pretty JSON runs to about 1 MiB. */
function descriptor(): unknown {
  const env: Record<string, string> = {};
  for (let i = 0; JSON.stringify(env).length < 1024 * KiB - 64; i++) env[`FLOOR_VAR_${String(i).padStart(6, "0")}`] = fill("v", 40);
  return { name: "floor-max-mcp", command: "npx", args: ["-y", "floor-max-mcp"], env };
}

async function write(root: string, rel: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(path.join(root, rel)), { recursive: true });
  await fs.writeFile(path.join(root, rel), content);
}

/** Stages the floor fixture under a fresh temp root and builds the site there. */
export async function buildFloor(opts: { pageCap?: number; customCss?: string; config?: SiteConfig } = {}): Promise<{ root: string; outDir: string }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "floor-"));
  const outDir = path.join(root, "dist");
  await fs.cp(HERE, root, { recursive: true, filter: (src) => !src.endsWith(".ts") });
  await fs.mkdir(outDir, { recursive: true });

  const bundle = maxRecord("bundle", "floor-max-bundle");
  const mcp = maxRecord("mcp", "floor-max-mcp");
  const quotes = quotesRecord("floor-quotes");
  const readme = { schema: 1, name: "floor-readme", kind: "skill", ref: "ghcr.io/acme/floor-readme", namespace: NS,
    owner: { github: "acme", id: 1 }, description: "A skill with a very long README.", repository: "https://github.com/acme/floor-readme",
    version: "1.0.0", tags: ["latest", "1.0.0"], hasReadme: true, hasChangelog: false, updated: "2026-07-01T10:00:00+00:00" };
  const small = { schema: 1, name: "floor-small", kind: "bundle", ref: "ghcr.io/acme/floor-small", namespace: NS,
    owner: { github: "acme", id: 1 }, description: "A bundle well inside every bound.", repository: "https://github.com/acme/floor-small",
    version: "1.0.0", tags: ["latest", "1", "1.0", "1.0.0", "0.9.0", "0.8.0"], hasReadme: false, hasChangelog: false,
    updated: "2026-07-01T10:00:00+00:00" };
  const all = JSON.parse(await fs.readFile(path.join(root, "all.json"), "utf8")) as unknown[];
  await write(outDir, "all.json", JSON.stringify([...all, small, bundle, mcp, readme, quotes]));
  await fs.rm(path.join(root, "all.json"));

  const stats = JSON.parse(await fs.readFile(path.join(root, ".stats.json"), "utf8")) as {
    entries: Record<string, unknown>;
  };
  stats.entries["ghcr.io/acme/floor-max-bundle"] = {
    downloads: {
      total: 1_000_000,
      as_of: "2026-08-18T09:30:00Z",
      versions: Object.fromEntries((bundle.tags as string[]).slice(1).map((t, i) => [t, 1000 + i])),
    },
  };
  stats.entries["ghcr.io/acme/floor-small"] = {
    downloads: { total: 30, as_of: "2026-08-18T09:30:00Z", versions: { "1.0.0": 20, "0.9.0": 10 } },
  };
  await write(root, ".stats.json", JSON.stringify(stats));

  const e = (name: string) => `enrich/${NS}/${name}`;
  const members = JSON.stringify({ members: Array.from({ length: BOUNDS.members }, (_, i) => ({
    kind: "skill", name: `member-${i}`, id: `ghcr.io/other/member-${i}:1` })) });
  for (const name of ["floor-max-bundle", "floor-quotes"]) await write(root, `${e(name)}/contents.json`, members);
  await write(root, `${e("floor-small")}/contents.json`, JSON.stringify({ members: [
    { kind: "skill", name: "one", id: "ghcr.io/other/one:1" }, { kind: "rule", name: "two", id: "ghcr.io/other/two:1" } ] }));
  await write(root, `${e("floor-max-mcp")}/contents.json`, JSON.stringify(descriptor()));
  for (const name of ["floor-max-bundle", "floor-max-mcp", "floor-readme", "floor-quotes"]) await write(root, `${e(name)}/readme.md`, markdown(200 * KiB));
  for (const name of ["floor-max-bundle", "floor-quotes"]) await write(root, `${e(name)}/changelog.md`, markdown(200 * KiB));

  const config = { ...(JSON.parse(await fs.readFile(path.join(root, "index.config.json"), "utf8")) as SiteConfig), ...opts.config };
  if (opts.customCss !== undefined) {
    await write(root, "floor.css", opts.customCss);
    config.customCss = "floor.css";
  }
  await buildSite({ root, outDir, config, pageCap: opts.pageCap });
  return { root, outDir };
}
