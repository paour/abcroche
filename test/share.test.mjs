import assert from "node:assert/strict";
import { test } from "node:test";
import * as S from "../site/share.js";

test("options round-trip through the query string", () => {
  const q = new URLSearchParams("scale=1.5&width=500&play=1&bg=transparent&tr=eb&low=1&title=0&tempo=0&editbtn=1");
  const o = S.readOptions(q);
  assert.equal(o.transpose, -3);
  assert.equal(S.optionsQuery(o).toString(), q.toString());
  assert.equal(S.optionsQuery(o, { image: true }).toString(), "scale=1.5&width=500&bg=transparent&tr=eb&low=1&title=0&tempo=0");
});

test("links: pages and images, by name or packed", () => {
  const share = { ...S.defaultShare(), play: true };
  const o = S.linkOptions(share, { tr: "bb", low: false });
  assert.equal(S.shareUrl("https://x", share, o, { packed: "~abc" }), "https://x/t/~abc?play=1&tr=bb");
  const img = { ...share, link: "svg" };
  assert.equal(S.shareUrl("https://x", img, S.linkOptions(img, {}), { name: "my-song" }), "https://x/s/my-song.svg");
});

test("the editor's panel survives its own URL", () => {
  const share = { ...S.defaultShare(), link: "png", part: "bb-low", title: false, scale: 2 };
  assert.deepEqual(S.shareFromParams(S.shareQuery(share)), share);
});

test("short display keeps both ends", () => {
  const url = "https://x/t/~" + "a".repeat(80) + "zzzzzzzzzz.png?tr=bb";
  assert.match(S.shortUrl(url), /^https:\/\/x\/t\/~a{13}…a*z+\.png\?tr=bb$/);
});
