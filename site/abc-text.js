// Pure helpers for reading and rewriting ABC text. No DOM in here.
//
// Scope: the first tune in the text, single voice. That is what the visual
// editor produces; anything fancier still round-trips untouched, it just
// isn't editable with the buttons.

const EPS = 1e-6;

// --- Header fields ----------------------------------------------------------

// Header = the leading "X:"-style lines up to and including K:.
function headerSpan(lines) {
  let end = 0;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (/^[A-Za-z]:/.test(l) || /^%/.test(l) || (i === 0 && l.trim() === "")) {
      end = i + 1;
      if (/^K:/.test(l)) break;
    } else break;
  }
  return end;
}

export function getField(text, field) {
  const lines = text.split("\n");
  const end = headerSpan(lines);
  for (let i = 0; i < end; i++) {
    if (lines[i].startsWith(field + ":")) return lines[i].slice(field.length + 1).trim();
  }
  return null;
}

// Replace, insert or (with an empty value) remove a header field. X comes
// first, T second, K last; anything else goes just before K.
export function setField(text, field, value) {
  const lines = text.split("\n");
  let end = headerSpan(lines);
  const idx = lines.slice(0, end).findIndex((l) => l.startsWith(field + ":"));
  const empty = value == null || String(value).trim() === "";
  if (idx >= 0) {
    if (empty && field !== "K" && field !== "X") lines.splice(idx, 1);
    else lines[idx] = field + ":" + value;
    return lines.join("\n");
  }
  if (empty) return text;
  const line = field + ":" + value;
  const header = lines.slice(0, end);
  const kIdx = header.findIndex((l) => l.startsWith("K:"));
  let at;
  if (field === "X") at = 0;
  else if (field === "T") at = header.findIndex((l) => l.startsWith("X:")) + 1;
  else if (field === "K") at = end;
  else at = kIdx >= 0 ? kIdx : end;
  lines.splice(at, 0, line);
  return lines.join("\n");
}

// Offset in `text` where the tune body (the music) starts.
export function bodyStart(text) {
  const lines = text.split("\n");
  const end = headerSpan(lines);
  let off = 0;
  for (let i = 0; i < end; i++) off += lines[i].length + 1;
  return Math.min(off, text.length);
}

// A tune the editor can append to: X, T, M, L, K present.
export function ensureSkeleton(text) {
  let t = text;
  if (getField(t, "X") == null) t = setField(t, "X", "1");
  if (getField(t, "M") == null) t = setField(t, "M", "4/4");
  if (getField(t, "L") == null) t = setField(t, "L", "1/8");
  if (getField(t, "K") == null) t = setField(t, "K", "C");
  if (!t.endsWith("\n")) t += "\n";
  return t;
}

// --- Key signatures ---------------------------------------------------------

const MAJOR_FIFTHS = { C: 0, G: 1, D: 2, A: 3, E: 4, B: 5, "F#": 6, "C#": 7,
  "G#": 8, "D#": 9, "A#": 10, F: -1, Bb: -2, Eb: -3, Ab: -4, Db: -5, Gb: -6,
  Cb: -7, Fb: -8 };
const MODE_OFFSET = { "": 0, maj: 0, ion: 0, m: -3, min: -3, aeo: -3,
  mix: -1, dor: -2, phr: -4, loc: -5, lyd: 1 };
const SHARP_ORDER = "FCGDAEB";

