// The About dialog and its little demo: copper bars, a starfield, a wobbling
// logo and a sine scroller, drawn at 320x180 and scaled up in whole pixels.
// The colours come from the current theme, so every scheme gets its own demo.

export interface About {
  open(): void;
}

export const DEMO_WIDTH = 320;
export const DEMO_HEIGHT = 180;
const GLYPH = 16;
const FONT = `${GLYPH}px 'Press Start 2P', ui-monospace, monospace`;
const SMALL_FONT = `8px 'Press Start 2P', ui-monospace, monospace`;

export const SCROLL_TEXT =
  'chiptrackr by wirehack7 ... a tracker for chiptunes and modules, right in your browser ... ' +
  'load a MOD, XM, S3M or IT and make some noise ... greetings to every coder, musician and ' +
  'pixeler who still keeps the scene alive ... sixteen rows a beat, hex all the way down ... ' +
  'see you at the next party ...     ';

export interface Glyph {
  char: string;
  x: number;
  y: number;
  /** Position in the text, used to cycle colours along the scroller. */
  index: number;
}

/**
 * The scroller characters that are on screen at `offset` pixels into the
 * text. Each one rides a sine wave around `baseline`; the text repeats.
 */
export function scrollerGlyphs(text: string, offset: number, t: number, baseline: number, amplitude: number): Glyph[] {
  const span = text.length * GLYPH;
  const start = ((offset % span) + span) % span;
  const first = Math.floor(start / GLYPH);
  const glyphs: Glyph[] = [];
  for (let i = 0; i * GLYPH - (start % GLYPH) < DEMO_WIDTH; i++) {
    const index = (first + i) % text.length;
    const char = text[index]!;
    const x = i * GLYPH - (start % GLYPH);
    if (char === ' ') continue;
    const y = baseline + Math.round(Math.sin(x * 0.025 + t * 3) * amplitude);
    glyphs.push({ char, x, y, index });
  }
  return glyphs;
}

interface Star {
  x: number;
  y: number;
  z: number;
}

function makeStars(count: number): Star[] {
  return Array.from({ length: count }, () => ({
    x: (Math.random() - 0.5) * DEMO_WIDTH * 2,
    y: (Math.random() - 0.5) * DEMO_HEIGHT * 2,
    z: Math.random() * 0.95 + 0.05,
  }));
}

interface Palette {
  bg: string;
  text: string;
  dim: string;
  /** Colours that cycle through bars, logo and scroller. */
  cycle: string[];
}

function readPalette(): Palette {
  const css = getComputedStyle(document.documentElement);
  const v = (name: string, fallback: string) => css.getPropertyValue(name).trim() || fallback;
  return {
    bg: v('--pat-bg', '#000000'),
    text: v('--text', '#ffffff'),
    dim: v('--pat-rn', '#8ca0c0'),
    cycle: [v('--pat-instr', '#7fdfff'), v('--pat-vol', '#7fff8f'), v('--pat-param', '#ffdf7f'), v('--pat-fx', '#ff8fdf'), v('--pat-cell', '#ffd84a')],
  };
}

