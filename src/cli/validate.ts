// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Grimoire Authors

// `grim-indexer validate` — the contribution gate CI runs on a PR/MR.
//
// The contract callers depend on is the exit code, and only that:
//   0        -> eligible for auto-merge
//   non-zero -> manual review required
//
// This is also where CI plumbing lives: forge, PR author, and the committed
// registry-host allowlist are read off the environment and the policy file
// so the generated workflow stays a thin caller with no logic of its own.
import fs from "node:fs";
import path from "node:path";

import { CliError, EXIT, type ExitCode } from "./exit.js";
import type { TrustedBot } from "../validate/index.js";

export type ValidateForge = "github" | "gitlab";

export interface ValidateFlags {
  root?: string;
  prTree?: string;
  policy?: string;
  forge?: ValidateForge;
  authorLogin?: string;
  authorId?: string;
  changedFrom?: string;
}

/**
 * Read the changed-path list out of a file rather than off argv.
 *
 * This is the gate's only supported CI input, and the reason is a real
 * exploit: the paths are attacker-controlled strings, and CI used to append
 * them to the command line with `xargs`. A pull request that added an empty
 * file named `-h` therefore made commander print help and short-circuit, and
 * the gate's own contract reads exit 0 as "eligible for auto-merge". A path
 * spelled `--policy=pr-tree/...` was worse: it pointed the committed
 * allowlist at a file inside the contribution.
 *
 * Reading from a file removes the class rather than filtering it. NUL
 * separation is used when the producer offers it (`git diff -z`), newlines
 * otherwise (the GitHub API's `--jq` output). A path containing a literal
 * newline splits into two entries under the newline form; both fail the path
 * gate, so that residual is fail-closed.
 */
function readChangedFrom(file: string): string[] {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    throw new CliError(`--changed-from ${file}: cannot be read`, EXIT.data);
  }
  const separator = text.includes("\0") ? "\0" : "\n";
  return text.split(separator).filter((entry) => entry !== "");
}

/** What `index-policy.json` contributes to `ValidateOptions`. */
interface Policy {
  registryHosts?: string[];
  reservedNamespaces?: string[];
  /** Shape-checked only as far as "is an array" — the gate validates entries. */
  trustedBots?: TrustedBot[];
}

function detectForge(): ValidateForge | undefined {
  if (process.env.GITHUB_ACTIONS) return "github";
  if (process.env.GITLAB_CI) return "gitlab";
  return undefined;
}

/**
 * The PR/MR author, from whatever the forge exposes. GitHub carries it in
 * the event payload; GitLab's merge-request pipeline runs as the author, so
 * `GITLAB_USER_*` is the author.
 *
 * KNOWN GAP on GitLab: `GITLAB_USER_*` is the pipeline's *triggerer*, which
 * is the author only for the run the push creates. A maintainer who re-runs
 * the job becomes the identity ownership is checked against. Reading the
 * author from the API instead is a design change, and it is only worth making
 * if the GitLab gate is treated as a trust boundary at all — which the
 * RESIDUAL note in the generated `.gitlab-ci.yml` says it is not, because the
 * merge request supplies the pipeline. Pass `--author-login`/`--author-id`
 * explicitly if you need this pinned.
 */
function detectAuthor(forge: ValidateForge): { login: string; id: string } | undefined {
  if (forge === "gitlab") {
    const login = process.env.GITLAB_USER_LOGIN;
    const id = process.env.GITLAB_USER_ID;
    return login && id ? { login, id } : undefined;
  }

  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (!eventPath) return undefined;
  let event: unknown;
  try {
    event = JSON.parse(fs.readFileSync(eventPath, "utf8"));
  } catch {
    return undefined;
  }
  const user = (event as { pull_request?: { user?: { login?: unknown; id?: unknown } } })
    ?.pull_request?.user;
  if (typeof user?.login !== "string" || (typeof user.id !== "number" && typeof user.id !== "string")) {
    return undefined;
  }
  return { login: user.login, id: String(user.id) };
}

