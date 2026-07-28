import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "preact/hooks";
// Lucide (ISC) draws the UI; brand marks come from `@mdi/js`, which Lucide
// deliberately does not carry. No SVG on this site is hand-written.
import { Check, FolderRoot, Globe, Image, ImageOff } from "lucide-preact";
import { mdiMicrosoftVisualStudioCode } from "@mdi/js";
import { BrandMark } from "./BrandMark.js";
import { withBase } from "../lib/base.js";
import { timeAgo, vscodeUrl, type CatalogPackage } from "../lib/catalog.js";

// Known kinds get stable chip ordering + badge colors; unknown kinds
// (future schema growth) still render with a neutral badge.
const KNOWN_KINDS = ["skill", "rule", "agent", "mcp", "bundle"];

function kindOrder(kind: string): number {
  const i = KNOWN_KINDS.indexOf(kind);
  return i === -1 ? KNOWN_KINDS.length : i;
}

type Sort = "name" | "updated";

// Deprecated packages sink to the bottom regardless of sort mode; the
// chosen sort only orders within the two groups.
function compare(a: CatalogPackage, b: CatalogPackage, sort: Sort): number {
  const dep = Number(!!a.deprecated) - Number(!!b.deprecated);
  if (dep !== 0) return dep;
  if (sort === "name") return a.name.localeCompare(b.name);
  if (!a.created || !b.created) return (a.created ? 0 : 1) - (b.created ? 0 : 1);
  return new Date(b.created).getTime() - new Date(a.created).getTime();
}

// The two install scopes previously wore the VS Code extension's own
// codicons so "project" and "global" read identically in both. That parity
// is gone on purpose: every icon now comes from one set. `FolderRoot` and
// `Globe` are the nearest Lucide equivalents and carry the same meaning.

