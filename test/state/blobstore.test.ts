// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Grimoire Authors

import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { readRegular } from "../../src/marketplace/read.js";
import { BLOB_CAP, BlobStore, readHead } from "../../src/state/blobstore.js";
import { STATE_DIR, prepareState } from "../../src/state/handoff.js";
import { PROMPT_MS, canMakeFifo, plantFifo, reapWriters, timed } from "./fifo.js";

const sha = (b: Uint8Array): string => createHash("sha256").update(b).digest("hex");

let state: string;
let store: BlobStore;
const blobPath = (hex: string): string => path.join(state, "b", "sha256", hex.slice(0, 2), hex);

beforeEach(() => {
  state = fs.mkdtempSync(path.join(os.tmpdir(), "index-blobs-"));
  store = new BlobStore(state);
});

afterEach(() => {
  reapWriters();
  fs.rmSync(state, { recursive: true, force: true });
});

describe("BlobStore (IX-R41)", () => {
  it("contract:I2 put stores at <state>/b/sha256/<hh>/<hex> and get returns the bytes", () => {
    const bytes = Buffer.from("# readme");
    const ref = store.put(bytes);
    expect(ref).toEqual({ sha256: sha(bytes), size: bytes.length });
    expect(fs.readFileSync(blobPath(ref.sha256)).equals(bytes)).toBe(true);
    expect(store.get(ref.sha256)?.equals(bytes)).toBe(true);
  });

  it("contract:I2 get re-hashes: swapped bytes count as missing", () => {
    const ref = store.put(Buffer.from("# readme"));
    fs.writeFileSync(blobPath(ref.sha256), "# poisoned");
    expect(store.get(ref.sha256)).toBeNull();
  });

  it("contract:I2 get of an unknown digest is null", () => {
    expect(store.get("0".repeat(64))).toBeNull();
  });

  it("contract:I2 put truncates to 1 MiB before it hashes", () => {
    const big = Buffer.alloc(BLOB_CAP + 10, 0x61);
    const ref = store.put(big);
    expect(BLOB_CAP).toBe(1024 * 1024);
    expect(ref).toEqual({ sha256: sha(big.subarray(0, BLOB_CAP)), size: BLOB_CAP });
  });

  it("IX-R28 put on a store that cannot be written warns once and still returns the ref", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    fs.writeFileSync(path.join(state, "b"), "not a directory");

    const first = store.put(Buffer.from("one"));
    const second = store.put(Buffer.from("two"));

    expect(first).toEqual({ sha256: sha(Buffer.from("one")), size: 3 });
    expect(second.size).toBe(3);
    expect(warn).toHaveBeenCalledOnce();
    expect(store.get(first.sha256)).toBeNull();
    warn.mockRestore();
  });
});

describe("readHead (IX-R31)", () => {
  it("reads at most the cap from the head of a regular file", () => {
    const file = path.join(state, "big");
    fs.writeFileSync(file, Buffer.alloc(100, 0x61));
    expect(readHead(file, 10)?.toString()).toBe("a".repeat(10));
    expect(readHead(file, 1000)?.length).toBe(100);
  });

  it("is null for a link, a directory and a missing file", () => {
    const real = path.join(state, "real");
    fs.writeFileSync(real, "x");
    fs.symlinkSync(real, path.join(state, "link"));
    expect(readHead(path.join(state, "link"), 10)).toBeNull();
    expect(readHead(state, 10)).toBeNull();
    expect(readHead(path.join(state, "nope"), 10)).toBeNull();
  });
});

describe.skipIf(!canMakeFifo)("a FIFO where a cached file should be (restored state is hostile)", () => {
  const digest = "a".repeat(64);

  it("get answers null at once instead of waiting for a writer", () => {
    fs.mkdirSync(path.dirname(blobPath(digest)), { recursive: true });
    plantFifo(blobPath(digest));

    let got: Buffer | null = Buffer.alloc(0);
    const ms = timed(() => {
      got = store.get(digest);
    });

    expect(got).toBeNull();
    expect(ms).toBeLessThan(PROMPT_MS);
  });

  it("readHead and readRegular do not wait either", () => {
    // One late writer ends one blocked open, so each reader gets a pipe of its own.
    const head = path.join(state, "pipe-head");
    const regular = path.join(state, "pipe-regular");
    plantFifo(head);
    plantFifo(regular);

    const ms = timed(() => {
      expect(readHead(head, 10)).toBeNull();
      expect(readRegular(regular, 10)).toEqual({ why: "not a regular file" });
    });

    expect(ms).toBeLessThan(PROMPT_MS);
  });
});

