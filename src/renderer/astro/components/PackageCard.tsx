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
  /** The catalog's own arrow-key navigation. */
  onKeyDown: (event: KeyboardEvent) => void;
}

export function PackageCard({
  pkg: p,
  vscodeExtension,
  activeKeywords,
  onToggleKeyword,
  onKeyDown,
}: PackageCardProps) {
  const at = lastUpdated(p);
  const ago = at ? timeAgo(at) : "";
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
          {/* Top right, spanning the name and the kind line: the head is as
              tall as a button already, because the logo spans both rows, so
              the buttons cost the card no height there. Ghosts (see
              `.copy-group .copy` in the layout): the same three on every
              card, so they stay quiet until pointed at. */}
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
          {/* The kind, and on a retired package the word "deprecated"
              beside it in the deprecation colour — the card's one
              deprecation signal. The address used to follow the kind and
              was clipped on most cards; like the list row, the card now
              carries it in the name's tooltip, and the detail page shows
              it in full. */}
          <p class="namespace">
            <span class="kind" data-slot="package-kind">
              {p.kind}
            </span>
            {p.deprecated && (
              <>
                <span aria-hidden="true"> · </span>
                <span class="deprecated">deprecated</span>
              </>
            )}
          </p>
        </div>
        {/* Under the head, above the description: what the package
            is tagged with. One row, never two — chips that do not fit
            are dropped whole rather than cut off at the edge.

            Rendered even with no keywords, as one inert "no keywords"
            chip: the row keeps its height, so every card in a grid row
            starts its description at the same line. */}
        <div class="keywords" data-slot="package-keywords">
            {!p.keywords?.length && (
              <span class="chip keyword none">no keywords</span>
            )}
            {/* Capped at five so a package with thirty keywords does
                not render thirty chips off the side of a clipped row.
                Which of the five actually fit is the row's business. */}
            {/* Applies the keyword facet, not a text search. The two
                are not the same answer: `setQuery("cli")` also matched
                every description with the word in it, so the chip
                returned packages that are not tagged `cli` at all. */}
            {(p.keywords ?? []).slice(0, 5).map((kw) => (
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
        {p.description && <p class="description">{p.description}</p>}
        <div class="card-foot">
          {/* Small text only, so the foot is one text line tall rather than
              a button tall. Version and recency on the left. */}
          {(p.version || ago) && (
            <p class="card-meta" data-slot="package-meta">
              {p.version && <span class="card-version">v{p.version}</span>}
              {p.version && ago && <span aria-hidden="true"> · </span>}
              {ago && at && (
                <time datetime={at} title={at}>
                  updated {ago}
                </time>
              )}
            </p>
          )}
          {/* Opposite the version, bottom right: plain figures, not
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
