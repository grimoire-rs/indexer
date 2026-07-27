// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Grimoire Authors

/**
 * Pure checks on the submitted `metadata.json` — schema shape, package-name
 * agreement, owner shape, and OCI-ref syntax/policy.
 *
 * Everything here treats its input as hostile: the document comes from the PR
 * head and is consumed as data only. Nothing is executed, nothing is merged
 * into an existing object, and no value reaches a shell or a file path.
 */

export const KINDS = ["skill", "rule", "agent", "mcp", "bundle"] as const;
export type Kind = (typeof KINDS)[number];

export interface Owner {
  /** Numeric forge account id — the authorization key (immutable, rename-proof). */
  id: number;
  /** GitHub login. Display only. */
  github?: string;
  /** Generic login for non-GitHub forges. Display only. */
  login?: string;
}

export interface Metadata {
  schema: number;
  name: string;
  kind: Kind;
  ref: string;
  description: string;
  owner: Owner;
}

const REQUIRED = [
  "schema",
  "name",
  "kind",
  "ref",
  "description",
  "owner",
] as const;

/** Keys that turn a later merge/assign into prototype pollution. */
const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);

/** A metadata document larger than this is refused before it is parsed. */
export const MAX_METADATA_BYTES = 64 * 1024;

export type Parsed<T> = { ok: true; value: T } | { ok: false; reason: string };

/**
 * `JSON.parse` with a reviver that refuses prototype-pollution keys anywhere in
 * the document. Nothing downstream merges this object, so the keys are inert on
 * their own — refusing them keeps it that way for future callers and makes the
 * property testable.
 */
export function parseMetadataJson(text: string): Parsed<unknown> {
  if (text.length > MAX_METADATA_BYTES) {
    return { ok: false, reason: `larger than ${MAX_METADATA_BYTES} bytes` };
  }
  try {
    const value: unknown = JSON.parse(text, (key: string, val: unknown) => {
      if (FORBIDDEN_KEYS.has(key)) {
        throw new SyntaxError(`forbidden key ${JSON.stringify(key)}`);
      }
      return val;
    });
    return { ok: true, value };
  } catch (error) {
    return { ok: false, reason: `invalid JSON: ${(error as Error).message}` };
  }
}

/** Port of `build.validate` — the schema/kind/name checks, plus type strictness. */
export function validateMetadata(value: unknown, pkg: string): Parsed<Metadata> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { ok: false, reason: "metadata must be a JSON object" };
  }
  const meta = value as Record<string, unknown>;

  const missing = REQUIRED.filter(
    (key) => !Object.prototype.hasOwnProperty.call(meta, key),
  );
  if (missing.length > 0) {
    return { ok: false, reason: `missing keys: ${missing.join(", ")}` };
  }
  if (meta.schema !== 1) {
    return {
      ok: false,
      reason: `unsupported schema version ${JSON.stringify(meta.schema)}`,
    };
  }
  if (
    typeof meta.kind !== "string" ||
    !(KINDS as readonly string[]).includes(meta.kind)
  ) {
    return { ok: false, reason: `kind must be one of ${KINDS.join(", ")}` };
  }
  if (typeof meta.name !== "string" || meta.name !== pkg) {
    return {
      ok: false,
      reason: `name ${JSON.stringify(meta.name)} != directory ${JSON.stringify(pkg)}`,
    };
  }
  if (typeof meta.ref !== "string" || meta.ref === "") {
    return { ok: false, reason: "ref must be a non-empty string" };
  }
  if (typeof meta.description !== "string") {
    return { ok: false, reason: "description must be a string" };
  }

  const owner = meta.owner;
  if (typeof owner !== "object" || owner === null || Array.isArray(owner)) {
    return { ok: false, reason: "owner must be an object" };
  }
  const fields = owner as Record<string, unknown>;
  // `github` names a GitHub login; `login` is the generic key other forges use.
  const login = fields.github ?? fields.login;
  if (typeof login !== "string" || login === "") {
    return { ok: false, reason: "owner needs a 'github' or 'login' string" };
  }
  if (typeof fields.id !== "number" || !Number.isInteger(fields.id)) {
    return { ok: false, reason: "owner.id must be an integer account id" };
  }

  return { ok: true, value: meta as unknown as Metadata };
}

/** The declared owner login — display only, never the authorization key. */
export function ownerLogin(owner: Owner): string {
  return owner.github ?? owner.login ?? "";
}

/** Hostname with optional port. Rejects userinfo, paths, and unicode. */
const HOST = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*(:\d{1,5})?$/i;

/** OCI distribution-spec repository name grammar. */
const REPOSITORY =
  /^[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*(?:\/[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*)*$/;

export interface RegistryRef {
  host: string;
  repository: string;
}

/** Split `<host>/<repository>` and check both halves against their grammar. */
export function parseRef(ref: string): Parsed<RegistryRef> {
  const slash = ref.indexOf("/");
  if (slash <= 0) return { ok: false, reason: `ref ${JSON.stringify(ref)} has no repository part` };
  const host = ref.slice(0, slash);
  const repository = ref.slice(slash + 1);
  if (!HOST.test(host)) {
    return { ok: false, reason: `ref ${JSON.stringify(ref)} has an invalid registry host` };
  }
  if (!REPOSITORY.test(repository)) {
    return { ok: false, reason: `ref ${JSON.stringify(ref)} has an invalid repository name` };
  }
  return { ok: true, value: { host, repository } };
}

function stripPort(host: string): string {
  const colon = host.lastIndexOf(":");
  return colon === -1 ? host : host.slice(0, colon);
}

/**
 * A dotted DNS name, not an IP literal and not a dotless internal name — the
 * shape a public registry always has, and loopback/link-local never do.
 */
export function isPublicDnsHost(host: string): boolean {
  const bare = host.startsWith("[") ? host : stripPort(host);
  if (bare.startsWith("[") || /^\d{1,3}(\.\d{1,3}){3}$/.test(bare)) return false;
  return bare.includes(".");
}

/**
 * Registry-host policy, evaluated *before* any network call (SSRF ordering).
 *
 * A committed allowlist is authoritative — an operator who lists a host has
 * accepted it, IP literal or not. With no allowlist the check falls back to
 * "public DNS name": no IP literals, no dotless hosts, which keeps a hostile
 * `ref` from steering CI at loopback or a cloud metadata endpoint.
 */
export function registryHostReason(
  host: string,
  allowlist?: readonly string[],
): string | null {
  const listed =
    allowlist?.some((entry) => entry.toLowerCase() === host.toLowerCase()) ?? false;
  if (allowlist !== undefined && allowlist.length > 0) {
    return listed ? null : `registry host ${JSON.stringify(host)} is not in the allowlist`;
  }
  if (!isPublicDnsHost(host)) {
    return `registry host ${JSON.stringify(host)} must be a public DNS name`;
  }
  return null;
}
