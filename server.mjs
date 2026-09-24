// abcroche: a tiny ABC-notation score server.
//
// One Node process serves:
//   the site      site/ (the viewer and editor), plus third-party browser
//                 assets fetched by scripts/vendor.mjs (abcjs, jQuery,
//                 xml2abc, a piano soundfont)
//   tune pages    /s/<song> (a saved song, latest version) and /t/<tune> (a
//                 tune packed into the path, see site/codec.js), with a
//                 <title> and Open Graph / Twitter tags so pasted links
//                 unfurl with the score
//   images        …/<song|tune>.svg|.png, rendered server-side (render.mjs)
//   a song store  ABC text + a little metadata in SQLite, under /api/
//
// Sign-in is delegated to a forward-auth reverse proxy (Authelia, Authentik,
// oauth2-proxy, …) that sets a user header (AUTH_USER_HEADER, default
// Remote-User). The proxy must route:
//   GET /api/songs/<id>    public (a shared, named song)
//   everything else /api/  through forward-auth
//   everything else        public
// and strip the user header on the public routes, since this server trusts
// it. The /api/ routes also refuse requests without it, and mutating
// requests must carry X-Requested-With, which forces a CORS preflight for
// any cross-site caller (and this server answers none).
//
// Configuration (environment): see README.md.

import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import zlib from "node:zlib";

const env = process.env;
const HERE = path.dirname(new URL(import.meta.url).pathname);
const PORT = Number(env.PORT || 8000);
const DATA_DIR = path.resolve(env.DATA_DIR || path.join(HERE, "data"));
const DB_PATH = path.resolve(env.DB_PATH || path.join(DATA_DIR, "songs.db"));
// Static files are looked up in the app first, then in the vendored assets.
const PUBLIC = path.resolve(env.PUBLIC_DIR || path.join(HERE, "site"));
const VENDOR = path.resolve(env.VENDOR_DIR || path.join(HERE, ".vendor"));
const STATIC_ROOTS = [PUBLIC, VENDOR];
// Absolute URLs in link previews. Unset: taken from each request's Host.
const PUBLIC_URL = (env.PUBLIC_URL || "").replace(/\/$/, "");
const AUTH_USER_HEADER = (env.AUTH_USER_HEADER || "Remote-User").toLowerCase();
const AUTH_NAME_HEADER = (env.AUTH_NAME_HEADER || "Remote-Name").toLowerCase();
// Local development only: act as if the proxy had signed this user in.
const DEV_USER = env.DEV_USER || "";

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

// The page's own helpers (pure, DOM-free): the same URL decoding and the
// same title/tempo/transposition handling as the browser.
const Text = await import(pathToFileURL(path.join(PUBLIC, "abc-text.js")).href);
const Codec = await import(pathToFileURL(path.join(PUBLIC, "codec.js")).href);
const Share = await import(pathToFileURL(path.join(PUBLIC, "share.js")).href);
const Render = await import("./render.mjs");
const MAX_ABC = 256 * 1024;
const ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SONG_PATH = /^\/api\/songs\/([^/]+)$/;

const db = new DatabaseSync(DB_PATH);
db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
db.exec(`CREATE TABLE IF NOT EXISTS songs (
  id          TEXT PRIMARY KEY,
  title       TEXT NOT NULL,
  composer    TEXT NOT NULL DEFAULT '',
  abc         TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  created_by  TEXT NOT NULL,
  updated_by  TEXT NOT NULL
)`);

const q = {
  list: db.prepare("SELECT * FROM songs ORDER BY updated_at DESC"),
  get: db.prepare("SELECT * FROM songs WHERE id = ?"),
  upsert: db.prepare(`INSERT INTO songs (id, title, composer, abc, created_at, updated_at, created_by, updated_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET title = excluded.title, composer = excluded.composer,
      abc = excluded.abc, updated_at = excluded.updated_at, updated_by = excluded.updated_by`),
  remove: db.prepare("DELETE FROM songs WHERE id = ?"),
};

// Header field from the ABC text, for the list ("K:G clef=bass" -> "G").
const field = (abc, f) => ((abc || "").match(new RegExp("^" + f + ":\\s*(\\S+)", "m")) || [])[1] || "";

const songs = q; // the prepared statements, by a name that doesn't clash below

const summary = ({ id, title, composer, abc, created_at, updated_at, updated_by }) =>
  ({ id, title, composer, key: field(abc, "K"), meter: field(abc, "M"), created_at, updated_at, updated_by });

// --- plumbing -------------------------------------------------------------------

