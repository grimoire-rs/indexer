// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Grimoire Authors

// What the rendered CI lets near a shared cache, and how long a GitLab job may
// run. The GitHub half is scoped by `cache-mode`, which only github.com knows:
// GitHub Enterprise Server refuses a workflow that names it, so the key has to
// be rendered from a positive "this index is on github.com" and from nothing
// else. Most of what follows pins that asymmetry, because the safe direction
// (omit) and the useful one (render) fail very differently.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import yaml from "js-yaml";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { driftError } from "../../src/ci.js";
import { run } from "../../src/cli/main.js";

type Doc = Record<string, unknown>;

interface Step {
  uses?: string;
  with?: Record<string, unknown>;
}

interface Job {
  "cache-mode"?: string;
  cache?: unknown;
  timeout?: string;
  rules?: Array<{ if?: string }>;
  steps?: Step[];
}

const PAGES = ".github/workflows/pages.yml";
const VALIDATE = ".github/workflows/validate.yml";
const VERIFY = ".github/workflows/verify-ci.yml";
const PUBLISH = ".github/workflows/publish.yml";
const GITLAB = ".gitlab-ci.yml";

/** Every job of every optional feature at once, so no job escapes the sweep. */
const EVERYTHING = {
  publish: "tag",
  autoMerge: true,
} as const;
// Auto-merge is GitHub-only, so the GitLab sweep takes the rest.
const GITLAB_EVERYTHING = { publish: "tag" } as const;
const STATS = {
  ratings: { provider: "github", container: "Ratings" },
  downloads: { baseUrl: "https://artifactory.example.test/artifactory" },
};

const ON_GITHUB_COM = { repoUrl: "https://github.com/acme/idx" };

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "index-ci-cache-"));
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(dir, { recursive: true, force: true });
});

/** Render a config through the CLI and hand back each file's raw text. */
async function render(config: Record<string, unknown>): Promise<Map<string, string>> {
  const root = fs.mkdtempSync(path.join(dir, "case-"));
  fs.writeFileSync(path.join(root, "index.config.json"), JSON.stringify(config) + "\n");
  expect(await run(["node", "grim-indexer", "ci", root])).toBe(0);

  const files = new Map<string, string>();
  for (const rel of [PAGES, VALIDATE, VERIFY, PUBLISH, GITLAB]) {
    const abs = path.join(root, rel);
    if (fs.existsSync(abs)) files.set(rel, fs.readFileSync(abs, "utf8"));
  }
  return files;
}

function githubConfig(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { ci: { forge: "github", ...EVERYTHING }, ...STATS, ...extra };
}

function parse(text: string | undefined): Doc {
  return yaml.load(text ?? "") as Doc;
}

function jobsOf(workflow: Doc): Array<[string, Job]> {
  return Object.entries(workflow.jobs as Record<string, Job>);
}

/** A job's own `cache-mode`, else the workflow's: the one GitHub applies. */
function effectiveCacheMode(workflow: Doc, job: Job): unknown {
  return job["cache-mode"] ?? workflow["cache-mode"];
}

function cacheInputs(job: Job): unknown[] {
  return (job.steps ?? []).map((step) => step.with?.cache).filter((cache) => cache !== undefined);
}

