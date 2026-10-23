// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Grimoire Authors

/**
 * The one place that decides whether bytes are a logo this index publishes.
 *
 * A logo is served as a static file at its own URL on the index origin, so its
 * type decides what a browser does with it there. SVG runs script when opened
 * top-level, so it is accepted only when [`svgSafe`] passes it unchanged. The
 * rest are identified by magic bytes, and the extension must name the same
 * type: the host serves by extension, so a PNG signature followed by HTML is
 * harmless only as `.png`. `enrich`,
 * `compileIndex`, the checkpoint restore and the marketplace reader all use it.
 */

// Logo and docs match what `grim export` accepts (1 MiB), so a valid export loses nothing.
export const MAX_LOGO_BYTES = 1024 * 1024;

export type LogoType = "png" | "jpeg" | "webp" | "gif" | "svg";

/** What a package may ship. */
export const PACKAGE_LOGOS: readonly LogoType[] = ["png", "jpeg", "webp", "gif", "svg"];
/** What a marketplace plugin may ship. */
export const MARKETPLACE_LOGOS: readonly LogoType[] = ["png", "webp", "svg"];

const EXT_TYPE: ReadonlyMap<string, LogoType> = new Map([
  ["png", "png"],
  ["jpg", "jpeg"],
  ["jpeg", "jpeg"],
  ["webp", "webp"],
  ["gif", "gif"],
  ["svg", "svg"],
]);

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** The raster type `bytes` begin as, or null: empty, over the cap, or not one of the four. */
export function sniffLogo(bytes: Buffer): LogoType | null {
  if (bytes.length === 0 || bytes.length > MAX_LOGO_BYTES) return null;
  if (bytes.subarray(0, 8).equals(PNG_MAGIC)) return "png";
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "jpeg";
  const head = bytes.subarray(0, 12).toString("latin1");
  if (head.length === 12 && head.startsWith("RIFF") && head.endsWith("WEBP")) return "webp";
  if (head.startsWith("GIF87a") || head.startsWith("GIF89a")) return "gif";
  return null;
}

/** The type a file extension names, if `allowed` includes it. `jpg` and `jpeg` both mean JPEG. */
export function logoExtType(ext: string, allowed: readonly LogoType[]): LogoType | null {
  const type = EXT_TYPE.get(ext.toLowerCase());
  return type !== undefined && allowed.includes(type) ? type : null;
}

/** True when `bytes` are an allowed image and `ext` is the extension for that very type. */
export function logoOk(ext: string, bytes: Buffer, allowed: readonly LogoType[]): boolean {
  const want = logoExtType(ext, allowed);
  if (want === "svg") return svgSafe(bytes);
  const type = sniffLogo(bytes);
  return type !== null && type === want;
}

const SVG_NS = "http://www.w3.org/2000/svg";
const XLINK_NS = "http://www.w3.org/1999/xlink";

const SVG_ELEMENTS = new Set([
  "svg", "g", "path", "circle", "ellipse", "rect", "line", "polyline", "polygon", "defs", "symbol", "use",
  "linearGradient", "radialGradient", "stop", "clipPath", "mask", "title", "desc",
]);

const SVG_ATTRS = new Set([
  "viewBox", "width", "height", "x", "y", "x1", "y1", "x2", "y2", "cx", "cy", "r", "rx", "ry", "fx", "fy",
  "d", "points", "transform", "fill", "fill-rule", "fill-opacity", "opacity", "clip-path", "clip-rule",
  "mask", "offset", "stop-color", "stop-opacity", "gradientUnits", "gradientTransform", "preserveAspectRatio",
  "id", "class", "version", "xmlns", "xmlns:xlink", "href", "xlink:href",
]);

const NAME = /^[A-Za-z][A-Za-z0-9:_-]*$/;
const FRAGMENT = /^#[A-Za-z_][A-Za-z0-9_.-]*$/;
// The five predefined XML entities and character references; anything else could name a DTD entity.
const ENTITIES = /&(?!(?:amp|lt|gt|quot|apos|#[0-9]{1,7}|#x[0-9A-Fa-f]{1,6});)/;
const PROLOG = /^<\?xml(?:\s+(?:version|encoding|standalone)\s*=\s*(?:"[\w.-]*"|'[\w.-]*'))*\s*\?>/;
const TAG = /^<(\/?)([A-Za-z][A-Za-z0-9:_-]*)((?:\s+[^\s=<>/"']+\s*=\s*(?:"[^"<]*"|'[^'<]*'))*)\s*(\/?)>/;
const ATTR = /([^\s=<>/"']+)\s*=\s*(?:"([^"<]*)"|'([^'<]*)')/g;

/**
 * True when `bytes` are an SVG made only of shapes, gradients, clips and
 * presentation attributes — nothing a browser runs or fetches, opened
 * top-level or not. The bytes are judged, never rewritten: one that fails is
 * dropped like a mislabelled PNG.
 *
 * ponytail: a hand tokenizer that refuses anything it does not recognise
 * (doctype, comment, CDATA, processing instruction, `style`, external `url()`).
 * Some real logos will be refused; widen the two allowlists when one is.
 */
export function svgSafe(bytes: Buffer): boolean {
  if (bytes.length === 0 || bytes.length > MAX_LOGO_BYTES) return false;
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return false;
  }
  if (text.startsWith("\uFEFF")) text = text.slice(1);
  text = text.trimStart();
  const prolog = PROLOG.exec(text);
  if (prolog) text = text.slice(prolog[0].length);

  const open: string[] = [];
  let root = false;
  while (text.length > 0) {
    const lt = text.indexOf("<");
    const chars = lt === -1 ? text : text.slice(0, lt);
    if (ENTITIES.test(chars) || (open.length === 0 && chars.trim() !== "")) return false;
    if (lt === -1) break;
    text = text.slice(lt);
    const tag = TAG.exec(text);
    if (!tag) return false;
    const [whole, close, name = "", attrs = "", selfClose] = tag;
    text = text.slice(whole.length);
    if (close) {
      if (attrs || selfClose || open.pop() !== name) return false;
      continue;
    }
    if (!SVG_ELEMENTS.has(name)) return false;
    if (open.length === 0) {
      if (root || name !== "svg") return false;
      root = true;
    }
    const seen = new Set<string>();
    for (const m of attrs.matchAll(ATTR)) {
      const [, key = "", dq, sq] = m;
      const value = dq ?? sq ?? "";
      if (!NAME.test(key) || seen.has(key) || !SVG_ATTRS.has(key)) return false;
      seen.add(key);
      if (key === "xmlns" && value !== SVG_NS) return false;
      if (key === "xmlns:xlink" && value !== XLINK_NS) return false;
      if ((key === "href" || key === "xlink:href") && !FRAGMENT.test(value)) return false;
      // No references in values at all: `&#117;rl(` would spell an external `url(` past the check below.
      if (value.includes("&")) return false;
      for (const url of value.matchAll(/url\(([^)]*)\)/gi)) if (!FRAGMENT.test((url[1] ?? "").trim())) return false;
    }
    if (open.length === 0 && !seen.has("xmlns")) return false;
    if (!selfClose) open.push(name);
  }
  return root && open.length === 0;
}
