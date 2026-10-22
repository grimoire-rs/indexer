// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Grimoire Authors

// `handOff` ingests the `enrich/` working tree into the store and the plane. The
// tree is mostly bytes a registry sent, so ingest is where the 1 MiB cap and the
// refusal to follow a link have to hold (IX-R31, IX-R41).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BLOB_CAP, BlobStore } from "../../src/state/blobstore.js";
import { handOff } from "../../src/state/collect.js";
import { collectEntries } from "../../src/state/entries.js";
import { STATE_DIR } from "../../src/state/handoff.js";
import { SHARD_CAP } from "../../src/state/plane.js";
import { loadPlane } from "../../src/state/restore.js";

const REF = "ghcr.io/acme/skills/foo";
const NOW = new Date(1_792_000_000_000);

let root: string;
let store: BlobStore;

const sidecar = (...rel: string[]): string => path.join(root, "enrich/github.com/acme/foo", ...rel);

function addPackage(name = "foo", ref = REF): void {
  const pkg = path.join(root, "index/github.com/acme", "foo");
  fs.mkdirSync(pkg, { recursive: true });
  fs.writeFileSync(
    path.join(pkg, "metadata.json"),
    JSON.stringify({ schema: 1, name, kind: "skill", ref, description: "d", owner: { id: 1, github: "o" } }),
  );
}

function addSidecar(data: unknown = { title: "Foo" }): void {
  fs.mkdirSync(sidecar(), { recursive: true });
  fs.writeFileSync(sidecar("data.json"), JSON.stringify(data));
}

/** What the plane `handOff` just wrote holds for `REF`. */
function planned(h: ReturnType<typeof handOff>) {
  return loadPlane(store, h.planes.enrich!)?.entries.get(REF);
}

const hand = (published: { generation: number } | null = null): ReturnType<typeof handOff> =>
  handOff(root, store, {
    now: NOW,
    published: published && { flat: null, generated_at: "x", generation: published.generation, planes: { catalog: null, enrich: null }, schema: 1, search: null, stats: null },
    restored: null,
  });

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "index-collect-"));
  store = new BlobStore(path.join(root, STATE_DIR));
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

describe("handOff ingest (IX-R31, IX-R41)", () => {
  it("IX-R31 caps a companion at 1 MiB before it is hashed", () => {
    addPackage();
    addSidecar();
    fs.writeFileSync(sidecar("readme.md"), Buffer.alloc(BLOB_CAP + 4096, 0x61));

    const ref = planned(hand())?.files["readme.md"];

    expect(ref?.size).toBe(BLOB_CAP);
    expect(store.get(ref!.sha256)?.length).toBe(BLOB_CAP);
  });

  // The plane restore clamps again, so only the entry as collected shows whether ingest did.
  it("IX-R47 collects an on-disk sidecar within the record text bounds, as ingest would store it", () => {
    addPackage();
    addSidecar({ title: "Foo", keywords: Array.from({ length: 100 }, (_, i) => `kw${i}`), summary: `s${"\u{e0041}"}`, name: "x".repeat(4096) });

    const data = collectEntries(root, (bytes) => store.put(bytes), undefined).get(REF)?.data;

    expect(data?.keywords).toHaveLength(32);
    expect(data?.summary).toBe("s");
    expect(data).not.toHaveProperty("name");
  });

  it("does not follow a companion that is a symbolic link", () => {
    addPackage();
    addSidecar();
    const secret = path.join(root, "secret.txt");
    fs.writeFileSync(secret, "not a readme");
    fs.symlinkSync(secret, sidecar("readme.md"));
    fs.writeFileSync(sidecar("changelog.md"), "## 1\n");

    const files = planned(hand())?.files;

    expect(Object.keys(files ?? {})).toEqual(["changelog.md"]);
  });

  it("skips a data.json that is a symbolic link", () => {
    addPackage();
    fs.mkdirSync(sidecar(), { recursive: true });
    const elsewhere = path.join(root, "elsewhere.json");
    fs.writeFileSync(elsewhere, '{"title":"planted"}');
    fs.symlinkSync(elsewhere, sidecar("data.json"));

    expect(planned(hand())).toBeUndefined();
  });

  it("skips a data.json too big for any shard instead of reading it whole", () => {
    addPackage();
    fs.mkdirSync(sidecar(), { recursive: true });
    fs.writeFileSync(sidecar("data.json"), JSON.stringify({ title: "x".repeat(SHARD_CAP) }));
    const parse = vi.spyOn(JSON, "parse");

    expect(planned(hand())).toBeUndefined();

    expect(parse.mock.calls.some(([text]) => typeof text === "string" && text.length > SHARD_CAP)).toBe(false);
  });

  it("never reads a sidecar outside enrich/ for a package name with a path in it", () => {
    addPackage("../../../../escaped");
    fs.mkdirSync(path.join(root, "escaped"));
    fs.writeFileSync(path.join(root, "escaped/data.json"), '{"title":"planted"}');

    expect(planned(hand())).toBeUndefined();
  });
});

describe("handOff generation (IX-R06)", () => {
  const s = Math.floor(NOW.getTime() / 1000);

  it("is one past a published generation that is not too far ahead, silently", () => {
    expect(hand({ generation: s + 3600 }).generation).toBe(s + 3601);
    expect(console.warn).not.toHaveBeenCalled();
  });

  it("ignores a published generation more than a day ahead, and says so", () => {
    expect(hand({ generation: s + 86_401 }).generation).toBe(s);
    expect(vi.mocked(console.warn).mock.calls.flat().join("\n")).toMatch(/generation/);
  });

  it("ignores the largest safe integer the same way", () => {
    expect(hand({ generation: Number.MAX_SAFE_INTEGER }).generation).toBe(s);
    expect(console.warn).toHaveBeenCalled();
  });
});

describe("handOff state_epoch (IX-R27)", () => {
  const seconds = Math.floor(NOW.getTime() / 1000);
  const plane = (stateEpoch: number | undefined) => ({ stateEpoch, entries: new Map(), marketplace: null, stamps: {}, shards: [], cold: [] });
  const handWith = (stateEpoch: number | undefined, renew = false) => handOff(root, store, { now: NOW, published: null, restored: plane(stateEpoch), renew });

  it("carries a restored epoch under 7 days old, into the key as well", () => {
    const h = handWith(seconds - 3600);
    expect(h.state_epoch).toBe(seconds - 3600);
    expect(h.next_key.startsWith(`${seconds - 3600}-`)).toBe(true);
  });

  it("renews an epoch past 7 days, and on renew", () => {
    expect(handWith(seconds - 8 * 86_400).state_epoch).toBe(seconds);
    expect(handWith(seconds - 3600, true).state_epoch).toBe(seconds);
  });

  it("renews an epoch a hostile plane dated far in the future", () => {
    expect(handWith(seconds + 30 * 86_400).state_epoch).toBe(seconds);
  });

  it("starts a new epoch and warns when the restored plane has none usable, instead of failing", () => {
    expect(handWith(undefined).state_epoch).toBe(seconds);
    expect(vi.mocked(console.warn).mock.calls.flat().join("\n")).toMatch(/state_epoch/);
  });
});
