// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Grimoire Authors

// IX-R49 / V-40 seed cases: the ratings and downloads seeds read the previous
// stats through the published root, because a `legacy: false` site has no
// `/stats.json` and an empty seed would wipe every carried rating (R-2).
//
// A real socket, not a stubbed `fetch`: whether the blob is inflated, decoded in
// transit, or neither is a claim about bytes on the wire.
import { createHash } from "node:crypto";
import fs from "node:fs";
import type http from "node:http";
import os from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CliError, EXIT } from "../../src/cli/exit.js";
import { gzipDeterministic } from "../../src/emit/gzip.js";
import {
  EMPTY_SEED,
  STATS_BLOB_CAP,
  STATS_FILE,
  localOrPublishedSeed,
  mergeStats,
  statsDocument,
  type HttpsSite,
} from "../../src/ratings/seed.js";
import { MAX_RESPONSE_BYTES } from "../../src/validate/adapters/http.js";
import { rootJson, serve, type Loopback } from "../state/loopback.js";

const RATED = "ghcr.io/acme/code-review";
const DOWNLOADED = "ghcr.io/acme/starter-pack";

const PUBLISHED = {
  schema_version: 1,
  generated_at: "2026-10-21T09:30:00Z",
  providers: { rating: "github", downloads: "artifactory" },
  entries: {
    [RATED]: {
      rating: { up: 12, target: "DIC_kwDOAbc123", url: "https://github.com/acme/index/discussions/42" },
      downloads: { total: 4210 },
    },
    [DOWNLOADED]: { downloads: { total: 91 } },
  },
};
const SEED = { providers: PUBLISHED.providers, entries: PUBLISHED.entries };
const BYTES = Buffer.from(JSON.stringify(PUBLISHED, null, 2) + "\n");

/** A loopback origin standing in for the https `site` a verb vets with `requireHttpsSite`. */
const at = (origin: string): HttpsSite => origin as HttpsSite;

const refOf = (bytes: Uint8Array): { sha256: string; size: number } => ({
  sha256: createHash("sha256").update(bytes).digest("hex"),
  size: bytes.length,
});
const blobPath = (sha256: string): string => `/c/f/sha256/${sha256}.json.gz`;

type Reply = (res: http.ServerResponse) => void;
const send = (status: number, body = ""): Reply => (res) => {
  res.writeHead(status);
  res.end(body);
};

/** A host serving exactly `routes` by pathname; everything else is a 404. */
async function host(routes: Record<string, Reply>): Promise<Loopback> {
  return serve((req, res) => {
    const pathname = (req.url ?? "/").split("?")[0] ?? "/";
    (routes[pathname] ?? send(404))(res);
  });
}

/** The routes of an anchored build: a root naming the stats blob, and the blob. */
function anchored(
  bytes: Uint8Array = BYTES,
  over: { ref?: { sha256: string; size: number } | null; blob?: Reply } = {},
): Record<string, Reply> {
  const real = refOf(bytes);
  const ref = over.ref === undefined ? real : over.ref;
  return {
    "/c/root.json": (res) => res.end(rootJson({ stats: ref })),
    [blobPath(real.sha256)]: over.blob ?? ((res) => res.end(gzipDeterministic(bytes))),
  };
}

let site: Loopback | undefined;
let dir: string;
let file: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "seed-root-"));
  file = path.join(dir, STATS_FILE);
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  await site?.close();
  site = undefined;
  fs.rmSync(dir, { recursive: true, force: true });
});

async function failure(promise: Promise<unknown>): Promise<CliError> {
  const err: unknown = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err, "the seed read should have failed").toBeInstanceOf(CliError);
  return err as CliError;
}

