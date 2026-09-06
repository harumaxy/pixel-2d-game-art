/**
 * Pure RGBA operations for turning a 512px render into a 64px sprite. sharp
 * only decodes and encodes; everything in between is plain typed arrays so it
 * can be unit-tested without fixtures.
 */

import { join } from "node:path";
import sharp from "sharp";
import { PALETTES_DIR } from "./paths";

export interface Rgba {
  width: number;
  height: number;
  /** Row-major RGBA, 4 bytes per pixel. */
  data: Uint8Array;
}
export type Rgb = [number, number, number];
export interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

const blank = (width: number, height: number): Rgba => ({
  width,
  height,
  data: new Uint8Array(width * height * 4),
});

export async function readRgba(path: string): Promise<Rgba> {
  const { data, info } = await sharp(path)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { width: info.width, height: info.height, data: new Uint8Array(data) };
}

export async function writePng(img: Rgba, path: string): Promise<void> {
  await sharp(Buffer.from(img.data), { raw: { width: img.width, height: img.height, channels: 4 } })
    .png()
    .toFile(path);
}

export async function loadPalette(name: string): Promise<Rgb[]> {
  const file = Bun.file(join(PALETTES_DIR, `${name}.json`));
  if (!(await file.exists())) throw new Error(`no such palette: palettes/${name}.json`);
  const doc = (await file.json()) as { colors: string[] };
  return doc.colors.map((hex) => {
    const m = /^#?([0-9a-f]{6})$/i.exec(hex);
    if (!m) throw new Error(`palettes/${name}.json: bad colour ${JSON.stringify(hex)}`);
    const v = parseInt(m[1]!, 16);
    return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
  });
}

/** A matted render already carries its own cut-out; a flat-backdrop render is all alpha 255. */
export const hasAlpha = (img: Rgba): boolean => {
  for (let i = 3; i < img.data.length; i += 4) if (img.data[i] !== 255) return true;
  return false;
};

const dist2 = (a: Rgb, r: number, g: number, b: number) =>
  (a[0] - r) ** 2 + (a[1] - g) ** 2 + (a[2] - b) ** 2;

/**
 * Every pixel within `tolerance` (euclidean RGB) of `key` becomes alpha 0,
 * enclosed or not: backdrop showing between the legs or under an arm would
 * otherwise survive and quantize to a flickering white blob.
 */
export function removeBackground(img: Rgba, key: Rgb, tolerance: number): Rgba {
  const out = { ...img, data: new Uint8Array(img.data) };
  const tol2 = tolerance * tolerance;
  for (let i = 0; i < img.width * img.height; i++) {
    const o = i * 4;
    if (dist2(key, out.data[o]!, out.data[o + 1]!, out.data[o + 2]!) <= tol2) out.data[o + 3] = 0;
  }
  return out;
}

/** Rows from here down are "the feet": the only place a ground shadow can be. */
const SHADOW_BAND = 0.65;
/** A shadow is the backdrop colour at 40..92% brightness with the same chroma (±20). */
const SHADOW_LIGHT = [0.4, 0.92] as const;
const SHADOW_CHROMA = 20;

/**
 * Drop the ground shadow the checkpoints like to paint under the feet: a
 * darker copy of the backdrop colour, touching already-transparent backdrop,
 * in the bottom part of the frame. Flood from transparent pixels so neutral
 * greys inside the character (a gas mask, a buckle) are never reached, and
 * stay above SHADOW_BAND rows untouched so a grey torso is safe too.
 */