function send(res, status, body) {
  const data = body === undefined ? "" : JSON.stringify(body);
  res.writeHead(status, {
    ...SECURITY_HEADERS,
    ...(body === undefined ? {} : { "Content-Type": "application/json; charset=utf-8" }),
    "Content-Length": Buffer.byteLength(data),
    "Cache-Control": "no-cache",
  });
  res.end(res.req.method === "HEAD" ? undefined : data);
}

const fail = (res, status, message) => send(res, status, { error: message });

const userOf = (req) => DEV_USER || String(req.headers[AUTH_USER_HEADER] || "").trim();

function readJson(req) {
  return new Promise((resolve, reject) => {
    if (!String(req.headers["content-type"] || "").includes("application/json")) {
      return reject(new Error("Expected JSON"));
    }
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_ABC + 4096) { reject(new Error("Too large")); req.destroy(); }
      else chunks.push(c);
    });
    req.on("end", () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}")); }
      catch { reject(new Error("Invalid JSON")); }
    });
    req.on("error", reject);
  });
}

// --- routes -------------------------------------------------------------------------

async function handle(req, res) {
  const path = new URL(req.url, "http://x").pathname;
  const method = req.method === "HEAD" ? "GET" : req.method;
  const user = userOf(req);
  const song = path.match(SONG_PATH);

  if (method === "GET" && path === "/api/health") return send(res, 200, { ok: true });

  // Public: one song by id.
  if (method === "GET" && song) {
    const row = q.get.get(song[1]);
    return row ? send(res, 200, { ...summary(row), abc: row.abc }) : fail(res, 404, "No such song");
  }

  // Everything below needs a signed-in user.
  if (!user) return fail(res, 401, "Sign in required");

  // A page link to here goes through the proxy's login page (forward-auth
  // proxies redirect page loads, and answer background requests with 401)
  // and then comes back.
  if (method === "GET" && path === "/api/login") {
    const next = new URL(req.url, "http://x").searchParams.get("next") || "/?edit";
    // Same-site paths only: no "//host" or "/\\host" (browsers treat both as off-site).
    const safe = /^\/(?![\/\\])/.test(next) ? next : "/?edit";
    res.writeHead(302, { Location: safe, "Cache-Control": "no-store" });
    return res.end();
  }
  if (method === "GET" && path === "/api/me") {
    return send(res, 200, { user, name: String(req.headers[AUTH_NAME_HEADER] || user) });
  }
  if (method === "GET" && path === "/api/songs") return send(res, 200, q.list.all().map(summary));

  if ((method === "PUT" || method === "DELETE") && song) {
    if (req.headers["x-requested-with"] !== "XMLHttpRequest") return fail(res, 400, "Missing X-Requested-With");
    const id = song[1];

    if (method === "DELETE") {
      return q.remove.run(id).changes ? send(res, 204) : fail(res, 404, "No such song");
    }

    if (id.length > 80 || !ID_RE.test(id)) return fail(res, 400, "Invalid id");
    let body;
    try { body = await readJson(req); } catch (e) { return fail(res, 400, e.message); }
    const { abc } = body;
    if (typeof abc !== "string" || !abc.trim() || abc.length > MAX_ABC) {
      return fail(res, 400, "abc must be a non-empty string under 256 KB");
    }
    const existing = q.get.get(id);
    // Same id from a different tune: make the client confirm first.
    if (existing && !body.overwrite && existing.abc !== abc) {
      return send(res, 409, { error: "exists", song: summary(existing) });
    }
    const now = Date.now();
    q.upsert.run(id, String(body.title || id).slice(0, 200), String(body.composer || "").slice(0, 200),
      abc, now, now, user, user);
    return send(res, existing ? 200 : 201, summary(q.get.get(id)));
  }

  return fail(res, 404, "Not found");
}

// --- static site ---------------------------------------------------------------------

// Being embedded in other sites is the point: no X-Frame-Options and no
// frame-ancestors. The CSP only pins where scripts and sounds may come from.
const SECURITY_HEADERS = {
  "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
    "img-src 'self' data: blob:; media-src 'self' blob: data:; connect-src 'self' https://paulrosen.github.io; " +
    "base-uri 'none'; form-action 'none'",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
};

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".mp3": "audio/mpeg",
};
const COMPRESSIBLE = new Set([".html", ".js", ".css", ".json", ".md", ".svg"]);

// Files are baked into the image, so each is read (and gzipped) once.
const cache = new Map();

