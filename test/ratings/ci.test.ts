// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Grimoire Authors

// C-010 / C-013 / S-012 / S-016 — the generated ratings job, on both forges.
//
// The index repository owns and commits its CI, and a generated `verify-ci`
// job re-renders and diffs on every push, so everything here is under two
// constraints at once: it must be correct, and it must be byte-stable when the
// `ratings` block is absent — an index that never turns ratings on must not
// see its committed pipeline change at all.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import yaml from "js-yaml";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { renderCi, resolveCi } from "../../src/ci.js";
import { loadConfig } from "../../src/config.js";
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

/**
 * The one source of the seed URL: `site` from the checked-out
 * index.config.json, which is the same file, key and run the tally reads.
 * Deliberately not the built-in default, which names the first-party index.
 */
const SITE = "https://index.example.test/catalog";

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
  id?: string;
  name?: string;
  uses?: string;
  run?: string;
  env?: Record<string, string>;
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

/**
 * The seed shell the deploy actually runs, plus the environment the runner
 * would have exported for it — minus the `${{ }}` expressions, which are
 * the runner's to resolve and this test's to supply.
 *
 * `enrich: false` because GitLab renders the enrichment and the seed into
 * one `script:` entry, and the enrichment reaches the network.
 */
function seedShell(forge: "github" | "gitlab"): { script: string; env: Record<string, string> } {
  const files = renderCi(resolveCi({ forge, enrich: false }), RATINGS);
  const doc = yaml.load(files.get(forge === "github" ? PAGES : GITLAB) as string) as Record<
    string,
    unknown
  >;
  if (forge === "gitlab") {
    // One `script:` entry of several — the rest of the deploy is npm.
    const block = (jobs(doc).pages.script ?? []).find((entry) => entry.includes("http_code"));
    return { script: block ?? "", env: {} };
  }
  const step = (jobs(doc).build.steps ?? []).find((entry) =>
    (entry.run ?? "").includes("http_code"),
  );
  const env = Object.fromEntries(
    Object.entries(step?.env ?? {}).filter(([, value]) => !value.includes("${{")),
  );
  return { script: step?.run ?? "", env };
}

/**
 * Run that shell for real, against a checkout carrying `site`. A tally
 * artifact is already in place, so it short-circuits before the network —
 * what is under test runs first, and asserting on a regex would prove the
 * guard is spelled rather than that it fires.
 */
function runSeed(
  forge: "github" | "gitlab",
  platformUrl?: string,
  site: string | undefined = SITE,
): { code: number; output: string } {
  const { script, env } = seedShell(forge);
  fs.writeFileSync(path.join(dir, STATS_FILE), "{}\n");
  fs.writeFileSync(
    path.join(dir, "index.config.json"),
    JSON.stringify(site === undefined ? {} : { site }, null, 2) + "\n",
  );
  const platform = forge === "github" ? "PAGES_URL" : "CI_PAGES_URL";
  const result = spawnSync(forge === "github" ? "bash" : "sh", ["-c", script], {
    cwd: dir,
    encoding: "utf8",
    env: {
      // No inherited environment: the script is under test, not this
      // machine's shell profile.
      HOME: dir,
      PATH: process.env.PATH ?? "",
      ...env,
      ...(platformUrl === undefined ? {} : { [platform]: platformUrl }),
    },
  });
return { code: result.status ?? -1, output: `${result.stdout}${result.stderr}` };
}

