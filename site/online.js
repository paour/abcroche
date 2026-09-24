// Client for the song store (/api/, see server.mjs).
//
// Reading one song is public. Everything else goes through the sign-in
// (forward-auth) proxy, which answers these background requests with 401
// when nobody is signed in, so the page can quietly tell whether to offer
// online saving.

const XHR = { "X-Requested-With": "XMLHttpRequest", Accept: "application/json" };

async function call(method, path, body) {
  try {
    const res = await fetch(path, {
      method,
      credentials: "same-origin",
      headers: body ? { ...XHR, "Content-Type": "application/json" } : XHR,
      body: body ? JSON.stringify(body) : undefined,
    });
    let data = null;
    try { data = res.status === 204 ? null : await res.json(); } catch (e) { /* not JSON */ }
    return { ok: res.ok, status: res.status, data };
  } catch (e) {
    return { ok: false, status: 0, data: { error: "Network error" } };
  }
}

// { user, name } when signed in through the proxy, else null.
export async function me() {
  const r = await call("GET", "/api/me");
  return r.ok ? r.data : null;
}

export const list = () => call("GET", "/api/songs");
export const get = (id) => call("GET", "/api/songs/" + encodeURIComponent(id));
export const remove = (id) => call("DELETE", "/api/songs/" + encodeURIComponent(id));
export const save = (id, song, overwrite) =>
  call("PUT", "/api/songs/" + encodeURIComponent(id), { ...song, overwrite: !!overwrite });

// Goes through the proxy's login page and comes back to `next`.
export function signInUrl(next) {
  return "/api/login?next=" + encodeURIComponent(next);
}

// "Speed the Plough" -> "speed-the-plough"; "Café Noël" -> "cafe-noel".
export function slugify(title) {
  return String(title || "")
    .normalize("NFKD").replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80)
    .replace(/-+$/, "");
}
