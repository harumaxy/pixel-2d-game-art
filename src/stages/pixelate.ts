// src/stages/pixelate.ts
/**
 * `px pixelate <char> [--size 64] [--palette apoc|auto] [--bg-tolerance 40] [--bg #rrggbb]`
 *
 * out/gen/sprites -> out/px: remove the grey backdrop (unless the render is
 * already matted RGBA from `px sprites`, whose alpha is trusted), pin feet, scale every frame
 * of the character by the same factor (measured across all motions and
 * directions), box-filter down, snap to the palette, and mirror the side-ish
 * directions into their left-facing twins. Always processes every motion, so
 * a single scale factor — and, with `--palette auto`, a single palette — stay
 * consistent across the whole character, even on a partial re-run.
 */

import { readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { ensureDir, flag, positional } from "../lib/comfy";
import { loadChar } from "../lib/chars";
import { GEN_DIR, OUT_DIR } from "../lib/paths";
import {
  bbox,
  boxDownscale,
  cornerKey,
  hasAlpha,
  hflip,
  loadPalette,
  medianCut,
  placeOnSquare,
  quantize,
  readRgba,
  removeBackground,
  removeShadow,
  writePng,
  type Rgb,
  type Rgba,
} from "../lib/pixelate";
import { FLIP, GEN_DIRS, MOTIONS, type Dir8, type GenDir } from "../motions";

const VALUE_FLAGS = new Set(["--size", "--palette", "--bg-tolerance", "--bg", "--render"]);

export const pxPath = (char: string, motion: string, dir: Dir8, frame: number): string =>
  join(OUT_DIR, "px", char, motion, dir, `${frame}.png`);

/** Newest `<frame>_*.png` ComfyUI wrote for this frame, or the `<frame>_<render>_.png` asked for; undefined if none. */
async function latestRender(
  dir: string,
  frame: number,
  render?: string,
): Promise<string | undefined> {
  const files = (await readdir(dir).catch(() => [] as string[]))
    .filter((f) => f.startsWith(`${frame}_`) && f.endsWith(render ? `_${render}_.png` : ".png"))
    .sort();
  return files.length ? join(dir, files[files.length - 1]!) : undefined;
}

export async function run(argv: string[]): Promise<void> {
  const name = positional(argv, VALUE_FLAGS);
  if (!name) {
    console.error(
      `usage: bun run px pixelate <char> [--size 64] [--palette apoc|auto] [--bg-tolerance 40] [--bg #rrggbb] [--render 00013]`,
    );
    process.exit(1);
  }
  const char = await loadChar(name).catch((e: Error) => {
    console.error(e.message);
    process.exit(1);
  });

  const size = Number(flag(argv, "size") ?? 64);
  /** ComfyUI's counter, to pixelate one specific run instead of the newest. */
  const render = flag(argv, "render");
  const paletteName = flag(argv, "palette") ?? "apoc";
  const tolerance = Number(flag(argv, "bg-tolerance") ?? 40);
  let fixed: Rgb[] | undefined;
  if (paletteName !== "auto") {
    try {
      fixed = await loadPalette(paletteName);
    } catch (e) {
      console.error((e as Error).message);
      process.exit(1);
    }
  }
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

  const srcRoot = join(GEN_DIR, "sprites", char.name);

  // Pass 1: cut out every frame of every motion, so the scale factor below is
  // one number for the whole character run — a crouching motion or a profile
  // view must come out the same size as a standing front view, not its own
  // size per group.
  const cut: {
    motion: string;
    dir: GenDir;
    frame: number;
    img: Rgba;
    box: ReturnType<typeof bbox>;
  }[] = [];
  let missing = 0;
  let blank = 0;
  for (const m of MOTIONS)
    for (const dir of GEN_DIRS)
      for (let i = 0; i < m.frames; i++) {
        const src = await latestRender(join(srcRoot, m.id, dir), i, render);
        if (!src) {
          missing++;
          continue;
        }
        const raw = await readRgba(src);
        const key = bg ?? cornerKey(raw);
        // A matted render keeps the backdrop colour under alpha 0, so the corner
        // key and the shadow flood still work; the matting model itself counts
        // the ground shadow as subject and leaves it in.
        const keyed = hasAlpha(raw) ? raw : removeBackground(raw, key, tolerance);
        const img = removeShadow(keyed, key);
        const box = bbox(img);
        if (!box) blank++;
        cut.push({ motion: m.id, dir, frame: i, img, box });
      }

  const tallest = Math.max(0, ...cut.map((c) => (c.box ? c.box.y1 - c.box.y0 : 0)));
  const widest = Math.max(0, ...cut.map((c) => (c.box ? c.box.x1 - c.box.x0 : 0)));
  if (!tallest) {
    if (blank) {
      console.error(
        `${blank} frames were fully transparent after background removal — check --bg / --bg-tolerance`,
      );
    } else {
      console.error(
        `${missing} frames had no render in out/gen/sprites/${char.name}/ — run  bun run px sprites ${char.name}`,
      );
    }
    process.exitCode = 1;
    return;
  }
  // Leave 4% headroom on the working canvas; one scale for the whole character.
  const work = 512;
  const scale = Math.min((work * 0.96) / tallest, (work * 0.96) / widest);

  // Pass 2: place + downscale every frame first, so `--palette auto` builds
  // ONE palette for the whole character before any frame is quantized.
  const placed = cut
    .filter((c) => c.box !== undefined)
    .map((c) => ({ ...c, small: boxDownscale(placeOnSquare(c.img, c.box!, work, scale), size) }));

  let pal: Rgb[];
  if (fixed) {
    pal = fixed;
  } else {
    const count = placed.length;
    const combined: Rgba = {
      width: size,
      height: size * count,
      data: new Uint8Array(size * size * count * 4),
    };
    placed.forEach((p, i) => combined.data.set(p.small.data, i * size * size * 4));
    pal = medianCut(combined, 16);
  }

  let written = 0;
  for (const c of placed) {
    const final = quantize(c.small, pal);
    const [main, mirror] = FLIP[c.dir];
    for (const [d8, img] of [
      [main, final],
      ...(mirror ? [[mirror, hflip(final)] as const] : []),
    ] as const) {
      const dest = pxPath(char.name, c.motion, d8, c.frame);
      await ensureDir(dirname(dest));
      await writePng(img, dest);
      written++;
    }
  }

  console.log(`${written} frames -> out/px/${char.name}/  (${size}px, palette ${paletteName})`);
  if (missing) {
    console.error(
      `${missing} frames had no render in out/gen/sprites/${char.name}/ — run  bun run px sprites ${char.name}`,
    );
    process.exitCode = 1;
  }
  if (blank) {
    console.error(
      `${blank} frames were fully transparent after background removal — check --bg / --bg-tolerance`,
    );
    process.exitCode = 1;
  }
  if (!written) process.exitCode = 1;
}
