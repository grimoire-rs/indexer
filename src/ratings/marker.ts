// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Grimoire Authors

/**
 * Invariant R-1 — marker authority.
 *
 * A `<!-- grim-ref: <ref> -->` marker binds `ref → thread` only when all four
 * clauses hold: it is in the body of a top-level thread (never a comment,
 * reply or note); the author's *account id* is registered in
 * `index-policy.json`'s `trustedBots[].id`; it is the first anchored match in
 * that body; and the thread still lives in the configured container — the
 * repository/project id *and* the category or work-item type, compared by
 * immutable id, never by name. A ref bound by more than one authorized thread
 * is a conflict and contributes nothing.
 *
 * Pure, and separate from the providers because the rule must be enforced
 * identically on both forges — two copies is how one of them drifts. The
 * providers apply it inside `listAuthored()`, so no caller can receive an
 * unauthorized thread and forget to filter it.
 */

import type { TrustedBot } from "../validate/core/ownership.js";

/** What R-1 compares against: the registered bots and the configured container. */
export interface MarkerPolicy {
  /**
   * `index-policy.json`'s `trustedBots`. Read for ids only — the bare-string
   * form and the object form without an `id` are login-only and authorize
   * nothing here, because clause 2 has an account id and no login in hand.
   */
  trustedBots?: readonly TrustedBot[];
  /** GitHub `repository.id` / GitLab `project.id`. */
  containerId: string;
  /** GitHub discussion category id / GitLab work-item type id. */
  categoryId: string;
}

/** A forge thread as observed, before R-1 has ruled on it. */
export interface ObservedThread {
  /** Opaque forge node id the vote mutation targets. */
  target: string;
  url: string;
  /** The forge's own upvote counter. */
  up: number;
  body: string;
  /** Absent when the forge reports no author — a deleted account. */
  authorId?: string;
  containerId: string;
  categoryId: string;
  /**
   * Replies, comments or notes. Carried so clause 1 is enforced *here* rather
   * than by each provider remembering not to pass them: this module never
   * reads them, and an attacker's reply is the forgery clause 1 exists for.
   */
  comments?: readonly { body: string; authorId?: string }[];
}

/** A thread R-1 accepted. Structurally the provider's `RatingThread`. */
export interface AuthorizedThread {
  ref: string;
  target: string;
  url: string;
  up: number;
}

/** A ref claimed by more than one authorized thread. Contributes zero votes. */
export interface RefConflict {
  ref: string;
  urls: string[];
}

export interface Resolution {
  /** Refs bound by exactly one authorized thread. */
  bound: Map<string, AuthorizedThread>;
  conflicts: RefConflict[];
}

/**
 * Anchored: the whole line and nothing else. Not because an unanchored pattern
 * is exploitable while clause 2 holds — an attacker's content is never parsed
 * as a marker source — but because an unanchored parser is a parser-
 * differential bug waiting for the day someone relaxes clause 2.
 */
const MARKER_LINE = /^<!-- grim-ref: (\S+) -->$/;

/**
 * A fence opener or closer: the run of `` ` `` or `~` and whatever follows it.
 *
 * CommonMark closes a fence only with **the same character**, in a run at
 * least as long as the opener — so a `~~~` inside a ``` block is ordinary
 * text, not a close. A boolean toggle gets that wrong in the direction that
 * matters: ``` then `~~~` then a marker would read the marker as unfenced and
 * bind it.
 */
