// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Grimoire Authors

export interface SerializeOptions {
  /** The root only; every other `c/` file ends without one. */
  trailingNewline?: boolean;
}

// UTF-8 byte order, not UTF-16 code units; the string tiebreak orders lone
// surrogates, which UTF-8 encoding collapses to one replacement character.
const byBytes = (a: string, b: string): number =>
  Buffer.compare(Buffer.from(a), Buffer.from(b)) || (a < b ? -1 : a > b ? 1 : 0);

// `undefined` for a value `JSON.stringify` drops, so a caller can omit the member.
function encode(v: unknown): string | undefined {
  if (typeof v !== "object" || v === null) return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map((e) => encode(e) ?? "null").join(",")}]`;
  const members: string[] = [];
  // Sorting here, never relying on enumeration order: JS lists "10" before "0a".
  for (const k of Object.keys(v).sort(byBytes)) {
    const e = encode((v as Record<string, unknown>)[k]);
    if (e !== undefined) members.push(`${JSON.stringify(k)}:${e}`);
  }
  return `{${members.join(",")}}`;
}

/**
 * UTF-8 JSON with object keys in byte order and no insignificant whitespace.
 * Plain JSON values only. Not for `all.json`, which keeps its own serializer.
 */
export function serializeDeterministic(v: unknown, opts: SerializeOptions = {}): string {
  return `${encode(v) ?? "null"}${opts.trailingNewline ? "\n" : ""}`;
}
