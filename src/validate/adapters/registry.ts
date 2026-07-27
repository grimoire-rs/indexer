// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Grimoire Authors

/**
 * OCI registry reachability. A pointer is only eligible once the thing it
 * points at actually exists — the index never publishes a claim it did not
 * confirm against registry truth.
 *
 * The registry is an untrusted endpoint chosen by the PR author, so its replies
 * steer nothing: the bearer-token realm it names must be HTTPS on a public DNS
 * host, and a configured credential is sent there only when that host is the
 * registry itself or is on the committed allowlist. (The Python this ports
 * followed any realm and sent Basic auth to it — a metadata-endpoint SSRF and a
 * credential leak in one.)
 */

import { isPublicDnsHost } from "../core/metadata.js";
import { request, USER_AGENT } from "./http.js";

export interface RegistryConfig {
  /** `user:token` for registries that do not serve anonymous pull tokens. */
  auth?: string;
  /** Committed registry-host allowlist; also bounds where credentials go. */
  allowlist?: readonly string[];
}

function quoted(challenge: string, key: string): string | null {
  const match = new RegExp(`${key}="([^"]*)"`).exec(challenge);
  return match?.[1] ?? null;
}

interface TokenRequest {
  url: string;
  /** May the configured credential be sent to this realm? */
  credentialed: boolean;
}

export function tokenRequest(
  challenge: string,
  registryHost: string,
  repository: string,
  allowlist?: readonly string[],
): TokenRequest | null {
  const realm = quoted(challenge, "realm");
  if (realm === null) return null;

  let url: URL;
  try {
    url = new URL(realm);
  } catch {
    return null;
  }
  if (url.protocol !== "https:") return null;
  if (url.username !== "" || url.password !== "") return null;
  if (!isPublicDnsHost(url.host)) return null;

  url.searchParams.set("scope", `repository:${repository}:pull`);
  const service = quoted(challenge, "service");
  if (service !== null) url.searchParams.set("service", service);

  const sameHost = url.host.toLowerCase() === registryHost.toLowerCase();
  const listed =
    allowlist?.some((entry) => entry.toLowerCase() === url.host.toLowerCase()) ??
    false;
  return { url: url.toString(), credentialed: sameHost || listed };
}

async function pullToken(
  challenge: string,
  host: string,
  repository: string,
  config: RegistryConfig,
): Promise<string | null> {
  const target = tokenRequest(challenge, host, repository, config.allowlist);
  if (target === null) return null;

  const headers: Record<string, string> = { "User-Agent": USER_AGENT };
  if (config.auth && target.credentialed) {
    headers.Authorization = `Basic ${Buffer.from(config.auth).toString("base64")}`;
  }
  const response = await request(target.url, headers);
  if (response.status !== 200) return null;
  try {
    const token: unknown = (JSON.parse(response.body) as Record<string, unknown>)
      .token;
    return typeof token === "string" && token !== "" ? token : null;
  } catch {
    return null;
  }
}

/** True when `<host>/v2/<repository>/tags/list` lists at least one tag. */
export async function refReachable(
  host: string,
  repository: string,
  config: RegistryConfig = {},
): Promise<boolean> {
  const url = `https://${host}/v2/${repository}/tags/list`;

  let response = await request(url);
  if (response.status === 401) {
    const challenge = response.header("WWW-Authenticate");
    const token = challenge
      ? await pullToken(challenge, host, repository, config)
      : null;
    if (token !== null) {
      response = await request(url, { Authorization: `Bearer ${token}` });
    }
  }
  if (response.status !== 200) return false;

  try {
    const tags: unknown = (JSON.parse(response.body) as Record<string, unknown>)
      .tags;
    return Array.isArray(tags) && tags.length > 0;
  } catch {
    return false;
  }
}