describe("a legacy:false site carries the same entries as a legacy:true one (V-40)", () => {
  it("reads the stats blob the root names, with no /stats.json on the site", async () => {
    site = await host(anchored());

    await expect(localOrPublishedSeed(file, at(site.origin))).resolves.toEqual(SEED);

    expect(site.hits.map((hit) => hit.url.split("?")[0])).toEqual([
      "/c/root.json",
      blobPath(refOf(BYTES).sha256),
    ]);
  });

  it("gives the seed a legacy:true site serves, and never touches its /stats.json", async () => {
    site = await host({ ...anchored(), "/stats.json": send(200, BYTES.toString()) });

    await expect(localOrPublishedSeed(file, at(site.origin))).resolves.toEqual(SEED);

    expect(site.hits.map((hit) => hit.url)).not.toContain("/stats.json");
  });

  it("asks for the root with a cache-busting nonce and gzip", async () => {
    site = await host(anchored());

    await localOrPublishedSeed(file, at(site.origin));

    expect(site.hits[0]?.url).toMatch(/^\/c\/root\.json\?[0-9a-f]{8,}$/);
    expect(site.hits[0]?.headers["accept-encoding"]).toBe("gzip");
  });

  it("tolerates a trailing slash on the site", async () => {
    site = await host(anchored());

    await expect(localOrPublishedSeed(file, at(`${site.origin}//`))).resolves.toEqual(SEED);
  });

  it("uses a blob a host or CDN already decoded in transit", async () => {
    // The file is served with `Content-Encoding: gzip`, which fetch decodes: what
    // arrives has no gzip magic and is the document itself.
    site = await host(
      anchored(BYTES, {
        blob: (res) => {
          res.writeHead(200, { "Content-Encoding": "gzip" });
          res.end(gzipDeterministic(BYTES));
        },
      }),
    );

    await expect(localOrPublishedSeed(file, at(site.origin))).resolves.toEqual(SEED);
  });
});

describe("an earlier producer's .stats.json wins, without a request (IX-R49)", () => {
  it("reads the file and asks the site nothing", async () => {
    site = await host(anchored());
    fs.writeFileSync(file, JSON.stringify({ ...PUBLISHED, providers: { rating: "gitlab" } }));

    const seed = await localOrPublishedSeed(file, at(site.origin));

    expect(seed.providers).toEqual({ rating: "gitlab" });
    expect(site.hits).toHaveLength(0);
  });

  it("keeps a downloads run's update and a ratings run's update in one job", async () => {
    site = await host(anchored());

    // `downloads` runs first, from the published document.
    const first = await localOrPublishedSeed(file, at(site.origin));
    const downloads = statsDocument(
      mergeStats(first, "downloads", "artifactory", {
        [RATED]: { total: 9999 },
        [DOWNLOADED]: { total: 91 },
      }),
    );
    fs.writeFileSync(file, JSON.stringify(downloads));

    // `ratings` then seeds from the file `downloads` left, not from the site.
    const hitsBefore = site.hits.length;
    const second = await localOrPublishedSeed(file, at(site.origin));
    const both = statsDocument(
      mergeStats(second, "rating", "github", { [RATED]: { up: 13, target: "t", url: "u" } }),
    );

    expect(site.hits).toHaveLength(hitsBefore);
    expect(both.entries[RATED]).toEqual({
      rating: { up: 13, target: "t", url: "u" },
      downloads: { total: 9999 },
    });
    // The ref the ratings run never saw keeps the count the downloads run wrote.
    expect(both.entries[DOWNLOADED]).toEqual({ downloads: { total: 91 } });
  });

  it("fails on a file that does not parse, rather than reading the site", async () => {
    site = await host(anchored());
    fs.writeFileSync(file, "{");

    expect((await failure(localOrPublishedSeed(file, at(site.origin)))).code).toBe(EXIT.data);
    expect(site.hits).toHaveLength(0);
  });
});

