// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Grimoire Authors

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import yaml from "js-yaml";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { run } from "../../src/cli/main.js";

let dir: string;

/** `--quick --no-git` is the non-interactive path CI and these tests use. */
function initArgs(target: string, ...extra: string[]): string[] {
  return ["node", "grim-indexer", "init", target, "--quick", "--no-git", ...extra];
}

function read(rel: string): string {
  return fs.readFileSync(path.join(dir, rel), "utf8");
}

function exists(rel: string): boolean {
  return fs.existsSync(path.join(dir, rel));
}

/** Walk a parsed YAML document by key path. Array indices are keys too. */
function dig(root: unknown, ...keys: string[]): unknown {
  return keys.reduce<unknown>(
    (node, key) => (node as Record<string, unknown> | undefined)?.[key],
    root,
  );
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "index-init-"));
  // Keep console noise out of the reporter; the assertions read the disk.
  // @clack/prompts writes its boxes straight to the stream, past console.
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("init --quick", () => {
  it("scaffolds the expected tree", async () => {
    expect(await run(initArgs(dir))).toBe(0);

    for (const file of [
      "index/.gitkeep",
      "index.config.json",
      "index-policy.json",
      ".gitignore",
      "README.md",
      ".github/workflows/pages.yml",
      ".github/workflows/validate.yml",
    ]) {
      expect(exists(file), file).toBe(true);
    }

    // Default forge is github, so no GitLab CI and no skills layout.
    expect(exists(".gitlab-ci.yml")).toBe(false);
    expect(exists("publish.toml")).toBe(false);
    expect(exists(".git")).toBe(false);
  });

  it("writes a config in the shape loadConfig validates", async () => {
    await run(initArgs(dir, "--name", "acme", "--base-url", "https://index.acme.test"));

    const config = JSON.parse(read("index.config.json"));
    expect(config.site).toBe("https://index.acme.test");
    expect(config.registry).toEqual({ alias: "acme", index: "https://index.acme.test" });
    // An unanswered logo prompt omits the key rather than writing "".
    expect("favicon" in config).toBe(false);
  });

  it("writes the registry-host allowlist the gate reads", async () => {
    await run(initArgs(dir, "--registry-host", "registry.acme.test"));

    expect(JSON.parse(read("index-policy.json"))).toEqual({
      version: 1,
      registryHosts: ["registry.acme.test"],
      reservedNamespaces: ["grim", "grimoire", "index"],
      trustedBots: [],
    });
  });

  it("derives the index name from the target directory", async () => {
    const named = path.join(dir, "My Cool Index");
    await run(initArgs(named));

    const config = JSON.parse(fs.readFileSync(path.join(named, "index.config.json"), "utf8"));
    expect(config.registry.alias).toBe("my-cool-index");
    expect(config.brand).toBe("My Cool Index");
  });
});

describe("init idempotency", () => {
  it("re-running changes nothing", async () => {
    await run(initArgs(dir));
    const before = read("README.md");

    expect(await run(initArgs(dir))).toBe(0);
    expect(read("README.md")).toBe(before);
  });

  it("leaves an edited file alone", async () => {
    await run(initArgs(dir));
    const edited = read("README.md") + "\n<!-- my own words -->\n";
    fs.writeFileSync(path.join(dir, "README.md"), edited);
    vi.spyOn(console, "error").mockImplementation(() => {});

    expect(await run(initArgs(dir))).toBe(0);
    expect(read("README.md")).toBe(edited);
  });

  it("overwrites an edited file only with --force", async () => {
    await run(initArgs(dir));
    const scaffolded = read("README.md");
    fs.writeFileSync(path.join(dir, "README.md"), "clobber me");

    expect(await run(initArgs(dir, "--force"))).toBe(0);
    expect(read("README.md")).toBe(scaffolded);
  });
});

