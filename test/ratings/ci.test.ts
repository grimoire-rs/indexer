// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Grimoire Authors

// C-010 / C-013 / S-012 / S-016 — the generated ratings job, on both forges.
//
// The index repository owns and commits its CI, and a generated `verify-ci`
// job re-renders and diffs on every push, so everything here is under two
// constraints at once: it must be correct, and it must be byte-stable when the
// `ratings` block is absent — an index that never turns ratings on must not
// see its committed pipeline change at all.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import yaml from "js-yaml";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { renderCi, resolveCi } from "../../src/ci.js";
import { run } from "../../src/cli/main.js";
import { STATS_FILE } from "../../src/ratings/seed.js";
import type { RatingsConfig } from "../../src/ratings/config.js";

const PAGES = ".github/workflows/pages.yml";
const GITLAB = ".gitlab-ci.yml";

const RATINGS: RatingsConfig = {
  provider: "github",
  container: "Ratings",
  createBudget: 400,
  lockThreads: true,
};

/** The verb this generated job invokes. WP-Hp wires it; the job predates it. */
const VERB = "grim-indexer ratings";

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "index-ratings-ci-"));
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(dir, { recursive: true, force: true });
});

function render(forge: "github" | "gitlab", ratings?: RatingsConfig): Map<string, string> {
  return renderCi(resolveCi({ forge }), ratings);
}

function file(forge: "github" | "gitlab", ratings?: RatingsConfig): string {
  return render(forge, ratings).get(forge === "github" ? PAGES : GITLAB) as string;
}

function load(forge: "github" | "gitlab", ratings?: RatingsConfig): Record<string, unknown> {
  return yaml.load(file(forge, ratings)) as Record<string, unknown>;
}

interface Step {
  name?: string;
  uses?: string;
  run?: string;
  "continue-on-error"?: boolean;
}
interface Job {
  steps?: Step[];
  needs?: unknown;
  dependencies?: unknown;
  if?: string;
  stage?: string;
  permissions?: Record<string, string>;
  rules?: unknown[];
  script?: string[];
  before_script?: string[];
  resource_group?: string;
  allow_failure?: boolean;
  artifacts?: { paths?: string[] };
}

function jobs(doc: Record<string, unknown>): Record<string, Job> {
  return (doc.jobs ?? doc) as Record<string, Job>;
}

describe("ratings absent — the pipeline is unchanged (C-013)", () => {
  it("renders byte-identical files whether the block is undefined or never passed", () => {
    for (const forge of ["github", "gitlab"] as const) {
      expect([...render(forge).entries()]).toEqual([...render(forge, undefined).entries()]);
    }
  });

  it("emits no ratings job, no schedule and no seed step", () => {
    const github = load("github");
    expect(jobs(github).ratings).toBeUndefined();
    expect(jobs(github).build.needs).toBeUndefined();
    expect((github.on as Record<string, unknown>).schedule).toBeUndefined();

    const gitlab = load("gitlab");
    expect(jobs(gitlab)["grim-indexer:ratings"]).toBeUndefined();
    expect(jobs(gitlab).pages.rules).toEqual([
      { if: "$CI_COMMIT_BRANCH == $CI_DEFAULT_BRANCH" },
    ]);

    for (const forge of ["github", "gitlab"] as const) {
      for (const [name, content] of render(forge)) {
        expect(content, `${forge}: ${name}`).not.toContain(STATS_FILE);
      }
    }
  });
});

describe("the generated ratings job — GitHub", () => {
  it("runs the ratings verb in its own job, with write access to discussions only", () => {
    const ratings = jobs(load("github", RATINGS)).ratings;

    expect(ratings, "pages.yml has no `ratings` job").toBeDefined();
    expect(ratings.steps?.map((step) => step.run ?? "").join("\n")).toContain(VERB);
    expect(ratings.permissions).toEqual({ contents: "read", discussions: "write" });
  });

  it("deploys even when the tally failed, which is the whole of S-012", () => {
    const build = jobs(load("github", RATINGS)).build;

    expect(build.needs).toBe("ratings");
    expect(build.if).toBe("always()");
  });

  // Two overlapping runs can interleave a stale tally over a fresh one, so
  // this is a correctness requirement rather than tuning.
  it("queues overlapping runs instead of cancelling them", () => {
    const concurrency = load("github", RATINGS).concurrency as Record<string, unknown>;

    expect(concurrency["cancel-in-progress"]).toBe(false);
  });

  it("re-tallies on a schedule, not only on a push", () => {
    expect((load("github", RATINGS).on as Record<string, unknown>).schedule).toBeDefined();
    expect((load("github").on as Record<string, unknown>).schedule).toBeUndefined();
  });

  it("prefers a fresh tally and falls back to the published sidecar", () => {
    const steps = jobs(load("github", RATINGS)).build.steps ?? [];
    const download = steps.findIndex((step) => (step.uses ?? "").includes("download-artifact"));
    const seed = steps.findIndex((step) => (step.run ?? "").includes("http_code"));
    const build = steps.findIndex((step) => (step.run ?? "").includes("npm run build"));

    expect(download, "no artifact download").toBeGreaterThanOrEqual(0);
    // A tally that failed produced no artifact, and that step must not fail
    // the deploy — the seed is then what gets published, unchanged.
    expect(steps[download]["continue-on-error"]).toBe(true);
    // Seed after the download (so a fresh tally wins) and before the build
    // (which is what joins the sidecar onto the catalog).
    expect(seed).toBeGreaterThan(download);
    expect(build).toBeGreaterThan(seed);
  });
});

