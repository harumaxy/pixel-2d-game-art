// src/stages/sheet.ts
/**
 * `px sheet <char> [--size 64]` — out/px/<char> -> out/sheets/<char>.png + .json
 * Rows: MOTIONS order × DIRS8 order. Missing frames are skipped and reported.
 */

import { join } from "node:path";
import { ensureDir, flag, positional } from "../lib/comfy";
import { loadChar } from "../lib/chars";
import { OUT_DIR } from "../lib/paths";
import { readRgba, writePng } from "../lib/pixelate";
import { composeSheet, type SheetRow } from "../lib/sheet";
import { DIRS8, MOTIONS } from "../motions";
import { pxPath } from "./pixelate";

export async function run(argv: string[]): Promise<void> {
  const name = positional(argv, new Set(["--size"]));
  if (!name) {
    console.error(`usage: bun run px sheet <char> [--size 64]`);
    process.exit(1);
  }
  const char = await loadChar(name).catch((e: Error) => {
    console.error(e.message);
    process.exit(1);
  });
  const size = Number(flag(argv, "size") ?? 64);

  const rows: SheetRow[] = [];
  let missing = 0;
  for (const m of MOTIONS)
    for (const dir of DIRS8) {
      const frames = [];
      for (let i = 0; i < m.frames; i++) {
        const p = pxPath(char.name, m.id, dir, i);
        if (await Bun.file(p).exists()) frames.push(await readRgba(p));
        else missing++;
      }
      if (frames.length) rows.push({ name: `${m.id}_${dir}`, frames, fps: m.fps });
    }

  if (!rows.length) {
    console.error(`nothing in out/px/${char.name}/ — run  bun run px pixelate ${char.name}`);
    process.exit(1);
  }

  const { image, meta } = composeSheet(rows, size);
  const dir = join(OUT_DIR, "sheets");
  await ensureDir(dir);
  await writePng(image, join(dir, `${char.name}.png`));
  await Bun.write(join(dir, `${char.name}.json`), JSON.stringify(meta, null, 2));
  console.log(
    `out/sheets/${char.name}.png  ${image.width}x${image.height}, ${rows.length} rows\nout/sheets/${char.name}.json`,
  );
  if (missing) {
    console.error(`${missing} frames missing (rows shortened)`);
    process.exitCode = 1;
  }
}
