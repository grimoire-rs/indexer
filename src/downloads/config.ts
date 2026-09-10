// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Grimoire Authors

// The `downloads` block of `index.config.json`, read the same way
// `src/ratings/config.ts` reads its own: a fourth independent reader of one
// shared file, each able to fail on its own block in its own words.
//
// One key, and deliberately one. The Artifactory repository key and the image
// path both come from the ref itself (see `src/downloads/artifactory.ts`), so
// there is no lookup map to configure and nothing to keep in step with
// `index/**`. The block exists to name the REST base and to be the on/off
// switch — an absent block is how download counts stay off.
import fs from "node:fs/promises";
import path from "node:path";

import { CONFIG_FILE, SiteConfigError } from "../config.js";

/**
 * The `downloads` block, with every gap filled. Absent means the feature is
 * off — that is the *absence* of this value, not a variant of it.
 */
export interface DownloadsConfig {
  /**
   * The Artifactory REST root — `https://artifactory.example.com/artifactory`,
   * no trailing slash. Required, https only.
   *
   * Named rather than derived from the ref host because the two genuinely
   * differ: a ref's host is where the OCI client pulls from, and this is where
   * `/api/search/aql` lives. It is also the **only** host this producer ever
   * dials. Nothing derived from a contributor-supplied ref becomes a URL, so a
   * hostile `ref` cannot steer CI anywhere (the SSRF ordering `registryHostReason`
   * enforces for the registry calls is structural here instead).
   */
  baseUrl: string;
  /**
   * The JFrog OIDC **identity mapping** name, when CI should exchange its own
   * id-token for a short-lived Artifactory token instead of carrying a stored
   * secret. Optional; absent means the generated job reads
   * `GRIM_DOWNLOADS_TOKEN` from a secret instead.
   *
   * GitHub only, and not an oversight: the exchange is one action there
   * (`jfrog/setup-jfrog-cli`, which takes exactly this name), where GitLab
   * would need the token exchange written out by hand. The GitLab job takes
   * the masked-variable route.
   */
  oidcProvider?: string;
}

function fail(msg: string): never {
  throw new SiteConfigError(`${CONFIG_FILE}: downloads.${msg}`);
}

/**
 * Validate the `downloads` block of an already-parsed config object.
 *
 * Absent (or `null`) ⇒ `undefined` ⇒ download counts off. Unknown keys are
 * ignored, the same forward-compatibility rule `stats.json` itself follows.
 */
export function validateDownloads(raw: unknown): DownloadsConfig | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new SiteConfigError(`${CONFIG_FILE}: downloads must be an object`);
  }
  const downloads = raw as Record<string, unknown>;

  if (typeof downloads.baseUrl !== "string" || downloads.baseUrl.trim() === "") {
    fail("baseUrl must be a non-empty string - the Artifactory REST root, e.g. https://artifactory.example.com/artifactory");
  }
  // Trailing slashes stripped once, here, so no call site has to wonder.
  const baseUrl = downloads.baseUrl.trim().replace(/\/+$/, "");
  if (!baseUrl.startsWith("https://")) {
    fail("baseUrl must be https - the reply decides every published download count");
  }
  try {
    new URL(baseUrl);
  } catch {
    fail(`baseUrl is not a URL (${JSON.stringify(downloads.baseUrl)})`);
  }

  if (downloads.oidcProvider !== undefined) {
    if (typeof downloads.oidcProvider !== "string" || downloads.oidcProvider.trim() === "") {
      fail("oidcProvider must be a non-empty string - the OIDC identity mapping name in the JFrog platform");
    }
    // It is interpolated into generated YAML. The grammar JFrog accepts for a
    // mapping name is narrower than this, but this is the part that matters:
    // nothing here can close a quote or start a new line.
    if (!/^[A-Za-z0-9._-]+$/.test(downloads.oidcProvider)) {
      fail("oidcProvider may only contain letters, digits, dot, underscore and hyphen");
    }
  }

  // Built key by key rather than spread, so an unknown key is ignored in the
  // strong sense — it cannot reach a consumer that happens to look for it.
  return downloads.oidcProvider === undefined
    ? { baseUrl }
    : { baseUrl, oidcProvider: downloads.oidcProvider };
}

/**
 * Read the `downloads` block out of `index.config.json`. A missing file, or a
 * file with no `downloads` block, means download counts are off.
 */
export async function loadDownloadsConfig(root: string): Promise<DownloadsConfig | undefined> {
  let text: string;
  try {
    text = await fs.readFile(path.join(root, CONFIG_FILE), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch (err) {
    throw new SiteConfigError(`${CONFIG_FILE}: ${(err as Error).message}`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new SiteConfigError(`${CONFIG_FILE}: must contain a JSON object`);
  }
  return validateDownloads((parsed as Record<string, unknown>).downloads);
}
