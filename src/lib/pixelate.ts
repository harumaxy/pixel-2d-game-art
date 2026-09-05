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
 * by `scale` (nearest), with the box's bottom-centre pinned to the canvas's
 * bottom-centre. Frames of one motion share one `scale`, so feet stay put.
 */
export function placeOnSquare(img: Rgba, box: Box, canvas: number, scale: number): Rgba {
  const out = blank(canvas, canvas);
  const bw = Math.round((box.x1 - box.x0) * scale);
  const bh = Math.round((box.y1 - box.y0) * scale);
  const ox = Math.round(canvas / 2 - bw / 2);
  const oy = canvas - bh;
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

/**
 * Box-filter downscale of a square image to `size`. Colour is the alpha-
 * weighted mean of the covered cell; alpha becomes 255 when at least half the
 * cell was opaque, else 0 — no soft edges on a sprite.
 */
export function boxDownscale(img: Rgba, size: number): Rgba {
  const out = blank(size, size);
  const fx = img.width / size,
    fy = img.height / size;
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const x0 = Math.floor(x * fx),
        x1 = Math.max(x0 + 1, Math.floor((x + 1) * fx));
      const y0 = Math.floor(y * fy),
        y1 = Math.max(y0 + 1, Math.floor((y + 1) * fy));
      let r = 0,
        g = 0,
        b = 0,
        a = 0,
        n = 0;
      for (let sy = y0; sy < y1; sy++)
        for (let sx = x0; sx < x1; sx++) {
          const o = (sy * img.width + sx) * 4;
          const al = img.data[o + 3]!;
          r += img.data[o]! * al;
          g += img.data[o + 1]! * al;
          b += img.data[o + 2]! * al;
          a += al;
          n++;
        }
      const d = (y * size + x) * 4;
      if (a === 0 || a < n * 127.5) continue;
      out.data[d] = Math.round(r / a);
      out.data[d + 1] = Math.round(g / a);
      out.data[d + 2] = Math.round(b / a);
      out.data[d + 3] = 255;
    }
  return out;
}

export function quantize(img: Rgba, palette: Rgb[]): Rgba {
  const out = { ...img, data: new Uint8Array(img.data) };
  for (let i = 0; i < img.width * img.height; i++) {
    const o = i * 4;
    if (out.data[o + 3] === 0) continue;
    let best = 0,
      bd = Infinity;
    for (let p = 0; p < palette.length; p++) {
      const d = dist2(palette[p]!, out.data[o]!, out.data[o + 1]!, out.data[o + 2]!);
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
