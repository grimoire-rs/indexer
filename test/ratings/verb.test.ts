// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Grimoire Authors

// `grim-indexer ratings` — the verb, its exit codes, and the file it writes.
//
// Zero network: every request goes through the stubbed `fetch`.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { run } from "../../src/cli/main.js";
import { buildMarker } from "../../src/ratings/marker.js";
import { STATS_FILE } from "../../src/ratings/seed.js";
import { stubFetch, type Call, type Route } from "../validate/helpers.js";

const SITE = "https://index.example";
const STATS_URL = `${SITE}/stats.json`;
const API = "https://api.github.com/graphql";

let dir: string;
let logs: string[];
let errors: string[];

function write(rel: string, body: unknown): void {
  const target = path.join(dir, rel);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, typeof body === "string" ? body : JSON.stringify(body));
}

/** An index root with one package and ratings turned on. */
function scaffold(overrides: { ratings?: unknown; site?: string | null; bots?: unknown } = {}): void {
  const config: Record<string, unknown> = {
    ratings: overrides.ratings ?? { provider: "github", container: "Ratings" },
  };
  if (overrides.site !== null) config.site = overrides.site ?? SITE;
  write("index.config.json", config);
  write("index-policy.json", {
    trustedBots: overrides.bots ?? [{ login: "github-actions[bot]", id: "99" }],
  });
  for (const name of ["one", "two"]) {
    write(`index/ghcr.io/acme/${name}/metadata.json`, {
      schema: 1,
      name,
      kind: "skill",
      ref: `ghcr.io/acme/${name}`,
      description: "d",
      owner: { github: "acme", id: 7 },
    });
  }
}

function json(value: unknown): Route {
  return { body: JSON.stringify(value) };
}

const REPO = { id: "R_1", discussionCategories: { nodes: [{ id: "DIC_1", name: "Ratings" }] } };

function discussion(ref: string, up: number, id = `D_${ref}`): Record<string, unknown> {
  return {
    id,
    url: `https://github.com/acme/index/discussions/${id}`,
    upvoteCount: up,
    body: buildMarker(ref),
    category: { id: "DIC_1" },
    repository: { id: "R_1" },
    author: { databaseId: 99 },
  };
}

/**
 * Route by URL for the seed, then by GraphQL body for the forge. The seed is a
 * plain GET at a different host, so the two never collide.
 */
function routes(opts: {
  seed?: Route;
  pages?: Route[];
  create?: Route;
}): Call[] {
  let page = 0;
  const calls: Call[] = stubFetch((url) => {
    if (url === STATS_URL) return opts.seed ?? { status: 404 };
    const body = calls.at(-1)?.body ?? "";
    if (body.includes("discussionCategories")) return json({ data: { repository: REPO } });
    if (body.includes("createDiscussion")) {
      return (
        opts.create ??
        json({
          data: { createDiscussion: { discussion: { id: "D_new", url: "u", upvoteCount: 0 } } },
        })
      );
    }
    if (body.includes("lockLockable")) return json({ data: { lockLockable: {} } });
    const pages = opts.pages ?? [
      json({
        data: {
          repository: { discussions: { pageInfo: { hasNextPage: false }, nodes: [] } },
        },
      }),
    ];
    const route = pages[Math.min(page, pages.length - 1)];
    page += 1;
    return route ?? null;
  });
  return calls;
}

function stats(): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(dir, STATS_FILE), "utf8")) as Record<string, unknown>;
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "index-ratings-"));
  logs = [];
  errors = [];
  vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    logs.push(args.map(String).join(" "));
  });
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    errors.push(args.map(String).join(" "));
  });
  vi.stubEnv("GITHUB_REPOSITORY", "acme/index");
  vi.stubEnv("GITHUB_GRAPHQL_URL", API);
  vi.stubEnv("GITHUB_TOKEN", "s3cret");
  vi.stubEnv("GRIM_RATINGS_TOKEN", "");
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("ratings off", () => {
  it("no ratings block ⇒ exit 0 and no file written", async () => {
    write("index.config.json", { site: SITE });
    expect(await run(["node", "grim-indexer", "ratings", dir])).toBe(0);
    expect(fs.existsSync(path.join(dir, STATS_FILE))).toBe(false);
  });

  it("no index.config.json at all ⇒ exit 0", async () => {
    expect(await run(["node", "grim-indexer", "ratings", dir])).toBe(0);
  });
});

describe("config errors exit 65", () => {
  it("an unknown provider", async () => {
    scaffold({ ratings: { provider: "bitbucket", container: "Ratings" } });
    expect(await run(["node", "grim-indexer", "ratings", dir])).toBe(65);
  });

  it("no `site`, so the seed URL would point at someone else's index", async () => {
    scaffold({ site: null });
    expect(await run(["node", "grim-indexer", "ratings", dir])).toBe(65);
    expect(errors.join("\n")).toContain("site");
  });

  it("no trustedBots id, so R-1 could authorize nothing", async () => {
    scaffold({ bots: ["github-actions[bot]"] });
    expect(await run(["node", "grim-indexer", "ratings", dir])).toBe(65);
    expect(errors.join("\n")).toContain("trustedBots");
  });

  it("no token", async () => {
    scaffold();
    vi.stubEnv("GITHUB_TOKEN", "");
    expect(await run(["node", "grim-indexer", "ratings", dir])).toBe(65);
  });

  it("no repository to tally in", async () => {
    scaffold();
    vi.stubEnv("GITHUB_REPOSITORY", "");
    expect(await run(["node", "grim-indexer", "ratings", dir])).toBe(65);
  });
});

