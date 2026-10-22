// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Grimoire Authors

// Browser fetch of the content-addressed `/c/` blobs. `fetch` is stubbed with
// `Response`s over real `ReadableStream`s, so the chunk loop, the stall timer
// and `DecompressionStream` all run for real — only the network is faked.
import { gzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  DigestLadderError,
  fetchJson,
  loadDigest,
} from "../../src/renderer/astro/lib/digestfetch.js";

const base = globalThis as Record<string, unknown>;
const DIGEST = "a".repeat(64);
const FRESH = "b".repeat(64);
const enc = new TextEncoder();

type Step = Uint8Array | number | "hang";

/** Chunks to emit; a number waits that many ms first, "hang" never ends. */
function body(steps: Step[], signal?: AbortSignal | null): ReadableStream<Uint8Array> {
  const queue = [...steps];
  return new ReadableStream<Uint8Array>({
    start(c) {
      // What a real fetch does to a body read when its request is aborted.
      signal?.addEventListener("abort", () => c.error(signal.reason), { once: true });
    },
    async pull(c) {
      for (;;) {
        const step = queue.shift();
        if (step === undefined) return c.close();
        if (step === "hang") return new Promise<void>(() => undefined);
        if (typeof step === "number") {
          await new Promise((r) => setTimeout(r, step));
          continue;
        }
        c.enqueue(step);
        return;
      }
    },
  });
}

type Reply = (init: RequestInit) => Response;
const gz = (v: unknown): Reply => () => new Response(gzipSync(JSON.stringify(v)));
const plain = (v: unknown): Reply => () => new Response(JSON.stringify(v));
const status = (code: number): Reply => () => new Response("nope", { status: code });
const html = (text: string): Reply => () => new Response(text);

const calls: Array<{ url: string; cache: RequestCache | undefined }> = [];

/** Answers fetches in order; one more than supplied is a test failure. */
function serve(...replies: Reply[]): void {
  calls.length = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit = {}) => {
      calls.push({ url, cache: init.cache });
      const reply = replies.shift();
      if (!reply) throw new Error(`unexpected fetch ${url}`);
      return reply(init);
    }),
  );
}

