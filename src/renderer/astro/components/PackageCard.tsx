// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Grimoire Authors

// One card of the grid view.
//
// Its own file so an index can replace the card without owning `Catalog.tsx`
// and its sorting, filtering, keyboard and URL-state machinery. Unlike the
// `.astro` components, this one takes props — a Preact component in a
// hydrated island cannot read the build-time payload — so its props ARE a
// contract, and they are the reason component overrides are documented as
// unstable for now.
import { ArrowBigUp, ArrowDownToLine } from "lucide-preact";
import { mdiMicrosoftVisualStudioCode } from "@mdi/js";
import { BrandMark } from "./BrandMark.js";
import { CardLogo } from "./CardLogo.js";
import { CopyButton } from "./CopyButton.js";
import { withBase } from "../lib/base.js";
import {
  compactCount,
  exactCount,
  lastUpdated,
  timeAgo,
  vscodeUrl,
  type CardPackage,
} from "../lib/catalog.js";

export interface PackageCardProps {
  pkg: CardPackage;
  /**
   * `publisher.extension` id behind the deep links, or `null`. A prop rather
   * than a `lib/data` read: this island hydrates in the browser, and importing
   * the build-time payload here would ship the whole catalog twice.
   */
  vscodeExtension: string | null;
  /** Keyword facets currently applied, so a chip can render itself pressed. */
  activeKeywords: string[];
  /** Apply or clear one keyword facet. */
  onToggleKeyword: (keyword: string) => void;
  /** Whether this card's keyword row is showing every keyword. */
  keywordsExpanded: boolean;
  /** Show every keyword on this card, or collapse back to one row. */
  onToggleKeywordsExpanded: () => void;
  /** The catalog's own arrow-key navigation. */
  onKeyDown: (event: KeyboardEvent) => void;
}

/**
 * Chips drawn while the row is collapsed. A cap, not a limit: the rest are one
 * click away, so this only bounds what 400 cards put in the document at once.
 */
const INLINE_KEYWORDS = 5;

