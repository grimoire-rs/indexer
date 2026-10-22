// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Grimoire Authors

// `grim-indexer state-key` against a real socket (IX-R27, V-17, V-24). CI writes
// stdout into `GITHUB_OUTPUT`, so every refusal here is checked twice: a
// non-zero exit and nothing on stdout.
import { createHash } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { EXIT } from "../../src/cli/exit.js";
import { run } from "../../src/cli/main.js";
import { INDEX_CAP } from "../../src/state/restore.js";
import { ROOT_CAP } from "../../src/state/anchor.js";
import { EPOCH_RENEW_SECONDS, STATE_KEY_RE } from "../../src/state/statekey.js";
import { STATE_DIR, writeHandoff, type Handoff } from "../../src/state/handoff.js";
import { serve, rootJson, type Loopback } from "../state/loopback.js";

const sha256 = (s: string | Buffer): string => createHash("sha256").update(s).digest("hex");
const EMPTY_BLOBS = sha256("");
const nowSeconds = (): number => Math.floor(Date.now() / 1000);

let dir: string;
let site: Loopback | undefined;
let out: string[];
let err: string[];

/** An enrich plane index as `bytes`, with the ref a root would name it by. */
function indexOf(doc: Record<string, unknown>): { bytes: Buffer; ref: { sha256: string; size: number } } {
  const bytes = Buffer.from(JSON.stringify({ blobs: EMPTY_BLOBS, buckets: {}, marketplace: null, plane: "enrich", schema: 1, state_epoch: 1, ...doc }));
  return { bytes, ref: { sha256: sha256(bytes), size: bytes.length } };
}

/** A site serving a root that names `index`, and `index` at its content address. */
async function publish(index: ReturnType<typeof indexOf> | null, over: { plane?: (res: http.ServerResponse) => void; root?: (res: http.ServerResponse) => void } = {}): Promise<Loopback> {
  const root = rootJson({ planes: { catalog: null, enrich: index?.ref ?? null } });
  site = await serve((req, res) => {
    if (req.url?.startsWith("/c/root.json")) return over.root ? over.root(res) : void res.end(root);
    if (index && req.url?.startsWith(`/c/p/sha256/${index.ref.sha256}.json`)) return over.plane ? over.plane(res) : void res.end(index.bytes);
    res.statusCode = 404;
    res.end();
  });
  return site;
}

function configure(value: string | undefined): void {
  fs.writeFileSync(path.join(dir, "index.config.json"), JSON.stringify(value === undefined ? {} : { site: value }));
}

/** Exit code and what reached stdout. */
async function stateKey(...args: string[]): Promise<{ code: number; stdout: string }> {
  const code = await run(["node", "grim-indexer", "state-key", dir, ...args]);
  return { code, stdout: out.join("") };
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "index-state-key-"));
  out = [];
  err = [];
  vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => void out.push(a.join(" ") + "\n"));
  vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => (out.push(String(chunk)), true));
  vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => void err.push(a.join(" ")));
  vi.spyOn(console, "warn").mockImplementation((...a: unknown[]) => void err.push(a.join(" ")));
});

