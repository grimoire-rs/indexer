import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "preact/hooks";
// Lucide (ISC) draws the UI; brand marks come from `@mdi/js`, which Lucide
// deliberately does not carry. No SVG on this site is hand-written.
import {
  ArrowBigUp,
  ArrowDownWideNarrow,
  ArrowUpNarrowWide,
  Check,
  FolderRoot,
  Globe,
  Image,
  ImageOff,
  LayoutGrid,
  List,
} from "lucide-preact";
import { mdiMicrosoftVisualStudioCode } from "@mdi/js";
import { BrandMark } from "./BrandMark.js";
import { DEPRECATED_MARK, KIND_MARKS, KindMark } from "./KindMark.js";
import { withBase } from "../lib/base.js";
import { keywordFrequency, selectRailKeywords } from "../lib/keywordRail.js";
import {
  externalUrl,
  lastUpdated,
  timeAgo,
  vscodeUrl,
  vscodeVoteUrl,
  type CatalogPackage,
} from "../lib/catalog.js";

// Known kinds get stable chip ordering + badge colors; unknown kinds
// (future schema growth) still render with a neutral badge.
const KNOWN_KINDS = ["skill", "rule", "agent", "mcp", "bundle"];

function kindOrder(kind: string): number {
  const i = KNOWN_KINDS.indexOf(kind);
  return i === -1 ? KNOWN_KINDS.length : i;
}

export type Sort = "name" | "updated" | "rating";
export type Dir = "asc" | "desc";
/** Roomy cards, or the same packages as a scannable list. */
export type View = "cards" | "table";

/**
 * How many keyword chips the rail shows at once, actives included.
 *
 * Everything past it goes behind the overflow menu. The cap is the point:
 * this catalog's keyword vocabulary is open-ended, and a rail that renders
 * all of it is a wall of chips nobody reads.
 */
const KEYWORD_CHIP_LIMIT = 8;

/**
 * The direction each field is *worth* reading first in — A→Z for a name,
 * newest and best-liked first for the two ranked keys.
 *
 * Picking a field selects its natural direction; the toggle beside the
 * combo box reverses that. So "descending" is not a global default a reader
 * has to correct on every mode, and the arrow always describes what the
 * order actually is rather than which way a flag is set.
 */
export const NATURAL: Record<Sort, Dir> = {
  name: "asc",
  updated: "desc",
  rating: "desc",
};

type Key = (a: CatalogPackage, b: CatalogPackage) => number;

/**
 * Bigger first, with `null` as its own bucket underneath every number.
 *
 * The shared shape of the two ranked keys, and the reason both are written
 * this way: "missing" is not a low value, it is the absence of one. Folding
 * it into a number — 0 upvotes, epoch 0 — orders those rows against real
 * data by accident, and ties them all with each other.
 */
function descending(a: number | null, b: number | null): number {
  if (a === null || b === null) return Number(a === null) - Number(b === null);
  return b - a;
}

/** `updated` as epoch ms; null when absent, empty or not a date at all. */
function updatedAt(p: CatalogPackage): number | null {
  const at = lastUpdated(p);
  const ms = at ? new Date(at).getTime() : NaN;
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Ascending, case-insensitive. The full ref breaks the last tie in every
 * mode, and it is unique, so no two rows ever compare equal — a browse order
 * that is not total is a browse order that reshuffles on rebuild.
 */
const byName: Key = (a, b) =>
  a.name.localeCompare(b.name, undefined, { sensitivity: "accent" }) ||
  a.ref.localeCompare(b.ref);

/**
 * Newest first. No usable date is *unknown*, not epoch 0: dating an undated
 * package to 1970 sorts it below real packages by accident rather than by
 * rule, so it goes into a bucket of its own at the bottom.
 */
const byUpdated: Key = (a, b) => descending(updatedAt(a), updatedAt(b));

/**
 * Most upvotes first. Unrated is its own bucket at the bottom, never a zero:
 * a fresh index is all-unrated, and zeroes would leave every one of those
 * rows comparing equal with nothing left to break the tie.
 */
const byRating: Key = (a, b) =>
  descending(a.rating?.up ?? null, b.rating?.up ?? null);

/** Each mode as a chain of keys, most significant first. */
const CHAINS: Record<Sort, Key[]> = {
  name: [byName],
  updated: [byUpdated, byName],
  rating: [byRating, byUpdated, byName],
};

// Deprecated packages get no special ordering here — they are filtered out
// of the default browse entirely (see `shown` below) and interleave like
// any other row when the toggle brings them back. grim's own browse order
// (`browse_sort.rs`) has no deprecated key either; keeping this comparator
// silent on deprecation is what keeps the two in sync.
export function compare(
  a: CatalogPackage,
  b: CatalogPackage,
  sort: Sort,
  dir: Dir = NATURAL[sort],
): number {
  for (const key of CHAINS[sort]) {
    const d = key(a, b);
    // Reversed means reversed all the way down, the ref tiebreak included.
    // Every chain ends on a unique key, so no two rows compare equal and
    // negating the whole answer leaves the order just as total as it was.
    if (d !== 0) return dir === NATURAL[sort] ? d : -d;
  }
  return 0;
}

// The two install scopes previously wore the VS Code extension's own
// codicons so "project" and "global" read identically in both. That parity
// is gone on purpose: every icon now comes from one set. `FolderRoot` and
// `Globe` are the nearest Lucide equivalents and carry the same meaning.

/**
 * The reader's own preferences, kept out of the URL.
 *
 * The split is deliberate and matches grim: `q`, `kind` and `kw` are *what
 * you are looking at* — a keyword chip on a package page links to
 * `/?kw=<keyword>`, so that half has to stay shareable — while sort,
 * direction, deprecated visibility and the cards/table choice are *how you
 * like the catalog arranged*, the same answer on every visit. grim keeps
 * `show_deprecated` in its config file for exactly that reason.
 *
 * Both accessors swallow: reading `localStorage` throws outright, not
 * returns null, in a browser set to block site data, and a catalog is not
 * worth a blank page. A reader who blocks it browses without preferences.
 */
const PREF = "grim.catalog.";

function readPref(key: string): string | null {
  try {
    return localStorage.getItem(PREF + key);
  } catch {
    return null;
  }
}

function writePref(key: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(PREF + key);
    else localStorage.setItem(PREF + key, value);
  } catch {
    // Nothing to do and nothing to report: preferences are a convenience.
  }
}

