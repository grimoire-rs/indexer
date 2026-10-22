// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Grimoire Authors

// The build-state blob-store cache as the rendered CI wires it (IX-R26, IX-R21;
// the rendered halves of IX-R10, IX-R27, IX-R43; spec V-17). The cache is the
// only thing a pipeline restores into a job that then publishes, so most of
// what follows pins what may NOT happen: a fallback key, a save from a failed
// or non-default run, a path wider than the blob store, an input spliced into
// a script. The enrich body and the key step are run for real, because
// asserting that a guard is spelled proves nothing about whether it fires.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import yaml from "js-yaml";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { renderCi, resolveCi, type CiConfig } from "../../src/ci.js";
import type { RatingsConfig } from "../../src/ratings/config.js";
import { STATE_DIR } from "../../src/state/handoff.js";
import { STATE_KEY_RE } from "../../src/state/statekey.js";

const PAGES = ".github/workflows/pages.yml";
const GITLAB = ".gitlab-ci.yml";
const BLOB_STORE = `${STATE_DIR}/b`;
const KEY_PREFIX = "grim-index-state-v1";
const RATINGS: RatingsConfig = { provider: "github", container: "Ratings", createBudget: 400, lockThreads: true };
const HEX = "a".repeat(64);
const GOOD_KEY = `1735689600-${HEX}`;

interface Step {
  id?: string;
  name?: string;
  uses?: string;
  if?: string;
  env?: Record<string, unknown>;
  with?: Record<string, unknown>;
  run?: string;
}

type Doc = Record<string, unknown>;

function render(ci: CiConfig): Map<string, string> {
  return renderCi(resolveCi(ci));
}

function github(ci: Partial<CiConfig> = {}): { text: string; doc: Doc; steps: Step[] } {
  const text = render({ forge: "github", ...ci }).get(PAGES) as string;
  const doc = yaml.load(text) as Doc;
  const build = (doc.jobs as Record<string, { steps: Step[] }>).build;
  return { text, doc, steps: build?.steps ?? [] };
}

function gitlab(ci: Partial<CiConfig> = {}): { text: string; doc: Doc } {
  const text = render({ forge: "gitlab", ...ci }).get(GITLAB) as string;
  return { text, doc: yaml.load(text) as Doc };
}

const byId = (steps: Step[], id: string) => steps.find((step) => step.id === id);
const usesOf = (steps: Step[], action: string) => steps.filter((step) => step.uses?.startsWith(`${action}@`));
const indexOfRun = (steps: Step[], needle: string) => steps.findIndex((step) => (step.run ?? "").includes(needle));