afterEach(async () => {
  vi.restoreAllMocks();
  await site?.close();
  site = undefined;
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("state-key: a published plane", () => {
  it("prints <epoch>-<blobs> as one line", async () => {
    const epoch = nowSeconds() - 3600;
    const blobs = sha256("some\nblobs");
    configure((await publish(indexOf({ state_epoch: epoch, blobs }))).origin);

    const got = await stateKey();

    expect(got).toEqual({ code: EXIT.ok, stdout: `${epoch}-${blobs}\n` });
    expect(site!.hits.map((h) => h.url.split("?")[0])).toEqual(["/c/root.json", expect.stringMatching(/^\/c\/p\/sha256\/[0-9a-f]{64}\.json$/)]);
  });

  it("asks for gzip and busts the cache on both reads", async () => {
    configure((await publish(indexOf({}))).origin);
    await stateKey();
    for (const hit of site!.hits) {
      expect(hit.url).toMatch(/\?[0-9a-f]{8,}$/);
      expect(hit.headers["accept-encoding"]).toBe("gzip");
    }
  });

  it("renews an epoch dated more than a day ahead of the clock", async () => {
    const before = nowSeconds();
    configure((await publish(indexOf({ state_epoch: before + 2 * 86_400 }))).origin);
    const renewed = await stateKey();

    expect(renewed.code).toBe(EXIT.ok);
    const epoch = Number(renewed.stdout.split("-")[0]);
    expect(epoch).toBeGreaterThanOrEqual(before);
    expect(epoch).toBeLessThanOrEqual(nowSeconds());
  });

  it("keeps an epoch just under 7 days old and renews one past it", async () => {
    // 60 s of slack for a slow runner; the exact boundary is pinned in test/state/statekey.test.ts.
    const young = nowSeconds() - EPOCH_RENEW_SECONDS + 60;
    configure((await publish(indexOf({ state_epoch: young }))).origin);
    expect((await stateKey()).stdout.split("-")[0]).toBe(String(young));
    await site!.close();
    out.length = 0;

    const before = nowSeconds();
    configure((await publish(indexOf({ state_epoch: before - EPOCH_RENEW_SECONDS - 5 }))).origin);
    const renewed = await stateKey();

    expect(renewed.code).toBe(EXIT.ok);
    expect(STATE_KEY_RE.test(renewed.stdout.trimEnd())).toBe(true);
    const epoch = Number(renewed.stdout.split("-")[0]);
    expect(epoch).toBeGreaterThanOrEqual(before);
    expect(epoch).toBeLessThanOrEqual(nowSeconds());
  });
});

describe("state-key: nothing published yet", () => {
  it.each([
    ["a 404 root", async () => (await publish(null, { root: (res) => ((res.statusCode = 404), res.end("nope")) })).origin],
    ["planes.enrich: null", async () => (await publish(null)).origin],
  ])("%s prints a fresh key that matches no entry", async (_name, start) => {
    configure(await start());
    const before = nowSeconds();

    const { code, stdout } = await stateKey();

    expect(code).toBe(EXIT.ok);
    expect(stdout.split("\n")).toHaveLength(2);
    expect(stdout.trimEnd()).toMatch(STATE_KEY_RE);
    const [epoch, blobs] = stdout.trimEnd().split("-");
    expect(Number(epoch)).toBeGreaterThanOrEqual(before);
    expect(blobs).toBe(EMPTY_BLOBS);
  });
});

describe("state-key refuses, printing nothing (V-17, V-24)", () => {
  const bad = (stdout: string, code: number, why?: RegExp): void => {
    expect(stdout).toBe("");
    expect(code).not.toBe(EXIT.ok);
    if (why) expect(err.join("\n")).toMatch(why);
  };

  it.each([
    ["a newline and an assignment", "1\nX=y"],
    ["a fraction", 1.5],
    ["a negative", -1],
    ["2^53", 2 ** 53],
    ["null", null],
  ])("a plane whose state_epoch is %s exits 65", async (_name, state_epoch) => {
    configure((await publish(indexOf({ state_epoch }))).origin);
    const { code, stdout } = await stateKey();
    bad(stdout, code, /state_epoch/);
    expect(code).toBe(EXIT.data);
  });

  it("a plane whose blobs is not a digest exits 65", async () => {
    configure((await publish(indexOf({ blobs: "1\nX=y" }))).origin);
    const { code, stdout } = await stateKey();
    bad(stdout, code);
    expect(code).toBe(EXIT.data);
  });

  it("a plane index that is not an index exits 65", async () => {
    configure((await publish(indexOf({ plane: "other" }))).origin);
    const { code, stdout } = await stateKey();
    bad(stdout, code);
    expect(code).toBe(EXIT.data);
  });

  it("a plane index whose bytes do not match the root's digest exits 69", async () => {
    const index = indexOf({});
    configure((await publish(index, { plane: (res) => void res.end(index.bytes.toString().replace("schema", "schemb")) })).origin);
    const { code, stdout } = await stateKey();
    // Same length, other bytes: the digest is what refuses it.
    bad(stdout, code, /digest/);
    expect(code).toBe(EXIT.unavailable);
  });

  it("a root that names an index the site does not serve exits 69", async () => {
    configure((await publish(indexOf({}), { plane: (res) => ((res.statusCode = 404), res.end()) })).origin);
    const { code, stdout } = await stateKey();
    bad(stdout, code);
    expect(code).toBe(EXIT.unavailable);
  });

  describe.each([
    ["the root", "root"],
    ["the plane index", "plane"],
  ] as const)("%s read", (_name, target) => {
    const cap = target === "root" ? ROOT_CAP : INDEX_CAP;
    const body = (res: http.ServerResponse, text: string): void => void res.end(text);
    it.each<[string, (res: http.ServerResponse, valid: string) => void]>([
      ["an oversize body", (res, valid) => body(res, valid + " ".repeat(cap))],
      [
        "a gzip bomb",
        (res, valid) => {
          res.writeHead(200, { "Content-Encoding": "gzip" });
          res.end(gzipSync(valid + " ".repeat(8 * 1024 * 1024)));
        },
      ],
      ["an HTML 200", (res) => body(res, "<!doctype html><title>sign in</title>")],
      [
        "a 3xx",
        (res) => {
          res.writeHead(302, { Location: "/elsewhere" });
          res.end();
        },
      ],
      [
        "a 503",
        (res) => {
          res.statusCode = 503;
          res.end();
        },
      ],
    ])("%s exits non-zero with nothing on stdout", async (_case, respond) => {
      const index = indexOf({});
      const valid = target === "root" ? rootJson({ planes: { catalog: null, enrich: index.ref } }) : index.bytes.toString();
      const over = target === "root" ? { root: (res: http.ServerResponse) => respond(res, valid) } : { plane: (res: http.ServerResponse) => respond(res, valid) };
      configure((await publish(index, over)).origin);

      const { code, stdout } = await stateKey();

      bad(stdout, code);
    });
  });

  it("a connection that is refused exits 69", async () => {
    const { origin } = await publish(null);
    await site!.close();
    site = undefined;
    configure(origin);
    const { code, stdout } = await stateKey();
    bad(stdout, code, /ECONNREFUSED/);
    expect(err.join("\n")).not.toContain("HTTP 0");
    expect(code).toBe(EXIT.unavailable);
  });

  it.each([
    ["no site", undefined],
    ["a plain-http non-loopback site", "http://index.example.test"],
  ])("%s exits 65 without a request", async (_name, value) => {
    configure(value);
    const { code, stdout } = await stateKey();
    bad(stdout, code, /`site`/);
    expect(code).toBe(EXIT.data);
  });
});

describe("state-key: a malformed site", () => {
  it("is refused by the config loader (65) with nothing on stdout", async () => {
    configure("not a url");
    const { code, stdout } = await stateKey();
    expect(stdout).toBe("");
    expect(code).toBe(EXIT.data);
    expect(err.join("\n")).toMatch(/site/);
  });
});

describe("state-key --next", () => {
  const handoff = (next_key: string): Handoff => ({
    generation: 1,
    planes: { enrich: null },
    state_epoch: 1,
    next_key,
    counters: {
      retained_files: 0, retained_skipped: 0, probed: 0, deep: 0, calls: 0, probe_ms_p50: 0, deep_ms_p50: 0, budget_min: 0, throttled: 0, backoff_refs: 0, enrich: "complete", failed_buckets: 0,
    },
  });

  it("prints the hand-off's next_key offline, as one line", async () => {
    const key = `1792000000-${EMPTY_BLOBS}`;
    writeHandoff(dir, handoff(key));

    expect(await stateKey("--next")).toEqual({ code: EXIT.ok, stdout: `${key}\n` });
  });

  it("exits 69 with nothing on stdout when there is no hand-off", async () => {
    const { code, stdout } = await stateKey("--next");
    expect(stdout).toBe("");
    expect(code).toBe(EXIT.unavailable);
  });

  it.each([
    ["a damaged file", "{"],
    ["a next_key outside the grammar", JSON.stringify(handoff("1\nX=y"))],
  ])("exits non-zero with nothing on stdout for %s", async (_name, text) => {
    fs.mkdirSync(path.join(dir, STATE_DIR, "out"), { recursive: true });
    fs.writeFileSync(path.join(dir, STATE_DIR, "out", "handoff.json"), text);

    const { code, stdout } = await stateKey("--next");

    expect(stdout).toBe("");
    expect(code).not.toBe(EXIT.ok);
  });
});

describe("state-key reaches no further than the root and the index", () => {
  it("makes no request for --next", async () => {
    await publish(null);
    configure(site!.origin);
    writeHandoff(dir, {
      generation: 1, planes: { enrich: null }, state_epoch: 1, next_key: `1-${EMPTY_BLOBS}`,
      counters: { retained_files: 0, retained_skipped: 0, probed: 0, deep: 0, calls: 0, probe_ms_p50: 0, deep_ms_p50: 0, budget_min: 0, throttled: 0, backoff_refs: 0, enrich: "complete", failed_buckets: 0 },
    });
    await stateKey("--next");
    expect(site!.hits).toHaveLength(0);
  });
});