const FENCE = /^\s{0,3}(`{3,}|~{3,})/;

/**
 * The marker line for `ref`.
 *
 * Defence in depth against the injection `desiredRefs` already rejects at
 * ingest: this function composes the body that {@link parseMarkerRef} later
 * reads back, so a `ref` carrying a newline, a space, or a `-->` would author
 * a *second* marker line under the bot's own identity — and every R-1 clause
 * would pass it, because they constrain who wrote the body and where the
 * thread lives, never what is in it. A ref that does not round-trip through
 * the marker grammar is refused here rather than published.
 *
 * @throws {RangeError} when `ref` cannot survive its own marker.
 */
export function buildMarker(ref: string): string {
  const line = `<!-- grim-ref: ${ref} -->`;
  if (MARKER_LINE.exec(line)?.[1] !== ref) {
    throw new RangeError(
      `refusing to build a rating marker for ${JSON.stringify(ref)}: it does not round-trip through the marker grammar`,
    );
  }
  return line;
}

/**
 * The first anchored marker in a body, by lowest byte offset — clause 3.
 *
 * Scanned line by line rather than with a `/m` regex: `^`/`$` alone would
 * accept a marker sitting at column 0 inside a fenced code block, and would
 * reject every marker in a CRLF body — which is what GitHub hands back for a
 * discussion it stored. An unterminated fence swallows the rest of the body;
 * that fails closed, which is the direction this rule errs in.
 */
export function parseMarkerRef(body: string): string | null {
  // The open fence's delimiter run, or null outside a fence. Tracked as the
  // run itself rather than a boolean so a different fence character, or a
  // shorter run of the same one, cannot close it (CommonMark 4.5).
  let open: string | null = null;
  for (const line of body.split(/\r?\n/)) {
    const fence = FENCE.exec(line)?.[1];
    if (fence) {
      if (open === null) {
        open = fence;
        continue;
      }
      if (fence[0] === open[0] && fence.length >= open.length) {
        open = null;
      }
      // A non-matching run inside a fence is content, and content is never
      // a marker source.
      continue;
    }
    if (open !== null) continue;
    const ref = MARKER_LINE.exec(line)?.[1];
    if (ref) return ref;
  }
  return null;
}

/**
 * Is this author one of the registered bots? Clause 2, keyed by account id.
 *
 * `findTrustedBot` cannot serve this — it is login-keyed, and R-1 has an id
 * and no login. An entry without an `id` is skipped, never read as a wildcard;
 * an author without an id matches nothing, so a deleted account and an
 * unpinned entry cannot meet in the middle as `undefined === undefined`.
 */
function authorIsTrustedBot(
  bots: readonly TrustedBot[] | undefined,
  authorId: string | undefined,
): boolean {
  if (authorId === undefined) return false;
  return (bots ?? []).some(
    // `index-policy.json` is hand-written and `id` is *typed* string but never
    // validated at runtime, so an operator who writes `"id": 99` — which this
    // repo's own fixtures do — used to fail `99 === "99"` on every thread,
    // authorize nothing, and publish an empty rating set. Compare in string
    // space so the natural thing to type works. A value that is not
    // id-shaped still matches nothing, which is the safe direction.
    (bot) => typeof bot !== "string" && bot.id !== undefined && String(bot.id) === authorId,
  );
}

/** Apply R-1 to one observed thread. `null` means it binds nothing. */
export function authorizeThread(
  thread: ObservedThread,
  policy: MarkerPolicy,
): AuthorizedThread | null {
  // Clause 4, two independent equalities: a transfer moves the container id, a
  // discussion→issue conversion moves the category. Either alone disqualifies.
  if (thread.containerId !== policy.containerId) return null;
  if (thread.categoryId !== policy.categoryId) return null;
  if (!authorIsTrustedBot(policy.trustedBots, thread.authorId)) return null;
  // Clause 1: the thread's own body. `thread.comments` is deliberately unread.
  const ref = parseMarkerRef(thread.body);
  if (ref === null) return null;
  return { ref, target: thread.target, url: thread.url, up: thread.up };
}

/**
 * Group authorized threads by ref. A ref claimed twice is ambiguous, and
 * silently picking one would let a second thread quietly retarget a popular
 * artifact's votes — so it contributes zero and the operator is told to delete
 * all but one.
 */
export function resolveConflicts(threads: readonly AuthorizedThread[]): Resolution {
  const byRef = new Map<string, AuthorizedThread[]>();
  for (const thread of threads) {
    const group = byRef.get(thread.ref);
    if (group) group.push(thread);
    else byRef.set(thread.ref, [thread]);
  }

  const bound = new Map<string, AuthorizedThread>();
  const conflicts: RefConflict[] = [];
  for (const [ref, group] of byRef) {
    const only = group.length === 1 ? group[0] : undefined;
    if (only) bound.set(ref, only);
    else conflicts.push({ ref, urls: group.map((thread) => thread.url) });
  }
  return { bound, conflicts };
}

export function conflictWarning(conflict: RefConflict): string {
  return `ratings: ref ${conflict.ref} bound by ${conflict.urls.length} threads: ${conflict.urls.join(", ")} — delete all but one`;
}
