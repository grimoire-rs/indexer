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
let errors: string[];

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "index-exit-"));
  errors = [];
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    errors.push(args.map(String).join(" "));
  });
  // Commander writes its own usage text; keep it out of the reporter.
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("usage errors exit 64", () => {
  it("unknown flag", async () => {
    expect(await run(["node", "grim-indexer", "init", dir, "--quick", "--nope"])).toBe(64);
  });

  it("unknown subcommand", async () => {
    expect(await run(["node", "grim-indexer", "frobnicate"])).toBe(64);
  });

  it("flag value outside its choices", async () => {
    expect(
      await run(["node", "grim-indexer", "init", dir, "--quick", "--forge", "bitbucket"]),
    ).toBe(64);
  });

  it("build --out-dir that would delete the index root", async () => {
    expect(await run(["node", "grim-indexer", "build", dir, "--out-dir", "."])).toBe(64);
  });

  // A bad flag value is a usage error like any other. Passed through unchecked
  // this reached Astro as `NaN` and surfaced as a raw zod issue dump naming no
  // flag at all, exiting 1. No server is booted: the value is rejected before
  // the renderer is even imported.
  it("dev --port that is not a port number", async () => {
    for (const port of ["abc", "8080.5", "0", "65536", "99999", "-1"]) {
      expect(await run(["node", "grim-indexer", "dev", dir, "--port", port]), port).toBe(64);
    }
  });

  it("validate with no forge to detect", async () => {
    vi.stubEnv("GITHUB_ACTIONS", "");
    vi.stubEnv("GITLAB_CI", "");
    expect(await run(["node", "grim-indexer", "validate", "--root", dir])).toBe(64);
  });

  it("validate with no author to determine", async () => {
    vi.stubEnv("GITHUB_ACTIONS", "");
    vi.stubEnv("GITLAB_CI", "");
    vi.stubEnv("GITHUB_EVENT_PATH", "");
    expect(
      await run(["node", "grim-indexer", "validate", "--root", dir, "--forge", "github"]),
    ).toBe(64);
  });
});

