// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Grimoire Authors

/**
 * The one place that decides whether bytes are a logo this index publishes.
 *
 * A logo is served as a static file at its own URL on the index origin, so its
 * type decides what a browser does with it there. SVG runs script when opened
 * top-level and is never accepted. The rest are identified by magic bytes, and
 * the extension must name the same type: the host serves by extension, so a
 * PNG signature followed by HTML is harmless only as `.png`. `enrich`,
 * `compileIndex`, the checkpoint restore and the marketplace reader all use it.
 */

// Logo and docs match what `grim export` accepts (1 MiB), so a valid export loses nothing.
export const MAX_LOGO_BYTES = 1024 * 1024;

export type LogoType = "png" | "jpeg" | "webp" | "gif";

/** What a package may ship. */
export const PACKAGE_LOGOS: readonly LogoType[] = ["png", "jpeg", "webp", "gif"];
/** What a marketplace plugin may ship. */
export const MARKETPLACE_LOGOS: readonly LogoType[] = ["png", "webp"];

const EXT_TYPE: ReadonlyMap<string, LogoType> = new Map([
  ["png", "png"],
  ["jpg", "jpeg"],
  ["jpeg", "jpeg"],
  ["webp", "webp"],
  ["gif", "gif"],
]);

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** The image type `bytes` begin as, or null: empty, over the cap, or not one of the four. */
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
  const type = sniffLogo(bytes);
  return type !== null && type === logoExtType(ext, allowed);
}
