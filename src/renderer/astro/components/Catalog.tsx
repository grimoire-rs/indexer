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
} from "lucide-preact";
import { mdiMicrosoftVisualStudioCode } from "@mdi/js";
import { BrandMark } from "./BrandMark.js";
import { DEPRECATED_MARK, KIND_MARKS, KindMark } from "./KindMark.js";
import { withBase } from "../lib/base.js";
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
 * The split is deliberate and matches grim: `q` and `kind` are *what you are
 * looking at* — a keyword chip on a package page links to `/?q=<kw>`, so that
 * half has to stay shareable — while sort, direction and deprecated
 * visibility are *how you like the catalog arranged*, the same answer on
 * every visit. grim keeps `show_deprecated` in its config file for exactly
 * that reason.
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
  const [kind, setKind] = useState<string | null>(null);
  const [sort, setSort] = useState<Sort>("name");
  // Direction, not "reversed": what the arrow draws is the order itself.
  const [dir, setDir] = useState<Dir>(NATURAL.name);
  // Deprecated packages are hidden until asked for: a retired package is
  // noise for someone browsing what to install, and the publisher already
  // said as much by deprecating it.
  const [showDeprecated, setShowDeprecated] = useState(false);

  const searchRef = useRef<HTMLInputElement>(null);
  const gridRef = useRef<HTMLUListElement>(null);
  const controlsRef = useRef<HTMLDivElement>(null);

  const cardsOf = () => [
    ...(gridRef.current?.querySelectorAll<HTMLElement>("li.card") ?? []),
  ];
  const chipsOf = () => [
    ...(controlsRef.current?.querySelectorAll<HTMLElement>("button.chip") ??
      []),
  ];

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
   * reaches a class name and `sort` selects a comparator, so neither follows
   * a hand-typed URL or a hand-edited storage entry anywhere the controls
   * cannot go.
   */
  const applyView = () => {
    const params = new URLSearchParams(location.search);
    const k = params.get("kind");
    const s = readPref("sort");
    const d = readPref("dir");
    const field: Sort = s === "updated" || s === "rating" ? s : "name";
    setQuery(params.get("q") ?? "");
    setKind(k && KNOWN_KINDS.includes(k) ? k : null);
    setSort(field);
    setDir(d === "asc" || d === "desc" ? d : NATURAL[field]);
    // A flag: stored at all means on.
    setShowDeprecated(readPref("deprecated") !== null);
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
    set("kind", kind);
    const search = params.toString();
    const next = `${location.pathname}${search ? `?${search}` : ""}${location.hash}`;
    if (next !== `${location.pathname}${location.search}${location.hash}`) {
      history.replaceState(history.state, "", next);
    }
  }, [seeded, query, kind]);

  // The preferences, into storage — so the next visit opens the way this one
  // ended. Each is stored only when it is not the default, so a reader who
  // never touched a control leaves nothing behind.
  useEffect(() => {
    if (!seeded) return;
    writePref("sort", sort === "name" ? null : sort);
    writePref("dir", dir === NATURAL[sort] ? null : dir);
    writePref("deprecated", showDeprecated ? "1" : null);
  }, [seeded, sort, dir, showDeprecated]);

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
        active instanceof HTMLElement ? active.closest("li.card") : null;
      if (!query && kind === null && !card) return; // nothing selected: not our key
      event.preventDefault();
      setQuery("");
      setKind(null);
      if (card) (active as HTMLElement).blur();
    };
    document.addEventListener("keydown", onEscape);
    return () => document.removeEventListener("keydown", onEscape);
  }, [query, kind]);

  /**
   * The filter and sort chips are not Tab stops — Tab is reserved for
   * crossing the catalog, so it runs search → card → card. The chips sit in
   * the row above the grid, so they are reached the way that row is:
   * ArrowUp out of the top card row, ArrowDown back into it.
   *
   * The one case that would strand them is an empty result set, where there
   * is no card to arrow up from — so with nothing shown they rejoin the Tab
   * order (see `chipTabIndex` below), which is also exactly when a reader
   * needs them most.
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
    } else if (event.key === "Escape" && !query && kind === null) {
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

  const kinds = useMemo(() => {
    const counts = new Map<string, number>();
    for (const p of counted) counts.set(p.kind, (counts.get(p.kind) ?? 0) + 1);
    return [...counts.entries()].sort(
      (a, b) => kindOrder(a[0]) - kindOrder(b[0]) || a[0].localeCompare(b[0]),
    );
  }, [counted]);

  const q = query.trim().toLowerCase();
  // Query and kind first, deprecation last — so the toggle can report how
  // many entries *it alone* is holding back, rather than a catalog-wide
  // number that has nothing to do with what is on screen.
  const matching = packages.filter((p) => {
    if (kind && p.kind !== kind) return false;
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

  // A catalog with nothing deprecated gets no toggle — a control that can
  // only ever be a no-op is worse than its absence. An index that publishes
  // no ratings gets no rating chip for the same reason.
  const hasDeprecated = packages.some((p) => p.deprecated);
  const hasRatings = packages.some((p) => p.rating);

  // Chips leave the Tab order only while there is a grid to arrow up from.
  const chipTabIndex = shown.length === 0 ? 0 : -1;

  return (
    <section class="catalog" data-slot="catalog">
      <div class="controls" data-slot="catalog-toolbar" ref={controlsRef}>
        <div class="search-field" data-slot="catalog-search">
          <input
            ref={searchRef}
            type="search"
            placeholder={`Search ${counted.length} packages…`}
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
        {/* Beside the search field rather than among the chips: choosing an
            order is not filtering, and it is built to the field's own
            measurements — same height, same radius — so the two read as one
            control strip. Both halves take an ordinary tab stop; a select
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
        {/* Divides sort from filter — two different questions sharing a row.
            Decorative only: each group already carries its own aria-label,
            so this is hidden rather than announced. */}
        {/* Its own line, always. The kind filters and the deprecated toggle
            are one row and the search field and sort control are another;
            without this wrapper a wide viewport fits all four on one line
            and the toolbar stops reading as two questions. */}
        <div class="filter-row">
          <div class="chips" role="group" aria-label="Filter by kind">
            <button
              type="button"
              class={kind === null ? "chip active" : "chip"}
              data-slot="filter-chip"
              tabIndex={chipTabIndex}
              onKeyDown={onChipKeyDown}
              onClick={() => setKind(null)}
            >
              all <small>{counted.length}</small>
            </button>
            {kinds.map(([k, count]) => (
              <button
                key={k}
                type="button"
                class={kind === k ? `chip active kind-${k}` : `chip kind-${k}`}
                data-slot="filter-chip"
                tabIndex={chipTabIndex}
                onKeyDown={onChipKeyDown}
                onClick={() => setKind(kind === k ? null : k)}
              >
                {k} <small>{count}</small>
              </button>
            ))}
          </div>
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
              tabIndex={chipTabIndex}
              onKeyDown={onChipKeyDown}
              onClick={() => setShowDeprecated((on) => !on)}
            >
              deprecated
            </button>
          )}
        </div>
      </div>

      {shown.length === 0 ? (
        <p class="empty">No packages match.</p>
      ) : (
        <ul class="grid" ref={gridRef}>
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
                    size={56}
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
                  {p.keywords.slice(0, 5).map((kw) => (
                    <button
                      key={kw}
                      type="button"
                      class="chip keyword"
                      tabIndex={-1}
                      onClick={() => setQuery(kw)}
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
