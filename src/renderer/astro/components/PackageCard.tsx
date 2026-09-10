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
import { DEPRECATED_MARK, KIND_MARKS, KindMark } from "./KindMark.js";
import { withBase } from "../lib/base.js";
import {
  compactCount,
  exactCount,
  externalUrl,
  lastUpdated,
  timeAgo,
  vscodeUrl,
  vscodeVoteUrl,
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
  return (
      <li
              class="card"
        data-slot="package-card"
        tabIndex={0}
        onKeyDown={onKeyDown}
      >
        {/* The kind again, as texture: the same mark the card's kind
            wears in the VS Code extension, enlarged into the card's
            top-right corner. Decorative — the kind is written on the
            address line — so it is aria-hidden.

            Every mark is framed on its own bounding box (see
            `KindMark`), so they render at one apparent size rather
            than at whatever fraction of the 16-unit grid each codicon
            happens to use.

            The colour is the token at FULL strength; the fading is
            `opacity` on the element, in CSS. A translucent colour is
            not equivalent: any glyph whose paths overlap composites
            each crossing twice and comes out blotchy along its own
            joins. Element opacity flattens the mark first and blends
            the result once, which is the only way the tint is even.

            A deprecated package spends it on the warning instead. The
            kind is written either way, so the mark is free to carry the
            one thing that has no words — and being the only deprecation
            signal on the card, it is labelled rather than hidden. */}
        {(() => {
          const mark = p.deprecated
            ? DEPRECATED_MARK
            : KIND_MARKS[p.kind];
          if (!mark) return null;
          return (
            <KindMark
              glyph={mark}
              class="card-watermark"
              size={112}
              role={p.deprecated ? "img" : undefined}
              aria-label={p.deprecated ? "deprecated" : undefined}
              aria-hidden={p.deprecated ? undefined : "true"}
              style={{
                color: p.deprecated
                  ? "var(--grim-color-deprecated)"
                  : `var(--grim-color-kind-${p.kind}, var(--grim-color-muted))`,
              }}
            />
          );
        })()}
        <div class="card-head">
          <CardLogo pkg={p} />
          <h2 data-slot="package-name">
            <a
              href={withBase(`/p/${p.namespace}/${p.name}/`)}
              tabIndex={-1}
            >
              {p.name}
            </a>
          </h2>
          {/* Pulls, left of the votes. A figure and not a control: no
              registry offers a URL that downloads on click, and the
              artifact's own install line is already on the card. Abbreviated
              because these reach seven digits; the exact number is in the
              `title`. */}
          {p.downloads && (
            <span class="download-count" title={`${exactCount(p.downloads.total)} downloads`}>
              <ArrowDownToLine size={13} aria-hidden="true" />
              {compactCount(p.downloads.total)}
            </span>
          )}
          {/* A count and two ways to add to it — never a "you voted"
              state: the page is prerendered once for everyone, so it
              cannot know whether *you* did, and showing "not voted"
              to someone who has would be worse than showing nothing.

              Left, the count itself, linking to the forge thread the
              sidecar names. No forge offers a URL that casts a vote,
              so this opens the thread and the reader clicks the
              reaction there. Right, the extension's `/vote?repo=`
              route, which does cast one — behind its own disclosure
              modal, never on the strength of this link. */}
          {p.rating &&
            (() => {
              const votes = `${p.rating.up} upvote${p.rating.up === 1 ? "" : "s"}`;
              // Registry-supplied, like every other outbound string
              // here: through the scheme allowlist before it is an
              // href, whatever the sidecar spelled.
              const thread = externalUrl(p.rating.url);
              const vote = vscodeVoteUrl(vscodeExtension, p.ref);
              return (
                <span class="rating-group">
                  {thread ? (
                    <a
                      class="rating-count"
                      href={thread}
                      target="_blank"
                      rel="noopener noreferrer"
                      tabIndex={-1}
                      title={`${votes} — open the thread to vote`}
                      aria-label={`${p.name}: ${votes}. Open the voting thread`}
                    >
                      <ArrowBigUp size={13} aria-hidden="true" />
                      {p.rating.up}
                    </a>
                  ) : (
                    <span class="rating-count" title={votes}>
                      <ArrowBigUp size={13} aria-hidden="true" />
                      {p.rating.up}
                    </span>
                  )}
                  {vote && (
                    <a
                      class="rating-vote"
                      href={vote}
                      tabIndex={-1}
                      title="Upvote in VS Code"
                      aria-label={`Upvote ${p.name} in VS Code`}
                    >
                      <BrandMark
                        path={mdiMicrosoftVisualStudioCode}
                        size={12}
                      />
                    </a>
                  )}
                </span>
              );
            })()}
          {/* Kind, then where it lives — two things, dot-separated, in
              the same shape the foot's `version · updated` uses. The
              kind leads because it is what a reader filters on; the
              watermark in the corner says the same thing without
              words. Deprecation is deliberately NOT here: a third item
              filled the line, and the watermark carries it. */}
          <p class="namespace">
            <span class="kind" data-slot="package-kind">
              {p.kind}
            </span>
            <span aria-hidden="true"> · </span>
            {/* Its own element so the row can give the address the slack and
                nothing else: the kind is one short word and keeps its width,
                and what does not fit is dropped off the FRONT — a registry
                host is the least distinguishing part of an address and the
                repository is the most. `title` keeps the whole of it
                reachable, since the ellipsis hides the head. */}
            <span class="address" title={p.namespace}>
              {p.namespace}
            </span>
          </p>
        </div>
        {/* Under the head, above the description: what the package
            is tagged with. One row, never two — the row gives up its
            overflow rather than wrapping, and fades at its right end
            to say there is more. */}
        {p.keywords && p.keywords.length > 0 && (
          <div class="keywords" data-slot="package-keywords">
            {/* Capped at five so a package with thirty keywords does
                not render thirty chips off the side of a clipped row.
                Which of the five actually fit is the row's business. */}
            {/* Applies the keyword facet, not a text search. The two
                are not the same answer: `setQuery("cli")` also matched
                every description with the word in it, so the chip
                returned packages that are not tagged `cli` at all. */}
            {p.keywords.slice(0, 5).map((kw) => (
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
        )}
        {p.description && <p class="description">{p.description}</p>}
        <div class="card-foot">
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
          {/* Version and recency, on their own line under the buttons.
              Both answer the same question — how current is this — so
              they read as one stamp; alongside the buttons they were a
              third thing competing for the card's last row, which is
              where the vote badge now sits.

              The date is the one the sidecar derived, not the
              artifact's own `created`: a package republished from the
              same commit keeps its date, and one with no commit date
              at all gets the day this index first saw its current
              digest. Licence is gone from the card entirely; it
              matters when adopting a package, not when scanning for
              one, and the detail page states it. */}
          {(() => {
            const at = lastUpdated(p);
            const ago = at && timeAgo(at) ? timeAgo(at) : null;
            if (!p.version && !ago) return null;
            return (
              <p class="card-meta" data-slot="package-meta">
                {p.version && (
                  <span class="card-version">v{p.version}</span>
                )}
                {p.version && ago && <span aria-hidden="true"> · </span>}
                {ago && at && (
                  <time datetime={at} title={at}>
                    updated {ago}
                  </time>
                )}
              </p>
            );
          })()}
        </div>
      </li>
  );
}