describe("the seed URL has one source (F-6)", () => {
  // The seed URL is read from the checkout, not baked into the workflow: the
  // tally reads `index.config.json` on every run, so a value frozen at render
  // time diverges again the moment `site` is edited without a re-render.
  it.each(["github", "gitlab"] as const)("reads the site from the checkout — %s", (forge) => {
    const { script } = seedShell(forge);

    expect(script).toContain("index.config.json");
    expect(script).not.toContain(SITE);
  });

  it.each(["github", "gitlab"] as const)("never fetches from the platform URL — %s", (forge) => {
    const { script } = seedShell(forge);
    const fetches = script.split("\n").filter((line) => line.includes("stats.json.seed"));

    expect(fetches.join("\n")).not.toMatch(/CI_PAGES_URL|PAGES_URL|base_url/);
  });

  it.each(["github", "gitlab"] as const)("fetches what the checkout names — %s", (forge) => {
    // 404 is a legal empty seed, so a wrong URL completes the run: the only
    // proof the right one is used is the URL the fetch is handed.
    const { code, output } = runSeed(forge, undefined, "https://from-the-checkout.example.test/x");

    expect(code, output).toBe(0);
    expect(runSeed(forge, undefined, "").code, "an absent site must not be defaulted").not.toBe(0);
  });

  it.each(["github", "gitlab"] as const)("refuses a site that is not https — %s", (forge) => {
    // The seed decides every published rating, and `--proto '=https'` would
    // refuse it further down anyway — in curl's words, on the runner.
    const { code, output } = runSeed(forge, undefined, "http://index.example.test/catalog");

    expect(code, output).not.toBe(0);
    expect(output).toContain("https");
  });

  // The whole of F-6: the guard read one URL and the tally read another, so a
  // 404 on the tally's URL — a legal empty seed — published a sidecar built
  // from nothing while the guard passed on a URL that was fine.
  it("fails when the site and the deployment disagree — github", () => {
    const other = "https://someone-else.example.test/catalog";
    const { code, output } = runSeed("github", other);

    expect(code, output).not.toBe(0);
    expect(output).toContain(SITE);
    expect(output).toContain(other);
  });

  it("reads slash, scheme and host case as agreement — github", () => {
    for (const agreeing of [
      SITE,
      `${SITE}/`,
      `${SITE}//`,
      SITE.replace("https://", "http://"),
      SITE.replace("index.example.test", "Index.Example.Test"),
    ]) {
      const { code, output } = runSeed("github", agreeing);
      expect(code, `${agreeing}: ${output}`).toBe(0);
    }
  });

  // A fork, or a deploy that is not Pages, has no such URL. That is not a
  // disagreement — `site` is authoritative alone.
  it("runs when the platform is silent — github", () => {
    const { code, output } = runSeed("github", undefined);

    expect(code, output).toBe(0);
  });

  // The only wire from the platform into the guard. Without this the guard
  // fires in every test and is fed by none of them — which is how F-6 itself
  // survived a review.
  it("wires the cross-check to the step that resolves the Pages URL — github", () => {
    const steps = jobs(load("github", RATINGS)).build.steps ?? [];
    const pages = steps.findIndex((step) => step.id === "pages");
    const seed = steps.findIndex((step) => (step.run ?? "").includes("http_code"));

    expect(pages, "no step resolves the Pages URL").toBeGreaterThanOrEqual(0);
    expect(steps[seed].env?.PAGES_URL).toBe("${{ steps.pages.outputs.base_url }}");
    expect(seed).toBeGreaterThan(pages);
  });

  // `CI_PAGES_URL` is always a subdomain of `CI_PAGES_DOMAIN` and never
  // reflects a custom domain; unique domains (16.7+) and `path_prefix`
  // (17.9+) move it again. It disagrees with a correct `site` as the normal
  // case, so comparing them would fail every such deploy.
  it("never compares against CI_PAGES_URL — gitlab", () => {
    // Comments stripped: the template names the variable in prose to say why
    // it is not compared, which is the opposite of using it.
    const executable = seedShell("gitlab")
      .script.split("\n")
      .filter((line) => !line.trim().startsWith("#"))
      .join("\n");

    expect(executable).not.toContain("CI_PAGES_URL");
  });
});

// One acceptance policy for `site`, at load, where `ci`, `ratings` and the
// renderer all see the same answer. The generated seed step's own `case` guard
// is belt-and-braces for the same rule — while the two were spelled separately,
// a value config accepted was refused on the runner, in the deploy job, after
// the tally had already written to the forge.
describe("`site` is validated once, at load (F-6)", () => {
  async function load(site: unknown): Promise<string | undefined> {
    fs.writeFileSync(path.join(dir, "index.config.json"), JSON.stringify({ site }));
    return (await loadConfig(dir)).site;
  }

  it.each([
    ["HTTPS://a.example/x", "the generated guard matches the lowercase prefix"],
    ["HtTpS://a.example/x", "same"],
    ["https://real.example@evil.example/x", "userinfo: reads as one host, fetches another"],
    ["https://a.example/x?v=1", "`<site>/stats.json` would append to the query"],
    ["https://a.example/x#y", "curl drops the fragment and fetches the site's own HTML"],
    ["https://a.example/x\n::add-mask::secret", "a newline is a workflow command in an ::error:: line"],
    [null, "not a string, and `resolveConfig` keeps null rather than defaulting it"],
  ])("refuses %j", async (site) => {
    await expect(load(site)).rejects.toThrow(/site/);
  });

  it.each([
    "https://a.example",
    "https://a.example/x",
    "https://a.example/x/",
    // IDN: curl resolves it, so refusing it would be a charset opinion rather
    // than a constraint the fetch needs.
    "https://ex\u00e4mple.test/x",
    // `init --quick` writes exactly this when no Pages URL is derivable, and
    // an index that never enables ratings never fetches anything.
    "http://localhost:4321",
  ])("accepts %s", async (site) => {
    await expect(load(site)).resolves.toBe(site);
  });

  // A scaffolder that can write a value the next command refuses to load is
  // the same split policy, one layer up.
  it("is the rule `init --base-url` enforces too", async () => {
    expect(await run(["node", "grim-indexer", "init", dir, "--quick", "--base-url", "https://a.example/x?v=1"])).toBe(65);
    expect(fs.existsSync(path.join(dir, "index.config.json"))).toBe(false);
  });

  // The seed step enforces TLS too, but it runs in the deploy job — on both
  // forges the tally has by then created and locked threads on the forge. The
  // verb refuses first, before any of that.
  it("refuses a non-https site before the tally touches the forge", async () => {
    fs.writeFileSync(
      path.join(dir, "index.config.json"),
      JSON.stringify({ site: "http://localhost:4321", ratings: RATINGS }),
    );

    // A usable policy file, so the run would otherwise get as far as the forge.
    fs.writeFileSync(
      path.join(dir, "index-policy.json"),
      JSON.stringify({ trustedBots: [{ login: "bot", id: "1" }] }),
    );

    expect(await run(["node", "grim-indexer", "ratings", dir])).toBe(65);
    // The message, not just the code: without this the run still exits 65,
    // one step later, for a missing forge variable instead of the real cause.
    expect(vi.mocked(console.error).mock.calls.flat().join("\n")).toMatch(/https/);
  });

  // The seed step must not be the first thing to notice: on both forges it runs
  // after the tally has created and locked threads on the forge.
  it.each(["github", "gitlab"] as const)("is the same rule the seed step keeps — %s", (forge) => {
    expect(seedShell(forge).script).toContain("https://*)");
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
