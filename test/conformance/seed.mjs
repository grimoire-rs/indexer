// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Grimoire Authors

// The input of `scripts/gen-conformance.mjs`: 300 records, as `compileIndex`
// hands them to `boundRecord`, plus the stats and the enrich-plane membership.
// Hostile text is built from code point escapes, never stored raw, so no editor
// or formatter can normalize a control character out of this file.

/** The tree's clock. The root's `generated_at` and `generation` derive from it. */
export const NOW = "2026-10-01T00:00:00Z";
const COUNT = 300;

const KiB = 1024;
const KINDS = ["skill", "rule", "agent", "mcp", "bundle", "hook"];
const OWNERS = {
  "github.com/acme": { id: 1001, github: "acme" },
  "github.com/globex": { id: 1002, github: "globex" },
  "gitlab.com/initech": { id: 1003, login: "initech" },
};
const NAMESPACES = Object.keys(OWNERS);

const range = (from, to) => Array.from({ length: to - from + 1 }, (_, i) => String.fromCodePoint(from + i)).join("");

/** `{...enrich, ...meta, namespace}`: the order `compileIndex` builds a record in. */
function record({ namespace, name, kind = "skill", ref, description, ...enrich }) {
  const org = namespace.split("/").pop();
  return {
    ...enrich,
    schema: 1,
    name,
    kind,
    ref: ref ?? `ghcr.io/${org}/${name}`,
    description: description ?? `The ${name} ${kind}.`,
    owner: OWNERS[namespace],
    namespace,
  };
}

const acme = (name, fields = {}) => record({ namespace: "github.com/acme", name, ...fields });

const TEXT_BOUNDS = {
  description: 16 * KiB,
  deprecated: KiB,
  summary: KiB,
  title: 256,
  url: 2 * KiB,
  documentation: 2 * KiB,
  compatibility: 2 * KiB,
  repository: 2 * KiB,
  version: 128,
  license: 256,
  revision: 128,
  vendor: 256,
  created: 64,
  replacedBy: 512,
  replaced_by: 512,
};
// "é" is two bytes, so each value is twice its bound and the cut lands on a character boundary.
const overlong = (bound) => "é".repeat(bound);

const lengthy = (n, size, ch) => Array.from({ length: n }, () => ch.repeat(size));

// Characters `boundRecord` strips, one class per record.
const STRIP_CLASSES = {
  c0: range(0x00, 0x1f),
  del: "\u007f",
  c1: range(0x80, 0x9f),
  u061c: "؜",
  u180e: "᠎",
  u200b: "​",
  "u2060-2064": range(0x2060, 0x2064),
  "bidi-override": range(0x202a, 0x202e),
  "bidi-isolate": range(0x2066, 0x2069),
  feff: "﻿",
  "fff9-fffb": range(0xfff9, 0xfffb),
  // A run of tag characters that is not a flag: no U+1F3F4 before it.
  "tag-run": "\u{e0001}" + range(0xe0020, 0xe007f),
};

const FLAG_ENGLAND = "\u{1F3F4}\u{E0067}\u{E0062}\u{E0065}\u{E006E}\u{E0067}\u{E007F}";

// The two refs below hash into enrich buckets "10" and "0a", the keys JS
// enumerates in the opposite order to byte order. Found by search; the test
// pins the buckets.
const BUCKET_10 = "ghcr.io/acme/bucket-305";
const BUCKET_0A = "ghcr.io/acme/bucket-519";

