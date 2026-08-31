#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Grimoire Authors

/**
 * Publish-shape gate for `@grimoire-rs/indexer`. Ported from the sibling
 * `ocx-catalog` repo, retargeted at this package's own shape.
 *
 * `tsc` reads the source tree; a consumer's install reads the tarball. Every
 * failure this catches lives only in the gap between the two — a broken
 * `exports` map, a `bin` npm silently rewrote, a runtime import that only
 * `devDependencies` satisfies. All of it passes lint, typecheck and vitest.
 *
 * Contract enforced before every publish:
 *   1. `npm pack` the package into a tarball.
 *   2. `publint` it — export map / bin / types correctness.
 *   3. `attw --pack` it — type resolution across module systems.
 *   4. Install the tarball into a fresh `mkdtemp` sandbox with npm scripts
 *      disabled, then run `grim-indexer --version` from the installed bin to
 *      prove the `bin` entry survived packing.
 *   5. From that sandbox, resolve BOTH subpath exports — `.` and
 *      `./integration` — proving each `exports` target is actually in the
 *      tarball. The integration entry is the one a consumer index imports
 *      from its own `astro.config`, and nothing else in this repo's gate
 *      touches it.
 *   6. Walk every shipped `.js`/`.mjs` under the installed package, extract
 *      every static AND dynamic import specifier, and resolve each one. The
 *      sandbox holds only what `dependencies` declares, so an unresolvable
 *      specifier is a real bug — a runtime dependency sitting in
 *      `devDependencies`. This repo ships a renderer that imports `astro`,
 *      `@astrojs/preact`, `preact` and `lucide-preact` at build time, which
 *      is exactly the class of mistake that would ship green.
 *   7. Fail if `npm pack` output contains "auto-corrected" — npm silently
 *      rewriting the manifest is a hard failure, not a warning. With
 *      `GRIM_INDEXER_PACK_SMOKE_NETWORK=1`, additionally run `npm publish
 *      --dry-run`, which applies a stricter normalization pass than `pack`
 *      does. Opt-in because it needs live registry connectivity (it hangs
 *      rather than failing fast against an unreachable one), so `task check`
 *      stays offline-safe; `release.yml` carries the enforced copy.
 *   8. Assert the npm major this script runs under, so a pack-format change
 *      in a future major does not silently pass.
 *
 * `dist/` must be built first — `task check` runs `build` upstream of this,
 * and `npm pack` reads what is on disk.
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { builtinModules } from "node:module";
import { tmpdir } from "node:os";
import { extname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

/** Runs a command, capturing stdout/stderr; throws on non-zero exit. */
function run(step, command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", ...options });
  if (result.error) {
    throw new Error(`${step}: failed to spawn "${command}": ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(
      `${step}: "${command} ${args.join(" ")}" exited ${String(result.status)}\n` +
        `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );
  }
  return result;
}

/** The npm major this script's assertions were verified against. Every check
 * below reads `npm pack --json` output and npm's own manifest-normalization
 * warnings — both of which npm is free to change across a major. Bump this
 * ONLY together with a re-verification of the whole script under the new
 * major (a green run after the bump is the evidence); a silent pass under an
 * npm whose pack format moved is exactly the regression this guards.
 * `release.yml` installs `npm@11.x` explicitly in the publish job, and
 * `actions/setup-node` with node 24 ships npm 11 in the gate job. */
const EXPECTED_NPM_MAJOR = 11;

function assertNpmMajor() {
  const result = spawnSync("npm", ["--version"], { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`assert npm version: "npm --version" exited ${String(result.status)}`);
  }
  const version = result.stdout.trim();
  const match = /^(\d+)\./.exec(version);
  if (!match) {
    throw new Error(`assert npm version: could not parse npm major version from "${version}"`);
  }
  const major = Number(match[1]);
  if (major !== EXPECTED_NPM_MAJOR) {
    throw new Error(
      `assert npm version: this script's pack-format assertions are verified against npm ` +
        `${String(EXPECTED_NPM_MAJOR)}.x, but it is running under npm ${version} — re-verify the ` +
        `whole script under the new major, then bump EXPECTED_NPM_MAJOR in scripts/pack-smoke.mjs.`,
    );
  }
  return { version, major };
}