// v0.1.3 emitted a `publish.toml` with no `[announce]` table at all, and
// grim's default announce target is the public first-party index
// (`https://github.com/grimoire-rs/index`, `DEFAULT_INDEX_REPO`). So the
// combined layout — a repo that holds both its skills and the index listing
// them — proposed its packages into a stranger's index instead of the one
// sitting in the same repo, silently and with a real PR.
describe("init --with-skills", () => {
  /** Scaffold the combined layout into a fresh subdir and return its manifest. */
  async function publishToml(sub: string, ...extra: string[]): Promise<string> {
    const target = path.join(dir, sub);
    expect(await run(initArgs(target, "--with-skills", ...extra))).toBe(0);
    return fs.readFileSync(path.join(target, "publish.toml"), "utf8");
  }

  /**
   * The manifest minus its comments — what grim actually reads. The header
   * names the public index to explain what dropping `[announce]` would do,
   * so "never targets it" is an assertion about values, not about prose.
   */
  function settings(manifest: string): string {
    return manifest.replace(/^\s*#.*$/gm, "");
  }

  it("adds the combined skills layout", async () => {
    expect(await run(initArgs(dir, "--with-skills", "--registry-host", "ghcr.io"))).toBe(0);

    expect(exists("skills/.gitkeep")).toBe(true);
    expect(read("publish.toml")).toContain('registry = "ghcr.io"');
    // Everything the standalone layout produces is still there.
    expect(exists("index/.gitkeep")).toBe(true);
    expect(exists("index.config.json")).toBe(true);
  });

  it("is not the default", async () => {
    await run(initArgs(dir));
    expect(exists("skills")).toBe(false);
    expect(exists("publish.toml")).toBe(false);
  });

  it("announces into the scaffolded repo, never the public index", async () => {
    const manifest = await publishToml("flagged", "--repo-url", "https://github.com/acme/idx");

    expect(manifest).toContain('repository = "https://github.com/acme/idx"');
    expect(manifest).toContain('namespace = "acme"');
    expect(settings(manifest)).not.toContain("grimoire-rs/index");
  });

  it("derives the repo from a Pages base URL", async () => {
    for (const [sub, baseUrl, repository, namespace] of [
      ["gh", "https://acme.github.io/idx", "https://github.com/acme/idx", "acme"],
      ["gl", "https://acme.gitlab.io/idx", "https://gitlab.com/acme/idx", "acme"],
      // A Pages root is served from the repo named after the host itself.
      ["gh-root", "https://acme.github.io", "https://github.com/acme/acme.github.io", "acme"],
      ["gl-root", "https://acme.gitlab.io", "https://gitlab.com/acme/acme.gitlab.io", "acme"],
    ]) {
      const manifest = await publishToml(sub as string, "--base-url", baseUrl as string);

      expect(manifest, baseUrl).toContain(`repository = "${repository}"`);
      expect(manifest, baseUrl).toContain(`namespace = "${namespace}"`);
    }
  });

  it("derives the repo from the target dir's git remote", async () => {
    const target = path.join(dir, "cloned");
    fs.mkdirSync(target);
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: target });
    // scp-like, the default `git clone git@…` writes — not a URL.
    execFileSync("git", ["remote", "add", "origin", "git@gitlab.example.com:team/idx.git"], {
      cwd: target,
    });

    expect(await run(initArgs(target, "--with-skills"))).toBe(0);

    const manifest = fs.readFileSync(path.join(target, "publish.toml"), "utf8");
    expect(manifest).toContain('repository = "https://gitlab.example.com/team/idx"');
    expect(manifest).toContain('namespace = "team"');
  });

  it("writes a placeholder rather than guessing when nothing derives a URL", async () => {
    // No --repo-url, no git remote, and the default base URL is localhost.
    const manifest = await publishToml("underivable");

    // `REPLACE-ME` is not a locator: `grim publish --announce` fails deriving
    // the index host from it, before any network call — the whole point.
    expect(manifest).toContain('repository = "REPLACE-ME"');
    expect(manifest).toContain('namespace = "REPLACE-ME"');
    expect(settings(manifest)).not.toContain("grimoire-rs/index");
  });
});

describe("generated CI", () => {
  it("parses as YAML and calls the reusable workflows by pinned ref", async () => {
    await run(initArgs(dir, "--forge", "both"));

    const pages = yaml.load(read(".github/workflows/pages.yml"));
    const validate = yaml.load(read(".github/workflows/validate.yml"));
    const gitlab = yaml.load(read(".gitlab-ci.yml"));

    expect(dig(pages, "jobs", "pages", "uses")).toMatch(
      /^grimoire-rs\/indexer\/\.github\/workflows\/index-pages\.yml@v\d+\.\d+\.\d+$/,
    );
    expect(dig(validate, "jobs", "validate", "uses")).toMatch(
      /^grimoire-rs\/indexer\/\.github\/workflows\/index-validate\.yml@v\d+\.\d+\.\d+$/,
    );
    expect(dig(gitlab, "include", "0", "remote")).toMatch(
      /^https:\/\/raw\.githubusercontent\.com\/grimoire-rs\/indexer\/v\d+\.\d+\.\d+\//,
    );

    // Thin callers: no inline job logic to drift out of date.
    expect(dig(pages, "jobs", "pages", "steps")).toBeUndefined();
    expect(dig(validate, "jobs", "validate", "steps")).toBeUndefined();
  });

  it("keeps permissions default-deny at the workflow top", async () => {
    await run(initArgs(dir, "--forge", "github"));

    for (const file of [".github/workflows/pages.yml", ".github/workflows/validate.yml"]) {
      const workflow = yaml.load(read(file));
      expect(dig(workflow, "permissions"), file).toEqual({});
      // Elevation happens per job, never at the top.
      const jobs = dig(workflow, "jobs") as Record<string, Record<string, unknown>>;
      for (const [name, job] of Object.entries(jobs)) {
        expect(job.permissions, `${file}: ${name}`).toBeTruthy();
      }
    }
  });

  it("emits only the forge that was asked for", async () => {
    await run(initArgs(dir, "--forge", "gitlab"));

    expect(exists(".gitlab-ci.yml")).toBe(true);
    expect(exists(".github/workflows/pages.yml")).toBe(false);
  });
});