describe("github.com: cache scoping", () => {
  it("sets cache-mode none on every job except the one default-branch cache writer", async () => {
    const files = await render(githubConfig(ON_GITHUB_COM));

    // All seven jobs are in play, or the sweep below proves less than it says.
    const seen = [...files.entries()]
      .filter(([rel]) => rel !== GITLAB)
      .flatMap(([rel, text]) => jobsOf(parse(text)).map(([name]) => `${rel}:${name}`));
    expect(seen.sort()).toEqual(
      [
        `${PAGES}:build`,
        `${PAGES}:deploy`,
        `${PAGES}:stats`,
        `${VALIDATE}:validate`,
        `${VALIDATE}:automerge`,
        `${VERIFY}:verify-ci`,
        `${PUBLISH}:publish`,
      ].sort(),
    );

    for (const [rel, text] of files) {
      if (rel === GITLAB) continue;
      const workflow = parse(text);
      for (const [name, job] of jobsOf(workflow)) {
        const mode = effectiveCacheMode(workflow, job);
        if (rel === PAGES && name === "build") {
          expect(mode, "pages/build is the cache writer and is left as is").toBeUndefined();
        } else {
          expect(mode, `${rel}:${name}`).toBe("none");
        }
      }
    }
  });

  it("scopes pages.yml per job, so its build job keeps the default", async () => {
    const pages = parse((await render(githubConfig(ON_GITHUB_COM))).get(PAGES));

    expect(pages["cache-mode"], "a workflow-level key would switch the writer off").toBeUndefined();
    const jobs = pages.jobs as Record<string, Job>;
    expect(jobs.deploy?.["cache-mode"]).toBe("none");
    expect(jobs.stats?.["cache-mode"]).toBe("none");
  });

  it("sets it at workflow level where no job is the writer", async () => {
    const files = await render(githubConfig(ON_GITHUB_COM));

    for (const rel of [VALIDATE, VERIFY, PUBLISH]) {
      expect(parse(files.get(rel))["cache-mode"], rel).toBe("none");
    }
  });

  it("leaves no job that reads a cache it has switched off", async () => {
    const files = await render(githubConfig(ON_GITHUB_COM));

    for (const [rel, text] of files) {
      if (rel === GITLAB) continue;
      const workflow = parse(text);
      for (const [name, job] of jobsOf(workflow)) {
        if (effectiveCacheMode(workflow, job) !== "none") continue;
        // It restores nothing under `none`, so the input would only warn on every run.
        expect(cacheInputs(job), `${rel}:${name}`).toEqual([]);
      }
    }
  });
});

describe("every host: npm caching", () => {
  const HOSTS: Array<[string, Record<string, unknown>]> = [
    ["github.com", ON_GITHUB_COM],
    ["unknown", {}],
    ["GitHub Enterprise Server", { repoUrl: "https://github.example.test/acme/idx" }],
  ];

  it.each(HOSTS)("never caches npm in the gate or the drift guard (%s)", async (_label, hosts) => {
    const files = await render(githubConfig(hosts));

    for (const rel of [VALIDATE, VERIFY]) {
      for (const [name, job] of jobsOf(parse(files.get(rel)))) {
        expect(cacheInputs(job), `${rel}:${name}`).toEqual([]);
      }
    }
  });

  it.each(HOSTS)("never caches npm in the stats job (%s)", async (_label, hosts) => {
    const pages = parse((await render(githubConfig(hosts))).get(PAGES));

    expect(cacheInputs((pages.jobs as Record<string, Job>).stats as Job)).toEqual([]);
  });

  it.each(HOSTS)("keeps the pages build as the one job that caches npm (%s)", async (_label, hosts) => {
    const files = await render(githubConfig(hosts));

    const cachers = [...files.entries()]
      .filter(([rel]) => rel !== GITLAB)
      .flatMap(([rel, text]) => jobsOf(parse(text)).map(([name, job]) => [`${rel}:${name}`, job] as const))
      .filter(([, job]) => cacheInputs(job).length > 0)
      .map(([id]) => id);
    expect(cachers).toEqual([`${PAGES}:build`]);
  });
});