// Split a K: value into the key itself and anything after it (clef=... etc).
export function splitKey(kValue) {
  const v = (kValue || "").trim();
  const m = v.match(/^([A-G][#b]?(?:maj|min|mix|dor|phr|loc|lyd|ion|aeo|m)?[a-z]*(?=\s|$)|none|HP|Hp)?\s*(.*)$/i);
  return { key: m[1] || "", rest: m[2] || "" };
}

export function getClef(kValue) {
  const m = (kValue || "").match(/\bclef=(\S+)/);
  if (m) return m[1];
  const bare = (kValue || "").match(/\b(treble|bass|alto|tenor)\b/);
  return bare ? bare[1] : "treble";
}

export function setClef(kValue, clef) {
  const { key, rest } = splitKey(kValue);
  let r = rest.replace(/\s*\bclef=\S+/, "").replace(/\s*\b(treble|bass|alto|tenor)\b/, "").trim();
  if (clef && clef !== "treble") r = ("clef=" + clef + " " + r).trim();
  return (key || "C") + (r ? " " + r : "");
}

export function setKeyName(kValue, key) {
  const { rest } = splitKey(kValue);
  return key + (rest ? " " + rest : "");
}

// { F: 1, C: 1, ... } semitone alteration per letter implied by the key.
export function keyAccidentals(kValue) {
  const { key } = splitKey(kValue);
  const map = { C: 0, D: 0, E: 0, F: 0, G: 0, A: 0, B: 0 };
  const m = key.match(/^([A-G][#b]?)([a-zA-Z]*)$/i);
  if (!m) return map;
  const tonic = m[1];
  const modeKey = m[2].toLowerCase().slice(0, 3);
  const fifths = (MAJOR_FIFTHS[tonic] ?? 0) + (MODE_OFFSET[modeKey] ?? 0);
  if (fifths > 0) for (let i = 0; i < Math.min(fifths, 7); i++) map[SHARP_ORDER[i]] = 1;
  if (fifths < 0) for (let i = 0; i < Math.min(-fifths, 7); i++) map[SHARP_ORDER[6 - i]] = -1;
  return map;
}

export function prefersFlats(kValue) {
  const acc = keyAccidentals(kValue);
  return Object.values(acc).some((a) => a < 0);
}

// --- Meter and unit length -------------------------------------------------

function parseFraction(s) {
  const m = (s || "").trim().match(/^(\d+)\s*\/\s*(\d+)/);
  return m ? { num: +m[1], den: +m[2] } : null;
}

// Length of one bar in whole notes, or null for free meter.
export function barLength(mValue) {
  const v = (mValue || "").trim();
  if (v === "C") return 1;
  if (v === "C|") return 1;
  const f = parseFraction(v.replace(/^\(|\)$/g, "").replace(/^(\d+)\+(\d+)/, (_, a, b) => +a + +b));
  return f ? f.num / f.den : null;
}

// Beaming beat in whole notes: dotted quarter in 6/8 etc., else 1/den.
export function beatLength(mValue) {
  const v = (mValue || "").trim();
  if (v === "C|") return 1 / 2;
  if (v === "C") return 1 / 4;
  const f = parseFraction(v);
  if (!f) return 1 / 4;
  if (f.den >= 8 && f.num % 3 === 0 && f.num > 3) return 3 / f.den;
  return 1 / f.den;
}

export function unitLength(text) {
  const f = parseFraction(getField(text, "L"));
  if (f) return f.num / f.den;
  const bar = barLength(getField(text, "M"));
  return bar != null && bar < 0.75 ? 1 / 16 : 1 / 8;
}

// "3/2", "", "/", "/4" ... for a note of `dur` whole notes when L = unit.
export function lengthSuffix(dur, unit) {
  const m = dur / unit;
  for (const den of [1, 2, 4, 8, 16, 32, 64]) {
    const num = Math.round(m * den);
    if (Math.abs(num / den - m) < EPS) {
      const g = gcd(num, den);
      const n = num / g, d = den / g;
      if (d === 1) return n === 1 ? "" : String(n);
      return (n === 1 ? "" : String(n)) + "/" + (d === 2 ? "" : String(d));
    }
  }
  return "";
}

function gcd(a, b) { return b ? gcd(b, a % b) : a; }

function suffixMultiplier(suffix) {
  const m = (suffix || "").match(/^(\d*)(\/*)(\d*)$/);
  if (!m) return 1;
  const num = m[1] ? +m[1] : 1;
  let den = 1;
  if (m[2]) den = m[3] ? +m[3] * Math.pow(2, m[2].length - 1) : Math.pow(2, m[2].length);
  return num / den;
}

// --- Pitches ------------------------------------------------------------------

const LETTERS = [..."CDEFGAB"];
const SEMITONE = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
const ACC_ALTER = { "^^": 2, "^": 1, "=": 0, "_": -1, "__": -2 };
const ALTER_ACC = { 2: "^^", 1: "^", 0: "=", "-1": "_", "-2": "__" };

// { letter: "F", octave: 4, acc: "^" | null } -- octave 4 is middle C's.
export function parsePitch(s) {
  const m = s.match(/^(\^\^|\^|__|_|=)?([A-Ga-g])([,']*)$/);
  if (!m) return null;
  const lower = m[2] === m[2].toLowerCase();
  const ups = (m[3].match(/'/g) || []).length;
  const downs = (m[3].match(/,/g) || []).length;
  return { letter: m[2].toUpperCase(), octave: (lower ? 5 : 4) + ups - downs, acc: m[1] || null };
}

export function pitchToAbc(p) {
  let s = p.acc || "";
  if (p.octave >= 5) s += p.letter.toLowerCase() + "'".repeat(p.octave - 5);
  else s += p.letter + ",".repeat(Math.max(0, 4 - p.octave));
  return s;
}

export function midiOf(letter, octave, alter) {
  return 12 * (octave + 1) + SEMITONE[letter] + alter;
}

// Spell a MIDI number: naturals where possible, else sharps or flats.
export function spellMidi(midi, useFlats) {
  const octave = Math.floor(midi / 12) - 1;
  const pc = midi % 12;
  for (const l of LETTERS) if (SEMITONE[l] === pc) return { letter: l, octave, alter: 0 };
  if (useFlats) {
    const l = LETTERS.find((x) => SEMITONE[x] === (pc + 1) % 12);
    return { letter: l, octave: pc === 11 ? octave + 1 : octave, alter: -1 };
  }
  const l = LETTERS.find((x) => SEMITONE[x] === pc - 1);
  return { letter: l, octave, alter: 1 };
}

export function stepPitch(p, steps) {
  let idx = LETTERS.indexOf(p.letter) + 7 * p.octave + steps;
  return { letter: LETTERS[((idx % 7) + 7) % 7], octave: Math.floor(idx / 7), acc: null };
}

// --- Note names --------------------------------------------------------------------

// "letters" (C D E, middle C = C4) or "solfege": French fixed-do (Do Ré Mi),
// where octaves are numbered one lower, so middle C = Do3.
const SOLFEGE = { C: "Do", D: "Ré", E: "Mi", F: "Fa", G: "Sol", A: "La", B: "Si" };
const SIGN = { 2: "𝄪", 1: "♯", 0: "", "-1": "♭", "-2": "𝄫" };

export function noteName(letter, names) {
  return names === "solfege" ? SOLFEGE[letter] : letter;
}

export function octaveNumber(octave, names) {
  return names === "solfege" ? octave - 1 : octave;
}

export function pitchName(p, alter, names) {
  return noteName(p.letter, names) + (SIGN[alter] || "") + octaveNumber(p.octave, names);
}

// "F#m" -> "F♯m" / "Fa♯m"; anything unrecognised is returned as-is.
export function keyLabel(key, names) {
  const m = (key || "").match(/^([A-G])([#b]?)(.*)$/);
  if (!m) return key || "";
  return noteName(m[1], names) + (m[2] === "#" ? "♯" : m[2] === "b" ? "♭" : "") + m[3];
}

// --- Tokens in the music body --------------------------------------------------

// A note, rest or [chord], with the decorations/chord symbols before it and
// tie, broken rhythm and spacing after it -- the span abcjs reports for a
// clicked note.
const NOTE_RE = /^((?:"[^"]*"|![^!]*!|\+[^+]*\+|[.~HLMOPSTuv]|\s)*)(?:(\[[^\]]*\])|(\^\^|\^|__|_|=)?([A-Ga-gzx])([,']*))(\d*\/*\d*)(-?)([<>]*\s*)$/;

export function parseNoteText(s) {
  const m = s.match(NOTE_RE);
  if (!m) return null;
  return { prefix: m[1], chord: m[2] || null, acc: m[3] || null, letter: m[4] || null,
    marks: m[5] || "", length: m[6], tie: m[7], tail: m[8] };
}

export function noteTextToAbc(n) {
  const core = n.chord || (n.acc || "") + n.letter + n.marks;
  return n.prefix + core + n.length + n.tie + n.tail;
}

// Notes inside a [chord]: [{ letter, octave, acc }].
const CHORD_NOTE_RE = /(\^\^|\^|__|_|=)?([A-Ga-g])([,']*)/g;

export function chordPitches(chord) {
  return [...chord.matchAll(CHORD_NOTE_RE)].map((m) => ({ ...parsePitch(m[2] + m[3]), acc: m[1] || null }));
}

// Move every note of a [chord] by `steps` letter steps. Like single notes,
// explicit accidentals are dropped so the notes follow the key signature.
export function stepChord(chord, steps) {
  return chord.replace(CHORD_NOTE_RE, (all, acc, letter, marks) => pitchToAbc(stepPitch(parsePitch(letter + marks), steps)));
}

export function noteDuration(n, unit) {
  return unit * suffixMultiplier(n.length);
}

// Chord symbol ("Am") in a note prefix; annotations ("^text") are left alone.
export function chordSymbolOf(n) {
  const m = n.prefix.match(/"([^"^_<>@][^"]*)"/);
  return m ? m[1] : "";
}

export function withChordSymbol(n, symbol) {
  const stripped = n.prefix.replace(/"[^"^_<>@][^"]*"/, "");
  return { ...n, prefix: (symbol ? '"' + symbol + '"' : "") + stripped };
}

// Blank out things whose contents could look like notes or bar lines:
// chord symbols, decorations, inline fields, comments, grace notes, voltas.
// Offsets are preserved, and "[|" keeps its bar character.
function mask(s) {
  return s
    .replace(/"[^"]*"|![^!]*!|\+[^+]*\+|\[[A-Za-z]:[^\]]*\]|%[^\n]*|\{[^}]*\}|\[\d[\d,-]*/g, (x) => " ".repeat(x.length))
    .replace(/\[\|/g, " |");
}

const TOKEN_RE = /(\((\d)(?::\d*)?(?::\d*)?)|(\[[^\]]*\])(\d*\/*\d*)|(\^\^|\^|__|_|=)?([A-Ga-gzx])([,']*)(\d*\/*\d*)/g;
const TUPLET_FACTOR = { 2: 3 / 2, 3: 2 / 3, 4: 3 / 4, 5: 2 / 5, 6: 2 / 6, 7: 2 / 7, 9: 2 / 9 };

// Walk the notes of one bar fragment: sum of durations and explicit
// accidentals, as they stand at the end of the fragment.
function scanBar(fragment, unit) {
  let total = 0, tupletLeft = 0, tupletFactor = 1, lastDur = 0;
  const accidentals = {};
  const s = mask(fragment);
  let m;
  TOKEN_RE.lastIndex = 0;
  while ((m = TOKEN_RE.exec(s))) {
    if (m[1]) {
      const p = +m[2];
      tupletLeft = p;
      tupletFactor = TUPLET_FACTOR[p] || 1;
      continue;
    }
    let dur;
    if (m[3]) {
      const inner = m[3].match(/[A-Ga-g][,']*(\d*\/*\d*)/);
      dur = unit * (inner ? suffixMultiplier(inner[1]) : 1) * suffixMultiplier(m[4]);
    } else {
      dur = unit * suffixMultiplier(m[8]);
      if (m[5] && m[6] !== "z" && m[6] !== "x") {
        const p = parsePitch(m[6] + m[7]);
        accidentals[p.letter + p.octave] = ACC_ALTER[m[5]];
      }
    }
    if (tupletLeft > 0) { dur *= tupletFactor; tupletLeft--; }
    total += dur;
    lastDur = dur;
  }
  return { total, accidentals, lastDur };
}

const BAR_RE = /:*\|[\]|:]*|\[\||::/g;

// Everything the note buttons need to know about an insertion point.
export function contextAt(text, pos) {
  const start = bodyStart(text);
  const before = mask(text.slice(start, pos));
  let barFrom = 0, m;
  BAR_RE.lastIndex = 0;
  while ((m = BAR_RE.exec(before))) barFrom = m.index + m[0].length;
  const lineFrom = before.lastIndexOf("\n") + 1;
  const barsOnLine = (before.slice(lineFrom).match(BAR_RE) || []).length;
  const unit = unitLength(text);
  const scan = scanBar(text.slice(start + barFrom, pos), unit);
  return {
    unit,
    bar: barLength(getField(text, "M")),
    beat: beatLength(getField(text, "M")),
    key: keyAccidentals(getField(text, "K")),
    barPosition: scan.total,
    lastDur: scan.lastDur,
    barAccidentals: scan.accidentals,
    barsOnLine,
    atBodyStart: pos <= start,
  };
}

// Alteration a written note without accidental would get at this point.
export function impliedAlter(ctx, letter, octave) {
  const k = letter + octave;
  if (k in ctx.barAccidentals) return ctx.barAccidentals[k];
  return ctx.key[letter] || 0;
}

// The accidental to write so that letter/octave sounds with `alter`.
export function accidentalFor(ctx, letter, octave, alter) {
  return impliedAlter(ctx, letter, octave) === alter ? null : ALTER_ACC[alter];
}

export function accAlter(acc) {
  return acc == null ? null : ACC_ALTER[acc];
}

// In ABC an accidental lasts to the end of the bar. After an edit at
// oldPos (old text) / newPos (new text), with the text after them
// unchanged, later notes in that bar may have gained or lost one. Add
// explicit accidentals so they sound as before.
export function keepBarPitches(oldText, oldPos, newText, newPos) {
  const tail = mask(oldText.slice(oldPos));
  const end = tail.search(/\||::/);
  const segment = end < 0 ? tail : tail.slice(0, end);
  const re = /(\^\^|\^|__|_|=)?([A-Ga-g])([,']*)/g;
  const notes = [];
  let m;
  while ((m = re.exec(segment))) {
    if (m[1]) continue; // explicit accidental: unaffected
    const p = parsePitch(m[2] + m[3]);
    notes.push({ off: m.index, p, alter: impliedAlter(contextAt(oldText, oldPos + m.index), p.letter, p.octave) });
  }
  let text = newText;
  let shift = 0;
  for (const n of notes) {
    const at = newPos + n.off + shift;
    const now = impliedAlter(contextAt(text, at), n.p.letter, n.p.octave);
    if (now === n.alter) continue;
    const acc = ALTER_ACC[n.alter];
    text = text.slice(0, at) + acc + text.slice(at);
    shift += acc.length;
  }
  return text;
}

// A bar line as abcjs reports it, split into the bar itself and any
// ending that follows: "|[1" -> { bar: "|", ending: "1" }.
export function parseBarText(s) {
  const m = s.match(/^(.*?)\s*\[?(\d[\d,-]*)?\s*$/);
  return { bar: m[1], ending: m[2] || "" };
}

export function isFull(ctx) {
  return ctx.bar != null && ctx.barPosition >= ctx.bar - EPS;
}

// Whitespace to put before a new note so beams follow the beat.
export function separatorBefore(text, pos, ctx, dur) {
  const before = text.slice(0, pos);
  if (ctx.atBodyStart || before === "" || /\s$/.test(before)) return "";
  if (/[|:\]]$/.test(before)) return " ";
  const onBeat = Math.abs(ctx.barPosition / ctx.beat - Math.round(ctx.barPosition / ctx.beat)) < EPS;
  if (onBeat || dur >= ctx.beat - EPS || ctx.lastDur >= ctx.beat - EPS) return " ";
  return "";
}

// --- Display options for embeds -----------------------------------------------------------

// Blank out the title (T:) lines in the header, keeping every other offset
// intact so click-to-edit positions still match the source.
export function hideTitle(abc) {
  const lines = abc.split("\n");
  const end = headerSpan(lines);
  for (let i = 0; i < end; i++) {
    if (lines[i].startsWith("T:")) lines[i] = "%" + " ".repeat(lines[i].length - 1);
  }
  return lines.join("\n");
}

// Keep Q: (playback tempo) but don't print it. abcjs honours
// %%printtempo when it comes before the Q: line.
export function hideTempo(abc) {
  const m = abc.match(/^X:[^\n]*\n/m);
  const at = m ? m.index + m[0].length : 0;
  return abc.slice(0, at) + "%%printtempo false\n" + abc.slice(at);
}

// --- Transposing instruments -----------------------------------------------------------

// Written = concert + semitones. "low" writes the part an octave lower.
const PARTS = { bb: 2, eb: 9 };

export function partSemitones(tr, low) {
  if (!PARTS[tr]) return 0;
  return PARTS[tr] - (low ? 12 : 0);
}

// abcjs's visualTranspose picks the written key from these tables (see its
// parse/abc_transpose.js), so the editor has to spell things the same way.
const MAJOR_BY_PC = ["C", "Db", "D", "Eb", "E", "F", "F#", "G", "Ab", "A", "Bb", "B"];
const MINOR_BY_PC = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "Bb", "B"];

function tonicPc(tonic) {
  const alter = tonic[1] === "#" ? 1 : tonic[1] === "b" ? -1 : 0;
  return (SEMITONE[tonic[0].toUpperCase()] + alter + 12) % 12;
}

// Written tonic for a concert tonic + mode suffix ("", "m", "dor", ...).
export function transposeTonic(tonic, mode, semis) {
  if (!semis) return tonic;
  const table = /^m/i.test(mode || "") ? MINOR_BY_PC : MAJOR_BY_PC;
  return table[(tonicPc(tonic) + (semis % 12) + 12) % 12];
}

// The written key (K: value without extras) for a concert K: value.
export function writtenKey(kValue, semis) {
  const m = splitKey(kValue).key.match(/^([A-G][#b]?)(.*)$/i);
  if (!m || !semis) return splitKey(kValue).key;
  return transposeTonic(m[1], m[2], semis) + m[2];
}

// { semis, steps }: how far written notes sit from concert ones, in
// semitones and in letter steps (the letter distance between the keys).
export function transposition(kValue, semis) {
  if (!semis) return { semis: 0, steps: 0 };
  const m = splitKey(kValue).key.match(/^([A-G][#b]?)(.*)$/i);
  const concert = m ? m[1] : "C";
  const written = m ? transposeTonic(m[1], m[2], semis) : transposeTonic("C", "", semis);
  const s0 = (((LETTERS.indexOf(written[0].toUpperCase()) - LETTERS.indexOf(concert[0].toUpperCase())) % 7) + 7) % 7;
  const nominal = (semis * 7) / 12;
  return { semis, steps: s0 + 7 * Math.round((nominal - s0) / 7) };
}

function shiftPitch(letter, octave, alter, steps, semis) {
  const idx = LETTERS.indexOf(letter) + 7 * octave + steps;
  const nl = LETTERS[((idx % 7) + 7) % 7];
  const no = Math.floor(idx / 7);
  return { letter: nl, octave: no, alter: midiOf(letter, octave, alter) + semis - midiOf(nl, no, 0) };
}

export function toWritten(letter, octave, alter, tr) {
  return shiftPitch(letter, octave, alter, tr.steps, tr.semis);
}

export function toConcert(letter, octave, alter, tr) {
  return shiftPitch(letter, octave, alter, -tr.steps, -tr.semis);
}

// Move a chord symbol's root (and bass note) by `semis`: "Am7/G" etc.
export function transposeChord(symbol, semis, useFlats) {
  if (!semis) return symbol;
  const names = useFlats
    ? ["C", "Db", "D", "Eb", "E", "F", "Gb", "G", "Ab", "A", "Bb", "B"]
    : ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
  const move = (root) => names[(tonicPc(root) + (semis % 12) + 12) % 12];
  return symbol.replace(/^([A-G][#b]?)(.*?)(?:\/([A-G][#b]?))?$/, (all, root, quality, bass) =>
    move(root) + quality + (bass ? "/" + move(bass) : ""));
}

export function accidentalSymbol(alter) {
  return ALTER_ACC[alter] ?? null;
}

export function sharpsFlats(key) {
  const acc = Object.values(keyAccidentals(key));
  const sharps = acc.filter((a) => a > 0).length;
  const flats = acc.filter((a) => a < 0).length;
  return sharps ? sharps + "♯" : flats ? flats + "♭" : "";
}

export { EPS, SEMITONE, LETTERS };
