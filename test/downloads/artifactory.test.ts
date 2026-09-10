// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Grimoire Authors

// The Artifactory collector, against the shape a live instance actually
// returns. The fixture below is the measured `skills/grim-usage` response —
// eleven tag folders, five digest folders, 20/55/82/5/7 and a real total of
// 169 — plus the two groups a second, corporate repository added: the
// `__grimoire` discovery artifact and a crowd of untagged digests.
import { afterEach, describe, expect, it, vi } from "vitest";

import { collectDownloads } from "../../src/downloads/artifactory.js";
import { CliError } from "../../src/cli/exit.js";
import { stubFetch, type Route } from "../validate/helpers.js";

const BASE = "https://artifactory.example.com/artifactory";
const REPO = "oci-grim";
const IMAGE = "skills/grim-usage";
const REF = `artifactory.example.com/${REPO}/${IMAGE}`;
const NOW = new Date("2026-09-10T12:41:37.512Z");

/** One AQL row. `downloads` omitted is what a never-pulled path looks like. */
function row(folder: string, sha256: string, downloads?: number): Record<string, unknown> {
  return {
    repo: REPO,
    path: `${IMAGE}/${folder}`,
    name: "manifest.json",
    sha256,
    // Measured: `stats` is an ARRAY, and `downloaded` is absent when the
    // count is 0 — so a row with no pulls carries no `stats` at all.
    ...(downloads === undefined ? {} : { stats: [{ downloads, downloaded: "2026-09-01T00:00:00Z" }] }),
  };
}

const D = {
  v010: "a".repeat(64),
  v011: "b".repeat(64),
  v021: "c".repeat(64),
  v030: "d".repeat(64),
  v040: "e".repeat(64),
  index: "f".repeat(64),
  orphan: "0".repeat(64),
};

/**
 * The measured layout: a folder per tag AND a folder per digest, with the
 * counters on the digest folders because a client resolves tag -> digest and
 * then GETs by digest.
 */
const RESULTS = [
  // Every tag folder reads 0 on this instance.
  row("latest", D.v040),
  row("0", D.v040),
  row("0.1", D.v011),
  row("0.2", D.v021),
  row("0.3", D.v030),
  row("0.4", D.v040),
  row("0.1.0", D.v010),
  row("0.1.1", D.v011),
  row("0.2.1", D.v021),
  row("0.3.0", D.v030),
  row("0.4.0", D.v040),
  // The counters, on the digest folders.
  row(`sha256:${D.v010}`, D.v010, 20),
  row(`sha256:${D.v011}`, D.v011, 55),
  row(`sha256:${D.v021}`, D.v021, 82),
  row(`sha256:${D.v030}`, D.v030, 5),
  row(`sha256:${D.v040}`, D.v040, 7),
  // The index-discovery artifact every client pulls. Not a release.
  row("__grimoire", D.index),
  row(`sha256:${D.index}`, D.index, 1047),
  // An untagged digest: a description companion or an orphaned push.
  row(`sha256:${D.orphan}`, D.orphan, 1),
];

