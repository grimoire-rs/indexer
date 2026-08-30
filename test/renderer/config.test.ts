// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Grimoire Authors

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CONFIG_FILE,
  DEFAULT_CONFIG,
  loadConfig,
  resolveConfig,
  SiteConfigError,
} from "../../src/config.js";

const roots: string[] = [];

async function rootWith(contents: string | null): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "index-config-"));
  roots.push(root);
  if (contents !== null) await fs.writeFile(path.join(root, CONFIG_FILE), contents);
  return root;
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((r) => fs.rm(r, { recursive: true, force: true })));
});

/**
 * Capture what a load writes to each stream. Spying on the streams rather
 * than on `console.error` asserts the thing the rule is about — the channel —
 * and leaves the implementation free to use `console.error`, `console.warn`
 * or a direct write.
 */
function captureStreams(): { err: () => string; out: () => string } {
  const err: string[] = [];
  const out: string[] = [];
  const sink = (into: string[]) => (...args: unknown[]) => {
    into.push(args.map((a) => String(a)).join(" "));
    return true;
  };
  // Both routes to each stream, because vitest replaces `console` with its own
  // reporter-bound object — a `console.error` never reaches the worker's real
  // `process.stderr`, so spying on the stream alone captures nothing at all.
  // Node binds error/warn to stderr and log/info to stdout, which is the
  // routing TS-CLI-06 names.
  for (const method of ["error", "warn"] as const) {
    vi.spyOn(console, method).mockImplementation(sink(err));
  }
  for (const method of ["log", "info"] as const) {
    vi.spyOn(console, method).mockImplementation(sink(out));
  }
  vi.spyOn(process.stderr, "write").mockImplementation(sink(err));
  vi.spyOn(process.stdout, "write").mockImplementation(sink(out));
  return { err: () => err.join("\n"), out: () => out.join("\n") };
}

