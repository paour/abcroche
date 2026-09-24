// Edit mode: a visual note-entry editor over the ABC text.
//
// The ABC text stays the single source of truth. Every button, piano key and
// score click is turned into a small text edit, so anything the buttons can't
// express can still be typed in the (optional) source panel.

import { encode, decode } from "./codec.js";
import { Score } from "./score.js";
import { importFile } from "./importer.js";
import * as T from "./abc-text.js";
import * as Lib from "./library.js";
import * as Online from "./online.js";
import * as Share from "./share.js";

const NEW_TUNE = "X:1\nT:Untitled\nM:4/4\nL:1/8\nQ:1/4=100\nK:C\n";

const SAMPLE = [
  "X:1",
  "T:Speed the Plough",
  "M:4/4",
  "L:1/8",
  "Q:1/4=120",
  "K:G",
  "|:GABc dedB|dedB dedB|c2ec B2dB|c2A2 A2BA|",
  "GABc dedB|dedB dedB|c2ec B2dB|A2F2 G4:|",
  "",
].join("\n");

const DURATIONS = [
  { dur: 1, key: "1", name: "Whole note" },
  { dur: 1 / 2, key: "2", name: "Half note" },
  { dur: 1 / 4, key: "3", name: "Quarter note" },
  { dur: 1 / 8, key: "4", name: "Eighth note" },
  { dur: 1 / 16, key: "5", name: "Sixteenth note" },
  { dur: 1 / 32, key: "6", name: "Thirty-second note" },
];

// [K: value, tonic, mode, signature]
const KEYS = [
  ["C", "C", "major", ""], ["G", "G", "major", "1♯"], ["D", "D", "major", "2♯"], ["A", "A", "major", "3♯"],
  ["E", "E", "major", "4♯"], ["B", "B", "major", "5♯"], ["F#", "F#", "major", "6♯"], ["C#", "C#", "major", "7♯"],
  ["F", "F", "major", "1♭"], ["Bb", "Bb", "major", "2♭"], ["Eb", "Eb", "major", "3♭"], ["Ab", "Ab", "major", "4♭"],
  ["Db", "Db", "major", "5♭"], ["Gb", "Gb", "major", "6♭"], ["Cb", "Cb", "major", "7♭"],
  ["Am", "A", "minor", ""], ["Em", "E", "minor", "1♯"], ["Bm", "B", "minor", "2♯"], ["F#m", "F#", "minor", "3♯"],
  ["C#m", "C#", "minor", "4♯"], ["G#m", "G#", "minor", "5♯"], ["D#m", "D#", "minor", "6♯"],
  ["Dm", "D", "minor", "1♭"], ["Gm", "G", "minor", "2♭"], ["Cm", "C", "minor", "3♭"], ["Fm", "F", "minor", "4♭"],
  ["Bbm", "Bb", "minor", "5♭"], ["Ebm", "Eb", "minor", "6♭"],
];
const METERS = ["4/4", "3/4", "2/4", "2/2", "6/8", "9/8", "12/8", "3/8", "5/4", "7/8", "C", "C|", "none"];
const CLEFS = [["treble", "Treble"], ["bass", "Bass"], ["alto", "Alto"], ["tenor", "Tenor"]];
const BARS = [
  { abc: "|", label: "|", title: "Bar line  ( | )" },
  { abc: "||", label: "||", title: "Double bar" },
  { abc: "|]", label: "|]", title: "Final bar" },
  { abc: "|:", label: "|:", title: "Start repeat" },
  { abc: ":|", label: ":|", title: "End repeat" },
  { abc: "::", label: ":|:", title: "End one repeat, start another" },
  { abc: "[1", label: "1.", title: "First ending" },
  { abc: "[2", label: "2.", title: "Second ending" },
];

const $ = (id) => document.getElementById(id);

function el(tag, attrs, ...children) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (k === "class") e.className = v;
    else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
    else if (v !== false && v != null) e.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children) e.append(c);
  return e;
}

// Small note glyphs for the duration buttons (Unicode music symbols render
// inconsistently across platforms, so these are drawn).
function noteIcon(dur) {
  const filled = dur <= 1 / 4;
  const stem = dur <= 1 / 2;
  const flags = Math.max(0, Math.round(Math.log2(1 / dur)) - 2);
  let s = `<svg viewBox="0 0 20 28" width="16" height="22" aria-hidden="true">`;
  s += `<ellipse cx="8" cy="22" rx="5" ry="3.6" transform="rotate(-20 8 22)" ` +
    (filled ? `fill="currentColor"` : `fill="none" stroke="currentColor" stroke-width="1.6"`) + `/>`;
  if (stem) s += `<line x1="12.6" y1="21" x2="12.6" y2="3" stroke="currentColor" stroke-width="1.5"/>`;
  for (let i = 0; i < flags; i++) {
    const y = 3 + i * 5;
    s += `<path d="M12.6 ${y} q6 4 4.5 10" fill="none" stroke="currentColor" stroke-width="1.6"/>`;
  }
  return s + `</svg>`;
}