export function removeShadow(img: Rgba, key: Rgb): Rgba {
  const { width: w, height: h } = img;
  const out = { ...img, data: new Uint8Array(img.data) };
  const keyLight = (key[0] + key[1] + key[2]) / 3;
  const keyChroma = [key[0] - key[1], key[1] - key[2]];
  const yMin = Math.floor(h * SHADOW_BAND);

  const isShadow = (i: number) => {
    const o = i * 4;
    if (out.data[o + 3] === 0) return false;
    const r = out.data[o]!,
      g = out.data[o + 1]!,
      b = out.data[o + 2]!;
    const light = (r + g + b) / 3;
    if (light < keyLight * SHADOW_LIGHT[0] || light > keyLight * SHADOW_LIGHT[1]) return false;
    return Math.abs(r - g - keyChroma[0]!) + Math.abs(g - b - keyChroma[1]!) <= SHADOW_CHROMA;
  };

  // Seed with every transparent pixel in the band; grow only through shadow.
  const stack: number[] = [];
  for (let i = yMin * w; i < w * h; i++) if (out.data[i * 4 + 3] === 0) stack.push(i);
  const seen = new Uint8Array(w * h);
  while (stack.length) {
    const i = stack.pop()!;
    const x = i % w;
    for (const j of [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, i - w, i + w]) {
      if (j < yMin * w || j >= w * h || seen[j]) continue;
      seen[j] = 1;
      if (!isShadow(j)) continue;
      out.data[j * 4 + 3] = 0;
      stack.push(j);
    }
  }
  return out;
}

/** Bounding box of alpha > 0; undefined when the image is fully transparent. x1/y1 exclusive. */
/** Smallest box holding every box; undefined when there are none. */
export function unionBox(boxes: Box[]): Box | undefined {
  if (!boxes.length) return undefined;
  return {
    x0: Math.min(...boxes.map((b) => b.x0)),
    y0: Math.min(...boxes.map((b) => b.y0)),
    x1: Math.max(...boxes.map((b) => b.x1)),
    y1: Math.max(...boxes.map((b) => b.y1)),
  };
}

export function bbox(img: Rgba): Box | undefined {
  let x0 = img.width,
    y0 = img.height,
    x1 = -1,
    y1 = -1;
  for (let y = 0; y < img.height; y++)
    for (let x = 0; x < img.width; x++)
      if (img.data[(y * img.width + x) * 4 + 3]! > 0) {
        if (x < x0) x0 = x;
        if (x >= x1) x1 = x + 1;
        if (y < y0) y0 = y;
        if (y >= y1) y1 = y + 1;
      }
  return x1 === -1 ? undefined : { x0, y0, x1, y1 };
}

/**
 * Copy `box` out of `img` onto a `canvas`×`canvas` transparent square, scaled
 * by `scale` (nearest), with the box's bottom-centre pinned `bottom` rows
 * above the canvas's bottom-centre. Frames of one motion share one `scale`,
 * so feet stay put.
 */
export function placeOnSquare(
  img: Rgba,
  box: Box,
  canvas: number,
  scale: number,
  bottom = 0,
): Rgba {
  const out = blank(canvas, canvas);
  const bw = Math.round((box.x1 - box.x0) * scale);
  const bh = Math.round((box.y1 - box.y0) * scale);
  const ox = Math.round(canvas / 2 - bw / 2);
  // `bottom` rows are left clear under the feet (room for an outline).
  const oy = canvas - bottom - bh;
  for (let y = 0; y < bh; y++) {
    const sy = box.y0 + Math.floor(y / scale);
    const dy = oy + y;
    if (dy < 0 || dy >= canvas) continue;
    for (let x = 0; x < bw; x++) {
      const sx = box.x0 + Math.floor(x / scale);
      const dx = ox + x;
      if (dx < 0 || dx >= canvas) continue;
      const s = (sy * img.width + sx) * 4,
        d = (dy * canvas + dx) * 4;
      out.data[d] = img.data[s]!;
      out.data[d + 1] = img.data[s + 1]!;
      out.data[d + 2] = img.data[s + 2]!;
      out.data[d + 3] = img.data[s + 3]!;
    }
  }
  return out;
}

const luma = (r: number, g: number, b: number) => 0.299 * r + 0.587 * g + 0.114 * b;

/** Quantiles of a cell's luminance that stand in for its min / max (an outlier-safe extremum). */
const EDGE_Q = 0.15;
/** The dark (or bright) side has to reach this much further from the mean than the other to win the cell. */
const EDGE_BIAS = 2.5;

