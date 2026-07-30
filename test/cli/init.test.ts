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
let logs: string[];

/**
 * The non-interactive path. `--no-install` is not just speed: `npm install`
 * reaches the network and writes a lock resolved from whatever is published
 * today, which would make every assertion below depend on the registry.
 */
function initArgs(target: string, ...extra: string[]): string[] {
  return ["node", "grim-indexer", "init", target, "--quick", "--no-git", "--no-install", ...extra];
}

function read(rel: string): string {
  return fs.readFileSync(path.join(dir, rel), "utf8");
}

function exists(rel: string): boolean {
  return fs.existsSync(path.join(dir, rel));
}

/** What init reported for each path: `created`, `unchanged`, `skipped`, `stale`. */
function reported(): Map<string, string> {
  return new Map(
    logs.map((line) => {
      const [outcome = "", file = ""] = line.trim().split(/\s+/);
      return [file, outcome];
    }),
  );
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "index-init-"));
  logs = [];
  // Keep console noise out of the reporter; the assertions read the disk —
  // except the per-file outcome lines, which are the only place `skipped` and
  // `stale` are reported at all.
  // @clack/prompts writes its boxes straight to the stream, past console.
  vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    logs.push(args.map(String).join(" "));
  });
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
      ".gitattributes",
      "package.json",
      "README.md",
      ".github/workflows/pages.yml",
      ".github/workflows/validate.yml",
      ".github/workflows/verify-ci.yml",
    ]) {
      expect(exists(file), file).toBe(true);
    }

    // `npm run ci:check` compares the generated CI through a renderer that
    // emits LF. Git for Windows installs with `core.autocrlf=true`, so without
    // this an untouched clone has CRLF on disk, every generated file reads as
    // drift, and re-rendering cannot clear it.
    expect(read(".gitattributes")).toMatch(/^\*\s+text=auto\s+eol=lf$/m);

    // `public/` is the index's own asset layer — the logo and favicon the
    // config names live there and the build copies them into `dist/`.
    // Ignoring it deploys a site referencing files the deploy never had,
    // which is silent: the build succeeds and the image 404s.
    const ignored = fs.readFileSync(path.join(dir, ".gitignore"), "utf8");
    expect(ignored).toContain("dist/");
    expect(ignored).not.toMatch(/^public\/$/m);
    // The lock is what CI installs from. Ignoring it would leave `npm ci`
    // with nothing to install and the renderer version resolved per runner —
    // which is the whole thing the lock exists to stop.
    expect(ignored).toMatch(/^node_modules\/$/m);
    expect(ignored).not.toMatch(/^package-lock\.json$/m);

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
    // Not a Pages URL and no git remote in a fresh temp dir, so nothing to
    // derive — and the key stays out rather than inheriting a default that
    // would link this index's header at somebody else's repository.
    expect("repoUrl" in config).toBe(false);
  });

  // The header's "github" link. `repoUrl` has no default for good reason, so
  // scaffolding has to work it out — from the git remote if there is one,
  // otherwise from the Pages URL the index is served from. A fresh temp dir
  // has no remote, so the Pages fallback is the only thing that can answer,
  // and dropping it left the header unlinked and `publish.toml` unable to
  // announce.
  it("derives repoUrl from a Pages base URL when there is no remote to read", async () => {
    for (const [sub, baseUrl, repoUrl] of [
      ["gh", "https://acme.github.io/idx", "https://github.com/acme/idx"],
      ["gl", "https://acme.gitlab.io/idx", "https://gitlab.com/acme/idx"],
    ]) {
      const target = path.join(dir, sub as string);
      expect(await run(initArgs(target, "--name", "idx", "--base-url", baseUrl as string))).toBe(0);

      expect(fs.existsSync(path.join(target, ".git")), "nothing to derive from").toBe(false);
      const config = JSON.parse(fs.readFileSync(path.join(target, "index.config.json"), "utf8"));
      expect(config.repoUrl, baseUrl).toBe(repoUrl);
      expect(config.site, baseUrl).toBe(baseUrl);
    }
  });

  // The obvious thing to paste into `--repo-url` is the forge's clone box,
  // which ends in `.git`. Used verbatim that made `site`
  // `https://acme.github.io/idx.git` — hence `/idx.git` as Astro's `base` — on
  // a Pages deployment that serves `/idx`, so every link on the built site
  // pointed one path segment wrong.
  it("normalizes a --repo-url the way git normalizes a remote", async () => {
    await run(initArgs(dir, "--name", "idx", "--repo-url", "https://github.com/acme/idx.git"));

    const config = JSON.parse(read("index.config.json"));
    expect(config.repoUrl).toBe("https://github.com/acme/idx");
    expect(config.site).toBe("https://acme.github.io/idx");
    // The address this index hands its visitors to add it with — same URL,
    // and just as wrong with a `.git` on the end.
    expect(config.registry.index).toBe("https://acme.github.io/idx");
  });

  // `logo` and `favicon` are deliberately different keys (see `SiteConfig`): a
  // favicon is drawn to read at 16px, a logo goes in the header and becomes
  // the default `og:image`. The prompt asks for a brand logo, so writing the
  // answer to `favicon` both lost the header logo and shipped a 16px slot
  // holding a wide brand mark.
  it("writes the brand logo to `logo`, never `favicon`", async () => {
    await run(initArgs(dir, "--logo", "/logo.svg"));

    const config = JSON.parse(read("index.config.json"));
    expect(config.logo).toBe("/logo.svg");
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

// What `init` owes the CI renderer: a `ci` block that reproduces exactly the
// files it just wrote. The scaffold's own drift guard runs on the first push,
// so a scaffold that is not already drift-free fails CI before the repository
// has done anything. Everything else about the generated CI is asserted in
// `ci.test.ts`, against the renderer rather than through the wizard.
describe("scaffolded CI", () => {
  it("records the forge the workflows were rendered for", async () => {
    await run(initArgs(dir, "--forge", "gitlab"));

    const { ci } = JSON.parse(read("index.config.json"));
    expect(ci.forge).toBe("gitlab");
    // Which renderer runs is package-lock.json's job, not the config's. A
    // version here would be a second copy of the same fact, free to disagree.
    expect("indexerVersion" in ci).toBe(false);
  });

  // What init renders is decided by the `ci` block that will be ON DISK when
  // it returns, not by its flags: `write` keeps an existing
  // `index.config.json` unless `--force`. Rendering from the flags while the
  // config kept its own values produced a tree whose committed CI did not
  // match its committed config — and `ci --check`, which reads only the
  // config, then failed on a tree init had just reported as successful.
  it("renders the CI its config asks for, not the CI its flags asked for", async () => {
    expect(await run(initArgs(dir))).toBe(0);
    const config = JSON.parse(read("index.config.json"));
    config.ci.forge = "gitlab";
    fs.writeFileSync(path.join(dir, "index.config.json"), JSON.stringify(config, null, 2) + "\n");

    logs = [];
    expect(await run(initArgs(dir, "--forge", "github"))).toBe(0);

    const outcome = reported();
    expect(exists(".gitlab-ci.yml"), "the config's forge is what got rendered").toBe(true);
    expect(JSON.parse(read("index.config.json")).ci.forge, "and the config is left alone").toBe(
      "gitlab",
    );
    expect(outcome.get("index.config.json")).toBe("skipped");
    // Reported, never deleted — removing a file from somebody's repository is
    // their call. Silence here left an orphaned pipeline behind and the drift
    // guard failing on the next push with no hint of where it came from.
    for (const workflow of [
      ".github/workflows/pages.yml",
      ".github/workflows/validate.yml",
      ".github/workflows/verify-ci.yml",
    ]) {
      expect(outcome.get(workflow), workflow).toBe("stale");
      expect(exists(workflow), workflow).toBe(true);
      fs.rmSync(path.join(dir, workflow));
    }

    // The payoff: with the orphans gone the tree init just wrote is drift-free.
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await run(["node", "grim-indexer", "ci", dir, "--check"])).toBe(0);
  });

  it("emits only the forge that was asked for", async () => {
    await run(initArgs(dir, "--forge", "gitlab"));

    expect(exists(".gitlab-ci.yml")).toBe(true);
    expect(exists(".github/workflows/pages.yml")).toBe(false);
    expect(exists(".github/workflows/verify-ci.yml")).toBe(false);
  });

  // A scaffolded index is an npm project, and every command a maintainer or a
  // CI job runs goes through its scripts. `dev` is the one a person reaches
  // for first, and it did not exist when the scaffold told people to use npx.
  it("is an npm project with the scripts CI and a human both run", async () => {
    await run(initArgs(dir, "--name", "acme"));

    const manifest = JSON.parse(read("package.json"));
    expect(manifest.private, "an index is never published to npm").toBe(true);
    expect(manifest.devDependencies["@grimoire-rs/indexer"]).toMatch(/^\^\d+\.\d+\.\d+$/);
    for (const script of ["dev", "build", "validate", "enrich", "ci", "ci:check"]) {
      expect(Object.keys(manifest.scripts), script).toContain(script);
    }
    // CI runs the gate as `npm run validate -- <flags>`, and the CLI arms its
    // "a 0 here authorizes a merge" guard only when the subcommand is
    // `argv[2]`. Anything in front of it here — a flag, a wrapper — disarms
    // that guard for every index scaffolded from this template.
    expect(manifest.scripts.validate).toBe("grim-indexer validate");
  });

  // Everything init writes lands in somebody else's repository, gets read in
  // CI logs, terminals, forge diff views and editors that are not all UTF-8,
  // and gets pasted around. A stray em dash in a generated YAML comment is a
  // rendering problem the index owner cannot fix without tripping the drift
  // guard, so the scaffold stays ASCII - this repo's own prose does not have
  // to, which is why the check is on the output rather than on the templates.
  it("writes nothing but ASCII", async () => {
    await run(initArgs(dir, "--forge", "gitlab", "--with-skills"));

    const walk = (at: string): string[] =>
      fs.readdirSync(at, { withFileTypes: true }).flatMap((entry) => {
        const full = path.join(at, entry.name);
        return entry.isDirectory() ? walk(full) : [full];
      });

    for (const file of walk(dir)) {
      const offending = [...fs.readFileSync(file, "utf8")].filter((ch) => ch.charCodeAt(0) > 127);
      expect(
        [...new Set(offending)].join(""),
        `${path.relative(dir, file)} carries non-ASCII`,
      ).toBe("");
    }
  });

  // The workflows used to be thin callers of reusable workflows in
  // grimoire-rs/indexer, which meant an index repository could not read its
  // own pipeline, and a fix to it arrived (or did not) out of band. Nothing a
  // scaffolded repo runs may be fetched from this one at run time any more,
  // and no version floats: CI installs the committed lock.
  it("points at nothing outside its own lockfile", async () => {
    for (const [forge, files] of [
      ["github", [".github/workflows/pages.yml", ".github/workflows/validate.yml", ".github/workflows/verify-ci.yml"]],
      ["gitlab", [".gitlab-ci.yml"]],
    ] as Array<[string, string[]]>) {
      const target = path.join(dir, forge);
      expect(await run(initArgs(target, "--forge", forge))).toBe(0);

      for (const file of files) {
        const text = fs.readFileSync(path.join(target, file), "utf8");
        expect(text, file).not.toMatch(/uses:\s*grimoire-rs\/indexer/);
        expect(text, file).not.toMatch(/raw\.githubusercontent\.com\/grimoire-rs/);
        expect(text, `${file} must not fetch a floating release`).not.toContain("npx");
        expect(text, `${file} installs the lock`).toContain("npm ci");
        expect(yaml.load(text), `${file} parses`).toBeTruthy();
      }
    }
  });
});