/** Typing inside one of these means a bare keystroke is text, not a shortcut. */
function isTyping(el: EventTarget | null): boolean {
  const node = el as HTMLElement | null;
  if (!node) return false;
  return node.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(node.tagName);
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
        style={{ background: `var(--kind-${pkg.kind}, var(--muted))` }}
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
        new CustomEvent("grimoire:copied", { detail: { name, value: command } }),
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
      {copied ? <Check size={14} /> : variant === "global" ? <Globe size={14} /> : <FolderRoot size={14} />}
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
  // Seeded from `?q=…` on the very first render, not from an effect: a
  // keyword chip on a package page links here, and filtering one render late
  // means painting the full catalog and then collapsing it. The server has
  // no `location`, so it renders the unfiltered list — which is what a
  // crawler and a `?q=`-less visitor should both get.
  const [query, setQuery] = useState(() =>
    typeof location === "undefined" ? "" : (new URLSearchParams(location.search).get("q") ?? ""),
  );
  const [kind, setKind] = useState<string | null>(null);
  const [sort, setSort] = useState<Sort>("name");
  // Deprecated packages are hidden until asked for: a retired package is
  // noise for someone browsing what to install, and the publisher already
  // said as much by deprecating it.
  const [showDeprecated, setShowDeprecated] = useState(false);

  const searchRef = useRef<HTMLInputElement>(null);
  const gridRef = useRef<HTMLUListElement>(null);
  const controlsRef = useRef<HTMLDivElement>(null);

  const cardsOf = () => [...(gridRef.current?.querySelectorAll<HTMLElement>("li.card") ?? [])];
  const chipsOf = () => [
    ...(controlsRef.current?.querySelectorAll<HTMLElement>("button.chip") ?? []),
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
      behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
    });
  };

  // Base.astro hides the catalog before first paint when the URL carries a
  // query. Reveal it once this render — the filtered one — has hit the DOM.
  // A layout effect, so the reveal lands in the same frame as the content.
  useLayoutEffect(() => {
    // Hydration attaches handlers but does not diff props against the server
    // markup, so the box the server rendered empty stays empty even though
    // this render filtered on `query`. Written straight to the DOM, which is
    // what the vnode already claims.
    const input = searchRef.current;
    if (input && input.value !== query) input.value = query;
    delete document.documentElement.dataset.query;
  }, []);

  // `/` jumps to the search box, the convention every package registry
  // shares. Bound on the document so it works wherever the reader is.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "/" || event.metaKey || event.ctrlKey || event.altKey) return;
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
      const card = active instanceof HTMLElement ? active.closest("li.card") : null;
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
  const shown = (showDeprecated ? matching : matching.filter((p) => !p.deprecated)).sort((a, b) =>
    compare(a, b, sort),
  );

  // A catalog with nothing deprecated gets no toggle — a control that can
  // only ever be a no-op is worse than its absence.
  const hasDeprecated = packages.some((p) => p.deprecated);

  // Chips leave the Tab order only while there is a grid to arrow up from.
  const chipTabIndex = shown.length === 0 ? 0 : -1;

  return (
    <section class="catalog">
      <div class="controls" ref={controlsRef}>
        <div class="search-field">
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
          <kbd class="search-hint" aria-hidden="true">/</kbd>
        </div>
        <div class="chips" role="group" aria-label="Sort by">
          <button
            type="button"
            class={sort === "name" ? "chip active" : "chip"}
            tabIndex={chipTabIndex}
            onKeyDown={onChipKeyDown}
            onClick={() => setSort("name")}
          >
            name
          </button>
          <button
            type="button"
            class={sort === "updated" ? "chip active" : "chip"}
            tabIndex={chipTabIndex}
            onKeyDown={onChipKeyDown}
            onClick={() => setSort("updated")}
          >
            updated
          </button>
        </div>
        {/* Divides sort from filter — two different questions sharing a row.
            Decorative only: each group already carries its own aria-label,
            so this is hidden rather than announced. */}
        <span class="chip-sep" aria-hidden="true"></span>
        <div class="chips" role="group" aria-label="Filter by kind">
          <button
            type="button"
            class={kind === null ? "chip active" : "chip"}
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
            class={showDeprecated ? "chip deprecated-toggle active" : "chip deprecated-toggle"}
            aria-pressed={showDeprecated}
            title={showDeprecated ? "Hide deprecated packages" : "Show deprecated packages"}
            tabIndex={chipTabIndex}
            onKeyDown={onChipKeyDown}
            onClick={() => setShowDeprecated((on) => !on)}
          >
            deprecated
          </button>
        )}
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
              tabIndex={0}
              onKeyDown={onCardKeyDown}
            >
              <div class="card-head">
                <CardLogo pkg={p} />
                <h2>
                  <a href={withBase(`/p/${p.namespace}/${p.name}/`)} tabIndex={-1}>
                    {p.name}
                  </a>
                </h2>
                {p.deprecated ? (
                  <span class="badge deprecated">deprecated</span>
                ) : (
                  <span class={`badge kind-${p.kind}`}>{p.kind}</span>
                )}
              </div>
              <p class="namespace">{p.namespace}</p>
              {(p.version || p.license || p.created) && (
                <div class="meta-row">
                  {p.version && <span class="pill version">v{p.version}</span>}
                  {p.license && <span class="pill license">{p.license}</span>}
                  {p.created && timeAgo(p.created) && (
                    <time class="updated" datetime={p.created} title={p.created}>
                      updated {timeAgo(p.created)}
                    </time>
                  )}
                </div>
              )}
              {p.deprecated && (
                <p class="deprecated-strip">
                  deprecated
                  {p.replacedBy ? ` — replaced by ${p.replacedBy}` : ""}
                </p>
              )}
              {p.description && <p class="description">{p.description}</p>}
              {p.keywords && p.keywords.length > 0 && (
                <div class="keywords">
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
                  {p.keywords.length > 5 && (
                    <span class="chip keyword overflow">
                      +{p.keywords.length - 5}
                    </span>
                  )}
                </div>
              )}
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
                  <CopyButton command={`grim add ${p.ref}`} name={`project add for ${p.name}`} />
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
                {p.repository && (
                  <a
                    class="source"
                    href={p.repository}
                    target="_blank"
                    rel="noopener noreferrer"
                    tabIndex={-1}
                  >
                    source
                  </a>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
