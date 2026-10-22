// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Grimoire Authors

// IX-R29. Three readers fetch a file by the digest a trusted root or index named:
// the plane's site leg, the previous-closure stage and the stats seed. They share
// one rule (verify before trust) and keep three policies for a failure. This
// table pins the classification of one answer through all three.
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CliError, EXIT } from "../../src/cli/exit.js";
import { fetchPlaneFile } from "../../src/emit/publish-plane.js";
import { gzipDeterministic } from "../../src/emit/gzip.js";
import type { BlobRef, Root } from "../../src/emit/root.js";
import { fetchPublishedStats, type HttpsSite } from "../../src/ratings/seed.js";
import { BlobStore } from "../../src/state/blobstore.js";
import { STATE_DIR } from "../../src/state/handoff.js";
import { stagePreviousClosure } from "../../src/state/retention.js";
import { rootJson } from "./loopback.js";

const SITE = "https://index.example";
const sha = (b: Uint8Array): string => createHash("sha256").update(b).digest("hex");

const CONTENT = Buffer.from(JSON.stringify({ title: "a file", pad: "x".repeat(200) }));
const REF: BlobRef = { sha256: sha(CONTENT), size: CONTENT.length };
/** The same length and a different digest. */
const FORGED = Buffer.from(CONTENT.toString().replace("a file", "b file"));
const SHORT = CONTENT.subarray(0, 50);

type Scenario = "missing" | "no-answer" | "redirect" | "short" | "wrong-digest" | "ok";
/** What every reader makes of the answer, whatever it then does about it. */
const CLASS: Record<Scenario, "missing" | "unreachable" | "invalid" | "ok"> = {
  missing: "missing",
  "no-answer": "unreachable",
  redirect: "unreachable",
  short: "invalid",
  "wrong-digest": "invalid",
  ok: "ok",
};
const SCENARIOS = Object.keys(CLASS) as Scenario[];

interface Seen {
  url: string;
  headers: Record<string, string>;
  redirect: unknown;
}

/** `fetch` answering the file's GET as `scenario` says, with `wire` shaping the bytes; the root is a healthy one naming `REF` as the stats blob. */
function stub(scenario: Scenario, wire: (b: Buffer) => Buffer): Seen[] {
  const seen: Seen[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown, init?: RequestInit) => {
      const url = new URL(String(input));
      seen.push({ url: url.pathname + url.search, headers: { ...(init?.headers as Record<string, string>) }, redirect: init?.redirect });
      if (url.pathname === "/c/root.json") return new Response(rootJson({ stats: REF }));
      const bytes = (b: Buffer): Response => new Response(new Uint8Array(wire(b)));
      switch (scenario) {
        case "missing":
          return new Response("<html>404</html>", { status: 404 });
        case "no-answer":
          throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
        case "redirect":
          return new Response(null, { status: 302, headers: { Location: "/elsewhere" } });
        case "short":
          return bytes(SHORT);
        case "wrong-digest":
          return bytes(FORGED);
        case "ok":
          return bytes(CONTENT);
      }
    }),
  );
  return seen;
}

/** The text `describeStatus` gives for the answer. */
const REASON: Record<Scenario, string> = {
  missing: "HTTP 404",
  "no-answer": "no answer (ECONNREFUSED)",
  redirect: "HTTP 302",
  short: `${SHORT.length} bytes, expected ${REF.size}`,
  "wrong-digest": "digest mismatch",
  ok: "",
};

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("the plane's site leg (fetchPlaneFile)", () => {
  it.each(SCENARIOS)("%s", async (scenario) => {
    const seen = stub(scenario, (b) => b);

    const got = await fetchPlaneFile(SITE, "s", REF);

    expect(got.kind === "ok" ? "ok" : got.kind === "missing" ? "missing" : "error").toBe(
      { missing: "missing", unreachable: "error", invalid: "error", ok: "ok" }[CLASS[scenario]],
    );
    if (got.kind === "ok") expect(got.bytes.equals(CONTENT)).toBe(true);
    if (got.kind === "error") expect(got.reason).toBe(REASON[scenario]);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.url).toMatch(new RegExp(`^/c/s/sha256/${REF.sha256}\\.json\\?[0-9a-f]{16}$`));
    expect(seen[0]?.headers["Accept-Encoding"]).toBe("gzip");
    expect(seen[0]?.redirect).toBe("manual");
  });
});

describe("the previous closure's stage (stagePreviousClosure)", () => {
  let tmp: string;
  let store: BlobStore;
  const root: Root = {
    flat: REF,
    generated_at: "2026-10-21T08:00:00Z",
    generation: 1,
    planes: { catalog: null, enrich: null },
    schema: 1,
    search: null,
    stats: null,
  };
  const warned = (): string => vi.mocked(console.warn).mock.calls.flat().join("\n");

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "fetch-by-digest-"));
    store = new BlobStore(path.join(tmp, STATE_DIR));
  });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it.each(SCENARIOS)("%s", async (scenario) => {
    const seen = stub(scenario, (b) => gzipDeterministic(b));

    const counts = await stagePreviousClosure(SITE, store, root, Date.now() + 60_000);

    const staged = path.join(store.stateDir, "out", "retained", "c", "f", "sha256", `${REF.sha256}.json.gz`);
    if (scenario === "ok") {
      expect(counts).toEqual({ files: 1, skipped: 0 });
      expect(fs.readFileSync(staged).equals(gzipDeterministic(CONTENT))).toBe(true);
      expect(warned()).toBe("");
    } else {
      expect(counts).toEqual({ files: 0, skipped: 1 });
      expect(fs.existsSync(staged)).toBe(false);
      expect(warned()).toContain(scenario === "missing" ? "(not published)" : `(${REASON[scenario]})`);
    }
    expect(seen).toHaveLength(1);
    expect(seen[0]?.url).toMatch(new RegExp(`^/c/f/sha256/${REF.sha256}\\.json\\.gz\\?[0-9a-f]{16}$`));
    expect(seen[0]?.headers["Accept-Encoding"]).toBe("gzip");
    expect(seen[0]?.redirect).toBe("manual");
  });
});

describe("the stats seed (fetchPublishedStats)", () => {
  it.each(SCENARIOS)("%s", async (scenario) => {
    const seen = stub(scenario, (b) => gzipDeterministic(b));

    const got = await fetchPublishedStats(SITE as HttpsSite).then(
      (stats) => stats,
      (e: unknown) => e,
    );

    const klass = CLASS[scenario];
    if (klass === "ok") {
      expect(got).toEqual({ text: CONTENT.toString("utf8"), where: expect.stringContaining(REF.sha256) });
    } else {
      expect(got).toBeInstanceOf(CliError);
      const err = got as CliError;
      // A 404, no answer and a redirect are unreadable; bytes that are not the file named are invalid.
      expect(err.code).toBe(klass === "invalid" ? EXIT.data : EXIT.unavailable);
      expect(err.message).toContain(klass === "invalid" ? "does not match the digest and size the root names" : `(${REASON[scenario]})`);
    }
    // The root is read first; the blob's own GET is the second request and carries no nonce.
    expect(seen).toHaveLength(2);
    expect(seen[1]?.url).toBe(`/c/f/sha256/${REF.sha256}.json.gz`);
    expect(seen[1]?.headers["Accept-Encoding"]).toBe("gzip");
    expect(seen[1]?.redirect).toBe("manual");
  });
});
