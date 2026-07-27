// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Grimoire Authors

/**
 * The index contribution gate.
 *
 * Runs from the TRUSTED base checkout (GitHub `pull_request_target`, or a
 * GitLab pipeline with `scripts/` re-checked-out from the target branch). PR
 * content is consumed as data only — never executed, never imported, never
 * interpolated into a command.
 *
 * `eligible: true` means the change may be auto-merged. Anything else means a
 * human looks at it: this gate never rejects a contribution, it only declines
 * to wave it through. Callers map that to the exit contract — 0 for eligible,
 * non-zero for manual review.
 *
 * Three separated concerns make auto-merging an untrusted PR safe:
 *   identity      — the forge account that authored the PR; the forge proves it
 *   authorization — the *numeric* namespace owner id, never the login string
 *   verification  — the OCI ref re-checked against registry truth, not trusted
 */

import { createForge, type NamespaceIdentity } from "./adapters/forge.js";
import { readIndexFile } from "./adapters/files.js";
import { refReachable } from "./adapters/registry.js";
import {
  ownerLogin,
  parseMetadataJson,
  parseRef,
  registryHostReason,
  validateMetadata,
  type Metadata,
} from "./core/metadata.js";
import { parseIndexPath, type IndexPath } from "./core/paths.js";
import {
  botOwnsNamespace,
  findTrustedBot,
  namespaceOwned,
  type TrustedBot,
} from "./core/ownership.js";

export type { TrustedBot } from "./core/ownership.js";
export type { Metadata } from "./core/metadata.js";

export interface ValidateOptions {
  forge: "github" | "gitlab";
  /** Trusted base checkout — the committed state the PR proposes to change. */
  root: string;
  changedFiles: string[];
  author: { login: string; id: string };
  /** Directory holding the PR head's files. DATA ONLY. */
  prTree: string;
  /**
   * Accounts trusted to announce for a namespace they do not own. Bare strings
   * are login-only; the object form pins the account id and scopes namespaces.
   */
  trustedBots?: TrustedBot[];
  /** Committed registry-host allowlist. Empty/absent = any public DNS host. */
  registryHosts?: string[];
  /** Namespaces nobody may claim through a PR, whoever owns them upstream. */
  reservedNamespaces?: string[];
  /** Forge host pinning the `index/<host>/` segment. Default: the forge's own. */
  host?: string;
  /** API base URL. Default: the CI-predefined one for the forge. */
  apiBase?: string;
  /** Forge API token. Default: the CI-conventional environment variable. */
  token?: string;
  /** `user:token` for registries without anonymous pull tokens. */
  registryAuth?: string;
  /** GitLab only: membership threshold (30 = Developer). */
  minAccessLevel?: number;
}

export interface ValidateResult {
  eligible: boolean;
  reasons: string[];
}

const env = (name: string): string | undefined => process.env[name] || undefined;

function forgeHost(options: ValidateOptions): string | undefined {
  if (options.host) return options.host;
  return options.forge === "github" ? "github.com" : env("CI_SERVER_HOST");
}

function apiBase(options: ValidateOptions): string | undefined {
  if (options.apiBase) return options.apiBase;
  return options.forge === "github"
    ? env("GITHUB_API_URL") ?? "https://api.github.com"
    : env("CI_API_V4_URL");
}

function apiToken(options: ValidateOptions): string | undefined {
  if (options.token) return options.token;
  return options.forge === "github"
    ? env("GH_TOKEN") ?? env("GITHUB_TOKEN")
    : env("GRIM_INDEX_BOT_TOKEN");
}

function isHttps(url: string): boolean {
  try {
    return new URL(url).protocol === "https:";
  } catch {
    return false;
  }
}

export async function runValidate(
  options: ValidateOptions,
): Promise<ValidateResult> {
  try {
    const reasons = await collectReasons(options);
    return { eligible: reasons.length === 0, reasons };
  } catch (error) {
    // Any unexpected failure is a manual review, never an approval.
    return {
      eligible: false,
      reasons: [`unexpected error: ${(error as Error).message}`],
    };
  }
}