describe("bad input data exits 65", () => {
  it("init --base-url that is not a URL", async () => {
    expect(
      await run(["node", "grim-indexer", "init", dir, "--quick", "--base-url", "not-a-url"]),
    ).toBe(65);
    expect(fs.existsSync(path.join(dir, "index.config.json"))).toBe(false);
  });

  it("init --name that is not a valid identifier", async () => {
    expect(
      await run(["node", "grim-indexer", "init", dir, "--quick", "--name", "Not A Name"]),
    ).toBe(65);
  });

  // `SiteConfig.logo` takes a site-root path or an http(s) URL. A bare
  // `logo.svg` resolves against whatever page is being served, so it has to
  // fail here rather than at build time — or on a subpath deployment, only in
  // production.
  it("init --logo that is neither a site-root path nor a URL", async () => {
    for (const logo of ["logo.svg", "./public/logo.svg", "ftp://example.com/logo.svg"]) {
      const target = path.join(dir, `logo-${logo.replace(/\W/g, "")}`);
      expect(
        await run([
          "node",
          "grim-indexer",
          "init",
          target,
          "--quick",
          "--no-git",
          "--no-install",
          "--logo",
          logo,
        ]),
        logo,
      ).toBe(65);
      expect(fs.existsSync(path.join(target, "index.config.json")), logo).toBe(false);
    }
  });

  it("validate with a malformed index-policy.json", async () => {
    fs.writeFileSync(path.join(dir, "index-policy.json"), "{ not json");

    expect(
      await run([
        "node",
        "grim-indexer",
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
        "grim-indexer",
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
        "grim-indexer",
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

// `validate` is the one subcommand whose exit code is an authorization rather
// than a status: branch protection reads its 0 as "eligible for auto-merge",
// so a 0 on any path that never judged the contribution IS a merge of
// attacker-authored content, unreviewed.
//
// That is not hypothetical. CI used to append the pull request's changed
// filenames to argv with `xargs`, and a pull request that added an empty file
// named `-h` made commander print help and short-circuit with exitCode 0,
// which `classify()` mapped straight to `EXIT.ok`. Every assertion below is
// about the difference between 64 and an authorization to merge.
describe("the gate never exits 0 without judging the contribution", () => {
  const FILE = "index/github.com/acme/tool/metadata.json";

  /** A gate invocation with everything the gate needs, plus whatever `extra` adds. */
  function gate(...extra: string[]): string[] {
    return [
      "node",
      "grim-indexer",
      "validate",
      "--forge",
      "github",
      "--root",
      dir,
      "--pr-tree",
      dir,
      "--author-login",
      "octocat",
      "--author-id",
      "1",
      ...extra,
    ];
  }

  beforeEach(() => {
    // Nothing in this block may reach the forge API: every case is refused by
    // the parser or the path gate, both of which run before the first call. A
    // throwing stub makes an accidental call loud instead of flaky.
    vi.stubGlobal("fetch", () => {
      throw new Error("the gate reached the network on a path that should refuse first");
    });
    vi.stubEnv("GITHUB_ACTIONS", "");
    vi.stubEnv("GITLAB_CI", "");
    vi.stubEnv("GITHUB_EVENT_PATH", "");
  });

  // The reproduced exploit, one spelling per case: each of these
  // short-circuits commander with exitCode 0 (verified — with the gate mapping
  // removed, all four return 0 from `run`), and it is the gate flag that turns
  // that into 64. A 0 here is an authorization to merge.
  for (const shortCircuit of ["-h", "--help", "--version", "-V"]) {
    it(`exits 64 when a changed path is spelled ${shortCircuit}`, async () => {
      expect(await run(gate(FILE, shortCircuit))).toBe(64);
    });
  }

  // …and the same short-circuit still exits 0 for a subcommand whose 0 means
  // nothing but success. That contrast is what makes the cases above
  // assertions about the gate rather than about commander.
  it("still prints help and exits 0 for a subcommand that authorizes nothing", async () => {
    expect(await run(["node", "grim-indexer", "ci", dir, "--help"])).toBe(0);
  });

  // The guard keys on `argv[2]`, so it is the scaffolded `validate` script
  // (`grim-indexer validate`, asserted in `init.test.ts`) that puts the
  // subcommand there and everything CI appends after it. A help request in
  // front of the subcommand is still a help request.
  it("keeps help in front of the subcommand a help request", async () => {
    expect(await run(["node", "grim-indexer", "--help", "validate"])).toBe(0);
  });

  // Defence in depth behind `--changed-from`: no path under `index/` can
  // legitimately begin with `-`, and one that does is either a shell-mangled
  // entry or an attempt to have the gate parse it as a flag. The worst
  // spelling was `--policy=pr-tree/...`, which points the committed allowlist
  // at a file inside the contribution — a contributor allowlisting their own
  // registry host in the pull request being judged.
  //
  // On argv that string is a real flag and commander consumes it before the
  // gate sees a path at all, which is why the rendered CI passes the list only
  // through `--changed-from` (asserted on the templates in `ci.test.ts`).
  // Through that file it is a path, and it is refused.
  it("refuses a changed path beginning with - as a positional", async () => {
    // Past `--` commander stops looking for options, so these arrive as the
    // paths they are spelled as and the gate's own guard is what answers.
    for (const dashed of ["-h", "--policy=pr-tree/index-policy.json", "--root=pr-tree"]) {
      errors = [];
      expect(await run(gate("--", dashed)), dashed).toBe(64);
      expect(errors.join("\n"), dashed).toContain('must not begin with "-"');
    }
  });

  it("refuses a changed path beginning with - read from --changed-from", async () => {
    const changed = path.join(dir, "changed.txt");
    fs.writeFileSync(changed, `${FILE}\n--policy=pr-tree/index-policy.json\n`);

    // Never 0 (an authorization) and never 1 (a judged contribution) — the
    // gate refuses to judge a list it cannot trust.
    expect(await run(gate("--changed-from", changed))).toBe(64);
    expect(errors.join("\n")).toContain('must not begin with "-"');
  });
});

describe("validate --changed-from", () => {
  // Out of bounds on purpose: the path gate refuses these before the first
  // forge call, so the reason list is a hermetic view of how the file was
  // split. One reason per entry — a list that failed to split would produce a
  // single reason naming both paths at once.
  const A = ".github/workflows/pages.yml";
  const B = "scripts/release.sh";

  function gate(file: string): string[] {
    return [
      "node",
      "grim-indexer",
      "validate",
      "--forge",
      "github",
      "--root",
      dir,
      "--pr-tree",
      dir,
      "--author-login",
      "octocat",
      "--author-id",
      "1",
      "--changed-from",
      file,
    ];
  }

  async function reasonsFor(contents: string): Promise<string[]> {
    const file = path.join(dir, "changed.txt");
    fs.writeFileSync(file, contents);
    expect(await run(gate(file))).toBe(1);
    return errors.filter((line) => line.trimStart().startsWith("- "));
  }

  // `git diff -z` is what GitLab's job produces: NUL-separated, so a path
  // containing a newline cannot split one entry into two.
  it("reads a NUL-separated list", async () => {
    const reasons = await reasonsFor(`${A}\0${B}\0`);

    expect(reasons).toHaveLength(2);
    expect(reasons[0]).toContain(A);
    expect(reasons[1]).toContain(B);
    expect(reasons.join("\n"), "an unsplit entry would carry the separator").not.toContain("\0");
  });

  // …and newlines are what the GitHub job's `gh api --jq` output is.
  it("reads a newline-separated list, empty entries and all", async () => {
    const reasons = await reasonsFor(`${A}\n\n${B}\n`);

    expect(reasons).toHaveLength(2);
    expect(reasons[0]).toContain(A);
    expect(reasons[1]).toContain(B);
  });

  // A file of nothing but separators is an empty change set, not a change set
  // holding empty paths — and an empty set is refused rather than read as
  // "nothing to object to".
  it("treats a file with no entries as an empty change set", async () => {
    expect(await reasonsFor("\n\n")).toEqual(["  - empty change set"]);
  });

  // The gate cannot judge what it cannot read, and the one thing it must never
  // do about that is exit 0.
  it("exits 65 when the file cannot be read", async () => {
    expect(await run(gate(path.join(dir, "never-written.txt")))).toBe(65);
    expect(errors.join("\n")).toContain("cannot be read");
  });
});

describe("a registry it cannot reach exits 69", () => {
  function addPackage(name: string): void {
    const pkg = path.join(dir, "index", "github.com", "acme", name);
    fs.mkdirSync(pkg, { recursive: true });
    fs.writeFileSync(
      path.join(pkg, "metadata.json"),
      JSON.stringify({
        schema: 1,
        name,
        kind: "skill",
        ref: `ghcr.io/acme/skills/${name}`,
        description: "A test skill.",
        owner: { id: 1, github: "octocat" },
      }),
    );
  }

  // The common way this fails in CI: the job never installed grim. Every
  // package fails at once, which is an outage, not a bad package.
  it("enrich with no grim on PATH", async () => {
    addPackage("foo");
    expect(
      await run(["node", "grim-indexer", "enrich", dir, "--grim", "grim-does-not-exist"]),
    ).toBe(69);
  });

  // Nothing to enrich is not an outage, however unreachable the registry is.
  it("enrich on an index with no packages", async () => {
    expect(
      await run(["node", "grim-indexer", "enrich", dir, "--grim", "grim-does-not-exist"]),
    ).toBe(0);
  });
});

describe("success exits 0", () => {
  it("--help", async () => {
    expect(await run(["node", "grim-indexer", "--help"])).toBe(0);
  });

  it("--version", async () => {
    expect(await run(["node", "grim-indexer", "--version"])).toBe(0);
  });
});