export function mountAbout(dialog: HTMLDialogElement): About {
  const canvas = dialog.querySelector<HTMLCanvasElement>('.about-demo')!;
  const ctx = canvas.getContext('2d')!;
  const logo = document.createElement('canvas');
  const logoCtx = logo.getContext('2d')!;
  const stars = makeStars(90);
  const still = matchMedia('(prefers-reduced-motion: reduce)');
  let palette = readPalette();
  let frame = 0;
  let paused = false;
  let time = 0;
  let last = 0;

  // The logo is drawn once in the 8x8 font and blown up three times, in
  // whole pixels, so it stays chunky.
  function drawLogo(): void {
    const text = 'chiptrackr';
    logo.width = text.length * 8 + 1;
    logo.height = 9;
    logoCtx.font = SMALL_FONT;
    logoCtx.textBaseline = 'top';
    const fill = logoCtx.createLinearGradient(0, 0, 0, 8);
    fill.addColorStop(0, palette.text);
    fill.addColorStop(0.5, palette.cycle[2]!);
    fill.addColorStop(1, palette.cycle[3]!);
    logoCtx.fillStyle = palette.bg;
    logoCtx.fillText(text, 1, 1);
    logoCtx.fillStyle = fill;
    logoCtx.fillText(text, 0, 0);
  }

  function draw(t: number): void {
    ctx.fillStyle = palette.bg;
    ctx.fillRect(0, 0, DEMO_WIDTH, DEMO_HEIGHT);

    // Starfield flying towards the viewer.
    const cx = DEMO_WIDTH / 2;
    const cy = DEMO_HEIGHT / 2;
    for (const star of stars) {
      const z = (((star.z - t * 0.25) % 1) + 1) % 1 || 1;
      const x = Math.round(cx + star.x / z / 4);
      const y = Math.round(cy + star.y / z / 4);
      if (x < 0 || y < 0 || x >= DEMO_WIDTH || y >= DEMO_HEIGHT) continue;
      ctx.fillStyle = z < 0.35 ? palette.text : palette.dim;
      const size = z < 0.2 ? 2 : 1;
      ctx.fillRect(x, y, size, size);
    }

    // Copper bars swinging behind the logo, back to front.
    const bars = palette.cycle.length;
    for (let i = bars - 1; i >= 0; i--) {
      const y = Math.round(52 + Math.sin(t * 1.7 + i * 0.55) * 30);
      const colour = palette.cycle[i]!;
      for (let row = 0; row < 12; row++) {
        ctx.globalAlpha = 1 - Math.abs(row - 5.5) / 6.5;
        ctx.fillStyle = colour;
        ctx.fillRect(0, y + row, DEMO_WIDTH, 1);
      }
    }
    ctx.globalAlpha = 1;

    // The logo wobbles column by column.
    const scale = 3;
    const logoX = Math.round((DEMO_WIDTH - logo.width * scale) / 2);
    ctx.imageSmoothingEnabled = false;
    for (let col = 0; col < logo.width; col++) {
      const dy = Math.round(Math.sin(col * 0.15 + t * 2.4) * 6);
      ctx.drawImage(logo, col, 0, 1, logo.height, logoX + col * scale, 44 + dy, scale, logo.height * scale);
    }

    ctx.font = SMALL_FONT;
    ctx.textBaseline = 'top';
    ctx.fillStyle = palette.text;
    const by = 'by wirehack7';
    ctx.fillText(by, Math.round((DEMO_WIDTH - by.length * 8) / 2), 92);

    // Sine scroller along the bottom.
    ctx.font = FONT;
    for (const glyph of scrollerGlyphs(SCROLL_TEXT, t * 60, t, 138, 14)) {
      ctx.fillStyle = palette.bg;
      ctx.fillText(glyph.char, glyph.x + 2, glyph.y + 2);
      ctx.fillStyle = palette.cycle[Math.floor(glyph.index / 3 + t * 2) % palette.cycle.length]!;
      ctx.fillText(glyph.char, glyph.x, glyph.y);
    }
  }

  function tick(now: number): void {
    if (last) time += Math.min(now - last, 100) / 1000;
    last = now;
    draw(time);
    frame = requestAnimationFrame(tick);
  }

  function start(): void {
    cancelAnimationFrame(frame);
    last = 0;
    if (paused || still.matches) draw(time);
    else frame = requestAnimationFrame(tick);
  }

  canvas.addEventListener('click', () => {
    paused = !paused;
    start();
  });
  dialog.addEventListener('close', () => cancelAnimationFrame(frame));

  return {
    open() {
      palette = readPalette();
      dialog.showModal();
      // The pixel font may still be loading; draw once it is there.
      void document.fonts.load(FONT).finally(() => {
        drawLogo();
        if (dialog.open) start();
      });
    },
  };
}
