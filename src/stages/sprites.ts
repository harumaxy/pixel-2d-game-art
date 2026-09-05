// src/stages/sprites.ts
/**
 * `px sprites <char> [--motion walk] [--dir down] [--seed n] [--strength 0.6] [--depth-strength 0.5]
 *                    [--ref out/hero/<char>.png] [--ref-weight 0.7] [--matte toonout|rmbg2|none]
 *                    [--batch] [--style-aligned] [--anim] [--dry]`
 *
 * One SD1.5 generation per (motion, dir, frame): character LoRA + IP-Adapter
 * reference (the hero image, so colours and outfit stay put between frames)
 * + openpose ControlNet + depth ControlNet, both hints pre-rendered by
 * `px poses` from Mixamo. The seed is fixed per (char, motion) so the only
 * thing that changes between frames is the skeleton. The render is matted
 * on the server (RGBA), so pixelate can trust the alpha instead of keying.
 *
 * --batch renders every frame of a (motion, dir) in one batch instead; that
 * is what --style-aligned (shared attention) and --anim (AnimateDiff) need
 * to hold the frames together. Note frame i then gets noise seed+i, so a
 * batch and a per-frame run of the same seed are not the same images.
 */

import {
  connect,
  flag,
  positional,
  resolveLoras,
  resolveSeed,
  runWorkflow,
  uploadImage,
} from "../lib/comfy";
import { join } from "node:path";
import { loadChar } from "../lib/chars";
import { genPrefix, OUT_DIR } from "../lib/paths";
import {
  buildSd15,
  SD15_ANIMATEDIFF,
  SD15_CONTROLNET_DEPTH,
  SD15_CONTROLNET_OPENPOSE,
  type Control,
  type Matte,
} from "../lib/sd15";
import { GEN_DIRS, MOTIONS, type GenDir } from "../motions";
import { depthPath, posePath } from "./poses";

/**
 * A smooth, photoreal-ish fine-tune, not a pixel-art one: pixelate does the
 * pixelating, and a pseudo-pixel render only fights the 64px grid. Fine-tunes
 * also hold a ControlNet pose better than base 1.5 once the hint releases.
 */
const DEFAULT_CKPT = "SD1.5\\realisticVisionV60B1_v51VAE.safetensors";
const SUFFIX = "full body, flat grey background, no shadow, centered";
/**
 * Photoreal checkpoints like to litter the ground, and the motion module
 * explains an airborne pose with a rope and paints a stained wall behind;
 * the matte would keep every pebble, rope and stain.
 */
const NEGATIVE =
  "black background, debris, rocks, objects on ground, (rope:1.5), (wire:1.5), (harness:1.5), (cable:1.5), " +
  "textured wall, stained wall, cliff, shadow";
const VALUE_FLAGS = new Set([
  "--motion",
  "--dir",
  "--seed",
  "--strength",
  "--depth-strength",
  "--ref",
  "--ref-weight",
  "--ckpt",
  "--steps",
  "--cfg",
  "--matte",
]);
const MATTES = ["toonout", "rmbg2", "none"] as const;

/** Where `px dataset` left the hero image; the default IP-Adapter reference. */
export const heroPath = (char: string): string => join(OUT_DIR, "hero", `${char}.png`);

const usage = () =>
  `usage: bun run px sprites <char> [--motion ${MOTIONS.map((m) => m.id).join("|")}] [--dir ${GEN_DIRS.join("|")}]\n` +
  `                          [--seed n] [--strength 0.6] [--depth-strength 0.5] [--ref out/hero/<char>.png] [--ref-weight 0.7]\n` +
  `                          [--ckpt file] [--steps 25] [--cfg 6] [--matte ${MATTES.join("|")}]\n` +
  `                          [--batch] [--style-aligned] [--anim] [--dry]`;

/** Seed per (char, motion): base seed from --seed or random, plus a stable per-motion offset. */
export const motionSeed = (base: number, motionIndex: number) =>
  (base + motionIndex * 1000) % 2 ** 32;

/** The skeleton carries no face when seen from behind, so the prompt has to say it. */
export function spritePrompt(
  char: { trigger: string; positive: string },
  motionPrompt: string,
  dir: GenDir,
): string {
  const view = dir === "up" || dir === "upright" ? ", from behind, back view" : "";
  return `${char.trigger}, ${char.positive}, ${motionPrompt}${view}, ${SUFFIX}`;
}