export function PackageCard({
  pkg: p,
  vscodeExtension,
  activeKeywords,
  onToggleKeyword,
  keywordsExpanded,
  onToggleKeywordsExpanded,
  onKeyDown,
}: PackageCardProps) {
  const at = lastUpdated(p);
  const ago = at ? timeAgo(at) : "";
  const keywords = p.keywords ?? [];
  // Applied facets first. A chip the reader can LIFT is the one chip that
  // must never be the one the row clips or the cap drops: it is pressed, it
  // is the reason half the catalog is missing, and behind a `…` it reads as
  // an accent the card acquired for no reason. The filter rail pins its own
  // actives for exactly this — `visibleKeywords = [...pinned, ...rail]` in
  // `Catalog.tsx` — and the card is the same problem one level down.
  // Partitioned, not sorted: order within each half is the publisher's.
  const ordered = [
    ...keywords.filter((k) => activeKeywords.includes(k)),
    ...keywords.filter((k) => !activeKeywords.includes(k)),
  ];
  const shown = keywordsExpanded ? ordered : ordered.slice(0, INLINE_KEYWORDS);
  // One string for the label and the tooltip: a control whose accessible name
  // and hover text disagree reads as two different controls.
  const keywordsLabel = keywordsExpanded
    ? "Show fewer keywords"
    : `Show all ${keywords.length} keyword${keywords.length === 1 ? "" : "s"}`;
  return (
      <li
              class="card"
        data-slot="package-card"
        tabIndex={0}
        onKeyDown={onKeyDown}
      >
        <div class="card-head">
          <CardLogo pkg={p} />
          <h2 data-slot="package-name">
            <a
              href={withBase(`/p/${p.namespace}/${p.name}/`)}
              title={`${p.namespace}/${p.name}`}
              tabIndex={-1}
            >
              {p.name}
            </a>
          </h2>
          {/* The kind, then the version and recency after it — the line
              under the name, so the name keeps the head's whole width. A
              retired package trades the recency for the word "deprecated"
              in the deprecation colour, the card's one deprecation signal:
              how recently a package nobody should pick was touched is not
              worth the room. The address is in the name's tooltip, and the
              detail page shows it in full. */}
          <p class="namespace">
            <span class="kind" data-slot="package-kind">
              {p.kind}
            </span>
            {(p.version || p.deprecated || ago) && (
              <span data-slot="package-meta">
                {p.version && (
                  <>
                    <span aria-hidden="true"> · </span>
                    <span class="card-version">v{p.version}</span>
                  </>
                )}
                {p.deprecated ? (
                  <>
                    <span aria-hidden="true"> · </span>
                    <span class="deprecated">deprecated</span>
                  </>
                ) : (
                  ago &&
                  at && (
                    <>
                      <span aria-hidden="true"> · </span>
                      <time datetime={at} title={at}>
                        updated {ago}
                      </time>
                    </>
                  )
                )}
              </span>
            )}
          </p>
        </div>
        {/* Under the head, above the description: what the package
            is tagged with. One row, never two — chips that do not fit
            are dropped whole rather than cut off at the edge.

            Rendered even with no keywords, as one inert "no keywords"
            chip: the row keeps its height, so every card in a grid row
            starts its description at the same line.

            Two tracks, not one flow. A row that clips eats whatever sits
            at its end first, which is why a trailing "+N" chip was
            rejected when the clip was introduced — so the control gets a
            track of its own and the chips clip inside theirs. It is
            offered on every card that has keywords rather than only where
            something is provably hidden: how many chips fit is a width
            question, and answering it per card means measuring 400 of
            them on every resize. Its label names the total instead of a
            remainder, so it promises the list it opens and never a count
            it did not measure. */}
        <div
          class="keywords"
          data-slot="package-keywords"
          data-expanded={keywordsExpanded ? "" : undefined}
        >
          <div class="keyword-chips">
            {!keywords.length && (
              <span class="chip keyword none">no keywords</span>
            )}
            {/* Applies the keyword facet, not a text search. The two
                are not the same answer: `setQuery("cli")` also matched
                every description with the word in it, so the chip
                returned packages that are not tagged `cli` at all. */}
            {shown.map((kw) => (
              <button
                key={kw}
                type="button"
                class={
                  activeKeywords.includes(kw)
                    ? "chip keyword active"
                    : "chip keyword"
                }
                aria-pressed={activeKeywords.includes(kw)}
                tabIndex={-1}
                onClick={() => onToggleKeyword(kw)}
              >
                {kw}
              </button>
            ))}
          </div>
          {keywords.length > 0 && (
            /* An ordinary Tab stop, deliberately unlike the chips beside
               it. Reaching a control by pointer and arrow key only is the
               WCAG 2.1.1 (A) failure the rail's chips were corrected for;
               a new control must not reintroduce it. (Those card chips
               still carry `tabIndex={-1}` — same class of defect, left
               alone here rather than fixed in passing.) */
            <button
              type="button"
              class="chip keyword more"
              aria-expanded={keywordsExpanded}
              aria-label={keywordsLabel}
              title={keywordsLabel}
              onClick={onToggleKeywordsExpanded}
            >
              {keywordsExpanded ? "\u2212" : "\u2026"}
            </button>
          )}
        </div>
        {p.description && <p class="description">{p.description}</p>}
        <div class="card-foot">
          {/* Bottom left, opposite the figures. They sat top right, where
              they cost a long name its width — and an index with long names
              clipped most of them. Ghosts (see `.copy-group .copy` in the
              layout): the same three on every card, so they stay quiet until
              pointed at. */}
          <div class="copy-group">
            {/* Global first, matching the hero's scope picker — the two
                are the same choice in two places, so they lead with the
                same one. */}
            <CopyButton
              command={`grim add --global ${p.ref}`}
              variant="global"
              name={`global add for ${p.name}`}
            />
            <CopyButton
              command={`grim add ${p.ref}`}
              name={`project add for ${p.name}`}
            />
            {vscodeUrl(vscodeExtension, p.ref) && (
              <a
                class="copy vscode"
                href={vscodeUrl(vscodeExtension, p.ref)!}
                title="Open in VS Code"
                aria-label={`Open ${p.name} in VS Code`}
                tabIndex={-1}
              >
                <BrandMark path={mdiMicrosoftVisualStudioCode} />
              </a>
            )}
          </div>
          {/* Bottom right, opposite the quick links: plain figures, not
              controls. Voting — the thread and the extension route — lives
              on the detail page; on a grid of cards the vote pill was one
              more control per card. Absent means unknown, so neither renders a
              zero. Abbreviated because downloads reach seven digits; the
              exact figure is in the `title`. */}
          {(p.downloads || p.rating) && (
            <span class="card-stats">
              {p.downloads && (
                <span
                  class="download-count"
                  title={`${exactCount(p.downloads.total)} downloads`}
                >
                  <ArrowDownToLine size={13} aria-hidden="true" />
                  {compactCount(p.downloads.total)}
                </span>
              )}
              {p.rating && (
                <span
                  class="vote-count"
                  title={`${p.rating.up} upvote${p.rating.up === 1 ? "" : "s"}`}
                >
                  <ArrowBigUp size={13} aria-hidden="true" />
                  {p.rating.up}
                </span>
              )}
            </span>
          )}
        </div>
      </li>
  );
}
