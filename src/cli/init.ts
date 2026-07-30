// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Grimoire Authors

// `grim-indexer init` — scaffold an index repo, following the UX of
// Microsoft's `yo code` (prompt, write, tell the user what to do next) but
// none of its runtime: the wizard is @clack/prompts, there is no Yeoman.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import * as prompts from "@clack/prompts";

import { loadCiConfig, renderCi, resolveCi, staleCi, type CiConfig, type Forge } from "../ci.js";
import { CONFIG_FILE } from "../config.js";
import { fromTemplate } from "../templates.js";
import { CliError, EXIT, type ExitCode } from "./exit.js";

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

export type { Forge };

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
  install: boolean;
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
  install?: boolean;
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
  /** Whether `npm install` ran and wrote a lock. */
  installed: boolean;
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

/** What `SiteConfig.logo` accepts — checked here so a typo fails now, not at build time. */
function badLogo(value: string): string | null {
  if (value === "" || /^(\/|https?:\/\/)/i.test(value)) return null;
  return "must be a site-root path (/logo.svg) or an http(s) URL";
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
  return normalizeRepoUrl(remote);
}

/**
 * Reduce any repository URL to the https form the rest of this file derives
 * from: Pages URL, forge, announce target and the site's own header link.
 *
 * Applied to `--repo-url` as well as to the git remote, because the obvious
 * thing to paste into it is GitHub's clone box — `https://github.com/acme/idx.git`
 * — and used verbatim that trailing `.git` became `https://acme.github.io/idx.git`
 * as `site`, hence `/idx.git` as Astro's `base`, on a Pages deployment that
 * serves `/idx`. Every link on the built site pointed one path segment wrong.
 */
