import assert from "node:assert/strict";
import { test } from "node:test";
import * as S from "../site/share.js";

test("options round-trip through the query string", () => {
  const q = new URLSearchParams("scale=1.5&width=500&play=1&bg=transparent&tr=eb&oct=-1&title=0&tempo=0&editbtn=1");
  const o = S.readOptions(q);
  assert.equal(o.transpose, -3);
  assert.equal(S.optionsQuery(o).toString(), q.toString());
  assert.equal(S.optionsQuery(o, { image: true }).toString(), "scale=1.5&width=500&bg=transparent&tr=eb&oct=-1&title=0&tempo=0");
});

test("octave shifts, including older low=1 links", () => {
  assert.equal(S.readOptions(new URLSearchParams("oct=1")).transpose, 12);
  assert.equal(S.readOptions(new URLSearchParams("tr=bb&oct=1")).transpose, 14);
  assert.equal(S.readOptions(new URLSearchParams("tr=bb&low=1")).transpose, -10);
  assert.equal(S.readOptions(new URLSearchParams("tr=bb&low=1")).oct, -1);
  // "As shown" follows the editor's own ↓8ve; an explicit choice overrides it.
  assert.equal(S.linkOptions(S.defaultShare(), { tr: "eb", low: true }).transpose, -3);
  assert.equal(S.linkOptions({ ...S.defaultShare(), octave: "1" }, { tr: "eb", low: true }).transpose, 21);
  assert.equal(S.linkOptions({ ...S.defaultShare(), octave: "0" }, { tr: "eb", low: true }).transpose, 9);
});

test("links: pages and images, by name or packed", () => {
  const share = { ...S.defaultShare(), play: true };
  const o = S.linkOptions(share, { tr: "bb", low: false });
  assert.equal(S.shareUrl("https://x", share, o, { packed: "~abc" }), "https://x/t/~abc?play=1&tr=bb");
  const img = { ...share, link: "svg" };
  assert.equal(S.shareUrl("https://x", img, S.linkOptions(img, {}), { name: "my-song" }), "https://x/s/my-song.svg");
});

test("the editor's panel survives its own URL", () => {
  for (const extra of [{ part: "bb", octave: "-1" }, { part: "", octave: "1" }, { part: "c", octave: "0" }, { part: "eb", octave: "" }]) {
    const share = { ...S.defaultShare(), link: "png", title: false, scale: 2, ...extra };
    assert.deepEqual(S.shareFromParams(S.shareQuery(share)), share);
  }
});

test("short display keeps both ends", () => {
  const url = "https://x/t/~" + "a".repeat(80) + "zzzzzzzzzz.png?tr=bb";
  assert.match(S.shortUrl(url), /^https:\/\/x\/t\/~a{13}…a*z+\.png\?tr=bb$/);
});
