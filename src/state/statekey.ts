// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Grimoire Authors

// The build-state cache key. One home for the grammar: the CLI and the CI
// renderer both import it, so a hostile plane epoch cannot reach
// `GITHUB_OUTPUT` through a second, looser copy.

/** `<epoch>-<blobs>`: a safe-integer epoch, then the plane's blob digest. */
export const STATE_KEY_RE = /^[0-9]{1,16}-[0-9a-f]{64}$/;

/** An epoch older than this renews, and the cold build that follows is the point. */
export const EPOCH_RENEW_SECONDS = 7 * 24 * 60 * 60;

/** Clock skew allowed to an epoch ahead of now; the same day the root's generation gets. */
const EPOCH_SKEW_SECONDS = 24 * 60 * 60;

/**
 * The epoch for this run: `nowSeconds` when `renew` (`--fresh`, `--purge`) or
 * when `published` (the plane's `state_epoch`, untrusted) is absent, older
 * than `EPOCH_RENEW_SECONDS` or more than a day ahead of the clock (a future
 * epoch would otherwise never rotate); otherwise `published`. Throws on a published
 * value that is not a safe non-negative integer, `renew` or not.
 */
export function nextEpoch(published: unknown, nowSeconds: number, renew: boolean): number {
  if (published !== undefined && !(typeof published === "number" && Number.isSafeInteger(published) && published >= 0)) {
    throw new Error(`state_epoch ${JSON.stringify(published)} is not a non-negative safe integer`);
  }
  return renew || published === undefined || nowSeconds - published > EPOCH_RENEW_SECONDS || published > nowSeconds + EPOCH_SKEW_SECONDS ? nowSeconds : published;
}

/** `<epoch>-<blobs>`, checked against `STATE_KEY_RE` before it is returned. */
export function formatKey(epoch: number, blobs: string): string {
  const key = `${epoch}-${blobs}`;
  if (!STATE_KEY_RE.test(key)) throw new Error(`state key ${JSON.stringify(key)} does not match ${STATE_KEY_RE}`);
  return key;
}