function normalizeRepoUrl(remote: string): string | undefined {
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
 * Say out loud what was read off the git remote, and what could not be.
 *
 * Everything below is inferred rather than asked, and an inference nobody
 * sees is one nobody checks — a wrong `site` is only noticed once the deploy
 * serves 404s from a subpath that does not exist. The silences matter as much
 * as the hits: a self-hosted forge can serve Pages from anywhere, so there is
 * no URL to guess, and an unrecognised host is not evidence of GitHub.
 */
function reportDerivation(what: {
  remoteUrl: string | undefined;
  fromRemote: boolean;
  baseUrl: string | undefined;
  forge: Forge | undefined;
  forgeFallback: boolean;
}): void {
  const say = (label: string, value: string) => console.log(`  ${label.padEnd(12)}${value}`);

  if (!what.remoteUrl) {
    say("no remote", "nothing to derive - set `site` in index.config.json yourself");
    return;
  }
  say(what.fromRemote ? "from origin" : "repository", what.remoteUrl);
  if (what.forge) say("forge", what.forge);
  if (what.forgeFallback) {
    say("forge", "github (the host is neither github nor gitlab - pass --forge)");
  }
  if (what.baseUrl) {
    say("site", what.baseUrl);
  } else {
    say("site", "not derivable from this host - set `site` in index.config.json");
  }
}

/**
 * Which forge hosts `repoUrl`. Read off the host, so a self-hosted
 * `gitlab.example.com` or `github.acme.internal` lands on the right pipeline
 * without anyone having to answer a question about it. Anything unrecognised
 * returns `undefined` and the prompt asks.
 */
function forgeFromRepoUrl(repoUrl: string): Forge | undefined {
  let host: string;
  try {
    host = new URL(repoUrl).hostname.toLowerCase();
  } catch {
    return undefined;
  }
  if (host === "github.com" || host.startsWith("github.")) return "github";
  if (host === "gitlab.com" || host.startsWith("gitlab.")) return "gitlab";
  return undefined;
}

/**
 * The Pages URL a forge serves `repoUrl` from — the inverse of
 * [`repoUrlFromPages`], and the reason nobody has to know their own Pages URL
 * to scaffold an index.
 *
 * `github.com/acme/idx` -> `https://acme.github.io/idx`, and the repository
 * *named after* the Pages host is served from its root rather than a
 * subpath. GitLab keeps everything below the top-level group in the path, so
 * `gitlab.com/acme/team/idx` -> `https://acme.gitlab.io/team/idx`.
 *
 * Only the two public hosts are answered. A self-hosted instance can serve
 * Pages from anywhere, and a custom domain is a fact this command cannot
 * observe — both are why the value is a prompt default and not a decision.
 */
function pagesUrlFromRepo(repoUrl: string): string | undefined {
  let url: URL;
  try {
    url = new URL(repoUrl);
  } catch {
    return undefined;
  }
  const host = url.hostname.toLowerCase();
  const forge = host === "github.com" ? "github" : host === "gitlab.com" ? "gitlab" : undefined;
  if (!forge) return undefined;

  const segments = url.pathname.split("/").filter(Boolean);
  if (segments.length < 2) return undefined;
  const pagesHost = `${segments[0]}.${forge}.io`.toLowerCase();
  const project = segments.slice(1).join("/");
  return project.toLowerCase() === pagesHost
    ? `https://${pagesHost}`
    : `https://${pagesHost}/${project}`;
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
    ["--logo", flags.logo, badLogo],
  ] as const) {
    if (value !== undefined) {
      const reason = check(value);
      if (reason) throw new CliError(`${flag} ${JSON.stringify(value)}: ${reason}`, EXIT.data);
    }
  }

  // The git remote is the one thing a cloned-then-scaffolded repo already
  // knows about itself, and everything else falls out of it: which forge runs
  // the CI, where Pages will serve the site, and what `--announce` targets. A
  // `--repo-url` overrides it, for scaffolding before the remote exists.
  const remoteUrl = flags.repoUrl ? normalizeRepoUrl(flags.repoUrl) : gitRemoteUrl(dir);
  const derivedBaseUrl = remoteUrl ? pagesUrlFromRepo(remoteUrl) : undefined;
  const derivedForge = remoteUrl ? forgeFromRepoUrl(remoteUrl) : undefined;

  if (flags.quick) {
    const name = flags.name ?? defaultName;
    // Falls back to localhost rather than a guess: `--quick` is the
    // non-interactive path, and a wrong absolute URL is worse than an obvious
    // placeholder the next step tells you to replace.
    const baseUrl = flags.baseUrl ?? derivedBaseUrl ?? "http://localhost:4321";
    // `--quick` asks nothing, so every one of these decisions is otherwise
    // invisible — including the two that quietly did not happen: a self-hosted
    // forge has no predictable Pages URL, and an unrecognised host falls back
    // to GitHub Actions rather than guessing.
    reportDerivation({
      remoteUrl,
      fromRemote: flags.repoUrl === undefined && remoteUrl !== undefined,
      baseUrl: flags.baseUrl === undefined ? derivedBaseUrl : undefined,
      forge: flags.forge === undefined ? derivedForge : undefined,
      forgeFallback: flags.forge === undefined && derivedForge === undefined,
    });
    return {
      name,
      title: flags.title ?? titleCase(name),
      baseUrl,
      registryAlias: flags.registry ?? name,
      registryHost: flags.registryHost ?? "ghcr.io",
      logo: flags.logo ?? "",
      forge: flags.forge ?? derivedForge ?? "github",
      git: flags.git ?? true,
      install: flags.install ?? true,
      withSkills: flags.withSkills ?? false,
      // The combined layout needs an announce target, and every layout wants
      // the header's repository link, which has no default to fall back on.
      // Empty stays empty — nothing is guessed, and a `publish.toml` with no
      // target refuses to publish.
      repoUrl: remoteUrl ?? repoUrlFromPages(baseUrl) ?? "",
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

  if (remoteUrl) {
    prompts.log.step(
      `Read from ${flags.repoUrl ? "--repo-url" : "the `origin` remote"}: ${remoteUrl}`,
    );
  }

  // Asked before the base URL, because it is what the base URL defaults from.
  // A repo cloned from its forge answers this without the user typing.
  const repoUrl =
    remoteUrl ??
    (await ask(
      prompts.text({
        message: "Repository URL this index lives in",
        placeholder: "https://github.com/you/your-index",
        defaultValue: "",
        // Blank is allowed: it writes a placeholder that refuses to publish,
        // which beats forcing a URL the user does not have yet.
        validate: (value) => (value ? (badUrl(value) ?? undefined) : undefined),
      }),
    ));

  // The whole point of asking for the repository first: on github.com and
  // gitlab.com the Pages URL follows from it, so the answer is usually Enter.
  // It stays a prompt because a custom domain (a CNAME on GitHub Pages, a
  // GitLab Pages domain) is a fact this command cannot observe. The message
  // names where the default came from, so accepting it is a decision rather
  // than a shrug.
  const pagesUrl = repoUrl === remoteUrl ? derivedBaseUrl : pagesUrlFromRepo(repoUrl);
  const baseUrl =
    flags.baseUrl ??
    (await ask(
      prompts.text({
        message: pagesUrl
          ? `Base URL the index is served from (Enter for ${pagesUrl}, or type a custom domain)`
          : "Base URL the index is served from",
        placeholder: pagesUrl ?? "https://index.example.com",
        defaultValue: pagesUrl ?? "",
        validate: (value) => badUrl(value || (pagesUrl ?? "")) ?? undefined,
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
        message: "Brand logo (site-root path like /logo.svg, or a URL; blank for none)",
        defaultValue: "",
        validate: (value) => badLogo(value ?? "") ?? undefined,
      }),
    ));

  // Prompted, not assumed. This is the committed allowlist the contribution
  // gate bounds every entry's `ref` by, and defaulting it silently left every
  // index refusing anything not on ghcr.io - including its own packages.
  const registryHost =
    flags.registryHost ??
    (await ask(
      prompts.text({
        message: "OCI registry host packages are pulled from (the gate's allowlist)",
        placeholder: "ghcr.io",
        defaultValue: "ghcr.io",
      }),
    ));

  // Derived from the repository's host when that is recognisable, so the
  // common case never sees this question. One repository runs on one forge —
  // rendering both left every index carrying a pipeline it would never run.
  const detectedForge = repoUrl === remoteUrl ? derivedForge : forgeFromRepoUrl(repoUrl);
  if (detectedForge) prompts.log.step(`CI: ${detectedForge}, from the repository host`);
  const forge =
    flags.forge ??
    detectedForge ??
    (await ask(
      prompts.select<Forge>({
        message: "CI to scaffold",
        options: [
          { value: "github", label: "GitHub Actions" },
          { value: "gitlab", label: "GitLab CI" },
        ],
        initialValue: "github",
      }),
    ));

  const git =
    flags.git ??
    (await ask(prompts.confirm({ message: "Initialize a git repository?", initialValue: true })));

  // The lock is what pins the renderer this index builds and validates with,
  // and CI runs `npm ci` against it — so an index without one is an index
  // whose first push fails. Declining is still allowed; the next steps say
  // what to run.
  const install =
    flags.install ??
    (await ask(
      prompts.confirm({
        message: "Install dependencies now? (writes package-lock.json)",
        initialValue: true,
      }),
    ));

  return {
    name,
    title,
    baseUrl,
    registryAlias,
    registryHost,
    logo,
    forge,
    git,
    install,
    withSkills: flags.withSkills ?? false,
    // The Pages-URL fallback the `--quick` path has: someone who answered the
    // base URL but left the repository blank has still said where this index
    // lives, and dropping that left `repoUrl` empty — no header link, and a
    // `publish.toml` that refuses to announce.
    repoUrl: repoUrl || (repoUrlFromPages(baseUrl) ?? ""),
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
    description: `${answers.title}, a Grimoire package index.`,
    // `logo`, not `favicon`. They are deliberately different keys (see
    // `SiteConfig`): a favicon is drawn to read at 16px, a logo goes in the
    // header and becomes the default `og:image`. The prompt asks for a brand
    // logo, so that is where the answer belongs.
    ...(answers.logo ? { logo: answers.logo } : {}),
    // The header's "github" link. Written whenever it could be derived —
    // it has no default, because the only sane one would be somebody
    // else's repository.
    ...(answers.repoUrl ? { repoUrl: answers.repoUrl } : {}),
    registry: { alias: answers.registryAlias, index: answers.baseUrl },
    // What the committed CI is rendered from. The remaining knobs
    // (`nodeVersion`, `enrich`, `grimVersion`, `allowManualEdits`) are left
    // to their defaults rather than written out — `grim-indexer ci` resolves
    // them the same way, so an absent key and its default render identically.
    // Which renderer runs is not here at all: that is `package-lock.json`.
    ci: { forge: answers.forge },
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

/**
 * The complete scaffold as (destination path, content) pairs — nothing
 * touches disk yet.
 *
 * `ci` is the `ci` block that will be on disk when this returns, which is not
 * always the one derived from the answers: `write` leaves an existing
 * `index.config.json` alone unless `--force`. Rendering the workflows from
 * the answers while the config kept its own values produced a tree whose
 * committed CI did not match its committed config — and `ci --check`, which
 * reads only the config, then failed on a tree `init` had just reported as
 * successful.
 */
function plan(
  answers: InitAnswers,
  version: string,
  ci: CiConfig,
): Array<{ path: string; content: string }> {
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
    // `title` is free text and lands inside a JSON string literal in
    // package.json. A quote in it would close that string and produce a
    // manifest npm refuses to read. Every other template puts it in prose.
    titleJson: JSON.stringify(answers.title).slice(1, -1),
  };

  const from = (rel: string, dest: string) => ({ path: dest, content: fromTemplate(rel, vars) });

  const files = [
    { path: "index/.gitkeep", content: "" },
    { path: "index.config.json", content: siteConfig(answers) },
    { path: "index-policy.json", content: indexPolicy(answers) },
    from("gitignore", ".gitignore"),
    from("gitattributes", ".gitattributes"),
    from("package.json", "package.json"),
    from("README.md", "README.md"),
  ];

  // The same renderer `grim-indexer ci` uses, driven by the `ci` block that
  // will be on disk — so the scaffold is drift-free by construction and the
  // guard it emits passes on the first push.
  for (const [dest, content] of renderCi(resolveCi(ci))) {
    files.push({ path: dest, content });
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

/**
 * Generate `package-lock.json` by installing. The lock is the load-bearing
 * part: CI runs `npm ci` against it, so a repository without one cannot build,
 * and which renderer runs would otherwise be resolved fresh on every runner.
 *
 * A failure is reported and survived — the scaffold is complete either way,
 * and the next steps say what to run.
 */
function npmInstall(dir: string): boolean {
  try {
    // `shell` on Windows: npm ships as `npm.cmd`, libuv's non-shell PATH
    // search only tries `.com`/`.exe`, and Node refuses to spawn a `.cmd`
    // without it — so without this branch the install could never succeed
    // there, and every Windows scaffold silently shipped without a lockfile.
    execFileSync("npm", ["install"], {
      cwd: dir,
      stdio: "ignore",
      shell: process.platform === "win32",
    });
    return true;
  } catch {
    console.error("warning: `npm install` failed - run it yourself to write package-lock.json");
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
    // The forge-host segment is mandatory: the gate refuses anything outside
    // `index/<host>/<namespace>/<package>/metadata.json`, and a shallow first
    // commit builds locally without complaint before failing every review.
    "Add packages under index/<host>/<namespace>/<package>/metadata.json",
    "Commit package-lock.json - CI installs from it, so it is not optional",
    "Push to your forge — CI builds and publishes the site",
  ];
  if (answers.baseUrl === "http://localhost:4321") {
    // Both keys, because the placeholder lands in both: `site` drives the
    // deployment URL, `registry.index` is the address this index hands its
    // visitors to add it with. Naming only the first left the copy-paste
    // block on the published site pointing at localhost.
    steps.push("Set site and registry.index in index.config.json to the real site URL");
  }
  if (answers.withSkills && !answers.repoUrl) {
    steps.push(
      `Set [announce] repository + namespace in publish.toml — both are ${UNDERIVED}, ` +
        "and `grim publish --announce` refuses to run until they name this repo",
    );
  }
  return [
    `${cd}${result.installed ? "" : "npm install\n"}npm run dev      # preview it locally`,
    "",
    "Then:",
    ...steps.map((step, i) => `  ${i + 1}. ${step}`),
  ].join("\n");
}

export async function init(dir: string, flags: InitFlags, version: string): Promise<ExitCode> {
  const target = path.resolve(dir);
  const answers = await resolveAnswers(target, flags);

  fs.mkdirSync(target, { recursive: true });
  // Which `ci` block the workflows are rendered from depends on which one
  // survives `write`: an existing `index.config.json` is kept unless
  // `--force`, and its settings — not the answers — are what the committed
  // CI has to match. A malformed one is a data error either way, and
  // `loadCiConfig` raises it rather than papering over it with defaults.
  const keepsExistingConfig =
    fs.existsSync(path.join(target, CONFIG_FILE)) && !(flags.force ?? false);
  const ci: CiConfig = keepsExistingConfig
    ? await loadCiConfig(target)
    : { forge: answers.forge };

  const files = write(target, plan(answers, version, ci), flags.force ?? false);
  const gitInitialized = answers.git ? initGit(target) : false;
  const installed = answers.install ? npmInstall(target) : false;
  const result: InitResult = { dir: target, files, gitInitialized, installed };

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

  // Same contract `grim-indexer ci` has: generated CI this config no longer
  // renders is reported, never deleted. Silence here left an orphaned
  // pipeline behind — and the drift guard failing on the next push with no
  // hint of where it came from.
  const orphaned = await staleCi(target, renderCi(resolveCi(ci)));
  for (const relative of orphaned) {
    console.log(`  ${"stale".padEnd(12)}${relative}`);
  }
  if (orphaned.length > 0) {
    console.error(
      `\n${orphaned.length} generated file(s) are no longer rendered by ${CONFIG_FILE} — ` +
        `delete them, or \`npm run ci:check\` keeps failing`,
    );
  }

  prompts.note(nextSteps(result, answers), "Next steps");
  prompts.outro(`Index "${answers.name}" ready in ${target}`);
  return EXIT.ok;
}
