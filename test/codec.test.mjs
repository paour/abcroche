import assert from "node:assert/strict";
import { test } from "node:test";
import { decode, encode } from "../site/codec.js";

test("round trip, compressed", async () => {
  const abc = "X:1\nT:Café ♪\nK:G\n|:GABc dedB|dedB dedB:|\n".repeat(5);
  const packed = await encode(abc);
  assert.match(packed, /^~[A-Za-z0-9_-]+$/);
  assert.ok(packed.length < abc.length);
  assert.equal(await decode(packed), abc);
});

test("only packed tunes are accepted", async () => {
  await assert.rejects(decode("X:1%0AK:C%0AC"));
  await assert.rejects(decode("~!!"));
  assert.equal(await decode(""), "");
});
