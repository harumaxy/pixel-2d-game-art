// src/stages/sprites.ts
/**
 * `px sprites <char> [--motion walk,run] [--dir down] [--seed n] [--strength 0.6] [--depth-strength 0.5]
 *                    [--ref out/hero/<char>.png] [--ref-weight 0.7] [--matte rmbg2|toonout|none]
 *                    [--ckpt file] [--steps 25] [--cfg 6] [--dry]`
 *
 * One SD1.5 AnimateDiff clip per (motion, dir): character LoRA + the motion
 * module's domain adapter + IP-Adapter reference (the hero image, so colours
 * and outfit stay put between frames) + openpose ControlNet + depth
 * ControlNet, both hints pre-rendered by `px poses` from Mixamo. The motion
 * module is what keeps a run's head and a crouch's pose intact from frame to
 * frame; the clip is generated at HINT_STEP x the frame count (the module's
 * native 16) and only every HINT_STEP-th frame is saved. The seed is fixed
 * per (char, motion); frame i gets noise seed+i. The render is matted on the
 * server (RGBA), so pixelate can trust the alpha instead of keying.
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
  SD15_ANIMATEDIFF_ADAPTER,
  SD15_ANIMATEDIFF_ADAPTER_STRENGTH,
  SD15_CONTROLNET_DEPTH,
  SD15_CONTROLNET_OPENPOSE,
  type Control,
  type Matte,
} from "../lib/sd15";
import { GEN_DIRS, HINT_STEP, MOTIONS, type GenDir } from "../motions";
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
const MATTES = ["rmbg2", "toonout", "none"] as const;

/** Where `px dataset` left the hero image; the default IP-Adapter reference. */
export const heroPath = (char: string): string => join(OUT_DIR, "hero", `${char}.png`);

const usage = () =>
  `usage: bun run px sprites <char> [--motion ${MOTIONS.map((m) => m.id).join(",")}] [--dir ${GEN_DIRS.join("|")}]\n` +
  `                          [--seed n] [--strength 0.6] [--depth-strength 0.5] [--ref out/hero/<char>.png] [--ref-weight 0.7]\n` +
  `                          [--ckpt file] [--steps 25] [--cfg 6] [--matte ${MATTES.join("|")}] [--dry]`;

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
  const wanted = motionFlag?.split(",");
  const motions = wanted ? MOTIONS.filter((m) => wanted.includes(m.id)) : MOTIONS;
  if (!motions.length || (wanted && motions.length !== wanted.length)) {
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
  if ([strength, depthStrength, refWeight].some((n) => Number.isNaN(n))) {
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

  // ToonOut is tuned on anime and keeps the motion module's wall stains as subject; Bria's does not.
  const matteFlag = (flag(argv, "matte") ?? "rmbg2") as (typeof MATTES)[number];
  if (!MATTES.includes(matteFlag)) {
    console.error(`unknown --matte ${matteFlag}\n${usage()}`);
    process.exit(1);
  }
  const matte: Matte | undefined = matteFlag === "none" ? undefined : matteFlag;
  /** Every rendered hint of the motion: the module wants the whole clip. */
  const hintFrames = (m: { frames: number }) => [...Array(m.frames * HINT_STEP).keys()];

  // Every hint must exist before we touch the server.
  for (const m of motions)
    for (const dir of dirs)
      for (const k of hintFrames(m))
        for (const p of [
          posePath(m.id, dir, k),
          ...(depthStrength > 0 ? [depthPath(m.id, dir, k)] : []),
        ])
          if (!(await Bun.file(p).exists())) {
            console.error(`missing ${p} — run  bun run px poses  first`);
            process.exit(1);
          }

  const dry = argv.includes("--dry");
  const api = dry ? undefined : await connect();

  const loraSpecs = [
    `${char.lora}:${char.strength}`,
    `${SD15_ANIMATEDIFF_ADAPTER}:${SD15_ANIMATEDIFF_ADAPTER_STRENGTH}`,
  ];
  let loras;
  try {
    loras = api
      ? await resolveLoras(api, loraSpecs)
      : [
          { name: char.lora, strength: char.strength },
          { name: SD15_ANIMATEDIFF_ADAPTER, strength: SD15_ANIMATEDIFF_ADAPTER_STRENGTH },
        ];
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

  const upload = async (path: string, name: string) => (api ? uploadImage(api, path, name) : name);

  let done = 0,
    failed = 0;
  for (const m of motions) {
    const seed = motionSeed(baseSeed, MOTIONS.indexOf(m));
    const frames = hintFrames(m);
    for (const dir of dirs) {
      const label = `${m.id}/${dir}`;
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
          prefix: frames.map((k) =>
            k % HINT_STEP
              ? undefined
              : genPrefix("sprites", char.name, m.id, dir, String(k / HINT_STEP)),
          ),
          loras,
          ref,
          controls,
          matte,
          animateDiff: SD15_ANIMATEDIFF,
        });

        if (dry) {
          console.log(JSON.stringify(workflow.prompt, null, 2));
          continue;
        }
        const files = await runWorkflow(api!, workflow, label);
        console.log(`\r  ${files.join(", ")}`);
        done += m.frames;
      } catch (e) {
        console.error(`\r[${label}] failed: ${(e as Error).message}`);
        failed += m.frames;
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
