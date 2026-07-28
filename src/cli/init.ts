// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Grimoire Authors

// `grim-indexer init` — scaffold an index repo, following the UX of
// Microsoft's `yo code` (prompt, write, tell the user what to do next) but
// none of its runtime: the wizard is @clack/prompts, there is no Yeoman.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import * as prompts from "@clack/prompts";

import { CliError, EXIT, type ExitCode } from "./exit.js";

/** Scaffold templates ship beside `dist/`, so this resolves identically from `src/cli/` and `dist/cli/`. */
const TEMPLATE_DIR = fileURLToPath(new URL("../../templates/", import.meta.url));

/** `{{name}}`, but never GitHub Actions' `${{ ... }}` — hence the `$` lookbehind. */
const PLACEHOLDER = /(?<!\$)\{\{\s*([A-Za-z_]\w*)\s*\}\}/g;

const NAME_RE = /^[a-z0-9][a-z0-9._-]*$/;

/**
 * What `[announce]` gets when nothing knew this repo's URL. It is not a
 * locator, so `grim publish --announce` fails on it before any network call —
 * which is the point: the alternative is grim's own default, the public
 * first-party index, and announcing into a stranger's repo by accident.
 */
const UNDERIVED = "REPLACE-ME";

/** GitHub/GitLab Pages hosts — the URL of a Pages site names the repo serving it. */
const PAGES_HOST = /^([\w-]+)\.(github|gitlab)\.io$/;

/** scp-like `[user@]host:owner/repo` — the one git remote shape that is not a URL. */
const SCP_REMOTE = /^(?:[^@/]+@)?([\w.-]+):(?!\/)(.+)$/;

export type Forge = "github" | "gitlab" | "both";

/** Everything `init` needs to render the scaffold. Flags and prompts both resolve into this. */
export interface InitAnswers {
  name: string;
  title: string;
  baseUrl: string;
  registryAlias: string;
  registryHost: string;
  logo: string;
  forge: Forge;
  git: boolean;
  withSkills: boolean;
  /** This repo's own https URL — the announce target. `""` when nothing could derive it. */
  repoUrl: string;
}

/** Raw `init` flags, straight off commander. */
export interface InitFlags {
  quick?: boolean;
  name?: string;
  title?: string;
  baseUrl?: string;
  registry?: string;
  registryHost?: string;
  logo?: string;
  forge?: Forge;
  git?: boolean;
  withSkills?: boolean;
  repoUrl?: string;
  force?: boolean;
}

/** What happened to one scaffolded file. */
export type FileOutcome = "created" | "overwritten" | "unchanged" | "skipped";

export interface InitResult {
  dir: string;
  files: Array<{ path: string; outcome: FileOutcome }>;
  gitInitialized: boolean;
}

function slug(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function titleCase(name: string): string {
  return name
    .split(/[-_.]+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

function readTemplate(rel: string): string {
  const file = path.join(TEMPLATE_DIR, rel);
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    throw new CliError(
      `scaffold template ${rel} is missing from ${TEMPLATE_DIR} — the installed package is incomplete`,
      EXIT.unavailable,
    );
  }
}

function render(template: string, vars: Record<string, string>, rel: string): string {
  return template.replace(PLACEHOLDER, (match, key: string) => {
    if (!(key in vars)) {
      throw new CliError(`scaffold template ${rel} references unknown placeholder {{${key}}}`);
    }
    return vars[key] as string;
  });
}

/** Validate a URL the user typed. Returns the reason it is bad, or `null`. */
function badUrl(value: string): string | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return "must be an absolute URL, e.g. https://index.example.com";
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return "must be an http(s) URL";
  }
  return null;
}

function badName(value: string): string | null {
  if (!NAME_RE.test(value)) {
    return "must be lowercase, start alphanumeric, and contain only a-z 0-9 . _ -";
  }
  return null;
}

/**
 * The target dir's `origin` remote as an https URL — set when the repo was
 * created on the forge and cloned before scaffolding into it. Any remote
 * shape (https, ssh, scp-like) reduces to the https form `[announce]` wants.
 */