/** npm's own wording when the version in package.json is already on the
 * registry (`E403`). Matched, not assumed from the exit status, so a genuine
 * publish failure never slips through as "expected". */
const ALREADY_PUBLISHED = /cannot publish over the previously published versions/i;

function pkgVersion() {
  return JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")).version;
}

function assertNoAutoCorrect(step, outputs) {
  for (const output of outputs) {
    if (output.includes("auto-corrected")) {
      throw new Error(
        `${step}: npm silently auto-corrected the manifest (found "auto-corrected" ` +
          `in output) — this is a hard failure, not a warning:\n${output}`,
      );
    }
  }
}

function packTarball(step, packDir) {
  const result = run(step, "npm", ["pack", "--pack-destination", packDir, "--json"], {
    cwd: repoRoot,
  });
  assertNoAutoCorrect(step, [result.stdout, result.stderr]);
  const [entry] = JSON.parse(result.stdout);
  return join(packDir, entry.filename);
}

function runPublint(step, tarballPath) {
  const publintBin = join(repoRoot, "node_modules", ".bin", "publint");
  run(step, publintBin, ["run", tarballPath], { cwd: repoRoot });
}

function runAttw(step, tarballPath) {
  // `--profile esm-only`, not a muted rule. This package is `type: module`
  // with an `exports`-only manifest and no `main`, so TypeScript's legacy
  // `node10` resolution cannot see either entrypoint — which is intended:
  // `moduleResolution: "node"` is deprecated in TS 6 and removed in 7. The
  // profile drops that one resolution mode; `--ignore-rules no-resolution`
  // would instead hide a genuine unresolvable entrypoint under node16 and
  // bundler too, which is the failure this gate exists to catch.
  //
  // Unlike the sibling this port came from, no entrypoint is excluded: both
  // `.` and `./integration` are compiled `.js` + `.d.ts`, which attw's
  // resolver understands completely.
  const attwBin = join(repoRoot, "node_modules", ".bin", "attw");
  run(step, attwBin, [tarballPath, "--profile", "esm-only"], { cwd: repoRoot });
}

/** Resolves (never evaluates) `specifier` from inside `installDir` — a bare
 * `node -e` child process, so it only sees what `require`/`import` resolution
 * from that sandbox's `node_modules` would see. Throws with the child's own
 * error text on any resolution failure (missing `exports` entry, or an
 * `exports` entry whose target file isn't actually in the tarball). */
function assertSubpathResolves(step, installDir, specifier) {
  const script = `
    const url = await import.meta.resolve(${JSON.stringify(specifier)});
    const { existsSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    if (!existsSync(fileURLToPath(url))) {
      throw new Error("resolved to " + url + " but that file does not exist");
    }
    console.log(url);
  `;
  const result = run(step, "node", ["--input-type=module", "-e", script], { cwd: installDir });
  return result.stdout.trim();
}

const PACKAGE_NAME = "@grimoire-rs/indexer";
// `files` ships `dist/` and `templates/`. `dist/` is compiled `.js` plus
// `.d.ts`, AND — copied verbatim by the build script — the renderer's own
// `.astro` and `.tsx` sources, which Astro compiles in the CONSUMER's build.
// Those are the files whose imports most need this gate: `lucide-preact`,
// `@mdi/js` and `preact` are runtime dependencies of a consumer's build, and
// moving any of them to `devDependencies` breaks every downstream index while
// leaving this repo's own lint, typecheck and tests green.
const SHIPPED_SOURCE_EXTENSIONS = new Set([".js", ".mjs", ".astro", ".tsx"]);
const DECLARATION_SUFFIXES = [".d.ts", ".d.mts"];

