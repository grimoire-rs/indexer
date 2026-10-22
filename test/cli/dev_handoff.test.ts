// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Grimoire Authors

// `dev` reads the hand-off exactly as `build` does and makes no request
// (IX-R35, V-29). The server is stubbed: this file never binds a port.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { dev } from "../../src/cli/dev.js";
import { BlobStore } from "../../src/state/blobstore.js";
import { handOff } from "../../src/state/collect.js";
import { STATE_DIR } from "../../src/state/handoff.js";
import { grimSpawns, spawned } from "./spawn_spy.js";

vi.mock("node:child_process", async (real) => (await import("./spawn_spy.js")).tapChildProcess(await real()));
vi.mock("../../src/renderer/index.js", () => ({
  devSite: vi.fn(async () => ({ url: "http://localhost:0", stop: async () => {} })),
}));

let dir: string;

function addPackage(name: string): void {
  const pkg = path.join(dir, "index", "acme", name);
  fs.mkdirSync(pkg, { recursive: true });
  fs.writeFileSync(
    path.join(pkg, "metadata.json"),
    JSON.stringify({ schema: 1, name, kind: "skill", ref: `ghcr.io/acme/skills/${name}`, description: "d", owner: { id: 1, github: "o" } }),
  );
  const out = path.join(dir, "enrich", "acme", name);
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, "data.json"), JSON.stringify({ updated: "2026-07-01T10:00:00+00:00" }));
}

/** Run `dev` until it has published the root, then stop it the way an operator would. */
async function runDev(): Promise<void> {
  const before = process.listeners("SIGINT");
  const done = dev(dir, {});
  const root = path.join(dir, "dist", "c", "root.json");
  for (let i = 0; i < 400 && !(fs.existsSync(root) && process.listeners("SIGINT").length > before.length); i++) {
    await new Promise((r) => setTimeout(r, 25));
  }
  process.emit("SIGINT");
  await done;
  for (const l of process.listeners("SIGINT")) if (!before.includes(l)) process.off("SIGINT", l);
  for (const l of process.listeners("SIGTERM")) process.off("SIGTERM", l);
}

const readRoot = (): { generation: number; planes: { enrich: unknown } } =>
  JSON.parse(fs.readFileSync(path.join(dir, "dist", "c", "root.json"), "utf8")) as ReturnType<typeof readRoot>;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "index-dev-handoff-"));
  spawned.length = 0;
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("dev hand-off (IX-R35, V-29)", () => {
  it.each([
    ["site set", true],
    ["site unset", false],
  ])("publishes no plane and makes no request with no hand-off, %s", async (_name, withSite) => {
    if (withSite) fs.writeFileSync(path.join(dir, "index.config.json"), JSON.stringify({ site: "https://index.example.test" }));
    const fetchSpy = vi.fn(() => Promise.reject(new Error("network denied")));
    vi.stubGlobal("fetch", fetchSpy);
    addPackage("hello");

    await runDev();

    expect(readRoot().planes.enrich).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(grimSpawns()).toEqual([]);
  }, 30_000);

  it("publishes the handed-off generation and plane", async () => {
    addPackage("hello");
    const h = handOff(dir, new BlobStore(path.join(dir, STATE_DIR)), {
      now: new Date(),
      published: { flat: null, generated_at: "x", generation: Math.floor(Date.now() / 1000) + 5000, planes: { catalog: null, enrich: null }, schema: 1, search: null, stats: null },
      restored: null,
    });
    const fetchSpy = vi.fn(() => Promise.reject(new Error("network denied")));
    vi.stubGlobal("fetch", fetchSpy);

    await runDev();

    expect(readRoot().generation).toBe(h.generation);
    expect(readRoot().planes.enrich).toEqual(h.planes.enrich);
    expect(fetchSpy).not.toHaveBeenCalled();
  }, 30_000);
});
