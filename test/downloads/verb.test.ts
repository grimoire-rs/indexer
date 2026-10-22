// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Grimoire Authors

// `grim-indexer downloads` — the verb reads its seed through the published
// root (IX-R49), the way `ratings` does. A `legacy: false` site serves no
// `/stats.json`, so a verb that asked for one would read the 404 as the first
// run and publish the counts with every carried rating gone (R-2).
//
// Zero network: every request goes through the stubbed `fetch`.
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { run } from "../../src/cli/main.js";
import { STATS_FILE } from "../../src/ratings/seed.js";
import { rootJson } from "../state/loopback.js";
import { stubFetch, type Call, type Route } from "../validate/helpers.js";

const SITE = "https://index.example";
const ROOT_URL = `${SITE}/c/root.json`;
const BLOB_URL = `${SITE}/c/f/sha256/`;
const LEGACY_URL = `${SITE}/stats.json`;
const BASE = "https://artifactory.example.com/artifactory";
const REPO = "oci-grim";
const REF = `artifactory.example.com/${REPO}/skills/grim-usage`;
const OTHER = "ghcr.io/acme/other";
const DIGEST = "a".repeat(64);

/** What the live site publishes: a rating on each ref, which this verb never computes. */
const PUBLISHED =
  JSON.stringify(
    {
      schema_version: 1,
      generated_at: "2026-10-21T09:30:00Z",
      providers: { rating: "github" },
      entries: {
        [REF]: { rating: { up: 6, target: "t", url: "u" } },
        [OTHER]: { rating: { up: 2, target: "t2", url: "u2" } },
      },
    },
    null,
    2,
  ) + "\n";

const refOf = (text: string): { sha256: string; size: number } => {
  const bytes = Buffer.from(text);
  return { sha256: createHash("sha256").update(bytes).digest("hex"), size: bytes.length };
};

let dir: string;
let logs: string[];
let errors: string[];

function write(rel: string, body: unknown): void {
  const target = path.join(dir, rel);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, typeof body === "string" ? body : JSON.stringify(body));
}

/** An index root with one artifact and download counts turned on. */
function scaffold(site: string | null = SITE): void {
  write("index.config.json", { ...(site === null ? {} : { site }), downloads: { baseUrl: BASE } });
  write(`index/${REF}/metadata.json`, {
    schema: 1,
    name: "grim-usage",
    kind: "skill",
    ref: REF,
    description: "d",
    owner: { github: "acme", id: 7 },
  });
}

/** Route the seed by URL, then Artifactory by path; anything unrouted is a 404. */
function routes(opts: { root?: Route; blob?: Route; legacy?: Route }): Call[] {
  return stubFetch((url) => {
    if (url.startsWith(`${ROOT_URL}?`)) return opts.root ?? { status: 404 };
    if (url.startsWith(BLOB_URL)) return opts.blob ?? { status: 404 };
    if (url === LEGACY_URL) return opts.legacy ?? { status: 404 };
    if (url === `${BASE}/api/repositories`) return { body: JSON.stringify([{ key: REPO }]) };
    if (url === `${BASE}/api/search/aql`) {
      const row = (folder: string, downloads?: number): Record<string, unknown> => ({
        repo: REPO,
        path: `skills/grim-usage/${folder}`,
        name: "manifest.json",
        sha256: DIGEST,
        ...(downloads === undefined ? {} : { stats: [{ downloads }] }),
      });
      return { body: JSON.stringify({ results: [row("1.0.0"), row(`sha256:${DIGEST}`, 5)] }) };
    }
    return null;
  });
}

/** The published document as a root names it. The blob arrives decoded, as a CDN may serve it. */
function anchored(text = PUBLISHED): { root: Route; blob: Route } {
  return { root: { body: rootJson({ stats: refOf(text) }) }, blob: { body: text } };
}

function stats(): { entries: Record<string, Record<string, unknown>>; providers: Record<string, unknown> } {
  return JSON.parse(fs.readFileSync(path.join(dir, STATS_FILE), "utf8")) as ReturnType<typeof stats>;
}