describe("github: the blob-store cache (IX-R26, V-17)", () => {
  it("gives the build job a 120 minute timeout, and the enrich step the same budget in seconds", () => {
    const { doc, steps } = github();

    expect((doc.jobs as Record<string, Doc>).build?.["timeout-minutes"]).toBe(120);
    const enrich = steps.find((step) => (step.run ?? "").includes("npm run enrich"));
    expect(String(enrich?.env?.CI_JOB_TIMEOUT)).toBe("7200");
  });

  it("restores the exact key from state-key, with no fallback key and no other path", () => {
    const { text, steps } = github();

    expect(text, "a fallback key would restore an entry nobody named").not.toContain("restore-keys");
    const restores = usesOf(steps, "actions/cache/restore").filter((step) => step.with?.["lookup-only"] !== true);
    expect(restores).toHaveLength(1);
    expect(restores[0]?.with?.key).toBe(`${KEY_PREFIX}-\${{ steps.state-key.outputs.key }}`);
    expect(restores[0]?.with?.path).toBe(BLOB_STORE);
  });

  it("runs the key step as `npx --no grim-indexer state-key`, before the restore", () => {
    const { steps } = github();

    const keyAt = steps.findIndex((step) => step.id === "state-key");
    const restoreAt = steps.findIndex((step) => step.id === "state-restore");
    const enrichAt = indexOfRun(steps, "npm run enrich");
    expect(steps[keyAt]?.run).toContain("npx --no grim-indexer state-key");
    expect(steps[keyAt]?.run, "the --next call is its own step").not.toContain("--next");
    expect(keyAt).toBeGreaterThanOrEqual(0);
    expect(enrichAt, "the enrich step is rendered").toBeGreaterThanOrEqual(0);
    expect(keyAt).toBeLessThan(restoreAt);
    expect(restoreAt).toBeLessThan(enrichAt);
  });

  it("admits a key only through STATE_KEY_RE, rendered from the one definition", () => {
    const { steps } = github();

    // The contract the spec states, pinned once here; the template must carry
    // the code's regex, so a changed grammar cannot leave a looser copy behind.
    expect(STATE_KEY_RE.source).toBe("^[0-9]{1,16}-[0-9a-f]{64}$");
    for (const id of ["state-key", "state-next"]) {
      expect(byId(steps, id)?.run, id).toContain(STATE_KEY_RE.source);
    }
  });

  it("restores and looks up only when the key was admitted: a rejected key is a cold build", () => {
    const { steps } = github();

    expect(byId(steps, "state-restore")?.if).toBe("github.ref == 'refs/heads/main' && steps.state-key.outputs.key != ''");
    expect(byId(steps, "state-next")?.if).toContain("steps.state-key.outputs.key != ''");
    expect(byId(steps, "state-lookup")?.if).toBe(
      "github.ref == 'refs/heads/main' && steps.state-next.outputs.key != ''",
    );
  });

  it("drops the blob store after any restore that was not an exact-key hit", () => {
    const { steps } = github();

    // The cache service prefix-matches the primary key, so a restore can fill
    // the blob store with `cache-hit == 'false'`; only an exact entry may stay.
    const restoreAt = steps.findIndex((step) => step.id === "state-restore");
    const clean = steps[restoreAt + 1];
    expect(restoreAt).toBeGreaterThanOrEqual(0);
    expect(clean?.id).toBe("state-restore-clean");
    expect(clean?.uses).toBeUndefined();
    expect(clean?.run).toBe(`rm -rf -- ${BLOB_STORE}`);
    expect(clean?.if).toBe(
      "github.ref == 'refs/heads/main' && steps.state-key.outputs.key != '' && steps.state-restore.outputs.cache-hit != 'true'",
    );
    expect(restoreAt + 1, "before anything reads the state").toBeLessThan(indexOfRun(steps, "npm run enrich"));
  });

  it("saves under the --next key, on the default branch, on success, when no entry exists", () => {
    const { steps } = github();

    const next = byId(steps, "state-next");
    expect(next?.run).toContain("npx --no grim-indexer state-key --next");
    const lookup = byId(steps, "state-lookup");
    expect(lookup?.uses).toMatch(/^actions\/cache\/restore@/);
    expect(lookup?.with).toMatchObject({
      key: `${KEY_PREFIX}-\${{ steps.state-next.outputs.key }}`,
      path: BLOB_STORE,
      "lookup-only": true,
    });

    const saves = usesOf(steps, "actions/cache/save");
    expect(saves).toHaveLength(1);
    const save = saves[0] as Step;
    expect(save.with).toEqual({ key: `${KEY_PREFIX}-\${{ steps.state-next.outputs.key }}`, path: BLOB_STORE });
    expect(save.if).toBe(
      "success() && github.ref == 'refs/heads/main' && steps.state-next.outputs.key != '' && steps.state-lookup.outputs.cache-hit != 'true'",
    );
  });

  it("saves only after the build, so a failed build leaves no entry", () => {
    const { steps } = github();

    const saveAt = steps.findIndex((step) => step.uses?.startsWith("actions/cache/save@"));
    const buildAt = indexOfRun(steps, "npm run build");
    const enrichAt = indexOfRun(steps, "npm run enrich");
    // -1 would satisfy every "after" below, so each anchor must exist first.
    expect(buildAt, "the build step is rendered").toBeGreaterThanOrEqual(0);
    expect(enrichAt, "the enrich step is rendered").toBeGreaterThanOrEqual(0);
    expect(saveAt, "the save step is rendered").toBeGreaterThanOrEqual(0);
    expect(saveAt).toBeGreaterThan(buildAt);
    expect(saveAt).toBeGreaterThan(enrichAt);
  });

  it("touches the state on the default branch only, and names the configured trunk, not main", () => {
    const { steps } = github({ defaultBranch: "trunk" });

    // Every step that reads or writes the state carries its own branch guard:
    // a dispatch from any other branch must neither restore nor seed it.
    for (const id of ["state-key", "state-restore", "state-restore-clean", "state-next", "state-lookup"]) {
      expect(byId(steps, id)?.if, id).toContain("github.ref == 'refs/heads/trunk'");
    }
    const touching = steps.filter((step) => step.uses?.includes("actions/cache"));
    expect(touching).toHaveLength(3);
    for (const step of touching) {
      expect(step.if, step.uses).toContain("github.ref == 'refs/heads/trunk'");
    }
    expect(JSON.stringify(steps)).not.toContain("refs/heads/main");
  });

  it("never lets `always()` near the cache, even with the stats job making the build job run on", () => {
    const { text, steps } = github({ forge: "github" });
    expect(text).not.toContain("always()");

    const withStats = renderCi(resolveCi({ forge: "github" }), RATINGS).get(PAGES) as string;
    const stepsWithStats = ((yaml.load(withStats) as Doc).jobs as Record<string, { steps: Step[] }>).build?.steps ?? [];
    for (const step of stepsWithStats.filter((s) => s.uses?.includes("actions/cache"))) {
      expect(step.if ?? "", step.uses).not.toContain("always()");
    }
    expect(steps.length).toBeGreaterThan(0);
  });

  it("pins every cache step to the blob store, never $HOME, GRIM_HOME or ~/.docker", () => {
    const { steps } = github();

    const cacheSteps = steps.filter((step) => step.uses?.includes("actions/cache"));
    expect(cacheSteps).toHaveLength(3);
    for (const step of cacheSteps) {
      expect(step.with?.path, step.uses).toBe(BLOB_STORE);
      expect(JSON.stringify(step.with)).not.toMatch(/HOME|~|\.docker/);
    }
  });

  it("keeps the cache out of every other job and workflow", () => {
    const files = render({ forge: "github", publish: "tag", autoMerge: true });

    for (const [file, text] of files) {
      if (file === PAGES) {
        const jobs = (yaml.load(text) as Doc).jobs as Record<string, { steps?: Step[] }>;
        for (const [name, job] of Object.entries(jobs)) {
          if (name === "build") continue;
          expect(JSON.stringify(job), `${file}:${name}`).not.toContain("actions/cache");
        }
      } else {
        expect(text, file).not.toContain("actions/cache");
      }
    }
  });

  it("takes fresh and purge as dispatch inputs and hands them over through env only (IX-R10)", () => {
    const { doc, steps } = github();

    const inputs = ((doc.on as Doc).workflow_dispatch as Doc).inputs as Record<string, Doc>;
    expect(inputs.fresh?.type).toBe("boolean");
    expect(inputs.purge?.type).toBe("string");
    const enrich = steps.find((step) => (step.run ?? "").includes("npm run enrich"));
    expect(enrich?.env?.GRIM_INDEX_FRESH).toBe("${{ inputs.fresh }}");
    expect(enrich?.env?.GRIM_INDEX_PURGE).toBe("${{ inputs.purge }}");
    for (const step of steps) {
      expect(step.run ?? "", `a run: script is shell, not a template (${step.name ?? step.id})`).not.toMatch(
        /\binputs\./,
      );
    }
  });

  it("is triggered by push, schedule and dispatch only: a pull request never reaches the cache", () => {
    const stats = renderCi(resolveCi({ forge: "github" }), RATINGS).get(PAGES) as string;

    for (const text of [github().text, stats]) {
      const on = Object.keys((yaml.load(text) as Doc).on as Doc);
      expect(on).toContain("push");
      expect(on).not.toContain("pull_request");
      expect(on).not.toContain("pull_request_target");
    }
  });

  it("splices no expression into a build-job script, with or without the stats job", () => {
    const stats = renderCi(resolveCi({ forge: "github" }), RATINGS).get(PAGES) as string;
    const withStats = ((yaml.load(stats) as Doc).jobs as Record<string, { steps: Step[] }>).build?.steps ?? [];

    for (const steps of [github().steps, withStats]) {
      expect(steps.filter((step) => step.run !== undefined).length).toBeGreaterThan(0);
      for (const step of steps) {
        expect(step.run ?? "", `a run: script is shell, not a template (${step.name ?? step.id})`).not.toContain("${{");
      }
    }
  });

  it("renders none of it when enrichment is off", () => {
    const { text, doc } = github({ enrich: false });

    expect(text).not.toContain("actions/cache");
    expect(text).not.toContain("GRIM_INDEX_");
    expect(text).not.toContain("inputs:");
    expect(text).not.toContain("state-key");
    expect((doc.on as Doc).workflow_dispatch).toBeNull();
  });
});

