/**
 * 8-bit sprite kit for the aquarium.
 *
 * Fish are drawn once into small offscreen canvases (one per palette × facing) and then
 * blitted. At 1000 agents we cannot afford per-frame path drawing, and image-smoothing is
 * off everywhere so scaling stays crunchy rather than blurry.
 */

/** Palette keys per fish state. 0 = transparent. */
export type FishPalette = {
  body: string;
  bodyDark: string;
  belly: string;
  fin: string;
  eye: string;
  outline: string;
};

/**
 * Three tail positions, 18 x 11, facing RIGHT. Cycling them is what turns a drifting
 * sprite into something that reads as *swimming* — the tail beat sells it more than any
 * amount of path smoothing.
 *
 * 0 empty · 1 outline · 2 body · 3 bodyDark · 4 belly · 5 fin/tail · 6 eye white · 7 pupil
 */
const FISH_FRAMES = [
  // tail fanned up
  [
    "000000000000000000",
    "005500001111000000",
    "055500112222110000",
    "555511122222221000",
    "555511222222222100",
    "005511222222267100",
    "000011222222267100",
    "000011222222222100",
    "000001122442221000",
    "000000112244110000",
    "000000001111000000",
    "000000000000000000",
  ],
  // tail straight back (mid-stroke)
  [
    "000000000000000000",
    "000000001111000000",
    "000000112222110000",
    "000551122222221000",
    "555511222222222100",
    "555511222222267100",
    "555511222222267100",
    "555511222222222100",
    "000551122442221000",
    "000000112244110000",
    "000000001111000000",
    "000000000000000000",
  ],
  // tail fanned down
  [
    "000000000000000000",
    "000000001111000000",
    "000000112222110000",
    "000001122222221000",
    "000011222222222100",
    "005511222222267100",
    "555511222222267100",
    "555511222222222100",
    "055501122442221000",
    "005500112244110000",
    "000000001111000000",
    "000000000000000000",
  ],
];

export const FISH_FRAME_COUNT = FISH_FRAMES.length;

const KEY = (p: FishPalette): (string | null)[] => [
  null,
  p.outline,
  p.body,
  p.bodyDark,
  p.belly,
  p.fin,
  "#ffffff",
  p.eye,
];

export const FISH_W = 18;
export const FISH_H = 12;

const cache = new Map<string, HTMLCanvasElement>();

/**
 * Build (and memoise) one fish frame at 1px-per-pixel; callers scale on blit.
 * Sprites are cached per (palette, frame, facing) so 1000 fish cost 1000 blits, not
 * 1000 × 198 fillRects.
 */
export function fishSprite(
  palette: FishPalette,
  flipped: boolean,
  frame: number,
  id: string,
): HTMLCanvasElement {
  const f = ((frame % FISH_FRAME_COUNT) + FISH_FRAME_COUNT) % FISH_FRAME_COUNT;
  const key = `${id}:${flipped}:${f}`;
  const hit = cache.get(key);
  if (hit) return hit;

  const c = document.createElement("canvas");
  c.width = FISH_W;
  c.height = FISH_H;
  const g = c.getContext("2d")!;
  const colours = KEY(palette);
  const bitmap = FISH_FRAMES[f];

  for (let y = 0; y < FISH_H; y++) {
    for (let x = 0; x < FISH_W; x++) {
      const v = Number(bitmap[y][flipped ? FISH_W - 1 - x : x]);
      const col = colours[v];
      if (!col) continue;
      g.fillStyle = col;
      g.fillRect(x, y, 1, 1);
    }
  }
  cache.set(key, c);
  return c;
}

/** Deterministic hue per persona so the same character keeps its colours across runs. */
export function hueFor(personaId: string): number {
  let h = 0;
  for (let i = 0; i < personaId.length; i++) h = (h * 31 + personaId.charCodeAt(i)) % 360;
  return h;
}

const hsl = (h: number, s: number, l: number) => `hsl(${h} ${s}% ${l}%)`;

export function palettes(
  hue: number,
): Record<"normal" | "confused" | "done" | "gone" | "queued", FishPalette> {
  return {
    normal: {
      body: hsl(hue, 62, 62),
      bodyDark: hsl(hue, 58, 46),
      belly: hsl(hue, 45, 78),
      fin: hsl((hue + 24) % 360, 66, 54),
      eye: "#101820",
      outline: hsl(hue, 45, 22),
    },
    // Alarm state — the fish that just filed a finding.
    confused: {
      body: "#ff8b4a",
      bodyDark: "#e2551f",
      belly: "#ffd9a0",
      fin: "#ffb648",
      eye: "#2b0f00",
      outline: "#7d2a08",
    },
    // Converted — gold, reached the seabed.
    done: {
      body: "#ffd34d",
      bodyDark: "#e0a026",
      belly: "#fff2c2",
      fin: "#ffe89a",
      eye: "#3d2a00",
      outline: "#7a5400",
    },
    // Queued — part of the swarm but not started; washed out, waiting near the surface.
    queued: {
      body: hsl(hue, 22, 44),
      bodyDark: hsl(hue, 20, 34),
      belly: hsl(hue, 18, 56),
      fin: hsl(hue, 20, 40),
      eye: "#1b2530",
      outline: hsl(hue, 22, 22),
    },
    // Rage-quit — drained of colour, drifts back up belly-first.
    gone: {
      body: "#7b8794",
      bodyDark: "#5a636e",
      belly: "#aab4bf",
      fin: "#6b747f",
      eye: "#2a2f36",
      outline: "#3a4149",
    },
  };
}

/**
 * 3x5 pixel digits for the HUD. Big numbers are the whole point of this project's
 * marketing, so they get to look like a scoreboard.
 */
const DIGITS: Record<string, string[]> = {
  "0": ["111", "101", "101", "101", "111"],
  "1": ["010", "110", "010", "010", "111"],
  "2": ["111", "001", "111", "100", "111"],
  "3": ["111", "001", "111", "001", "111"],
  "4": ["101", "101", "111", "001", "001"],
  "5": ["111", "100", "111", "001", "111"],
  "6": ["111", "100", "111", "101", "111"],
  "7": ["111", "001", "010", "010", "010"],
  "8": ["111", "101", "111", "101", "111"],
  "9": ["111", "101", "111", "001", "111"],
  ",": ["000", "000", "000", "010", "100"],
  "$": ["011", "110", "011", "110", "010"],
  ".": ["000", "000", "000", "000", "010"],
};

/** Render a numeric string as pixel digits into a canvas 2D context. */
export function drawPixelNumber(
  g: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  scale: number,
  colour: string,
): number {
  g.fillStyle = colour;
  let cx = x;
  for (const ch of text) {
    const glyph = DIGITS[ch];
    if (!glyph) {
      cx += 2 * scale;
      continue;
    }
    for (let gy = 0; gy < 5; gy++) {
      for (let gx = 0; gx < 3; gx++) {
        if (glyph[gy][gx] === "1") g.fillRect(cx + gx * scale, y + gy * scale, scale, scale);
      }
    }
    cx += 4 * scale;
  }
  return cx - x;
}