beforeEach(() => {
  base.__GRIMOIRE_BASE__ = "/";
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("fetchJson", () => {
  const opts = { cap: 1024 * 1024, cache: "default" } as const;

  it("inflates a gzip body split across chunks", async () => {
    const bytes = gzipSync(JSON.stringify({ a: [1, 2, 3] }));
    // One byte first: the gzip magic must be read off the whole body, not chunk 0.
    serve(() => new Response(body([bytes.subarray(0, 1), bytes.subarray(1, 9), bytes.subarray(9)])));
    await expect(fetchJson("/x.json.gz", opts)).resolves.toEqual({ a: [1, 2, 3] });
  });

  it("parses a body a host already decoded", async () => {
    serve(plain({ ok: true }));
    await expect(fetchJson("/x.json.gz", opts)).resolves.toEqual({ ok: true });
  });

  it("passes the cache mode through", async () => {
    serve(plain(1));
    await fetchJson("/x", { ...opts, cache: "force-cache" });
    expect(calls[0]?.cache).toBe("force-cache");
  });

  it("rejects when the inflated size passes the cap", async () => {
    // Small on the wire, large once inflated: the cap is on the inflated side.
    const bomb = gzipSync(JSON.stringify("x".repeat(100_000)));
    expect(bomb.length).toBeLessThan(1000);
    serve(() => new Response(bomb));
    await expect(fetchJson("/x", { ...opts, cap: 1000 })).rejects.toThrow(/cap/);
  });

  it("rejects a plain body past the cap", async () => {
    serve(() => new Response(JSON.stringify("x".repeat(2000))));
    await expect(fetchJson("/x", { ...opts, cap: 1000 })).rejects.toThrow(/cap/);
  });

  it("rejects a non-ok status, naming the URL and the status", async () => {
    serve(status(503));
    await expect(fetchJson("/c/q/x.json.gz", opts)).rejects.toThrow(/\/c\/q\/x\.json\.gz.*503/);
  });

  it("rejects a body that is not JSON", async () => {
    serve(html("<html>"));
    await expect(fetchJson("/x", opts)).rejects.toThrow();
  });

  it("rejects when the caller aborts", async () => {
    serve((init) => new Response(body(["hang"], init.signal)));
    const ctl = new AbortController();
    const p = fetchJson("/x", { ...opts, signal: ctl.signal });
    ctl.abort(new Error("caller gave up"));
    await expect(p).rejects.toThrow("caller gave up");
  });

  describe("stall", () => {
    const stallMs = 1000;
    const json = enc.encode(JSON.stringify({ n: [1, 2, 3, 4] }));
    const piece = (i: number) => json.subarray(i * 5, i === 3 ? undefined : (i + 1) * 5);

    beforeEach(() => vi.useFakeTimers());

    it("fails a body that stops arriving", async () => {
      serve((init) => new Response(body([piece(0), "hang"], init.signal)));
      const outcome = expect(fetchJson("/x", { ...opts, stallMs })).rejects.toThrow(/no data/);
      await vi.advanceTimersByTimeAsync(stallMs + 1);
      await outcome;
    });

    it("fails a request that never answers", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn(
          (_url: string, init: RequestInit) =>
            new Promise((_, reject) => {
              init.signal?.addEventListener("abort", () => reject(init.signal?.reason));
            }),
        ),
      );
      const outcome = expect(fetchJson("/x", { ...opts, stallMs })).rejects.toThrow(/no data/);
      await vi.advanceTimersByTimeAsync(stallMs + 1);
      await outcome;
    });

    it("lets a slow but steady body finish past stallMs in total", async () => {
      const gap = stallMs / 2;
      serve(
        (init) =>
          new Response(
            body([piece(0), gap, piece(1), gap, piece(2), gap, piece(3), gap], init.signal),
          ),
      );
      const outcome = expect(fetchJson("/x", { ...opts, stallMs })).resolves.toEqual({
        n: [1, 2, 3, 4],
      });
      // 4 gaps of stallMs/2 is twice stallMs; no single gap reaches it.
      await vi.advanceTimersByTimeAsync(gap * 4 + 1);
      await outcome;
    });
  });
});