// ── Running the rendered shell ───────────────────────────────────────────────

let dir: string;
let bin: string;
let log: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "index-ci-state-"));
  bin = path.join(dir, "bin");
  log = path.join(dir, "calls.log");
  fs.mkdirSync(bin);
  const stub = (name: string, body: string) => {
    fs.writeFileSync(path.join(bin, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  };
  // Records one argument per line, then exits as told: the stubs stand in for
  // the commands whose behaviour is not under test.
  stub("npm", 'printf "npm:%s\\n" "$@" >> "$STUB_LOG"; exit "${STUB_NPM_RC:-0}"');
  stub("npx", 'printf "npx:%s\\n" "$@" >> "$STUB_LOG"; printf "%s" "$STUB_NPX_OUT"; exit "${STUB_NPX_RC:-0}"');
  stub("apk", "exit 0");
  stub("apt-get", "exit 0");
  stub("sha256sum", "exit 0");
  stub("tar", "exit 0");
  stub("curl", 'exit "${STUB_CURL_RC:-0}"');
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

interface Ran {
  code: number;
  output: string;
  calls: string[];
  github: string;
}

function exec(shell: string, flags: string[], script: string, env: Record<string, string>): Ran {
  const file = path.join(dir, "script.sh");
  const githubOutput = path.join(dir, "github-output");
  fs.writeFileSync(file, script);
  fs.writeFileSync(githubOutput, "");
  fs.writeFileSync(log, "");
  const result = spawnSync(shell, [...flags, file], {
    cwd: dir,
    encoding: "utf8",
    env: { HOME: dir, PATH: `${bin}:${process.env.PATH ?? ""}`, STUB_LOG: log, GITHUB_OUTPUT: githubOutput, ...env },
  });
  return {
    code: result.status ?? -1,
    output: `${result.stdout}${result.stderr}`,
    calls: fs.readFileSync(log, "utf8").split("\n").filter(Boolean),
    github: fs.readFileSync(githubOutput, "utf8"),
  };
}

/** A GitHub `run:` as the runner runs it: `bash -e` over a script file. */
function runGithub(step: Step | undefined, env: Record<string, string> = {}): Ran {
  // An absent step would run an empty script and pass every "writes nothing" case.
  if (step?.run === undefined) throw new Error("the step under test is not rendered");
  const own = Object.fromEntries(
    Object.entries(step?.env ?? {})
      .filter(([, value]) => !String(value).includes("${{"))
      .map(([key, value]) => [key, String(value)]),
  );
  return exec("bash", ["-e"], step.run, { ...own, ...env });
}

const onUnix = describe.skipIf(process.platform === "win32");

onUnix("github: the key step admits only a well-formed key (V-17)", () => {
  const step = (id: string) => byId(github().steps, id);

  it.each(["state-key", "state-next"])("%s writes a well-formed key to GITHUB_OUTPUT", (id) => {
    const ran = runGithub(step(id), { STUB_NPX_OUT: `${GOOD_KEY}\n` });

    expect(ran.code, ran.output).toBe(0);
    expect(ran.github).toBe(`key=${GOOD_KEY}\n`);
  });

  it.each([
    ["an epoch with a newline and a second output", `1\nX=y\n`],
    ["a valid key with a second line behind it", `${GOOD_KEY}\nX=y\n`],
    ["a 63 character digest", `1-${"a".repeat(63)}\n`],
    ["an upper-case digest", `1-${"A".repeat(64)}\n`],
    ["a 17 digit epoch", `12345678901234567-${HEX}\n`],
    ["a leading space", ` ${GOOD_KEY}\n`],
    ["nothing", ""],
  ])("writes nothing for %s, so the build is cold", (_label, out) => {
    for (const id of ["state-key", "state-next"]) {
      const ran = runGithub(step(id), { STUB_NPX_OUT: out });

      expect(ran.github, id).toBe("");
      expect(ran.code, `${id}: a cold build is not a failed build\n${ran.output}`).toBe(0);
    }
  });

  it("writes nothing when state-key itself exits non-zero, whatever it printed", () => {
    const ran = runGithub(step("state-key"), { STUB_NPX_OUT: `${GOOD_KEY}\n`, STUB_NPX_RC: "69" });

    expect(ran.github).toBe("");
    expect(ran.code, ran.output).toBe(0);
  });

  it("calls the locked renderer through npx --no, never a package.json script", () => {
    const ran = runGithub(step("state-key"), { STUB_NPX_OUT: `${GOOD_KEY}\n` });

    expect(ran.calls).toEqual(["npx:--no", "npx:grim-indexer", "npx:state-key"]);
    expect(runGithub(step("state-next"), { STUB_NPX_OUT: `${GOOD_KEY}\n` }).calls).toEqual([
      "npx:--no",
      "npx:grim-indexer",
      "npx:state-key",
      "npx:--next",
    ]);
  });
});

onUnix("github: the step that drops a stray restore (V-17)", () => {
  it("removes the blob store and nothing around it, and passes when there is none", () => {
    const clean = byId(github().steps, "state-restore-clean");
    const state = path.join(dir, STATE_DIR);
    fs.mkdirSync(path.join(state, "b"), { recursive: true });
    fs.writeFileSync(path.join(state, "b", "blob"), "x");
    fs.writeFileSync(path.join(state, "next.json"), "{}");

    const ran = runGithub(clean);

    expect(ran.code, ran.output).toBe(0);
    expect(fs.existsSync(path.join(state, "b"))).toBe(false);
    expect(fs.existsSync(path.join(state, "next.json"))).toBe(true);
    expect(runGithub(clean).code, "a cold build has no blob store to remove").toBe(0);
  });
});

/** The args `npm run enrich` was given, after the `run enrich --` prefix. */
const enrichArgs = (calls: string[]) => calls.slice(calls.indexOf("npm:--") + 1);

function enrichCases(run: (env: Record<string, string>) => Ran, warning: string): void {
  it("appends no flag beyond --seed when nothing is set", () => {
    const ran = run({});

    expect(ran.code, ran.output).toBe(0);
    expect(enrichArgs(ran.calls)).toEqual(["npm:--seed"]);
  });

  it("appends --purge= only for a non-empty purge, as one argument", () => {
    const value = "ghcr.io/acme/x:1; touch pwned && echo $(id)";
    const ran = run({ GRIM_INDEX_PURGE: value });

    expect(enrichArgs(ran.calls)).toEqual(["npm:--seed", `npm:--purge=${value}`]);
    expect(fs.existsSync(path.join(dir, "pwned"))).toBe(false);
  });

  it.each([["false"], [""], ["TRUE"], ["1"]])("appends --fresh only for the string true, not %j", (value) => {
    expect(enrichArgs(run({ GRIM_INDEX_FRESH: value }).calls)).toEqual(["npm:--seed"]);
  });

  it("appends --fresh for true, and both flags together", () => {
    expect(enrichArgs(run({ GRIM_INDEX_FRESH: "true" }).calls)).toEqual(["npm:--seed", "npm:--fresh"]);
    expect(enrichArgs(run({ GRIM_INDEX_FRESH: "true", GRIM_INDEX_PURGE: "sha256:ab" }).calls)).toEqual([
      "npm:--seed",
      "npm:--purge=sha256:ab",
      "npm:--fresh",
    ]);
  });

  it("fails the job on exit 65 when a flag was passed", () => {
    const flagged: Array<Record<string, string>> = [{ GRIM_INDEX_PURGE: "x" }, { GRIM_INDEX_FRESH: "true" }];
    for (const env of flagged) {
      const ran = run({ ...env, STUB_NPM_RC: "65" });

      expect(ran.code, ran.output).toBe(65);
      expect(ran.output).not.toContain("AFTER");
    }
  });

  it("warns and deploys on exit 65 when no flag was passed", () => {
    const ran = run({ STUB_NPM_RC: "65" });

    expect(ran.code, ran.output).toBe(0);
    expect(ran.output).toContain(warning);
    expect(ran.output).toContain("AFTER");
  });

  it.each([[69], [1], [75]])("warns and deploys on exit %i, flag or not", (rc) => {
    const either: Array<Record<string, string>> = [{}, { GRIM_INDEX_PURGE: "x", GRIM_INDEX_FRESH: "true" }];
    for (const env of either) {
      const ran = run({ ...env, STUB_NPM_RC: String(rc) });

      expect(ran.code, ran.output).toBe(0);
      expect(ran.output).toContain(`exited ${rc}`);
      expect(ran.output).toContain("AFTER");
    }
  });

  it("stays quiet on success", () => {
    expect(run({}).output).not.toContain("warning");
  });
}

onUnix("github: the enrich step body (IX-R10, V-17)", () => {
  const enrich = () => github().steps.find((step) => (step.run ?? "").includes("npm run enrich"));
  const withTail = (step: Step | undefined): Step => ({ ...step, run: step?.run === undefined ? undefined : `${step.run}\necho AFTER\n` });

  it("appends each flag only under its own guard, never unconditionally", () => {
    const body = enrich()?.run ?? "";

    expect(body).toContain('[ -n "${GRIM_INDEX_PURGE:-}" ]');
    expect(body).toContain('[ "${GRIM_INDEX_FRESH:-}" = true ]');
    expect(body).toContain("exit 65");
    expect(body).toMatch(/\[ "\$rc" -eq 65 \] && \[ -n "\$strict" \]/);
    expect(body).not.toContain("--purge=$GRIM_INDEX_PURGE npm");
  });

  enrichCases((env) => runGithub(withTail(enrich()), env), "::warning::enrich exited");
});

describe("gitlab: the blob-store cache (IX-R21, V-17)", () => {
  type Cache = { key?: unknown; paths?: string[]; policy?: string; when?: string; unprotect?: unknown };

  it("caches the blob store under the fixed key, pull-push, on success, in the pages job", () => {
    const { doc } = gitlab();

    const caches = (doc.pages as { cache: Cache[] }).cache;
    const state = caches.filter((cache) => typeof cache.key === "string");
    expect(state).toEqual([{ key: KEY_PREFIX, paths: [BLOB_STORE], policy: "pull-push", when: "on_success" }]);
  });

  it("keeps the shared npm cache in the pages job beside it", () => {
    const { doc } = gitlab();

    const caches = (doc.pages as { cache: Cache[] }).cache;
    expect(caches[0]).toEqual((doc.default as { cache: Cache }).cache);
  });

  it("never unprotects, never falls back to another key, never widens the path", () => {
    const { text } = gitlab();

    expect(text).not.toContain("unprotect");
    expect(text).not.toContain("fallback_keys");
    expect(text).not.toContain("restore-keys");
    expect(text).not.toMatch(/\$HOME|GRIM_HOME|~\/\.docker/);
  });

  it("gives the state cache to the pages job alone", () => {
    const { doc } = gitlab({});
    const files = render({ forge: "gitlab", publish: "tag" }).get(GITLAB) as string;
    const jobs = Object.entries(yaml.load(files) as Record<string, unknown>).filter(
      ([key, value]) =>
        key !== "default" && key !== "stages" && key !== "variables" && value !== null && typeof value === "object",
    );

    for (const [name, job] of jobs) {
      const holds = JSON.stringify((job as Doc).cache ?? "").includes(KEY_PREFIX);
      expect(holds, name).toBe(name === "pages");
    }
    expect(doc).toBeDefined();
  });

  it("states the two hour timeout once, on default, without a second copy", () => {
    const { text, doc } = gitlab();

    expect((doc.default as { timeout: string }).timeout).toBe("2h");
    expect(text.match(/^\s*timeout:/gm)).toHaveLength(1);
  });

  it("runs the pages job on the default branch alone, a scheduled pipeline included", () => {
    const stats = yaml.load(renderCi(resolveCi({ forge: "gitlab" }), RATINGS).get(GITLAB) as string) as Doc;
    const onDefault = "$CI_COMMIT_BRANCH == $CI_DEFAULT_BRANCH";

    // pull-push saves from every pipeline the job runs in; only a protected
    // ref may write the key, so no rule may admit a pipeline from another ref.
    expect((gitlab().doc.pages as { rules: unknown[] }).rules).toEqual([{ if: onDefault }]);
    expect((stats.pages as { rules: unknown[] }).rules).toEqual([
      { if: onDefault },
      { if: `$CI_PIPELINE_SOURCE == "schedule" && ${onDefault}` },
    ]);
  });

  it("states the protected-cache setting the fixed key relies on", () => {
    expect(gitlab().text).toContain("Use separate caches for protected branches");
  });

  it("lists the manual-run variables in the Run pipeline form, empty by default", () => {
    const { doc } = gitlab();

    const variables = doc.variables as Record<string, { value?: unknown; description?: unknown }>;
    expect(Object.keys(variables).sort()).toEqual(["GRIM_INDEX_FRESH", "GRIM_INDEX_PURGE"]);
    for (const [name, variable] of Object.entries(variables)) {
      expect(variable.value, name).toBe("");
      expect(String(variable.description).length, name).toBeGreaterThan(0);
    }
    expect(gitlab({ enrich: false }).doc.variables).toBeUndefined();
  });

  it("renders no state cache, and no inputs, when enrichment is off", () => {
    const { text } = gitlab({ enrich: false });

    expect(text).not.toContain(KEY_PREFIX);
    expect(text).not.toContain("GRIM_INDEX_");
  });
});

onUnix("gitlab: the enrich step body (IX-R10, V-17)", () => {
  const script = () => {
    const entries = ((gitlab().doc.pages as { script: string[] }).script ?? []).filter((entry) =>
      entry.includes("npm run enrich"),
    );
    expect(entries, "the body sits in one script entry").toHaveLength(1);
    return `${entries[0]}\necho AFTER\n`;
  };

  const run = (env: Record<string, string>) => exec("sh", ["-eu"], script(), env);

  it("never prints the GitHub warning syntax", () => {
    expect(script()).not.toContain("::warning::");
  });

  it("appends each flag only under its own guard", () => {
    const body = script();

    expect(body).toContain('[ -n "${GRIM_INDEX_PURGE:-}" ]');
    expect(body).toContain('[ "${GRIM_INDEX_FRESH:-}" = true ]');
    expect(body).toContain("exit 65");
  });

  it("runs the body in the then branch of the install if, never in a subshell", () => {
    // Comments say "then" and "else" too; only the code may count.
    const body = script().replace(/^\s*#.*$/gm, "");

    const ifAt = body.indexOf('if ( cd "$tmp"');
    const thenAt = body.indexOf("); then", ifAt);
    const enrichAt = body.indexOf("npm run enrich");
    const elseAt = body.indexOf("else", thenAt);
    // The install is the parenthesised group; the body follows it, outside.
    expect(ifAt).toBeGreaterThanOrEqual(0);
    expect(thenAt).toBeGreaterThan(ifAt);
    expect(enrichAt).toBeGreaterThan(thenAt);
    expect(elseAt).toBeGreaterThan(enrichAt);
    // `set -e` would carry a subshell's exit 65 out anyway, so this is checked
    // on the text: the branch must not open a group of its own.
    const branch = body.slice(thenAt + "); then".length, elseAt);
    expect(branch, "no subshell opens inside the branch").not.toMatch(/^\s*\(|^\s*\)\s*$/m);
  });

  enrichCases(run, "warning: enrich exited");

  it("keeps today's warning, and runs no enrich, when the install fails", () => {
    const ran = run({ STUB_CURL_RC: "22", GRIM_INDEX_PURGE: "x" });

    expect(ran.code, ran.output).toBe(0);
    expect(ran.output).toContain("warning: enrich failed - building without READMEs, logos and version lists");
    expect(ran.calls.filter((call) => call.startsWith("npm:"))).toEqual([]);
    expect(ran.output).toContain("AFTER");
  });
});
