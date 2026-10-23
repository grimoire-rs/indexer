// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Grimoire Authors

// An unset `site` and `repoUrl` are read off the forge's CI variables, else
// the repository root's `origin` remote; a written value always wins.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { EXIT } from "../../src/cli/exit.js";
import { run } from "../../src/cli/main.js";
import { loadConfig } from "../../src/config.js";
import { deriveHosts } from "../../src/derive.js";

const GITHUB = { GITHUB_ACTIONS: "true", GITHUB_SERVER_URL: "https://github.com", GITHUB_REPOSITORY: "acme/idx" };
const GITLAB = { GITLAB_CI: "true", CI_PROJECT_URL: "https://gitlab.com/acme/team/idx", CI_PAGES_URL: "https://acme.gitlab.io/team/idx" };

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "index-derive-"));
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  fs.rmSync(dir, { recursive: true, force: true });
});

function gitInit(at: string, remote: string): void {
  execFileSync("git", ["init", "-q", at]);
  execFileSync("git", ["-C", at, "remote", "add", "origin", remote]);
}

describe("deriveHosts", () => {
  it("reads GitHub Actions", () => {
    expect(deriveHosts(dir, GITHUB)).toEqual({
      repoUrl: { value: "https://github.com/acme/idx", source: "GITHUB_REPOSITORY" },
      site: { value: "https://acme.github.io/idx", source: "GITHUB_REPOSITORY" },
    });
  });

  it("gives GitHub Enterprise a repoUrl but no site", () => {
    const derived = deriveHosts(dir, { ...GITHUB, GITHUB_SERVER_URL: "https://ghe.acme.test" });

    expect(derived.repoUrl?.value).toBe("https://ghe.acme.test/acme/idx");
    expect(derived.site).toBeUndefined();
  });

  it("reads GitLab CI, preferring CI_PAGES_URL", () => {
    const derived = deriveHosts(dir, { ...GITLAB, CI_PAGES_URL: "https://idx-1a2b.gitlab.io" });

    expect(derived.repoUrl?.value).toBe(GITLAB.CI_PROJECT_URL);
    expect(derived.site).toEqual({ value: "https://idx-1a2b.gitlab.io", source: "CI_PAGES_URL" });
  });

  it("falls back to the repo root's origin remote", () => {
    gitInit(dir, "git@github.com:acme/idx.git");

    expect(deriveHosts(dir, {})).toEqual({
      repoUrl: { value: "https://github.com/acme/idx", source: "git remote origin" },
      site: { value: "https://acme.github.io/idx", source: "git remote origin" },
    });
  });

  it("ignores the remote of a checkout the root merely sits inside", () => {
    gitInit(dir, "https://github.com/acme/idx");
    const nested = path.join(dir, "fixture");
    fs.mkdirSync(nested);

    expect(deriveHosts(nested, {})).toEqual({});
  });
});

describe("loadConfig", () => {
  it("fills an unset site and repoUrl from the environment, and says so", async () => {
    for (const [key, value] of Object.entries(GITLAB)) vi.stubEnv(key, value);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const config = await loadConfig(dir);

    expect(config.site).toBe(GITLAB.CI_PAGES_URL);
    expect(config.repoUrl).toBe(GITLAB.CI_PROJECT_URL);
    expect(warn.mock.calls.flat().join("\n")).toContain("from CI_PAGES_URL");
  });

  it("keeps written values, and repoUrl: null", async () => {
    for (const [key, value] of Object.entries(GITHUB)) vi.stubEnv(key, value);
    fs.writeFileSync(path.join(dir, "index.config.json"), JSON.stringify({ site: "https://index.acme.test", repoUrl: null }));

    const config = await loadConfig(dir);

    expect(config.site).toBe("https://index.acme.test");
    expect(config.repoUrl).toBeNull();
  });

  it("drops a derived site the site rule refuses", async () => {
    for (const [key, value] of Object.entries(GITLAB)) vi.stubEnv(key, value);
    vi.stubEnv("CI_PAGES_URL", "https://acme.gitlab.io/idx?x=1");
    vi.spyOn(console, "warn").mockImplementation(() => {});

    expect((await loadConfig(dir)).site).toBeUndefined();
  });
});

describe("grim-indexer site", () => {
  it("prints the derived site", async () => {
    for (const [key, value] of Object.entries(GITHUB)) vi.stubEnv(key, value);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    expect(await run(["node", "grim-indexer", "site", dir])).toBe(EXIT.ok);
    expect(log.mock.calls).toEqual([["https://acme.github.io/idx"]]);
  });

  it("exits 65 when nothing names one", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});

    expect(await run(["node", "grim-indexer", "site", dir])).toBe(EXIT.data);
  });
});
