// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Grimoire Authors

// `grim-indexer probe` against a real socket: the content types a deployed site
// answers with, one warning per fault, and an exit code that stays 0 either way.
import { createHash } from "node:crypto";
import type http from "node:http";
import { gzipSync } from "node:zlib";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { EXIT } from "../../src/cli/exit.js";
import { run } from "../../src/cli/main.js";
import { encodeSearchFile } from "../../src/renderer/astro/lib/searchfile.js";
import { ROOT_CAP } from "../../src/state/anchor.js";
import { rootJson, serve, type Loopback } from "../state/loopback.js";

const sha256 = (bytes: Buffer | string): string => createHash("sha256").update(bytes).digest("hex");

const PACKAGES = [{ ref: "reg.example.com/acme/tool", kind: "skill", namespace: "acme", name: "tool", logo: "/logos/tool.png" }];
const SEARCH = gzipSync(encodeSearchFile(PACKAGES));
const SEARCH_SHA = sha256(SEARCH);
const BLOB_SHA = sha256("blob");

const BLOB_PATH = `/c/f/sha256/${BLOB_SHA}.json.gz`;
const SEARCH_PATH = `/c/q/sha256/${SEARCH_SHA}.json.gz`;
const LOGO_PATH = "/logos/tool.png";
const PAGE_PATH = "/p/acme/tool/";
const ROOT_PATH = "/c/root.json";
const HEALTHY_PATHS = [ROOT_PATH, BLOB_PATH, SEARCH_PATH, LOGO_PATH, PAGE_PATH];

/** What a healthy site answers each path with. */
const HEALTHY: Record<string, { type: string; body: Buffer | string; encoding?: string }> = {
  [ROOT_PATH]: {
    type: "application/json",
    body: rootJson({ stats: { sha256: BLOB_SHA, size: 4 }, search: { sha256: SEARCH_SHA, size: 1 } }),
  },
  [BLOB_PATH]: { type: "application/gzip", body: gzipSync("blob") },
  [SEARCH_PATH]: { type: "application/gzip", body: SEARCH },
  [LOGO_PATH]: { type: "image/png", body: Buffer.from([0x89, 0x50, 0x4e, 0x47]) },
  [PAGE_PATH]: { type: "text/html; charset=utf-8", body: "<!doctype html>" },
};

type Answers = Partial<Record<string, { type?: string; body?: Buffer | string; encoding?: string; status?: number; location?: string }>>;

let sites: Loopback[];
let stdout: string[];
let stderr: string[];

/** A site under `prefix`, answering `HEALTHY` except where `over` says otherwise. */
async function site(over: Answers = {}, prefix = ""): Promise<Loopback> {
  const s = await serve((req: http.IncomingMessage, res: http.ServerResponse) => {
    const path = (req.url ?? "").split("?")[0]!;
    const key = path.startsWith(prefix) ? path.slice(prefix.length) : "";
    const answer = { ...HEALTHY[key], ...over[key] };
    if (answer.status !== undefined) {
      res.statusCode = answer.status;
      if (answer.location !== undefined) res.setHeader("Location", answer.location);
      res.end();
    } else if (HEALTHY[key] === undefined && over[key] === undefined) {
      res.statusCode = 404;
      res.end();
    } else {
      if (answer.type !== undefined) res.setHeader("Content-Type", answer.type);
      if (answer.encoding !== undefined) res.setHeader("Content-Encoding", answer.encoding);
      res.end(answer.body);
    }
  });
  sites.push(s);
  return s;
}

/** The root and search file of a site whose packages are `rows`, to pass to `site`. */
function listing(rows: Record<string, unknown>[]): Answers {
  const search = gzipSync(encodeSearchFile(rows));
  const sha = sha256(search);
  return {
    [ROOT_PATH]: { body: rootJson({ stats: { sha256: BLOB_SHA, size: 4 }, search: { sha256: sha, size: 1 } }) },
    [`/c/q/sha256/${sha}.json.gz`]: { type: "application/gzip", body: search },
  };
}

const probe = (...args: string[]): Promise<number> => run(["node", "grim-indexer", "probe", ...args]);
const warnings = (): string[] => stderr.filter((line) => line.startsWith("warn:"));

beforeEach(() => {
  sites = [];
  stdout = [];
  stderr = [];
  vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => void stdout.push(a.join(" ")));
  vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => void stderr.push(a.join(" ")));
  // Commander writes its own usage errors here.
  vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => (stderr.push(String(chunk)), true));
});

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(sites.map((s) => s.close()));
});

