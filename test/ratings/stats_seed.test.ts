// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Grimoire Authors

// `grim-indexer stats-seed` — the deploy's seed step (IX-R49, R-2). It carries
// the published stats document into `.stats.json` when no collector left a
// fresh one, through the root, because a `legacy: false` site serves no
// `/stats.json` for a shell `curl` to find.
//
// Zero network: every request goes through the stubbed `fetch`.
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { run } from "../../src/cli/main.js";
import { STATS_FILE } from "../../src/ratings/seed.js";
import { stubFetch, type Call, type Route } from "../validate/helpers.js";
import { rootJson } from "../state/loopback.js";

const SITE = "https://index.example";
const ROOT = `${SITE}/c/root.json`;
const BLOB = `${SITE}/c/f/sha256/`;
const LEGACY = `${SITE}/stats.json`;
const DECOY = `${SITE}/decoy`;

/** What the live site publishes: byte-exact, because the file is carried forward untouched. */
const PUBLISHED =
  JSON.stringify(
    {
      schema_version: 1,
      generated_at: "2026-10-21T09:30:00Z",
      providers: { rating: "github" },
      entries: { "ghcr.io/acme/one": { rating: { up: 6, target: "t", url: "u" } } },
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

function config(site: unknown): void {
  fs.writeFileSync(path.join(dir, "index.config.json"), JSON.stringify(site === undefined ? {} : { site }));
}

function target(): string {
  return path.join(dir, STATS_FILE);
}

/** Route by URL; anything unrouted is a 404. The blob is served decoded, as a CDN may. */
function site(routes: { root?: Route; blob?: Route; legacy?: Route; decoy?: Route }): Call[] {
  return stubFetch((url) => {
    if (url.startsWith(`${ROOT}?`)) return routes.root ?? { status: 404 };
    if (url.startsWith(BLOB)) return routes.blob ?? { status: 404 };
    if (url === LEGACY) return routes.legacy ?? { status: 404 };
    if (url === DECOY) return routes.decoy ?? { status: 404 };
    return null;
  });
}

const anchored = (text = PUBLISHED, over: Partial<{ root: Route; blob: Route }> = {}): { root: Route; blob: Route } => ({
  root: { body: rootJson({ stats: refOf(text) }) },
  blob: { body: text },
  ...over,
});

const seed = (): Promise<number> => run(["node", "grim-indexer", "stats-seed", dir]);

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "stats-seed-"));
  logs = [];
  errors = [];
  config(SITE);
  vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    logs.push(args.map(String).join(" "));
  });
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    errors.push(args.map(String).join(" "));
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("a fresh document wins", () => {
  it("leaves a .stats.json a collector wrote alone, and asks the site nothing", async () => {
    fs.writeFileSync(target(), '{"fresh":true}\n');
    const calls = site(anchored());

    expect(await seed()).toBe(0);

    expect(fs.readFileSync(target(), "utf8")).toBe('{"fresh":true}\n');
    expect(calls).toHaveLength(0);
  });
});

describe("carries the published document forward, byte for byte", () => {
  it("through the root's stats blob, with no /stats.json on the site", async () => {
    const calls = site(anchored());

    expect(await seed()).toBe(0);

    // Verbatim: the document's own `generated_at` is what keeps an unchanged rebuild unchanged.
    expect(fs.readFileSync(target(), "utf8")).toBe(PUBLISHED);
    expect(calls.map((call) => call.url)).not.toContain(LEGACY);
  });

  it("through /stats.json when the site publishes no root yet", async () => {
    site({ legacy: { body: PUBLISHED } });

    expect(await seed()).toBe(0);
    expect(fs.readFileSync(target(), "utf8")).toBe(PUBLISHED);
  });

  it("writes nothing when nothing is published: the first run", async () => {
    site({});

    expect(await seed()).toBe(0);
    expect(fs.existsSync(target())).toBe(false);
    expect(logs.join("\n")).toContain("empty seed");
  });
});

describe("a .stats.json that is a dangling link", () => {
  it("is not written through: the seed refuses it and the link target is never created", async () => {
    const victim = path.join(dir, "victim.json");
    fs.symlinkSync(victim, target());
    site(anchored());

    expect(await seed()).not.toBe(0);

    expect(errors.join("\n")).toMatch(/EEXIST/);
    expect(fs.existsSync(victim)).toBe(false);
  });
});

describe("an unreadable seed fails the job and writes nothing (R-2)", () => {
  async function fails(routes: Parameters<typeof site>[0], code: number): Promise<Call[]> {
    const calls = site({ legacy: { body: JSON.stringify({ entries: {} }) }, ...routes });

    expect(await seed()).toBe(code);
    expect(fs.existsSync(target())).toBe(false);
    // The legacy file is a decoy that would read as an emptied rating set.
    expect(calls.map((call) => call.url)).not.toContain(LEGACY);
    return calls;
  }

  it("a root that answers 5xx (69)", async () => {
    await fails({ root: { status: 503 } }, 69);
  });

  // A stubbed `fetch` follows nothing, so the proof that a redirect is refused
  // is the `redirect: "manual"` every call carries; the real-socket proof is in
  // `seed_root.test.ts`.
  const redirect: Route = { status: 302, headers: { Location: DECOY } };
  const notFollowed = (calls: Call[]): void => {
    expect(calls.map((call) => call.url)).not.toContain(DECOY);
    expect(calls.every((call) => call.redirect === "manual")).toBe(true);
  };

  it("a root that redirects (69), and its Location is not followed", async () => {
    notFollowed(await fails({ root: redirect, decoy: anchored().root }, 69));
  });

  it("a stats blob that redirects (69), and its Location is not followed", async () => {
    notFollowed(await fails({ ...anchored(), blob: redirect, decoy: { body: PUBLISHED } }, 69));
  });

  it("a named blob that 404s (69)", async () => {
    await fails({ ...anchored(), blob: { status: 404 } }, 69);
  });

  it("a blob that does not match the root's digest (65)", async () => {
    await fails(anchored(PUBLISHED, { blob: { body: PUBLISHED.replace("6", "7") } }), 65);
  });

  it("a verified blob that is not a stats document (65)", async () => {
    await fails(anchored("<html>sign in</html>"), 65);
  });

  it("a verified blob whose entries are the wrong shape (65)", async () => {
    await fails(anchored(JSON.stringify({ entries: [] })), 65);
  });
});

describe("`site` is the explicit https value or the job fails (F-6)", () => {
  it("refuses an absent site, never defaulting to the first-party index", async () => {
    config(undefined);
    const calls = site(anchored());

    expect(await seed()).toBe(65);
    expect(errors.join("\n")).toContain("site");
    expect(calls).toHaveLength(0);
  });

  it("refuses a site that is not https", async () => {
    config("http://index.example/catalog");
    const calls = site(anchored());

    expect(await seed()).toBe(65);
    expect(errors.join("\n")).toContain("https");
    expect(calls).toHaveLength(0);
  });
});
