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
  ] as const) {
    if (value !== undefined) {
      const reason = check(value);
      if (reason) throw new CliError(`${flag} ${JSON.stringify(value)}: ${reason}`, EXIT.data);
    }
  }

  if (flags.quick) {
    const name = flags.name ?? defaultName;
    return {
      name,
      title: flags.title ?? titleCase(name),
      baseUrl: flags.baseUrl ?? "http://localhost:4321",
      registryAlias: flags.registry ?? name,
      registryHost: flags.registryHost ?? "ghcr.io",
      logo: flags.logo ?? "",
      forge: flags.forge ?? "github",
      git: flags.git ?? true,
      withSkills: flags.withSkills ?? false,
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
  const lines = [
    `${cd}npx @grimoire-rs/indexer build`,
    "",
    "Then:",
    "  1. Add packages under index/<namespace>/<package>/metadata.json",
    "  2. Push to your forge — CI builds and publishes the site",
  ];
  if (answers.baseUrl === "http://localhost:4321") {
    lines.push("  3. Set baseUrl in index.config.json to the real site URL");
  }
  return lines.join("\n");
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