/** Recursively collects shipped source files under `dir` — anything with a
 * `SHIPPED_SOURCE_EXTENSIONS` extension, except `.d.ts`/`.d.mts` declaration
 * files (type-only; attw already covers type resolution). Sorted for
 * deterministic error messages; `readdirSync` order isn't guaranteed. */
function collectShippedSourceFiles(dir) {
  const files = [];
  const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
    a.name.localeCompare(b.name),
  );
  for (const entry of entries) {
    if (entry.name === "node_modules") continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectShippedSourceFiles(full));
      continue;
    }
    if (DECLARATION_SUFFIXES.some((suffix) => entry.name.endsWith(suffix))) continue;
    if (SHIPPED_SOURCE_EXTENSIONS.has(extname(entry.name))) files.push(full);
  }
  return files;
}

/** Strips line, block and `.astro` markup comments from `text`, replacing them with
 * whitespace so the rest of the file keeps its shape; string/template
 * literal contents pass through untouched. Without this, a prose comment
 * like "derived from 'upstream data'" would extract "upstream data" as a
 * bare import specifier and fail the gate on a phantom dependency — the
 * same false-positive class a `"http://…"` string inside a comment would
 * trigger against a naive `//`-strips-to-end-of-line regex.
 * ponytail: no regex-literal or nested-template-literal awareness (a real
 * ceiling of comment-stripping without a JS parser) — upgrade to a real
 * parser only if that ever produces a false positive here. */
function stripComments(text) {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const two = text.slice(i, i + 2);
    if (two === "//") {
      while (i < text.length && text[i] !== "\n") {
        out += " ";
        i++;
      }
    } else if (two === "/*") {
      out += "  ";
      i += 2;
      while (i < text.length && text.slice(i, i + 2) !== "*/") {
        out += text[i] === "\n" ? "\n" : " ";
        i++;
      }
      out += "  ";
      i += 2;
    } else if (text.slice(i, i + 4) === "<!--" && text.indexOf("-->", i + 4) !== -1) {
      // An `.astro` markup comment, and only a CLOSED one — the `indexOf`
      // guard matters because this branch runs on every shipped source file,
      // not just `.astro`. An unterminated `<!--` (a stray sequence in a `.ts`
      // file, where `a<!--b` is legal as `a < --b`) would otherwise blank the
      // rest of the file, hiding every import below it — a
      // dependency-completeness gate that silently stops looking is
      // indistinguishable from one that passed.
      //
      // Not optional prose-stripping: an ordinary apostrophe in a comment
      // ("the button's own label") reads as a string opener to the branch
      // below, which then runs to the next apostrophe anywhere in the file
      // and can swallow a real `/*` on the way — after which that block
      // comment's body is scanned as code.
      out += "    ";
      i += 4;
      while (i < text.length && text.slice(i, i + 3) !== "-->") {
        out += text[i] === "\n" ? "\n" : " ";
        i++;
      }
      out += "   ";
      i += 3;
    } else if (text[i] === "'" || text[i] === '"' || text[i] === "`") {
      const quote = text[i];
      out += text[i];
      i++;
      while (i < text.length && text[i] !== quote) {
        if (text[i] === "\\" && i + 1 < text.length) {
          out += text[i] + text[i + 1];
          i += 2;
          continue;
        }
        out += text[i];
        i++;
      }
      if (i < text.length) {
        out += text[i];
        i++;
      }
    } else {
      out += text[i];
      i++;
    }
  }
  return out;
}

/** Finds every `name(...)` call in `text` (`name` is `"import"` or
 * `"require"`) via a balanced-paren scan — a regex alone can't span nested
 * parens (e.g. `import(getPath())`). Returns `{ specifier }` when the whole
 * argument is a single plain quoted string literal, or `{ raw }` with the
 * verbatim argument text otherwise (a computed expression, which can't be
 * checked statically). */