function loadFile(file) {
  if (cache.has(file)) return cache.get(file);
  let entry = null;
  try {
    const stat = fs.statSync(file);
    if (stat.isFile()) {
      const body = fs.readFileSync(file);
      const ext = path.extname(file).toLowerCase();
      entry = {
        body,
        type: TYPES[ext] || "application/octet-stream",
        etag: '"' + crypto.createHash("sha1").update(body).digest("base64url").slice(0, 16) + '"',
        gz: COMPRESSIBLE.has(ext) && body.length > 1024 ? zlib.gzipSync(body, { level: 9 }) : null,
      };
    }
  } catch { /* missing: null */ }
  cache.set(file, entry);
  return entry;
}

// Long-lived for bundled third-party assets; everything else revalidates
// (ETag) so a redeploy shows up straight away.
const cacheControl = (p) =>
  p.startsWith("/vendor/") || p.startsWith("/soundfont/") ? "public, max-age=2592000" : "no-cache";

function serveStatic(req, res, pathname) {
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405, { ...SECURITY_HEADERS, Allow: "GET, HEAD" });
    return res.end();
  }
  if (pathname === "/healthz") {
    res.writeHead(200, { "Content-Type": "text/plain" });
    return res.end("ok\n");
  }
  let rel;
  try { rel = decodeURIComponent(pathname); } catch { rel = null; }
  let entry = null;
  if (rel && !rel.includes("\0")) {
    for (const root of STATIC_ROOTS) {
      const file = path.join(root, rel === "/" ? "index.html" : rel);
      // path.join resolves ".."; anything that lands outside the root is refused.
      if (file.startsWith(root + path.sep) && (entry = loadFile(file))) break;
    }
  }

  if (!entry) {
    // Only the piano soundfont is bundled; other instruments come from
    // upstream (GitHub Pages sends Access-Control-Allow-Origin: *).
    if (pathname.startsWith("/soundfont/")) {
      res.writeHead(302, {
        ...SECURITY_HEADERS,
        Location: "https://paulrosen.github.io/midi-js-soundfonts/abcjs/" + pathname.slice("/soundfont/".length),
      });
      return res.end();
    }
    res.writeHead(404, { ...SECURITY_HEADERS, "Content-Type": "text/plain; charset=utf-8" });
    return res.end("Not found\n");
  }

  const headers = {
    ...SECURITY_HEADERS,
    "Content-Type": entry.type,
    "Cache-Control": cacheControl(pathname),
    ETag: entry.etag,
    Vary: "Accept-Encoding",
  };
  if (req.headers["if-none-match"] === entry.etag) {
    res.writeHead(304, headers);
    return res.end();
  }
  const gzip = entry.gz && /\bgzip\b/.test(req.headers["accept-encoding"] || "");
  const body = gzip ? entry.gz : entry.body;
  if (gzip) headers["Content-Encoding"] = "gzip";
  headers["Content-Length"] = body.length;
  res.writeHead(200, headers);
  res.end(req.method === "HEAD" ? undefined : body);
}

// --- images: server-side rendering ---------------------------------------------------

