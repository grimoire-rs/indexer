// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Grimoire Authors

// One row of the table view.
//
// Its own file so an index can replace the row without owning `Catalog.tsx`
// and its sorting, filtering, keyboard and URL-state machinery. Unlike the
// `.astro` components, this one takes props — a Preact component in a
// hydrated island cannot read the build-time payload — so its props ARE a
// contract, and they are the reason component overrides are documented as
// unstable for now.
import { ArrowBigUp, ArrowDownToLine } from "lucide-preact";
import { CardLogo } from "./CardLogo.js";
import { DEPRECATED_MARK, KIND_MARKS, KindMark } from "./KindMark.js";
import { withBase } from "../lib/base.js";
import {
  compactCount,
  exactCount,
  lastUpdated,
  timeAgo,
  type CardPackage,
} from "../lib/catalog.js";

export interface PackageRowProps {
  pkg: CardPackage;
  /** Whether this index publishes ratings at all — decided once, not per row. */
  hasRatings: boolean;
  /** Same, for download counts. Only an Artifactory-backed index has any. */
  hasDownloads: boolean;
  /** The catalog's own arrow-key navigation. */
  onKeyDown: (event: KeyboardEvent) => void;
}

export function PackageRow({ pkg: p, hasRatings, hasDownloads, onKeyDown }: PackageRowProps) {
  const at = lastUpdated(p);
  const ago = at && timeAgo(at) ? timeAgo(at) : null;
  return (
      <a
              class="row"
        data-slot="package-row"
        href={withBase(`/p/${p.namespace}/${p.name}/`)}
        // The full identity, since the visible name is clipped and the
        // namespace is not shown at all.
        title={`${p.namespace}/${p.name}`}
        onKeyDown={onKeyDown}
      >
        {/* The same tile the card shows, at a row's height. It goes in a
            column of its own rather than beside the name so it stays a
            slot the eye tracks down — and `CardLogo` already answers the
            three states a logo has here (missing, loading, declared but
            unreachable), so the column is never ragged. */}
        <span class="t-logo">
          <CardLogo pkg={p} />
        </span>
        {/* The kind as its mark, not as its word — the same glyph the
            card wears in its corner and the same one the VS Code
            extension puts on its cards, in the kind's own colour.

            Which is also how deprecation is said here: a retired package
            shows the warning mark in the deprecation colour instead of
            its kind, exactly as the card's watermark does. The badge this
            replaces was a second word in a cell with room for none, and
            it widened the column for every row whether or not anything in
            view was retired.

            The word is not lost — it names the mark, so it is read out,
            and the `title` sits on the cell rather than on the `<svg>`:
            an SVG takes its tooltip from a `<title>` child, and a `title`
            attribute on it does nothing at all. */}
        {(() => {
          const mark = p.deprecated ? DEPRECATED_MARK : KIND_MARKS[p.kind];
          const label = p.deprecated ? `${p.kind}, deprecated` : p.kind;
          return (
            <span
              class="t-kind"
              data-slot="package-kind"
              title={label}
              style={{
                color: p.deprecated
                  ? "var(--grim-color-deprecated)"
                  : `var(--grim-color-kind-${p.kind}, var(--grim-color-muted))`,
              }}
            >
              {mark ? (
                <KindMark
                  glyph={mark}
                  size={16}
                  role="img"
                  aria-label={label}
                />
              ) : (
                // An unknown kind has no mark, and inventing one would be
                // a claim. It keeps the word it always had.
                <span class="t-kind-word">{label}</span>
              )}
            </span>
          );
        })()}
        {/* The name alone. The namespace used to sit beside it and was
            what pushed this cell onto a second line — and it is not worth
            a column of its own here, where the kind already answers "what
            is this" and the description answers "about what". It rides in
            the row's tooltip instead, with the full name, which is also
            what the ellipsis costs the reader. */}
        <span class="t-name" data-slot="package-name">
          {p.name}
        </span>
        <span class="t-desc">{p.description}</span>
        <span class="t-updated" data-slot="package-meta">
          {ago && at && (
            <time datetime={at} title={at}>
              {ago}
            </time>
          )}
        </span>
        {hasDownloads && (
          // Same shape as the rating cell beside it, and for the same reason:
          // a fixed right-aligned box so the glyph lands in one place down the
          // column whatever the count is. The figure is abbreviated because
          // these run to seven digits; the exact number is in the `title`.
          <span class="t-downloads">
            {p.downloads && (
              <>
                <span class="t-count" title={`${exactCount(p.downloads.total)} downloads`}>
                  {compactCount(p.downloads.total)}
                </span>
                <ArrowDownToLine size={13} aria-hidden="true" />
              </>
            )}
          </span>
        )}
        {hasRatings && (
          // Count first, arrow after it, both held at the right edge.
          // The count sits in a fixed right-aligned box, so the digits
          // stack into a column and the arrow after them lands in the
          // same place on every row whatever the count is. An unrated
          // package keeps the empty cell: the column is a slot the eye
          // tracks down, and a row that skips it breaks the run.
          <span class="t-rating">
            {p.rating && (
              <>
                <span class="t-votes">{p.rating.up}</span>
                <ArrowBigUp size={13} aria-hidden="true" />
              </>
            )}
          </span>
        )}
      </a>
  );
}