describe("probe: a healthy site", () => {
  it("asks for the root, a blob, the search file, a logo and a page, and warns about nothing", async () => {
    const s = await site();

    expect(await probe(s.origin)).toBe(EXIT.ok);
    expect(warnings()).toEqual([]);
    expect(s.hits.map((h) => h.url)).toEqual(HEALTHY_PATHS);
    expect(stdout.join("\n")).toContain("5 request(s), 0 warning(s)");
  });

  it("accepts JSON the host marked Content-Encoding: gzip, and x-gzip, for a blob", async () => {
    for (const over of [
      { type: "application/json; charset=utf-8", encoding: "gzip" },
      { type: "application/x-gzip" },
    ]) {
      const s = await site({ [BLOB_PATH]: over });
      expect(await probe(s.origin)).toBe(EXIT.ok);
    }
    expect(warnings()).toEqual([]);
  });

  it("reads a search file the host served as JSON with Content-Encoding: gzip", async () => {
    // fetch undoes the encoding, so the bytes the probe sees are the JSON itself.
    const s = await site({ [SEARCH_PATH]: { type: "application/json", encoding: "gzip", body: SEARCH } });

    expect(await probe(s.origin)).toBe(EXIT.ok);
    expect(warnings()).toEqual([]);
  });

  it("keeps asking under a sub-path, whether or not the URL ends in a slash", async () => {
    const s = await site({}, "/repo");

    expect(await probe(`${s.origin}/repo`)).toBe(EXIT.ok);
    expect(await probe(`${s.origin}/repo/?ignored#too`)).toBe(EXIT.ok);
    expect(warnings()).toEqual([]);
    expect(s.hits.map((h) => h.url)).toEqual([...HEALTHY_PATHS.map((p) => `/repo${p}`), ...HEALTHY_PATHS.map((p) => `/repo${p}`)]);
  });

  it("follows a redirect that stays on the origin", async () => {
    const s = await site({ [PAGE_PATH]: { status: 301, location: "/p/acme/tool/index.html" }, "/p/acme/tool/index.html": { type: "text/html" } });

    expect(await probe(s.origin)).toBe(EXIT.ok);
    expect(warnings()).toEqual([]);
  });
});

describe("probe: one warning per fault", () => {
  const CASES: Array<[string, string, string, string]> = [
    ["root", ROOT_PATH, "text/plain", "application/json"],
    ["blob", BLOB_PATH, "application/octet-stream", "application/gzip"],
    ["search file", SEARCH_PATH, "text/html", "application/gzip"],
    ["logo", LOGO_PATH, "image/jpeg", "image/png"],
    ["logo as HTML", LOGO_PATH, "text/html", "image/png"],
    ["page", PAGE_PATH, "application/json", "text/html"],
  ];

  it.each(CASES)("a wrong type on the %s", async (_label, path, type, expected) => {
    const s = await site({ [path]: { type } });

    expect(await probe(s.origin)).toBe(EXIT.ok);
    expect(warnings()).toEqual([`warn: ${s.origin}${path}: expected ${expected}${path === BLOB_PATH || path === SEARCH_PATH ? " or application/x-gzip" : ""}, got ${type}`]);
  });

  it("a missing Content-Type, and JSON served as gzip content without the encoding header", async () => {
    const s = await site({ [PAGE_PATH]: { type: "" }, [BLOB_PATH]: { type: "application/json" } });

    expect(await probe(s.origin)).toBe(EXIT.ok);
    expect(warnings()).toHaveLength(2);
    expect(warnings()[0]).toContain("expected application/gzip or application/x-gzip, got application/json");
    expect(warnings()[1]).toContain("expected text/html, got no Content-Type");
  });

  it("a non-2xx answer", async () => {
    const s = await site({ [LOGO_PATH]: { status: 404 } });

    expect(await probe(s.origin)).toBe(EXIT.ok);
    expect(warnings()).toEqual([`warn: ${s.origin}${LOGO_PATH}: expected image/png, got HTTP 404`]);
  });

  it("an unreachable host", async () => {
    const s = await site();
    await s.close();

    expect(await probe(s.origin)).toBe(EXIT.ok);
    expect(warnings()).toHaveLength(1);
    expect(warnings()[0]).toMatch(new RegExp(`^warn: ${s.origin}${ROOT_PATH}: expected application/json, got no answer \\(ECONNREFUSED\\)$`));
  });

  it("a cross-origin redirect, which is not followed", async () => {
    const elsewhere = await site();
    const s = await site({ [PAGE_PATH]: { status: 302, location: `${elsewhere.origin}${PAGE_PATH}` } });

    expect(await probe(s.origin)).toBe(EXIT.ok);
    expect(warnings()).toEqual([`warn: ${s.origin}${PAGE_PATH}: expected text/html, got a redirect to ${elsewhere.origin}, off the site origin`]);
    expect(elsewhere.hits).toEqual([]);
  });

  it("a redirect loop", async () => {
    const s = await site({ [PAGE_PATH]: { status: 302, location: PAGE_PATH } });

    expect(await probe(s.origin)).toBe(EXIT.ok);
    expect(warnings()).toEqual([`warn: ${s.origin}${PAGE_PATH}: expected text/html, got more than 5 redirects`]);
  });

  it("a root over the body cap", async () => {
    const s = await site({ [ROOT_PATH]: { body: " ".repeat(ROOT_CAP + 1) } });

    expect(await probe(s.origin)).toBe(EXIT.ok);
    expect(warnings()).toEqual([`warn: ${s.origin}${ROOT_PATH}: expected application/json, got a body over the ${ROOT_CAP} byte cap`]);
    expect(s.hits).toHaveLength(1);
  });

  it("a root that is not a JSON object", async () => {
    const s = await site({ [ROOT_PATH]: { body: "[]" } });

    expect(await probe(s.origin)).toBe(EXIT.ok);
    expect(warnings()).toEqual([`warn: ${s.origin}${ROOT_PATH}: expected a JSON object, got a body that is not one`]);
  });

  it("a search file that does not decode", async () => {
    const s = await site({ [SEARCH_PATH]: { body: gzipSync('{"schema":9}') } });

    expect(await probe(s.origin)).toBe(EXIT.ok);
    expect(warnings()).toEqual([`warn: ${s.origin}${SEARCH_PATH}: expected a search file, got unsupported search schema 9`]);
    expect(s.hits.map((h) => h.url)).not.toContain(LOGO_PATH);
  });
});

