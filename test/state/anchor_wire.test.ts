// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Grimoire Authors

// The anchor read against a real socket: a stubbed `fetch` never decodes a
// Content-Encoding, follows nothing and shows no headers, so the claims of V-24
// and IX-R29 that depend on those can only be made here.
import { gzipSync } from "node:zlib";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ROOT_CAP, readRoot } from "../../src/state/anchor.js";
import { serve, rootJson, type Loopback } from "./loopback.js";

let site: Loopback | undefined;
let warn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(async () => {
  vi.restoreAllMocks();
  await site?.close();
  site = undefined;
});

describe("readRoot on the wire (V-24, IX-R29)", () => {
  it("asks for gzip, adds a cache-busting query, and reads the root", async () => {
    site = await serve((_req, res) => res.end(rootJson()));

    const got = await readRoot(site.origin);

    expect(got?.generation).toBe(1_792_000_000);
    expect(site.hits).toHaveLength(1);
    expect(site.hits[0]?.url).toMatch(/^\/c\/root\.json\?[0-9a-f]{8,}$/);
    expect(site.hits[0]?.headers["accept-encoding"]).toBe("gzip");
    expect(warn).not.toHaveBeenCalled();
  });

  it("inflates a gzip-encoded root", async () => {
    site = await serve((_req, res) => {
      res.writeHead(200, { "Content-Encoding": "gzip" });
      res.end(gzipSync(rootJson()));
    });
    expect((await readRoot(site.origin))?.generation).toBe(1_792_000_000);
  });

  it("reads the current generation through the nonce when the plain URL is stale at the edge", async () => {
    site = await serve((req, res) => {
      const stale = req.url === "/c/root.json";
      res.end(rootJson({ generation: stale ? 100 : 200 }));
    });
    expect((await readRoot(site.origin))?.generation).toBe(200);
  });

  it("refuses a body over the root cap", async () => {
    site = await serve((_req, res) => res.end(rootJson() + " ".repeat(ROOT_CAP)));
    expect(await readRoot(site.origin)).toBeNull();
    expect(warn).toHaveBeenCalledOnce();
  });

  // `request` reports a refused socket and an over-cap body alike as status 0; the warning says which.
  it("names a refused connection instead of HTTP 0", async () => {
    site = await serve((_req, res) => res.end(rootJson()));
    const { origin } = site;
    await site.close();
    site = undefined;

    expect(await readRoot(origin)).toBeNull();

    const message = String(warn.mock.calls[0]?.[0]);
    expect(message).toContain("ECONNREFUSED");
    expect(message).not.toContain("HTTP 0");
  });

  it("names the cap a body passed instead of HTTP 0", async () => {
    site = await serve((_req, res) => res.end(rootJson() + " ".repeat(ROOT_CAP)));

    expect(await readRoot(site.origin)).toBeNull();

    const message = String(warn.mock.calls[0]?.[0]);
    expect(message).toContain(`${ROOT_CAP} byte cap`);
    expect(message).not.toContain("HTTP 0");
  });

  it("refuses a gzip bomb: the cap counts inflated bytes", async () => {
    // A root that parses if it is ever read whole, then 8 MiB of whitespace in 8 KiB of gzip.
    const bomb = gzipSync(rootJson() + " ".repeat(8 * 1024 * 1024));
    expect(bomb.length).toBeLessThan(ROOT_CAP);
    site = await serve((_req, res) => {
      res.writeHead(200, { "Content-Encoding": "gzip" });
      res.end(bomb);
    });

    expect(await readRoot(site.origin)).toBeNull();
    expect(warn).toHaveBeenCalledOnce();
  });

  it("refuses an HTML 200", async () => {
    site = await serve((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end("<!doctype html><title>sign in</title>");
    });
    expect(await readRoot(site.origin)).toBeNull();
    expect(warn).toHaveBeenCalledOnce();
  });

  it("does not follow a redirect", async () => {
    site = await serve((req, res) => {
      if (req.url?.startsWith("/c/root.json")) {
        res.writeHead(302, { Location: "/elsewhere/root.json" });
        res.end();
      } else {
        res.end(rootJson());
      }
    });

    expect(await readRoot(site.origin)).toBeNull();

    expect(site.hits.map((h) => h.url.split("?")[0])).toEqual(["/c/root.json"]);
    expect(warn).toHaveBeenCalledOnce();
  });

  it("warns once on a 5xx and says nothing on a 404", async () => {
    site = await serve((_req, res) => {
      res.statusCode = 503;
      res.end();
    });
    expect(await readRoot(site.origin)).toBeNull();
    expect(warn).toHaveBeenCalledOnce();

    warn.mockClear();
    await site.close();
    site = await serve((_req, res) => {
      res.statusCode = 404;
      res.end("not found");
    });
    expect(await readRoot(site.origin)).toBeNull();
    expect(warn).not.toHaveBeenCalled();
  });
});

describe("readRoot never throws (IX-R28)", () => {
  it("warns and yields no root when the connection is refused", async () => {
    site = await serve((_req, res) => res.end());
    const { origin } = site;
    await site.close();
    site = undefined;

    expect(await readRoot(origin)).toBeNull();
    expect(warn).toHaveBeenCalledOnce();
  });

  it("warns and yields no root when the name does not resolve", async () => {
    expect(await readRoot("https://index.invalid")).toBeNull();
    expect(warn).toHaveBeenCalledOnce();
  });

  it("warns and yields no root when the request times out", async () => {
    vi.stubGlobal("fetch", () => Promise.reject(new DOMException("The operation was aborted due to timeout", "TimeoutError")));
    try {
      expect(await readRoot("https://index.example.test")).toBeNull();
      expect(warn).toHaveBeenCalledOnce();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
