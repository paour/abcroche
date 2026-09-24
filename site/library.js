// The editor's tune library, kept in this browser's localStorage.
//
// Per-browser by design: nothing is sent to the server. Every call tolerates
// storage being unavailable (private windows, blocked site data) and reports
// it rather than throwing, so the editor keeps working unsaved.

const KEY = "abc-library-v1";

export function available() {
  try {
    localStorage.setItem(KEY + "-probe", "1");
    localStorage.removeItem(KEY + "-probe");
    return true;
  } catch (e) {
    return false;
  }
}

// [{ id, title, abc, created, updated }], most recently updated first.
export function list() {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || "[]");
    return (Array.isArray(raw) ? raw : [])
      .filter((t) => t && typeof t.id === "string" && typeof t.abc === "string")
      .sort((a, b) => b.updated - a.updated);
  } catch (e) {
    return [];
  }
}

export function get(id) {
  return list().find((t) => t.id === id) || null;
}

function write(tunes) {
  try {
    localStorage.setItem(KEY, JSON.stringify(tunes));
    return { ok: true };
  } catch (e) {
    const full = e && (e.name === "QuotaExceededError" || e.code === 22);
    return { ok: false, reason: full ? "full" : "unavailable" };
  }
}

// Insert or update; returns { ok, reason? }.
export function save(tune) {
  const tunes = list();
  const now = Date.now();
  const i = tunes.findIndex((t) => t.id === tune.id);
  if (i >= 0) tunes[i] = { ...tunes[i], ...tune, updated: now };
  else tunes.push({ created: now, ...tune, updated: now });
  return write(tunes);
}

export function remove(id) {
  return write(list().filter((t) => t.id !== id));
}

export function newId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

// Fires when another tab changes the library.
export function onExternalChange(fn) {
  window.addEventListener("storage", (e) => { if (e.key === KEY) fn(); });
}
