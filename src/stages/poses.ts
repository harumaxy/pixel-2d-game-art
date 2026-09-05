/**
 * `px poses [--only walk,run] [--size 512]` — render every openpose skeleton.
 * Character-independent; run once, rerun after editing src/motions/.
 */

import { dirname, join } from "node:path";
import { ensureDir, flag } from "../lib/comfy";
import { OUT_DIR } from "../lib/paths";
import { renderPose } from "../lib/skeleton";
import { DIRS5, MOTIONS, type Dir5 } from "../motions";

export const posePath = (motion: string, dir: Dir5, frame: number): string =>
  join(OUT_DIR, "poses", motion, dir, `${frame}.png`);

export async function run(argv: string[]): Promise<void> {
  const size = Number(flag(argv, "size") ?? 512);
  const only = flag(argv, "only")
    ?.split(",")
    .map((s) => s.trim());
  const selected = only ? MOTIONS.filter((m) => only.includes(m.id)) : MOTIONS;
  const unknown = only?.filter((id) => !MOTIONS.some((m) => m.id === id)) ?? [];
  if (unknown.length) {
    console.error(
      `unknown --only ${unknown.join(", ")}; expected ${MOTIONS.map((m) => m.id).join(", ")}`,
    );
    process.exit(1);
  }

  let n = 0;
  for (const m of selected)
    for (const dir of DIRS5)
      for (let i = 0; i < m.frames; i++) {
        const dest = posePath(m.id, dir, i);
        await ensureDir(dirname(dest));
        await Bun.write(dest, await renderPose(m.key(dir, i / m.frames), size));
        n++;
      }
  console.log(`${n} poses -> out/poses/`);
}