describe("a complete run", () => {
  it("writes the sidecar and logs one structured line", async () => {
    scaffold();
    routes({
      pages: [
        json({
          data: {
            repository: {
              discussions: {
                pageInfo: { hasNextPage: false },
                nodes: [discussion("ghcr.io/acme/one", 6)],
              },
            },
          },
        }),
      ],
    });

    expect(await run(["node", "grim-indexer", "ratings", dir])).toBe(0);
    expect(stats()).toEqual({
      schema_version: 1,
      generated_at: expect.stringMatching(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/) as unknown,
      providers: { rating: "github" },
      entries: {
        "ghcr.io/acme/one": {
          rating: { up: 6, target: "D_ghcr.io/acme/one", url: expect.any(String) as unknown },
        },
      },
    });
    expect(logs.join("\n")).toContain(
      "ratings: refs=2 created=1/1 tallied=1 conflicts=0 secondary_limit_hit=false",
    );
  });

  it("warns per conflicting ref", async () => {
    scaffold();
    routes({
      pages: [
        json({
          data: {
            repository: {
              discussions: {
                pageInfo: { hasNextPage: false },
                nodes: [
                  discussion("ghcr.io/acme/one", 6, "D_a"),
                  discussion("ghcr.io/acme/one", 2, "D_b"),
                ],
              },
            },
          },
        }),
      ],
    });
    expect(await run(["node", "grim-indexer", "ratings", dir])).toBe(0);
    expect(errors.join("\n")).toContain("delete all but one");
  });
});

describe("R-2 — nothing empties a published rating set", () => {
  it("a seed that does not parse fails the run (65) and writes nothing", async () => {
    scaffold();
    routes({ seed: { status: 200, body: "<html>" } });
    expect(await run(["node", "grim-indexer", "ratings", dir])).toBe(65);
    expect(fs.existsSync(path.join(dir, STATS_FILE))).toBe(false);
  });

  it("an unreachable seed fails the run (69) and writes nothing", async () => {
    scaffold();
    routes({ seed: { status: 503 } });
    expect(await run(["node", "grim-indexer", "ratings", dir])).toBe(69);
    expect(fs.existsSync(path.join(dir, STATS_FILE))).toBe(false);
  });

  it("a foreign stat key survives a rating run", async () => {
    scaffold();
    routes({
      seed: json({
        schema_version: 1,
        generated_at: "2026-01-01T00:00:00Z",
        providers: { rating: "github", downloads: "registry" },
        entries: { "ghcr.io/acme/two": { downloads: { total: 12 } } },
      }),
      pages: [
        json({
          data: {
            repository: {
              discussions: {
                pageInfo: { hasNextPage: false },
                nodes: [discussion("ghcr.io/acme/one", 6)],
              },
            },
          },
        }),
      ],
    });
    expect(await run(["node", "grim-indexer", "ratings", dir])).toBe(0);
    const entries = stats().entries as Record<string, unknown>;
    expect(entries["ghcr.io/acme/two"]).toEqual({ downloads: { total: 12 } });
    expect(stats().providers).toEqual({ rating: "github", downloads: "registry" });
  });
});

describe("secondary rate limits", () => {
  it("a limit while listing publishes a partial tally and exits 0", async () => {
    scaffold();
    routes({
      seed: json({
        schema_version: 1,
        generated_at: "2026-01-01T00:00:00Z",
        providers: { rating: "github" },
        entries: { "ghcr.io/acme/two": { rating: { up: 4, target: "old", url: "u" } } },
      }),
      pages: [
        json({
          data: {
            repository: {
              discussions: {
                pageInfo: { hasNextPage: true, endCursor: "c" },
                nodes: [discussion("ghcr.io/acme/one", 6)],
              },
            },
          },
        }),
        { status: 429, body: "", headers: { "retry-after": "60" } },
      ],
    });

    expect(await run(["node", "grim-indexer", "ratings", dir])).toBe(0);
    expect(logs.join("\n")).toContain("secondary_limit_hit=true");
    const entries = stats().entries as Record<string, Record<string, unknown>>;
    // Observed fresh, and the ref the truncated pass never reached kept its
    // published value rather than being wiped.
    expect(entries["ghcr.io/acme/one"]?.rating).toEqual({
      up: 6,
      target: "D_ghcr.io/acme/one",
      url: "https://github.com/acme/index/discussions/D_ghcr.io/acme/one",
    });
    expect(entries["ghcr.io/acme/two"]?.rating).toEqual({ up: 4, target: "old", url: "u" });
  });

  it("a limit before anything was observed exits 69 and writes nothing", async () => {
    scaffold();
    routes({ pages: [{ status: 429, body: "", headers: { "retry-after": "60" } }] });
    expect(await run(["node", "grim-indexer", "ratings", dir])).toBe(69);
    expect(fs.existsSync(path.join(dir, STATS_FILE))).toBe(false);
  });
});

describe("forge failures never become an empty tally", () => {
  it("a 200 carrying GraphQL errors exits non-zero and writes nothing", async () => {
    scaffold();
    routes({
      pages: [json({ data: { repository: null }, errors: [{ message: "Could not resolve" }] })],
    });
    const code = await run(["node", "grim-indexer", "ratings", dir]);
    expect(code).toBe(69);
    expect(code).not.toBe(0);
    expect(fs.existsSync(path.join(dir, STATS_FILE))).toBe(false);
    expect(errors.join("\n")).toContain("Could not resolve");
  });

  it("the new error classes map to an exit code, never to a generic 1", async () => {
    scaffold();
    vi.stubGlobal("fetch", (input: unknown) =>
      String(input) === STATS_URL
        ? Promise.resolve(new Response("", { status: 404 }))
        : Promise.reject(new Error("ECONNRESET")),
    );
    expect(await run(["node", "grim-indexer", "ratings", dir])).toBe(69);
  });
});
