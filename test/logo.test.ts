// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Grimoire Authors

import { describe, expect, it } from "vitest";

import {
  MARKETPLACE_LOGOS,
  MAX_LOGO_BYTES,
  PACKAGE_LOGOS,
  logoExtType,
  logoOk,
  sniffLogo,
} from "../src/logo.js";

const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
const JPEG = Buffer.from("ffd8ffe000104a464946", "hex");
const WEBP = Buffer.concat([Buffer.from("RIFF"), Buffer.from([1, 0, 0, 0]), Buffer.from("WEBPVP8 ")]);
const GIF = Buffer.from("GIF89a\x01\x00\x01\x00", "latin1");
const POLYGLOT = Buffer.concat([PNG, Buffer.from("<html><script>alert(1)</script></html>")]);

describe("sniffLogo", () => {
  it.each([
    ["png", PNG],
    ["jpeg", JPEG],
    ["webp", WEBP],
    ["gif", GIF],
    ["gif", Buffer.from("GIF87a....", "latin1")],
  ])("identifies %s by its magic bytes", (type, bytes) => {
    expect(sniffLogo(bytes)).toBe(type);
  });

  it.each([
    ["a plain svg", Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>')],
    ["an svg with a script", Buffer.from("<svg><script>alert(1)</script></svg>")],
    ["html", Buffer.from("<html><script>alert(1)</script></html>")],
    ["an empty file", Buffer.alloc(0)],
    ["garbage", Buffer.from("not an image at all")],
    ["a truncated png signature", PNG.subarray(0, 7)],
    ["a RIFF that is not webp", Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WAVE")])],
    ["a webp tag with no size field", Buffer.from("RIFFWEBP")],
    ["an oversized png", Buffer.concat([PNG, Buffer.alloc(MAX_LOGO_BYTES)])],
  ])("rejects %s", (_what, bytes) => {
    expect(sniffLogo(bytes)).toBeNull();
  });

  it("takes a png signature followed by html for a png", () => {
    expect(sniffLogo(POLYGLOT)).toBe("png");
  });
});

describe("logoExtType", () => {
  it("maps jpg and jpeg to jpeg, ignoring case", () => {
    expect(logoExtType("jpg", PACKAGE_LOGOS)).toBe("jpeg");
    expect(logoExtType("JPEG", PACKAGE_LOGOS)).toBe("jpeg");
    expect(logoExtType("PNG", PACKAGE_LOGOS)).toBe("png");
  });

  it.each(["svg", "svgz", "html", "", "png/../x", "constructor", "__proto__"])("refuses %j", (ext) => {
    expect(logoExtType(ext, PACKAGE_LOGOS)).toBeNull();
  });

  it("follows the policy it is given", () => {
    expect(logoExtType("jpg", MARKETPLACE_LOGOS)).toBeNull();
    expect(logoExtType("gif", MARKETPLACE_LOGOS)).toBeNull();
    expect(logoExtType("webp", MARKETPLACE_LOGOS)).toBe("webp");
  });
});

describe("logoOk", () => {
  it("accepts bytes under the extension that names their type", () => {
    expect(logoOk("png", PNG, PACKAGE_LOGOS)).toBe(true);
    expect(logoOk("jpg", JPEG, PACKAGE_LOGOS)).toBe(true);
    expect(logoOk("jpeg", JPEG, PACKAGE_LOGOS)).toBe(true);
    expect(logoOk("webp", WEBP, PACKAGE_LOGOS)).toBe(true);
    expect(logoOk("gif", GIF, PACKAGE_LOGOS)).toBe(true);
  });

  it("refuses an extension that disagrees with the bytes", () => {
    expect(logoOk("png", JPEG, PACKAGE_LOGOS)).toBe(false);
    expect(logoOk("jpg", PNG, PACKAGE_LOGOS)).toBe(false);
    expect(logoOk("svg", PNG, PACKAGE_LOGOS)).toBe(false);
    expect(logoOk("", PNG, PACKAGE_LOGOS)).toBe(false);
  });

  it("refuses a type the policy leaves out, even under its own extension", () => {
    expect(logoOk("gif", GIF, MARKETPLACE_LOGOS)).toBe(false);
    expect(logoOk("jpg", JPEG, MARKETPLACE_LOGOS)).toBe(false);
    expect(logoOk("png", PNG, MARKETPLACE_LOGOS)).toBe(true);
  });
});
