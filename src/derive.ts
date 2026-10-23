// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Grimoire Authors

// Where an index is hosted, read off the forge's CI environment or the git
// remote: the defaults behind an unset `site` and `repoUrl`, and the answers
// `init` prompts with.
import { execFileSync } from "node:child_process";
import fs from "node:fs";

/** scp-like `[user@]host:owner/repo` — the one git remote shape that is not a URL. */
const SCP_REMOTE = /^(?:[^@/]+@)?([\w.-]+):(?!\/)(.+)$/;

const GIT_TIMEOUT_MS = 5000;

/**
 * The target dir's `origin` remote as an https URL — set when the repo was
 * created on the forge and cloned before scaffolding into it. Any remote
 * shape (https, ssh, scp-like) reduces to the https form `[announce]` wants.
 */
export function gitRemoteUrl(dir: string): string | undefined {
  let remote: string;
  try {
    remote = execFileSync("git", ["-C", dir, "remote", "get-url", "origin"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: GIT_TIMEOUT_MS,
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
export function normalizeRepoUrl(remote: string): string | undefined {
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
export function pagesUrlFromRepo(repoUrl: string): string | undefined {
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

/** A value nobody wrote down, and what it was read from. */
export interface Derived {
  value: string;
  source: string;
}

export interface DerivedHosts {
  site?: Derived;
  repoUrl?: Derived;
}

/**
 * `site` and `repoUrl` for an index that does not set them: the forge's CI
 * variables when running there, else the `origin` remote of `root`.
 *
 * GitHub publishes no Pages URL to its jobs, so its `site` is the github.io
 * address the repository name implies; a custom domain must be written into
 * `index.config.json`. GitLab's `CI_PAGES_URL` is in every job's environment.
 */
export function deriveHosts(root: string, env: NodeJS.ProcessEnv = process.env): DerivedHosts {
  if (env.GITHUB_ACTIONS === "true" && env.GITHUB_SERVER_URL && env.GITHUB_REPOSITORY) {
    return fromRepo({ value: `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}`, source: "GITHUB_REPOSITORY" });
  }
  if (env.GITLAB_CI === "true" && env.CI_PROJECT_URL) {
    const derived = fromRepo({ value: env.CI_PROJECT_URL, source: "CI_PROJECT_URL" });
    return env.CI_PAGES_URL ? { ...derived, site: { value: env.CI_PAGES_URL, source: "CI_PAGES_URL" } } : derived;
  }
  // Only the repository root's own remote: a fixture or a nested index inside
  // another checkout would otherwise be published under that checkout's URL.
  if (!isRepoRoot(root)) return {};
  const remote = gitRemoteUrl(root);
  return remote ? fromRepo({ value: remote, source: "git remote origin" }) : {};
}

function fromRepo(repoUrl: Derived): DerivedHosts {
  const site = pagesUrlFromRepo(repoUrl.value);
  return { repoUrl, ...(site ? { site: { value: site, source: repoUrl.source } } : {}) };
}

function isRepoRoot(dir: string): boolean {
  try {
    const top = execFileSync("git", ["-C", dir, "rev-parse", "--show-toplevel"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: GIT_TIMEOUT_MS,
    }).trim();
    return fs.realpathSync(top) === fs.realpathSync(dir);
  } catch {
    return false; // no git, or not a repository
  }
}