const verb = (): Promise<number> => run(["node", "grim-indexer", "downloads", dir]);
const urls = (calls: Call[]): string[] => calls.map((call) => call.url);

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "index-downloads-"));
  logs = [];
  errors = [];
  vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    logs.push(args.map(String).join(" "));
  });
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    errors.push(args.map(String).join(" "));
  });
  vi.stubEnv("GRIM_DOWNLOADS_TOKEN", "t");
  vi.stubEnv("JF_ACCESS_TOKEN", "");
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("IX-R49 — the seed is read through the published root", () => {
  it("a legacy:false site keeps its ratings without serving /stats.json", async () => {
    scaffold();
    const calls = routes(anchored());

    expect(await verb()).toBe(0);

    const { entries, providers } = stats();
    // The counts this run computed...
    expect(entries[REF]?.downloads).toMatchObject({ total: 5, versions: { "1.0.0": 5 } });
    // ...beside every rating it never touched, on the counted ref and on the other one.
    expect(entries[REF]?.rating).toEqual({ up: 6, target: "t", url: "u" });
    expect(entries[OTHER]?.rating).toEqual({ up: 2, target: "t2", url: "u2" });
    expect(providers).toEqual({ rating: "github", downloads: "artifactory" });
    expect(urls(calls)).not.toContain(LEGACY_URL);
    expect(urls(calls).some((url) => url.startsWith(BLOB_URL))).toBe(true);
  });

  it("a root that answers 5xx fails the run (69) before Artifactory is asked", async () => {
    scaffold();
    const calls = routes({ root: { status: 503 }, legacy: { body: JSON.stringify({ entries: {} }) } });

    expect(await verb()).toBe(69);

    expect(fs.existsSync(path.join(dir, STATS_FILE))).toBe(false);
    expect(urls(calls)).toEqual([expect.stringContaining(ROOT_URL)]);
  });

  it("a named blob that 404s fails the run (69), writes no file and never reads /stats.json", async () => {
    scaffold();
    const calls = routes({ root: anchored().root, legacy: { body: JSON.stringify({ entries: {} }) } });

    expect(await verb()).toBe(69);

    expect(fs.existsSync(path.join(dir, STATS_FILE))).toBe(false);
    expect(urls(calls)).not.toContain(LEGACY_URL);
    expect(urls(calls).some((url) => url.startsWith(BASE))).toBe(false);
  });

  it("a blob that does not match its digest fails the run (65) and writes no file", async () => {
    scaffold();
    const { root } = anchored();
    const calls = routes({ root, blob: { body: PUBLISHED.replace("6", "7") } });

    expect(await verb()).toBe(65);

    expect(fs.existsSync(path.join(dir, STATS_FILE))).toBe(false);
    expect(urls(calls).some((url) => url.startsWith(BASE))).toBe(false);
  });

  it("a .stats.json an earlier producer left wins, and the site is asked nothing", async () => {
    scaffold();
    fs.writeFileSync(path.join(dir, STATS_FILE), JSON.stringify({ providers: { rating: "gitlab" }, entries: {} }));
    const calls = routes(anchored());

    expect(await verb()).toBe(0);

    expect(stats().providers).toEqual({ rating: "gitlab", downloads: "artifactory" });
    expect(urls(calls).some((url) => url.startsWith(SITE))).toBe(false);
  });
});

describe("`site` is the explicit https value or the run fails (F-6)", () => {
  it("refuses an absent site, never defaulting to the first-party index", async () => {
    scaffold(null);
    const calls = routes(anchored());

    expect(await verb()).toBe(65);

    expect(errors.join("\n")).toContain("downloads: index.config.json needs an explicit https `site`");
    expect(calls).toHaveLength(0);
  });

  it("refuses a site that is not https", async () => {
    scaffold("http://index.example");
    const calls = routes(anchored());

    expect(await verb()).toBe(65);

    expect(errors.join("\n")).toContain("explicit https `site`");
    expect(calls).toHaveLength(0);
  });
});
