/* ABC notation renderer and editor.
 *
 *   /t/<tune>        the score of a tune packed into the path (see codec.js)
 *   /s/<id>          the score of a song saved online (latest version)
 *   /?edit           the editor (its own URL keeps the tune in the #fragment)
 *
 * Page options are the query parameters in share.js. The same paths with
 * .png or .svg are server-rendered images, and the server gives these pages
 * a title and preview tags (server.mjs).
 */
import { decode } from "./codec.js";
import { Score } from "./score.js";
import { hideTitle, hideTempo } from "./abc-text.js";
import { readOptions } from "./share.js";
import * as Online from "./online.js";

function startView(params) {
  const opts = readOptions(params);
  if (opts.transparent) document.documentElement.classList.add("transparent");
  const score = new Score(document.getElementById("paper"), document.getElementById("audio"));
  const empty = document.getElementById("empty");

  const m = location.pathname.match(/^\/([st])\/([^/.]+)$/);
  const song = m && m[1] === "s" ? decodeURIComponent(m[2]) : null;
  const packed = m && m[1] === "t" ? m[2] : null;

  async function show() {
    let text = "";
    if (song) {
      const r = await Online.get(song);
      if (!r.ok) {
        empty.hidden = false;
        empty.textContent = r.status === 404 ? `No song called “${song}” here.` : "Couldn't load this song.";
        return;
      }
      text = r.data.abc;
    } else if (packed) {
      try { text = await decode(packed); } catch (e) {
        empty.hidden = false;
        empty.textContent = "This link doesn't contain a readable tune.";
        return;
      }
    }
    empty.hidden = text.trim() !== "";
    if (opts.editButton && text.trim()) showEditButton(song, packed);
    if (!opts.showTitle) text = hideTitle(text);
    if (!opts.showTempo) text = hideTempo(text);
    score.render(text, opts);
  }
  show();
}

// Embedded in another site the page can't see the proxy's sign-in
// (third-party frame), so this is shown to every viewer; saving online
// still needs one.
function showEditButton(song, packed) {
  let a = document.getElementById("edit-button");
  if (!a) {
    a = document.createElement("a");
    a.id = "edit-button";
    a.target = "_blank";
    a.rel = "noopener";
    a.title = "Open in the editor";
    a.setAttribute("aria-label", "Open in the editor");
    a.textContent = "✎";
    document.getElementById("view").append(a);
  }
  a.href = song ? "/?edit&song=" + encodeURIComponent(song) : "/?edit#" + packed;
}

const params = new URLSearchParams(location.search);
if (location.pathname === "/" && params.has("edit")) {
  // The editor (and its importer) are only fetched in edit mode.
  import("./editor.js").then((m) => m.startEdit(params));
} else {
  startView(params);
}
