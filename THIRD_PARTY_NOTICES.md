# Third-party components

abcroche's own code is MIT-licensed (see [LICENSE](LICENSE)). It uses the
components below, each under its own licence. None of them is stored in this
repository: npm installs the libraries, and `scripts/vendor.mjs` fetches the
browser assets when you build or run it.

## Served to browsers

| Component | Licence | Source |
| --- | --- | --- |
| [abcjs](https://github.com/paulrosen/abcjs) | MIT | npm (`abcjs`) |
| [jQuery](https://jquery.com) (only needed by xml2abc-js) | MIT | npm (`jquery`) |
| [xml2abc-js](https://wim.vree.org/js/xml2abc-js_index.html) by Willem Vree | LGPL-3.0 | downloaded unmodified, verified by SHA-256 |
| Acoustic grand piano samples from [midi-js-soundfonts](https://github.com/paulrosen/midi-js-soundfonts) | see the upstream repository | downloaded at build time |

xml2abc-js is served unmodified as a separate file, with its licence header
intact, and is loaded only when a MusicXML file is imported.

## Used by the server

| Component | Licence |
| --- | --- |
| [abcjs](https://github.com/paulrosen/abcjs) | MIT |
| [jsdom](https://github.com/jsdom/jsdom) | MIT |
| [resvg-js](https://github.com/yisibl/resvg-js) | MPL-2.0 |
| [Liberation fonts](https://github.com/liberationfonts/liberation-fonts) (in the container image) | SIL Open Font License 1.1 |
