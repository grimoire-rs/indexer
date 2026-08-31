import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "preact/hooks";
// Lucide (ISC) draws the toolbar. The brand marks and kind glyphs moved out
// with the card and the row that wear them.
import {
  ArrowDownWideNarrow,
  ArrowUpNarrowWide,
  LayoutGrid,
  List,
  X,
} from "lucide-preact";
import { PackageCard } from "./PackageCard.js";
import { PackageRow } from "./PackageRow.js";
import { keywordFrequency, selectRailKeywords } from "../lib/keywordRail.js";
import { lastUpdated, type CardPackage } from "../lib/catalog.js";

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
 * `popovertarget` needs an id, and the catalog is a singleton on its page —
 * one island, one toolbar, one overflow menu — so this is a constant rather
 * than something generated per mount.
 */
const KEYWORD_MENU_ID = "grim-keyword-overflow";

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

type Key = (a: CardPackage, b: CardPackage) => number;

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
function updatedAt(p: CardPackage): number | null {
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
  a: CardPackage,
  b: CardPackage,
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
  packages: CardPackage[];
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
      {packages.map((p) => (
        <PackageRow
          key={`${p.namespace}/${p.name}`}
          pkg={p}
          hasRatings={hasRatings}
          onKeyDown={onKeyDown}
        />
      ))}
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
  packages: CardPackage[];
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
  /**
   * Where each chip sat at the last commit, as `offsetLeft`/`offsetTop`.
   *
   * Layout positions, deliberately, not `getBoundingClientRect`: the offsets
   * ignore transforms and page scroll, so a chip measured mid-slide reports
   * the seat it is animating towards rather than the box it is drawn in this
   * frame. See the FLIP effect below for why that distinction is the whole
   * fix.
   */
  const railSeats = useRef(new Map<string, { x: number; y: number }>());
  /** The slide each chip is currently running, so a new one can replace it. */
  const railSlides = useRef(new WeakMap<HTMLElement, Animation>());
  const railRef = useRef<HTMLDivElement>(null);

  const kwMenuRef = useRef<HTMLDivElement>(null);
  const kwTriggerRef = useRef<HTMLButtonElement>(null);
  // Drives the trigger's own `aria-expanded` and its open styling. The panel's
  // visibility is the popover's business, not this flag's.
  const [kwMenuOpen, setKwMenuOpen] = useState(false);

  /**
   * Seat the overflow menu under its trigger.
   *
   * The panel is a popover, so it lives in the top layer and is positioned
   * against the viewport rather than against any ancestor — which is the whole
   * point (`.filter-row` is a scroll container and used to crop it). That
   * leaves the seat to us.
   *
   * It always opens downward: the toolbar sits at the top of the page, and a
   * flip would only ever fire on a viewport short enough that the panel has
   * nowhere to go either way. What does not fit becomes `max-height` and
   * scrolls inside the list.
   *
   * Called twice per open, from `beforetoggle` and again from `toggle`. The
   * first runs while the panel is still `display: none`, so its measured width
   * is 0 and the horizontal clamp is a no-op — but the vertical seat is right,
   * which is what stops it appearing in the wrong place for a frame. The
   * second has a real width and finishes the clamp.
   */
  const placeKwMenu = () => {
    const panel = kwMenuRef.current;
    const trigger = kwTriggerRef.current;
    if (!panel || !trigger) return;
    const seat = trigger.getBoundingClientRect();
    const gap = 8;
    const width = panel.getBoundingClientRect().width;
    panel.style.left = `${Math.max(gap, Math.min(seat.left, window.innerWidth - width - gap))}px`;
    panel.style.top = `${seat.bottom + gap}px`;
    panel.style.maxHeight = `${Math.max(120, window.innerHeight - seat.bottom - gap * 3)}px`;
  };

  // A fixed panel does not travel with the trigger, so it is re-seated rather
  // than left behind. Only while open — there is nothing to follow otherwise.
  useEffect(() => {
    if (!kwMenuOpen) return;
    const reseat = () => placeKwMenu();
    // Capturing: the scroll may be any ancestor's, including `.filter-row`'s.
    window.addEventListener("scroll", reseat, { capture: true, passive: true });
    window.addEventListener("resize", reseat);
    return () => {
      window.removeEventListener("scroll", reseat, { capture: true });
      window.removeEventListener("resize", reseat);
    };
  }, [kwMenuOpen]);

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
   * Two choices carry the whole thing, and both are here because the shape
   * they replace — an inline `translate` under the stylesheet's transition,
   * dropped again on a `requestAnimationFrame` — could leave a chip stopped
   * off its seat with no path back:
   *
   * - **Seats come from `offsetLeft`/`offsetTop`, never from
   *   `getBoundingClientRect`.** The offsets are layout positions and ignore
   *   both transforms and scroll; a rect is where the chip is *drawn*, so a
   *   chip measured mid-slide recorded its animated box and the next
   *   inversion compounded that error — the stutter. Mid-slide is the common
   *   case, not a rare one: the fit measurement above commits a second time
   *   whenever a rescore changes how many chips fit, and that commit lands
   *   inside the previous slide. Because the offsets are transform-blind,
   *   that second commit now measures the same seats and starts nothing.
   * - **The slide is a Web Animation, not an inline style.** It needs no
   *   frame to start, so no commit can land between an invert and its play
   *   and freeze a chip at the offset. It writes nothing to `style`, so
   *   there is nothing left to strip when a chip unmounts or a pass is
   *   superseded. And it clears itself the instant it finishes or is
   *   cancelled, which makes "the rail always ends up in its real state" a
   *   property of the mechanism rather than of a cleanup remembering to run.
   */
  useLayoutEffect(() => {
    const previous = railSeats.current;
    const current = new Map<string, { x: number; y: number }>();
    const moved: { el: HTMLElement; dx: number; dy: number }[] = [];
    for (const [keyword, el] of railRefs.current) {
      const x = el.offsetLeft;
      const y = el.offsetTop;
      current.set(keyword, { x, y });
      const was = previous.get(keyword);
      if (!was) continue;
      const dx = was.x - x;
      const dy = was.y - y;
      if (dx !== 0 || dy !== 0) moved.push({ el, dx, dy });
    }
    // Rebuilt from `railRefs` every pass, so a chip that left the rail leaves
    // this map with it and cannot seed a slide if it comes back elsewhere.
    railSeats.current = current;
    if (moved.length === 0) return;
    const rail = railRef.current;
    // Guarded rather than assumed, like the fit observer above: the test
    // renderer's DOM has no Web Animations API, and a rail that does not
    // slide is not worth throwing during a render over.
    if (!rail || typeof rail.animate !== "function") return;
    // The motion is the ornament here — the filtering works identically
    // without it — so a reader who asked for less of it gets none.
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
    // The stylesheet stays the source of truth for how long a slide runs:
    // `--grim-duration-slow` is written in milliseconds and that is the unit
    // the Web Animations API takes, so the token survives the move out of CSS.
    // Read once, after every seat above, so the reads and the writes below
    // stay in two passes rather than interleaving per chip.
    const ms = Number.parseFloat(
      getComputedStyle(rail).getPropertyValue("--grim-duration-slow"),
    );
    for (const { el, dx, dy } of moved) {
      // One slide per chip. A chip that moves again mid-slide takes the new
      // delta from its layout seat, which starts the second slide a step off
      // where the first had drawn it — a jump measured in the pixels one
      // frame of easing covers, and it is bounded, unlike two animations
      // compositing the same property against each other.
      // ponytail: not blended with the in-flight offset, which would cost a
      // computed-style read per chip in the middle of the write pass.
      railSlides.current.get(el)?.cancel();
      railSlides.current.set(
        el,
        el.animate(
          { translate: [`${dx}px ${dy}px`, "none"] },
          { duration: Number.isFinite(ms) ? ms : 200, easing: "ease-out" },
        ),
      );
    }
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
  //
  // Memoized, and `shown` with it, for a reason beyond the scan's own cost:
  // an unmemoized `.filter().sort()` yields a NEW array on every render, so
  // anything downstream keyed on `shown` — the keyword rail's set-cover below
  // — could never hit its own cache. Both had to move together or neither
  // helped. Every dependency here is a primitive or a state array, so the
  // identity is stable exactly when the answer is.
  const matching = useMemo(
    () =>
      packages.filter((p) => {
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
      }),
    [packages, kinds, keywords, q],
  );
  const shown = useMemo(
    () =>
      // `.filter()` already returns a fresh array, so sorting in place here
      // mutates nothing the memo above holds — except in the `showDeprecated`
      // branch, where `matching` IS that array. Copy before sorting.
      (showDeprecated ? [...matching] : matching.filter((p) => !p.deprecated)).sort((a, b) =>
        compare(a, b, sort, dir),
      ),
    [matching, showDeprecated, sort, dir],
  );

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
  // Memoized on `shown` alone, because that is the only thing the scan reads.
  // `selectRailKeywords` is a greedy set-cover over every keyword of every
  // shown package — it scales with catalog size, and unmemoized it ran on
  // EVERY render: each keystroke in the search box, each chip click, each
  // view toggle, and once more for every re-render none of those caused. At a
  // corporate-sized catalog that is the most expensive thing in the render
  // path, repeated for an answer that had not changed.
  const scored = useMemo(() => selectRailKeywords(shown, KEYWORD_CHIP_LIMIT), [shown]);
  const rail = scored
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
            // A popover, and not by preference: the panel used to be an
            // absolutely-positioned child of `.filter-row`, which is a scroll
            // container, so it was cropped to the row and stretched the row's
            // scroll extent — an invisible menu and two stray scrollbars. The
            // top layer is outside every ancestor's `overflow`. Escape and
            // light dismiss come with it; only the seat is ours to compute,
            // and that is `placeKwMenu` above.
            <div class="kw-menu">
              <button
                type="button"
                class="chip"
                data-slot="filter-chip"
                ref={kwTriggerRef}
                popovertarget={KEYWORD_MENU_ID}
                aria-expanded={kwMenuOpen}
              >
                +{menuKeywords.length} more
              </button>
              <div
                class="kw-menu-panel"
                id={KEYWORD_MENU_ID}
                popover="auto"
                ref={kwMenuRef}
                // Both, and in this order: `beforetoggle` runs synchronously
                // inside the show steps, so the panel is seated before it is
                // ever painted; `toggle` runs after, when its width can
                // actually be measured for the clamp.
                onBeforeToggle={(e) => {
                  setKwMenuOpen(e.newState === "open");
                  placeKwMenu();
                }}
                onToggle={(e) => {
                  setKwMenuOpen(e.newState === "open");
                  placeKwMenu();
                }}
              >
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
            </div>
          )}
          {keywords.length > 0 && (
            // Lifts every keyword at once. Only rendered while there is
            // something to lift — a permanently visible control that does
            // nothing most of the time is a chip's width spent on nothing, and
            // this row is already the one that runs out of room first.
            //
            // Keywords only, deliberately. Escape clears the search and the
            // kinds along with them, and a button that quietly did the same
            // would undo a filter the reader did not ask about; the label
            // names exactly what it lifts.
            <button
              type="button"
              class="chip kw-clear"
              data-slot="filter-chip"
              title="Clear the keyword filters"
              onKeyDown={onChipKeyDown}
              onClick={(e) => {
                setKeywords([]);
                // This button is the last thing standing when it is pressed:
                // clearing the facets unmounts it, and focus would land on
                // `<body>`, sending a keyboard reader back to the top of the
                // document. `detail === 0` is a click synthesized by Enter or
                // Space, so a pointer user is left alone and a keyboard one
                // gets the toolbar's own anchor instead of nothing.
                if (e.detail === 0) searchRef.current?.focus();
              }}
            >
              <X size={13} aria-hidden="true" />
              clear {keywords.length}
            </button>
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
            <PackageCard
              key={`${p.namespace}/${p.name}`}
              pkg={p}
              vscodeExtension={vscodeExtension}
              activeKeywords={keywords}
              onToggleKeyword={toggleKeyword}
              onKeyDown={onCardKeyDown}
            />
          ))}
        </ul>
      )}
    </section>
  );
}
