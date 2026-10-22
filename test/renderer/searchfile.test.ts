// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Grimoire Authors

// The search file format: the bytes the build digests and the rows the island
// reads back. Pure functions, so no Astro build is involved.
import { describe, expect, it } from "vitest";

import {
  SEARCH_FIELDS,
  SEARCH_SCHEMA,
  SearchFileError,
  decodeSearchFile,
  encodeSearchFile,
} from "../../src/renderer/astro/lib/searchfile.js";

/** Every one of the 19 fields set to a distinct, recognisable value. */
const FULL: Record<string, unknown> = {
  ref: "github.com/acme/code-review",
  kind: "skill",
  name: "code-review",
  title: "Code Review",
  keywords: ["review", "lint"],
  tags: ["1.2.0", "latest"],
  summary: "Reviews a diff.",
  description: "Reviews a diff, line by line.",
  namespace: "github.com/acme",
  vendor: "acme",
  authors: "Ada <ada@example.test>",
  license: "Apache-2.0",
  compatibility: "claude",
  version: "1.2.0",
  created: "2026-01-02T03:04:05Z",
  updated: "2026-02-03T04:05:06Z",
  deprecated: "use code-audit",
  replacedBy: "github.com/acme/code-audit",
  logo: "logos/code-review.svg",
};

/** The record a round trip must hand back: the 19 fields, minus the absent ones. */
const project = (p: Record<string, unknown>) =>
  Object.fromEntries(SEARCH_FIELDS.filter((f) => p[f] != null).map((f) => [f, p[f]]));

const roundTrip = (packages: Record<string, unknown>[]) =>
  decodeSearchFile(JSON.parse(encodeSearchFile(packages)));

/** A file as the producer would write it, then edited by the test. */
const file = (over: Record<string, unknown> = {}): unknown => ({
  ...(JSON.parse(encodeSearchFile([FULL])) as Record<string, unknown>),
  ...over,
});

describe("encodeSearchFile", () => {
  it("lists the 19 fields in the pinned order", () => {
    expect(SEARCH_SCHEMA).toBe(1);
    expect(SEARCH_FIELDS.join(",")).toBe(
      "ref,kind,name,title,keywords,tags,summary,description,namespace,vendor,authors,license,compatibility,version,created,updated,deprecated,replacedBy,logo",
    );
  });

  it("writes compact JSON, rows in input order, null for an absent field", () => {
    const bytes = encodeSearchFile([
      { ref: "h/a/x", kind: "rule", name: "x", extra: "ignored" },
      { ref: "h/a/y", kind: "skill", name: "y", keywords: ["k"], logo: null },
    ]);
    expect(bytes).toBe(
      '{"schema":1,"fields":["ref","kind","name","title","keywords","tags","summary","description","namespace","vendor","authors","license","compatibility","version","created","updated","deprecated","replacedBy","logo"],' +
        '"rows":[["h/a/x","rule","x",null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null],' +
        '["h/a/y","skill","y",null,["k"],null,null,null,null,null,null,null,null,null,null,null,null,null,null]]}',
    );
  });

  it("writes an empty row list for no packages", () => {
    expect(JSON.parse(encodeSearchFile([])).rows).toEqual([]);
  });
});

describe("decodeSearchFile round trip", () => {
  it("returns every field when all are set", () => {
    expect(roundTrip([FULL])).toEqual([project(FULL)]);
  });

  it.each(SEARCH_FIELDS)("omits %s as an absent key when it is the one field missing", (field) => {
    const { [field]: _dropped, ...rest } = FULL;
    const [row] = roundTrip([rest]);
    expect(row).toEqual(project(rest));
    expect(row).not.toHaveProperty(field);
  });

  it("turns a null cell into an absent key", () => {
    const [row] = roundTrip([{ ...FULL, logo: null }]);
    expect(row).not.toHaveProperty("logo");
  });

  it("keeps rows in input order", () => {
    const names = roundTrip([{ name: "b" }, { name: "a" }, { name: "c" }]).map((r) => r.name);
    expect(names).toEqual(["b", "a", "c"]);
  });
});

describe("decodeSearchFile rejections", () => {
  it.each([null, undefined, "text", 3, []])("rejects a non-object payload (%j)", (value) => {
    expect(() => decodeSearchFile(value)).toThrow(SearchFileError);
  });

  it.each([2, 0, "1", undefined])("rejects schema %j", (schema) => {
    expect(() => decodeSearchFile(file({ schema }))).toThrow(SearchFileError);
  });

  it.each([
    ["not an array", "ref"],
    ["holding a non-string", [...SEARCH_FIELDS.slice(1), 7]],
    ["missing a field", SEARCH_FIELDS.slice(1)],
  ])("rejects fields %s", (_label, fields) => {
    expect(() => decodeSearchFile(file({ fields }))).toThrow(SearchFileError);
  });

  it("rejects rows that is not an array", () => {
    expect(() => decodeSearchFile(file({ rows: {} }))).toThrow(SearchFileError);
  });

  it.each([
    ["not an array", "row"],
    ["too short", new Array(18).fill(null)],
    ["too long", new Array(20).fill(null)],
  ])("rejects a row that is %s", (_label, row) => {
    expect(() => decodeSearchFile(file({ rows: [row] }))).toThrow(SearchFileError);
  });

  it("names the offending row", () => {
    const good = new Array(19).fill(null);
    expect(() => decodeSearchFile(file({ rows: [good, []] }))).toThrow(/row 1/);
  });
});

describe("decodeSearchFile forward compatibility", () => {
  it("ignores a column it does not know", () => {
    const encoded = JSON.parse(encodeSearchFile([FULL])) as { fields: string[]; rows: unknown[][] };
    const widened = {
      ...encoded,
      fields: [...encoded.fields, "future"],
      rows: encoded.rows.map((r) => [...r, "x"]),
    };
    const [row] = decodeSearchFile(widened);
    expect(row).toEqual(project(FULL));
    expect(row).not.toHaveProperty("future");
  });

  it("maps by name, so a reordered file decodes the same", () => {
    const encoded = JSON.parse(encodeSearchFile([FULL])) as { fields: string[]; rows: unknown[][] };
    const order = [...encoded.fields.keys()].reverse();
    const reordered = {
      ...encoded,
      fields: order.map((i) => encoded.fields[i]),
      rows: encoded.rows.map((r) => order.map((i) => r[i])),
    };
    expect(decodeSearchFile(reordered)).toEqual([project(FULL)]);
  });
});