describe("a seed the root cannot vouch for fails and publishes nothing (R-2)", () => {
  /** Every failure leaves `.stats.json` unwritten and never falls back to a legacy file that is not there. */
  async function fails(routes: Record<string, Reply>, code: number): Promise<CliError> {
    site = await host({ ...routes, "/stats.json": send(200, JSON.stringify({ ...PUBLISHED, entries: {} })) });
    const err = await failure(localOrPublishedSeed(file, at(site.origin)));

    expect(err.code).toBe(code);
    expect(fs.existsSync(file)).toBe(false);
    // The legacy file is a decoy that would read as an emptied rating set: it must not be reached.
    expect(site.hits.map((hit) => hit.url)).not.toContain("/stats.json");
    return err;
  }

  it("a named blob that 404s is unreadable (69)", async () => {
    const real = refOf(BYTES);
    const routes = anchored();
    delete routes[blobPath(real.sha256)];

    expect((await fails(routes, EXIT.unavailable)).message).toContain(real.sha256);
  });

  it("a named blob that answers 5xx is unreadable (69)", async () => {
    await fails(anchored(BYTES, { blob: send(503) }), EXIT.unavailable);
  });

  it("a digest mismatch is invalid (65)", async () => {
    const tampered = Buffer.from(BYTES.toString().replace("4210", "1234"));
    expect(tampered.length).toBe(BYTES.length);
    // Served under the digest the root names, but the bytes are not those bytes.
    const real = refOf(BYTES);
    await fails(anchored(BYTES, { blob: (res) => res.end(gzipDeterministic(tampered)), ref: real }), EXIT.data);
  });

  it("a size mismatch is invalid (65)", async () => {
    const real = refOf(BYTES);
    await fails(anchored(BYTES, { ref: { sha256: real.sha256, size: real.size + 1 } }), EXIT.data);
  });

  it("an inflate past the ref's size is invalid (65)", async () => {
    const real = refOf(BYTES);
    const bomb = gzipSync(Buffer.concat([BYTES, Buffer.alloc(4 * 1024 * 1024, 0x20)]));
    const err = await fails(anchored(BYTES, { ref: real, blob: (res) => res.end(bomb) }), EXIT.data);
    // Without the output cap the bomb inflates whole and fails the size check
    // instead, with the same exit code: only this message tells the two apart.
    expect(err.message).toContain("did not inflate to its declared");
  });

  it("a bad gzip stream is invalid (65)", async () => {
    const real = refOf(BYTES);
    const broken = gzipDeterministic(BYTES).subarray(0, 20);
    await fails(anchored(BYTES, { ref: real, blob: (res) => res.end(broken) }), EXIT.data);
  });

  it("a blob that verifies but is not a stats document is invalid (65)", async () => {
    const text = Buffer.from("<html>sign in</html>");
    await fails(anchored(text), EXIT.data);
  });

  it("a ref over the 128 MiB cap is invalid (65), and the blob is never requested", async () => {
    const real = refOf(BYTES);
    const routes = anchored(BYTES, { ref: { sha256: real.sha256, size: 128 * 1024 * 1024 + 1 } });
    await fails(routes, EXIT.data);
    expect(site?.hits.some((hit) => hit.url.startsWith("/c/f/"))).toBe(false);
  });

  const redirect = (to: string): Reply => (res) => {
    res.writeHead(302, { Location: to });
    res.end();
  };

  // Each decoy would make the run succeed if followed, so a followed redirect
  // fails the exit-code check as well as the hit check below it.
  it("a root that redirects is unreadable (69), and its Location is never requested", async () => {
    await fails(
      { ...anchored(), "/c/root.json": redirect("/decoy-root"), "/decoy-root": (res) => res.end(rootJson({ stats: refOf(BYTES) })) },
      EXIT.unavailable,
    );
    expect(site?.hits.map((hit) => hit.url)).not.toContain("/decoy-root");
  });

  it("a stats blob that redirects is unreadable (69), and its Location is never requested", async () => {
    await fails(
      {
        ...anchored(BYTES, { blob: redirect("/decoy-blob") }),
        "/decoy-blob": (res) => res.end(gzipDeterministic(BYTES)),
      },
      EXIT.unavailable,
    );
    expect(site?.hits.map((hit) => hit.url)).not.toContain("/decoy-blob");
  });

  it("a root that answers 5xx is unreadable (69)", async () => {
    await fails({ "/c/root.json": send(503) }, EXIT.unavailable);
  });

  it("a root that answers 403 is unreadable (69), not absent", async () => {
    await fails({ "/c/root.json": send(403) }, EXIT.unavailable);
  });

  it("a root that does not parse is invalid (65)", async () => {
    await fails({ "/c/root.json": send(200, "<!doctype html>") }, EXIT.data);
  });

  it("a root of the wrong schema is invalid (65)", async () => {
    await fails({ "/c/root.json": (res) => res.end(rootJson({ schema: 2 })) }, EXIT.data);
  });

  it("a root whose stats slot is not a ref is invalid (65)", async () => {
    await fails({ "/c/root.json": (res) => res.end(rootJson({ stats: { sha256: "ABC", size: 3 } })) }, EXIT.data);
  });

  it("an unreachable site is unreadable (69)", async () => {
    site = await host(anchored());
    const origin = site.origin;
    await site.close();

    expect((await failure(localOrPublishedSeed(file, at(origin)))).code).toBe(EXIT.unavailable);
  });

  it("an unreachable site says why, never HTTP 0", async () => {
    site = await host(anchored());
    const origin = site.origin;
    await site.close();

    const err = await failure(localOrPublishedSeed(file, at(origin)));

    expect(err.message).toContain("ECONNREFUSED");
    expect(err.message).not.toContain("HTTP 0");
  });

  it("a stats blob over the cap says so, never HTTP 0", async () => {
    vi.stubGlobal("fetch", (input: unknown) =>
      Promise.resolve(
        String(input).includes("/c/root.json")
          ? new Response("", { status: 404 })
          : new Response(new Uint8Array(STATS_BLOB_CAP + 1)),
      ),
    );

    const err = await failure(localOrPublishedSeed(file, at("https://index.example")));

    expect(err.message).toContain(`${STATS_BLOB_CAP} byte cap`);
    expect(err.message).not.toContain("HTTP 0");
  });
});