const special = [
  // Listed last on purpose: the winner is the greater pointer path, not the later seed position.
  record({ namespace: "github.com/globex", name: "dup-second", ref: "ghcr.io/acme/shared", version: "2.0.0" }),
  record({ namespace: "github.com/acme", name: "dup-first", ref: "ghcr.io/acme/shared", version: "1.0.0" }),

  // `compileIndex` rejects schema 2; the emitter has no such check, and grim must read it as nothing.
  { ...acme("future-schema"), schema: 2, capabilities: ["streaming"] },

  // 4-byte characters straddling the 16 KiB bound: the cut backs up to the boundary.
  acme("hostile-midchar", { description: "a".repeat(16 * KiB - 2) + "\u{1F600}\u{1F600}" }),

  ...Object.entries(TEXT_BOUNDS).map(([field, bound]) => acme(`hostile-${field}`, { [field]: overlong(bound) })),

  acme("hostile-keywords", { keywords: lengthy(40, 100, "k") }),
  acme("hostile-tags", { tags: lengthy(140, 100, "t") }),
  acme("hostile-authors-list", { authors: lengthy(20, 300, "a") }),
  acme("hostile-authors-text", { authors: "a".repeat(5000) }),
  acme("hostile-support", {
    support: { issues: "s".repeat(3000), chat: "s".repeat(3000), contact: "s".repeat(3000), security: "s".repeat(3000), extra: "e".repeat(3000) },
  }),
  acme("hostile-unlisted-string", { "x-note": "n".repeat(4 * KiB) }),
  acme("hostile-unlisted-list", { "x-list": lengthy(40, 300, "i") }),
  // Eight 1 KiB strings spend the 8 KiB budget; every value after them is clamped in place.
  acme("hostile-unlisted-budget", {
    ...Object.fromEntries(["a", "b", "c", "d", "e", "f", "g", "h"].map((k) => [`x-${k}`, "b".repeat(2 * KiB)])),
    "x-i": "late",
    "x-list": ["late"],
    "x-object": { late: "value" },
    "x-number": 7,
  }),
  acme("hostile-wrong-shape", { description: 123, keywords: "single", tags: [1, 2], title: ["x"] }),

  ...Object.entries(STRIP_CLASSES).map(([cls, chars]) => acme(`strip-${cls}`, { title: `a${chars}b`, description: `a${chars}b` })),

  acme("keep-flag-england", { title: `a${FLAG_ENGLAND}b` }),
  acme("keep-zwj", { title: "\u{1F468}‍\u{1F469}‍\u{1F467}" }),
  acme("keep-lrm-rlm", { title: "a‎b‏c‌d" }),

  acme("bucket-305", { ref: BUCKET_10, version: "1.0.0" }),
  acme("bucket-519", { ref: BUCKET_0A, version: "1.0.0" }),
];

const ordinary = Array.from({ length: COUNT - special.length }, (_, i) => {
  const kind = KINDS[i % KINDS.length];
  const namespace = NAMESPACES[Math.floor(i / KINDS.length) % NAMESPACES.length];
  const enrich =
    i % 3 === 2
      ? {}
      : {
          created: `2026-0${1 + (i % 9)}-01T00:00:00Z`,
          keywords: [kind, `group-${i % 8}`],
          license: "Apache-2.0",
          summary: `A sample ${kind} for the conformance tree.`,
          title: `Sample ${kind} ${i}`,
          updated: "2026-09-30T00:00:00Z",
          version: `1.${i % 7}.${i % 3}`,
        };
  return record({ namespace, name: `${kind}-${String(i).padStart(3, "0")}`, kind, ...enrich });
});

export const records = [...special, ...ordinary];

/** Refs that carry an enrich entry: every sixth ordinary record and the refs the tests look for. */
export const enriched = [
  ...ordinary.filter((_, i) => i % 6 === 0).map((r) => r.ref),
  "ghcr.io/acme/shared",
  BUCKET_10,
  BUCKET_0A,
];
/** Refs whose enrich entry is pointer-only, with a failure memo. */
export const failing = [ordinary[7].ref];

/** `ratings` and `downloads` for some of the ordinary refs. */
export const stats = {
  providers: { rating: "github", downloads: "artifactory" },
  entries: Object.fromEntries(
    ordinary
      .map((r, i) => [r.ref, i])
      .filter(([, i]) => i % 10 === 0)
      .map(([ref, i]) => [
        ref,
        {
          rating: { up: i, target: `DIC_kwDOconformance${i}`, url: `https://github.com/acme/index/discussions/${i}` },
          ...(i % 20 === 0 ? { downloads: { total: 100 + i, versions: { "1.0.0": 100, "1.1.0": i }, as_of: NOW } } : {}),
        },
      ]),
  ),
};