function findCallSpecifiers(text, name) {
  const results = [];
  const calleeRe = new RegExp(`\\b${name}\\s*\\(`, "g");
  let match;
  while ((match = calleeRe.exec(text))) {
    const argStart = match.index + match[0].length;
    let depth = 1;
    let i = argStart;
    while (i < text.length && depth > 0) {
      if (text[i] === "(") depth++;
      else if (text[i] === ")") depth--;
      i++;
    }
    const raw = text.slice(argStart, i - 1).trim();
    const literal = /^(['"])((?:(?!\1)[^\\\n]|\\.)*)\1$/.exec(raw);
    results.push(literal ? { specifier: literal[2] } : { raw });
    calleeRe.lastIndex = i;
  }
  return results;
}

// `import ... from "spec"` / `export ... from "spec"` — both share the
// trailing ` from "spec"` shape, so one pattern covers both keywords.
const IMPORT_FROM = /\bfrom\s*(['"])((?:(?!\1)[^\\\n]|\\.)*)\1/g;
// Side-effect-only `import "spec"`.
const SIDE_EFFECT_IMPORT = /\bimport\s*(['"])((?:(?!\1)[^\\\n]|\\.)*)\1/g;

/** Extracts every import specifier from one shipped file's `text` (comments
 * already stripped by the caller). Returns the list of bare specifier
 * strings found via static `from`/side-effect syntax plus `import()`/
 * `require()` string-literal calls, and a separate list of human-readable
 * lines describing any dynamic `import()`/`require()` call whose argument
 * was a computed expression — those can't be resolved statically, and are
 * reported rather than silently dropped. */
function extractSpecifiers(relPath, text) {
  const specifiers = [];
  const unchecked = [];
  for (const re of [IMPORT_FROM, SIDE_EFFECT_IMPORT]) {
    re.lastIndex = 0;
    let match;
    while ((match = re.exec(text))) specifiers.push(match[2]);
  }
  for (const name of ["import", "require"]) {
    for (const call of findCallSpecifiers(text, name)) {
      if (call.specifier !== undefined) {
        specifiers.push(call.specifier);
      } else if (call.raw !== "") {
        unchecked.push(`${relPath}: ${name}(${call.raw}) — computed specifier, cannot check statically`);
      }
    }
  }
  return { specifiers, unchecked };
}

// Real npm scoped packages are always `@scope/name` — a bare `@word` with no
// slash can't be an installable dependency, so it must be a build-time
// virtual module, resolved only by a bundler plugin and never by node's own
// resolver.
const INVALID_SCOPED_SHAPE = /^@[^/]+$/;

/** True when `specifier` names something `dependencies`/`peerDependencies`
 * could actually satisfy — filters out relative/absolute paths, `node:`
 * imports, bare Node builtins, this package's own name (self-reference
 * resolves via its own `exports`, not a dependency), and virtual-module
 * specifiers that can never resolve outside a bundler. */
function isCheckableBareSpecifier(specifier) {
  if (specifier.startsWith(".") || specifier.startsWith("/")) return false;
  if (specifier.startsWith("node:")) return false;
  if (specifier === PACKAGE_NAME || specifier.startsWith(`${PACKAGE_NAME}/`)) return false;
  if (INVALID_SCOPED_SHAPE.test(specifier)) return false;
  // Virtual modules Astro injects into a build (`astro:components`,
  // `astro:content`, `astro:assets`). Host-supplied, never installable, and
  // `import.meta.resolve` rejects the scheme outright.
  if (specifier.startsWith("astro:")) return false;
  // Build-time aliases the renderer defines for a consumer's overlay
  // (`vite.resolve.alias` in src/renderer/index.ts). Vite rewrites them; no
  // node resolver ever sees one, and neither names an installable package.
  if (specifier.startsWith("@grim/") || specifier.startsWith("@grim-original/")) return false;
  const packageRoot = specifier.startsWith("@")
    ? specifier.split("/").slice(0, 2).join("/")
    : specifier.split("/")[0];
  if (builtinModules.includes(packageRoot)) return false;
  return true;
}

/** Proves every import reachable from the shipped `src/**` (as it landed in
 * the sandbox, under `node_modules/@grimoire-rs/indexer`) resolves from
 * `dependencies`/`peerDependencies` alone (see file docblock step 6). Reuses `installDir`; does not create its own
 * sandbox. */
function assertDependencyCompleteness(step, installDir) {
  const packageDir = join(installDir, "node_modules", "@grimoire-rs", "indexer");
  const files = collectShippedSourceFiles(packageDir);

  const specifierToFile = new Map();
  for (const file of files) {
    const relPath = relative(packageDir, file);
    const text = stripComments(readFileSync(file, "utf8"));
    const { specifiers, unchecked } = extractSpecifiers(relPath, text);
    for (const line of unchecked) {
      process.stderr.write(`pack-smoke: unchecked dynamic import — ${line}\n`);
    }
    for (const specifier of specifiers) {
      if (!isCheckableBareSpecifier(specifier)) continue;
      if (!specifierToFile.has(specifier)) specifierToFile.set(specifier, relPath);
    }
  }

  const specifiers = [...specifierToFile.keys()];
  const script = `
    const specifiers = ${JSON.stringify(specifiers)};
    const { existsSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const failures = [];
    for (const specifier of specifiers) {
      try {
        const url = await import.meta.resolve(specifier);
        if (!existsSync(fileURLToPath(url))) {
          failures.push({ specifier, reason: "resolved to " + url + " but that file does not exist" });
        }
      } catch (err) {
        failures.push({ specifier, reason: err instanceof Error ? err.message : String(err) });
      }
    }
    console.log(JSON.stringify(failures));
  `;
  const result = run(step, "node", ["--input-type=module", "-e", script], { cwd: installDir });
  const failures = JSON.parse(result.stdout.trim());
  if (failures.length > 0) {
    const lines = failures.map(
      (f) => `  - "${f.specifier}" (from ${specifierToFile.get(f.specifier)}): ${f.reason}`,
    );
    throw new Error(
      `${step}: ${String(failures.length)} import specifier(s) don't resolve from the packed ` +
        `sandbox — add the missing package to "dependencies" or "peerDependencies" (never ` +
        `"devDependencies", which the sandbox never installs):\n${lines.join("\n")}`,
    );
  }
  process.stderr.write(
    `pack-smoke: dependency-completeness OK (${String(specifiers.length)} bare specifiers from ` +
      `${String(files.length)} shipped files all resolve)\n`,
  );
}

function installAndRunBin(step, tarballPath) {
  const installDir = mkdtempSync(join(tmpdir(), "grim-indexer-pack-smoke-install-"));
  try {
    // A bare `npm install <tarball>` in a directory with no package.json of
    // its own walks up to the nearest ancestor package.json (this repo's)
    // and installs there instead — writing an `--ignore-scripts` sandbox
    // package.json pins the install to installDir.
    writeFileSync(
      join(installDir, "package.json"),
      JSON.stringify({ name: "grim-indexer-pack-smoke-sandbox", private: true }),
    );
    run(step, "npm", ["install", "--ignore-scripts", tarballPath], { cwd: installDir });
    const binPath = join(installDir, "node_modules", ".bin", "grim-indexer");
    const result = run(step, binPath, ["--version"], { cwd: installDir });
    const stdout = result.stdout.trim();
    const expectedVersion = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")).version;
    if (stdout !== expectedVersion) {
      throw new Error(
        `${step}: expected installed bin to print "${expectedVersion}", got "${stdout}"`,
      );
    }
    // Both published entrypoints. `./integration` is what a consumer index
    // imports from its own `astro.config`, and it is the one nothing else in
    // this repo's gate ever loads from a packed tarball.
    for (const specifier of [PACKAGE_NAME, `${PACKAGE_NAME}/integration`]) {
      const url = assertSubpathResolves(step, installDir, specifier);
      process.stderr.write(`pack-smoke: "${specifier}" resolves to ${url}\n`);
    }
    assertDependencyCompleteness(step, installDir);
  } finally {
    rmSync(installDir, { recursive: true, force: true });
  }
}

/** Opt-in (`GRIM_INDEXER_PACK_SMOKE_NETWORK=1`): the stricter manifest
 * normalization `npm publish` applies but `npm pack` does not — verified
 * empirically to require live registry connectivity (hangs rather than
 * failing fast against an unreachable registry), so this never runs as part
 * of the default, offline `npm test` path. `release.yml` carries the
 * non-optional copy of this same guard at actual release time.
 *
 * Deliberately run from `repoRoot` with NO tarball/path argument — verified
 * empirically that `npm publish <tarball-path> --dry-run` skips this
 * normalization pass entirely (it never reproduced the real bin-path bug
 * this guard exists to catch), while the bare `npm publish --dry-run` this
 * uses (reading `package.json` from cwd directly, same as `release.yml`'s
 * own publish step) does. */
function runPublishDryRunGuard(step) {
  if (process.env.GRIM_INDEXER_PACK_SMOKE_NETWORK !== "1") {
    process.stderr.write(
      `${step}: skipped (needs registry network access — set GRIM_INDEXER_PACK_SMOKE_NETWORK=1 to ` +
        `enable; release.yml's own dry-run guard always runs this check at release time)\n`,
    );
    return;
  }
  const result = spawnSync("npm", ["publish", "--dry-run", "--provenance", "--access", "public"], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  if (result.error) {
    throw new Error(`${step}: failed to spawn "npm": ${result.error.message}`);
  }
  const outputs = [result.stdout, result.stderr];
  // The manifest normalization this guard reads happens BEFORE the registry
  // rejects the version, so the output is still the evidence we need — scan it
  // first, whatever the exit status was.
  assertNoAutoCorrect(step, outputs);
  if (result.status !== 0) {
    // Between a release and the next version bump, package.json names a
    // version that is already on the registry, so this dry-run can only ever
    // fail with E403 — on every CI run of every PR, for a reason that has
    // nothing to do with the packed artifact. That one rejection is expected
    // and non-fatal (the normalization pass above already ran); anything else
    // is a real failure.
    if (outputs.some((output) => ALREADY_PUBLISHED.test(output))) {
      process.stderr.write(
        `${step}: registry rejected the dry-run because ${pkgVersion()} is already published — ` +
          `expected on a non-release commit; the manifest-normalization check above still ran\n`,
      );
      return;
    }
    throw new Error(
      `${step}: "npm publish --dry-run" exited ${String(result.status)}\n` +
        `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );
  }
}

function main() {
  const { version: npmVersion, major: npmMajor } = assertNpmMajor();
  process.stderr.write(`pack-smoke: running under npm ${npmVersion} (major ${String(npmMajor)})\n`);

  const packDir = mkdtempSync(join(tmpdir(), "grim-indexer-pack-smoke-pack-"));
  try {
    const tarballPath = packTarball("npm pack", packDir);
    runPublint("publint", tarballPath);
    runAttw("attw", tarballPath);
    installAndRunBin("install + run bin", tarballPath);
    runPublishDryRunGuard("npm publish --dry-run");
  } finally {
    rmSync(packDir, { recursive: true, force: true });
  }
}

try {
  main();
  process.stderr.write("pack-smoke: OK\n");
  process.exitCode = 0;
} catch (err) {
  process.stderr.write(`pack-smoke: FAILED — ${err instanceof Error ? err.message : String(err)}\n`);
  process.exitCode = 1;
}