/**
 * Read the committed allowlist. An absent default-location file is fine —
 * the gate then bounds nothing. An explicitly requested one that is absent
 * or malformed is a data error, never a silent pass.
 */
function readPolicy(file: string, explicit: boolean): Policy {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    if (explicit) throw new CliError(`${file}: cannot be read`, EXIT.data);
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new CliError(`${file}: ${(err as Error).message}`, EXIT.data);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new CliError(`${file}: must contain a JSON object`, EXIT.data);
  }
  const policy = parsed as Record<string, unknown>;
  for (const key of ["registryHosts", "reservedNamespaces"] as const) {
    const value = policy[key];
    if (value === undefined) continue;
    if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
      throw new CliError(`${file}: ${key} must be an array of strings`, EXIT.data);
    }
  }
  if (policy.trustedBots !== undefined && !Array.isArray(policy.trustedBots)) {
    throw new CliError(`${file}: trustedBots must be an array`, EXIT.data);
  }
  return policy as Policy;
}

/**
 * @param files Changed `index/**` paths as CI's `git diff --name-only`
 *   printed them — repo-relative, and passed through unchanged. An empty set
 *   is not "check everything": the gate has nothing to authorize and returns
 *   ineligible.
 */
export async function validate(files: string[], flags: ValidateFlags): Promise<ExitCode> {
  const changed = flags.changedFrom ? [...files, ...readChangedFrom(flags.changedFrom)] : files;

  // Defence in depth behind `--changed-from`: no path under `index/` can
  // legitimately begin with `-`, and one that does is either a shell-mangled
  // entry or an attempt to have the gate parse it as a flag. Refuse rather
  // than judge it, so the failure is a usage error and never an exit 0.
  const dashed = changed.filter((file) => file.startsWith("-"));
  if (dashed.length > 0) {
    throw new CliError(
      `changed paths must not begin with "-": ${dashed.map((f) => JSON.stringify(f)).join(", ")}`,
      EXIT.usage,
    );
  }

  const root = path.resolve(flags.root ?? ".");
  const forge = flags.forge ?? detectForge();
  if (!forge) {
    throw new CliError("cannot tell which forge this is; pass --forge github|gitlab", EXIT.usage);
  }

  const author =
    flags.authorLogin && flags.authorId
      ? { login: flags.authorLogin, id: flags.authorId }
      : detectAuthor(forge);
  if (!author) {
    throw new CliError(
      "cannot determine the contribution author; pass --author-login and --author-id",
      EXIT.usage,
    );
  }

  // Not defaulted to `root`. Passing the same dir for both silently disables
  // the committed-owner-id continuity check — the one that stops a
  // re-registered login from inheriting the previous owner's packages — and a
  // gate that quietly drops a check is worse than one that refuses to run.
  if (!flags.prTree) {
    throw new CliError("--pr-tree is required: the directory holding the PR head", EXIT.data);
  }

  const policyFile = flags.policy
    ? path.resolve(flags.policy)
    : path.join(root, "index-policy.json");
  const policy = readPolicy(policyFile, flags.policy !== undefined);

  const { runValidate } = await import("../validate/index.js");
  const { eligible, reasons } = await runValidate({
    forge,
    root,
    prTree: path.resolve(flags.prTree),
    changedFiles: changed,
    author,
    ...(policy.registryHosts ? { registryHosts: policy.registryHosts } : {}),
    ...(policy.reservedNamespaces ? { reservedNamespaces: policy.reservedNamespaces } : {}),
    ...(policy.trustedBots ? { trustedBots: policy.trustedBots } : {}),
  });

  if (eligible) {
    console.log("eligible for auto-merge");
    return EXIT.ok;
  }

  console.error("manual review required:");
  for (const reason of reasons) {
    console.error(`  - ${reason}`);
  }
  return EXIT.failure;
}
