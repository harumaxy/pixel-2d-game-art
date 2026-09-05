/** Grid a set of same-sized frames into one sheet: row = animation, column = frame. */

import type { Rgba } from "./pixelate";

export interface SheetRow {
  name: string;
  frames: Rgba[];
  fps: number;
}
export interface SheetMeta {
  frameSize: number;
  columns: number;
  animations: { name: string; row: number; frames: number; fps: number }[];
}

export function composeSheet(
  rows: SheetRow[],
  frameSize: number,
): { image: Rgba; meta: SheetMeta } {
  const columns = Math.max(1, ...rows.map((r) => r.frames.length));
  const width = columns * frameSize,
    height = rows.length * frameSize;
  const image: Rgba = { width, height, data: new Uint8Array(width * height * 4) };

  rows.forEach((row, r) =>
    row.frames.forEach((f, c) => {
      if (f.width !== frameSize || f.height !== frameSize)
        throw new Error(
          `${row.name}[${c}] is ${f.width}x${f.height}, expected ${frameSize}x${frameSize}`,
        );
      for (let y = 0; y < frameSize; y++) {
        const s = y * frameSize * 4;
        const d = ((r * frameSize + y) * width + c * frameSize) * 4;
        image.data.set(f.data.subarray(s, s + frameSize * 4), d);
      }
    }),
  );

  return {
    image,
    meta: {
      frameSize,
      columns,
      animations: rows.map((row, r) => ({
        name: row.name,
        row: r,
        frames: row.frames.length,
        fps: row.fps,
      })),
    },
  };
}
