// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Grimoire Authors

// The package logo slot, shared by the card and the table row — and split out
// of `Catalog.tsx` so that replacing either of those under `theme/components/`
// does not mean re-implementing the three states a logo has here.
import { useEffect, useRef, useState } from "preact/hooks";
import { Image, ImageOff } from "lucide-preact";
import { withBase } from "../lib/base.js";
import type { CardPackage } from "../lib/catalog.js";

export /**
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
function CardLogo({ pkg }: { pkg: CardPackage }) {
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