describe("loadConfig", () => {
  it("treats a missing file as an empty config", async () => {
    await expect(loadConfig(await rootWith(null))).resolves.toEqual({});
  });

  it("returns what the file declares", async () => {
    const root = await rootWith('{"brand":"acme index","docsUrl":"https://acme.test"}');
    await expect(loadConfig(root)).resolves.toEqual({
      brand: "acme index",
      docsUrl: "https://acme.test",
    });
  });

  it.each([
    ["not JSON at all", "{"],
    ["a JSON array", "[]"],
    ["a non-string brand", '{"brand":42}'],
    // A `javascript:` href would run in the visitor's browser.
    ["a non-http docsUrl", '{"docsUrl":"javascript:alert(1)"}'],
    ["a malformed extension id", '{"vscodeExtension":"nodot"}'],
    ["a non-array install", '{"install":"curl … | sh"}'],
    ["an install row missing `command`", '{"install":[{"os":"Linux"}]}'],
    ["a registry with no index", '{"registry":{"alias":"acme"}}'],
    ["a registry alias with a slash", '{"registry":{"alias":"a/b","index":"https://a.test"}}'],
    ["a non-array footerLinks", '{"footerLinks":{"label":"privacy"}}'],
    ["a footer link that is not an object", '{"footerLinks":["privacy"]}'],
    ["a footer link with no label", '{"footerLinks":[{"href":"https://a.test/p"}]}'],
    ["a footer link with a blank label", '{"footerLinks":[{"label":" ","href":"https://a.test"}]}'],
    // Relative would resolve against `/p/<ns>/<pkg>/` on package pages —
    // unlike a site-root path, which is accepted (see below).
    ["a relative footer link", '{"footerLinks":[{"label":"privacy","href":"privacy.html"}]}'],
    // Protocol-relative reads as a path and leaves the site entirely.
    ["a protocol-relative footer link", '{"footerLinks":[{"label":"x","href":"//evil.test/x"}]}'],
    // So does a backslash-rooted one: `\` is a path separator to the URL
    // parser, so `/\evil.test/x` leaves the site exactly like `//evil.test/x`
    // while passing any check that only looks for a second `/`.
    ["a backslash-rooted footer link", '{"footerLinks":[{"label":"x","href":"/\\\\evil.test/x"}]}'],
    // Same reason `docsUrl` refuses it: this href lands in an anchor.
    [
      "a javascript: footer link",
      '{"footerLinks":[{"label":"privacy","href":"javascript:alert(1)"}]}',
    ],
    ["a non-array nav", '{"nav":{"label":"docs"}}'],
    ["a nav entry with no label", '{"nav":[{"href":"/setup/"}]}'],
    ["a javascript: nav link", '{"nav":[{"label":"docs","href":"javascript:alert(1)"}]}'],
    ["a protocol-relative nav link", '{"nav":[{"label":"docs","href":"//evil.test"}]}'],
    ["a backslash-rooted nav link", '{"nav":[{"label":"docs","href":"/\\\\evil.test/x"}]}'],
    // The URL parser *deletes* tab, CR and LF before it parses anything, so
    // `/<tab>/evil.test/x` is `//evil.test/x` by the time a browser resolves
    // it — past a check that only reads the character after the first slash.
    ["a tab-smuggled nav link", '{"nav":[{"label":"x","href":"/\\t/evil.test/x"}]}'],
    ["a newline-smuggled nav link", '{"nav":[{"label":"x","href":"/\\n/evil.test/x"}]}'],
    // C-018. `validateSite` has refused userinfo since it shipped — it "reads
    // as one host and fetches another" — and that reasoning does not stop
    // applying because the value lands in a header link instead of a fetch.
    ["a userinfo nav link", '{"nav":[{"label":"docs","href":"https://good.test@evil.test/"}]}'],
    [
      "a userinfo footer link",
      '{"footerLinks":[{"label":"privacy","href":"https://good.test@evil.test/"}]}',
    ],
    ["a userinfo docsUrl", '{"docsUrl":"https://good.test@evil.test/"}'],
    [
      "a userinfo registry index",
      '{"registry":{"alias":"acme","index":"https://good.test@evil.test/"}}',
    ],
    // C-008 shipped `external` and nothing checked it. `"false"` is the
    // likely typo and it is truthy, so the author writes "not external" and
    // gets external. `null` is refused for the same reason `attribution`
    // refuses it: this field has no third state to mean.
    [
      "a string nav external",
      '{"nav":[{"label":"docs","href":"https://a.test","external":"false"}]}',
    ],
    [
      "a null footer-link external",
      '{"footerLinks":[{"label":"x","href":"https://a.test","external":null}]}',
    ],
    // C-017. `logo` carried the pre-fix href regex 55 lines below the line
    // this branch fixed, and `favicon` carried no URL check at all. Both land
    // in rendered markup — `<img src>`, `<link rel="icon" href>`, and
    // `og:image` for whichever of the two is set.
    ["a protocol-relative logo", '{"logo":"//evil.test/x.svg"}'],
    ["a backslash-rooted logo", '{"logo":"/\\\\evil.test/x.svg"}'],
    ["a userinfo logo", '{"logo":"https://good.test@evil.test/x.svg"}'],
    ["a javascript: favicon", '{"favicon":"javascript:alert(1)"}'],
    ["a data: favicon", '{"favicon":"data:image/svg+xml,<svg/>"}'],
    ["a protocol-relative favicon", '{"favicon":"//evil.test/f.svg"}'],
    ["a backslash-rooted favicon", '{"favicon":"/\\\\evil.test/f.svg"}'],
    ["a relative favicon", '{"favicon":"favicon.svg"}'],
    // `notice` is a string like the rest; the point of the row is that the
    // key `validate` walks is this one and not the pre-release `banner`.
    ["a non-string notice", '{"notice":42}'],
  ])("rejects %s", async (_case, contents) => {
    await expect(loadConfig(await rootWith(contents))).rejects.toBeInstanceOf(SiteConfigError);
  });

  // Why those rows exist, asserted rather than asserted-in-a-comment: every
  // form here reads as a site-root path to a human and to a `startsWith("/")`
  // check, and every one resolves to another origin in the parser the browser
  // uses. Platform behaviour — it cannot regress, but it is what stops the
  // href check being "simplified" back to a single-slash lookahead.
  it.each(["//evil.test/x", "/\\evil.test/x", "/\t/evil.test/x", "/\n/evil.test/x"])(
    "%j resolves off-site",
    (href) => {
      expect(new URL(href, "https://acme.test/").href).toBe("https://evil.test/x");
    },
  );

  // The same claim for userinfo, and the reason the whitespace and userinfo
  // checks cannot be one regex: this string needs no smuggled character and
  // is a perfectly well-formed absolute URL. Only the parser says which host
  // it names.
  it("a userinfo authority names the host after the @", () => {
    expect(new URL("https://good.test@evil.test/").host).toBe("evil.test");
  });

  it("accepts footer links, and defaults to none", async () => {
    expect(resolveConfig({}).footerLinks).toEqual([]);

    const root = await rootWith(
      '{"footerLinks":[{"label":"privacy","href":"https://acme.test/privacy"}]}',
    );
    expect((await loadConfig(root)).footerLinks).toEqual([
      { label: "privacy", href: "https://acme.test/privacy" },
    ]);
  });

  // The point of the site-root form: a page the index repo added under
  // `theme/pages/` is only reachable at its own path, so a nav or footer
  // entry has to be able to name one.
  it("accepts a site-root path in nav and footer links", async () => {
    const root = await rootWith(
      '{"nav":[{"label":"setup","href":"/setup/"}],"footerLinks":[{"label":"imprint","href":"/imprint/"}]}',
    );
    const config = resolveConfig(await loadConfig(root));
    expect(config.nav).toEqual([{ label: "setup", href: "/setup/" }]);
    expect(config.footerLinks).toEqual([{ label: "imprint", href: "/imprint/" }]);
  });

  // C-017: one rule, three keys. `logo` and `favicon` accept exactly what a
  // nav href accepts — a path this site emits, or an asset already hosted
  // somewhere else — so that the guard cannot be loosened for one of them
  // without the other two going with it.
  it("accepts both shapes for logo and favicon", async () => {
    const root = await rootWith('{"logo":"/logo.svg","favicon":"https://cdn.acme.test/f.svg"}');
    const config = resolveConfig(await loadConfig(root));
    expect(config.logo).toBe("/logo.svg");
    expect(config.favicon).toBe("https://cdn.acme.test/f.svg");
  });

  it("accepts null for every disable-able field", async () => {
    const root = await rootWith(
      '{"docsUrl":null,"repoUrl":null,"vscodeExtension":null,"registry":null,"footerNote":null}',
    );
    const config = resolveConfig(await loadConfig(root));
    expect(config.docsUrl).toBeNull();
    expect(config.vscodeExtension).toBeNull();
    expect(config.registry).toBeNull();
  });
});

