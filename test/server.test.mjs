// Starts the real server on a random port with an empty database and a
// tiny image cache, and talks to it the way a proxy and a browser would.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { encode } from "../site/codec.js";

const root = path.resolve(import.meta.dirname, "..");
let child, base;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "abcroche-test-"));

before(async () => {
  child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", "server.mjs"], {
    cwd: root,
    env: { ...process.env, PORT: "0", DATA_DIR: dataDir, IMAGE_CACHE_MAX_FILES: "6", DEV_USER: "" },
    stdio: ["ignore", "pipe", "inherit"],
  });
  base = await new Promise((resolve, reject) => {
    child.on("exit", (code) => reject(new Error(`server exited (${code})`)));
    child.stdout.on("data", (d) => {
      const m = String(d).match(/on :(\d+)/);
      if (m) resolve(`http://127.0.0.1:${m[1]}`);
    });
  });
});
after(() => {
  child.kill();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const USER = { "Remote-User": "alice", "Remote-Name": "Alice" };
const XHR = { "X-Requested-With": "XMLHttpRequest", "Content-Type": "application/json" };
const put = (id, body, headers = { ...USER, ...XHR }) =>
  fetch(`${base}/api/songs/${id}`, { method: "PUT", headers, body: JSON.stringify(body) });
const ABC = "X:1\nT:Test Tune\nC:Trad.\nM:4/4\nL:1/8\nK:D\nDEFG ABcd|";

test("site: health, page headers, no framing restrictions", async () => {
  assert.equal(await (await fetch(`${base}/healthz`)).text(), "ok\n");
  const r = await fetch(`${base}/`);
  assert.equal(r.status, 200);
  assert.match(r.headers.get("content-security-policy"), /default-src 'self'/);
  assert.equal(r.headers.get("x-frame-options"), null);
});

test("static files stay inside their folders", async () => {
  for (const p of ["/%2e%2e/package.json", "/vendor/..%2f..%2fpackage.json", "/a%00.js"]) {
    assert.equal((await fetch(base + p)).status, 404, p);
  }
});

test("the song store needs the proxy's user header", async () => {
  assert.equal((await fetch(`${base}/api/songs`)).status, 401);
  assert.equal((await fetch(`${base}/api/me`, { headers: USER })).status, 200);
  assert.equal((await put("x", { abc: ABC }, { ...USER, "Content-Type": "application/json" })).status, 400); // no X-Requested-With
  assert.equal((await put("x", { abc: ABC }, XHR)).status, 401);
});

test("save, conflict, overwrite, read, list", async () => {
  assert.equal((await put("test-tune", { abc: ABC, title: "Test Tune" })).status, 201);
  assert.equal((await put("test-tune", { abc: ABC + "e", title: "Test Tune" })).status, 409);
  assert.equal((await put("test-tune", { abc: ABC + "e", title: "Test Tune", overwrite: true })).status, 200);
  const song = await (await fetch(`${base}/api/songs/test-tune`)).json(); // public
  assert.equal(song.abc, ABC + "e");
  const list = await (await fetch(`${base}/api/songs`, { headers: USER })).json();
  assert.deepEqual(list.map((s) => [s.id, s.key, s.meter, s.updated_by]), [["test-tune", "D", "4/4", "alice"]]);
});

test("tune pages carry previews", async () => {
  const html = await (await fetch(`${base}/s/test-tune?tr=bb`)).text();
  assert.match(html, /<title>Test Tune<\/title>/);
  assert.match(html, /og:image" content="http:\/\/127\.0\.0\.1:\d+\/s\/test-tune\.png\?tr=bb"/);
  assert.match(html, /og:description" content="Trad\. · Key of D · 4\/4"/);
  const packed = await encode(ABC);
  assert.match(await (await fetch(`${base}/t/${packed}`)).text(), /og:title" content="Test Tune"/);
});

test("images: SVG and PNG, cached, and capped", async () => {
  const svg = await fetch(`${base}/s/test-tune.svg`);
  assert.equal(svg.headers.get("content-type"), "image/svg+xml; charset=utf-8");
  assert.match(await svg.text(), /<svg[^>]*viewBox/);
  const png = Buffer.from(await (await fetch(`${base}/s/test-tune.png`)).arrayBuffer());
  assert.deepEqual([...png.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47]);
  assert.match((await fetch(`${base}/s/test-tune.png`)).headers.get("content-disposition"), /filename="Test Tune\.png"/);

  // The cache holds 6 here. Already cached: the two preview PNGs from the
  // page test and the SVG and PNG above; so two new tunes fit, not three.
  const tunes = await Promise.all(["C", "E", "G"].map((n) => encode(`X:1\nK:C\n${n}4|`)));
  const codes = [];
  for (const t of tunes) codes.push((await fetch(`${base}/t/${t}.svg`)).status);
  assert.deepEqual(codes, [200, 200, 503]);
  assert.equal((await fetch(`${base}/t/${tunes[0]}.svg`)).status, 200); // cached still served
  assert.equal((await fetch(`${base}/s/test-tune.svg?width=400`)).status, 200); // saved songs render uncached
  assert.equal((await fetch(`${base}/t/not-packed.png`)).status, 400);
});

test("delete", async () => {
  const r = await fetch(`${base}/api/songs/test-tune`, { method: "DELETE", headers: { ...USER, ...XHR } });
  assert.equal(r.status, 204);
  assert.equal((await fetch(`${base}/api/songs/test-tune`)).status, 404);
});
