// Sharing: the options a link carries, and the links themselves.
//
//   /t/<tune>[.png|.svg]   a tune packed into the path (see codec.js)
//   /s/<song>[.png|.svg]   a song saved online (always its latest version)
//
// Pages take the query options below; images take the ones that change the
// picture. The server reads the same options (server.mjs) for images and
// link previews.

import { partSemitones } from "./abc-text.js";

// --- options carried by a link -------------------------------------------------

const yes = (v) => /^(1|true|yes)$/i.test(v || "");

// Query string -> options. `transpose` is in semitones.
export function readOptions(params) {
  const scale = parseFloat(params.get("scale"));
  const width = parseInt(params.get("width"), 10);
  const tr = ["bb", "eb", "c"].includes(params.get("tr")) ? params.get("tr") : null;
  // Octave shift, any part: oct=1 or oct=-1. Older links said low=1 (a B♭
  // or E♭ part an octave down); still read as oct=-1.
  const o = parseInt(params.get("oct"), 10);
  const oct = [-1, 0, 1].includes(o) ? o : tr && tr !== "c" && yes(params.get("low")) ? -1 : 0;
  return {
    scale: scale > 0 ? scale : null,     // size at full width; still shrinks to fit
    width: width > 0 ? width : null,     // staff width in px (where lines wrap)
    play: yes(params.get("play")),       // playback control (pages only)
    transparent: params.get("bg") === "transparent",
    tr, oct,                             // written for a B♭ / E♭ part; octave up or down
    transpose: partSemitones(tr, false) + 12 * oct,
    showTitle: params.get("title") !== "0",
    showTempo: params.get("tempo") !== "0",
    editButton: yes(params.get("editbtn")), // ✎ opening the editor (pages only)
  };
}

// Options -> query string (defaults left out).
export function optionsQuery(o, { image = false } = {}) {
  const p = new URLSearchParams();
  if (o.scale) p.set("scale", o.scale);
  if (o.width) p.set("width", o.width);
  if (o.play && !image) p.set("play", "1");
  if (o.transparent) p.set("bg", "transparent");
  if (o.tr) p.set("tr", o.tr);
  if (o.oct) p.set("oct", o.oct);
  if (!o.showTitle) p.set("title", "0");
  if (!o.showTempo) p.set("tempo", "0");
  if (o.editButton && !image) p.set("editbtn", "1");
  return p;
}

// --- the editor's sharing panel ---------------------------------------------------

// Everything the panel lets you choose. `part` is "" to follow the editor's
// own transposition, else "c", "bb" or "eb"; `octave` is "" to follow the
// editor's ↓8ve, else "1", "0" or "-1".
export function defaultShare() {
  return {
    link: "",          // "" (page), "png" or "svg"
    named: true,       // a saved song links by name, when signed in
    scale: null, width: null,
    play: false, transparent: false,
    part: "", octave: "",
    title: true, tempo: true,
    editButton: false,
  };
}

// The editor keeps the panel in its own URL, so a reload restores it.
export function shareFromParams(params) {
  const o = readOptions(params);
  return {
    ...defaultShare(),
    link: ["png", "svg"].includes(params.get("link")) ? params.get("link") : "",
    scale: o.scale, width: o.width,
    play: o.play, transparent: o.transparent,
    part: o.tr || "",
    octave: params.has("oct") || params.has("low") ? String(o.oct) : "",
    title: o.showTitle, tempo: o.showTempo,
    editButton: o.editButton,
  };
}

// The options a link made from this panel carries. `displayPart` is the
// editor's own { tr, low }, used where the panel says "as shown".
export function linkOptions(share, displayPart) {
  const tr = share.part || displayPart.tr || "";
  const oct = share.octave ? Number(share.octave) : displayPart.tr && displayPart.low ? -1 : 0;
  return readOptions(new URLSearchParams({
    scale: share.scale || "", width: share.width || "",
    play: share.play ? "1" : "", bg: share.transparent ? "transparent" : "",
    tr, oct: String(oct),
    title: share.title ? "" : "0", tempo: share.tempo ? "" : "0",
    editbtn: share.editButton ? "1" : "",
  }));
}

// The link to share. `name` is the saved song's id when it should link by
// name, `packed` the encoded tune otherwise.
export function shareUrl(origin, share, options, { name, packed }) {
  const base = name ? `/s/${encodeURIComponent(name)}` : `/t/${packed}`;
  const q = optionsQuery(options, { image: !!share.link });
  return origin + base + (share.link ? "." + share.link : "") + (q.toString() ? "?" + q : "");
}

// The editor's own query: the panel's choices (only what differs from the
// defaults), so the URL is shareable and survives a reload.
export function shareQuery(share) {
  const o = linkOptions(share, {});
  const p = optionsQuery({ ...o, tr: share.part ? o.tr : null, oct: 0 });
  if (share.octave) p.set("oct", share.octave); // "0" too: an explicit "no shift"
  if (share.link) p.set("link", share.link);
  return p;
}

// Long tune links hide their ending (.png/.svg, options) when wrapped: keep
// both ends of the packed tune and elide the middle.
export function shortUrl(url) {
  const u = new URL(url);
  const path = u.pathname.replace(/^(\/[st]\/)([^/.]{40,})/, (all, pre, seg) => pre + seg.slice(0, 14) + "…" + seg.slice(-10));
  return u.origin + path + u.search;
}
