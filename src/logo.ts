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
// Namespaces whose elements a browser runs or embeds as a document inside an SVG.
const ACTIVE_NS = new Set(["http://www.w3.org/1999/xhtml", "http://www.w3.org/1998/Math/MathML"]);
// Local names, lowercased: script, embedded HTML, and SVG Tiny event listeners.
const ACTIVE_ELEMENTS = new Set(["script", "foreignobject", "iframe", "embed", "object", "handler", "listener"]);

const FRAGMENT = /^#[A-Za-z_][A-Za-z0-9_.-]*$/;
// An inline raster; one in an SVG image cannot run script or fetch anything.
const DATA_IMAGE = /^data:image\/(?:png|jpeg|gif|webp)[;,]/i;
const PROLOG = /^<\?xml(?:\s+(?:version|encoding|standalone)\s*=\s*(?:"[\w.-]*"|'[\w.-]*'))*\s*\?>/;
// A doctype with a public or system id but no internal subset: entities there could spell markup.
const DOCTYPE = /^<!DOCTYPE\s+[A-Za-z][\w:.-]*(?:\s+(?:PUBLIC\s+(?:"[^"]*"|'[^']*')\s+|SYSTEM\s+)(?:"[^"]*"|'[^']*'))?\s*>/;
const TAG = /^<(\/?)([A-Za-z_][A-Za-z0-9:_.-]*)((?:\s+[^\s=<>/"']+\s*=\s*(?:"[^"<]*"|'[^'<]*'))*)\s*(\/?)>/;
const ATTR = /([^\s=<>/"']+)\s*=\s*(?:"([^"<]*)"|'([^'<]*)')/g;
const REF = /&(?:(amp|lt|gt|quot|apos)|#([0-9]{1,7})|#x([0-9A-Fa-f]{1,6}));/g;
const NAMED: Readonly<Record<string, string>> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

/** `raw` with its references resolved, or null when one names a DTD entity or no character. */
function decode(raw: string): string | null {
  if (raw.replace(REF, "").includes("&")) return null;
  let bad = false;
  const out = raw.replace(REF, (_m, named?: string, dec?: string, hex?: string) => {
    if (named) return NAMED[named] ?? "";
    const code = dec ? Number(dec) : parseInt(hex ?? "", 16);
    if (code > 0x10ffff) bad = true;
    return bad ? "" : String.fromCodePoint(code);
  });
  return bad ? null : out;
}

const URL_FN = /url\(\s*(["']?)([^)"']*)\1\s*\)/gi;

/** True when `css` fetches nothing: no `@import`, `image-set` or escape, every `url()` in-file or an inline raster. */
function cssInert(css: string): boolean {
  if (/@import|image-set|\\/i.test(css)) return false;
  for (const m of css.matchAll(URL_FN)) if (!refInert(m[2] ?? "")) return false;
  return !/url\(/i.test(css.replace(URL_FN, ""));
}

const refInert = (ref: string): boolean => FRAGMENT.test(ref.trim()) || DATA_IMAGE.test(ref.trim());
const local = (name: string): string => name.slice(name.indexOf(":") + 1).toLowerCase();

/**
 * True when `bytes` are an SVG with nothing a browser runs or fetches, opened
 * top-level or not. The bytes are judged, never rewritten: one that fails is
 * dropped like a mislabelled PNG.
 *
 * Everything an editor writes passes — comments, CDATA, `<style>`, `style`,
 * `<text>`, filters, editor namespaces and metadata — and only the active
 * parts are refused: script and event handlers, `foreignObject` and HTML or
 * MathML namespaces, an `href` outside the file (a data: raster aside),
 * animation of an `href`, a processing instruction, a doctype internal
 * subset, and CSS that imports or fetches.
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
  let doctype = false;
  // A comment splits a style's text but not its CSS, so the whole of it is judged at the close.
  let css = "";
  while (text.length > 0) {
    const lt = text.indexOf("<");
    const raw = lt === -1 ? text : text.slice(0, lt);
    const chars = decode(raw);
    if (chars === null || (open.length === 0 && raw.trim() !== "")) return false;
    if (open.at(-1) === "style") css += chars;
    if (lt === -1) break;
    text = text.slice(lt);

    if (text.startsWith("<!--")) {
      const end = text.indexOf("-->", 4);
      if (end === -1) return false;
      text = text.slice(end + 3);
      continue;
    }
    if (text.startsWith("<![CDATA[")) {
      const end = text.indexOf("]]>", 9);
      if (end === -1 || open.length === 0) return false;
      if (open.at(-1) === "style") css += text.slice(9, end);
      text = text.slice(end + 3);
      continue;
    }
    if (text.startsWith("<!DOCTYPE")) {
      const dt = DOCTYPE.exec(text);
      if (!dt || doctype || root) return false;
      doctype = true;
      text = text.slice(dt[0].length);
      continue;
    }
    const tag = TAG.exec(text);
    if (!tag) return false;
    const [whole, close, name = "", attrs = "", selfClose] = tag;
    text = text.slice(whole.length);
    if (close) {
      if (attrs || selfClose || open.pop() !== local(name)) return false;
      if (local(name) === "style" && !cssInert(css)) return false;
      css = "";
      continue;
    }
    if (ACTIVE_ELEMENTS.has(local(name))) return false;
    if (open.length === 0) {
      if (root || name !== "svg") return false;
      root = true;
    }
    const seen = new Set<string>();
    for (const m of attrs.matchAll(ATTR)) {
      const [, key = "", dq, sq] = m;
      const value = decode(dq ?? sq ?? "");
      const attr = local(key);
      if (value === null || seen.has(key) || attr.startsWith("on")) return false;
      seen.add(key);
      if (key === "xmlns" && value !== SVG_NS) return false;
      if (key.startsWith("xmlns:") && ACTIVE_NS.has(value.trim())) return false;
      if (attr === "href" && !refInert(value)) return false;
      if (attr === "attributename" && /href|^on/i.test(local(value.trim()))) return false;
      // A prefixed attribute is editor data (`inkscape:export-filename`); an unprefixed one may be CSS.
      if (!key.includes(":") && !cssInert(value)) return false;
    }
    if (open.length === 0 && !seen.has("xmlns")) return false;
    if (!selfClose) open.push(local(name));
  }
  return root && open.length === 0;
}
