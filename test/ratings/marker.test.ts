// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Grimoire Authors

import { describe, expect, it } from "vitest";

import type { TrustedBot } from "../../src/validate/core/ownership.js";
import {
  authorizeThread,
  buildMarker,
  conflictWarning,
  parseMarkerRef,
  resolveConflicts,
  type MarkerPolicy,
  type ObservedThread,
} from "../../src/ratings/marker.js";

const REF = "ghcr.io/grimoire-rs/grim-usage";

/** The bot the index registered in `index-policy.json`. */
const BOT_ID = "1001";
/** Anyone else with a keyboard. */
const STRANGER_ID = "666";

const policy = (over: Partial<MarkerPolicy> = {}): MarkerPolicy => ({
  trustedBots: [{ login: "grim-ratings[bot]", id: BOT_ID, namespaces: [] }],
  containerId: "R_kwDOconfigured",
  categoryId: "DIC_kwDOratings",
  ...over,
});

/**
 * The in-memory forge thread. Minimal on purpose — R-1 is pure, so the whole
 * fake is the record a provider would hand it after one page of GraphQL.
 */
const thread = (over: Partial<ObservedThread> = {}): ObservedThread => ({
  target: "D_kwDOthread1",
  url: "https://github.com/grimoire-rs/index/discussions/1",
  up: 42,
  body: buildMarker(REF),
  authorId: BOT_ID,
  containerId: "R_kwDOconfigured",
  categoryId: "DIC_kwDOratings",
  ...over,
});

describe("R-1 clause 1 — only a top-level thread body binds", () => {
  it("counts a bot's own top-level post", () => {
    expect(authorizeThread(thread(), policy())).toEqual({
      ref: REF,
      target: "D_kwDOthread1",
      url: "https://github.com/grimoire-rs/index/discussions/1",
      up: 42,
    });
  });

  it("ignores a marker forged in a reply to the bot's thread (S-013)", () => {
    // The attacker cannot author a thread, so they reply to one. The reply is
    // never parsed as a marker source — not the bot's, not a stranger's.
    const forged = thread({
      body: "no marker here",
      comments: [
        { body: buildMarker("ghcr.io/mallory/typosquat"), authorId: STRANGER_ID },
        { body: buildMarker(REF), authorId: BOT_ID },
      ],
    });
    expect(authorizeThread(forged, policy())).toBeNull();
  });
});

describe("R-1 clause 2 — the author's account id, never the login", () => {
  it("refuses a stranger's top-level post carrying a marker (S-013)", () => {
    expect(authorizeThread(thread({ authorId: STRANGER_ID }), policy())).toBeNull();
  });

  it("skips a login-only trustedBots entry rather than treating it as a wildcard", () => {
    // Both forms yield `id: undefined`. Neither may authorize anything here:
    // R-1 clause 2 has an account id and no login to compare against.
    const loginOnly: TrustedBot[] = [
      "grim-ratings[bot]",
      { login: "grim-ratings[bot]", namespaces: [] },
    ];
    expect(authorizeThread(thread(), policy({ trustedBots: loginOnly }))).toBeNull();
    // The undefined-matches-undefined hole: a deleted account reports no id.
    const ghost = thread({ authorId: undefined });
    expect(authorizeThread(ghost, policy({ trustedBots: loginOnly }))).toBeNull();
    expect(authorizeThread(ghost, policy())).toBeNull();
  });

  it("refuses when no bot is registered at all", () => {
    expect(authorizeThread(thread(), policy({ trustedBots: undefined }))).toBeNull();
    expect(authorizeThread(thread(), policy({ trustedBots: [] }))).toBeNull();
  });
});

describe("R-1 clause 3 — the first anchored match, nothing else", () => {
  it("binds the first marker by byte offset, not the last", () => {
    const two = `${buildMarker(REF)}\n${buildMarker("ghcr.io/mallory/typosquat")}\n`;
    expect(parseMarkerRef(two)).toBe(REF);
    expect(authorizeThread(thread({ body: two }), policy())?.ref).toBe(REF);
  });

  it("binds nothing from a non-anchored position", () => {
    const evil = "ghcr.io/mallory/typosquat";
    for (const body of [
      `see ${buildMarker(evil)}`, // mid-line
      `  ${buildMarker(evil)}`, // indented
      `> ${buildMarker(evil)}`, // quoted
      "```\n" + buildMarker(evil) + "\n```", // fenced
      "~~~\n" + buildMarker(evil) + "\n~~~", // fenced, tilde
      `<!-- grim-ref:  ${evil} -->`, // double space
      `<!--grim-ref: ${evil}-->`, // no spaces
      `<!-- grim-ref: ${evil} --> trailing`,
      `<!-- grim-ref: a b -->`, // ref is \S+, never two tokens
      `<!-- grim-ref:  -->`, // empty ref
    ]) {
      expect(parseMarkerRef(body)).toBeNull();
      expect(authorizeThread(thread({ body }), policy())).toBeNull();
    }
  });

  it("still finds a marker that follows a closed code fence", () => {
    const body = "```\nexample\n```\n" + buildMarker(REF);
    expect(parseMarkerRef(body)).toBe(REF);
  });

  it("round-trips the marker it builds, including under CRLF", () => {
    expect(buildMarker(REF)).toBe(`<!-- grim-ref: ${REF} -->`);
    expect(parseMarkerRef(`intro\r\n${buildMarker(REF)}\r\n`)).toBe(REF);
  });

  it("reports no marker at all as unbound, never as an empty ref", () => {
    expect(parseMarkerRef("")).toBeNull();
    expect(parseMarkerRef("just a thread body")).toBeNull();
  });
});

