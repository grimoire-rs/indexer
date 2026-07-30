// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Grimoire Authors

// The CI renderer: `index.config.json`'s `ci` block in, complete workflow
// files out. The index repository owns and commits what it runs — there is no
// reusable workflow to call, no remote include to fetch, and nothing about the
// pipeline that lives anywhere but in the repository being pushed.
//
// The trade that buys is the drift guard: because the files are generated,
// `grim-indexer ci --check` can re-render and diff, and the generated
// `verify-ci` job runs exactly that on every push and pull request. So a
// hand-edit is caught rather than silently forked, while the repository keeps
// full ownership of its own CI — set `allowManualEdits` and the guard is not
// emitted at all.
import fs from "node:fs/promises";
import path from "node:path";

import { CliError, EXIT } from "./cli/exit.js";
import { CONFIG_FILE, SiteConfigError } from "./config.js";
import { fromTemplate } from "./templates.js";

/**
 * Forges CI can be rendered for. One repository is hosted on one forge, so
 * this is a choice rather than a set — rendering both left every index with a
 * pipeline it would never run, and a second gate to keep honest for nothing.
 */
export type Forge = "github" | "gitlab";

const FORGES: readonly Forge[] = ["github", "gitlab"];

/**
 * The `ci` block of `index.config.json` — everything that varies the
 * generated pipeline. Every key is optional; [`resolveCi`] fills the gaps.
 */
export interface CiConfig {
  /** Which forge's CI to render. Default `github`. */
  forge?: Forge;
  /** Node.js the jobs run on — `setup-node` version, and the GitLab image tag. Default `22`. */
  nodeVersion?: string;
  /**
   * Refresh READMEs, changelogs, logos and version lists from the registry
   * before building. `false` renders the enrichment steps away entirely, for
   * a pointers-only site whose build never leaves the runner. Default `true`.
   */
  enrich?: boolean;
  /** grim release the enrichment step reads the registry with — `latest` or a tag. Default `latest`. */
  grimVersion?: string;
  /**
   * Squash-merge a pull request the gate passed, then deploy. Default `false`:
   * merging an untrusted contribution unattended is a policy this package will
   * not assume on a repository's behalf.
   *
   * GitHub only, and deliberately. GitHub always runs the base branch's copy
   * of a `pull_request_target` workflow, so the gate a pull request faces is
   * one it cannot edit. GitLab has no equivalent — the merge request supplies
   * its own `.gitlab-ci.yml`, and a fork's pipeline runs in the fork — so an
   * auto-merge there would act on a verdict the contributor could write.
   */
  autoMerge?: boolean;
  /**
   * Own these files by hand. The `verify-ci` drift guard is then not emitted,
   * `ci --check` is the only thing left that would notice an edit, and CI
   * fixes stop arriving by re-render. Discouraged, and deliberately not the
   * default — but it is the repository's CI, so it is the repository's call.
   */
  allowManualEdits?: boolean;
}

export type ResolvedCiConfig = Required<CiConfig>;

/** Fill every gap from the defaults documented on [`CiConfig`]. */
export function resolveCi(ci: CiConfig | undefined): ResolvedCiConfig {
  return {
    forge: ci?.forge ?? "github",
    nodeVersion: ci?.nodeVersion ?? "22",
    enrich: ci?.enrich ?? true,
    grimVersion: ci?.grimVersion ?? "latest",
    allowManualEdits: ci?.allowManualEdits ?? false,
    autoMerge: ci?.autoMerge ?? false,
  };
}

function fail(msg: string): never {
  throw new SiteConfigError(`${CONFIG_FILE}: ci.${msg}`);
}

/** Validate the `ci` block of an already-parsed config object. */
export function validateCi(raw: unknown): CiConfig {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new SiteConfigError(`${CONFIG_FILE}: ci must be an object`);
  }
  const ci = raw as Record<string, unknown>;

  if (ci.forge !== undefined && !FORGES.includes(ci.forge as Forge)) {
    fail(`forge must be one of ${FORGES.join(", ")}`);
  }
  // These land inside a double-quoted shell word or a docker image tag in the
  // generated YAML. The repository owner writes this file, so it is a paste
  // guard rather than a trust boundary — but a value carrying a quote or a `$`
  // would rewrite the command around it, and no version string needs either.
  for (const key of ["nodeVersion", "grimVersion"]) {
    const value = ci[key];
    if (value !== undefined && typeof value !== "string") fail(`${key} must be a string`);
    if (typeof value === "string" && !/^[\w.@^~><=* +-]+$/.test(value)) {
      fail(`${key} must be a plain version or range`);
    }
  }
  for (const key of ["enrich", "allowManualEdits", "autoMerge"]) {
    if (ci[key] !== undefined && typeof ci[key] !== "boolean") fail(`${key} must be a boolean`);
  }
  // Refused rather than ignored. Rendering GitLab CI while the config asks for
  // auto-merge would leave a repository believing contributions land by
  // themselves, and the honest answer is that they cannot be made to safely
  // there — see the field's doc comment.
  if (ci.autoMerge === true && ci.forge === "gitlab") {
    fail("autoMerge is github-only - the GitLab gate cannot be made tamper-proof");
  }

  return ci as CiConfig;
}