const repo = path.join(import.meta.dirname, "..", "..");

/**
 * Every place a scaffolded repo points back at this one, as
 * (repo-relative path, git ref) — from `uses:` in the GitHub callers and
 * from the `include: remote:` URL in the GitLab one.
 */
function backRefs(text: string): Array<{ file: string; ref: string }> {
  return [
    ...[...text.matchAll(/^\s*-?\s*uses: grimoire-rs\/indexer\/(\S+?)@(\S+)/gm)],
    ...[...text.matchAll(/raw\.githubusercontent\.com\/grimoire-rs\/indexer\/([^/]+)\/(\S+?)"/g)]
      // The URL orders them ref-then-path; normalise to path-then-ref.
      .map((m) => [m[0], m[2], m[1]] as RegExpMatchArray),
  ].map((m) => ({ file: m[1] as string, ref: m[2] as string }));
}

// v0.1.2 shipped scaffolds whose callers said
// `uses: grimoire-rs/indexer/.github/workflows/index-pages.yml@v0.1.2` while
// those workflows only existed under `templates/reusable/`. GitHub cannot
// resolve a reusable workflow outside `.github/workflows/`, so the very
// first push to a scaffolded index failed before any job started — with no
// job to show a log for. Nothing checked that the emitted ref pointed at a
// file that exists, so nothing caught it.
describe("scaffolded callers resolve back to this repo", () => {
  it("names a file that exists here, at this package's tag", async () => {
    expect(await run(initArgs(dir, "--forge", "both"))).toBe(0);
    const version = JSON.parse(fs.readFileSync(path.join(repo, "package.json"), "utf8")).version;

    const refs = [".github/workflows/pages.yml", ".github/workflows/validate.yml", ".gitlab-ci.yml"]
      .flatMap((caller) => backRefs(read(caller)));

    expect(refs.length).toBe(3);
    for (const { file, ref } of refs) {
      expect(fs.existsSync(path.join(repo, file)), `${file} is referenced but not in this repo`)
        .toBe(true);
      expect(ref, `${file} must be pinned to this package's tag`).toBe(`v${version}`);
    }
  });

  it("only reaches GitHub-resolvable paths for `uses:`", async () => {
    await run(initArgs(dir, "--forge", "github"));

    for (const caller of [".github/workflows/pages.yml", ".github/workflows/validate.yml"]) {
      for (const { file } of backRefs(read(caller))) {
        // GitHub does not resolve a reusable workflow in a subdirectory.
        expect(file, caller).toMatch(/^\.github\/workflows\/[^/]+\.ya?ml$/);
      }
    }
  });
});

describe("shipped reusable workflows", () => {
  it("parse as YAML and SHA-pin every action", () => {
    for (const file of [".github/workflows/index-pages.yml", ".github/workflows/index-validate.yml"]) {
      const text = fs.readFileSync(path.join(repo, file), "utf8");
      const workflow = yaml.load(text);

      expect(dig(workflow, "permissions"), file).toEqual({});
      expect(dig(workflow, "on", "workflow_call"), file).toBeTruthy();

      // Line-anchored: these files discuss `uses:` in their header comments.
      const uses = [...text.matchAll(/^\s*-?\s*uses: (\S+)/gm)].map((m) => m[1] as string);
      expect(uses.length, file).toBeGreaterThan(0);
      for (const ref of uses) {
        expect(ref, `${file}: ${ref}`).toMatch(/@[0-9a-f]{40}$/);
      }
    }
  });

  it("gitlab include file parses as a single YAML document", () => {
    const gitlab = yaml.load(
      fs.readFileSync(path.join(repo, "templates/reusable/gitlab-index-ci.yml"), "utf8"),
    );

    expect(dig(gitlab, "stages")).toEqual(["test", "deploy"]);
    expect(dig(gitlab, "pages", "artifacts", "paths")).toEqual(["$GRIM_INDEXER_OUT_DIR"]);
  });
});
