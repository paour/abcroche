// Server-side score rendering: abcjs in a jsdom window -> SVG, resvg -> PNG.
//
// jsdom has no layout engine, and abcjs only needs it to measure text
// (titles, chord symbols, lyrics); the music itself is drawn from abcjs's own
// glyph paths. A width estimate from the font size is close enough that the
// result matches the browser's layout to within a few pixels.
//
// The SVG names the same fonts as the page (Times New Roman, Helvetica) with
// Liberation fallbacks; the image ships Liberation (metric-compatible) so
// the PNG's text is set in the right shapes.

import fs from "node:fs";
import { JSDOM } from "jsdom";
import { Resvg } from "@resvg/resvg-js";

const dom = new JSDOM("<!doctype html><div id=paper></div>", { pretendToBeVisual: true });
// abcjs looks for a browser-like global window/document when it is loaded.
globalThis.window = dom.window;
globalThis.document = dom.window.document;

const proto = dom.window.SVGElement.prototype;
proto.getBBox = function () {
  const text = this.textContent || "";
  const size = parseFloat(this.getAttribute("font-size")) || 16;
  const family = this.getAttribute("font-family") || "";
  const bold = /bold|[6-9]00/.test(this.getAttribute("font-weight") || "");
  const perChar = (/helvetica|arial|sans/i.test(family) ? 0.55 : 0.5) * (bold ? 1.06 : 1);
  return { x: 0, y: 0, width: text.length * size * perChar, height: size * 1.15 };
};
proto.getComputedTextLength = function () { return this.getBBox().width; };

const ABCJS = (await import("abcjs")).default;
const paper = dom.window.document.getElementById("paper");

const FONT_FALLBACKS = [
  [/times|serif$/i, "'Times New Roman', Times, 'Liberation Serif', serif"],
  [/helvetica|arial|sans/i, "Helvetica, Arial, 'Liberation Sans', sans-serif"],
  [/courier|mono/i, "'Courier New', Courier, 'Liberation Mono', monospace"],
];

function withFontFallbacks(svg) {
  return svg.replace(/font-family="([^"]*)"/g, (all, family) => {
    const hit = FONT_FALLBACKS.find(([re]) => re.test(family));
    return hit ? `font-family="${hit[1]}"` : all;
  });
}

// { svg, width, height } or null when there is nothing to draw.
export function renderSvg(abc, { staffwidth, transpose = 0, transparent = false, scale = 1 } = {}) {
  paper.textContent = "";
  const tune = ABCJS.renderAbc(paper, abc, {
    staffwidth: staffwidth || undefined,
    visualTranspose: transpose,
    paddingtop: 12, paddingbottom: 12, paddingleft: 12, paddingright: 12,
  })[0];
  const svg = paper.querySelector("svg");
  if (!tune || !svg || !tune.lines || !tune.lines.length) return null;

  const width = Math.ceil(parseFloat(svg.getAttribute("width")));
  const height = Math.ceil(parseFloat(svg.getAttribute("height")));
  svg.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  svg.setAttribute("width", String(Math.round(width * scale)));
  svg.setAttribute("height", String(Math.round(height * scale)));
  // Opened as an image, currentColor is black; say so, and give it a page.
  svg.setAttribute("color", "#000");
  if (!transparent) {
    const bg = dom.window.document.createElementNS("http://www.w3.org/2000/svg", "rect");
    bg.setAttribute("width", "100%");
    bg.setAttribute("height", "100%");
    bg.setAttribute("fill", "#fff");
    bg.setAttribute("stroke", "none");
    svg.insertBefore(bg, svg.firstChild);
  }
  // abcjs's user-select helper style and dragging classes mean nothing here.
  svg.querySelectorAll("style").forEach((s) => s.remove());
  const out = '<?xml version="1.0" encoding="UTF-8"?>\n' + withFontFallbacks(svg.outerHTML);
  return { svg: out, width: Math.round(width * scale), height: Math.round(height * scale) };
}

// Liberation fonts: FONT_DIR, else wherever the usual packages put them
// (Alpine font-liberation, Debian/Ubuntu fonts-liberation, Fedora).
const FONT_DIRS = [
  process.env.FONT_DIR,
  "/usr/share/fonts/liberation",
  "/usr/share/fonts/truetype/liberation",
  "/usr/share/fonts/liberation-serif",
  "/usr/share/fonts/liberation-sans",
  "/usr/share/fonts/liberation-mono",
].filter((d) => d && fs.existsSync(d));
if (!FONT_DIRS.length) console.warn("warning: no Liberation fonts found; text in PNG images will be missing (set FONT_DIR)");

const FONTS = {
  loadSystemFonts: false,
  fontDirs: FONT_DIRS,
  defaultFontFamily: "Liberation Serif",
  serifFamily: "Liberation Serif",
  sansSerifFamily: "Liberation Sans",
  monospaceFamily: "Liberation Mono",
};

// resvg takes only the first family in a list (and ignores generic names),
// so name the bundled Liberation face outright for rasterising.
function forResvg(svg) {
  return svg.replace(/font-family="([^"]*)"/g, (all, family) =>
    /Liberation Sans/.test(family) ? 'font-family="Liberation Sans"'
      : /Liberation Mono/.test(family) ? 'font-family="Liberation Mono"'
        : 'font-family="Liberation Serif"');
}

// PNG at `density` pixels per SVG unit (2 = sharp on high-DPI screens).
export function renderPng(svg, { density = 2 } = {}) {
  return new Resvg(forResvg(svg), { fitTo: { mode: "zoom", value: density }, font: FONTS }).render().asPng();
}
