#!/usr/bin/env node
// Fetch the third-party browser assets into <out> (default .vendor/):
//
//   vendor/abcjs-basic-min.js, abcjs-audio.css   from node_modules/abcjs
//   vendor/jquery.min.js                          from node_modules/jquery
//   vendor/xml2abc.js                             downloaded, checked by SHA-256
//   soundfont/acoustic_grand_piano-mp3/*.mp3      downloaded (the synth's default
//                                                 instrument; others are fetched
//                                                 from upstream at play time)
//
// Used by the Dockerfile and by local development (npm run vendor). Files
// already present are kept, so re-running is cheap.

import { createHash } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import zlib from "node:zlib";

const XML2ABC = {
  // xml2abc-js by Willem Vree, LGPL-3.0; only published as a zip.
  url: "https://wim.vree.org/js/xml2abc-js_122.zip",
  sha256: "77d9bdc3de053dcf773a381fea3022a0313cc25e48f30b8a78c3f0326589a11d",
  file: "xml2abc-js_122/xml2abc.js",
};
const SOUNDFONT = "https://paulrosen.github.io/midi-js-soundfonts/abcjs/acoustic_grand_piano-mp3";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const out = path.resolve(process.argv[2] || path.join(root, ".vendor"));
const require = createRequire(path.join(root, "package.json"));
const vendor = path.join(out, "vendor");
const piano = path.join(out, "soundfont", "acoustic_grand_piano-mp3");
fs.mkdirSync(vendor, { recursive: true });
fs.mkdirSync(piano, { recursive: true });

const moduleDir = (name) => path.dirname(require.resolve(`${name}/package.json`));
function copy(from, to) {
  fs.copyFileSync(from, to);
  console.log("copied    ", path.relative(root, to));
}

// abcjs and jQuery come from node_modules (versions pinned in package-lock.json).
const abcjs = moduleDir("abcjs");
copy(path.join(abcjs, "dist", "abcjs-basic-min.js"), path.join(vendor, "abcjs-basic-min.js"));
copy(path.join(abcjs, "abcjs-audio.css"), path.join(vendor, "abcjs-audio.css"));
copy(path.join(abcjs, "LICENSE.md"), path.join(vendor, "abcjs-LICENSE.md"));
const jquery = moduleDir("jquery");
copy(path.join(jquery, "dist", "jquery.min.js"), path.join(vendor, "jquery.min.js"));

async function download(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} for ${url}`);
  return Buffer.from(await res.arrayBuffer());
}

// Just enough of a zip reader for one file: central directory, then deflate.
function unzipOne(buf, name) {
  let eocd = buf.length - 22;
  while (eocd >= 0 && buf.readUInt32LE(eocd) !== 0x06054b50) eocd--;
  if (eocd < 0) throw new Error("not a zip file");
  let p = buf.readUInt32LE(eocd + 16);
  for (let n = buf.readUInt16LE(eocd + 10); n > 0; n--) {
    const method = buf.readUInt16LE(p + 10);
    const size = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const skip = nameLen + buf.readUInt16LE(p + 30) + buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    if (buf.toString("utf8", p + 46, p + 46 + nameLen) === name) {
      const at = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
      const data = buf.subarray(at, at + size);
      return method === 8 ? zlib.inflateRawSync(data) : data;
    }
    p += 46 + skip;
  }
  throw new Error(`${name} not found in zip`);
}

const xml2abcOut = path.join(vendor, "xml2abc.js");
if (!fs.existsSync(xml2abcOut)) {
  const zip = await download(XML2ABC.url);
  const hash = createHash("sha256").update(zip).digest("hex");
  if (hash !== XML2ABC.sha256) throw new Error(`xml2abc zip checksum mismatch: ${hash}`);
  fs.writeFileSync(xml2abcOut, unzipOne(zip, XML2ABC.file));
  console.log("downloaded", path.relative(root, xml2abcOut));
}

// The note names abcjs will ask for; ones outside the piano's range simply
// don't exist upstream and are skipped.
const names = [...new Set(Object.values(require(path.join(abcjs, "src", "synth", "pitch-to-note-name.js"))))];
let fetched = 0, have = 0, missing = 0;
await Promise.all(Array.from({ length: 8 }, async (_, worker) => {
  for (let i = worker; i < names.length; i += 8) {
    const file = path.join(piano, names[i] + ".mp3");
    if (fs.existsSync(file)) { have++; continue; }
    const res = await fetch(`${SOUNDFONT}/${names[i]}.mp3`);
    if (!res.ok) { missing++; continue; }
    fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
    fetched++;
  }
}));
const total = fetched + have;
console.log(`soundfont  ${total} piano notes (${fetched} downloaded, ${have} already there, ${missing} outside the range)`);
if (total < 80) throw new Error("too few soundfont notes; is the network reachable?");