// The field is additive: the header infers "external" from the href's shape
// unless a config says otherwise, so the contract is that an unset field
// changes nothing and a set one survives untouched. What the header *does*
// with it is the header's test, not this file's.
describe("NavLink.external", () => {
  it("adds no key when unset", async () => {
    const root = await rootWith('{"nav":[{"label":"setup","href":"/setup/"}]}');
    const nav = resolveConfig(await loadConfig(root)).nav;
    expect(nav).toEqual([{ label: "setup", href: "/setup/" }]);
    // `toEqual` treats an `external: undefined` as absent, so assert the
    // key list too: resolution must not invent a default for this field.
    expect(nav.map((link) => Object.keys(link))).toEqual([["label", "href"]]);
  });

  // Both values carry information — `false` forces the internal treatment
  // onto an http(s) href, which href-shape inference cannot express — so
  // neither may be dropped, and `false` must not collapse into "unset".
  it.each([true, false])("carries external: %s through", async (external) => {
    const root = await rootWith(
      JSON.stringify({ nav: [{ label: "docs", href: "https://acme.test", external }] }),
    );
    const expected = [{ label: "docs", href: "https://acme.test", external }];
    expect(resolveConfig(await loadConfig(root)).nav).toEqual(expected);
    // The typed path, and it has to stay an inline literal: excess-property
    // checking only fires on a *fresh* one, so hoisting this into a variable
    // silently stops it being a compile-time assertion that `NavLink` has
    // the field at all. That is the only half of this contract a runtime
    // test cannot reach — the field has no runtime behaviour of its own.
    expect(
      resolveConfig({ nav: [{ label: "docs", href: "https://acme.test", external }] }).nav,
    ).toEqual(expected);
  });
});

describe("notice", () => {
  it("is an optional string, defaulting to none", async () => {
    const root = await rootWith('{"notice":"read-only mirror of acme/index"}');
    expect(resolveConfig(await loadConfig(root)).notice).toBe("read-only mirror of acme/index");
    expect(DEFAULT_CONFIG.notice).toBeNull();
    expect(DEFAULT_CONFIG).not.toHaveProperty("banner");
  });

  // Characterization, not a guard: `validate` walks a fixed key list and
  // returns the object unchanged, so it has no unknown-key check at all. A
  // config still carrying the pre-release `banner` name therefore loads
  // clean and renders no notice — silently. Asserted so that behaviour is on
  // record; the row above is what makes `notice` the name that works.
  it("silently ignores the pre-release `banner` key", async () => {
    const config = await loadConfig(await rootWith('{"banner":"read-only mirror"}'));
    expect(config).toEqual({ banner: "read-only mirror" });
    expect(resolveConfig(config).notice).toBeNull();
  });
});

