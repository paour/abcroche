import assert from "node:assert/strict";
import { test } from "node:test";
import * as T from "../site/abc-text.js";

test("key signatures", () => {
  assert.deepEqual(T.keyAccidentals("G"), { C: 0, D: 0, E: 0, F: 1, G: 0, A: 0, B: 0 });
  assert.equal(T.keyAccidentals("Dm").B, -1);
  assert.equal(T.keyAccidentals("Bb clef=bass").E, -1);
  assert.equal(T.splitKey("C clef=bass").key, "C");
  assert.equal(T.setClef("G", "bass"), "G clef=bass");
});

test("lengths", () => {
  assert.deepEqual([1, 2, 0.5, 0.25, 1.5, 0.75, 3].map((m) => T.lengthSuffix(m / 8, 1 / 8)), ["", "2", "/", "/4", "3/", "3/4", "3"]);
});

test("context: bar position and accidentals carried in the bar", () => {
  const tx = "X:1\nM:6/8\nL:1/8\nK:G\n^c2 d e3|";
  const ctx = T.contextAt(tx, tx.indexOf("|"));
  assert.equal(ctx.barPosition, 0.75);
  assert.deepEqual(ctx.barAccidentals, { C5: 1 });
  assert.ok(T.isFull(ctx));
});

test("accidentals follow the key and the bar", () => {
  const tx = "X:1\nM:4/4\nL:1/8\nK:D\nF2 =F";
  const ctx = T.contextAt(tx, tx.length);
  assert.equal(T.accidentalFor(ctx, "F", 4, 1), "^"); // natural earlier in the bar
  assert.equal(T.accidentalFor(ctx, "C", 5, 1), null); // C♯ is in the key
});

test("an edit keeps later notes in the bar sounding the same", () => {
  const H = "X:1\nL:1/4\nK:C\n";
  const t = H + "C D E F | F";
  const i = t.indexOf("E");
  const edited = t.slice(0, i) + "^F" + t.slice(i + 1);
  assert.equal(T.keepBarPitches(t, i + 1, edited, i + 2).slice(H.length), "C D ^F =F | F");
});

test("transposing parts spell like abcjs", () => {
  assert.equal(T.writtenKey("B", 2), "Db");
  assert.deepEqual(T.toWritten("B", 4, 0, T.transposition("B", 2)), { letter: "D", octave: 5, alter: -1 });
  assert.deepEqual(T.toWritten("F", 4, 1, T.transposition("G", 9)), { letter: "D", octave: 5, alter: 1 });
  assert.equal(T.transposeChord("Am7/G", -2, false), "Gm7/F");
});

test("chords move as a whole", () => {
  assert.equal(T.stepChord("[CEG]", 1), "[DFA]");
  assert.equal(T.stepChord("[^F,Ac]", -1), "[E,GB]");
});

test("hide title keeps offsets; hide tempo keeps Q:", () => {
  const abc = "X:1\nT:Title\nQ:1/4=90\nK:C\nC";
  assert.equal(T.hideTitle(abc).length, abc.length);
  assert.ok(!/^T:/m.test(T.hideTitle(abc)));
  assert.match(T.hideTempo(abc), /^X:1\n%%printtempo false\n/);
});
