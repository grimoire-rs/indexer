// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Grimoire Authors

/**
 * Forge lookups — GitHub and GitLab. Read-only: this module resolves who owns a
 * namespace and whether an account belongs to it. It never merges, comments, or
 * approves; deciding is `core/`'s job and acting is the caller's.
 */

import { requestJson, USER_AGENT } from "./http.js";

export interface NamespaceIdentity {
  kind: "user" | "org" | "group";
  /** Numeric account/group id as a string — the authorization key. */
  id: string;
  /** Canonical path/login the forge reports. Display and case-folding only. */
  path: string;
}

export interface Forge {
  /** Identity of `namespace`, or null when the forge does not know it. */
  namespaceIdentity(namespace: string): Promise<NamespaceIdentity | null>;
  /** Is `author` a member of this org/group namespace? */
  isMember(
    namespace: string,
    author: { login: string; id: string },
  ): Promise<boolean>;
}

export interface ForgeConfig {
  /** API base, e.g. `https://api.github.com` or `https://gitlab.com/api/v4`. */
  apiBase: string;
  token?: string;
  /** GitLab only: membership threshold (30 = Developer). */
  minAccessLevel?: number;
}

function field(data: unknown, key: string): unknown {
  if (typeof data !== "object" || data === null) return undefined;
  return (data as Record<string, unknown>)[key];
}

function idOf(data: unknown): string | null {
  const id = field(data, "id");
  return typeof id === "number" && Number.isInteger(id) ? String(id) : null;
}

function stringOf(data: unknown, key: string): string {
  const value = field(data, key);
  return typeof value === "string" ? value : "";
}

/** Trailing slash off, so every path below can start with one. */
function base(apiBase: string): string {
  return apiBase.replace(/\/+$/, "");
}

function github(config: ForgeConfig): Forge {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "User-Agent": USER_AGENT,
  };
  if (config.token) headers.Authorization = `Bearer ${config.token}`;
  const api = base(config.apiBase);

  return {
    async namespaceIdentity(namespace) {
      const { status, data } = await requestJson(
        `${api}/users/${encodeURIComponent(namespace)}`,
        headers,
      );
      if (status !== 200) return null;
      const id = idOf(data);
      if (id === null) return null;
      return {
        kind: stringOf(data, "type") === "Organization" ? "org" : "user",
        id,
        path: stringOf(data, "login"),
      };
    },

    async isMember(namespace, author) {
      // Public membership only — GitHub does not disclose private membership to
      // a token that is not itself an org member.
      const { status } = await requestJson(
        `${api}/orgs/${encodeURIComponent(namespace)}/public_members/${encodeURIComponent(author.login)}`,
        headers,
      );
      return status === 204;
    },
  };
}

function gitlab(config: ForgeConfig): Forge {
  const headers: Record<string, string> = { "User-Agent": USER_AGENT };
  if (config.token) headers["PRIVATE-TOKEN"] = config.token;
  const api = base(config.apiBase);
  const minAccess = config.minAccessLevel ?? 30;

  return {
    async namespaceIdentity(namespace) {
      const group = await requestJson(
        `${api}/namespaces/${encodeURIComponent(namespace)}`,
        headers,
      );
      if (group.status === 200 && field(group.data, "kind") !== "user") {
        const id = idOf(group.data);
        if (id !== null) {
          return { kind: "group", id, path: stringOf(group.data, "full_path") };
        }
      }

      // `/namespaces` is membership-scoped, so a bot token cannot see foreign
      // user namespaces. The public `/users` lookup also carries the USER id,
      // which is what grim stamps into `owner.id` (a user namespace's own id is
      // invisible to anyone but its owner).
      const users = await requestJson(
        `${api}/users?username=${encodeURIComponent(namespace)}`,
        headers,
      );
      if (users.status !== 200 || !Array.isArray(users.data)) return null;
      const hits = users.data.filter(
        (user) =>
          stringOf(user, "username").toLowerCase() === namespace.toLowerCase(),
      );
      if (hits.length !== 1) return null;
      const id = idOf(hits[0]);
      if (id === null) return null;
      return { kind: "user", id, path: stringOf(hits[0], "username") };
    },

    async isMember(namespace, author) {
      if (!/^\d+$/.test(author.id)) return false;
      // `/members/all/` includes inherited membership: a parent-group member
      // owns subgroup namespaces too.
      const { status, data } = await requestJson(
        `${api}/groups/${encodeURIComponent(namespace)}/members/all/${author.id}`,
        headers,
      );
      const level = field(data, "access_level");
      return status === 200 && typeof level === "number" && level >= minAccess;
    },
  };
}

export function createForge(
  forge: "github" | "gitlab",
  config: ForgeConfig,
): Forge {
  return forge === "github" ? github(config) : gitlab(config);
}