describe("cache-mode is rendered only for github.com", () => {
  const NOT_GITHUB_COM: Array<[string, Record<string, unknown>]> = [
    ["no site and no repository", {}],
    ["a GitHub Enterprise Server repository", { repoUrl: "https://github.example.test/acme/idx" }],
    ["a custom domain with no repository", { site: "https://index.example.test" }],
    ["a host that only starts with github.com", { repoUrl: "https://github.com.evil.test/acme/idx" }],
    ["a host that only ends in github.io", { site: "https://acme.github.io.evil.test/idx" }],
    ["a GitLab repository", { repoUrl: "https://gitlab.com/acme/idx" }],
    ["a repository that is not a URL", { repoUrl: "git@github.com:acme/idx.git" }],
    ["a site that is not a string", { site: 42 }],
  ];

  it.each(NOT_GITHUB_COM)("renders no cache-mode line for %s", async (_label, hosts) => {
    const files = await render(githubConfig(hosts));

    expect([...files.keys()]).toContain(PAGES);
    for (const [rel, text] of files) {
      expect(text, rel).not.toContain("cache-mode");
    }
  });

  const GITHUB_COM: Array<[string, Record<string, unknown>]> = [
    ["a github.com repository", { repoUrl: "https://github.com/acme/idx" }],
    ["a github.com repository in any case", { repoUrl: "https://GitHub.com/acme/idx" }],
    ["a github.io Pages site", { site: "https://acme.github.io/idx" }],
    ["a github.io Pages root", { site: "https://acme.github.io" }],
    ["a custom domain beside a github.com repository", {
      site: "https://index.example.test",
      repoUrl: "https://github.com/acme/idx",
    }],
  ];

  it.each(GITHUB_COM)("renders it for %s", async (_label, hosts) => {
    const files = await render(githubConfig(hosts));

    expect(files.get(VERIFY)).toContain("cache-mode: none");
  });

  it("renders none of it for GitLab, whatever the host", async () => {
    const files = await render({ ci: { forge: "gitlab" }, ...ON_GITHUB_COM });

    expect(files.get(GITLAB)).not.toContain("cache-mode");
  });
});

describe("GitLab: merge request jobs and timeouts", () => {
  async function gitlab(ci: Record<string, unknown> = {}): Promise<Doc> {
    const config = { ci: { forge: "gitlab", ...ci }, ratings: { provider: "gitlab", container: "Task" }, ...ON_GITHUB_COM };
    return parse((await render(config)).get(GITLAB));
  }

  function jobs(doc: Doc): Array<[string, Job]> {
    return Object.entries(doc).filter(
      ([key, value]) => key !== "default" && key !== "stages" && value !== null && typeof value === "object",
    ) as Array<[string, Job]>;
  }

  const runsOnMergeRequests = (job: Job) =>
    (job.rules ?? []).some((rule) => rule.if?.includes("merge_request_event"));

  it("switches the cache off for every job a merge request can run", async () => {
    const doc = await gitlab(GITLAB_EVERYTHING);

    const mergeRequestJobs = jobs(doc).filter(([, job]) => runsOnMergeRequests(job));
    expect(mergeRequestJobs.map(([name]) => name).sort()).toEqual([
      "grim-indexer:validate",
      "grim-indexer:verify-ci",
    ]);
    for (const [name, job] of mergeRequestJobs) {
      expect(job.cache, name).toEqual([]);
    }
  });

  it("leaves the default-branch jobs on the shared cache", async () => {
    const doc = await gitlab(GITLAB_EVERYTHING);

    for (const [name, job] of jobs(doc)) {
      if (runsOnMergeRequests(job)) continue;
      expect(job.cache, name).toBeUndefined();
    }
    expect((doc.default as Doc).cache).toBeDefined();
  });

  it("gives every job a two hour timeout", async () => {
    const doc = await gitlab(GITLAB_EVERYTHING);
    const fallback = (doc.default as Job).timeout;

    // The jobs are all there, or "every job" is vacuous.
    expect(jobs(doc).map(([name]) => name).sort()).toEqual([
      "grim-indexer:publish",
      "grim-indexer:stats",
      "grim-indexer:validate",
      "grim-indexer:verify-ci",
      "pages",
    ]);
    for (const [name, job] of jobs(doc)) {
      expect(job.timeout ?? fallback, name).toBe("2h");
    }
  });
});

describe("drift error", () => {
  it("says an upgrade renders new CI, and what to do about it", () => {
    const error = driftError([{ path: PAGES, status: "drift" }]);

    expect(error.message).toContain("npm run ci");
    expect(error.message).toContain("@grimoire-rs/indexer");
    expect(error.message).toMatch(/upgrade/i);
  });
});
