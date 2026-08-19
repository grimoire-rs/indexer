// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Grimoire Authors

/**
 * The in-memory `RatingProvider` — the primary local test seam.
 *
 * It proves the reconcile logic with no network and no fixtures: threads live
 * in an array, `create` appends to it, and the next `listAuthored` sees them.
 * That is what makes "a rerun is idempotent" a thing a test can assert rather
 * than a thing a comment claims.
 *
 * R-1 is not re-applied here. Every thread the fake holds is one it authored,
 * which is exactly the post-R-1 state a live provider hands back.
 */

import { RateLimited, type RatingProvider, type RatingThread } from "./provider.js";

export interface MemoryProviderOptions {
  /** Threads already on the fake forge. Repeat a `ref` to stage a conflict. */
  threads?: RatingThread[];
  /** Stop the listing pass after this many threads and raise a rate limit. */
  listLimit?: number;
  /** Raise a rate limit on the create after this many succeeded. */
  createLimit?: number;
}

export interface MemoryProvider extends RatingProvider {
  /** Live view of the fake forge — assert on it after a run. */
  readonly threads: RatingThread[];
  /** Targets of threads created with locking asked for. */
  readonly locked: string[];
}

export function memoryProvider(options: MemoryProviderOptions = {}): MemoryProvider {
  const threads = options.threads ?? [];
  const locked: string[] = [];
  // The fake's limits are per-run, and a run always starts by listing — so the
  // create counter resets there rather than needing a separate reset call.
  let created = 0;

  return {
    threads,
    locked,

    listAuthored() {
      created = 0;
      const { listLimit } = options;
      if (listLimit !== undefined && listLimit < threads.length) {
        return Promise.reject(
          new RateLimited("memory: secondary rate limit while listing", 60_000, threads.slice(0, listLimit)),
        );
      }
      return Promise.resolve([...threads]);
    },

    create(ref) {
      if (options.createLimit !== undefined && created >= options.createLimit) {
        return Promise.reject(new RateLimited("memory: secondary rate limit while creating", 60_000));
      }
      created += 1;
      const thread: RatingThread = {
        ref,
        target: `t-${ref}`,
        url: `https://forge.example/${ref}`,
        up: 0,
      };
      threads.push(thread);
      locked.push(thread.target);
      return Promise.resolve(thread);
    },
  };
}
