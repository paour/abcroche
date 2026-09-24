// A tune packed for a URL: compressed, then base64url, about 3x shorter
// than the raw ABC text.

function toBase64url(bytes) {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64url(s) {
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

async function pipe(bytes, stream) {
  const out = new Blob([bytes]).stream().pipeThrough(stream);
  return new Uint8Array(await new Response(out).arrayBuffer());
}

// Only the compressed form: "~" + base64url(deflate-raw(utf-8)). Used for
// /t/<tune> links, the editor's own #fragment, and by the server (server.mjs).
export async function encode(text) {
  const bytes = new TextEncoder().encode(text);
  return "~" + toBase64url(await pipe(bytes, new CompressionStream("deflate-raw")));
}

export async function decode(packed) {
  if (!packed) return "";
  if (!/^~[A-Za-z0-9_-]+$/.test(packed)) throw new Error("Not a packed tune");
  const bytes = await pipe(fromBase64url(packed.slice(1)), new DecompressionStream("deflate-raw"));
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}
