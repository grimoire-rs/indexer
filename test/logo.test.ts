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
  svgSafe,
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

  it.each(["svgz", "html", "", "png/../x", "constructor", "__proto__"])("refuses %j", (ext) => {
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
    expect(logoOk("png", Buffer.from(SVG), PACKAGE_LOGOS)).toBe(false);
    expect(logoOk("", PNG, PACKAGE_LOGOS)).toBe(false);
  });

  it("refuses a type the policy leaves out, even under its own extension", () => {
    expect(logoOk("gif", GIF, MARKETPLACE_LOGOS)).toBe(false);
    expect(logoOk("jpg", JPEG, MARKETPLACE_LOGOS)).toBe(false);
    expect(logoOk("png", PNG, MARKETPLACE_LOGOS)).toBe(true);
  });
});

const SVG =
  '<?xml version="1.0" encoding="UTF-8"?>\n' +
  '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 24 24">' +
  '<title>Acme &amp; co</title><defs><linearGradient id="g"><stop offset="0" stop-color="#fff"/></linearGradient>' +
  '<path id="p" d="M0 0h24v24z"/></defs><use xlink:href="#p" fill="url(#g)"/></svg>\n';

describe("svgSafe", () => {
  it("accepts shapes, gradients and fragment references", () => {
    expect(svgSafe(Buffer.from(SVG))).toBe(true);
    expect(logoOk("svg", Buffer.from(SVG), PACKAGE_LOGOS)).toBe(true);
    expect(logoOk("svg", Buffer.from(SVG), MARKETPLACE_LOGOS)).toBe(true);
  });

  const wrap = (inner: string, attrs = "") => `<svg xmlns="http://www.w3.org/2000/svg"${attrs}>${inner}</svg>`;
  it.each([
    [
      "an Inkscape export",
      '<?xml version="1.0" encoding="UTF-8" standalone="no"?>\n<!-- Created with Inkscape -->\n' +
        '<svg xmlns="http://www.w3.org/2000/svg" xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape" ' +
        'xmlns:sodipodi="http://sodipodi.sourceforge.net/DTD/sodipodi-0.dtd" xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" ' +
        'width="24mm" height="24mm" inkscape:export-filename="C:\\logo.png" sodipodi:docname="logo.svg">' +
        '<sodipodi:namedview id="nv" inkscape:zoom="1"/><metadata><rdf:RDF/></metadata>' +
        '<g inkscape:label="Layer 1" inkscape:groupmode="layer"><text xml:space="preserve" ' +
        'style="font-family:&apos;Fira Sans&apos;;fill:#000"><tspan>Acme</tspan></text></g></svg>',
    ],
    [
      "an Illustrator export",
      '<?xml version="1.0" encoding="utf-8"?>\n<!-- Generator: Adobe Illustrator 27.0 -->\n' +
        '<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd">\n' +
        '<svg version="1.1" xmlns="http://www.w3.org/2000/svg" x="0px" y="0px" viewBox="0 0 24 24" ' +
        'style="enable-background:new 0 0 24 24;" xml:space="preserve"><style type="text/css">\n' +
        "\t.st0{fill:url(#SVGID_1_);}\n</style><circle class=\"st0\" stroke=\"#000\" stroke-width=\"2\" stroke-dasharray=\"1 2\" cx=\"12\" cy=\"12\" r=\"10\"/></svg>",
    ],
    [
      "filters, links and an inline raster",
      wrap(
        '<defs><filter id="f"><feGaussianBlur stdDeviation="1"/></filter></defs>' +
          '<a href="#f"><image href="data:image/png;base64,iVBORw0KGgo=" filter="url(#f)"/></a>' +
          "<style><![CDATA[rect{opacity:.5}]]></style>",
      ),
    ],
  ])("accepts %s", (_label, text) => {
    expect(svgSafe(Buffer.from(text))).toBe(true);
  });

  it.each([
    ["a script element", wrap("<script>alert(1)</script>")],
    ["an event handler", wrap("", ' onload="alert(1)"')],
    ["a foreignObject", wrap("<foreignObject><div/></foreignObject>")],
    ["an external href", wrap('<use href="https://evil.test/x.svg#a"/>')],
    ["a javascript href", wrap('<use xlink:href="javascript:alert(1)"/>')],
    ["an external url()", wrap('<rect fill="url(https://evil.test/a)"/>')],
    ["a reference inside a value", wrap('<rect fill="&#117;rl(https://evil.test/a)"/>')],
    ["a doctype with an entity", `<!DOCTYPE svg [<!ENTITY x "y">]>${wrap("&x;")}`],
    ["an undeclared entity", wrap("<title>&x;</title>")],
    ["a processing instruction", wrap('<?xml-stylesheet href="x.css"?>')],
    ["an unbalanced tag", '<svg xmlns="http://www.w3.org/2000/svg"><g></svg>'],
    ["a missing namespace", "<svg></svg>"],
    ["a foreign namespace", '<svg xmlns="http://www.w3.org/1999/xhtml"></svg>'],
    ["a second root", `${wrap("")}${wrap("")}`],
    ["text outside the root", `${wrap("")}x`],
    ["a duplicate attribute", wrap("", ' width="1" width="2"')],
    ["a prefixed script", wrap('<s:script xmlns:s="http://www.w3.org/2000/svg">alert(1)</s:script>')],
    ["an XHTML namespace", wrap('<h:p xmlns:h="http://www.w3.org/1999/xhtml"/>')],
    ["an encoded XHTML namespace", wrap('<h:p xmlns:h="http://www.w3.org/1999/xht&#109;l"/>')],
    ["an animated href", wrap('<a><set attributeName="href" to="javascript:alert(1)"/></a>')],
    ["an svg data image", wrap('<image href="data:image/svg+xml,&lt;svg/&gt;"/>')],
    ["a style import", wrap("<style>@import 'https://evil.test/a.css';</style>")],
    ["an encoded style import", wrap("<style>&#64;import 'https://evil.test/a.css';</style>")],
    ["a style import split by a comment", wrap("<style>@im<!-- -->port 'https://evil.test/a.css';</style>")],
    ["a CSS escape", wrap("<style>rect{fill:u\\72l(https://evil.test/a)}</style>")],
    ["an external url() in a style attribute", wrap('<rect style="fill:url(\'https://evil.test/a\')"/>')],
    ["an external url() in CDATA", wrap("<style><![CDATA[rect{fill:url(https://evil.test/a)}]]></style>")],
    ["an unterminated comment", wrap("<!-- x")],
    ["a png signature", Buffer.from("89504e470d0a1a0a", "hex").toString("latin1")],
    ["nothing", ""],
  ])("refuses %s", (_label, text) => {
    expect(svgSafe(Buffer.from(text))).toBe(false);
  });

  it("refuses bytes that are not UTF-8 and bytes over the cap", () => {
    expect(svgSafe(Buffer.concat([Buffer.from(wrap("<title>")), Buffer.from([0xff]), Buffer.from("</title>")]))).toBe(false);
    expect(svgSafe(Buffer.from(wrap(`<title>${"x".repeat(MAX_LOGO_BYTES)}</title>`)))).toBe(false);
  });
});