/**
 * Contrast-aware downscale of a square image to `size`: a cell's colour is
 * not the mean of what it covers but the side of its luminance spread that
 * sticks out — a belt or a strap that is a thin dark line on a lighter coat
 * keeps the cell dark, where a box mean melts it into the coat. A cell with
 * no strong tail takes its median band. Alpha becomes 255 when at least half
 * the cell was opaque, else 0 — no soft edges on a sprite. ponytail: PixelOE
 * does this with an outline-expansion pass first; add one if thin bright
 * highlights still vanish.
 */
export function contrastDownscale(img: Rgba, size: number): Rgba {
  const out = blank(size, size);
  const fx = img.width / size,
    fy = img.height / size;
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const x0 = Math.floor(x * fx),
        x1 = Math.max(x0 + 1, Math.floor((x + 1) * fx));
      const y0 = Math.floor(y * fy),
        y1 = Math.max(y0 + 1, Math.floor((y + 1) * fy));
      const cell: { o: number; l: number }[] = [];
      let a = 0,
        n = 0;
      for (let sy = y0; sy < y1; sy++)
        for (let sx = x0; sx < x1; sx++) {
          const o = (sy * img.width + sx) * 4;
          const al = img.data[o + 3]!;
          a += al;
          n++;
          if (al >= 128)
            cell.push({ o, l: luma(img.data[o]!, img.data[o + 1]!, img.data[o + 2]!) });
        }
      if (!cell.length || a < n * 127.5) continue;
      cell.sort((p, q) => p.l - q.l);
      const at = (q: number) => cell[Math.min(cell.length - 1, Math.floor(q * cell.length))]!.l;
      const mean = cell.reduce((s, p) => s + p.l, 0) / cell.length;
      const dark = mean - at(EDGE_Q),
        bright = at(1 - EDGE_Q) - mean;
      // The band of pixels averaged for the cell's colour.
      const [lo, hi] =
        dark > bright * EDGE_BIAS ? [0, 0.3] : bright > dark * EDGE_BIAS ? [0.7, 1] : [0.25, 0.75];
      const from = Math.floor(lo * cell.length),
        to = Math.max(from + 1, Math.ceil(hi * cell.length));
      let r = 0,
        g = 0,
        b = 0;
      for (let i = from; i < to; i++) {
        const o = cell[i]!.o;
        r += img.data[o]!;
        g += img.data[o + 1]!;
        b += img.data[o + 2]!;
      }
      const d = (y * size + x) * 4;
      const k = to - from;
      out.data[d] = Math.round(r / k);
      out.data[d + 1] = Math.round(g / k);
      out.data[d + 2] = Math.round(b / k);
      out.data[d + 3] = 255;
    }
  return out;
}

/**
 * Luminance at the `lo`..`hi` quantiles (0..1) over the opaque pixels of all
 * the images together: one measurement for the whole character, so every
 * frame gets the same stretch and nothing flickers.
 */
export function luminanceRange(imgs: Rgba[], lo: number, hi: number): { lo: number; hi: number } {
  const ys: number[] = [];
  for (const img of imgs)
    for (let o = 0; o < img.data.length; o += 4)
      if (img.data[o + 3]! > 0) ys.push(luma(img.data[o]!, img.data[o + 1]!, img.data[o + 2]!));
  ys.sort((a, b) => a - b);
  const at = (q: number) => ys[Math.min(ys.length - 1, Math.floor(q * ys.length))] ?? 0;
  return { lo: at(lo), hi: at(hi) };
}

/**
 * Linear levels: luminance `lo`..`hi` becomes `outLo`..`outHi` (fractions of
 * 255), each channel scaled the same so hue survives. A dark render then
 * spreads across the palette instead of collapsing onto its darkest entries.
 */
