// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Grimoire Authors

/**
 * `gen-conformance.mjs --pinned` diffs the regenerated tree, and the fixture
 * files grim holds, against the manifest grim has checked in at the release tag
 * `GRIM_REF` names, resolved to the commit it peels to. These tests stand a
 * throwaway git repo in for that grim checkout.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { serializeDeterministic } from "../../src/emit/serialize.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..");
const SCRIPT = path.join(REPO, "scripts", "gen-conformance.mjs");
const TREE_PATH = "test/data/conformance";

type Manifest = { generator: Record<string, unknown>; files: Record<string, Record<string, unknown>> };

let tmp: string;
let dist: string;
let grim: string;
let tree: string;
let good: string;
let drifted: string;

// Identity and signing travel in the spawned env and `-c` flags, never in any
// config file. GIT_* from a calling hook would aim `git` at that hook's repo.
const gitEnv = (): NodeJS.ProcessEnv => ({
  ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("GIT_"))),
  GIT_CONFIG_GLOBAL: os.devNull,
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@example.invalid",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@example.invalid",
});

function git(...args: string[]): string {
  const run = spawnSync("git", ["-C", grim, "-c", "commit.gpgsign=false", ...args], { env: gitEnv(), encoding: "utf8", timeout: 30_000 });
  expect(run.status, run.stderr).toBe(0);
  return run.stdout.trim();
}

let tagCount = 0;

/** Commit the generated tree, as grim keeps it, with `edit` applied to the copy, tag the commit (annotated, as grim's releases are) and return the tag. */
function commitTree(message: string, edit: (dir: string) => void = () => {}): string {
  const dir = path.join(grim, TREE_PATH);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.cpSync(tree, dir, { recursive: true });
  edit(dir);
  git("add", "-A", TREE_PATH);
  git("commit", "-q", "--allow-empty", "-m", message);
  const tag = `v1.0.${tagCount++}`;
  git("tag", "-a", "-m", message, tag);
  return tag;
}

/** `checkout` null leaves GRIM_CHECKOUT unset. */
function pinned(pin: string, checkout: string | null = grim) {
  const file = path.join(tmp, `pin-${fs.readdirSync(tmp).length}`);
  fs.writeFileSync(file, pin);
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.GRIM_CHECKOUT;
  if (checkout !== null) env.GRIM_CHECKOUT = checkout;
  return spawnSync(process.execPath, [SCRIPT, "--dist", dist, "--pinned", file], { env, encoding: "utf8", timeout: 120_000 });
}

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "conformance-pin-"));
  dist = path.join(tmp, "dist");
  // The script imports the compiled emitters; see gen.test.ts for why the copy sits beside a node_modules link.
  fs.symlinkSync(path.join(REPO, "node_modules"), path.join(tmp, "node_modules"), "dir");
  const tsc = spawnSync(
    process.execPath,
    [path.join(REPO, "node_modules", "typescript", "bin", "tsc"), "-p", "tsconfig.json", "--outDir", dist],
    { cwd: REPO, encoding: "utf8", timeout: 120_000 },
  );
  expect(tsc.status, tsc.stdout).toBe(0);

  tree = path.join(tmp, "tree");
  const gen = spawnSync(process.execPath, [SCRIPT, "--dist", dist, "--out", tree], { encoding: "utf8", timeout: 120_000 });
  expect(gen.status, gen.stderr).toBe(0);
  const fresh = fs.readFileSync(path.join(tree, "MANIFEST.json"), "utf8");
  // grim keeps a README beside the tree; its own check, and this one, leave it out.
  fs.writeFileSync(path.join(tree, "README.md"), "notes\n");

  grim = path.join(tmp, "grim");
  fs.mkdirSync(grim);
  git("init", "-q");
  good = commitTree("the tree as generated");

  const planted = JSON.parse(fresh) as Manifest;
  planted.files["c/root.json"] = { ...planted.files["c/root.json"], sha256: "0".repeat(64) };
  drifted = commitTree("one sha256 perturbed", (dir) => fs.writeFileSync(path.join(dir, "MANIFEST.json"), serializeDeterministic(planted)));
}, 240_000);

afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("GRIM_REF", () => {
  it("contract:I6 IX-R42 is one v<major>.<minor>.<patch> release tag and a newline", () => {
    expect(fs.readFileSync(path.join(HERE, "GRIM_REF"), "utf8")).toMatch(/^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)\n$/);
  });
});

// Each test spawns the generator; a loaded runner needs more than the 5 s default.
describe("--pinned", { timeout: 60_000 }, () => {
  it("contract:I6 IX-R42 exits 0 when the manifest at the pin matches the regenerated tree", () => {
    const run = pinned(`${good}\n`);
    expect(run.status, run.stderr).toBe(0);
  });

  it("contract:I6 IX-R42 exits 1 and names the file whose sha256 drifted at the pin", () => {
    const run = pinned(`${drifted}\n`);
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("c/root.json");
  });

  it("contract:I6 IX-R42 exits 1 and names a fixture file missing at the pin, whatever the manifest says", () => {
    const tag = commitTree("all.json removed, manifest unchanged", (dir) => fs.rmSync(path.join(dir, "all.json")));
    const run = pinned(`${tag}\n`);
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("all.json: the pinned tree does not have it");
  });

  it("contract:I6 IX-R42 exits 1 and names a fixture file modified at the pin, whatever the manifest says", () => {
    const tag = commitTree("stats.json edited, manifest unchanged", (dir) => fs.appendFileSync(path.join(dir, "stats.json"), " "));
    const run = pinned(`${tag}\n`);
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("stats.json: differs");
  });

  it("contract:I6 IX-R42 exits 1 for a gzip fixture that no longer inflates, and for a file the manifest does not list", () => {
    let gz = "";
    const damaged = commitTree("a gzip blob replaced", (dir) => {
      gz = fs.readdirSync(path.join(dir, "c/f/sha256")).find((f) => f.endsWith(".gz"))!;
      fs.writeFileSync(path.join(dir, "c/f/sha256", gz), "not gzip");
    });
    const run = pinned(`${damaged}\n`);
    expect(run.status).toBe(1);
    expect(run.stderr).toContain(`c/f/sha256/${gz}: differs`);

    const extra = pinned(`${commitTree("a stray file", (dir) => fs.writeFileSync(path.join(dir, "stray.json"), "{}"))}\n`);
    expect(extra.status).toBe(1);
    expect(extra.stderr).toContain("stray.json: the manifest does not list it");
  });

  it("contract:I6 IX-R42 exits 64 and names GRIM_CHECKOUT when it is unset or empty", () => {
    for (const checkout of [null, ""]) {
      const run = pinned(`${good}\n`, checkout);
      expect(run.status, run.stderr).toBe(64);
      expect(run.stderr).toContain("GRIM_CHECKOUT");
    }
  });

  it.each(["", "v1.0\n", "1.0.0\n", "V1.0.0\n", "v1.0.0-rc.1\n", "v01.0.0\n", `${"a".repeat(40)}\n`, "main\n", "v1.0.0 v1.0.1\n"])("contract:I6 IX-R42 exits 65 for the malformed pin %j", (pin) => {
    const run = pinned(pin);
    expect(run.status, run.stderr).toBe(65);
  });

  it("contract:I6 IX-R42 exits 69 and names the tag when the checkout does not hold it", () => {
    const absent = "v9.9.9";
    const run = pinned(`${absent}\n`);
    expect(run.status).toBe(69);
    expect(run.stderr).toContain(absent);
  });

  it("contract:I6 IX-R42 exits 69 when only a branch, not a tag, carries the pinned name", () => {
    git("branch", "v8.8.8", good);
    const run = pinned("v8.8.8\n");
    expect(run.status).toBe(69);
    expect(run.stderr).toContain("v8.8.8");
  });

  it("contract:I6 IX-R42 exits 69 when the checkout is not a repository", () => {
    const run = pinned(`${good}\n`, path.join(tmp, "dist"));
    expect(run.status).toBe(69);
    expect(run.stderr).toContain(good);
  });
});