describe("loadDigest", () => {
  const decode = (v: unknown): string[] => {
    if (!Array.isArray(v)) throw new Error("not an array");
    return v.map(String);
  };
  const opts = { cap: 1024 * 1024, decode, attr: "search" } as const;
  const own = `/c/q/sha256/${DIGEST}.json.gz`;
  const fresh = `/c/q/sha256/${FRESH}.json.gz`;

  it("takes the first rung from the HTTP cache", async () => {
    serve(gz(["a", "b"]));
    await expect(loadDigest("q", DIGEST, opts)).resolves.toEqual(["a", "b"]);
    expect(calls).toEqual([{ url: own, cache: "force-cache" }]);
  });

  it("takes the second rung with a reload when the cached copy 404s", async () => {
    serve(status(404), gz(["ok"]));
    await expect(loadDigest("q", DIGEST, opts)).resolves.toEqual(["ok"]);
    expect(calls).toEqual([
      { url: own, cache: "force-cache" },
      { url: own, cache: "reload" },
    ]);
  });

  it("takes the second rung when decode rejects the first body", async () => {
    serve(gz({ not: "an array" }), gz(["ok"]));
    await expect(loadDigest("q", DIGEST, opts)).resolves.toEqual(["ok"]);
    expect(calls.map((c) => c.cache)).toEqual(["force-cache", "reload"]);
  });

  it("takes the second rung after a stalled or capped first body", async () => {
    serve(() => new Response(gzipSync(JSON.stringify(["x".repeat(5000)]))), gz(["ok"]));
    await expect(loadDigest("q", DIGEST, { ...opts, cap: 1000 })).resolves.toEqual(["ok"]);
  });

  it("reads a fresh digest off the home page for the third rung", async () => {
    serve(
      status(404),
      status(404),
      html(`<div data-grim-search="${FRESH}" data-grim-stats="${"c".repeat(64)}">`),
      gz(["fresh"]),
    );
    await expect(loadDigest("q", DIGEST, opts)).resolves.toEqual(["fresh"]);
    expect(calls).toEqual([
      { url: own, cache: "force-cache" },
      { url: own, cache: "reload" },
      { url: "/", cache: "reload" },
      { url: fresh, cache: "force-cache" },
    ]);
  });

  it("reads the attribute the caller names", async () => {
    serve(
      status(404),
      status(404),
      html(`data-grim-search="${DIGEST}" data-grim-stats="${FRESH}"`),
      gz(["stats"]),
    );
    await loadDigest("f", DIGEST, { ...opts, attr: "stats" });
    expect(calls[3]).toEqual({ url: `/c/f/sha256/${FRESH}.json.gz`, cache: "force-cache" });
  });

  it("does not fetch the digest it already reloaded when the home page names it again", async () => {
    serve(status(404), status(404), html(`data-grim-search="${DIGEST}"`));
    const err: unknown = await loadDigest("q", DIGEST, opts).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DigestLadderError);
    // The reload's own failure, not a made-up one.
    expect(((err as Error).cause as Error).message).toMatch(/404/);
    expect(calls).toEqual([
      { url: own, cache: "force-cache" },
      { url: own, cache: "reload" },
      { url: "/", cache: "reload" },
    ]);
  });

  it("reads the home page up to 1 MiB and no further", async () => {
    const MIB = 1024 * 1024;
    const attribute = `data-grim-search="${FRESH}"`;
    serve(status(404), status(404), html("x".repeat(MIB - attribute.length) + attribute), gz(["fresh"]));
    await expect(loadDigest("q", DIGEST, opts)).resolves.toEqual(["fresh"]);

    serve(status(404), status(404), html("x".repeat(MIB) + attribute));
    const err: unknown = await loadDigest("q", DIGEST, opts).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DigestLadderError);
    expect(((err as Error).cause as Error).message).toMatch(/home page.*cap/);
    expect(calls).toHaveLength(3);
  });

  it("throws DigestLadderError, keeping the last cause, when every rung fails", async () => {
    serve(status(404), status(404), html("<html>no attribute</html>"));
    const err: unknown = await loadDigest("q", DIGEST, opts).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DigestLadderError);
    expect((err as Error).cause).toBeInstanceOf(Error);
    expect(calls).toHaveLength(3);
  });

  it("throws DigestLadderError when the fresh digest fails too", async () => {
    serve(status(404), status(404), html(`data-grim-search="${FRESH}"`), status(404));
    await expect(loadDigest("q", DIGEST, opts)).rejects.toBeInstanceOf(DigestLadderError);
    expect(calls).toHaveLength(4);
  });

  it("throws DigestLadderError when the home page itself fails", async () => {
    serve(status(404), status(404), status(500));
    await expect(loadDigest("q", DIGEST, opts)).rejects.toBeInstanceOf(DigestLadderError);
  });

  it("puts every request under the deployment base", async () => {
    base.__GRIMOIRE_BASE__ = "/sub/";
    serve(status(404), status(404), html(`data-grim-search="${FRESH}"`), gz(["ok"]));
    await loadDigest("q", DIGEST, opts);
    expect(calls.map((c) => c.url)).toEqual([
      `/sub${own}`,
      `/sub${own}`,
      "/sub/",
      `/sub${fresh}`,
    ]);
  });

  it("never asks for all.json, whichever rung fails", async () => {
    serve(status(404), status(404), html("nothing"));
    await loadDigest("q", DIGEST, opts).catch(() => undefined);
    serve(status(404), status(404), html(`data-grim-search="${FRESH}"`), status(404));
    await loadDigest("f", DIGEST, opts).catch(() => undefined);
    for (const { url } of calls) expect(url.endsWith("all.json")).toBe(false);
  });

  it.each(["", "abc", "A".repeat(64), "a".repeat(63), "a".repeat(65), `../${"a".repeat(61)}`])(
    "rejects the digest %j without fetching",
    async (digest) => {
      serve();
      await expect(loadDigest("q", digest, opts)).rejects.toBeInstanceOf(DigestLadderError);
      expect(calls).toHaveLength(0);
    },
  );
});