function gitRemoteUrl(dir: string): string | undefined {
  let remote: string;
  try {
    remote = execFileSync("git", ["-C", dir, "remote", "get-url", "origin"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return undefined; // no git, no repo, or no `origin`
  }

  const bare = remote.replace(/\.git$/, "");
  const scp = SCP_REMOTE.exec(bare);
  if (scp) return `https://${scp[1]}/${scp[2]}`;
  try {
    const url = new URL(bare);
    // `url.host` drops the userinfo, so a token in the remote never survives.
    if (["https:", "http:", "ssh:", "git:"].includes(url.protocol)) {
      return `https://${url.host}${url.pathname}`;
    }
  } catch {
    /* a `file://` or otherwise unmappable remote — nothing to announce into */
  }
  return undefined;
}

/**
 * The forge repo behind a Pages base URL: `https://acme.github.io/idx` is
 * served from `github.com/acme/idx`, and a Pages root (`https://acme.github.io`)
 * from the repo named after the host itself. Only the first path segment is
 * read, so a nested GitLab group needs the URL corrected by hand.
 */
function repoUrlFromPages(baseUrl: string): string | undefined {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    return undefined;
  }
  const pages = PAGES_HOST.exec(url.hostname);
  if (!pages) return undefined;

  const project = url.pathname.split("/").filter(Boolean)[0] ?? url.hostname;
  return `https://${pages[2]}.com/${pages[1]}/${project}`;
}

/**
 * The `index/<host>/<namespace>/` this repo's entries land under: its path
 * minus the repo itself — one segment on GitHub, possibly nested on GitLab.
 */
function announceNamespace(repoUrl: string): string | undefined {
  let segments: string[];
  try {
    segments = new URL(repoUrl).pathname.split("/").filter(Boolean);
  } catch {
    return undefined;
  }
  return segments.length > 1 ? segments.slice(0, -1).join("/") : undefined;
}

/**
 * Resolve flags into a complete answer set, prompting for whatever is
 * missing. `--quick` never prompts, so CI and tests get a deterministic
 * tree from flags alone.
 */
async function resolveAnswers(dir: string, flags: InitFlags): Promise<InitAnswers> {
  const defaultName = slug(path.basename(path.resolve(dir))) || "my-index";

  // Flags always win, and any flag value is validated whether or not a
  // prompt would have caught it — `--quick` skips the prompt, not the check.
  for (const [flag, value, check] of [
    ["--name", flags.name, badName],
    ["--registry", flags.registry, badName],
    ["--base-url", flags.baseUrl, badUrl],
    ["--repo-url", flags.repoUrl, badUrl],
  ] as const) {
    if (value !== undefined) {
      const reason = check(value);
      if (reason) throw new CliError(`${flag} ${JSON.stringify(value)}: ${reason}`, EXIT.data);
    }
  }

  if (flags.quick) {
    const name = flags.name ?? defaultName;
    const baseUrl = flags.baseUrl ?? "http://localhost:4321";
    const withSkills = flags.withSkills ?? false;
    return {
      name,
      title: flags.title ?? titleCase(name),
      baseUrl,
      registryAlias: flags.registry ?? name,
      registryHost: flags.registryHost ?? "ghcr.io",
      logo: flags.logo ?? "",
      forge: flags.forge ?? "github",
      git: flags.git ?? true,
      withSkills,
      // Only the combined layout writes an announce target, so only it pays
      // for the derivation. An empty answer stays empty — a guessed index
      // repo is worse than a placeholder that refuses to publish.
      repoUrl: withSkills
        ? (flags.repoUrl ?? gitRemoteUrl(dir) ?? repoUrlFromPages(baseUrl) ?? "")
        : "",
    };
  }

  prompts.intro("grim-indexer — new package index");

  const name =
    flags.name ??
    (await ask(
      prompts.text({
        message: "Index name (used as the identifier)",
        placeholder: defaultName,
        defaultValue: defaultName,
        validate: (value) => badName(value || defaultName) ?? undefined,
      }),
    ));

  const title =
    flags.title ??
    (await ask(
      prompts.text({
        message: "Display title",
        placeholder: titleCase(name),
        defaultValue: titleCase(name),
      }),
    ));

  const baseUrl =
    flags.baseUrl ??
    (await ask(
      prompts.text({
        message: "Base URL the index is served from",
        placeholder: "https://index.example.com",
        validate: (value) => badUrl(value ?? "") ?? undefined,
      }),
    ));

  // Asked only for the combined layout — the standalone one writes no
  // `publish.toml` and so announces nothing.
  const derivedRepoUrl = gitRemoteUrl(dir) ?? repoUrlFromPages(baseUrl);
  const repoUrl = !flags.withSkills
    ? ""
    : (flags.repoUrl ??
      (await ask(
        prompts.text({
          message: "Repository URL this index lives in (`grim publish --announce` targets it)",
          placeholder: derivedRepoUrl ?? "https://github.com/you/your-index",
          defaultValue: derivedRepoUrl ?? "",
          // Blank is allowed: it writes a placeholder that refuses to publish,
          // which beats forcing a URL the user does not have yet.
          validate: (value) => (value ? (badUrl(value) ?? undefined) : undefined),
        }),
      )));

  const registryAlias =
    flags.registry ??
    (await ask(
      prompts.text({
        message: "Registry alias packages are published under",
        placeholder: name,
        defaultValue: name,
        validate: (value) => badName(value || name) ?? undefined,
      }),
    ));

  const logo =
    flags.logo ??
    (await ask(
      prompts.text({
        message: "Brand logo (path or URL, blank for none)",
        defaultValue: "",
      }),
    ));

  const forge =
    flags.forge ??
    (await ask(
      prompts.select<Forge>({
        message: "CI to scaffold",
        options: [
          { value: "github", label: "GitHub Actions" },
          { value: "gitlab", label: "GitLab CI" },
          { value: "both", label: "Both" },
        ],
        initialValue: "github",
      }),
    ));

  const git =
    flags.git ??
    (await ask(prompts.confirm({ message: "Initialize a git repository?", initialValue: true })));

  return {
    name,
    title,
    baseUrl,
    registryAlias,
    registryHost: flags.registryHost ?? "ghcr.io",
    logo,
    forge,
    git,
    withSkills: flags.withSkills ?? false,
    repoUrl,
  };
}

/** Unwrap a clack prompt, turning Ctrl-C into a clean non-error abort. */
async function ask<T>(pending: Promise<T | symbol>): Promise<T> {
  const value = await pending;
  if (prompts.isCancel(value)) {
    prompts.cancel("Cancelled — nothing written.");
    throw new CliError("cancelled", EXIT.ok);
  }
  return value as T;
}

function json(value: unknown): string {
  return JSON.stringify(value, null, 2) + "\n";
}

/**
 * `index.config.json`, in the shape `loadConfig` validates. Every
 * key is optional there, so an unanswered prompt omits its key rather than
 * writing an empty string the validator would reject.
 */
function siteConfig(answers: InitAnswers): string {
  return json({
    site: answers.baseUrl,
    brand: answers.title,
    description: `${answers.title} — a Grimoire package index.`,
    ...(answers.logo ? { favicon: answers.logo } : {}),
    registry: { alias: answers.registryAlias, index: answers.baseUrl },
  });
}

/**
 * `index-policy.json` — the committed allowlist the contribution gate reads.
 * `registryHosts` bounds which registries an entry may point at (empty or
 * absent means any public DNS host); `reservedNamespaces` are refused before
 * any network call; `trustedBots` names accounts allowed to announce for a
 * namespace they do not own — prefer the object form, `{ login, id,
 * namespaces }`, since a bare string pins no account id and scopes nothing.
 */
function indexPolicy(answers: InitAnswers): string {
  return json({
    version: 1,
    registryHosts: [answers.registryHost],
    reservedNamespaces: ["grim", "grimoire", "index"],
    trustedBots: [],
  });
}

/** The complete scaffold as (destination path, content) pairs — nothing touches disk yet. */
function plan(answers: InitAnswers, version: string): Array<{ path: string; content: string }> {
  const vars: Record<string, string> = {
    name: answers.name,
    title: answers.title,
    baseUrl: answers.baseUrl,
    registryAlias: answers.registryAlias,
    registryHost: answers.registryHost,
    logo: answers.logo,
    announceRepo: answers.repoUrl || UNDERIVED,
    announceNamespace: (answers.repoUrl && announceNamespace(answers.repoUrl)) || UNDERIVED,
    version,
    // The reusable workflows are pinned by tag; Renovate's `github-actions`
    // manager bumps this in every scaffolded repo.
    ref: `v${version}`,
  };

  const from = (rel: string, dest: string) => ({
    path: dest,
    content: render(readTemplate(rel), vars, rel),
  });

  const files = [
    { path: "index/.gitkeep", content: "" },
    { path: "index.config.json", content: siteConfig(answers) },
    { path: "index-policy.json", content: indexPolicy(answers) },
    from("gitignore", ".gitignore"),
    from("README.md", "README.md"),
  ];

  if (answers.forge === "github" || answers.forge === "both") {
    files.push(from("github-pages.yml", ".github/workflows/pages.yml"));
    files.push(from("github-validate.yml", ".github/workflows/validate.yml"));
  }
  if (answers.forge === "gitlab" || answers.forge === "both") {
    files.push(from("gitlab-ci.yml", ".gitlab-ci.yml"));
  }
  if (answers.withSkills) {
    files.push({ path: "skills/.gitkeep", content: "" });
    files.push(from("publish.toml", "publish.toml"));
  }

  return files;
}

/**
 * Write the scaffold. Re-running is safe: a file whose content already
 * matches is reported `unchanged`, and one the user has edited is left
 * alone as `skipped` unless `--force`.
 */
function write(
  dir: string,
  files: Array<{ path: string; content: string }>,
  force: boolean,
): InitResult["files"] {
  const written: InitResult["files"] = [];

  for (const file of files) {
    const abs = path.join(dir, file.path);
    let outcome: FileOutcome;

    if (fs.existsSync(abs)) {
      if (fs.readFileSync(abs, "utf8") === file.content) {
        written.push({ path: file.path, outcome: "unchanged" });
        continue;
      }
      if (!force) {
        written.push({ path: file.path, outcome: "skipped" });
        continue;
      }
      outcome = "overwritten";
    } else {
      outcome = "created";
    }

    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, file.content);
    written.push({ path: file.path, outcome });
  }

  return written;
}