function contentDisposition(title, ext) {
  const name = String(title).replace(/[\u0000-\u001f"\\/]/g, "").trim().slice(0, 100) || "score";
  const ascii = name.normalize("NFKD").replace(/[^\x20-\x7e]/g, "") || "score";
  return `inline; filename="${ascii}.${ext}"; filename*=UTF-8''${encodeURIComponent(name)}.${ext}`;
}

// Same query options as embeds, where they make sense for a picture.
// Parsed by share.js, the page's own parser, so pages and images agree;
// sizes are clamped here since images are rendered on the server.
function imageOptions(params) {
  const o = Share.readOptions(params);
  const clamp = (v, lo, hi) => (v == null ? null : Math.min(hi, Math.max(lo, v)));
  return {
    scale: clamp(o.scale, 0.3, 4) || 1,
    staffwidth: clamp(o.width, 200, 2000),
    transpose: o.transpose,
    title: o.showTitle,
    tempo: o.showTempo,
    transparent: o.transparent,
  };
}

// Rendered images, kept in memory until restart. /t/ links let anyone ask
// for renders of arbitrary tunes, so the cache is capped (by count and by
// size, whichever comes first) and never evicts: once full, a /t/ tune that
// isn't cached yet is refused rather than rendered. Saved songs (/s/, only
// created by signed-in users) still render when it's full, just uncached.
// A restart empties it.
const images = new Map();
const IMAGE_CACHE_MAX_FILES = Number(process.env.IMAGE_CACHE_MAX_FILES || 10000);
const IMAGE_CACHE_MAX_BYTES = Number(process.env.IMAGE_CACHE_MAX_BYTES || 1024 ** 3);
let imageBytes = 0;
let imageCacheFullLogged = false;

const imageCacheFull = () => images.size >= IMAGE_CACHE_MAX_FILES || imageBytes >= IMAGE_CACHE_MAX_BYTES;

// A tune from a saved song (s) or from a link (t):
// { abc, title, version, row? } or { status, message }.
async function loadTune(kind, key) {
  if (kind === "s") {
    const row = songs.get.get(key);
    if (!row) return { status: 404, message: "No such song" };
    return { abc: row.abc, title: row.title, version: row.updated_at, row };
  }
  if (key.length > 32768) return { status: 414, message: "Tune too long for a link" };
  let abc;
  try { abc = await Codec.decode(key); } catch { return { status: 400, message: "Couldn't decode this tune" }; }
  if (!abc || !abc.trim() || abc.length > MAX_ABC) return { status: 400, message: "Empty or oversized tune" };
  return { abc, title: Text.getField(abc, "T") || "Untitled tune", version: "" };
}

// { entry } or { status, message }.
async function getImage(kind, key, format, params) {
  const tune = await loadTune(kind, key);
  if (!tune.abc) return tune;
  const { abc, version } = tune;

  const o = imageOptions(params);
  const cacheKey = JSON.stringify([kind, key, version, format, o]);
  let entry = images.get(cacheKey);
  if (!entry) {
    const full = imageCacheFull();
    if (full && !imageCacheFullLogged) {
      imageCacheFullLogged = true;
      console.log(`image cache full: ${images.size} images, ${Math.round(imageBytes / 1048576)} MiB; no new /t/ renders until restart`);
    }
    if (full && kind === "t") return { status: 503, message: "Image cache is full; this tune can't be rendered right now." };
    let text = abc;
    if (!o.title) text = Text.hideTitle(text);
    if (!o.tempo) text = Text.hideTempo(text);
    const r = Render.renderSvg(text, o);
    if (!r) return { status: 422, message: "Nothing to draw" };
    const body = format === "svg" ? Buffer.from(r.svg) : Render.renderPng(r.svg, { density: 2 });
    entry = {
      body,
      gz: format === "svg" ? zlib.gzipSync(body, { level: 9 }) : null,
      type: format === "svg" ? "image/svg+xml; charset=utf-8" : "image/png",
      etag: '"' + crypto.createHash("sha1").update(body).digest("base64url").slice(0, 16) + '"',
      width: format === "svg" ? r.width : r.width * 2,
      height: format === "svg" ? r.height : r.height * 2,
      // Link previewers use a file's name as its title.
      disposition: contentDisposition(tune.title, format),
    };
    const size = entry.body.length + (entry.gz ? entry.gz.length : 0);
    if (!full && imageBytes + size <= IMAGE_CACHE_MAX_BYTES) {
      images.set(cacheKey, entry);
      imageBytes += size;
    }
  }
  return { entry };
}

function sendEntry(req, res, entry, headers) {
  const h = { ...SECURITY_HEADERS, ...headers, "Content-Type": entry.type, ETag: entry.etag, Vary: "Accept-Encoding" };
  if (entry.disposition) h["Content-Disposition"] = entry.disposition;
  if (req.headers["if-none-match"] === entry.etag) {
    res.writeHead(304, h);
    return res.end();
  }
  const gzip = entry.gz && /\bgzip\b/.test(req.headers["accept-encoding"] || "");
  const body = gzip ? entry.gz : entry.body;
  if (gzip) h["Content-Encoding"] = "gzip";
  h["Content-Length"] = body.length;
  res.writeHead(200, h);
  res.end(req.method === "HEAD" ? undefined : body);
}

async function serveImage(req, res, kind, key, format, params) {
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405, { ...SECURITY_HEADERS, Allow: "GET, HEAD" });
    return res.end();
  }
  const { entry, status, message } = await getImage(kind, key, format, params);
  if (!entry) {
    res.writeHead(status, { ...SECURITY_HEADERS, "Content-Type": "text/plain; charset=utf-8" });
    return res.end(message + "\n");
  }
  // A /t/ image is its own content; a saved song can change, so it's only
  // kept briefly (and revalidated by ETag).
  sendEntry(req, res, entry, {
    "Cache-Control": kind === "t" ? "public, max-age=31536000, immutable" : "public, max-age=300",
  });
}

// --- tune pages with link previews (Open Graph / Twitter) -----------------------------

const esc = (v) => String(v).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

// Absolute base URL for previews: PUBLIC_URL, else this request's origin.
function baseUrl(req) {
  if (PUBLIC_URL) return PUBLIC_URL;
  const proto = String(req.headers["x-forwarded-proto"] || "http").split(",")[0].trim();
  return `${proto}://${req.headers.host || "localhost"}`;
}