describe("probe: a namespace is a path", () => {
  it("asks for the page of a nested namespace as nested directories", async () => {
    const row = { ref: "reg.example.com/github.com/acme/tool", kind: "skill", namespace: "github.com/acme", name: "tool" };
    const page = "/p/github.com/acme/tool/";
    const s = await site({ ...listing([row]), [page]: { type: "text/html" } });

    expect(await probe(s.origin)).toBe(EXIT.ok);
    expect(warnings()).toEqual([]);
    expect(s.hits.map((h) => h.url)).toContain(page);
  });
});

describe("probe: a URL the host chose stays on the site", () => {
  const OFF_SITE: Array<[string, (other: string) => string]> = [
    ["an absolute URL on another origin", (other) => `${other}/x.png`],
    ["a private address", () => "http://10.0.0.5/x.png"],
    ["a backslash host", () => "\\\\evil\\x.png"],
  ];

  it.each(OFF_SITE)("a logo that is %s is not requested", async (_label, logoFor) => {
    const elsewhere = await site();
    const logo = logoFor(elsewhere.origin);
    const s = await site(listing([{ ...PACKAGES[0], logo }]));

    expect(await probe(s.origin)).toBe(EXIT.ok);
    expect(warnings()).toEqual([`warn: ${new URL(logo, `${s.origin}/`).href}: expected image/png, got a URL outside the site, not requested`]);
    expect(elsewhere.hits).toEqual([]);
    expect(s.hits.map((h) => h.url)).toEqual([ROOT_PATH, expect.stringContaining("/c/f/"), expect.stringContaining("/c/q/"), PAGE_PATH]);
  });

  it("a logo that climbs out of the site's base path is not requested", async () => {
    const s = await site(listing([{ ...PACKAGES[0], logo: "/../x.png" }]), "/repo");

    expect(await probe(`${s.origin}/repo`)).toBe(EXIT.ok);
    expect(warnings()).toEqual([`warn: ${s.origin}/x.png: expected image/png, got a URL outside the site, not requested`]);
    expect(s.hits.map((h) => h.url)).not.toContain("/x.png");
  });
});

