// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Grimoire Authors

/**
 * Namespace-ownership decisions — pure, given facts the adapters probed.
 *
 * Identity is the forge account that authored the PR; authorization is the
 * *numeric* account id. The login string is display only: ids are immutable and
 * rename-proof, so every comparison that decides anything compares ids.
 */

import type { NamespaceIdentity } from "../adapters/forge.js";

/**
 * A bot trusted to announce on someone else's behalf (first-party publish CI).
 *
 * The object form pins the numeric account id and scopes the namespaces the bot
 * may touch — use it. The bare-string form is login-only: unpinned id, every
 * namespace. It exists because config files are usually written by hand, and it
 * is safe only where logins cannot be re-registered (GitHub app bots own their
 * `...[bot]` suffix; humans cannot register brackets).
 */
export type TrustedBot =
  | string
  | { login: string; id?: string; namespaces?: string[] };

export interface BotGrant {
  login: string;
  /** Numeric account id the author must present. Absent = unpinned. */
  id?: string;
  /** Namespaces the bot may announce for; `"*"` means all. */
  namespaces: string[];
}

export function findTrustedBot(
  bots: readonly TrustedBot[] | undefined,
  login: string,
): BotGrant | null {
  for (const bot of bots ?? []) {
    const grant: BotGrant =
      typeof bot === "string"
        ? { login: bot, namespaces: ["*"] }
        : { login: bot.login, id: bot.id, namespaces: bot.namespaces ?? ["*"] };
    if (grant.login.toLowerCase() === login.toLowerCase()) return grant;
  }
  return null;
}

export function botOwnsNamespace(
  grant: BotGrant,
  namespace: string,
  authorId: string,
): boolean {
  if (grant.id !== undefined && grant.id !== authorId) return false;
  return grant.namespaces.some(
    (allowed) => allowed === "*" || allowed.toLowerCase() === namespace.toLowerCase(),
  );
}

/**
 * Does the author own this namespace, given the identity the forge reported?
 *
 * A user namespace is owned only by the account it *is* — login match plus id
 * match, because a login match alone is a rename away from being someone else.
 * Org/group namespaces delegate to the membership probe the caller ran.
 */
export function namespaceOwned(
  namespace: string,
  identity: NamespaceIdentity,
  author: { login: string; id: string },
  isMember: boolean,
): boolean {
  if (identity.kind === "user") {
    return (
      identity.path.toLowerCase() === author.login.toLowerCase() &&
      namespace.toLowerCase() === author.login.toLowerCase() &&
      identity.id === author.id
    );
  }
  return isMember;
}