/** Read the `ci` block out of `index.config.json`. A missing file means defaults. */
export async function loadCiConfig(root: string): Promise<CiConfig> {
  let text: string;
  try {
    text = await fs.readFile(path.join(root, CONFIG_FILE), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch (err) {
    throw new SiteConfigError(`${CONFIG_FILE}: ${(err as Error).message}`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new SiteConfigError(`${CONFIG_FILE}: must contain a JSON object`);
  }
  return validateCi((parsed as Record<string, unknown>).ci);
}

// ── Rendering ────────────────────────────────────────────────────────────────

/**
 * First line of every file this renderer writes. Stale detection keys on it,
 * so a repository's hand-written workflows are never mistaken for ours.
 *
 * Deliberately carries no version stamp. The version that renders these files
 * is the one in the repository's own `package-lock.json`; stamping it here too
 * would be a second copy that goes stale, and every dependency bump would red
 * the drift guard until somebody re-rendered a file whose content had not
 * changed.
 */
export const GENERATED_HEADER = "# Generated by @grimoire-rs/indexer";

/**
 * What CI scaffolded by a pre-header release (<= 0.2.2) looks like: a thin
 * caller pointing back at this package's reusable workflow, or a GitLab
 * remote include of the same. Those files carry no generated header, so
 * without this the reaper was blind to exactly the repositories that most
 * need telling — an index scaffolded with the old `--forge both` resolves to
 * `forge: "github"` today (its config has no `ci` block at all) and would
 * keep serving an orphaned `.gitlab-ci.yml` with nothing to say so.
 */
const LEGACY_SIGNATURE =
  /uses:\s*grimoire-rs\/indexer\/\.github\/workflows\/|raw\.githubusercontent\.com\/grimoire-rs\/indexer\//;

/** Where each forge's files land. */
const GITHUB_FILES = {
  pages: ".github/workflows/pages.yml",
  validate: ".github/workflows/validate.yml",
  verify: ".github/workflows/verify-ci.yml",
} as const;

const GITLAB_FILE = ".gitlab-ci.yml";

/**
 * Where the grim release tarball is fetched from. `latest` has its own URL
 * shape on GitHub releases; anything else is a tag. Resolving it here rather
 * than in the generated shell is the point of rendering CI from config: a
 * value that is fixed at render time should not be a branch at run time.
 */
function grimReleaseBase(grimVersion: string): string {
  const releases = "https://github.com/grimoire-rs/grimoire/releases";
  return grimVersion === "latest"
    ? `${releases}/latest/download`
    : `${releases}/download/${grimVersion}`;
}

/**
 * `paths:` entries that must re-run the drift guard — every file it renders,
 * plus the config they are rendered from. `package-lock.json` is in there
 * because the lock is what decides which renderer produces them.
 */
const VERIFY_PATHS = [CONFIG_FILE, "package.json", "package-lock.json", ".github/workflows/**"];

/**
 * Render the complete CI file set. Nothing touches disk — the caller writes
 * it or diffs it against what is committed.
 */
export function renderCi(ci: ResolvedCiConfig): Map<string, string> {
  const base: Record<string, string> = {
    nodeVersion: ci.nodeVersion,
    grimVersion: ci.grimVersion,
    grimReleaseBase: grimReleaseBase(ci.grimVersion),
  };
  // Rendered first: `render` is single-pass, so a block handed in as a value
  // must already have its own placeholders resolved. The trailing newline is
  // trimmed because the template supplies one on the placeholder's own line —
  // keeping both would leave a stray blank line, or an empty block would not.
  const block = (rel: string) => fromTemplate(rel, base).replace(/\n$/, "");
  const vars: Record<string, string> = {
    ...base,
    header: fromTemplate("ci/header.txt", base),
    githubEnrichSteps: ci.enrich ? block("ci/github-enrich.yml") : "",
    gitlabEnrichScript: ci.enrich ? block("ci/gitlab-enrich.sh") : "",
    verifyPaths: VERIFY_PATHS.map((entry) => `      - ${entry}`).join("\n"),
    gitlabVerifyJob: ci.allowManualEdits ? "" : block("ci/gitlab-verify.yml"),
    // GitHub only — `validateCi` refuses the GitLab combination outright, so
    // there is no silently-inert case to render around here.
    githubAutoMergeJob: ci.autoMerge ? block("ci/github-automerge.yml") : "",
  };

  // Exactly one trailing newline, whatever the placeholders resolved to. An
  // optional block that renders empty at the end of a file otherwise leaves
  // its own blank line behind, so the same config produced two shapes.
  const file = (rel: string) => fromTemplate(rel, vars).replace(/\n*$/, "\n");

  const files = new Map<string, string>();
  if (ci.forge === "github") {
    files.set(GITHUB_FILES.pages, file("ci/github-pages.yml"));
    files.set(GITHUB_FILES.validate, file("ci/github-validate.yml"));
    if (!ci.allowManualEdits) {
      files.set(GITHUB_FILES.verify, file("ci/github-verify-ci.yml"));
    }
  } else {
    files.set(GITLAB_FILE, file("ci/gitlab-ci.yml"));
  }
  return files;
}

/**
 * Canonicalize a generated file for drift comparison.
 *
 * The index repository owns the *pin* on every `uses:` action reference —
 * its own Renovate or Dependabot will bump `uses: owner/action@<ref>  # vX`,
 * and the guard must not read that as a hand-edit. Only the `@<ref>` suffix
 * and any trailing version comment are stripped; `owner/action` survives, so
 * swapping in a different action still trips drift.
 */
export function normalizeForDrift(content: string): string {
  // Line endings first. Git for Windows installs with `core.autocrlf=true` by
  // default, so an untouched clone has CRLF on disk while the renderer emits
  // LF — every generated file read as drift, and `npm run ci` could not clear
  // it because the rewrite was LF too. The scaffold ships a `.gitattributes`
  // that prevents it; this unsticks the checkouts that already have it.
  return content
    .replace(/\r\n/g, "\n")
    .replace(/^([ \t]*(?:-[ \t]+)?uses:[ \t]*[^@\s]+)@[^\s#]+(?:[ \t]*#[^\n]*)?$/gm, "$1");
}

/**
 * Files on disk that carry our header but that the current config no longer
 * renders — a `forge` narrowed from `both`, or `allowManualEdits` turned on
 * after a guard was already committed. Reported, never deleted: removing a
 * file from somebody's repository is their call, not the renderer's.
 */
export async function staleCi(root: string, files: Map<string, string>): Promise<string[]> {
  const candidates: string[] = [GITLAB_FILE];
  try {
    for (const entry of await fs.readdir(path.join(root, ".github/workflows"))) {
      if (/\.ya?ml$/.test(entry)) candidates.push(`.github/workflows/${entry}`);
    }
  } catch {
    /* no workflows directory — nothing of ours can be stale in it */
  }

  const stale: string[] = [];
  for (const relative of candidates) {
    if (files.has(relative)) continue;
    const content = await fs.readFile(path.join(root, relative), "utf8").catch(() => null);
    if (content === null) continue;
    if (content.startsWith(GENERATED_HEADER) || LEGACY_SIGNATURE.test(content)) {
      stale.push(relative);
    }
  }
  return stale.sort();
}

export interface CiOutcome {
  path: string;
  /** `written` on a render; `drift`/`stale`/`ok` on a check. */
  status: "written" | "unchanged" | "ok" | "drift" | "stale";
}

/**
 * Write the rendered set, overwriting whatever is there.
 *
 * "Whatever is there" is judged through [`normalizeForDrift`], the same lens
 * the guard uses — not raw bytes. Otherwise the two disagreed: `ci --check`
 * deliberately tolerates a bumped `uses: owner/action@<ref>`, while a plain
 * `npm run ci` rewrote it back to the pin baked into this package, silently
 * undoing every Renovate bump the repository is told it may make. The repo
 * owns its pins; a render must not take them back.
 */
export async function writeCi(root: string, files: Map<string, string>): Promise<CiOutcome[]> {
  const outcomes: CiOutcome[] = [];
  for (const [relative, content] of files) {
    const abs = path.join(root, relative);
    const current = await fs.readFile(abs, "utf8").catch(() => null);
    if (current !== null && normalizeForDrift(current) === normalizeForDrift(content)) {
      outcomes.push({ path: relative, status: "unchanged" });
      continue;
    }
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, content);
    outcomes.push({ path: relative, status: "written" });
  }
  return outcomes;
}

/**
 * Compare the rendered set against what is committed. Missing counts as
 * drift; a generated file the config no longer renders counts as stale.
 * Hints are path-only — the contents of a repository's CI never go to stderr.
 */
export async function checkCi(root: string, files: Map<string, string>): Promise<CiOutcome[]> {
  const outcomes: CiOutcome[] = [];
  for (const [relative, expected] of files) {
    const actual = await fs.readFile(path.join(root, relative), "utf8").catch(() => null);
    const same = actual !== null && normalizeForDrift(actual) === normalizeForDrift(expected);
    outcomes.push({ path: relative, status: same ? "ok" : "drift" });
  }
  for (const relative of await staleCi(root, files)) {
    outcomes.push({ path: relative, status: "stale" });
  }
  return outcomes;
}

/**
 * The re-render command a drift message tells the reader to run. It is the
 * repository's own npm script, so it runs the renderer the lock pins rather
 * than whatever `npx` would fetch today.
 */
export const RE_RENDER_COMMAND = "npm run ci";

/** Turn a failed check into the error the CLI exits on. */
export function driftError(outcomes: CiOutcome[]): CliError {
  const bad = outcomes.filter((outcome) => outcome.status !== "ok");
  return new CliError(
    `${bad.length} generated CI file(s) do not match ${CONFIG_FILE} — ` +
      `re-run \`${RE_RENDER_COMMAND}\` and commit the result`,
    EXIT.data,
  );
}