describe("probe: text the host controls cannot forge a log line", () => {
  const oneLine = (): string => {
    expect(warnings()).toHaveLength(1);
    const [line] = warnings();
    expect(line).not.toMatch(/[^\x20-\x7e]/);
    expect(stderr.join("\n").split("\n").filter((l) => l.startsWith("::"))).toEqual([]);
    return line!;
  };

  it("in a JSON error that quotes the search file", async () => {
    const s = await site({ [SEARCH_PATH]: { body: gzipSync("\n::error::injected") } });

    expect(await probe(s.origin)).toBe(EXIT.ok);
    expect(oneLine()).toContain("?::error::injected");
  });

  it("in a cell the search file schema field carries", async () => {
    const s = await site({ [SEARCH_PATH]: { body: gzipSync(JSON.stringify({ schema: "x\n::error::injected" })) } });

    expect(await probe(s.origin)).toBe(EXIT.ok);
    expect(oneLine()).toBe(`warn: ${s.origin}${SEARCH_PATH}: expected a search file, got unsupported search schema string`);
  });

  it("in a Content-Type that is not ASCII, and one far longer than a warning needs", async () => {
    const s = await site({ [PAGE_PATH]: { type: `text/\u00ff${"a".repeat(500)}` } });

    expect(await probe(s.origin)).toBe(EXIT.ok);
    const line = oneLine();
    expect(line).toMatch(/, got text\/\?+a+$/);
    expect(line.slice(line.indexOf(", got ") + 6)).toHaveLength(200);
  });
});

describe("probe: a value that breaks URL parsing", () => {
  it("a logo no URL parser accepts is one warning, and the exit stays 0", async () => {
    const s = await site(listing([{ ...PACKAGES[0], logo: "http://" }]));

    expect(await probe(s.origin)).toBe(EXIT.ok);
    expect(warnings()).toEqual([`warn: ${s.origin}/: expected the checks to finish, got Invalid URL`]);
  });

  it("a namespace that cannot be percent-encoded is one warning, and the exit stays 0", async () => {
    const s = await site(listing([{ ref: "reg.example.com/x/tool", kind: "skill", namespace: "\ud800", name: "tool" }]));

    expect(await probe(s.origin)).toBe(EXIT.ok);
    expect(warnings()).toEqual([`warn: ${s.origin}/: expected the checks to finish, got URI malformed`]);
  });
});

describe("probe: inputs the root may lack", () => {
  it("warns once when the root names no search file, and asks for no logo or page", async () => {
    const s = await site({ [ROOT_PATH]: { body: rootJson({ stats: { sha256: BLOB_SHA, size: 4 } }) } });

    expect(await probe(s.origin)).toBe(EXIT.ok);
    expect(warnings()).toEqual([`warn: ${s.origin}${ROOT_PATH}: expected a "search" member naming the search file, got none`]);
    expect(s.hits.map((h) => h.url)).toEqual([ROOT_PATH, BLOB_PATH]);
  });

  it("asks for no blob when the root names neither stats nor flat", async () => {
    const s = await site({ [ROOT_PATH]: { body: rootJson({ search: { sha256: SEARCH_SHA, size: 1 } }) } });

    expect(await probe(s.origin)).toBe(EXIT.ok);
    expect(warnings()).toEqual([]);
    expect(s.hits.map((h) => h.url)).toEqual([ROOT_PATH, SEARCH_PATH, LOGO_PATH, PAGE_PATH]);
  });

  it("falls back to the flat blob, and refuses a digest that is not 64 hex", async () => {
    const flat = await site({ [ROOT_PATH]: { body: rootJson({ flat: { sha256: BLOB_SHA, size: 4 }, search: { sha256: SEARCH_SHA, size: 1 } }) } });
    const bad = await site({ [ROOT_PATH]: { body: rootJson({ stats: { sha256: "../../x", size: 4 }, search: { sha256: SEARCH_SHA, size: 1 } }) } });

    expect(await probe(flat.origin)).toBe(EXIT.ok);
    expect(await probe(bad.origin)).toBe(EXIT.ok);
    expect(flat.hits.map((h) => h.url)).toContain(BLOB_PATH);
    expect(bad.hits.map((h) => h.url)).toEqual([ROOT_PATH, SEARCH_PATH, LOGO_PATH, PAGE_PATH]);
  });
});

describe("probe: usage", () => {
  it.each([
    ["no URL", []],
    ["two URLs", ["http://127.0.0.1:1/", "http://127.0.0.1:2/"]],
    ["not a URL", ["not a url"]],
    ["a scheme that is not http(s)", ["ftp://example.test/"]],
    ["a URL with credentials", ["https://user:secret@example.test/"]],
  ])("%s exits 64 and asks for nothing", async (_label, args) => {
    expect(await probe(...args)).toBe(EXIT.usage);
    expect(warnings()).toEqual([]);
    expect(stderr.join("\n")).not.toContain("secret");
  });
});