/**
 * A comma-joined URL parameter, back into the list it was.
 *
 * Empty and absent are the same answer — `?kind=` is a reader who cleared
 * the filter, not a request for the kind named "". Duplicates collapse so a
 * hand-edited `?kw=a,a` cannot render the same chip twice.
 */
function list(value: string | null): string[] {
  return [...new Set((value ?? "").split(",").filter(Boolean))];
}

/** Typing inside one of these means a bare keystroke is text, not a shortcut. */
function isTyping(el: EventTarget | null): boolean {
  const node = el as HTMLElement | null;
  if (!node) return false;
  return (
    node.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(node.tagName)
  );
}

/**
 * How many cards the grid actually laid out per row.
 *
 * Measured, not read from CSS: the track list is `auto-fill` with a minimum
 * width, so the count is a layout outcome that depends on the viewport. The
 * first card whose top edge drops below the first row's starts row two.
 *
 * The table view needs no branch of its own — its rows stack, so the second
 * one is already below the first and this measures the 1 that makes every
 * arrow key move by a single row.
 */
function columnCount(cards: HTMLElement[]): number {
  if (cards.length < 2) return 1;
  const top = cards[0]!.offsetTop;
  const wrapped = cards.findIndex((card) => card.offsetTop > top);
  return wrapped === -1 ? cards.length : wrapped;
}

/**
 * The card's 28px logo slot, in its three states.
 *
 * The third one is the reason this is a component rather than inline JSX: a
 * package can declare a `logo` whose file is not actually served — the
 * enrich step failed, the asset was pruned, the path is stale — and the
 * browser's own broken-image glyph is both ugly and says nothing. So a
 * declared-but-unreachable logo degrades to a marked placeholder, which is
 * deliberately *not* the same as the initial-letter tile a package with no
 * logo at all gets: one is a fault worth seeing, the other is normal.
 *
 * The static detail page needs the same treatment but cannot use `onError`,
 * so it opts into the global handler in `Base.astro` instead — keep the two
 * placeholders looking alike.
 */
function CardLogo({ pkg }: { pkg: CatalogPackage }) {
  const [state, setState] = useState<"loading" | "ready" | "broken">("loading");
  const imgRef = useRef<HTMLImageElement>(null);

  // The image is server-rendered, so the browser begins fetching it while
  // parsing the HTML — long before this island hydrates. Two consequences,
  // and the slot markup below answers both: `onError` can fire before any
  // listener exists (the placeholder used to appear only sometimes), and a
  // failed image paints the browser's broken glyph on the way (the flash on
  // reload). Starting the image hidden means nothing is ever shown until it
  // is known to be good.
  //
  // `complete` says the browser finished, not how it went. `decode()` is
  // what separates the two: it rejects for a failure and resolves for a good
  // image — including an SVG with no intrinsic size, where the usual
  // `naturalWidth === 0` test reports a false failure. Gating on `complete`
  // means it never starts a fetch, so `loading="lazy"` still holds off
  // -screen cards.
  useEffect(() => {
    setState("loading");
    const img = imgRef.current;
    if (!img?.complete) return;
    let live = true;
    img.decode().then(
      () => live && setState("ready"),
      () => live && setState("broken"),
    );
    return () => {
      live = false;
    };
  }, [pkg.logo]);

  if (!pkg.logo) {
    return (
      <span
        class="card-logo card-logo-fallback"
        aria-hidden="true"
        style={{
          background: `var(--grim-color-kind-${pkg.kind}, var(--grim-color-muted))`,
        }}
      >
        {pkg.name[0]?.toUpperCase()}
      </span>
    );
  }

  return (
    <span
      class="card-logo logo-slot"
      data-state={state}
      role={state === "broken" ? "img" : undefined}
      aria-label={state === "broken" ? "Logo image unavailable" : undefined}
      title={state === "broken" ? "Logo image unavailable" : undefined}
    >
      {state === "broken" ? (
        <ImageOff class="logo-mark" aria-hidden="true" />
      ) : (
        <Image class="logo-mark" aria-hidden="true" />
      )}
      <img
        ref={imgRef}
        src={withBase(pkg.logo)}
        alt=""
        loading="lazy"
        onLoad={() => setState("ready")}
        onError={() => setState("broken")}
      />
    </span>
  );
}

function CopyButton({
  command,
  variant = "default",
  name,
}: {
  command: string;
  variant?: "default" | "global";
  /** What the copy toast calls this, e.g. `"global install command"`. */
  name?: string;
}) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    navigator.clipboard.writeText(command).then(() => {
      setCopied(true);
      // The toast lives in Base.astro's inline script, outside this island —
      // an event is how a hydrated component reaches it without either side
      // importing the other.
      document.dispatchEvent(
        new CustomEvent("grimoire:copied", {
          detail: { name, value: command },
        }),
      );
      setTimeout(() => setCopied(false), 1500);
    });
  };
  return (
    <button
      type="button"
      class={copied ? "copy copied" : "copy"}
      title={command}
      aria-label={`Copy: ${command}`}
      // Out of the Tab sequence: the card is the stop, and the same command
      // is copyable from the detail page Enter opens.
      tabIndex={-1}
      onClick={copy}
    >
      {copied ? (
        <Check size={14} />
      ) : variant === "global" ? (
        <Globe size={14} />
      ) : (
        <FolderRoot size={14} />
      )}
    </button>
  );
}