describe("the generated ratings job — GitLab", () => {
  it("runs the ratings verb in its own job, serialized by a resource group", () => {
    const ratings = jobs(load("gitlab", RATINGS))["grim-indexer:ratings"];

    expect(ratings, ".gitlab-ci.yml has no ratings job").toBeDefined();
    expect([...(ratings.before_script ?? []), ...(ratings.script ?? [])].join("\n")).toContain(VERB);
    expect(ratings.resource_group).toBe("grim-ratings");
    expect(ratings.artifacts?.paths).toContain(STATS_FILE);
  });

  it("deploys even when the tally failed, which is the whole of S-012", () => {
    const doc = load("gitlab", RATINGS);
    const ratings = jobs(doc)["grim-indexer:ratings"];
    const pages = jobs(doc).pages;

    // A failed tally must not block the deploy that carries the seed forward.
    expect(ratings.allow_failure).toBe(true);
    // The artifact arrives by stage ordering — `test` before `deploy` — and
    // deliberately not through `needs:`, which would take `pages` off stage
    // ordering and let it deploy past a failed `verify-ci`.
    expect(ratings.stage).toBe("test");
    expect(pages.stage).toBe("deploy");
    expect(pages.needs).toBeUndefined();
    expect(pages.dependencies).toBeUndefined();
  });

  it("re-tallies on a schedule, and lets the scheduled pipeline deploy", () => {
    const doc = load("gitlab", RATINGS);
    const schedule = { if: '$CI_PIPELINE_SOURCE == "schedule"' };

    expect(jobs(doc)["grim-indexer:ratings"].rules).toContainEqual(schedule);
    expect(jobs(doc).pages.rules).toContainEqual(schedule);
    expect(jobs(load("gitlab")).pages.rules).not.toContainEqual(schedule);
  });
});

describe("the seed step — R-2 in shell (C-010)", () => {
  /**
   * Every shell line the deploy runs, on one forge, comments stripped — the
   * `|| true` assertion below is about what executes, and both seed templates
   * name the forbidden idiom in prose to say why it is not there.
   */
  function seedScript(forge: "github" | "gitlab"): string {
    const doc = load(forge, RATINGS);
    const raw =
      forge === "github"
        ? (jobs(doc).build.steps ?? []).map((step) => step.run ?? "").join("\n")
        : (jobs(doc).pages.script ?? []).join("\n");
    return raw
      .split("\n")
      .filter((line) => !line.trim().startsWith("#"))
      .join("\n");
  }

  it.each(["github", "gitlab"] as const)("branches on the status code — %s", (forge) => {
    const script = seedScript(forge);

    // 404 is absent-is-first-class; a 2xx is the merge base; anything else is
    // indistinguishable from a wipe and fails the job.
    expect(script).toContain("http_code");
    expect(script).toMatch(/\b404\)/);
    expect(script).toMatch(/2\?\?\)|\b2xx/);
  });

  // `|| true` cannot tell a genuine 404 from a DNS failure, a TLS error, a 5xx
  // or a truncated body. If the tally also failed, the deploy would then
  // publish a site with no sidecar at all — the exact wipe R-2 exists to
  // prevent.
  it.each(["github", "gitlab"] as const)("never swallows a failed fetch — %s", (forge) => {
    expect(seedScript(forge)).not.toContain("|| true");
    expect(seedScript(forge)).not.toMatch(/curl[^\n]*-f\b/);
  });

  it.each(["github", "gitlab"] as const)("parses what it fetched before trusting it — %s", (forge) => {
    expect(seedScript(forge)).toMatch(/JSON\.parse/);
  });
});

describe("rollback (S-016)", () => {
  // Removing the block is not enough on its own — the published file keeps
  // being served. Nothing generated here may make it undeletable, so the
  // sidecar is never committed and never pushed: it is built, uploaded and
  // deployed, and dropping the block stops the deploy from carrying it.
  it("never commits or pushes the sidecar", () => {
    for (const forge of ["github", "gitlab"] as const) {
      for (const [name, content] of render(forge, RATINGS)) {
        for (const line of content.split("\n")) {
          if (line.includes(STATS_FILE)) {
            expect(line, `${forge}: ${name}`).not.toMatch(/git (add|commit|push)/);
          }
        }
      }
    }
  });

  it("gitignores the sidecar in the scaffold, so it cannot be committed by hand", () => {
    const gitignore = fs.readFileSync(
      path.join(import.meta.dirname, "../../templates/gitignore"),
      "utf8",
    );

    expect(gitignore).toContain(STATS_FILE);
  });
});

describe("the drift guard still passes with ratings on", () => {
  it.each(["github", "gitlab"] as const)("renders what --check accepts — %s", async (forge) => {
    fs.writeFileSync(
      path.join(dir, "index.config.json"),
      JSON.stringify({ ci: { forge }, ratings: RATINGS }, null, 2) + "\n",
    );

    // A render that `--check` then rejects means `ci.ts` read the block and
    // `cli/ci.ts` did not, or the reverse — the failure mode that would red
    // every push in an index that turned ratings on.
    expect(await run(["node", "grim-indexer", "ci", dir])).toBe(0);
    expect(await run(["node", "grim-indexer", "ci", dir, "--check"])).toBe(0);
  });

  it.each(["github", "gitlab"] as const)("renders parseable YAML — %s", (forge) => {
    for (const [name, content] of render(forge, RATINGS)) {
      expect(() => yaml.load(content), name).not.toThrow();
    }
  });
});
