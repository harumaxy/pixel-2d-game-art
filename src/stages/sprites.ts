// src/stages/sprites.ts
/**
 * `px sprites <char> [--motion walk] [--dir down] [--seed n] [--strength 0.65] [--dry]`
 *
 * One SD1.5 generation per (motion, dir, frame): character LoRA + the
 * pre-rendered openpose skeleton. The seed is fixed per (char, motion) so the
 * only thing that changes between frames is the skeleton.
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
import { loadChar } from "../lib/chars";
import { buildSd15 } from "../lib/sd15";
import { DIRS5, MOTIONS, type Dir5 } from "../motions";
import { posePath } from "./poses";

const DEFAULT_CKPT = "aziibpixelmix_v10.safetensors";
const SUFFIX =
  "full body, chibi, 2 heads tall, flat grey background, no shadow, centered, pixel art style";
const VALUE_FLAGS = new Set([
  "--motion",
  "--dir",
  "--seed",
  "--strength",
  "--ckpt",
  "--steps",
  "--cfg",
]);

const usage = () =>
  `usage: bun run px sprites <char> [--motion ${MOTIONS.map((m) => m.id).join("|")}] [--dir ${DIRS5.join("|")}]\n` +
  `                          [--seed n] [--strength 0.65] [--ckpt file] [--steps 25] [--cfg 6] [--dry]`;

/** Seed per (char, motion): base seed from --seed or random, plus a stable per-motion offset. */
export const motionSeed = (base: number, motionIndex: number) =>
  (base + motionIndex * 1000) % 2 ** 32;

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
  const dirFlag = flag(argv, "dir") as Dir5 | undefined;
  const dirs: readonly Dir5[] = dirFlag ? [dirFlag] : DIRS5;
  if (dirFlag && !DIRS5.includes(dirFlag)) {
    console.error(`unknown --dir ${dirFlag}\n${usage()}`);
    process.exit(1);
  }

  // Every skeleton must exist before we touch the server.
  for (const m of motions)
    for (const dir of dirs)
      for (let i = 0; i < m.frames; i++)
        if (!(await Bun.file(posePath(m.id, dir, i)).exists())) {
          console.error(`missing ${posePath(m.id, dir, i)} — run  bun run px poses  first`);
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

  const baseSeed = resolveSeed(argv);
  const strength = Number(flag(argv, "strength") ?? 0.65);
  const ckpt = flag(argv, "ckpt") ?? DEFAULT_CKPT;
  const steps = flag(argv, "steps") ? Number(flag(argv, "steps")) : undefined;
  const cfg = flag(argv, "cfg") ? Number(flag(argv, "cfg")) : undefined;

  let done = 0,
    failed = 0;
  for (const m of motions) {
    const seed = motionSeed(baseSeed, MOTIONS.indexOf(m));
    for (const dir of dirs)
      for (let i = 0; i < m.frames; i++) {
        const pose = posePath(m.id, dir, i);
        const label = `${m.id}/${dir}/${i}`;
        const poseName = `${m.id}_${dir}_${i}.png`;
        try {
          const image = api ? await uploadImage(api, pose, poseName) : poseName;
          const workflow = buildSd15({
            ckpt,
            positive: `${char.trigger}, ${char.positive}, ${m.prompt}, ${SUFFIX}`,
            negative: `${char.negative}, black background`,
            width: 512,
            height: 512,
            count: 1,
            seed,
            steps,
            cfg,
            prefix: `sprites/${char.name}/${m.id}/${dir}/${i}`,
            loras,
            control: { image, strength },
          });

          if (dry) {
            console.log(JSON.stringify(workflow.prompt, null, 2));
            continue;
          }
          const files = await runWorkflow(api!, workflow, label);
          console.log(`\r  ${files.join(", ")}`);
          done++;
        } catch (e) {
          console.error(`\r[${label}] failed: ${(e as Error).message}`);
          failed++;
        }
      }
  }

  api?.destroy();
  if (dry) return;
  console.log(`\n${done} frames -> out/sprites/${char.name}/  (base seed ${baseSeed})`);
  if (failed) {
    console.error(`${failed}/${done + failed} frames failed`);
    process.exitCode = 1;
  }
}
