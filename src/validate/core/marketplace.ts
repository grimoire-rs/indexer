// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Grimoire Authors

/**
 * The marketplace gate (pure): which members `marketplace.toml` and
 * `marketplace.lock` pull in, and which of them an index-hosted marketplace
 * cannot serve. Both files are PR content — parsed as data, never executed.
 */

import { parse } from "smol-toml";

export const MARKETPLACE_FILES = ["marketplace.toml", "marketplace.lock"] as const;

/** Largest marketplace file read; a lock grows with every pinned member. */
export const MAX_MARKETPLACE_BYTES = 1024 * 1024;

const LOCK_KINDS = ["skill", "rule", "agent", "mcp", "hook"] as const;

/** Mirrors grim's `is_path_value`, plus a Windows drive or UNC root. */
const PATH_MEMBER = /^(\.{1,2}[\\/]|[\\/]|[A-Za-z]:[\\/])/;

export interface Member {
  plugin: string;
  /**
   * `registry`: a ref the index must serve. `invalid`: a shape this gate
   * cannot read, so it cannot judge it. The rest are refused outright.
   */
  type: "registry" | "path" | "project" | "invalid";
  /** The member exactly as written; for `invalid`, what is wrong with it. */
  value: string;
}

/** Keys grim's manifest accepts on a `[plugins.<name>]` table. */
const PLUGIN_KEYS = new Set([
  "include", "project", "description", "version", "rename", "logo", "readme",
  "changelog", "author", "homepage", "repository", "documentation", "support",
  "license", "keywords", "tags", "category",
]);

/**
 * `host/repo[:tag][@digest]` -> `host/repo`, lower-cased. A colon only starts
 * a tag after the last slash; before it, it is a registry port.
 */
export function stripRef(ref: string): string {
  const noDigest = ref.split("@", 1)[0] ?? "";
  const slash = noDigest.lastIndexOf("/");
  const colon = noDigest.indexOf(":", slash + 1);
  return (colon === -1 ? noDigest : noDigest.slice(0, colon)).toLowerCase();
}

const isTable = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Parse PR-supplied TOML. A syntax error is reported by position only:
 * smol-toml's message quotes source lines, and this text reaches the gate's
 * reasons - a comment on the pull request.
 */
function parseToml(text: string): Record<string, unknown> {
  try {
    return parse(text) as Record<string, unknown>;
  } catch (error) {
    const { line, column } = error as { line?: unknown; column?: unknown };
    throw new Error(
      typeof line === "number" && typeof column === "number"
        ? `line ${line}, column ${column}`
        : "syntax error",
    );
  }
}

const invalid = (plugin: string, value: string): Member => ({ plugin, type: "invalid", value });

const memberType = (ref: string): "registry" | "path" =>
  PATH_MEMBER.test(ref) ? "path" : "registry";

export function manifestMembers(text: string): Member[] {
  const plugins = parseToml(text).plugins;
  const members: Member[] = [];
  if (plugins === undefined) return members;
  if (!isTable(plugins)) return [invalid("(manifest)", "`plugins` is not a table")];
  for (const [plugin, decl] of Object.entries(plugins)) {
    if (!isTable(decl)) {
      members.push(invalid(plugin, "plugin declaration is not a table"));
      continue;
    }
    for (const key of Object.keys(decl)) {
      if (!PLUGIN_KEYS.has(key)) members.push(invalid(plugin, `unknown key ${JSON.stringify(key)}`));
    }
    if (decl.project !== undefined) {
      if (typeof decl.project === "string") {
        members.push({ plugin, type: "project", value: decl.project });
      } else {
        members.push(invalid(plugin, "`project` is not a string"));
      }
    }
    if (decl.include === undefined) continue;
    if (!Array.isArray(decl.include)) {
      members.push(invalid(plugin, "`include` is not an array"));
      continue;
    }
    for (const include of decl.include) {
      members.push(
        typeof include === "string"
          ? { plugin, type: memberType(include), value: include }
          : invalid(plugin, "`include` holds a non-string entry"),
      );
    }
  }
  return members;
}

export function lockMembers(text: string): Member[] {
  const doc = parseToml(text);
  const members: Member[] = [];
  for (const kind of LOCK_KINDS) {
    const rows = doc[kind];
    if (rows === undefined) continue;
    if (!Array.isArray(rows)) {
      members.push(invalid("(lock)", `\`${kind}\` is not an array of tables`));
      continue;
    }
    for (const row of rows) {
      if (!isTable(row)) {
        members.push(invalid("(lock)", `a \`${kind}\` row is not a table`));
        continue;
      }
      const plugin = typeof row.plugin === "string" ? row.plugin : "(no plugin)";
      if (row.path !== undefined) {
        members.push(
          typeof row.path === "string"
            ? { plugin, type: "path", value: row.path }
            : invalid(plugin, `\`${kind}\` row has a non-string \`path\``),
        );
      } else if (row.bundle !== undefined || row.bundles !== undefined) {
        // A bundle's members are covered by the bundle, so the bundle itself
        // has to be served by this index - it is the only ref this row names
        // that the index can vouch for.
        // grim writes `bundles` as `[[<kind>.bundles]]` tables carrying `repo`
        // and `tag`; a bare string is read too.
        const named = [row.bundle, ...(Array.isArray(row.bundles) ? row.bundles : [row.bundles])]
          .filter((value) => value !== undefined)
          .map((value) => (isTable(value) ? value.repo : value));
        for (const bundle of named) {
          members.push(
            typeof bundle === "string"
              ? { plugin, type: memberType(bundle), value: bundle }
              : invalid(plugin, `\`${kind}\` row has a non-string bundle`),
          );
        }
      } else if (typeof row.pinned === "string") {
        members.push({ plugin, type: "registry", value: row.pinned });
      } else {
        members.push(invalid(plugin, `\`${kind}\` row has no readable \`pinned\` or \`path\``));
      }
    }
  }
  return members;
}

/** One reason per member the index cannot serve; `indexed` holds stripped refs. */
export function memberReasons(
  file: string,
  members: Member[],
  indexed: ReadonlySet<string>,
): string[] {
  const reasons: string[] = [];
  for (const { plugin, type, value } of members) {
    const who = `${file}: plugin ${JSON.stringify(plugin)}`;
    if (type === "invalid") {
      reasons.push(`${who}: ${value} - cannot be judged, manual review`);
    } else if (type !== "registry") {
      reasons.push(
        `${who}: ${type} member ${JSON.stringify(value)} is not allowed in an index-hosted marketplace`,
      );
    } else if (!indexed.has(stripRef(value))) {
      reasons.push(
        `${who}: ${JSON.stringify(stripRef(value))} is not a package in this index — add it first`,
      );
    }
  }
  return reasons;
}
