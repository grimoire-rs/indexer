// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Grimoire Authors

// `grim-indexer state-key` (IX-R27): the CI cache key of the build state, on
// stdout and nowhere else. CI writes whatever this prints into `GITHUB_OUTPUT`,
// so a failure prints nothing and exits non-zero (a cold build with no save),
// and the key is checked against `STATE_KEY_RE` before it leaves the process.
// The epoch rules live in `state/statekey.ts`.
import path from "node:path";

import { sha256Hex } from "../emit/digest.js";
import { fetchPlaneFile } from "../emit/publish-plane.js";
import { anchorSite, readRootStrict, type RootRead } from "../state/anchor.js";
import { readHandoff } from "../state/handoff.js";
import { asIndex } from "../state/restore.js";
import { STATE_KEY_RE, formatKey, nextEpoch } from "../state/statekey.js";
import { CliError, EXIT, type ExitCode } from "./exit.js";

export interface StateKeyFlags {
  /** `--next`: the key of the hand-off, read offline. */
  next?: boolean;
}

/**
 * `<blobs>` of a key with no published plane: the digest of the empty blob set,
 * `sha256("")`, which is what `emitPlane` computes for a plane that holds no
 * blob. The epoch is the current second, so the key matches no saved entry and
 * the first build still saves.
 */
const EMPTY_BLOBS = sha256Hex("");

/** Print `key` as one line, after the grammar check that guards `GITHUB_OUTPUT`. */
function print(key: string): ExitCode {
  if (!STATE_KEY_RE.test(key)) throw new CliError(`state-key: ${JSON.stringify(key)} is not a well-formed key`, EXIT.data);
  console.log(key);
  return EXIT.ok;
}

async function readRoot(site: string): Promise<RootRead> {
  try {
    return await readRootStrict(site);
  } catch (err) {
    // `request` should report a dead socket as status 0; a throw must not become a stack trace.
    throw new CliError(`state-key: could not read ${site}/c/root.json (${err instanceof Error ? err.message : String(err)})`, EXIT.unavailable);
  }
}

/** The key for the plane the published root names, or a fresh one when none is published. */
async function publishedKey(site: string, nowSeconds: number): Promise<string> {
  const read = await readRoot(site);
  if (read.kind === "unreadable") throw new CliError(`state-key: could not read ${site}/c/root.json (${read.why})`, EXIT.unavailable);
  if (read.kind === "invalid") throw new CliError(`state-key: ${site}/c/root.json is not a root`, EXIT.data);
  const ref = read.kind === "root" ? read.root.planes.enrich : null;
  if (ref === null) return formatKey(nowSeconds, EMPTY_BLOBS);

  const got = await fetchPlaneFile(site, "p", ref);
  if (got.kind === "missing") throw new CliError("state-key: the root names an enrich plane index that is not published", EXIT.unavailable);
  if (got.kind === "error") throw new CliError(`state-key: could not read the enrich plane index (${got.reason})`, EXIT.unavailable);

  // `asIndex` drops a bad epoch to "absent", which would mint a new one; this command refuses it instead.
  let doc: { state_epoch?: unknown; blobs?: unknown };
  try {
    doc = JSON.parse(got.bytes.toString("utf8")) as typeof doc;
  } catch {
    throw new CliError("state-key: the enrich plane index is not JSON", EXIT.data);
  }
  if (asIndex(got.bytes) === null || typeof doc.blobs !== "string") throw new CliError("state-key: the enrich plane index is not a valid index", EXIT.data);
  try {
    return formatKey(nextEpoch(doc.state_epoch, nowSeconds, false), doc.blobs);
  } catch (err) {
    throw new CliError(`state-key: ${err instanceof Error ? err.message : String(err)}`, EXIT.data);
  }
}

export async function stateKey(root: string, flags: StateKeyFlags): Promise<ExitCode> {
  const rootDir = path.resolve(root);
  if (flags.next === true) {
    const handoff = readHandoff(rootDir);
    if (handoff === null) throw new CliError("state-key --next: no usable hand-off under .grim-index-state/out — run `enrich` first", EXIT.unavailable);
    return print(handoff.next_key);
  }

  const { loadConfig } = await import("../config.js");
  // `loadConfig`, never `resolveConfig`: the default `site` names somebody else's index.
  const site = anchorSite((await loadConfig(rootDir)).site);
  if (site === undefined) throw new CliError("state-key: `site` in index.config.json is missing or not https (or loopback http)", EXIT.data);
  return print(await publishedKey(site, Math.floor(Date.now() / 1000)));
}