async function collectReasons(options: ValidateOptions): Promise<string[]> {
  const host = forgeHost(options);
  const api = apiBase(options);
  if (!host) return ["forge host is not configured"];
  if (!api) return ["forge API base URL is not configured"];
  if (!isHttps(api)) return [`forge API base URL ${api} is not https`];

  const changed = [...new Set(options.changedFiles.filter((file) => file !== ""))];
  if (changed.length === 0) return ["empty change set"];

  // 1. Path gate. Nothing else runs until every path is in bounds — no forge
  //    call, no registry call, no read of PR content.
  const paths: IndexPath[] = [];
  const pathReasons: string[] = [];
  for (const file of changed) {
    const parsed = parseIndexPath(file, options.forge, host);
    if (parsed === null) {
      pathReasons.push(
        `${file}: outside index/${host}/<ns>/<pkg>/metadata.json — manual review`,
      );
      continue;
    }
    paths.push(parsed);
  }
  if (pathReasons.length > 0) return pathReasons;

  // 2. Namespace ownership, once per namespace.
  const forge = createForge(options.forge, {
    apiBase: api,
    token: apiToken(options),
    minAccessLevel: options.minAccessLevel,
  });
  const identities = new Map<string, NamespaceIdentity>();
  const ownershipReasons: string[] = [];
  const reserved = new Set(
    (options.reservedNamespaces ?? []).map((name) => name.toLowerCase()),
  );
  for (const namespace of [...new Set(paths.map((p) => p.namespace))].sort()) {
    if (reserved.has(namespace.toLowerCase())) {
      ownershipReasons.push(`namespace ${JSON.stringify(namespace)} is reserved`);
      continue;
    }
    const identity = await forge.namespaceIdentity(namespace);
    if (identity === null) {
      ownershipReasons.push(
        `namespace ${JSON.stringify(namespace)} does not exist on ${host}`,
      );
      continue;
    }
    identities.set(namespace, identity);

    const bot = findTrustedBot(options.trustedBots, options.author.login);
    const owned =
      bot !== null
        ? // A login matching a trusted bot is never re-checked as a human: an
          // impostor on that login is refused outright, not given a second path.
          botOwnsNamespace(bot, namespace, options.author.id)
        : namespaceOwned(
            namespace,
            identity,
            options.author,
            identity.kind === "user"
              ? false
              : await forge.isMember(namespace, options.author),
          );
    if (!owned) {
      ownershipReasons.push(
        `namespace ${JSON.stringify(namespace)} is not owned by ${JSON.stringify(options.author.login)}`,
      );
    }
  }
  if (ownershipReasons.length > 0) return ownershipReasons;

  // 3. Per-file content checks.
  const reasons: string[] = [];
  for (const path of paths) {
    const reason = await checkFile(path, identities, options);
    if (reason !== null) reasons.push(`${path.file}: ${reason}`);
  }
  return reasons;
}

async function checkFile(
  path: IndexPath,
  identities: Map<string, NamespaceIdentity>,
  options: ValidateOptions,
): Promise<string | null> {
  const read = await readIndexFile(options.prTree, path.file);
  // A path with no file in the PR tree is a deletion by the namespace owner,
  // whose ownership was already established above.
  if (read.kind === "missing") return null;
  if (read.kind === "error") return read.reason;

  const parsed = parseMetadataJson(read.text);
  if (!parsed.ok) return parsed.reason;
  const checked = validateMetadata(parsed.value, path.pkg);
  if (!checked.ok) return checked.reason;
  const meta = checked.value;

  const identity = identities.get(path.namespace);
  if (identity === undefined) return "namespace identity is unknown";

  const login = ownerLogin(meta.owner);
  if (login.toLowerCase() !== path.namespace.toLowerCase()) {
    return `owner login ${JSON.stringify(login)} != namespace ${JSON.stringify(path.namespace)}`;
  }
  if (String(meta.owner.id) !== identity.id) {
    return `owner.id ${JSON.stringify(meta.owner.id)} != ${options.forge} id ${identity.id}`;
  }

  const continuity = await committedOwnerReason(path, meta, options.root);
  if (continuity !== null) return continuity;

  const ref = parseRef(meta.ref);
  if (!ref.ok) return ref.reason;
  // Host policy before the request — the ref is attacker-chosen input.
  const hostReason = registryHostReason(ref.value.host, options.registryHosts);
  if (hostReason !== null) return hostReason;

  const reachable = await refReachable(ref.value.host, ref.value.repository, {
    auth: options.registryAuth ?? env("GRIM_INDEX_REGISTRY_AUTH"),
    allowlist: options.registryHosts,
  });
  if (!reachable) {
    return `ref ${JSON.stringify(meta.ref)} has no reachable tags — publish first`;
  }
  return null;
}

/**
 * The committed entry is the authorization record: an existing package keeps
 * the owner id it was published under. A namespace whose login was freed and
 * re-registered resolves to a *different* account id on the forge, so this is
 * what stops the new holder from inheriting the old holder's packages.
 */
async function committedOwnerReason(
  path: IndexPath,
  submitted: Metadata,
  root: string,
): Promise<string | null> {
  const read = await readIndexFile(root, path.file);
  if (read.kind === "missing") return null; // new package
  if (read.kind === "error") {
    return `cannot read the committed entry (${read.reason}) — manual review`;
  }
  const parsed = parseMetadataJson(read.text);
  if (!parsed.ok) return `committed entry is unreadable (${parsed.reason})`;
  const committed = validateMetadata(parsed.value, path.pkg);
  if (!committed.ok) {
    return `committed entry is invalid (${committed.reason}) — manual review`;
  }
  if (committed.value.owner.id !== submitted.owner.id) {
    return `owner.id ${JSON.stringify(submitted.owner.id)} != committed owner.id ${JSON.stringify(committed.value.owner.id)}`;
  }
  return null;
}