function serve(overrides: Record<string, Route> = {}) {
  return stubFetch((url) => {
    for (const [fragment, route] of Object.entries(overrides)) {
      if (url.includes(fragment)) return route;
    }
    if (url.endsWith("/api/repositories")) {
      return { body: JSON.stringify([{ key: REPO }, { key: "other-repo" }]) };
    }
    if (url.endsWith("/api/search/aql")) {
      return { body: JSON.stringify({ results: RESULTS }) };
    }
    return null;
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("collectDownloads — the measured algorithm", () => {
  it("sums each sha256 group, so a floating tag aliases rather than double counts", async () => {
    serve();
    const fresh = await collectDownloads({ baseUrl: BASE, token: "t", refs: [REF], now: NOW });

    expect(fresh[REF]).toEqual({
      // 20 + 55 + 82 + 5 + 7. `latest`, `0`, `0.1`…`0.4` share a group with
      // the release they alias, so none of them contributes a second time.
      total: 169,
      versions: { "0.4.0": 7, "0.3.0": 5, "0.2.1": 82, "0.1.1": 55, "0.1.0": 20 },
      as_of: "2026-09-10T12:41:37Z",
    });
  });

  it("labels a group by its release tag, never by the aliases in the same group", async () => {
    serve();
    const fresh = await collectDownloads({ baseUrl: BASE, token: "t", refs: [REF], now: NOW });

    expect(Object.keys(fresh[REF]!.versions!)).toEqual(["0.4.0", "0.3.0", "0.2.1", "0.1.1", "0.1.0"]);
  });

  it("drops __grimoire, which on a real repository was 1047 pulls of inflation", async () => {
    serve();
    const fresh = await collectDownloads({ baseUrl: BASE, token: "t", refs: [REF], now: NOW });

    expect(fresh[REF]!.total).toBe(169);
    expect(fresh[REF]!.total).not.toBe(169 + 1047);
    expect(fresh[REF]!.versions).not.toHaveProperty("__grimoire");
  });

  it("drops a digest with no tag left on it", async () => {
    serve();
    const fresh = await collectDownloads({ baseUrl: BASE, token: "t", refs: [REF], now: NOW });

    // The orphan's single pull is in neither the total nor any version row.
    expect(fresh[REF]!.total).toBe(169);
  });

  it("counts a hit recorded against the TAG path, which another instance does", async () => {
    // Same content, same sha256, counter on the tag folder instead — the
    // grouping is what makes the placement stop mattering.
    stubFetch((url) =>
      url.endsWith("/api/repositories")
        ? { body: JSON.stringify([{ key: REPO }]) }
        : {
            body: JSON.stringify({
              results: [row("1.0.0", D.v010, 12), row(`sha256:${D.v010}`, D.v010, 30)],
            }),
          },
    );
    const fresh = await collectDownloads({ baseUrl: BASE, token: "t", refs: [REF], now: NOW });

    expect(fresh[REF]).toEqual({ total: 42, versions: { "1.0.0": 42 }, as_of: "2026-09-10T12:41:37Z" });
  });

  it("counts a channel tag toward the total and gives it no version row", async () => {
    stubFetch((url) =>
      url.endsWith("/api/repositories")
        ? { body: JSON.stringify([{ key: REPO }]) }
        : {
            body: JSON.stringify({
              results: [row(`sha256:${D.v010}`, D.v010, 9), row("canary", D.v010)],
            }),
          },
    );
    const fresh = await collectDownloads({ baseUrl: BASE, token: "t", refs: [REF], now: NOW });

    expect(fresh[REF]).toEqual({ total: 9, as_of: "2026-09-10T12:41:37Z" });
  });

  it("leaves an artifact the instance returned no rows for ABSENT, never at zero", async () => {
    serve();
    const other = "artifactory.example.com/oci-grim/skills/not-published";
    const fresh = await collectDownloads({
      baseUrl: BASE,
      token: "t",
      refs: [REF, other],
      now: NOW,
    });

    expect(fresh).not.toHaveProperty(other);
  });

  it("skips a ref hosted somewhere else instead of failing the run", async () => {
    const calls = serve();
    const fresh = await collectDownloads({
      baseUrl: BASE,
      token: "t",
      refs: ["ghcr.io/acme/code-review", REF],
      now: NOW,
    });

    expect(Object.keys(fresh)).toEqual([REF]);
    // Nothing derived from a ref ever becomes a URL — the only host dialled is
    // the configured one.
    for (const call of calls) expect(call.url.startsWith(BASE)).toBe(true);
  });

  it("makes one query per repository key, not one per artifact", async () => {
    const calls = serve();
    await collectDownloads({
      baseUrl: BASE,
      token: "t",
      refs: [REF, `artifactory.example.com/${REPO}/skills/other`],
      now: NOW,
    });

    expect(calls.filter((c) => c.url.endsWith("/api/search/aql"))).toHaveLength(1);
  });

  it("dials nothing at all when no ref is on this instance", async () => {
    const calls = serve();
    const fresh = await collectDownloads({
      baseUrl: BASE,
      token: "t",
      refs: ["ghcr.io/acme/code-review"],
      now: NOW,
    });

    expect(fresh).toEqual({});
    expect(calls).toEqual([]);
  });
});

describe("the AQL request itself", () => {
  it("POSTs a query including repo, path and name — a non-admin query without them is rejected", async () => {
    const calls = serve();
    await collectDownloads({ baseUrl: BASE, token: "sekret", refs: [REF], now: NOW });
    const aql = calls.find((c) => c.url.endsWith("/api/search/aql"))!;

    expect(aql.method).toBe("POST");
    expect(aql.headers.Authorization).toBe("Bearer sekret");
    expect(aql.headers["Content-Type"]).toBe("text/plain");
    for (const field of ['"repo"', '"path"', '"name"', '"sha256"', '"stat.downloads"']) {
      expect(aql.body, field).toContain(field);
    }
    expect(aql.body).toContain(`"repo":"${REPO}"`);
    // Layer blobs measure nothing — 0 across every version of one package and
    // 6 on another — so only the manifest is ever counted.
    expect(aql.body).toContain('"*manifest.json"');
  });
});

describe("a missing read permission is silent in AQL, so it is caught elsewhere", () => {
  it("fails the run when the repository is not in the readable list", async () => {
    serve({
      "/api/repositories": { body: JSON.stringify([{ key: "some-other-repo" }]) },
      // What a token without read actually sees: HTTP 200, no rows, no error.
      "/api/search/aql": { body: JSON.stringify({ results: [] }) },
    });

    await expect(
      collectDownloads({ baseUrl: BASE, token: "t", refs: [REF], now: NOW }),
    ).rejects.toThrow(/cannot read oci-grim/);
  });

  it("publishes nothing rather than a zero when the repository list is unreachable", async () => {
    serve({ "/api/repositories": { status: 503 } });

    await expect(
      collectDownloads({ baseUrl: BASE, token: "t", refs: [REF], now: NOW }),
    ).rejects.toThrow(CliError);
  });

  it("fails on an AQL error rather than reading it as no downloads", async () => {
    serve({ "/api/search/aql": { status: 403 } });

    await expect(
      collectDownloads({ baseUrl: BASE, token: "t", refs: [REF], now: NOW }),
    ).rejects.toThrow(/HTTP 403/);
  });

  it("fails on an AQL reply that does not parse", async () => {
    serve({ "/api/search/aql": { body: "<html>login</html>" } });

    await expect(
      collectDownloads({ baseUrl: BASE, token: "t", refs: [REF], now: NOW }),
    ).rejects.toThrow(/did not parse/);
  });

  it("reads a readable repository with genuinely no rows as no data, not as an error", async () => {
    serve({ "/api/search/aql": { body: JSON.stringify({ results: [] }) } });
    const fresh = await collectDownloads({ baseUrl: BASE, token: "t", refs: [REF], now: NOW });

    expect(fresh).toEqual({});
  });
});