describe("R-1 clause 4 — the configured container, by id", () => {
  it("refuses a thread transferred out of the index repository (S-014)", () => {
    const moved = thread({ containerId: "R_kwDOsomewhereElse" });
    expect(authorizeThread(moved, policy())).toBeNull();
  });

  it("refuses the right repository with the wrong category or work-item type", () => {
    // Discussion→issue conversion and a category move land here (S-014).
    const recategorized = thread({ categoryId: "DIC_kwDOgeneral" });
    expect(authorizeThread(recategorized, policy())).toBeNull();
  });

  it("compares ids exactly — a name-shaped match is not a match", () => {
    expect(authorizeThread(thread({ containerId: "r_kwdoconfigured" }), policy())).toBeNull();
    expect(authorizeThread(thread({ categoryId: "Ratings" }), policy())).toBeNull();
  });
});

describe("R-1 conflict rule — a ref bound twice contributes zero", () => {
  const bound = (over: Partial<ObservedThread>) => {
    const authorized = authorizeThread(thread(over), policy());
    if (!authorized) throw new Error("fixture is not authorized");
    return authorized;
  };

  it("drops a doubly-bound ref and reports both URLs (S-013)", () => {
    const first = bound({ target: "D_1", url: "https://forge.example/d/1" });
    const second = bound({ target: "D_2", url: "https://forge.example/d/2", up: 7 });
    const other = bound({ target: "D_3", url: "https://forge.example/d/3", body: buildMarker("ghcr.io/acme/other") });

    const { bound: result, conflicts } = resolveConflicts([first, second, other]);

    expect(result.has(REF)).toBe(false);
    expect(result.get("ghcr.io/acme/other")?.up).toBe(42);
    expect(conflicts).toEqual([
      { ref: REF, urls: ["https://forge.example/d/1", "https://forge.example/d/2"] },
    ]);

    const warning = conflictWarning(conflicts[0]!);
    expect(warning).toContain("https://forge.example/d/1");
    expect(warning).toContain("https://forge.example/d/2");
    expect(warning).toContain(REF);
  });

  it("keeps a singly-bound ref", () => {
    const only = bound({});
    expect(resolveConflicts([only])).toEqual({
      bound: new Map([[REF, only]]),
      conflicts: [],
    });
  });

  it("has nothing to say about no threads", () => {
    expect(resolveConflicts([])).toEqual({ bound: new Map(), conflicts: [] });
  });
});

describe("R-1 clause 3 — fence delimiters close only their own kind", () => {
  // Cross-model review (codex, 2026-08-18): a boolean fence toggle read
  // ``` … ~~~ … marker … ``` as "fence opened, fence closed, marker is
  // ordinary text" and bound the marker. CommonMark 4.5 closes a fence only
  // with the same character in a run at least as long as the opener, so the
  // marker is inside the still-open backtick fence and binds nothing.
  it("does not let a foreign delimiter close an open fence", () => {
    const body = [
      "```",
      "~~~",
      "<!-- grim-ref: ghcr.io/mallory/typosquat -->",
      "```",
    ].join("\n");
    expect(parseMarkerRef(body)).toBeNull();
  });

  it("does not let a shorter run of the same delimiter close a longer one", () => {
    const body = [
      "````",
      "```",
      "<!-- grim-ref: ghcr.io/mallory/typosquat -->",
      "````",
    ].join("\n");
    expect(parseMarkerRef(body)).toBeNull();
  });

  it("closes on a longer run of the same delimiter, as CommonMark allows", () => {
    const body = [
      "```",
      "fenced content",
      "`````",
      "<!-- grim-ref: ghcr.io/acme/real -->",
    ].join("\n");
    expect(parseMarkerRef(body)).toBe("ghcr.io/acme/real");
  });

  it("still binds a marker after a properly closed fence of either kind", () => {
    for (const d of ["```", "~~~"]) {
      const body = [d, "code", d, "<!-- grim-ref: ghcr.io/acme/real -->"].join("\n");
      expect(parseMarkerRef(body), `delimiter ${d}`).toBe("ghcr.io/acme/real");
    }
  });
});

describe("R-1 — a ref cannot smuggle a second marker into the body", () => {
  // Security review (2026-08-18, B-2): `threadBody` interpolates the ref into
  // a body that `parseMarkerRef` later reads back, and R-1's four clauses all
  // constrain who wrote the body and where the thread lives — never what is
  // in it. A newline in the ref makes the *bot* author a bare column-0 marker
  // for someone else's package, passing all four clauses. Rejected at ingest
  // (`desiredRefs` now calls `parseRef`) and again here, at composition.
  const HOSTILE = [
    "ghcr.io/attacker/pkg\n<!-- grim-ref: ghcr.io/victim/popular -->\n",
    "ghcr.io/attacker/pkg -->\n<!-- grim-ref: ghcr.io/victim/popular",
    "ghcr.io/attacker/pkg with spaces",
    "ghcr.io/attacker/pkg\r<!-- grim-ref: ghcr.io/victim/popular -->",
  ];

  it("refuses to build a marker for a ref that does not round-trip", () => {
    for (const ref of HOSTILE) {
      expect(() => buildMarker(ref), JSON.stringify(ref)).toThrow(/does not round-trip/);
    }
  });

  it("still builds a marker for an ordinary ref", () => {
    expect(buildMarker("ghcr.io/acme/skills/code-review")).toBe(
      "<!-- grim-ref: ghcr.io/acme/skills/code-review -->",
    );
    expect(parseMarkerRef(buildMarker("ghcr.io/acme/x"))).toBe("ghcr.io/acme/x");
  });
});