/**
 * The same packages as a list, for reading down a column rather than across
 * a grid.
 *
 * **A row is an anchor, and there is no `<table>`.** Two reasons, and the
 * first is the load-bearing one: a header row that cannot sort is a header
 * row that *looks* like it sorts — every reader who has met a data table
 * clicks it once. Sorting lives in the toolbar, so the table has no headers,
 * and a headerless table has no column semantics left to justify the element.
 * What remains is a list of links, which is what this is. A CSS grid with
 * `subgrid` rows keeps the columns aligned without the markup.
 *
 * The anchor is also what makes the whole row clickable, focusable and
 * middle-clickable for free — no stretched-link overlay, no synthetic Enter
 * handler. A row carries no controls of its own: the install buttons and the
 * vote links are what the card exists for, and repeating them per row would
 * be five columns of icons. The detail page has all of them.
 *
 * Columns are fixed, unlike the keyword rail above — deliberately. A column
 * is a slot the eye tracks down; one that appears and disappears as the
 * filters change destroys the alignment the table exists to give. The rating
 * column is the one exception, and it is decided once per index rather than
 * per filter.
 */
function PackageTable({
  packages,
  hasRatings,
  onKeyDown,
  rootRef,
}: {
  packages: CatalogPackage[];
  hasRatings: boolean;
  onKeyDown: (event: KeyboardEvent) => void;
  rootRef: { current: HTMLElement | null };
}) {
  return (
    <div
      class={hasRatings ? "table rated" : "table"}
      data-slot="package-table"
      ref={(el) => {
        rootRef.current = el;
      }}
    >
      {packages.map((p) => {
        const at = lastUpdated(p);
        const ago = at && timeAgo(at) ? timeAgo(at) : null;
        return (
          <a
            key={`${p.namespace}/${p.name}`}
            class="row"
            data-slot="package-row"
            href={withBase(`/p/${p.namespace}/${p.name}/`)}
            // The full identity, since the visible name is clipped and the
            // namespace is not shown at all.
            title={`${p.namespace}/${p.name}`}
            onKeyDown={onKeyDown}
          >
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
      })}
    </div>
  );
}

// `vscodeExtension` arrives as a prop, not from lib/data: this island
// hydrates in the browser, so importing the build-time payload here would
// ship the whole catalog twice.
export default function Catalog({
  packages,
  vscodeExtension,
}: {
  packages: CatalogPackage[];
  vscodeExtension: string | null;
}) {
  // Empty on the first render, ALWAYS — `?q=…` is applied a beat later, in
  // the layout effect below. This is not a style preference, it is the one
  // rule this island has to obey.
  //
  // Preact does not diff props while hydrating; its own source says so, and
  // only re-applies props whose value is a function. Text children *are*
  // diffed. So when the first client render disagrees with the server's, you
  // get cards whose text is right and whose every attribute belongs to
  // whichever package the server put at that position: one package's logo
  // over another's name, and a link that opens the wrong page. Nothing
  // throws. This used to seed from `location` here, and did exactly that.
  const [query, setQuery] = useState("");
  // Whether the URL's query has been applied. Gates the reveal below, so the
  // catalog is never unhidden while it still shows the unfiltered list.
  const [seeded, setSeeded] = useState(false);
  // Kinds combine with OR, keywords with AND, and the two groups with each
  // other. That is not an inconsistency, it follows from the data: a package
  // has exactly one kind, so requiring both of two kinds always yields
  // nothing, while it carries many keywords, so requiring both of two is the
  // only reading under which a second click narrows. A facet whose second
  // click *widens* the result set reads as broken.
  const [kinds, setKinds] = useState<string[]>([]);
  const [keywords, setKeywords] = useState<string[]>([]);
  const [sort, setSort] = useState<Sort>("name");
  // Direction, not "reversed": what the arrow draws is the order itself.
  const [dir, setDir] = useState<Dir>(NATURAL.name);
  // Deprecated packages are hidden until asked for: a retired package is
  // noise for someone browsing what to install, and the publisher already
  // said as much by deprecating it.
  const [showDeprecated, setShowDeprecated] = useState(false);
  const [view, setView] = useState<View>("cards");
  // Local to the overflow menu and deliberately not shareable: it narrows
  // the list of keywords, not the catalog.
  const [keywordFilter, setKeywordFilter] = useState("");

  const searchRef = useRef<HTMLInputElement>(null);
  const gridRef = useRef<HTMLElement>(null);
  const controlsRef = useRef<HTMLDivElement>(null);

  // Both views, one selector: a table row is the Tab stop its card is, so
  // every keyboard path below — the search hatch, ArrowDown out of the
  // chips, Escape's blur — works in either without knowing which is up.
  const cardsOf = () => [
    ...(gridRef.current?.querySelectorAll<HTMLElement>("li.card, a.row") ?? []),
  ];
  // Clipped keyword chips are excluded: they are drawn as nothing, so an
  // arrow key that landed on one would move focus somewhere the reader
  // cannot see it.
  const chipsOf = () => [
    ...(controlsRef.current?.querySelectorAll<HTMLElement>(
      'button.chip:not([aria-hidden="true"])',
    ) ?? []),
  ];

  const railRefs = useRef(new Map<string, HTMLElement>());
  const railRects = useRef(new Map<string, DOMRect>());
  const railRef = useRef<HTMLDivElement>(null);

  /**
   * How many keyword chips actually fit on the row, measured.
   *
   * Not a constant, because the answer is a layout outcome: the rail is the
   * one flexible child of the filter row, so its width is whatever the kinds,
   * the overflow menu and the deprecated toggle left, and the chips are as
   * wide as the words publishers wrote. `KEYWORD_CHIP_LIMIT` bounds how many
   * are *offered*; this is how many are shown.
   *
   * The rule it enforces: the rail never wraps and never scrolls. A second
   * row makes the toolbar a different height on every filter click, and a
   * scrollbar hides the chips behind a gesture nobody looks for — it also
   * pushed the overflow menu off the end of the row entirely.
   *
   * Every chip stays in the flow whatever this says; the ones past it are
   * drawn as nothing (see `.chip.kw.clipped`). Taking them out of the flow
   * would free the width that excluded them, which is a measurement that
   * disagrees with itself on every other frame.
   */
  const [railFit, setRailFit] = useState(KEYWORD_CHIP_LIMIT);

  useLayoutEffect(() => {
    const rail = railRef.current;
    if (!rail) return;
    const measure = () => {
      const edge = rail.getBoundingClientRect().right;
      let fits = 0;
      for (const chip of rail.children) {
        // Half a pixel of slack: a fractional layout can leave a chip's right
        // edge a rounding error past a boundary it visually sits inside.
        if (chip.getBoundingClientRect().right > edge + 0.5) break;
        fits += 1;
      }
      // At least one, always. A rail too narrow for its shortest chip should
      // show that chip clipped rather than render an empty group beside a
      // divider that then divides nothing.
      setRailFit(Math.max(1, fits));
    };
    measure();
    // Guarded rather than assumed: this effect also runs under the test
    // renderer, whose DOM has no `ResizeObserver` — and a missing one costs
    // only re-measurement on viewport resize, which is not worth throwing
    // during a render over.
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(rail);
    return () => observer.disconnect();
    // Re-measured on every commit that changes which chips are up, since the
    // observer only fires when the rail's own box changes and a rescore can
    // swap a short word for a long one at the same width.
  });

  /**
   * FLIP for the keyword rail: chips slide to their new places instead of
   * teleporting.
   *
   * The rail is rescored against the current result set, so it reorders on
   * every click — the chip just picked moves to the front and the rest flow
   * around it. Animating that is not decoration: a rail whose contents change
   * between two frames reads as having been *replaced*, and a reader who
   * cannot see that a chip moved has no reason to believe it is the same one.
   *
   * First (the map of rects kept from the last commit), Last (measured now),
   * Invert (an inline translate back to where the chip was), Play (dropped on
   * the next frame, so the stylesheet's transition carries it home). Measure
   * every chip before transforming any: `translate` composites and does not
   * reflow, but reading a rect after writing a style on a sibling is the
   * shape that makes a layout thrash, and this runs per keystroke.
   */
  useLayoutEffect(() => {
    const previous = railRects.current;
    const current = new Map<string, DOMRect>();
    const moved: { el: HTMLElement; dx: number; dy: number }[] = [];
    for (const [keyword, el] of railRefs.current) {
      const rect = el.getBoundingClientRect();
      current.set(keyword, rect);
      const was = previous.get(keyword);
      if (!was) continue;
      const dx = was.left - rect.left;
      const dy = was.top - rect.top;
      if (dx !== 0 || dy !== 0) moved.push({ el, dx, dy });
    }
    railRects.current = current;
    if (moved.length === 0) return;
    for (const { el, dx, dy } of moved) {
      el.style.transition = "none";
      el.style.translate = `${dx}px ${dy}px`;
    }
    const frame = requestAnimationFrame(() => {
      for (const { el } of moved) {
        el.style.transition = "";
        el.style.translate = "";
      }
    });
    return () => cancelAnimationFrame(frame);
  });

  /** Move focus `delta` cards along, clamping at both ends rather than wrapping. */
  const focusCard = (from: number, delta: number) => {
    const cards = cardsOf();
    if (cards.length === 0) return;
    const next = Math.min(cards.length - 1, Math.max(0, from + delta));
    cards[next]?.focus();
  };

  /**
   * Focus the search box and bring it to the top of the viewport, so the
   * results — not whatever was on screen before — are what you are looking
   * at while typing. `scroll-margin-top` on the field supplies the gap.
   *
   * Used by every path that moves focus there deliberately (`/`, arrowing up
   * out of the chips, Escape). A plain mouse click is left alone: scrolling
   * the page under a reader who just clicked a visible field is a jolt, not
   * a help.
   */
  const focusSearch = () => {
    const input = searchRef.current;
    if (!input) return;
    input.focus();
    input.select();
    input.scrollIntoView({
      block: "start",
      behavior: matchMedia("(prefers-reduced-motion: reduce)").matches
        ? "auto"
        : "smooth",
    });
  };

  /**
   * Put the reader's view into state — the query from the URL, the
   * preferences from storage. Neither half was there before, and the missing
   * preference half is what made a deprecated package unreachable by Back:
   * you turned the toggle on, opened the package, came back, and the
   * remounted catalog knew nothing about it, so the card you had just been
   * looking at was hidden again.
   *
   * Unknown values are dropped rather than trusted at both doors: `kind`
   * reaches a class name, `kw` reaches a chip that stays on screen until it
   * is clicked off, and `sort` selects a comparator, so none of them follows
   * a hand-typed URL or a hand-edited storage entry anywhere the controls
   * cannot go. `kw` is checked against the catalog's own vocabulary rather
   * than a fixed list, since keywords are whatever publishers wrote.
   */
  const applyView = () => {
    const params = new URLSearchParams(location.search);
    const s = readPref("sort");
    const d = readPref("dir");
    const v = readPref("view");
    const field: Sort = s === "updated" || s === "rating" ? s : "name";
    const published = new Set(packages.flatMap((p) => p.keywords ?? []));
    setQuery(params.get("q") ?? "");
    setKinds(list(params.get("kind")).filter((k) => KNOWN_KINDS.includes(k)));
    setKeywords(list(params.get("kw")).filter((k) => published.has(k)));
    setSort(field);
    setDir(d === "asc" || d === "desc" ? d : NATURAL[field]);
    // A flag: stored at all means on.
    setShowDeprecated(readPref("deprecated") !== null);
    setView(v === "table" ? "table" : "cards");
  };

  // Apply the URL's view, now that hydration has matched the server's markup
  // and Preact owns the tree. A layout effect rather than a plain one: the
  // resulting render must land before the browser paints, or a `?q=` visitor
  // sees the whole catalog flash past on the way to their results.
  useLayoutEffect(() => {
    applyView();
    setSeeded(true);
  }, []);

  // Back and Forward within the catalog — a keyword chip on a package page
  // links to `/?q=…`, so the reader can land here more than once without a
  // reload, and `popstate` is the only notice of it.
  useEffect(() => {
    const onPop = () => applyView();
    addEventListener("popstate", onPop);
    return () => removeEventListener("popstate", onPop);
  }, []);

  // The query, into the URL — so it can be shared, and so Back lands on the
  // search the reader left. `replaceState`, not `pushState`: a history entry
  // per keystroke would make Back mean "undo one letter" rather than "the
  // page I came from". Gated on `seeded`, since writing before the URL has
  // been read would erase a deep link on arrival.
  useEffect(() => {
    if (!seeded) return;
    const params = new URLSearchParams(location.search);
    const set = (key: string, value: string | null) =>
      value === null ? params.delete(key) : params.set(key, value);
    set("q", query || null);
    set("kind", kinds.length > 0 ? kinds.join(",") : null);
    set("kw", keywords.length > 0 ? keywords.join(",") : null);
    const search = params.toString();
    const next = `${location.pathname}${search ? `?${search}` : ""}${location.hash}`;
    if (next !== `${location.pathname}${location.search}${location.hash}`) {
      history.replaceState(history.state, "", next);
    }
    // `keywords` is compared by identity, which is what we want: the array is
    // replaced on every toggle and never mutated in place.
  }, [seeded, query, kinds, keywords]);

  // The preferences, into storage — so the next visit opens the way this one
  // ended. Each is stored only when it is not the default, so a reader who
  // never touched a control leaves nothing behind.
  useEffect(() => {
    if (!seeded) return;
    writePref("sort", sort === "name" ? null : sort);
    writePref("dir", dir === NATURAL[sort] ? null : dir);
    writePref("deprecated", showDeprecated ? "1" : null);
    writePref("view", view === "cards" ? null : view);
  }, [seeded, sort, dir, showDeprecated, view]);

  // Base.astro hides the catalog before first paint when the URL carries a
  // query. Reveal it only once the filtered render is in the DOM — keyed on
  // `seeded`, so the unfiltered first render is never the one revealed.
  useLayoutEffect(() => {
    if (!seeded) return;
    // The input's `value` prop was skipped during hydration for the same
    // reason every other prop was, and the render that applied the query is
    // a normal diff — but write it anyway: this effect is also what runs on
    // a `?q=`-less load, where no second render is queued at all.
    const input = searchRef.current;
    if (input && input.value !== query) input.value = query;
    delete document.documentElement.dataset.query;
  }, [seeded]);

  // `/` jumps to the search box, the convention every package registry
  // shares. Bound on the document so it works wherever the reader is.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "/" || event.metaKey || event.ctrlKey || event.altKey)
        return;
      if (isTyping(event.target)) return;
      event.preventDefault();
      focusSearch();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);

  /**
   * Escape drops the selection, from wherever the reader is — the search
   * box, a chip, a card. "Selection" is both halves of it: the active
   * filters, and the card currently holding focus, which wears the accent
   * border and reads as picked. Clearing one and leaving the other visibly
   * selected is the wrong half.
   *
   * The card is blurred rather than handed back to the search box: Escape
   * means "never mind", not "go here instead", and `/` reaches search from
   * anywhere. It matches what a second Escape in the search box already does.
   *
   * Document-level for the same reason `/` is: this is one piece of state,
   * so the key that clears it should not depend on what happens to hold
   * focus. Bailing on `defaultPrevented` leaves the menus that close
   * themselves on Escape — the platform picker, the version popovers — to do
   * that first without also wiping the catalog.
   */
  useEffect(() => {
    const onEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      const active = document.activeElement;
      // Also true for a control *inside* a card, which is still the card
      // being selected as far as the reader is concerned.
      const card =
        active instanceof HTMLElement ? active.closest("li.card, a.row") : null;
      // Nothing selected: not our key.
      if (!query && kinds.length === 0 && keywords.length === 0 && !card)
        return;
      event.preventDefault();
      setQuery("");
      setKinds([]);
      setKeywords([]);
      if (card) (active as HTMLElement).blur();
    };
    document.addEventListener("keydown", onEscape);
    return () => document.removeEventListener("keydown", onEscape);
  }, [query, kinds, keywords]);

  /** Both facets toggle the same way; only the relation between values differs. */
  const toggle =
    (set: (next: (was: string[]) => string[]) => void) => (value: string) =>
      set((was) =>
        was.includes(value) ? was.filter((v) => v !== value) : [...was, value],
      );
  const toggleKind = toggle(setKinds);
  // Appends rather than inserts, so the pinned chips below stay in the order
  // they were picked — the rail reorders underneath them, the actives do not.
  const toggleKeyword = toggle(setKeywords);

  /**
   * Arrow keys move *across* a rail the reader is already standing in. They
   * are not Tab's replacement, and this is the correction of a real defect:
   * the chips used to carry `tabIndex={-1}` whenever the grid had anything
   * in it, which left filtering reachable by pointer and arrow key only.
   * That is a WCAG 2.1.1 (A) failure — every control has to be operable from
   * the keyboard through the ordinary sequence, and an undocumented arrow
   * convention is not that sequence. The sibling `@ocx-sh/catalog` renderer
   * shipped the same shortcut and reverted it for the same reason.
   *
   * So the chips are ordinary Tab stops now, and ArrowUp/ArrowDown remain as
   * the faster way to cross a long rail or drop back into the grid.
   */
  const onChipKeyDown = (event: KeyboardEvent) => {
    const chips = chipsOf();
    const index = chips.indexOf(event.currentTarget as HTMLElement);
    if (index === -1) return;
    switch (event.key) {
      case "ArrowRight":
        event.preventDefault();
        return chips[Math.min(chips.length - 1, index + 1)]?.focus();
      case "ArrowLeft":
        event.preventDefault();
        return chips[Math.max(0, index - 1)]?.focus();
      case "ArrowDown":
        event.preventDefault();
        return cardsOf()[0]?.focus();
      case "ArrowUp":
        // Not Escape any more — that clears the filters now, from here as
        // much as anywhere else. ArrowUp is still the way back to search.
        event.preventDefault();
        return focusSearch();
      default:
        return;
    }
  };

  const onSearchKeyDown = (event: KeyboardEvent) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      cardsOf()[0]?.focus();
    } else if (
      event.key === "Tab" &&
      !event.shiftKey &&
      !event.metaKey &&
      !event.ctrlKey &&
      !event.altKey
    ) {
      // The hatch. Everything between the field and the grid — sort, the
      // view toggle, every chip — sits after it in the DOM and is a real Tab
      // stop again, so plain Tab would walk the whole toolbar before
      // reaching a single package. Forward Tab skips to the results; the
      // toolbar stays reachable by Shift+Tab back out of the grid.
      //
      // Reordering the DOM instead would have put focus order at odds with
      // visual order, which is the worse defect of the two.
      //
      // With nothing to jump to — an empty result set — Tab is left alone
      // rather than swallowed: trapping focus in the field is worse than the
      // walk it was meant to save.
      const first = cardsOf()[0];
      if (!first) return;
      event.preventDefault();
      first.focus();
    } else if (
      event.key === "Escape" &&
      !query &&
      kinds.length === 0 &&
      keywords.length === 0
    ) {
      // Clearing is the document handler's job; this is only the second
      // press, once there is nothing left to clear — so Escape leaves the
      // field rather than being a dead key.
      searchRef.current?.blur();
    }
  };

  const onCardKeyDown = (event: KeyboardEvent) => {
    const card = event.currentTarget as HTMLElement;
    const index = cardsOf().indexOf(card);
    if (index === -1) return;

    switch (event.key) {
      case "ArrowRight":
        event.preventDefault();
        return focusCard(index, 1);
      case "ArrowLeft":
        event.preventDefault();
        return focusCard(index, -1);
      case "ArrowDown":
        event.preventDefault();
        return focusCard(index, columnCount(cardsOf()));
      case "ArrowUp": {
        event.preventDefault();
        const columns = columnCount(cardsOf());
        // Up out of the first row lands on the control row that sits above
        // the grid — the chips, which have no other keyboard path. Search is
        // one more ArrowUp away, and `/` reaches it from anywhere.
        if (index < columns) {
          const chip = chipsOf()[0];
          if (chip) return chip.focus();
          return focusSearch();
        }
        return focusCard(index, -columns);
      }
      case "Home":
        event.preventDefault();
        return focusCard(index, -index);
      case "End":
        event.preventDefault();
        return focusCard(index, cardsOf().length);
      case "Enter":
      case " ":
        // Only when the card itself holds focus: an inner control reached by
        // mouse must keep its own Space/Enter behaviour.
        if (event.target !== card) return;
        // A table row *is* an anchor, so Enter is the browser's to handle —
        // swallowing it here would break activation rather than provide it.
        // Only the card needs its title link clicked on its behalf.
        if (card instanceof HTMLAnchorElement) return;
        event.preventDefault();
        card.querySelector<HTMLAnchorElement>("h2 a")?.click();
        return;
      default:
        return;
    }
  };

  // The catalog as the kind chips and the search placeholder count it —
  // deprecated entries drop out of those totals too while they are hidden,
  // so no count ever promises more than the grid shows.
  const counted = useMemo(
    () => (showDeprecated ? packages : packages.filter((p) => !p.deprecated)),
    [packages, showDeprecated],
  );

  // Which kinds this catalog publishes, in chip order. No counts on the
  // chips: they cost every chip the width of a number, which is width the
  // keyword rail beside them needs more, and the meta row already states how
  // many packages the filters left. A per-chip count is also the harder one
  // to read honestly — kinds are an OR group, so a count taken after the
  // filter says "3" about a chip that is about to reveal thirty.
  const kindNames = useMemo(() => {
    const seen = new Set(counted.map((p) => p.kind));
    return [...seen].sort(
      (a, b) => kindOrder(a) - kindOrder(b) || a.localeCompare(b),
    );
  }, [counted]);

  const q = query.trim().toLowerCase();
  // Query and facets first, deprecation last — so the toggle can report how
  // many entries *it alone* is holding back, rather than a catalog-wide
  // number that has nothing to do with what is on screen.
  const matching = packages.filter((p) => {
    if (kinds.length > 0 && !kinds.includes(p.kind)) return false;
    if (!keywords.every((kw) => p.keywords?.includes(kw))) return false;
    if (!q) return true;
    return [
      p.name,
      p.description ?? "",
      p.namespace,
      p.kind,
      p.ref,
      p.summary ?? "",
      (p.keywords ?? []).join(" "),
    ].some((field) => field.toLowerCase().includes(q));
  });
  const shown = (
    showDeprecated ? matching : matching.filter((p) => !p.deprecated)
  ).sort((a, b) => compare(a, b, sort, dir));

  /**
   * The keyword rail, over what is on screen rather than over the catalog.
   *
   * Two decisions, both borrowed from `@ocx-sh/catalog` and both load-bearing:
   *
   * Active keywords are **pinned**, first and in the order they were clicked,
   * and never scored. A filter that scrolls out of the rail is a filter the
   * reader cannot lift. Their count is `shown.length` by construction — under
   * AND, every surviving package carries every active keyword.
   *
   * The rest are picked by splitting power over `shown`, not by frequency
   * over `packages`. A rail scored against the whole catalog keeps offering
   * keywords no surviving package carries, and under AND that is most of
   * them — every such chip is one click to an empty grid.
   *
   * The cost, accepted: the rail's contents move as the reader filters, which
   * is what the FLIP effect above animates. The set changing invisibly is
   * what would read as broken.
   */
  const pinned = keywords.map((keyword) => ({
    keyword,
    count: shown.length,
  }));
  const rail = selectRailKeywords(shown, KEYWORD_CHIP_LIMIT)
    // `selectRailKeywords` scores the actives like any other keyword, so
    // over-request and drop them rather than spend rail slots twice.
    .filter((k) => !keywords.includes(k.keyword))
    .slice(0, Math.max(0, KEYWORD_CHIP_LIMIT - pinned.length));
  const visibleKeywords = [...pinned, ...rail];
  // What the menu has to carry: everything the rail had no slot for, plus
  // everything it has a slot for but no ROOM for. The second half is why the
  // menu is built from `railFit` rather than from `KEYWORD_CHIP_LIMIT` — a
  // chip clipped at the rail's edge is one the reader cannot reach anywhere
  // else, and a "+N more" that does not count it is lying about where it is.
  const clippedKeywords = visibleKeywords.slice(railFit).map((k) => k.keyword);
  const menuKeywords = keywordFrequency(shown).filter(
    (k) =>
      clippedKeywords.includes(k.keyword) ||
      !visibleKeywords.some((v) => v.keyword === k.keyword),
  );
  // Plain substring, not a fuzzy match: this searches a list the reader is
  // looking at, and every entry in it is one short known word.
  const menuShown = menuKeywords.filter((k) =>
    k.keyword.toLowerCase().includes(keywordFilter.trim().toLowerCase()),
  );

  // A catalog with nothing deprecated gets no toggle — a control that can
  // only ever be a no-op is worse than its absence. An index that publishes
  // no ratings gets no rating chip for the same reason.
  const hasDeprecated = packages.some((p) => p.deprecated);
  const hasRatings = packages.some((p) => p.rating);

  return (
    <section class="catalog" data-slot="catalog">
      <div class="controls" data-slot="catalog-toolbar" ref={controlsRef}>
        <div class="search-field" data-slot="catalog-search">
          <input
            ref={searchRef}
            type="search"
            placeholder="Search packages — name, keyword, description…"
            value={query}
            onInput={(e) => setQuery((e.target as HTMLInputElement).value)}
            onKeyDown={onSearchKeyDown}
            aria-label="Search packages"
            aria-keyshortcuts="/"
          />
          {/* Decorative: the shortcut is announced by aria-keyshortcuts, so
              repeating it here would be read twice. CSS hides it as soon as
              the field is focused or holds a query. */}
          <kbd class="search-hint" aria-hidden="true">
            /
          </kbd>
        </div>
        {/* One row, three groups, in the order they narrow: what sort of
            thing, then what it is about, then what the catalog is
            withholding. Only the keyword group flexes and scrolls, so a
            narrow viewport shrinks IT rather than dropping the deprecated
            toggle onto a second line — no chip can shrink below its own
            longest word, and the rail's chip count is a constant, not a
            viewport reading. */}
        <div class="filter-row">
          <div
            class="chips kind-chips"
            role="group"
            aria-label="Filter by kind"
          >
            {/* "all" is the empty selection rendered as a chip, not a sixth
                kind — so it is active exactly when nothing else is, and
                clicking it clears rather than selects. */}
            <button
              type="button"
              class={kinds.length === 0 ? "chip active" : "chip"}
              data-slot="filter-chip"
              aria-pressed={kinds.length === 0}
              onKeyDown={onChipKeyDown}
              onClick={() => setKinds([])}
            >
              all
            </button>
            {kindNames.map((k) => (
              <button
                key={k}
                type="button"
                class={
                  kinds.includes(k) ? `chip active kind-${k}` : `chip kind-${k}`
                }
                data-slot="filter-chip"
                aria-pressed={kinds.includes(k)}
                onKeyDown={onChipKeyDown}
                onClick={() => toggleKind(k)}
              >
                {k}
              </button>
            ))}
          </div>
          {/* Divides "what sort of thing" from "about what" — two
              questions sharing a row. Decorative: each group carries its own
              aria-label, so this is drawn, not announced. */}
          {visibleKeywords.length > 0 && (
            <>
              <span class="filter-divider" aria-hidden="true" />
              <div
                class="chips kw-rail"
                role="group"
                aria-label="Filter by keyword"
                ref={railRef}
              >
                {visibleKeywords.map(({ keyword }, i) => {
                  // Past the measured fit: still laid out, so the measurement
                  // that decided this stays true on the next pass, but drawn
                  // as nothing and out of reach. Removing it from the flow
                  // instead would free the width that excluded it, which is
                  // the oscillation this shape exists to avoid.
                  const clipped = i >= railFit;
                  return (
                    <button
                      key={keyword}
                      ref={(el) => {
                        // The FLIP effect measures whatever is in this map, so
                        // a chip that leaves has to leave the map with it —
                        // Preact calls back with null on unmount for that.
                        if (el)
                          railRefs.current.set(keyword, el as HTMLElement);
                        else railRefs.current.delete(keyword);
                      }}
                      type="button"
                      class={[
                        "chip kw",
                        keywords.includes(keyword) ? "active" : "",
                        clipped ? "clipped" : "",
                      ]
                        .filter(Boolean)
                        .join(" ")}
                      data-slot="filter-chip"
                      aria-pressed={keywords.includes(keyword)}
                      aria-hidden={clipped ? "true" : undefined}
                      tabIndex={clipped ? -1 : undefined}
                      onKeyDown={onChipKeyDown}
                      onClick={() => toggleKeyword(keyword)}
                    >
                      {keyword}
                    </button>
                  );
                })}
              </div>
            </>
          )}
          {menuKeywords.length > 0 && (
            // Everything the rail had no room for, behind a search box.
            // Not an "expand" that dumps the remaining chips inline: a
            // catalog's keyword vocabulary is open-ended, and a few hundred
            // chips at once is a wall, not a control.
            //
            // A `<details>` for the same reason the platform picker and the
            // version menus are: it opens, closes and takes Escape on its
            // own, with no popover library and no script.
            <details class="kw-menu">
              <summary class="chip" data-slot="filter-chip">
                +{menuKeywords.length} more
              </summary>
              <div class="kw-menu-panel">
                <input
                  type="text"
                  class="kw-menu-search"
                  placeholder="Filter keywords…"
                  aria-label="Filter keywords"
                  value={keywordFilter}
                  onInput={(e) =>
                    setKeywordFilter((e.target as HTMLInputElement).value)
                  }
                />
                <div class="kw-menu-list">
                  {menuShown.map(({ keyword, count }) => (
                    <button
                      key={keyword}
                      type="button"
                      class="kw-menu-item"
                      onClick={() => toggleKeyword(keyword)}
                    >
                      <span>{keyword}</span>
                      <small>{count}</small>
                    </button>
                  ))}
                  {menuShown.length === 0 && (
                    <p class="kw-menu-empty">No keyword matches.</p>
                  )}
                </div>
              </div>
            </details>
          )}
          {hasDeprecated && (
            // A toggle, not a filter: `aria-pressed` rather than the `active`
            // class alone, so it is announced as on/off instead of selected.
            //
            // No count, unlike the kind chips. Theirs is a fixed property of
            // the catalog; this one would be the number currently hidden, which
            // is zero once the toggle is on — so it vanished exactly when
            // pressed and the chip changed width under the pointer.
            <button
              type="button"
              class={
                showDeprecated
                  ? "chip deprecated-toggle active"
                  : "chip deprecated-toggle"
              }
              aria-pressed={showDeprecated}
              title={
                showDeprecated
                  ? "Hide deprecated packages"
                  : "Show deprecated packages"
              }
              onKeyDown={onChipKeyDown}
              onClick={() => setShowDeprecated((on) => !on)}
            >
              deprecated
            </button>
          )}
        </div>
        {/* The bottom line of the toolbar: what the filters above left, and
            the three controls that arrange it. The count leads because it is
            the answer to everything above it; the controls are pushed to the
            far end because they are not. */}
        <div class="meta-row">
          {/* `role="status"` on the count alone. It re-announces "N of M
              packages" as the filters change; putting it on the grid would
              read the whole result list out on every keystroke. */}
          <p class="result-count" role="status" aria-atomic="true">
            {shown.length === counted.length
              ? `${counted.length} packages`
              : `${shown.length} of ${counted.length} packages`}
          </p>
          {/* Held at the far end, away from the chips: choosing an order is
              not filtering. Both halves take an ordinary tab stop; a select
              owns ArrowLeft/Right for its options, so neither can join the
              chips' roving arrow ring. */}
          <div class="sort-group" role="group" aria-label="Sort by">
            {/* Left, because that is the order the pair reads in: "descending,
                by rating". The bars-and-arrow glyph draws the order itself —
                tall-to-short under a down arrow — rather than labelling a flag,
                so it stays right whichever field is selected. */}
            <button
              type="button"
              class="sort-dir"
              data-slot="filter-chip"
              title={
                dir === "asc"
                  ? "Ascending — click for descending"
                  : "Descending — click for ascending"
              }
              aria-label={
                dir === "asc"
                  ? "Sorted ascending; sort descending"
                  : "Sorted descending; sort ascending"
              }
              onClick={() => setDir((d) => (d === "asc" ? "desc" : "asc"))}
            >
              {dir === "asc" ? (
                <ArrowUpNarrowWide size={15} aria-hidden="true" />
              ) : (
                <ArrowDownWideNarrow size={15} aria-hidden="true" />
              )}
            </button>
            <select
              class="sort-field"
              data-slot="filter-chip"
              aria-label="Sort by"
              value={sort}
              onChange={(event) => {
                const next = (event.currentTarget as HTMLSelectElement)
                  .value as Sort;
                setSort(next);
                // Picking a field takes that field's own direction. Carrying
                // the previous one over lands the reader on "oldest first"
                // because they had asked for Z→A a moment ago.
                setDir(NATURAL[next]);
              }}
            >
              <option value="name">name</option>
              <option value="updated">updated</option>
              {hasRatings && <option value="rating">rating</option>}
            </select>
          </div>
          {/* Beside sort, because it answers the same kind of question — how
              the catalog is arranged, not which of it is shown. Two buttons
              rather than one that toggles: a single button has to be labelled
              with either the state or the action, and whichever it picks reads
              as the other half the time. `aria-pressed` on both says which is
              current without either label lying. */}
          <div class="view-toggle" role="group" aria-label="Catalog view">
            <button
              type="button"
              class={view === "cards" ? "view-pick active" : "view-pick"}
              data-slot="filter-chip"
              aria-pressed={view === "cards"}
              title="Cards"
              aria-label="Show packages as cards"
              onClick={() => setView("cards")}
            >
              <LayoutGrid size={15} aria-hidden="true" />
            </button>
            <button
              type="button"
              class={view === "table" ? "view-pick active" : "view-pick"}
              data-slot="filter-chip"
              aria-pressed={view === "table"}
              title="List"
              aria-label="Show packages as a list"
              onClick={() => setView("table")}
            >
              <List size={15} aria-hidden="true" />
            </button>
          </div>
        </div>
      </div>

      {shown.length === 0 ? (
        <p class="empty">No packages match.</p>
      ) : view === "table" ? (
        <PackageTable
          packages={shown}
          hasRatings={hasRatings}
          onKeyDown={onCardKeyDown}
          rootRef={gridRef}
        />
      ) : (
        <ul
          class="grid"
          ref={(el) => {
            gridRef.current = el;
          }}
        >
          {shown.map((p) => (
            // One Tab stop per card, in DOM order — which the grid lays out
            // left to right, top to bottom. Every control inside is taken
            // out of the sequence (`tabindex={-1}`) so tabbing crosses the
            // catalog instead of wading through it; arrow keys move by row
            // and column, and Enter opens the detail page, which carries the
            // same install commands the card's buttons do.
            <li
              key={`${p.namespace}/${p.name}`}
              class="card"
              data-slot="package-card"
              tabIndex={0}
              onKeyDown={onCardKeyDown}
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
                  {p.namespace}
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
                        keywords.includes(kw)
                          ? "chip keyword active"
                          : "chip keyword"
                      }
                      aria-pressed={keywords.includes(kw)}
                      tabIndex={-1}
                      onClick={() => toggleKeyword(kw)}
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
          ))}
        </ul>
      )}
    </section>
  );
}