// C-015. An unrecognised key is a typo signal, not a fatal config error — the
// file is hand-edited and a misspelling that silently does nothing is the
// failure mode worth catching. So: warn, name the key, and load anyway.
describe("unrecognised keys", () => {
  it.each([
    // A plain typo, which is the case the warning exists for.
    "bannner",
    // And the real one: `banner` is what `notice` was called pre-release, so
    // an index tracking this branch has it and would otherwise lose its
    // notice line with no error and a green build.
    "banner",
  ])("warns about `%s` and loads anyway", async (key) => {
    const streams = captureStreams();
    const config = await loadConfig(await rootWith(JSON.stringify({ brand: "acme", [key]: "x" })));
    // Not fatal: the rest of the config is unaffected.
    expect(resolveConfig(config).brand).toBe("acme");
    expect(streams.err()).toContain(key);
  });

  // Everything about the run goes to stderr; stdout is the payload channel and
  // stays empty here (TS-OBS-01, TS-CLI-06). A config load emits no payload at
  // all, so anything on stdout is the violation.
  it("warns on stderr, never stdout", async () => {
    const streams = captureStreams();
    await loadConfig(await rootWith('{"bannner":"x"}'));
    expect(streams.err()).not.toBe("");
    expect(streams.out()).toBe("");
  });

  // The allowlist is not "the keys SiteConfig declares". Two other modules
  // read their own top-level block out of this same file — `src/ci.ts`
  // (`loadCiConfig`) and `src/ratings/config.ts` (`loadRatingsConfig`) — and
  // neither block is a `SiteConfig` key. A naive check warns at every index
  // that configures CI or ratings, which is most of them.
  it("says nothing about a sibling block another module owns", async () => {
    const streams = captureStreams();
    await loadConfig(
      await rootWith('{"ci":{"forge":"github"},"ratings":{"provider":"github-discussions"}}'),
    );
    expect(streams.err()).toBe("");
  });

  // Driven from `DEFAULT_CONFIG` rather than a list written out here, because
  // it is typed `Required<SiteConfig>`: it holds every key exhaustively, and
  // it cannot drift — a new `SiteConfig` key with no default is a compile
  // error. So this stays honest as the config surface grows.
  it("says nothing about any key SiteConfig declares", async () => {
    const streams = captureStreams();
    await loadConfig(await rootWith(JSON.stringify(DEFAULT_CONFIG)));
    expect(streams.err()).toBe("");
  });
});

describe("resolveConfig", () => {
  it("fills every gap from the defaults", () => {
    expect(resolveConfig({ brand: "acme index" })).toEqual({
      ...DEFAULT_CONFIG,
      brand: "acme index",
      // The one key resolution computes rather than copies — see below.
      nav: [{ label: "docs", href: DEFAULT_CONFIG.docsUrl }],
    });
  });

  // An index that predates `nav` keeps exactly the header it had: the docs
  // link, then the repo link labelled after the forge it points at.
  it("synthesizes nav from docsUrl and repoUrl when unset", () => {
    expect(resolveConfig({ repoUrl: "https://gitlab.com/acme/index" }).nav).toEqual([
      { label: "docs", href: "https://grimoire.rs" },
      { label: "gitlab", href: "https://gitlab.com/acme/index" },
    ]);
    // A host that is no forge we know is named outright rather than guessed.
    expect(resolveConfig({ docsUrl: null, repoUrl: "https://git.acme.test/x" }).nav).toEqual([
      { label: "git.acme.test", href: "https://git.acme.test/x" },
    ]);
  });

  // `null` is "nobody configured one"; `[]` is a decision, and the two must
  // not collapse into each other.
  it("keeps an explicit empty nav empty", () => {
    expect(resolveConfig({ nav: [] }).nav).toEqual([]);
    expect(resolveConfig({ nav: [{ label: "setup", href: "/setup/" }] }).nav).toEqual([
      { label: "setup", href: "/setup/" },
    ]);
  });

  it("treats an explicit undefined as absent, but keeps null", () => {
    const resolved = resolveConfig({ brand: undefined, docsUrl: null });
    expect(resolved.brand).toBe(DEFAULT_CONFIG.brand);
    expect(resolved.docsUrl).toBeNull();
  });

  // A default that names one specific index is a default that ships that
  // index's identity to everyone else. `repoUrl` put a "github" link on
  // every site pointing at grimoire-rs/index; `registry` handed out a
  // working `grim config registry add` for the wrong index entirely.
  it("has no default for the keys that name a particular index", () => {
    expect(DEFAULT_CONFIG.repoUrl).toBeNull();
    expect(DEFAULT_CONFIG.registry).toBeNull();
    // The tool's own docs are the same page whoever runs the index, so
    // those keep theirs.
    expect(DEFAULT_CONFIG.docsUrl).toBe("https://grimoire.rs");
    for (const [key, value] of Object.entries(DEFAULT_CONFIG)) {
      if (key === "site") continue; // every index sets its own; init writes it
      expect(JSON.stringify(value), key).not.toContain("index.grimoire.rs");
    }
  });
});
