/**
 * `px poses [--only walk,run] [--size 512] [--elev 25] [--blender exe] [--skip-blender]`
 *
 * Character-independent; run once, rerun after editing MOTIONS or motions/.
 * Blender runs once per clip source (Mixamo Y Bot, Quaternius mannequin).
 * Step 1 drives Blender (scripts/mixamo_poses.py) to write joint JSON + depth
 * PNGs for every motion x 8 directions x frames * HINT_STEP; step 2 draws the
 * openpose PNGs from the JSON. `--skip-blender` reruns only step 2.
 */

import { dirname, join } from "node:path";
import { ensureDir, flag } from "../lib/comfy";
import { OUT_DIR, REPO_ROOT } from "../lib/paths";
import { poseFromJson, renderPose } from "../lib/skeleton";
import { DIRS8, HINT_STEP, MOTIONS, SOURCES, type Dir8, type Motion } from "../motions";

const POSES_DIR = join(OUT_DIR, "poses");
const SCRIPT = join(REPO_ROOT, "scripts", "mixamo_poses.py");

export const posePath = (motion: string, dir: Dir8, frame: number): string =>
  join(POSES_DIR, motion, dir, `${frame}.png`);
export const depthPath = (motion: string, dir: Dir8, frame: number): string =>
  join(POSES_DIR, motion, dir, `${frame}.depth.png`);
const jsonPath = (motion: string, dir: Dir8, frame: number): string =>
  join(POSES_DIR, motion, dir, `${frame}.json`);

/**
 * `--blender` > $BLENDER > PATH > the Windows installer's default location
 * (newest version first). The Microsoft Store build is not usable: its exe is
 * ACL-locked and its launcher alias swallows stdout.
 */
export async function findBlender(explicit: string | undefined): Promise<string | undefined> {
  if (explicit) return explicit;
  if (process.env.BLENDER) return process.env.BLENDER;
  const onPath = Bun.which("blender");
  if (onPath) return onPath;
  if (process.platform !== "win32") return undefined;
  const root = "C:\\Program Files\\Blender Foundation";
  const hits = await Array.fromAsync(new Bun.Glob("Blender */blender.exe").scan({ cwd: root }));
  return hits.length ? join(root, hits.sort().at(-1)!) : undefined;
}

export async function run(argv: string[]): Promise<void> {
  const size = Number(flag(argv, "size") ?? 512);
  const elev = Number(flag(argv, "elev") ?? 25);
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

  if (!argv.includes("--skip-blender")) {
    const exe = await findBlender(flag(argv, "blender"));
    if (!exe) {
      console.error(`blender not found — install it, pass --blender <exe>, or set BLENDER`);
      process.exit(1);
    }
    await ensureDir(POSES_DIR);
    for (const source of SOURCES) {
      const batch = selected.filter((m) => (m.source ?? "mixamo") === source);
      if (!batch.length) continue;
      const motionsJson = join(POSES_DIR, `motions.${source}.json`);
      await Bun.write(
        motionsJson,
        JSON.stringify(
          batch.map(({ id, fbx, action, frames, loop }: Motion) => ({
            id,
            fbx,
            ...(action ? { action } : {}),
            frames: frames * HINT_STEP,
            loop,
          })),
        ),
      );
      console.log(`[poses] ${source}: ${batch.map((m) => m.id).join(", ")} via ${exe} ...`);
      const proc = Bun.spawn(
        [
          exe,
          "--background",
          "--python",
          SCRIPT,
          "--",
          "--out",
          POSES_DIR,
          "--motions",
          motionsJson,
          "--fbx-dir",
          join(REPO_ROOT, "motions", source),
          "--rig",
          source,
          "--size",
          String(size),
          "--elev",
          String(elev),
        ],
        { stdout: "inherit", stderr: "inherit" },
      );
      const code = await proc.exited;
      if (code !== 0) {
        console.error(`[poses] blender exited ${code}`);
        process.exit(1);
      }
    }
  }

  let n = 0;
  let missing = 0;
  for (const m of selected)
    for (const dir of DIRS8)
      for (let i = 0; i < m.frames * HINT_STEP; i++) {
        const src = Bun.file(jsonPath(m.id, dir, i));
        if (!(await src.exists())) {
          missing++;
          continue;
        }
        const raw = await src.json().catch(() => {
          throw new Error(`${m.id}/${dir}/${i}: not valid JSON`);
        });
        const pose = poseFromJson(raw, `${m.id}/${dir}/${i}`);
        const dest = posePath(m.id, dir, i);
        await ensureDir(dirname(dest));
        await Bun.write(dest, await renderPose(pose, size));
        n++;
      }
  console.log(`${n} poses -> out/poses/`);
  if (missing) {
    console.error(`${missing} frames have no JSON — see blender output above`);
    process.exitCode = 1;
  }
}