export async function run(argv: string[]): Promise<void> {
  const name = positional(argv, VALUE_FLAGS);
  if (!name) {
    console.error(usage());
    process.exit(1);
  }

  let char;
  try {
    char = await loadChar(name);
  } catch (e) {
    console.error((e as Error).message);
    process.exit(1);
  }
  if (!char.lora) {
    console.error(
      `chars/${char.name}.yaml has no  lora:  — train one first (bun run px dataset ${char.name} --hero ...)`,
    );
    process.exit(1);
  }

  const motionFlag = flag(argv, "motion");
  const motions = motionFlag ? MOTIONS.filter((m) => m.id === motionFlag) : MOTIONS;
  if (!motions.length) {
    console.error(`unknown --motion ${motionFlag}\n${usage()}`);
    process.exit(1);
  }
  const dirFlag = flag(argv, "dir") as GenDir | undefined;
  const dirs: readonly GenDir[] = dirFlag ? [dirFlag] : GEN_DIRS;
  if (dirFlag && !GEN_DIRS.includes(dirFlag)) {
    console.error(`unknown --dir ${dirFlag}\n${usage()}`);
    process.exit(1);
  }

  const strength = Number(flag(argv, "strength") ?? 0.6);
  const depthStrength = Number(flag(argv, "depth-strength") ?? 0.5);
  const refWeight = Number(flag(argv, "ref-weight") ?? 0.7);
  if (Number.isNaN(strength) || Number.isNaN(depthStrength) || Number.isNaN(refWeight)) {
    console.error(`--strength / --depth-strength / --ref-weight must be numbers\n${usage()}`);
    process.exit(1);
  }
  // --ref-weight 0 turns the reference off; an explicit --ref must exist, the default may not.
  const refFlag = flag(argv, "ref");
  const refFile = refWeight > 0 ? (refFlag ?? heroPath(char.name)) : undefined;
  if (refFile && !(await Bun.file(refFile).exists())) {
    if (refFlag) {
      console.error(`no such file: ${refFile}`);
      process.exit(1);
    }
    console.error(`[sprites] no ${refFile}; generating without a reference image`);
  }
  const refPath = refFile && (await Bun.file(refFile).exists()) ? refFile : undefined;

  // Every hint must exist before we touch the server.
  for (const m of motions)
    for (const dir of dirs)
      for (let i = 0; i < m.frames; i++)
        for (const p of [
          posePath(m.id, dir, i),
          ...(depthStrength > 0 ? [depthPath(m.id, dir, i)] : []),
        ])
          if (!(await Bun.file(p).exists())) {
            console.error(`missing ${p} — run  bun run px poses  first`);
            process.exit(1);
          }

  const dry = argv.includes("--dry");
  const api = dry ? undefined : await connect();

  let loras;
  try {
    loras = api
      ? await resolveLoras(api, [`${char.lora}:${char.strength}`])
      : [{ name: char.lora, strength: char.strength }];
  } catch (e) {
    console.error((e as Error).message);
    process.exit(1);
  }

  // One upload for the whole run; every frame references the same image.
  const ref = refPath
    ? {
        image: api
          ? await uploadImage(api, refPath, `${char.name}_ref.png`)
          : `${char.name}_ref.png`,
        weight: refWeight,
      }
    : undefined;

  const baseSeed = resolveSeed(argv);
  const ckpt = flag(argv, "ckpt") ?? DEFAULT_CKPT;
  const steps = flag(argv, "steps") ? Number(flag(argv, "steps")) : undefined;
  const cfg = flag(argv, "cfg") ? Number(flag(argv, "cfg")) : undefined;
  const styleAligned = argv.includes("--style-aligned");
  const animateDiff = argv.includes("--anim") ? SD15_ANIMATEDIFF : undefined;
  // ToonOut is tuned on anime and keeps the motion module's wall stains as subject; Bria's does not.
  const matteFlag = (flag(argv, "matte") ??
    (animateDiff ? "rmbg2" : "toonout")) as (typeof MATTES)[number];
  if (!MATTES.includes(matteFlag)) {
    console.error(`unknown --matte ${matteFlag}\n${usage()}`);
    process.exit(1);
  }
  const matte: Matte | undefined = matteFlag === "none" ? undefined : matteFlag;
  const batch = argv.includes("--batch") || styleAligned || !!animateDiff;

  const upload = async (path: string, name: string) => (api ? uploadImage(api, path, name) : name);

  let done = 0,
    failed = 0;
  for (const m of motions) {
    const seed = motionSeed(baseSeed, MOTIONS.indexOf(m));
    const all = [...Array(m.frames).keys()];
    // Per-frame runs, or the whole motion as one batch.
    const groups = batch ? [all] : all.map((i) => [i]);
    for (const dir of dirs)
      for (const frames of groups) {
        const label = batch ? `${m.id}/${dir}` : `${m.id}/${dir}/${frames[0]}`;
        const stem = (i: number) => `${m.id}_${dir}_${i}`;
        try {
          const controls: Control[] = [
            {
              model: SD15_CONTROLNET_OPENPOSE,
              image: await Promise.all(
                frames.map((i) => upload(posePath(m.id, dir, i), `${stem(i)}.png`)),
              ),
              strength,
            },
          ];
          if (depthStrength > 0)
            controls.push({
              model: SD15_CONTROLNET_DEPTH,
              image: await Promise.all(
                frames.map((i) => upload(depthPath(m.id, dir, i), `${stem(i)}.depth.png`)),
              ),
              strength: depthStrength,
            });
          const workflow = buildSd15({
            ckpt,
            positive: spritePrompt(char, m.prompt, dir),
            negative: `${char.negative}, ${NEGATIVE}`,
            width: 512,
            height: 512,
            count: frames.length,
            seed,
            steps,
            cfg,
            prefix: frames.map((i) => genPrefix("sprites", char.name, m.id, dir, String(i))),
            loras,
            ref,
            controls,
            matte,
            styleAligned,
            animateDiff,
          });

          if (dry) {
            console.log(JSON.stringify(workflow.prompt, null, 2));
            continue;
          }
          const files = await runWorkflow(api!, workflow, label);
          console.log(`\r  ${files.join(", ")}`);
          done += frames.length;
        } catch (e) {
          console.error(`\r[${label}] failed: ${(e as Error).message}`);
          failed += frames.length;
        }
      }
  }

  api?.destroy();
  if (dry) return;
  console.log(`\n${done} frames -> out/gen/sprites/${char.name}/  (base seed ${baseSeed})`);
  if (failed) {
    console.error(`${failed}/${done + failed} frames failed`);
    process.exitCode = 1;
  }
}