export async function startEdit(params) {
  document.documentElement.classList.add("editing");
  $("view").hidden = true;
  $("editor").hidden = false;

  // Keep in sync with the phone @media rule in style.css.
  const phone = matchMedia("(max-width: 720px), (max-height: 500px) and (pointer: coarse)");
  const textarea = $("abc");
  const frame = $("preview-frame");
  const caret = $("caret");
  const status = $("status");

  // --- State ------------------------------------------------------------------

  let tune = null;
  let cursor = 0;        // insertion point (offset into the text)
  let sel = null;        // { start, end } of the selected note, or null
  let dur = 1 / 4;       // input duration in whole notes (before dotting)
  let dotted = false;
  let pendingChord = ""; // chord symbol for the next inserted note
  let baseOctave = 4;    // keyboard shows baseOctave .. baseOctave+1, plus a top C
  let message = null;    // one-off status message { text, error }
  const undo = [];
  const redo = [];
  let typingGroupAt = 0;
  let lastText = "";
  let lastNoteClick = 0;
  let tuneId = null;     // library id of the open tune; null until first saved
  let account = null;    // { user, name } when signed in through the proxy
  let server = null;     // { id, abc }: the online song this tune is linked to, as last saved
  let onlineSongs = [];  // summaries from /api/songs (signed in only)
  let share = Share.shareFromParams(params); // the sharing panel's choices (share.js)
  let saveTimer = null;  // pending autosave
  let part = { tr: null, low: false }; // transposing-instrument display
  try { part = { ...part, ...JSON.parse(localStorage.getItem("abc-transpose") || "{}") }; } catch (e) { /* ignore */ }
  let names = "letters"; // note names in the UI: "letters" or "solfege"
  try { if (localStorage.getItem("abc-note-names") === "solfege") names = "solfege"; } catch (e) { /* ignore */ }

  const text = () => textarea.value;
  const snapshot = () => ({ text: text(), cursor, sel });

  // --- Palette, keyboard and header form ------------------------------------------

  const durButtons = DURATIONS.map((d) => {
    const b = el("button", {
      type: "button", class: "dur", title: `${d.name}  (${d.key})`, "aria-label": d.name,
      onclick: () => setDuration(d.dur),
    });
    b.innerHTML = noteIcon(d.dur);
    b.dataset.dur = d.dur;
    return b;
  });
  const dotBtn = el("button", { type: "button", title: "Dotted  ( . )", "aria-label": "Dotted", onclick: toggleDot }, "·");
  dotBtn.classList.add("dot");
  $("palette-durations").append(...durButtons, dotBtn);

  $("palette-notes").append(
    el("button", { type: "button", title: "Rest  (R)", onclick: () => enterRest() }, "Rest"),
    el("button", { type: "button", title: "Sharp", "aria-label": "Sharp", onclick: () => setAccidental("^") }, "♯"),
    el("button", { type: "button", title: "Flat", "aria-label": "Flat", onclick: () => setAccidental("_") }, "♭"),
    el("button", { type: "button", title: "Natural", "aria-label": "Natural", onclick: () => setAccidental("=") }, "♮"),
    el("button", { type: "button", title: "Tie to the next note", onclick: toggleTie }, "Tie"),
    el("button", { type: "button", title: "Triplet: the next three notes", onclick: () => insertMark("(3") }, "Triplet"),
  );
  $("palette-bars").append(
    ...BARS.map((b) => el("button", { type: "button", class: "bar-btn", title: b.title, onclick: () => insertMark(b.abc) }, b.label)),
    el("button", { type: "button", title: "New line of music", onclick: () => insertMark("\n") }, "↵ Line"),
  );

  const chordInput = $("chord");
  $("chord-apply").addEventListener("click", applyChord);
  chordInput.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); applyChord(); } });

  $("undo").addEventListener("click", doUndo);
  $("redo").addEventListener("click", doRedo);
  $("delete").addEventListener("click", deleteBack);

  $("oct-down").addEventListener("click", () => { baseOctave = Math.max(1, baseOctave - 1); buildKeyboard(); });
  $("oct-up").addEventListener("click", () => { baseOctave = Math.min(6, baseOctave + 1); buildKeyboard(); });

  function buildKeyboard() {
    const kb = $("keys");
    kb.textContent = "";
    const whites = [];
    const blacks = [];
    const first = 12 * (baseOctave + 1);
    const span = phone.matches && innerWidth < 600 ? 12 : 24; // one octave on narrow phones
    for (let m = first; m <= first + span; m++) {
      const pc = m % 12;
      const black = [1, 3, 6, 8, 10].includes(pc);
      const btn = el("button", {
        type: "button", class: black ? "key black" : "key white", tabindex: -1,
        onpointerdown: (e) => { e.preventDefault(); pianoKey(m); },
      });
      btn.dataset.midi = m;
      if (black) {
        btn.style.setProperty("--pos", whites.length);
        blacks.push(btn);
      } else {
        const sp = T.spellMidi(m, false);
        const label = T.noteName(sp.letter, names) + (pc === 0 ? T.octaveNumber(sp.octave, names) : "");
        btn.append(el("span", {}, label));
        whites.push(btn);
      }
    }
    kb.style.setProperty("--whites", whites.length);
    kb.append(...whites, ...blacks);
    const c = T.noteName("C", names);
    $("oct-label").textContent = `${c}${T.octaveNumber(baseOctave, names)}–${c}${T.octaveNumber(baseOctave + span / 12, names)}`;
    markKeyboard();
  }

  // Header form
  const fTitle = $("f-title"), fComposer = $("f-composer"), fKey = $("f-key"),
    fMeter = $("f-meter"), fClef = $("f-clef"), fTempo = $("f-tempo");
  function fillKeys() {
    const current = fKey.value;
    fKey.textContent = "";
    const semis = T.partSemitones(part.tr, part.low);
    KEYS.forEach(([v, tonic, mode]) => {
      const suffix = mode === "minor" ? "m" : "";
      const written = T.transposeTonic(tonic, suffix, semis);
      const sig = T.sharpsFlats(written + suffix);
      fKey.append(el("option", { value: v }, T.keyLabel(written, names) + " " + mode + (sig ? " · " + sig : "")));
    });
    if (current) selectValue(fKey, current);
  }

  // Transposing instruments: the score, piano, status and key names all
  // show written pitch; the tune itself stays in concert pitch.
  const partBtns = document.querySelectorAll("#part button[data-tr]");
  const partLow = $("part-low");
  function setPart(next) {
    part = { tr: next.tr || null, low: !!next.low };
    try { localStorage.setItem("abc-transpose", JSON.stringify(part)); } catch (e) { /* ignore */ }
    fillKeys();
    if (tune) render(); // redraws, then syncUi()
  }
  partBtns.forEach((b) => b.addEventListener("click", () => setPart({ tr: b.dataset.tr, low: part.low })));
  partLow.addEventListener("click", () => setPart({ tr: part.tr, low: !part.low }));

  const tr = () => T.transposition(T.getField(text(), "K") || "C", T.partSemitones(part.tr, part.low));

  // Letter names vs. solfège, remembered per browser.
  const namesBtns = document.querySelectorAll("#note-names button");
  function setNames(n) {
    names = n;
    try { localStorage.setItem("abc-note-names", n); } catch (e) { /* ignore */ }
    fillKeys();
    buildKeyboard();
    if (tune) { updateStatus(); renderLibrary(); syncUi(); }
  }
  namesBtns.forEach((b) => b.addEventListener("click", () => setNames(b.dataset.names)));
  METERS.forEach((v) => fMeter.append(el("option", { value: v }, v === "none" ? "Free" : v)));
  CLEFS.forEach(([v, label]) => fClef.append(el("option", { value: v }, label)));

  // Header edits change the text before the music, so move the insertion
  // point and selection along with it.
  function setHeader(field, value) {
    const old = text();
    const next = T.setField(old, field, value);
    const d = next.length - old.length;
    const bs = T.bodyStart(old);
    const shift = (p) => (p >= bs ? p + d : p);
    change(next, {
      cursor: shift(cursor),
      sel: sel ? { ...sel, start: shift(sel.start), end: shift(sel.end) } : null,
    });
  }
  fTitle.addEventListener("input", () => setHeader("T", fTitle.value));
  fComposer.addEventListener("input", () => setHeader("C", fComposer.value));
  fKey.addEventListener("change", () => setHeader("K", T.setKeyName(T.getField(text(), "K") || "C", fKey.value)));
  fClef.addEventListener("change", () => {
    setHeader("K", T.setClef(T.getField(text(), "K") || "C", fClef.value));
    baseOctave = fClef.value === "bass" ? 2 : fClef.value === "treble" ? 4 : 3;
    buildKeyboard();
  });
  fMeter.addEventListener("change", () => setHeader("M", fMeter.value));
  fTempo.addEventListener("input", () => {
    const bpm = parseInt(fTempo.value, 10);
    if (!(bpm > 0)) return setHeader("Q", "");
    const q = T.getField(text(), "Q") || "";
    const unit = (q.match(/^\s*(\d+\/\d+)\s*=/) || [])[1] || beatUnit();
    setHeader("Q", unit + "=" + bpm);
  });

  function beatUnit() {
    const b = T.beatLength(T.getField(text(), "M"));
    const f = T.lengthSuffix(b, 1);
    return f.includes("/") ? (f.startsWith("/") ? "1" + f : f) : f + "/1";
  }

  function selectValue(select, value) {
    if (value && ![...select.options].some((o) => o.value === value)) {
      select.append(el("option", { value }, value));
    }
    select.value = value;
  }

  function syncForm() {
    const t = text();
    const focused = document.activeElement;
    if (focused !== fTitle) fTitle.value = T.getField(t, "T") || "";
    if (focused !== fComposer) fComposer.value = T.getField(t, "C") || "";
    const k = T.getField(t, "K") || "C";
    selectValue(fKey, T.splitKey(k).key || "C");
    selectValue(fClef, T.getClef(k));
    selectValue(fMeter, T.getField(t, "M") || "none");
    if (focused !== fTempo) {
      const q = (T.getField(t, "Q") || "").match(/=\s*(\d+)/) || (T.getField(t, "Q") || "").match(/^\s*(\d+)\s*$/);
      fTempo.value = q ? q[1] : "";
    }
  }

  // --- Sharing panel: its controls edit `share`; syncUi() writes them back ---------------

  const SHARE_CONTROLS = [
    ["opt-link", "link", "value"], ["opt-scale", "scale", "number"], ["opt-width", "width", "number"],
    ["opt-play", "play", "checked"], ["opt-transparent", "transparent", "checked"],
    ["opt-tr", "part", "value"], ["opt-title", "title", "checked"], ["opt-tempo", "tempo", "checked"],
    ["opt-editbtn", "editButton", "checked"],
  ].map(([id, key, kind]) => ({ el: $(id), key, kind }));
  for (const c of SHARE_CONTROLS) {
    c.el.addEventListener("input", () => {
      const v = c.kind === "checked" ? c.el.checked : c.kind === "number" ? parseFloat(c.el.value) || null : c.el.value;
      share = { ...share, [c.key]: v };
      render(); // the preview shows several of these; render() ends with syncUi()
    });
  }

  // What a link made now would carry (transposition "as shown" = the editor's).
  const linkOpts = () => Share.linkOptions(share, part);

  // --- Source panel ---------------------------------------------------------------------

  const sourceBtn = $("toggle-source");
  function showSource(on) {
    $("source").hidden = !on;
    sourceBtn.setAttribute("aria-pressed", on ? "true" : "false");
    try { localStorage.setItem("abc-show-source", on ? "1" : "0"); } catch (e) { /* ignore */ }
  }
  sourceBtn.addEventListener("click", () => showSource($("source").hidden));

  // The quick reference under the source remembers whether it was open.
  const help = $("abc-help");
  try { help.open = localStorage.getItem("abc-show-help") === "1"; } catch (e) { /* ignore */ }
  help.addEventListener("toggle", () => {
    try { localStorage.setItem("abc-show-help", help.open ? "1" : "0"); } catch (e) { /* ignore */ }
  });
  let sourcePref = false;
  try { sourcePref = localStorage.getItem("abc-show-source") === "1"; } catch (e) { /* ignore */ }
  showSource(sourcePref);

  textarea.addEventListener("input", () => {
    const now = Date.now();
    if (now - typingGroupAt > 1000) pushUndo({ text: lastText, cursor, sel: null });
    typingGroupAt = now;
    lastText = text();
    sel = null;
    cursor = textarea.selectionEnd;
    scheduleRender();
    scheduleSave();
  });
  const followTextCursor = () => {
    sel = null;
    cursor = textarea.selectionEnd;
    placeCaret();
    updateStatus();
  };
  textarea.addEventListener("click", followTextCursor);
  textarea.addEventListener("keyup", (e) => { if (e.key.startsWith("Arrow") || e.key === "Home" || e.key === "End") followTextCursor(); });

  // --- Undo -------------------------------------------------------------------------------

  function pushUndo(state) {
    undo.push(state);
    if (undo.length > 200) undo.shift();
    redo.length = 0;
  }
  function restore(state) {
    textarea.value = state.text;
    lastText = state.text;
    cursor = Math.min(state.cursor, state.text.length);
    sel = state.sel;
    render();
    scheduleSave();
  }
  function doUndo() { if (undo.length) { redo.push(snapshot()); restore(undo.pop()); } }
  function doRedo() { if (redo.length) { undo.push(snapshot()); restore(redo.pop()); } }

  // Apply a new text. Cursor/selection default to "unchanged".
  function change(newText, opts = {}) {
    if (newText === text()) return;
    pushUndo(snapshot());
    typingGroupAt = 0;
    textarea.value = newText;
    lastText = newText;
    if ("cursor" in opts) cursor = opts.cursor;
    if ("sel" in opts) sel = opts.sel;
    else if (!opts.keepSelection) sel = null;
    cursor = Math.min(cursor, newText.length);
    render();
    scheduleSave();
  }

  // --- Rendering ------------------------------------------------------------------------------

  const score = new Score($("preview-paper"), $("preview-audio"), { clickListener: onScoreClick });
  let renderTimer;
  function scheduleRender() {
    clearTimeout(renderTimer);
    renderTimer = setTimeout(render, 150);
  }

  function render() {
    clearTimeout(renderTimer);
    const opts = linkOpts();
    frame.classList.toggle("transparent", opts.transparent);
    // The preview shows the editor's own transposition, not the link's.
    const shown = { ...opts, transpose: T.partSemitones(part.tr, part.low) };
    if (phone.matches) Object.assign(shown, { width: Math.max(240, frame.clientWidth - 20), wrap: true });
    $("preview-paper").classList.toggle("hide-tempo", !opts.showTempo);
    tune = score.render(opts.showTitle ? text() : T.hideTitle(text()), shown);

    const warnings = (tune && tune.warnings) || [];
    $("warnings").textContent = warnings.map((w) => w.replace(/<[^>]*>/g, "")).join("\n");

    if (sel) {
      const els = selectedElements();
      if (els.length) els.forEach((e) => e.abselem && e.abselem.highlight(undefined, "#2383e2"));
      else sel = null;
    }
    if (document.activeElement !== textarea) {
      if (sel) textarea.setSelectionRange(sel.start, sel.end);
      else textarea.setSelectionRange(cursor, cursor);
    }
    syncForm();
    placeCaret();
    updateStatus();
    syncUi();
  }

  // The link to share and the editor's own URL. Async (packing the tune), so
  // only the latest call writes anything.
  let linkSeq = 0;
  async function updateLinks() {
    const seq = ++linkSeq;
    const packed = await encode(text());
    if (seq !== linkSeq) return;
    const byName = account && server && share.named;
    const url = Share.shareUrl(location.origin, share, linkOpts(), { name: byName ? server.id : null, packed });
    const shown = $("embed-url");
    shown.textContent = Share.shortUrl(url); // the ending (.png, options) stays visible
    shown.dataset.full = url;                // Copy and Open use the whole link
    shown.title = url.length > 300 ? url.slice(0, 300) + "…" : url;
    $("open-view").href = url;
    // The editor's own URL names the library entry and keeps the panel's
    // choices, so a reload (or a bookmark) comes back to exactly this.
    const own = new URLSearchParams({ edit: "" });
    if (tuneId) own.set("t", tuneId);
    Share.shareQuery(share).forEach((v, k) => own.set(k, v));
    history.replaceState(null, "", "?" + own.toString().replace(/^edit=/, "edit") + "#" + packed);
  }

  // Every rendered element (notes, rests, bars) with a source range, in order.
  function elements(types) {
    const out = [];
    if (!tune || !tune.lines) return out;
    for (const line of tune.lines) {
      for (const staff of line.staff || []) {
        for (const voice of staff.voices || []) {
          for (const e of voice) {
            if (e.startChar != null && e.endChar != null && (!types || types.includes(e.el_type))) out.push(e);
          }
        }
      }
    }
    return out.sort((a, b) => a.startChar - b.startChar);
  }

  function elementAt(start) {
    return elements(["note", "bar"]).find((e) => e.startChar === start) || null;
  }

  function rectOf(abselem) {
    const r = { left: Infinity, top: Infinity, right: -Infinity, bottom: -Infinity };
    for (const node of abselem.elemset || []) {
      if (!node.getBoundingClientRect) continue;
      const b = node.getBoundingClientRect();
      if (!b.width && !b.height) continue;
      r.left = Math.min(r.left, b.left); r.top = Math.min(r.top, b.top);
      r.right = Math.max(r.right, b.right); r.bottom = Math.max(r.bottom, b.bottom);
    }
    return r.left === Infinity ? null : r;
  }

  // A thin line after the element just before the insertion point.
  // A tinted box behind the selected note or bar line; abcjs only recolours
  // it, which is hard to see for a thin bar line.
  // A range gets one box per staff line it covers.
  function placeSelBox() {
    frame.querySelectorAll(".sel-box").forEach((b) => b.remove());
    if (!sel || !tune) return;
    const groups = new Map();
    for (const e of selectedElements()) {
      const r = e.abselem && rectOf(e.abselem);
      if (!r) continue;
      const node = (e.abselem.elemset || [])[0];
      const line = ((node && (node.getAttribute("class") || "").match(/abcjs-l\d+/)) || ["?"])[0];
      const g = groups.get(line);
      if (g) Object.assign(g, { left: Math.min(g.left, r.left), right: Math.max(g.right, r.right), top: Math.min(g.top, r.top), bottom: Math.max(g.bottom, r.bottom) });
      else groups.set(line, { ...r });
    }
    const base = frame.getBoundingClientRect();
    const single = sel.kind !== "range";
    for (const [line, r] of groups) {
      let { top, bottom } = r;
      if (!single || sel.kind === "bar") {
        const staff = $("preview-paper").querySelector(".abcjs-staff." + line);
        if (staff) { const s = staff.getBoundingClientRect(); top = Math.min(top, s.top); bottom = Math.max(bottom, s.bottom); }
      }
      const padX = sel.kind === "bar" ? 7 : 4;
      const box = el("div", { class: "sel-box" });
      box.style.left = r.left - base.left + frame.scrollLeft - padX + "px";
      box.style.width = r.right - r.left + 2 * padX + "px";
      box.style.top = top - base.top + frame.scrollTop - 5 + "px";
      box.style.height = bottom - top + 10 + "px";
      frame.append(box);
    }
  }

  function placeCaret() {
    placeSelBox();
    caret.hidden = true;
    if (sel || !tune) return;
    const before = elements(["note", "bar"]).filter((e) => e.endChar <= cursor).pop();
    if (!before || !before.abselem) return;
    const r = rectOf(before.abselem);
    if (!r) return;
    const base = frame.getBoundingClientRect();
    const node = (before.abselem.elemset || [])[0];
    const lineClass = node && (node.getAttribute("class") || "").match(/abcjs-l\d+/);
    const staff = lineClass && $("preview-paper").querySelector(".abcjs-staff." + lineClass[0]);
    const s = staff ? staff.getBoundingClientRect() : r;
    caret.style.left = r.right - base.left + frame.scrollLeft + 3 + "px";
    caret.style.top = s.top - base.top + frame.scrollTop - 8 + "px";
    caret.style.height = s.bottom - s.top + 16 + "px";
    caret.hidden = false;
  }

  // --- Status ---------------------------------------------------------------------------------

  function describe(n, start) {
    if (!n) return "a chord or ornament";
    if (n.chord) {
      const x = tr();
      const ctx = T.contextAt(text(), start);
      const names2 = T.chordPitches(n.chord).map((p) => {
        const alter = p.acc ? T.accAlter(p.acc) : T.impliedAlter(ctx, p.letter, p.octave);
        const w = T.toWritten(p.letter, p.octave, alter, x);
        return T.pitchName(w, w.alter, names);
      });
      return durationName(T.noteDuration(n, T.unitLength(text()))) + " chord " + names2.join(" ");
    }
    const len = durationName(T.noteDuration(n, T.unitLength(text())));
    if (n.letter === "z" || n.letter === "x") return len + " rest";
    const p = T.parsePitch((n.acc || "") + n.letter + n.marks);
    const ctx = T.contextAt(text(), start);
    const alter = n.acc ? T.accAlter(n.acc) : T.impliedAlter(ctx, p.letter, p.octave);
    const w = T.toWritten(p.letter, p.octave, alter, tr());
    return len + " " + T.pitchName(w, w.alter, names);
  }

  function durationName(d) {
    for (const x of DURATIONS) {
      if (Math.abs(d - x.dur) < T.EPS) return x.name.replace(" note", "").toLowerCase();
      if (Math.abs(d - x.dur * 1.5) < T.EPS) return "dotted " + x.name.replace(" note", "").toLowerCase();
    }
    return "odd-length";
  }

  function updateStatus() {
    durButtons.forEach((b) => b.setAttribute("aria-pressed", Math.abs(+b.dataset.dur - dur) < T.EPS ? "true" : "false"));
    dotBtn.setAttribute("aria-pressed", dotted ? "true" : "false");
    $("undo").disabled = !undo.length;
    $("redo").disabled = !redo.length;
    markKeyboard();

    let msg;
    if (message) {
      status.textContent = message.text;
      status.classList.toggle("error", !!message.error);
      message = null;
      return;
    }
    status.classList.remove("error");
    if (isRange()) {
      const els = selectedElements();
      const notes = els.filter((e) => e.el_type === "note").length;
      const bars = els.filter((e) => e.el_type === "bar").length;
      msg = `Selected: ${notes} note${notes === 1 ? "" : "s"}${bars ? ` and ${bars} bar line${bars === 1 ? "" : "s"}` : ""}. ` +
        "↑/↓ move them; lengths, ♯♭♮ and Rest apply to all; Ctrl+C/X/V copy, cut, paste; Delete removes them; Esc to add notes after.";
    } else if (isBarSel()) {
      const b = T.parseBarText(text().slice(sel.start, sel.end));
      msg = `Selected: bar line ${b.bar}${b.ending ? " with ending " + b.ending : ""}. Pick a bar type below to change it, 1./2. for an ending, Delete removes it, Esc to add notes after it.`;
    } else if (sel) {
      const n = T.parseNoteText(text().slice(sel.start, sel.end));
      msg = `Selected: ${describe(n, sel.start)}. Shift+click or Shift+←/→ selects more. Piano changes its pitch, ↑/↓ moves it, Delete removes it, Esc to add notes after it.`;
    } else if (!elements(["note"]).length) {
      msg = "Pick a length, then play notes on the keyboard below (or type the letters A–G).";
    } else {
      msg = "Adding notes at the blue line. Click a note in the score to change it.";
    }
    if (pendingChord) msg += ` Next note gets chord “${pendingChord}”.`;
    status.textContent = msg;
  }

  // Concert-pitch MIDI numbers of a [chord] at a position.
  function chordMidis(chord, pos) {
    const ctx = T.contextAt(text(), pos);
    return T.chordPitches(chord).map((p) =>
      T.midiOf(p.letter, p.octave, p.acc ? T.accAlter(p.acc) : T.impliedAlter(ctx, p.letter, p.octave)));
  }

  function markKeyboard() {
    let midi = null;
    let lit = [];
    if (sel && !isRange() && !isBarSel()) {
      const n = T.parseNoteText(text().slice(sel.start, sel.end));
      if (n && n.chord) lit = chordMidis(n.chord, sel.start).map((m) => m + tr().semis);
    }
    if (sel) {
      const n = T.parseNoteText(text().slice(sel.start, sel.end));
      if (n && n.letter && n.letter !== "z" && n.letter !== "x") {
        const p = T.parsePitch((n.acc || "") + n.letter + n.marks);
        const ctx = T.contextAt(text(), sel.start);
        const alter = n.acc ? T.accAlter(n.acc) : T.impliedAlter(ctx, p.letter, p.octave);
        midi = T.midiOf(p.letter, p.octave, alter) + tr().semis;
      }
    }
    document.querySelectorAll("#keys .key").forEach((k) =>
      k.classList.toggle("on", +k.dataset.midi === midi || lit.includes(+k.dataset.midi)));
  }

  function notify(text, error) {
    message = { text, error };
    updateStatus();
  }

  // --- Selection -------------------------------------------------------------------------------

  function onScoreClick(abcelem, tuneNumber, classes, analysis, drag, ev) {
    if (!abcelem) return;
    // Shift+click extends the selection to here (a contiguous range).
    if (ev && ev.shiftKey && sel && (abcelem.el_type === "note" || abcelem.el_type === "bar")) {
      lastNoteClick = performance.now();
      extendTo(abcelem.startChar);
      return;
    }
    if (abcelem.el_type === "bar") {
      lastNoteClick = performance.now();
      sel = { start: abcelem.startChar, end: abcelem.endChar, kind: "bar", anchor: abcelem.startChar, focus: abcelem.startChar };
      cursor = sel.end;
      textarea.setSelectionRange(sel.start, sel.end);
      caret.hidden = true;
      placeSelBox();
      updateStatus();
      return;
    }
    if (abcelem.el_type !== "note") return;
    lastNoteClick = performance.now();
    sel = { start: abcelem.startChar, end: abcelem.endChar, kind: "note", anchor: abcelem.startChar, focus: abcelem.startChar };
    cursor = sel.end;
    const n = T.parseNoteText(text().slice(sel.start, sel.end));
    if (drag && drag.step && n) {
      moveSelected(-drag.step);
      return;
    }
    if (n) {
      const d = T.noteDuration(n, T.unitLength(text()));
      const isDotted = DURATIONS.some((x) => Math.abs(d - x.dur * 1.5) < T.EPS);
      const plain = isDotted ? d / 1.5 : d;
      if (DURATIONS.some((x) => Math.abs(x.dur - plain) < T.EPS)) { dur = plain; dotted = isDotted; }
    }
    textarea.setSelectionRange(sel.start, sel.end);
    caret.hidden = true;
    placeSelBox();
    updateStatus();
  }

  // Clicking empty paper drops the selection.
  frame.addEventListener("click", () => {
    setTimeout(() => {
      if (performance.now() - lastNoteClick > 100 && sel) deselect();
    }, 0);
  });

  function deselect() {
    if (!sel) return;
    cursor = sel.end;
    sel = null;
    render();
  }

  function selectNeighbour(delta) {
    leaveBar();
    const notes = elements(["note"]);
    if (!notes.length) return;
    let idx;
    if (sel) idx = notes.findIndex((e) => e.startChar === sel.start) + delta;
    else idx = delta < 0 ? notes.filter((e) => e.endChar <= cursor).length - 1 : notes.findIndex((e) => e.startChar >= cursor);
    if (idx < 0 || idx >= notes.length) return;
    const e = notes[idx];
    onScoreClick(e, 0, "", null, null);
    render();
  }

  // --- Editing -------------------------------------------------------------------------------

  const isBarSel = () => !!(sel && sel.kind === "bar");
  const isRange = () => !!(sel && sel.kind === "range");
  // Entering notes with a bar line or a range selected: carry on after it.
  function leaveBar() {
    if (isBarSel() || isRange()) { cursor = sel.end; sel = null; }
  }

  // --- Ranges (contiguous multi-selection) ---------------------------------------------

  const selectables = () => elements(["note", "bar"]);

  function selectedElements() {
    if (!sel) return [];
    if (sel.kind === "range") return selectables().filter((e) => e.startChar >= sel.start && e.endChar <= sel.end);
    const e = elementAt(sel.start);
    return e ? [e] : [];
  }

  function selectSingle(e) {
    sel = { start: e.startChar, end: e.endChar, kind: e.el_type === "bar" ? "bar" : "note", anchor: e.startChar, focus: e.startChar };
    cursor = sel.end;
  }

  // Anchor and focus are element start offsets. After an edit they may no
  // longer match an element, so fall back to the range's ends.
  function endsOf(els) {
    const valid = (p) => els.some((e) => e.startChar === p);
    const inSel = selectedElements();
    const anchor = valid(sel.anchor) ? sel.anchor : inSel[0].startChar;
    const focus = valid(sel.focus) ? sel.focus : inSel[inSel.length - 1].startChar;
    return { anchor, focus };
  }

  function extendTo(focusStart) {
    const els = selectables();
    const { anchor } = endsOf(els);
    const a = els.findIndex((x) => x.startChar === anchor);
    const f = els.findIndex((x) => x.startChar === focusStart);
    if (a < 0 || f < 0) return;
    if (a === f) selectSingle(els[a]);
    else {
      const lo = Math.min(a, f), hi = Math.max(a, f);
      sel = { start: els[lo].startChar, end: els[hi].endChar, kind: "range", anchor, focus: focusStart };
      cursor = sel.end;
    }
    textarea.setSelectionRange(sel.start, sel.end);
    render();
  }

  // Shift+←/→: grow or shrink the selection one element at a time.
  function extendBy(delta) {
    const els = selectables();
    if (!els.length) return;
    if (!sel || !selectedElements().length) {
      const i = delta < 0 ? els.filter((e) => e.endChar <= cursor).length - 1 : els.findIndex((e) => e.startChar >= cursor);
      if (i < 0 || i >= els.length) return;
      selectSingle(els[i]);
      render();
      return;
    }
    const { focus } = endsOf(els);
    const f = els.findIndex((x) => x.startChar === focus) + delta;
    if (f >= 0 && f < els.length) extendTo(els[f].startChar);
  }

  // Rewrite every note in the range; fn(note, offset) returns the new note
  // or null to leave it. Works from the end so earlier offsets stay valid.
  function transformRange(fn) {
    const t = text();
    const notes = elements(["note"]).filter((e) => e.startChar >= sel.start && e.endChar <= sel.end)
      .sort((a, b) => b.startChar - a.startChar);
    let next = t;
    let delta = 0;
    for (const e of notes) {
      const n = T.parseNoteText(next.slice(e.startChar, e.endChar));
      const u = n && fn(n, e.startChar, next);
      if (!u) continue;
      const s = T.noteTextToAbc(u);
      next = next.slice(0, e.startChar) + s + next.slice(e.endChar);
      delta += s.length - (e.endChar - e.startChar);
    }
    if (next === t) { render(); return; }
    const end = sel.end + delta;
    change(T.keepBarPitches(t, sel.end, next, end), { sel: { start: sel.start, end, kind: "range", anchor: sel.start }, cursor: end });
  }

  // --- Clipboard ------------------------------------------------------------------------

  let clip = ""; // fallback when the system clipboard isn't readable

  function selectionText() {
    return sel ? text().slice(sel.start, sel.end).trim() : "";
  }

  function copySelection() {
    const s = selectionText();
    if (!s) { notify("Select notes to copy first (click, then Shift+click).", true); return ""; }
    clip = s;
    try { navigator.clipboard.writeText(s).catch(() => {}); } catch (e) { /* fine: clip has it */ }
    return s;
  }

  // Only the music of a pasted tune; never a blank line (it would end the tune).
  function cleanPaste(raw) {
    let s = String(raw || "").replace(/\r\n?/g, "\n");
    if (/^K:/m.test(s)) s = s.slice(T.bodyStart(s));
    while (/\n[ \t]*\n/.test(s)) s = s.replace(/\n[ \t]*\n/g, "\n");
    return s.trim();
  }

  function pasteText(raw) {
    const s = cleanPaste(raw);
    if (!s) return;
    const t = ensureBody(text());
    let from, to;
    if (sel && !isBarSel()) { from = sel.start; to = sel.end; }
    else { if (sel) cursor = sel.end; from = to = Math.max(cursor, T.bodyStart(t)); }
    const before = t.slice(0, from);
    const after = t.slice(to);
    const ins = (before === "" || /\s$/.test(before) || from === T.bodyStart(t) ? "" : " ") + s +
      (after === "" || /^\s/.test(after) ? "" : " ");
    const next = T.keepBarPitches(t, to, before + ins + after, from + ins.length);
    change(next, { cursor: from + ins.length, sel: null });
    notify("Pasted.");
  }

  const inField = (node) => node && node.closest && node.closest("input, textarea, select");
  document.addEventListener("copy", (e) => {
    if (inField(e.target) || !sel || !getSelection().isCollapsed) return;
    e.preventDefault();
    e.clipboardData.setData("text/plain", copySelection());
    notify("Copied.");
  });
  document.addEventListener("cut", (e) => {
    if (inField(e.target) || !sel || !getSelection().isCollapsed) return;
    e.preventDefault();
    e.clipboardData.setData("text/plain", copySelection());
    deleteBack();
    notify("Cut.");
  });
  document.addEventListener("paste", (e) => {
    if (inField(e.target)) return;
    const s = e.clipboardData && e.clipboardData.getData("text/plain");
    if (!s) return;
    e.preventDefault();
    pasteText(s);
  });
  $("copy-notes").addEventListener("click", () => { if (copySelection()) notify("Copied."); });
  $("cut-notes").addEventListener("click", () => { if (copySelection()) { deleteBack(); notify("Cut."); } });
  $("paste-notes").addEventListener("click", async () => {
    let s = "";
    try { s = await navigator.clipboard.readText(); } catch (e) { /* no permission: use ours */ }
    if (!s && clip) s = clip;
    if (s) pasteText(s);
    else notify("Nothing to paste yet. Copy some notes first.", true);
  });

  function replaceSelected(fn) {
    if (!sel) return false;
    const t = text();
    const n = T.parseNoteText(t.slice(sel.start, sel.end));
    if (!n) { notify("That element can't be edited with the buttons; use the ABC source.", true); return true; }
    const updated = fn(n);
    // Nothing to change (e.g. a rest dragged up): redraw, which also puts
    // back anything abcjs moved on screen while dragging.
    if (!updated) { render(); return true; }
    const s = T.noteTextToAbc(updated);
    const next = T.keepBarPitches(t, sel.end, t.slice(0, sel.start) + s + t.slice(sel.end), sel.start + s.length);
    change(next, {
      sel: { start: sel.start, end: sel.start + s.length },
      cursor: sel.start + s.length,
    });
    return true;
  }

  function currentDuration() { return dotted ? dur * 1.5 : dur; }

  function preview(midi) {
    const pitches = [].concat(midi).map((m) => ({ pitch: m, volume: 90, start: 0, duration: 0.25, instrument: 0 }));
    try {
      ABCJS.synth.playEvent(
        pitches, [], 1000,
        new URL("/soundfont/", location.href).href,
      ).catch(() => {});
    } catch (e) { /* no audio: fine */ }
  }

  // `midi` is the key as written (what's on the score); spell it in the
  // written key, then store the concert-pitch equivalent.
  function pianoKey(midi) {
    leaveBar();
    const t = text();
    const pos = sel ? sel.start : cursor;
    const ctx = T.contextAt(t, pos);
    const k = T.getField(t, "K") || "C";
    const x = tr();
    const w = T.spellMidi(midi, T.prefersFlats(T.writtenKey(k, x.semis)));
    const sp = T.toConcert(w.letter, w.octave, w.alter, x);
    preview(midi - x.semis);
    const acc = T.accidentalFor(ctx, sp.letter, sp.octave, sp.alter);
    const abc = T.pitchToAbc({ letter: sp.letter, octave: sp.octave, acc });
    enterPitch(abc);
  }

  // Letters typed on the computer keyboard: nearest octave to the previous note.
  function letterKey(writtenLetter) {
    leaveBar();
    const steps = tr().steps;
    const letter = T.LETTERS[(((T.LETTERS.indexOf(writtenLetter) - steps) % 7) + 7) % 7];
    const t = text();
    const pos = sel ? sel.start : cursor;
    const ctx = T.contextAt(t, pos);
    const prev = previousPitch(pos);
    let octave = prev ? prev.octave : baseOctave;
    if (prev) {
      const idx = (o) => T.LETTERS.indexOf(letter) + 7 * o;
      const target = T.LETTERS.indexOf(prev.letter) + 7 * prev.octave;
      octave = [octave - 1, octave, octave + 1].reduce((a, b) => (Math.abs(idx(b) - target) < Math.abs(idx(a) - target) ? b : a));
    }
    const alter = T.impliedAlter(ctx, letter, octave);
    preview(T.midiOf(letter, octave, alter));
    enterPitch(T.pitchToAbc({ letter, octave, acc: null }));
  }

  function previousPitch(pos) {
    const notes = elements(["note"]).filter((e) => e.endChar <= pos).reverse();
    for (const e of notes) {
      const n = T.parseNoteText(text().slice(e.startChar, e.endChar));
      if (n && n.letter && n.letter !== "z" && n.letter !== "x") return T.parsePitch(n.letter + n.marks);
    }
    return null;
  }

  function enterPitch(pitchAbc) {
    const p = T.parsePitch(pitchAbc);
    if (sel) {
      replaceSelected((n) => {
        if (n.chord) { notify("Chords can't be re-pitched from the keyboard; use the ABC source.", true); return null; }
        return { ...n, acc: p.acc, letter: pitchAbc.replace(/^[\^_=]+/, "").replace(/[,']+$/, ""), marks: pitchAbc.match(/[,']*$/)[0] };
      });
      return;
    }
    insertNote(pitchAbc);
  }

  function enterRest() {
    if (isRange()) return transformRange((n) => ({ ...n, chord: null, acc: null, letter: "z", marks: "", tie: "" }));
    leaveBar();
    if (sel) {
      replaceSelected((n) => ({ ...n, chord: null, acc: null, letter: "z", marks: "", tie: "" }));
      return;
    }
    insertNote("z");
  }

  function insertNote(core) {
    let t = ensureBody(text());
    let pos = Math.max(cursor, T.bodyStart(t));
    const ctx = T.contextAt(t, pos);
    const d = currentDuration();
    const chord = pendingChord ? '"' + pendingChord + '"' : "";
    pendingChord = "";
    chordInput.value = "";
    let ins = T.separatorBefore(t, pos, ctx, d) + chord + core + T.lengthSuffix(d, ctx.unit);
    // Close the bar once it's full, unless more of it follows (inserting
    // into the middle of a bar) or a bar line is already there. Start a new
    // line after every 4th bar, never leaving a blank line (which would end
    // the tune in ABC).
    const rest = t.slice(pos);
    const restOfBar = rest.match(/^[^|\n]*/)[0];
    const ctx2 = T.contextAt(t.slice(0, pos) + ins, pos + ins.length);
    if (T.isFull(ctx2) && !restOfBar.trim() && !/^\s*(\||::)/.test(rest)) {
      const lineEnds = /^[ \t]*(\n|$)/.test(rest);
      if (ctx2.barsOnLine + 1 >= 4 && lineEnds && !/^[ \t]*\n/.test(rest)) ins += " |\n";
      else ins += " |" + (lineEnds && rest.length ? "" : " ");
    } else if (/^[^\s]/.test(rest)) {
      ins += " "; // inserted before more music: keep it apart from what follows
    }
    const next = T.keepBarPitches(t, pos, t.slice(0, pos) + ins + t.slice(pos), pos + ins.length);
    change(next, { cursor: pos + ins.length, sel: null });
  }

  function ensureBody(t) {
    if (T.getField(t, "K") != null) return t.endsWith("\n") || t.slice(T.bodyStart(t)).trim() ? t : t + "\n";
    return T.ensureSkeleton(t);
  }

  function insertMark(mark) {
    // A selected bar line: bar buttons change its type, 1./2. set or clear
    // its ending.
    if (isBarSel() && mark !== "\n" && mark !== "(3") {
      const t = text();
      const b = T.parseBarText(t.slice(sel.start, sel.end));
      let s;
      if (/^\[\d$/.test(mark)) s = b.bar + (b.ending === mark[1] ? "" : "[" + mark[1]);
      else s = mark + (b.ending ? "[" + b.ending : "");
      const next = T.keepBarPitches(t, sel.end, t.slice(0, sel.start) + s + t.slice(sel.end), sel.start + s.length);
      change(next, { sel: { start: sel.start, end: sel.start + s.length, kind: "bar" }, cursor: sel.start + s.length });
      return;
    }
    if (sel) { cursor = sel.end; sel = null; }
    const t = ensureBody(text());
    const pos = Math.max(cursor, T.bodyStart(t));
    const before = t.slice(0, pos);
    let ins;
    if (mark === "\n") {
      // A blank line would end the tune.
      if (/\n[ \t]*$/.test(before) || /^[ \t]*\n/.test(t.slice(pos))) return;
      ins = "\n";
    }
    else if (mark === "(3") ins = (/[\s|:]$/.test(before) || pos === T.bodyStart(t) ? "" : " ") + mark;
    else ins = (/\s$/.test(before) || pos === T.bodyStart(t) ? "" : " ") + mark + " ";
    change(t.slice(0, pos) + ins + t.slice(pos), { cursor: pos + ins.length, sel: null });
  }

  // The note an accidental or tie applies to: selected, else the one before the cursor.
  function targetNote() {
    leaveBar();
    if (sel) return sel;
    const e = elements(["note"]).filter((x) => x.endChar <= cursor).pop();
    return e ? { start: e.startChar, end: e.endChar } : null;
  }

  function withTarget(fn) {
    const target = targetNote();
    if (!target) { notify("Add or select a note first.", true); return; }
    const hadSel = !!sel;
    sel = target;
    const done = replaceSelected(fn);
    if (!hadSel && done) { cursor = sel ? sel.end : cursor; sel = null; render(); }
  }

  // ♯/♭/♮ mean what they say on the (possibly transposed) score. Pressing
  // the one already written removes it again.
  function setAccidental(acc) {
    const want = T.accAlter(acc);
    const one = (n, toggle) => {
      if (!n.letter || n.letter === "z" || n.letter === "x") return null;
      const x = tr();
      const p = T.parsePitch(n.letter + n.marks);
      if (toggle && n.acc && T.toWritten(p.letter, p.octave, T.accAlter(n.acc), x).alter === want) return { ...n, acc: null };
      const written = T.toWritten(p.letter, p.octave, 0, x);
      const c = T.toConcert(written.letter, written.octave, want, x);
      const symbol = T.accidentalSymbol(c.alter);
      return symbol ? { ...n, acc: symbol } : null;
    };
    // A range gets the accidental on every note; a single note toggles it.
    if (isRange()) return transformRange((n) => one(n, false));
    withTarget((n) => one(n, true));
  }

  function toggleTie() {
    withTarget((n) => ({ ...n, tie: n.tie ? "" : "-" }));
  }

  function setDuration(d) {
    dur = d;
    if (isRange()) transformRange((n) => ({ ...n, length: T.lengthSuffix(currentDuration(), T.unitLength(text())) }));
    else if (sel && !isBarSel()) {
      replaceSelected((n) => ({ ...n, length: T.lengthSuffix(currentDuration(), T.unitLength(text())) }));
    }
    updateStatus();
  }

  function toggleDot() {
    dotted = !dotted;
    if (isRange()) transformRange((n) => ({ ...n, length: T.lengthSuffix(currentDuration(), T.unitLength(text())) }));
    else if (sel && !isBarSel()) {
      replaceSelected((n) => ({ ...n, length: T.lengthSuffix(currentDuration(), T.unitLength(text())) }));
    }
    updateStatus();
  }

  function moveSelected(steps) {
    if (isRange()) {
      return transformRange((n) => {
        if (n.chord) return { ...n, chord: T.stepChord(n.chord, steps) };
        if (!n.letter || n.letter === "z" || n.letter === "x") return null;
        const abc = T.pitchToAbc(T.stepPitch(T.parsePitch(n.letter + n.marks), steps));
        return { ...n, acc: null, letter: abc.replace(/[,']+$/, ""), marks: abc.match(/[,']*$/)[0] };
      });
    }
    replaceSelected((n) => {
      if (n.chord) {
        const chord = T.stepChord(n.chord, steps);
        preview(chordMidis(chord, sel.start));
        return { ...n, chord };
      }
      if (!n.letter || n.letter === "z" || n.letter === "x") return null;
      const p = T.stepPitch(T.parsePitch(n.letter + n.marks), steps);
      const abc = T.pitchToAbc(p);
      const ctx = T.contextAt(text(), sel.start);
      preview(T.midiOf(p.letter, p.octave, T.impliedAlter(ctx, p.letter, p.octave)));
      return { ...n, acc: null, letter: abc.replace(/[,']+$/, ""), marks: abc.match(/[,']*$/)[0] };
    });
  }

  function applyChord() {
    leaveBar();
    // Typed as written; stored at concert pitch like everything else.
    const k = T.getField(text(), "K") || "C";
    const symbol = T.transposeChord(chordInput.value.trim().replace(/"/g, ""), -tr().semis, T.prefersFlats(k));
    if (sel) {
      replaceSelected((n) => T.withChordSymbol(n, symbol));
      chordInput.value = "";
      return;
    }
    pendingChord = symbol;
    updateStatus();
  }

  function deleteBack() {
    const t = text();
    if (sel) {
      let { start, end } = sel;
      if (/\s/.test(t[start - 1] || "") && /\s/.test(t[end] || "")) end++;
      change(T.keepBarPitches(t, end, t.slice(0, start) + t.slice(end), start), { cursor: start, sel: null });
      return;
    }
    let p = cursor;
    while (p > T.bodyStart(t) && /[ \t]/.test(t[p - 1])) p--;
    if (p <= T.bodyStart(t)) return;
    const e = elements(["note", "bar"]).find((x) => x.startChar < p && x.endChar >= p);
    let start;
    if (e) start = e.startChar;
    else {
      const m = t.slice(0, p).match(/(\(\d|\[\d|"[^"]*"|\n|\S)$/);
      start = p - m[0].length;
    }
    change(T.keepBarPitches(t, cursor, t.slice(0, start) + t.slice(cursor), start), { cursor: start, sel: null });
  }

  // --- Keyboard shortcuts ------------------------------------------------------------------

  document.addEventListener("keydown", (e) => {
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === "z") { e.preventDefault(); e.shiftKey ? doRedo() : doUndo(); return; }
    if (mod && e.key.toLowerCase() === "y") { e.preventDefault(); doRedo(); return; }
    // Typing in a field is typing. (A clicked note has focus inside the SVG;
    // abcjs's own arrow-key dragging there only commits on Tab, so the
    // handling below takes over.)
    if (e.key === "Escape" && closeOverlays()) { e.preventDefault(); return; }
    if (e.target.closest && e.target.closest("input, textarea, select")) return;
    if (mod || e.altKey) return;
    const k = e.key;
    let handled = true;
    if (/^[a-gA-G]$/.test(k)) letterKey(k.toUpperCase());
    else if (/^[1-6]$/.test(k)) setDuration(DURATIONS[+k - 1].dur);
    else if (k === ".") toggleDot();
    else if (k === "r" || k === "R" || k === "z") enterRest();
    else if (k === "|") insertMark("|");
    else if (k === "Backspace" || k === "Delete") deleteBack();
    else if (k === "Escape") deselect();
    else if (k === "ArrowUp" && sel && !isBarSel()) moveSelected(e.shiftKey ? 7 : 1);
    else if (k === "ArrowDown" && sel && !isBarSel()) moveSelected(e.shiftKey ? -7 : -1);
    else if (k === "ArrowLeft" && e.shiftKey) extendBy(-1);
    else if (k === "ArrowRight" && e.shiftKey) extendBy(1);
    else if (k === "ArrowLeft") selectNeighbour(-1);
    else if (k === "ArrowRight") selectNeighbour(1);
    else handled = false;
    if (handled) e.preventDefault();
  });

  // --- Import -------------------------------------------------------------------------------

  const fileInput = $("import-file");
  $("import").addEventListener("click", () => fileInput.click());
  fileInput.addEventListener("change", () => {
    if (fileInput.files[0]) doImport(fileInput.files[0]);
    fileInput.value = "";
  });
  const editor = $("editor");
  editor.addEventListener("dragover", (e) => { e.preventDefault(); editor.classList.add("dropping"); });
  editor.addEventListener("dragleave", (e) => { if (e.target === editor) editor.classList.remove("dropping"); });
  editor.addEventListener("drop", (e) => {
    e.preventDefault();
    editor.classList.remove("dropping");
    const f = e.dataTransfer.files[0];
    if (f) doImport(f);
  });

  async function doImport(file) {
    notify(`Importing ${file.name}…`);
    try {
      const { abc } = await importFile(file);
      openTune(abc, null);
      saveNow();
      notify(`Imported ${file.name} as a new tune.`);
    } catch (err) {
      console.error(err);
      notify(`Couldn't import ${file.name}: ${err.message}`, true);
    }
  }

  $("new").addEventListener("click", () => {
    openTune(NEW_TUNE, null);
    fTitle.focus();
    fTitle.select();
  });

  // --- Copy -----------------------------------------------------------------------------------

  $("copy").addEventListener("click", async function () {
    const btn = this;
    await updateLinks();
    const url = $("embed-url").dataset.full;
    const done = (ok) => {
      btn.textContent = ok ? "Copied" : "Select and copy below";
      setTimeout(() => { btn.textContent = "Copy link"; }, 1500);
    };
    try {
      await navigator.clipboard.writeText(url);
      done(true);
    } catch (e) {
      $("embed-url").textContent = url; // select the whole link, not the short form
      const range = document.createRange();
      range.selectNodeContents($("embed-url"));
      getSelection().removeAllRanges();
      getSelection().addRange(range);
      done(false);
    }
  });

  // --- Library and autosave ---------------------------------------------------------------------

  const saveState = $("save-state");
  function setSaveState(state) {
    const labels = {
      "": "",
      pending: "Saving…",
      saved: "Saved",
      full: "Not saved: browser storage is full",
      unavailable: "Not saved: browser storage is unavailable",
    };
    saveState.textContent = labels[state] ?? "";
    saveState.title = state === "saved" ? "Saved in this browser only (nothing is sent to the server)" : "";
    saveState.classList.toggle("error", state === "full" || state === "unavailable");
  }

  function scheduleSave() {
    setSaveState("pending");
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveNow, 600);
  }

  function saveNow() {
    clearTimeout(saveTimer);
    saveTimer = null;
    if (!tuneId) tuneId = Lib.newId();
    const result = Lib.save({ id: tuneId, title: T.getField(text(), "T") || "Untitled", abc: text() });
    setSaveState(result.ok ? "saved" : result.reason);
    renderLibrary();
    syncUi();
  }

  function flushSave() {
    if (saveTimer) saveNow();
  }
  window.addEventListener("pagehide", flushSave);
  document.addEventListener("visibilitychange", () => { if (document.hidden) flushSave(); });

  // Switch the editor to another tune. Undo history belongs to one tune.
  function openTune(abc, id) {
    flushSave();
    tuneId = id;
    server = (id && Lib.get(id)?.server) || null;
    textarea.value = abc;
    lastText = abc;
    undo.length = 0;
    redo.length = 0;
    typingGroupAt = 0;
    sel = null;
    cursor = abc.length;
    pendingChord = "";
    const clef = T.getClef(T.getField(abc, "K"));
    baseOctave = clef === "bass" ? 2 : clef === "treble" ? 4 : 3;
    buildKeyboard();
    render();
    setSaveState(id ? "saved" : "");
    renderLibrary();
  }

  const libPanel = $("library");
  const libList = $("lib-list");
  const libFilter = $("lib-filter");
  const libBtn = $("toggle-library");
  const relTime = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });

  function ago(ms) {
    const s = (ms - Date.now()) / 1000;
    const steps = [[60, "second"], [60, "minute"], [24, "hour"], [7, "day"], [4.35, "week"], [12, "month"], [Infinity, "year"]];
    let v = s;
    for (const [n, unit] of steps) {
      if (Math.abs(v) < n) return Math.abs(v) < 45 && unit === "second" ? "just now" : relTime.format(Math.round(v), unit);
      v /= n;
    }
    return "";
  }

  function summary(abc) {
    const k = T.keyLabel(T.splitKey(T.getField(abc, "K") || "").key, names);
    const m = T.getField(abc, "M");
    return [k, m].filter(Boolean).join(" · ");
  }

  function renderLibrary() {
    const tunes = Lib.list();
    libBtn.textContent = tunes.length ? `Tunes (${tunes.length})` : "Tunes";
    const q = libFilter.value.trim().toLowerCase();
    const shown = q ? tunes.filter((t) => t.title.toLowerCase().includes(q)) : tunes;
    libList.textContent = "";
    for (const t of shown) {
      const open = el("button", { type: "button", class: "lib-open", onclick: () => {
        if (t.id !== tuneId) openTune(t.abc, t.id);
        if (phone.matches) showLibrary(false);
      } },
        el("span", { class: "lib-title" }, t.title),
        el("span", { class: "lib-meta" }, [ago(t.updated), summary(t.abc), t.server ? "online" : ""].filter(Boolean).join(" · ")));
      if (t.id === tuneId) open.setAttribute("aria-current", "true");
      const del = el("button", {
        type: "button", class: "lib-delete", title: "Delete", "aria-label": `Delete ${t.title}`,
        onclick: () => deleteTune(t),
      }, "×");
      libList.append(el("li", {}, open, del));
    }
    $("lib-empty").hidden = shown.length > 0;
    renderOnline(q);
    $("lib-empty").textContent = !Lib.available()
      ? "This browser isn't allowing storage here (private window?), so tunes can't be saved."
      : tunes.length ? "No tunes match." : "Tunes you edit are saved here automatically.";
  }

  function deleteTune(t) {
    if (!confirm(`Delete “${t.title}” from this browser?`)) return;
    Lib.remove(t.id);
    if (t.id === tuneId) {
      clearTimeout(saveTimer);
      saveTimer = null;
      tuneId = null;
      const next = Lib.list()[0];
      openTune(next ? next.abc : NEW_TUNE, next ? next.id : null);
    } else {
      renderLibrary();
    }
    notify(`Deleted “${t.title}”.`);
  }

  // A side column on wide screens; a drawer over the editor on phones.
  function showLibrary(on) {
    libPanel.hidden = !on;
    libBtn.setAttribute("aria-pressed", on ? "true" : "false");
    if (on && phone.matches) openSheet(false);
    if (!phone.matches) {
      try { localStorage.setItem("abc-show-library", on ? "1" : "0"); } catch (e) { /* ignore */ }
    }
    placeCaret();
  }
  libBtn.addEventListener("click", () => showLibrary(libPanel.hidden));
  libFilter.addEventListener("input", renderLibrary);
  Lib.onExternalChange(renderLibrary);
  setInterval(renderLibrary, 60000);

  // --- Online songs (signed-in users) --------------------------------------------------------------

  // Only people signed in through the proxy see any of this. Songs are saved
  // under a slug of their title ("Speed the Plough" -> speed-the-plough),
  // and anyone can then view them at /s/<slug>.
  const saveOnlineBtn = $("save-online");
  const signIn = $("sign-in");
  const onlineSection = $("online-section");
  const srvList = $("srv-list");

  // Sign in through the proxy and come back to exactly this tune.
  signIn.addEventListener("mousedown", () => { signIn.href = Online.signInUrl(location.pathname + location.search + location.hash); });
  signIn.addEventListener("focus", () => { signIn.href = Online.signInUrl(location.pathname + location.search + location.hash); });

  function signedOut() {
    account = null;
    onlineSongs = [];
    syncUi();
    notify("Your sign-in has expired. Sign in again to save online.", true);
  }

  async function refreshOnline() {
    const r = await Online.list();
    if (r.status === 401) return signedOut();
    onlineSongs = r.ok ? r.data : [];
    renderLibrary();
  }

  function renderOnline(filter) {
    srvList.textContent = "";
    if (!account) return;
    const shown = filter ? onlineSongs.filter((s) => s.title.toLowerCase().includes(filter) || s.id.includes(filter)) : onlineSongs;
    for (const s of shown) {
      const open = el("button", { type: "button", class: "lib-open", title: "/s/" + s.id, onclick: () => openOnline(s) },
        el("span", { class: "lib-title" }, s.title),
        el("span", { class: "lib-meta" },
          [ago(s.updated_at), T.keyLabel(s.key, names), s.meter, "by " + s.updated_by].filter(Boolean).join(" · ")));
      if (server && server.id === s.id) open.setAttribute("aria-current", "true");
      const del = el("button", {
        type: "button", class: "lib-delete", title: "Delete online", "aria-label": `Delete ${s.title} online`,
        onclick: () => deleteOnline(s),
      }, "×");
      srvList.append(el("li", {}, open, del));
    }
    $("srv-empty").hidden = shown.length > 0;
    $("srv-empty").textContent = onlineSongs.length ? "No online songs match." : "Songs you save online appear here.";
  }

  function link(localId, song) {
    server = song;
    Lib.save({ id: localId, server: song });
  }

  async function saveOnline() {
    const title = (T.getField(text(), "T") || "").trim();
    const id = Online.slugify(title);
    if (!id) {
      notify("Give the tune a title first: it becomes its online name.", true);
      if (phone.matches) openSheet(false);
      fTitle.focus();
      return;
    }
    if (!tuneId || saveTimer) saveNow();
    const song = { abc: text(), title, composer: T.getField(text(), "C") || "" };
    const previous = server && server.id;
    saveOnlineBtn.disabled = true;
    try {
      // Re-saving the song this tune came from just updates it; any other
      // song already using the name needs a yes first.
      let r = await Online.save(id, song, previous === id);
      if (r.status === 409) {
        const other = r.data.song;
        if (!confirm(`“${other.title}” is already saved online as “${id}” (${ago(other.updated_at)}, by ${other.updated_by}). Replace it with this tune?`)) {
          notify("Not saved online.");
          return;
        }
        r = await Online.save(id, song, true);
      }
      if (r.status === 401) return signedOut();
      if (!r.ok) return notify(`Couldn't save online: ${(r.data && r.data.error) || r.status}`, true);
      link(tuneId, { id, abc: song.abc });
      notify(`Saved online. Share it as /s/${id}` + (previous && previous !== id ? ` (the old “${previous}” is still online).` : "."));
      refreshOnline();
      syncUi();
    } finally {
      saveOnlineBtn.disabled = false;
    }
  }
  saveOnlineBtn.addEventListener("click", saveOnline);

  // Open an online song in the editor, as a local tune linked to it.
  async function openOnline(s) {
    const r = await Online.get(s.id);
    if (!r.ok) {
      notify(r.status === 404 ? `There's no online song “${s.id}”.` : `Couldn't load “${s.title}”.`, true);
      return false;
    }
    s = { ...s, title: r.data.title };
    const song = { id: s.id, abc: r.data.abc };
    const local = Lib.list().find((t) => t.server && t.server.id === s.id);
    if (local) {
      if (local.abc !== song.abc &&
          !confirm(`Your copy of “${s.title}” in this browser differs from the online one. Replace it with the online version?`)) {
        openTune(local.abc, local.id);
      } else {
        Lib.save({ id: local.id, title: r.data.title, abc: song.abc, server: song });
        openTune(song.abc, local.id);
      }
    } else {
      const id = Lib.newId();
      Lib.save({ id, title: r.data.title, abc: song.abc, server: song });
      openTune(song.abc, id);
    }
    if (phone.matches) showLibrary(false);
    return true;
  }

  async function deleteOnline(s) {
    if (!confirm(`Delete “${s.title}” online? Links to /s/${s.id} will stop working. Copies in this browser are kept.`)) return;
    const r = await Online.remove(s.id);
    if (r.status === 401) return signedOut();
    if (!r.ok && r.status !== 404) return notify(`Couldn't delete: ${(r.data && r.data.error) || r.status}`, true);
    for (const t of Lib.list()) if (t.server && t.server.id === s.id) Lib.save({ id: t.id, server: null });
    if (server && server.id === s.id) server = null;
    notify(`Deleted “${s.title}” online.`);
    refreshOnline();
    syncUi();
  }

  // Link by name or with the tune in it: offered once the tune is saved online.
  const linkBtns = document.querySelectorAll("#link-kind button");
  linkBtns.forEach((b) => b.addEventListener("click", () => {
    share = { ...share, named: b.dataset.kind === "named" };
    syncUi();
  }));

  // --- Deriving the interface from state -----------------------------------------------------

  // Everything shown that follows from `part`, `names`, `account`, `server`
  // and `share` is set here and only here; every change to those ends with a
  // call to this.
  function syncUi() {
    // Transposition and note-name toggles, and their labels.
    partBtns.forEach((b) => b.setAttribute("aria-pressed", (b.dataset.tr || null) === part.tr ? "true" : "false"));
    partLow.setAttribute("aria-pressed", part.tr && part.low ? "true" : "false");
    partLow.disabled = !part.tr;
    namesBtns.forEach((b) => b.setAttribute("aria-pressed", b.dataset.names === names ? "true" : "false"));
    const sol = names === "solfege";
    const partName = { "": sol ? "Ut" : "Concert", bb: sol ? "Sib" : "B♭", eb: sol ? "Mib" : "E♭" };
    partBtns.forEach((b) => { b.textContent = partName[b.dataset.tr]; });
    const trName = { c: partName[""], bb: partName.bb, eb: partName.eb, "bb-low": partName.bb + " ↓8ve", "eb-low": partName.eb + " ↓8ve" };
    for (const o of $("opt-tr").options) if (o.value) o.textContent = trName[o.value];

    // Signed in or not.
    saveOnlineBtn.hidden = !account;
    signIn.hidden = !!account;
    onlineSection.hidden = !account;
    $("lib-local-heading").hidden = !account;
    $("online-user").textContent = account ? `· ${account.name}` : "";

    // The sharing panel shows `share` (a field being typed in is left alone).
    for (const c of SHARE_CONTROLS) {
      if (c.kind === "checked") c.el.checked = !!share[c.key];
      else if (document.activeElement !== c.el) c.el.value = share[c.key] ?? "";
    }
    const image = !!share.link; // images have no player and no edit button
    $("opt-play").disabled = $("opt-editbtn").disabled = image;
    const byNameAvailable = !!(account && server);
    $("link-kind").hidden = !byNameAvailable;
    linkBtns.forEach((b) => b.setAttribute("aria-pressed", (b.dataset.kind === "named") === share.named ? "true" : "false"));
    $("link-note").textContent = byNameAvailable && share.named && server.abc !== text()
      ? "The named link shows the last online save: Save online to update it." : "";

    updateLinks();
  }

  // --- Phone layout -----------------------------------------------------------------------------

  // On phones the score and note entry get the screen; tune settings, file
  // actions, note names and embed options move into the "⋯" sheet. Moving
  // the nodes (rather than duplicating them) keeps every listener intact.
  const sheet = $("more-sheet");
  const moreBtn = $("more");
  const moves = [
    ["f-composer", "sheet-tune"], ["tune-settings", "sheet-tune"], ["note-names", "sheet-display"],
    ["file-actions", "sheet-file"], ["embed", "sheet-embed"],
  ].map(([id, slot]) => {
    const node = $(id);
    const mark = document.createComment(id);
    node.before(mark);
    return { node, mark, slot: $(slot) };
  });

  function applyLayout() {
    const on = phone.matches;
    document.documentElement.classList.toggle("phone", on);
    for (const m of moves) {
      if (on) m.slot.append(m.node);
      else m.mark.after(m.node);
    }
    if (!on) openSheet(false);
    buildKeyboard();
    render();
  }

  function openSheet(on) {
    sheet.hidden = !on;
    moreBtn.setAttribute("aria-expanded", on ? "true" : "false");
    if (on && phone.matches && !libPanel.hidden) showLibrary(false);
  }
  moreBtn.addEventListener("click", () => openSheet(sheet.hidden));

  // Returns true if something was open.
  function closeOverlays() {
    if (!sheet.hidden) { openSheet(false); return true; }
    if (phone.matches && !libPanel.hidden) { showLibrary(false); return true; }
    return false;
  }

  // Tapping outside the sheet or drawer closes it.
  document.addEventListener("pointerdown", (e) => {
    if (!phone.matches) return;
    if (!sheet.hidden && !sheet.contains(e.target) && !moreBtn.contains(e.target)) openSheet(false);
    if (!libPanel.hidden && !libPanel.contains(e.target) && !libBtn.contains(e.target)) showLibrary(false);
  });
  // Actions that lead elsewhere close the sheet behind them.
  for (const id of ["new", "import", "toggle-source", "save-online"]) {
    $(id).addEventListener("click", () => { if (phone.matches) openSheet(false); });
  }

  // --- Start ------------------------------------------------------------------------------------

  // ?edit&t=<id> reopens a saved tune; a link carrying a tune opens it as a
  // new (not yet saved) one; a bare ?edit resumes the most recent tune.
  setNames(names);
  setPart(part);
  const stored = params.get("t") && Lib.get(params.get("t"));
  const fromLink = stored ? "" : await decode(location.hash.slice(1)).catch(() => "");
  const recent = Lib.list()[0];
  // ?edit&song=<id> comes from an embed's edit button: open the online song.
  const fromSong = !stored && params.get("song") && (await openOnline({ id: params.get("song"), title: params.get("song") }));
  if (fromSong) { /* opened */ }
  else if (stored) openTune(stored.abc, stored.id);
  else if (fromLink) openTune(fromLink, null);
  else if (recent) openTune(recent.abc, recent.id);
  else openTune(SAMPLE, null);

  let libPref = null;
  try { libPref = localStorage.getItem("abc-show-library"); } catch (e) { /* ignore */ }
  showLibrary(!phone.matches && (libPref ? libPref === "1" : Lib.list().length > 0));
  applyLayout();
  phone.addEventListener("change", applyLayout);
  Online.me().then((a) => {
    account = a;
    syncUi();
    if (account) refreshOnline();
  });
  let resizeTimer;
  window.addEventListener("resize", () => {
    placeCaret();
    clearTimeout(resizeTimer);
    if (phone.matches) resizeTimer = setTimeout(render, 200); // reflow for the new width
  });
  // Last, so the layout pass above doesn't overwrite it.
  if (params.get("song") && !fromSong && !stored) {
    notify(`There's no online song “${params.get("song")}”; it may have been renamed or deleted.`, true);
  }
}
