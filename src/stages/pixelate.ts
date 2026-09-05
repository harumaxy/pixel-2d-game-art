// src/stages/pixelate.ts
/**
 * `px pixelate <char> [--size 64] [--palette apoc|auto] [--bg-tolerance 40] [--bg #rrggbb] [--motion m]`
 *
 * out/sprites -> out/px: remove the grey backdrop, pin feet, scale every frame
 * of a motion by the same factor, box-filter down, snap to the palette, and
 * mirror the side-ish directions into their left-facing twins.
 */

import { readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { ensureDir, flag, positional } from "../lib/comfy";
import { loadChar } from "../lib/chars";
import { OUT_DIR } from "../lib/paths";
import {
  bbox,
  boxDownscale,
  cornerKey,
  hflip,
  loadPalette,
  medianCut,
  placeOnSquare,
  quantize,
  readRgba,
  removeBackground,
  writePng,
  type Rgb,
  type Rgba,
} from "../lib/pixelate";
import { DIRS5, FLIP, MOTIONS, type Dir5, type Dir8 } from "../motions";

const VALUE_FLAGS = new Set(["--size", "--palette", "--bg-tolerance", "--bg", "--motion"]);

export const pxPath = (char: string, motion: string, dir: Dir8, frame: number): string =>
  join(OUT_DIR, "px", char, motion, dir, `${frame}.png`);

/** Newest `<frame>_*.png` ComfyUI wrote for this frame, or undefined. */
async function latestRender(dir: string, frame: number): Promise<string | undefined> {
  const files = (await readdir(dir).catch(() => [] as string[]))
    .filter((f) => f.startsWith(`${frame}_`) && f.endsWith(".png"))
    .sort();
  return files.length ? join(dir, files[files.length - 1]!) : undefined;
}

export async function run(argv: string[]): Promise<void> {
  const name = positional(argv, VALUE_FLAGS);
  if (!name) {
    console.error(
      `usage: bun run px pixelate <char> [--size 64] [--palette apoc|auto] [--bg-tolerance 40] [--bg #rrggbb] [--motion m]`,
    );
    process.exit(1);
  }
  const char = await loadChar(name).catch((e: Error) => {
    console.error(e.message);
    process.exit(1);
  });

  const size = Number(flag(argv, "size") ?? 64);
  const paletteName = flag(argv, "palette") ?? "apoc";
  const tolerance = Number(flag(argv, "bg-tolerance") ?? 40);
  const fixed = paletteName === "auto" ? undefined : await loadPalette(paletteName);
  const bgFlag = flag(argv, "bg");
  let bg: Rgb | undefined;
  if (bgFlag !== undefined) {
    const m = /^#?([0-9a-f]{6})$/i.exec(bgFlag);
    if (!m) {
      console.error(`bad --bg colour ${JSON.stringify(bgFlag)}, expected #rrggbb`);
      process.exit(1);
    }
    const v = parseInt(m[1]!, 16);
    bg = [(v >> 16) & 255, (v >> 8) & 255, v & 255];
  }
  const motionFlag = flag(argv, "motion");
  const motions = motionFlag ? MOTIONS.filter((m) => m.id === motionFlag) : MOTIONS;

  const srcRoot = join(OUT_DIR, "sprites", char.name);
  let written = 0,
    missing = 0;

  for (const m of motions)
    for (const dir of DIRS5) {
      // Pass 1: cut out every frame, remember the tallest box.
      const cut: { frame: number; img: Rgba; box: ReturnType<typeof bbox> }[] = [];
      for (let i = 0; i < m.frames; i++) {
        const src = await latestRender(join(srcRoot, m.id, dir), i);
        if (!src) {
          missing++;
          continue;
        }
        const raw = await readRgba(src);
        const img = removeBackground(raw, bg ?? cornerKey(raw), tolerance);
        cut.push({ frame: i, img, box: bbox(img) });
      }
      const tallest = Math.max(0, ...cut.map((c) => (c.box ? c.box.y1 - c.box.y0 : 0)));
      if (!tallest) continue;
      // Leave 4% headroom on the working canvas; one scale for the whole motion.
      const work = 512;
      const scale = (work * 0.96) / tallest;

      // Pass 2: place, downscale, quantize, write + mirror.
      for (const c of cut) {
        if (!c.box) {
          missing++;
          continue;
        }
        const placed = placeOnSquare(c.img, c.box, work, scale);
        const small = boxDownscale(placed, size);
        const pal = fixed ?? medianCut(small, 16);
        const final = quantize(small, pal);
        const [main, mirror] = FLIP[dir as Dir5];
        for (const [d8, img] of [
          [main, final],
          ...(mirror ? [[mirror, hflip(final)] as const] : []),
        ] as const) {
          const dest = pxPath(char.name, m.id, d8, c.frame);
          await ensureDir(dirname(dest));
          await writePng(img, dest);
          written++;
        }
      }
    }

  console.log(`${written} frames -> out/px/${char.name}/  (${size}px, palette ${paletteName})`);
  if (missing) {
    console.error(
      `${missing} frames had no render in out/sprites/${char.name}/ — run  bun run px sprites ${char.name}`,
    );
    process.exitCode = 1;
  }
  if (!written) process.exitCode = 1;
}
