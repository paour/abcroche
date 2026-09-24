// MusicXML -> ABC, entirely in the browser, via xml2abc-js (which needs
// jQuery). Both are loaded on first use only, so view mode never pays for them.

let loading = null;

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = src;
    s.onload = resolve;
    s.onerror = () => reject(new Error("Couldn't load " + src));
    document.head.appendChild(s);
  });
}

function loadConverter() {
  if (!loading) {
    loading = loadScript("/vendor/jquery.min.js")
      .then(() => loadScript("/vendor/xml2abc.js"))
      .catch((e) => { loading = null; throw e; });
  }
  return loading;
}

// --- .mxl: a zip holding the MusicXML -----------------------------------------

async function inflate(bytes) {
  const out = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(out).arrayBuffer());
}

async function unzip(buffer) {
  const view = new DataView(buffer);
  let eocd = -1;
  for (let i = buffer.byteLength - 22; i >= Math.max(0, buffer.byteLength - 65557); i--) {
    if (view.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("Not a valid .mxl (zip) file");
  const count = view.getUint16(eocd + 10, true);
  let p = view.getUint32(eocd + 16, true);
  const files = {};
  const utf8 = new TextDecoder();
  for (let n = 0; n < count; n++) {
    if (view.getUint32(p, true) !== 0x02014b50) throw new Error("Corrupt .mxl file");
    const method = view.getUint16(p + 10, true);
    const size = view.getUint32(p + 20, true);
    const nameLen = view.getUint16(p + 28, true);
    const extraLen = view.getUint16(p + 30, true);
    const commentLen = view.getUint16(p + 32, true);
    const local = view.getUint32(p + 42, true);
    const name = utf8.decode(new Uint8Array(buffer, p + 46, nameLen));
    const dataAt = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
    files[name] = { method, data: new Uint8Array(buffer, dataAt, size) };
    p += 46 + nameLen + extraLen + commentLen;
  }
  return async (name) => {
    const f = files[name];
    if (!f) return null;
    if (f.method === 0) return f.data;
    if (f.method === 8) return inflate(f.data);
    throw new Error("Unsupported compression in .mxl");
  };
}

async function mxlToXml(buffer) {
  const read = await unzip(buffer);
  const text = (bytes) => new TextDecoder().decode(bytes);
  const container = await read("META-INF/container.xml");
  let path = null;
  if (container) {
    const doc = new DOMParser().parseFromString(text(container), "application/xml");
    const root = doc.querySelector("rootfile");
    path = root && root.getAttribute("full-path");
  }
  const bytes = path && (await read(path));
  if (!bytes) throw new Error("No MusicXML score inside this .mxl");
  return text(bytes);
}

// --- Conversion -------------------------------------------------------------------

export async function importFile(file) {
  const buffer = await file.arrayBuffer();
  const head = new Uint8Array(buffer, 0, Math.min(4, buffer.byteLength));
  const isZip = head[0] === 0x50 && head[1] === 0x4b; // "PK"
  const xml = isZip ? await mxlToXml(buffer) : new TextDecoder().decode(buffer);

  const doc = new DOMParser().parseFromString(xml, "application/xml");
  if (doc.querySelector("parsererror")) throw new Error("This file isn't valid XML");
  if (!doc.querySelector("score-partwise, score-timewise")) {
    throw new Error("This doesn't look like a MusicXML score");
  }
  if (doc.querySelector("score-timewise") && !doc.querySelector("score-partwise")) {
    throw new Error("Timewise MusicXML isn't supported; export as partwise (MuseScore's default)");
  }

  await loadConverter();
  // b: 4 bars per line, x: 1 = no "$" system-break markers. abcjs doesn't
  //    understand "I:linebreak $", and real newlines keep w: lyrics aligned.
  // m: 1 = keep each part's MIDI instrument, so playback sounds right
  // p: "" = don't translate page size/margins; the embed sizes itself
  const opts = { b: 4, x: 1, m: 1, p: "" };
  const [abc, log] = window.vertaal(doc, opts);
  if (!abc || !/\bK:/.test(abc)) throw new Error("No notes found in this score" + (log ? ":\n" + log : ""));
  return { abc: abc.replace(/\s+$/, "") + "\n", log };
}