describe("the legacy file is read only when the root says there is no blob (IX-R49)", () => {
  it("falls back to /stats.json after a root 404", async () => {
    site = await host({ "/stats.json": send(200, BYTES.toString()) });

    await expect(localOrPublishedSeed(file, at(site.origin))).resolves.toEqual(SEED);
    expect(site.hits.map((hit) => hit.url.split("?")[0])).toEqual(["/c/root.json", "/stats.json"]);
  });

  it("falls back to /stats.json when a valid root names no stats", async () => {
    site = await host({
      "/c/root.json": (res) => res.end(rootJson({ stats: null })),
      "/stats.json": send(200, BYTES.toString()),
    });

    await expect(localOrPublishedSeed(file, at(site.origin))).resolves.toEqual(SEED);
  });

  it("is an empty seed when neither is published: the first run", async () => {
    site = await host({});

    await expect(localOrPublishedSeed(file, at(site.origin))).resolves.toEqual(EMPTY_SEED);
  });

  it.each([500, 502, 503, 429, 401, 301])("a legacy file that answers %i is unreadable (69)", async (status) => {
    site = await host({ "/stats.json": send(status) });

    expect((await failure(localOrPublishedSeed(file, at(site.origin)))).code).toBe(EXIT.unavailable);
  });

  it("a legacy file that does not parse is invalid (65)", async () => {
    site = await host({ "/stats.json": send(200, "<!doctype html><title>404 · GitHub Pages</title>") });

    const err = await failure(localOrPublishedSeed(file, at(site.origin)));

    expect(err.code).toBe(EXIT.data);
    expect(err.message).toContain("did not parse");
  });

  it("a legacy file that parses but is not a document is invalid (65)", async () => {
    site = await host({ "/stats.json": send(200, "[]") });

    expect((await failure(localOrPublishedSeed(file, at(site.origin)))).code).toBe(EXIT.data);
  });

  // A live site with no root yet may serve a `/stats.json` past the 1 MiB
  // default cap: reading it with that cap would exit 69 on every deploy.
  it("reads a legacy file past the default response cap, under the stats blob cap", async () => {
    const padded = BYTES.toString() + " ".repeat(MAX_RESPONSE_BYTES + 1);
    site = await host({ "/stats.json": send(200, padded) });

    await expect(localOrPublishedSeed(file, at(site.origin))).resolves.toEqual(SEED);
  });

  // `request()` reports an over-cap body as status 0, which must read as a
  // failure and never as an empty seed. One chunk past the cap stands in for a
  // 128 MiB transfer.
  it("a legacy file over the stats blob cap is unreadable (69), never an empty seed", async () => {
    vi.stubGlobal("fetch", (input: unknown) =>
      Promise.resolve(
        String(input).includes("/c/root.json")
          ? new Response("", { status: 404 })
          : new Response(new Uint8Array(STATS_BLOB_CAP + 1)),
      ),
    );

    expect((await failure(localOrPublishedSeed(file, at("https://index.example")))).code).toBe(EXIT.unavailable);
  });
});
