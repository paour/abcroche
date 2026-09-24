// Renders a tune into a paper element, with optional playback controls.
// Used as-is by view mode; the editor adds click/drag handling on top.

function cursorControl(paper) {
  let lit = [];
  const clear = () => {
    lit.forEach((el) => el.classList.remove("abc-playing"));
    lit = [];
  };
  return {
    onEvent(ev) {
      clear();
      (ev.elements || []).forEach((group) =>
        group.forEach((el) => { el.classList.add("abc-playing"); lit.push(el); }));
    },
    onFinished: clear,
  };
}

export class Score {
  constructor(paper, audio, interactive) {
    this.paper = paper;
    this.audio = audio;
    this.interactive = interactive || null; // { clickListener }
    this.synth = null;
  }

  render(text, opts) {
    const params = {
      responsive: "resize",
      staffwidth: opts.width || undefined,
      add_classes: true,
      paddingtop: 0,
      paddingbottom: 0,
      paddingleft: 0,
      paddingright: 0,
      visualTranspose: opts.transpose || 0, // playback stays at concert pitch
    };
    // Reflow into fewer bars per line (editor preview on phones only; the
    // tune's own line breaks are what embeds use).
    if (opts.wrap) params.wrap = { minSpacing: 1.8, maxSpacing: 2.7, preferredMeasuresPerLine: 2 };
    if (this.interactive) {
      params.clickListener = this.interactive.clickListener;
      params.dragging = true;
      params.selectTypes = ["note", "bar"];
      params.selectionColor = "#2383e2";
      params.dragColor = "#2383e2";
    }
    const tune = ABCJS.renderAbc(this.paper, text, params)[0];

    // "resize" always fills the container, so scale is applied as a cap on
    // the container width: the score is `scale` times its natural size, and
    // only shrinks when the frame is narrower than that.
    const svg = this.paper.querySelector("svg");
    const natural = svg && svg.viewBox && svg.viewBox.baseVal ? svg.viewBox.baseVal.width : 0;
    this.paper.style.maxWidth = natural ? Math.ceil(natural * (opts.scale || 1)) + "px" : "";

    this.updateSynth(tune, opts.play && text.trim() !== "");
    return tune;
  }

  updateSynth(tune, wanted) {
    this.audio.hidden = !wanted;
    if (!wanted || !ABCJS.synth.supportsAudio()) {
      if (this.synth) this.synth.pause();
      return;
    }
    if (!this.synth) {
      this.synth = new ABCJS.synth.SynthController();
      this.synth.load(this.audio, cursorControl(this.paper), {
        displayPlay: true,
        displayProgress: true,
        displayRestart: true,
      });
    } else {
      this.synth.pause();
    }
    this.synth.setTune(tune, false, {
      soundFontUrl: new URL("/soundfont/", location.href).href,
    }).catch((err) => {
      console.warn("abcjs synth:", err);
      this.audio.hidden = true;
    });
    // setTune() without a user gesture only swaps the tune in; once the
    // player has been used, its isLoaded flag makes the next ▶ replay the
    // old audio (old length, old notes). Clearing it makes ▶ rebuild the
    // audio and timing from this tune.
    this.synth.isLoaded = false;
  }
}