export function stretchLevels(
  img: Rgba,
  lo: number,
  hi: number,
  outLo: number,
  outHi: number,
): Rgba {
  const out: Rgba = { width: img.width, height: img.height, data: new Uint8Array(img.data) };
  const gain = ((outHi - outLo) * 255) / Math.max(1, hi - lo);
  const offset = outLo * 255 - lo * gain;
  for (let o = 0; o < out.data.length; o += 4) {
    if (out.data[o + 3] === 0) continue;
    for (let c = 0; c < 3; c++)
      out.data[o + c] = Math.max(0, Math.min(255, Math.round(out.data[o + c]! * gain + offset)));
  }
  return out;
}

/** sRGB 0..255 -> Oklab (L, a, b): euclidean distance here tracks what the eye calls "close". */
export function oklab(r: number, g: number, b: number): [number, number, number] {
  const lin = (c: number) => {
    const v = c / 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  const [rl, gl, bl] = [lin(r), lin(g), lin(b)];
  const l = Math.cbrt(0.4122214708 * rl + 0.5363325363 * gl + 0.0514459929 * bl);
  const m = Math.cbrt(0.2119034982 * rl + 0.6806995451 * gl + 0.1073969566 * bl);
  const s = Math.cbrt(0.0883024619 * rl + 0.2817188376 * gl + 0.6299787005 * bl);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

/**
 * Snap every opaque pixel to its nearest palette entry, measured in Oklab: RGB
 * distance lets a dark brown fall onto a dark grey and a khaki onto a pink
 * because the numbers are close, where the eye sees a hue change.
 */
export function quantize(img: Rgba, palette: Rgb[]): Rgba {
  const out = { ...img, data: new Uint8Array(img.data) };
  const lab = palette.map((c) => oklab(c[0], c[1], c[2]));
  for (let i = 0; i < img.width * img.height; i++) {
    const o = i * 4;
    if (out.data[o + 3] === 0) continue;
    const [L, A, B] = oklab(out.data[o]!, out.data[o + 1]!, out.data[o + 2]!);
    let best = 0,
      bd = Infinity;
    for (let p = 0; p < lab.length; p++) {
      const [l, a, b] = lab[p]!;
      const d = (l - L) ** 2 + (a - A) ** 2 + (b - B) ** 2;
      if (d < bd) {
        bd = d;
        best = p;
      }
    }
    const c = palette[best]!;
    out.data[o] = c[0];
    out.data[o + 1] = c[1];
    out.data[o + 2] = c[2];
  }
  return out;
}

/** Opaque 4-connected blobs smaller than this are matte crumbs, not character. */
const CRUMB = 4;

/**
 * One pass of pixel-art hygiene on a quantized sprite: an opaque blob of
 * fewer than CRUMB pixels is a matte crumb (a wall stain the matte kept) and
 * goes transparent; a pixel whose 4-neighbours all differ from it takes
 * their commonest colour. Reads the input, writes a copy, so the pass is
 * order-independent.
 */
export function despeckle(img: Rgba): Rgba {
  const { width: w, height: h } = img;
  const out = { ...img, data: new Uint8Array(img.data) };
  const key = (o: number) => (img.data[o]! << 16) | (img.data[o + 1]! << 8) | img.data[o + 2]!;
  const neighbours = (i: number) => {
    const x = i % w,
      y = (i - x) / w;
    return [
      x > 0 ? i - 1 : -1,
      x < w - 1 ? i + 1 : -1,
      y > 0 ? i - w : -1,
      y < h - 1 ? i + w : -1,
    ].filter((j) => j >= 0 && img.data[j * 4 + 3]! > 0);
  };
  // Flood each opaque blob; clear the small ones.
  const seen = new Uint8Array(w * h);
  for (let s = 0; s < w * h; s++) {
    if (seen[s] || img.data[s * 4 + 3] === 0) continue;
    const blob = [s];
    seen[s] = 1;
    for (let k = 0; k < blob.length; k++)
      for (const j of neighbours(blob[k]!))
        if (!seen[j]) {
          seen[j] = 1;
          blob.push(j);
        }
    if (blob.length < CRUMB) for (const i of blob) out.data[i * 4 + 3] = 0;
  }
  for (let i = 0; i < w * h; i++) {
    const o = i * 4;
    if (out.data[o + 3] === 0) continue;
    const around = neighbours(i).map((j) => j * 4);
    if (!around.length) continue;
    const me = key(o);
    if (around.some((p) => key(p) === me)) continue;
    const votes = new Map<number, number>();
    let top = around[0]!;
    for (const p of around) {
      const v = (votes.get(key(p)) ?? 0) + 1;
      votes.set(key(p), v);
      if (v > (votes.get(key(top)) ?? 0)) top = p;
    }
    out.data.set(img.data.subarray(top, top + 3), o);
  }
  return out;
}

/** Paint `colour` on every transparent pixel that 4-touches an opaque one: a 1px outline. */
export function outline(img: Rgba, colour: Rgb): Rgba {
  const { width: w, height: h } = img;
  const out = { ...img, data: new Uint8Array(img.data) };
  const opaque = (x: number, y: number) =>
    x >= 0 && x < w && y >= 0 && y < h && img.data[(y * w + x) * 4 + 3]! > 0;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      if (img.data[o + 3] !== 0) continue;
      if (opaque(x - 1, y) || opaque(x + 1, y) || opaque(x, y - 1) || opaque(x, y + 1))
        out.data.set([...colour, 255], o);
    }
  return out;
}

/** Median cut over opaque pixels; returns up to n colours (fewer if the image has fewer). */
export function medianCut(img: Rgba, n: number): Rgb[] {
  const px: Rgb[] = [];
  for (let i = 0; i < img.width * img.height; i++)
    if (img.data[i * 4 + 3]! > 0)
      px.push([img.data[i * 4]!, img.data[i * 4 + 1]!, img.data[i * 4 + 2]!]);
  if (!px.length) return [];

  let buckets: Rgb[][] = [px];
  while (buckets.length < n) {
    // Split the bucket with the widest channel range.
    let bi = -1,
      bc = 0,
      br = -1;
    buckets.forEach((b, i) => {
      if (b.length < 2) return;
      for (let c = 0; c < 3; c++) {
        let lo = 255,
          hi = 0;
        for (const p of b) {
          if (p[c]! < lo) lo = p[c]!;
          if (p[c]! > hi) hi = p[c]!;
        }
        if (hi - lo > br) {
          br = hi - lo;
          bi = i;
          bc = c;
        }
      }
    });
    if (bi === -1) break;
    const b = buckets[bi]!.sort((p, q) => p[bc]! - q[bc]!);
    const mid = b.length >> 1;
    buckets.splice(bi, 1, b.slice(0, mid), b.slice(mid));
  }
  return buckets.map((b) => {
    const s = b.reduce((acc, p) => [acc[0] + p[0], acc[1] + p[1], acc[2] + p[2]], [0, 0, 0]);
    return [Math.round(s[0] / b.length), Math.round(s[1] / b.length), Math.round(s[2] / b.length)];
  });
}

export function hflip(img: Rgba): Rgba {
  const out = blank(img.width, img.height);
  for (let y = 0; y < img.height; y++)
    for (let x = 0; x < img.width; x++) {
      const s = (y * img.width + x) * 4,
        d = (y * img.width + (img.width - 1 - x)) * 4;
      out.data.set(img.data.subarray(s, s + 4), d);
    }
  return out;
}

/**
 * The backdrop colour a render actually used: the per-channel median of the
 * four corner pixels. The prompt asks for flat grey, but each checkpoint has
 * its own idea of grey, so the key is read off the image rather than assumed.
 */
export function cornerKey(img: Rgba): Rgb {
  const w = img.width,
    h = img.height;
  const idx = [0, w - 1, (h - 1) * w, h * w - 1].map((i) => i * 4);
  const ch = (c: number) => idx.map((o) => img.data[o + c]!).sort((a, b) => a - b);
  return [ch(0)[1]!, ch(1)[1]!, ch(2)[1]!] as Rgb;
}
