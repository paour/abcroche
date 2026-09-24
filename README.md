# abcroche

A tiny, self-hosted server for [ABC notation](https://abcnotation.com): write
tunes in a visual editor, then share them as embeddable pages, as images, or as
links that unfurl with the score.

*abc* + *croche*, the French eighth note.

- **Viewer**: a clean, chrome-free score page built for embedding (Notion
  `/embed`, iframes, wikis), with optional playback and note highlighting.
- **Visual editor**: note entry from an on-screen piano or the keyboard,
  click/drag/arrow editing on the score, contiguous selections, copy and
  paste, bar lines and repeats, chord symbols, key/time/clef/tempo fields,
  undo, and the raw ABC with a built-in quick reference. Works on phones.
- **Transposing instruments**: show and share B♭ or E♭ parts (optionally an
  octave down); playback stays at concert pitch. Letter names or solfège.
- **MusicXML import** (MuseScore, Sibelius, Finale, Dorico, …), converted in
  the browser.
- **Server-side rendering**: any tune as SVG or PNG, with the same options as
  the page.
- **Link previews**: tune pages carry a title and Open Graph / Twitter tags
  with the score as the preview image.
- **Saved songs** (optional): a small SQLite store behind your own sign-in
  proxy, with short, stable links that always show the latest version.
- Tunes you edit are kept in your browser automatically.

## Quick start

```sh
docker run -d -p 8000:8000 -v abcroche-data:/data ghcr.io/OWNER/abcroche:latest
```

Open <http://localhost:8000/?edit>. Or with Compose: `docker compose up -d`
(see [`compose.yaml`](compose.yaml)).

## Links

| URL | What |
| --- | --- |
| `/?edit` | The editor |
| `/t/<tune>` | The score of a tune packed into the link (compressed, about 3× shorter than the ABC) |
| `/s/<song>` | The score of a saved song, always its latest version |
| `/t/<tune>.svg`, `.png` | The same as an image (and `/s/<song>.svg`, `.png`) |

The editor builds all of these for you (**Link**: Embed, PNG image or SVG
image, then **Copy link**). Pages and images take these options:

| Option | Effect |
| --- | --- |
| `play=1` | Playback control (pages) |
| `editbtn=1` | A small ✎ that opens the tune in the editor (pages) |
| `tr=bb`, `tr=eb`, `tr=c` | Written for a B♭ or E♭ instrument, or concert pitch |
| `low=1` | With `tr=bb`/`eb`: an octave lower |
| `title=0`, `tempo=0` | Hide the title or the tempo marking |
| `width=500` | Staff width in pixels (where lines wrap) |
| `scale=1.5` | Size |
| `bg=transparent` | No white background |

## Configuration

All optional, through environment variables:

| Variable | Default | |
| --- | --- | --- |
| `PORT` | `8000` | |
| `PUBLIC_URL` | from each request | Absolute base URL for link previews, e.g. `https://music.example.com`. Set it behind a proxy. |
| `DATA_DIR` | `./data` (image: `/data`) | Where the SQLite database lives |
| `AUTH_USER_HEADER` | `Remote-User` | Header your sign-in proxy sets with the user name |
| `AUTH_NAME_HEADER` | `Remote-Name` | Header with a display name |
| `IMAGE_CACHE_MAX_FILES` | `10000` | Rendered-image cache limit (count) |
| `IMAGE_CACHE_MAX_BYTES` | `1073741824` | Rendered-image cache limit (bytes) |
| `FONT_DIR` | auto | Where the Liberation fonts are, for text in PNGs |
| `DEV_USER` | — | Local development only: treat every request as signed in as this user |

Rendered images are cached in memory. The cache never evicts: once it reaches
either limit, links to tunes that aren't cached yet get a `503` until the next
restart (saved songs still render, uncached). This bounds what anonymous
`/t/` links can make the server hold.

## Saving songs: sign-in

Viewing, editing, images and previews need no account. Saving songs on the
server does, and abcroche leaves sign-in to a forward-auth reverse proxy
(Authelia, Authentik, oauth2-proxy, …) that passes the user in a header.
Route it like this:

| Route | Access |
| --- | --- |
| `GET /api/songs/<id>` | public (shared songs stay readable) |
| everything else under `/api/` | through forward-auth |
| everything else | public |

**On the public routes, the proxy must remove the user header** a client
might send: abcroche trusts it. As a second line of defence the API refuses
requests without it, and saving or deleting requires an `X-Requested-With`
header, which forces a CORS preflight that abcroche never grants.

[`examples/traefik-authelia.compose.yaml`](examples/traefik-authelia.compose.yaml)
is a complete Traefik + Authelia setup. When a signed-in user visits the editor,
a **Save online** button appears; songs are saved under a name made from their
title (`/s/speed-the-plough`).

Pages are meant to be embedded, so abcroche sends no `X-Frame-Options` or
`frame-ancestors`. Its Content-Security-Policy only allows its own scripts.

## Development

Needs Node.js 24 or later.

```sh
npm install
npm run vendor      # abcjs, jQuery, xml2abc and a piano soundfont into .vendor/
cp .env.example .env  # optional: DEV_USER=dev lets you save songs locally
npm run dev         # http://localhost:8000/?edit, restarts on changes
npm test
```

For text in PNG images, install the Liberation fonts
(`fonts-liberation` on Debian/Ubuntu, `font-liberation` on Alpine).

| Path | |
| --- | --- |
| `server.mjs` | HTTP server: static files, tune pages with previews, images, the song API |
| `render.mjs` | Server-side rendering: abcjs under jsdom → SVG, resvg → PNG |
| `site/` | The browser app (plain ES modules, no build step) |
| `site/abc-text.js` | ABC text logic shared by the editor and the server |
| `site/share.js` | Link options and link building, shared by the page, editor and server |
| `scripts/vendor.mjs` | Fetches the third-party browser assets |
| `test/` | `node --test` suites |

Pushes to `main` run the tests and publish a multi-arch image
(`linux/amd64`, `linux/arm64`) to the GitHub Container Registry.

## Limitations

- The visual editor is built for single-line melodies (lead sheets, folk
  tunes). Multi-voice scores import, display and play correctly, but are best
  edited in the ABC source.
- The server renders text with estimated widths (there is no browser layout),
  so images can differ from the page by a few pixels.

## License

MIT, see [LICENSE](LICENSE). abcroche downloads and serves third-party
components under their own licences; see
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