function initGit(dir: string): boolean {
  if (fs.existsSync(path.join(dir, ".git"))) return false;
  try {
    execFileSync("git", ["init", "-b", "main"], { cwd: dir, stdio: "ignore" });
    return true;
  } catch {
    console.error("warning: `git init` failed — initialize the repository yourself");
    return false;
  }
}

function nextSteps(result: InitResult, answers: InitAnswers): string {
  const rel = path.relative(process.cwd(), result.dir);
  // A relative path that climbs out of the working directory is worse than
  // the absolute one it was derived from.
  const target = rel === "" ? "" : rel.startsWith("..") ? result.dir : rel;
  const cd = target === "" ? "" : `cd ${target}\n`;
  const steps = [
    "Add packages under index/<namespace>/<package>/metadata.json",
    "Push to your forge — CI builds and publishes the site",
  ];
  if (answers.baseUrl === "http://localhost:4321") {
    steps.push("Set baseUrl in index.config.json to the real site URL");
  }
  if (answers.withSkills && !answers.repoUrl) {
    steps.push(
      `Set [announce] repository + namespace in publish.toml — both are ${UNDERIVED}, ` +
        "and `grim publish --announce` refuses to run until they name this repo",
    );
  }
  return [
    `${cd}npx @grimoire-rs/indexer build`,
    "",
    "Then:",
    ...steps.map((step, i) => `  ${i + 1}. ${step}`),
  ].join("\n");
}

export async function init(dir: string, flags: InitFlags, version: string): Promise<ExitCode> {
  const target = path.resolve(dir);
  const answers = await resolveAnswers(target, flags);

  fs.mkdirSync(target, { recursive: true });
  const files = write(target, plan(answers, version), flags.force ?? false);
  const gitInitialized = answers.git ? initGit(target) : false;
  const result: InitResult = { dir: target, files, gitInitialized };

  for (const file of files) {
    console.log(`  ${file.outcome.padEnd(12)}${file.path}`);
  }

  const skipped = files.filter((f) => f.outcome === "skipped");
  if (skipped.length > 0) {
    console.error(
      `\n${skipped.length} file(s) differ from the scaffold and were left alone. ` +
        `Re-run with --force to overwrite them.`,
    );
  }

  prompts.note(nextSteps(result, answers), "Next steps");
  prompts.outro(`Index "${answers.name}" ready in ${target}`);
  return EXIT.ok;
}