async function previewTags(kind, key, params, base) {
  const tune = await loadTune(kind, key);
  if (!tune.abc) return null;
  // The preview image follows the link's own display options.
  const iq = new URLSearchParams();
  for (const k of ["tr", "low", "title", "tempo", "width"]) if (params.has(k)) iq.set(k, params.get(k));
  const image = `${base}/${kind}/${encodeURIComponent(key)}.png${iq.toString() ? "?" + iq : ""}`;
  const pageUrl = `${base}/${kind}/${encodeURIComponent(key)}${params.toString() ? "?" + params : ""}`;
  const { entry } = await getImage(kind, key, "png", iq);
  const k = Text.splitKey(Text.getField(tune.abc, "K") || "").key;
  const composer = (tune.row && tune.row.composer) || Text.getField(tune.abc, "C");
  const description = [composer, k && "Key of " + k, Text.getField(tune.abc, "M")].filter(Boolean).join(" · ") || "Sheet music";
  return {
    title: tune.title,
    tags: [
      `<meta name="description" content="${esc(description)}">`,
      `<meta property="og:type" content="website">`,
      `<meta property="og:site_name" content="${esc(new URL(base).host)}">`,
      `<meta property="og:title" content="${esc(tune.title)}">`,
      `<meta property="og:description" content="${esc(description)}">`,
      `<meta property="og:url" content="${esc(pageUrl)}">`,
      `<meta property="og:image" content="${esc(image)}">`,
      `<meta property="og:image:type" content="image/png">`,
      ...(entry ? [`<meta property="og:image:width" content="${entry.width}">`, `<meta property="og:image:height" content="${entry.height}">`] : []),
      `<meta property="og:image:alt" content="${esc("Sheet music for " + tune.title)}">`,
      `<meta name="twitter:card" content="summary_large_image">`,
      `<meta name="twitter:title" content="${esc(tune.title)}">`,
      `<meta name="twitter:description" content="${esc(description)}">`,
      `<meta name="twitter:image" content="${esc(image)}">`,
    ].join("\n"),
  };
}

// index.html, with the tune's title and preview tags in the head. The page's
// own script then reads the tune from the same URL.
async function servePreviewPage(req, res, kind, key, params) {
  const page = loadFile(path.join(PUBLIC, "index.html"));
  const preview = await previewTags(kind, key, params, baseUrl(req));
  if (!page || !preview) return serveStatic(req, res, "/");
  const html = page.body.toString("utf8")
    .replace(/<title>[^<]*<\/title>/, `<title>${esc(preview.title)}</title>`)
    .replace("</head>", preview.tags + "\n</head>");
  const body = Buffer.from(html);
  sendEntry(req, res, {
    body,
    gz: zlib.gzipSync(body),
    type: "text/html; charset=utf-8",
    etag: '"' + crypto.createHash("sha1").update(body).digest("base64url").slice(0, 16) + '"',
  }, { "Cache-Control": "no-cache" });
}

// --- server ---------------------------------------------------------------------------

const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  const pathname = url.pathname;
  const oops = (e) => { console.error(e); if (!res.headersSent) fail(res, 500, "Server error"); };
  const img = pathname.match(/^\/([st])\/([^/]+)\.(svg|png)$/);
  if (img) return void serveImage(req, res, img[1], img[2], img[3], url.searchParams).catch(oops);
  const tunePage = pathname.match(/^\/([st])\/([^/.]+)$/);
  if (tunePage && (req.method === "GET" || req.method === "HEAD")) {
    return void servePreviewPage(req, res, tunePage[1], tunePage[2], url.searchParams).catch(oops);
  }
  if (!pathname.startsWith("/api/")) {
    try { serveStatic(req, res, pathname); } catch (e) { oops(e); }
    return;
  }
  handle(req, res).catch((e) => {
    console.error(e);
    if (!res.headersSent) fail(res, 500, "Server error");
  });
  res.on("finish", () => console.log(`${userOf(req) || "-"} ${req.method} ${req.url} ${res.statusCode}`));
});
server.listen(PORT, () => {
  console.log(`abcroche on :${server.address().port} (site ${PUBLIC}, vendor ${VENDOR}, db ${DB_PATH})`);
  if (!fs.existsSync(path.join(VENDOR, "vendor", "abcjs-basic-min.js"))) {
    console.warn(`warning: no vendored assets in ${VENDOR}; run "npm run vendor" (pages need abcjs)`);
  }
  if (DEV_USER) console.warn(`warning: DEV_USER is set: every request is signed in as "${DEV_USER}". Local development only.`);
});
