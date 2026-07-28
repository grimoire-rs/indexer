// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Grimoire Authors

// The exit-code contract, which is the whole API for anything scripting
// this CLI: 64 usage, 65 bad input data, 69 unavailable, and — for
// `validate` — 0 eligible for auto-merge / non-zero manual review.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { run } from "../../src/cli/main.js";

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "index-exit-"));
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  // Commander writes its own usage text; keep it out of the reporter.
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("usage errors exit 64", () => {
  it("unknown flag", async () => {
    expect(await run(["node", "grimoire-indexer", "init", dir, "--quick", "--nope"])).toBe(64);
  });

  it("unknown subcommand", async () => {
    expect(await run(["node", "grimoire-indexer", "frobnicate"])).toBe(64);
  });

  it("flag value outside its choices", async () => {
    expect(
      await run(["node", "grimoire-indexer", "init", dir, "--quick", "--forge", "bitbucket"]),
    ).toBe(64);
  });

  it("build --out-dir that would delete the index root", async () => {
    expect(await run(["node", "grimoire-indexer", "build", dir, "--out-dir", "."])).toBe(64);
  });

  it("validate with no forge to detect", async () => {
    vi.stubEnv("GITHUB_ACTIONS", "");
    vi.stubEnv("GITLAB_CI", "");
    expect(await run(["node", "grimoire-indexer", "validate", "--root", dir])).toBe(64);
  });

  it("validate with no author to determine", async () => {
    vi.stubEnv("GITHUB_ACTIONS", "");
    vi.stubEnv("GITLAB_CI", "");
    vi.stubEnv("GITHUB_EVENT_PATH", "");
    expect(
      await run(["node", "grimoire-indexer", "validate", "--root", dir, "--forge", "github"]),
    ).toBe(64);
  });
});

describe("bad input data exits 65", () => {
  it("init --base-url that is not a URL", async () => {
    expect(
      await run(["node", "grimoire-indexer", "init", dir, "--quick", "--base-url", "not-a-url"]),
    ).toBe(65);
    expect(fs.existsSync(path.join(dir, "index.config.json"))).toBe(false);
  });

  it("init --name that is not a valid identifier", async () => {
    expect(
      await run(["node", "grimoire-indexer", "init", dir, "--quick", "--name", "Not A Name"]),
    ).toBe(65);
  });

  it("validate with a malformed index-policy.json", async () => {
    fs.writeFileSync(path.join(dir, "index-policy.json"), "{ not json");

    expect(
      await run([
        "node",
        "grimoire-indexer",
        "validate",
        "--root",
        dir,
        "--forge",
        "github",
        "--author-login",
        "octocat",
        "--author-id",
        "1",
        "--pr-tree",
        dir,
      ]),
    ).toBe(65);
  });

  // A gate that ran without a PR tree would silently skip the owner-id
  // continuity check, so it refuses to run at all.
  it("validate without --pr-tree", async () => {
    expect(
      await run([
        "node",
        "grimoire-indexer",
        "validate",
        "--root",
        dir,
        "--forge",
        "github",
        "--author-login",
        "octocat",
        "--author-id",
        "1",
      ]),
    ).toBe(65);
  });

  it("validate with a policy whose registryHosts is the wrong type", async () => {
    fs.writeFileSync(path.join(dir, "index-policy.json"), JSON.stringify({ registryHosts: "ghcr.io" }));

    expect(
      await run([
        "node",
        "grimoire-indexer",
        "validate",
        "--root",
        dir,
        "--forge",
        "gitlab",
        "--author-login",
        "octocat",
        "--author-id",
        "1",
        "--pr-tree",
        dir,
      ]),
    ).toBe(65);
  });
});

describe("success exits 0", () => {
  it("--help", async () => {
    expect(await run(["node", "grimoire-indexer", "--help"])).toBe(0);
  });

  it("--version", async () => {
    expect(await run(["node", "grimoire-indexer", "--version"])).toBe(0);
  });
});