describe("a restored state directory that is not what enrich wrote (prepareState)", () => {
  let root: string;
  let outside: string;
  const stateDir = (): string => path.join(root, STATE_DIR);

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "index-prepare-"));
    outside = fs.mkdtempSync(path.join(os.tmpdir(), "index-outside-"));
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  });

  it("put writes nothing outside the state when b/sha256/<hh> was a link", () => {
    const bytes = Buffer.from("# readme");
    const hex = sha(bytes);
    fs.mkdirSync(path.join(stateDir(), "b", "sha256"), { recursive: true });
    fs.symlinkSync(outside, path.join(stateDir(), "b", "sha256", hex.slice(0, 2)));

    prepareState(root);
    const ref = new BlobStore(stateDir()).put(bytes);

    expect(fs.readdirSync(outside)).toEqual([]);
    expect(new BlobStore(stateDir()).get(ref.sha256)?.equals(bytes)).toBe(true);
  });

  it("a linked b or b/sha256 is replaced too", () => {
    fs.mkdirSync(stateDir(), { recursive: true });
    fs.symlinkSync(outside, path.join(stateDir(), "b"));

    prepareState(root);
    new BlobStore(stateDir()).put(Buffer.from("x"));

    expect(fs.readdirSync(outside)).toEqual([]);
    expect(fs.lstatSync(path.join(stateDir(), "b")).isDirectory()).toBe(true);
  });

  it("writes .gitignore afresh instead of through a link", () => {
    const target = path.join(outside, "victim");
    fs.writeFileSync(target, "keep me");
    fs.mkdirSync(stateDir(), { recursive: true });
    fs.symlinkSync(target, path.join(stateDir(), ".gitignore"));

    prepareState(root);

    expect(fs.readFileSync(target, "utf8")).toBe("keep me");
    expect(fs.lstatSync(path.join(stateDir(), ".gitignore")).isFile()).toBe(true);
    expect(fs.readFileSync(path.join(stateDir(), ".gitignore"), "utf8")).toBe("*");
  });

  it("replaces a state directory that is a link, or a file", () => {
    fs.symlinkSync(outside, stateDir());
    prepareState(root);
    expect(fs.lstatSync(stateDir()).isDirectory()).toBe(true);
    expect(fs.readdirSync(outside)).toEqual([]);

    fs.rmSync(stateDir(), { recursive: true });
    fs.writeFileSync(stateDir(), "not a directory");
    prepareState(root);
    expect(fs.readFileSync(path.join(stateDir(), ".gitignore"), "utf8")).toBe("*");
  });

  it("removes what is not a directory at b/sha256/<hh> and what is not a file inside it, and keeps the rest", () => {
    const keep = Buffer.from("keep");
    const kept = new BlobStore(stateDir()).put(keep);
    const hh = path.join(stateDir(), "b", "sha256", "ab");
    fs.mkdirSync(path.join(stateDir(), "b", "sha256", "cd", "subdir"), { recursive: true });
    fs.writeFileSync(hh, "a file where a directory belongs");
    fs.symlinkSync(outside, path.join(stateDir(), "b", "sha256", "ef"));
    fs.symlinkSync(path.join(outside, "x"), path.join(stateDir(), "b", "sha256", kept.sha256.slice(0, 2), "f".repeat(64)));

    prepareState(root);

    expect(fs.existsSync(hh)).toBe(false);
    expect(fs.existsSync(path.join(stateDir(), "b", "sha256", "cd", "subdir"))).toBe(false);
    expect(fs.existsSync(path.join(stateDir(), "b", "sha256", "ef"))).toBe(false);
    expect(fs.existsSync(path.join(stateDir(), "b", "sha256", kept.sha256.slice(0, 2), "f".repeat(64)))).toBe(false);
    expect(new BlobStore(stateDir()).get(kept.sha256)?.equals(keep)).toBe(true);
  });

  it("keeps only sha256 under b/ and two-hex directories under it, and removes everything else", () => {
    const keep = Buffer.from("keep");
    const kept = new BlobStore(stateDir()).put(keep);
    const b = path.join(stateDir(), "b");
    fs.writeFileSync(path.join(b, "stray-file"), "x");
    fs.mkdirSync(path.join(b, "stray-dir", "ab"), { recursive: true });
    fs.mkdirSync(path.join(b, "sha256", "zz"), { recursive: true });
    fs.mkdirSync(path.join(b, "sha256", "AB"), { recursive: true });
    fs.mkdirSync(path.join(b, "sha256", "abc"), { recursive: true });
    fs.writeFileSync(path.join(b, "sha256", "zz", "f".repeat(64)), "x");
    fs.writeFileSync(path.join(b, "sha256", "stray-file"), "x");

    prepareState(root);

    expect(fs.readdirSync(b)).toEqual(["sha256"]);
    expect(fs.readdirSync(path.join(b, "sha256"))).toEqual([kept.sha256.slice(0, 2)]);
    expect(new BlobStore(stateDir()).get(kept.sha256)?.equals(keep)).toBe(true);
  });

  it("delete and clear tolerate a file where a directory belongs", () => {
    const hex = "ab".repeat(32);
    fs.mkdirSync(path.join(stateDir(), "b", "sha256"), { recursive: true });
    fs.writeFileSync(path.join(stateDir(), "b", "sha256", "ab"), "not a directory");
    const store = new BlobStore(stateDir());

    expect(() => store.delete(hex)).not.toThrow();
    expect(() => store.clear()).not.toThrow();
    expect(fs.existsSync(path.join(stateDir(), "b"))).toBe(false);
  });

  it("put removes its temporary file when the rename fails", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const bytes = Buffer.from("# readme");
    const hex = sha(bytes);
    const target = path.join(stateDir(), "b", "sha256", hex.slice(0, 2), hex);
    fs.mkdirSync(target, { recursive: true }); // a directory where the blob goes: the rename cannot land

    new BlobStore(stateDir()).put(bytes);

    expect(fs.readdirSync(path.dirname(target))).toEqual([hex]);
    vi.restoreAllMocks();
  });
});
