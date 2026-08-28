// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Grimoire Authors

// Page size, alone in a module because of *where* it is read.
//
// `provider.ts` and the two implementations form a deliberate cycle: the
// factory imports both providers, and both import the shared plumbing back.
// `provider.ts` states the rule that makes that safe -- everything crossing the
// cycle is a hoisted function declaration, referenced only from inside a
// closure -- and a `const` interpolated into a module-level query string is
// precisely the case the rule excludes.
//
// It was declared in `provider.ts` and read at module scope by both providers,
// which the factory imports before it reaches the declaration. Under Node's ESM
// that is a temporal dead zone and every `ratings` run died on import; under
// Vitest's SSR transform the same read is a property access on a
// not-yet-populated namespace, so it quietly yielded `undefined` and shipped
// `first:undefined` in the query while 24 provider tests passed.
//
// Living here, the constant does not cross the cycle at all, so the rule holds
// by construction instead of by remembering it.

/**
 * Nodes per page.
 *
 * 50 rather than the API maximum of 100. This used to be a workaround for
 * `request()`'s fixed 1 MiB cap — a page carries every thread's full body,
 * including bodies this bot did not write, so a container holding long human
 * threads overran the cap and [`graphql`] reported it as a transport failure.
 * That was a real failure on first runs, before any bot thread existed.
 *
 * The cap is now per-call (`LARGE_RESPONSE_BYTES`), so the size argument for
 * keeping this at 50 is gone. It stays at 50 anyway: raising it changes request
 * count and cursor behaviour for every existing index, which is a separate
 * decision from fixing the overrun.
 */
export const PAGE_SIZE = 50;
