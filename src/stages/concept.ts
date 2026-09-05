// src/stages/concept.ts
/**
 * `px concept <char>` — candidate hero images for a character.
 *
 *   bun run px concept scavenger
 *   bun run px concept scavenger -n 8 --seed 42
 *   bun run px concept scavenger --dry        # print the graph, no server
 *
 * Plain SD1.5 t2i: no LoRA, no ControlNet. The suffix forces the shape the
 * dataset stage wants — full body, front, flat grey backdrop.
 */

import { connect, flag, positional, resolveSeed, runWorkflow } from "../lib/comfy";
import { genPrefix } from "../lib/paths";
import { loadChar } from "../lib/chars";
import { buildSd15 } from "../lib/sd15";

const DEFAULT_CKPT = "SD1.5\\dreamshaper_8.safetensors";
const SUFFIX = "full body, standing straight, front view, flat grey background, even lighting";
const VALUE_FLAGS = new Set(["--count", "-n", "--seed", "--ckpt", "--steps", "--cfg"]);

const usage = () =>
  `usage: bun run px concept <char> [-n|--count 4] [--seed n] [--ckpt file] [--steps 25] [--cfg 6] [--dry]`;

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

  const seed = resolveSeed(argv);
  const workflow = buildSd15({
    ckpt: flag(argv, "ckpt") ?? DEFAULT_CKPT,
    positive: `${char.positive}, ${SUFFIX}`,
    negative: char.negative,
    width: 512,
    height: 768,
    count: Number(flag(argv, "count", "n") ?? 4),
    seed,
    steps: flag(argv, "steps") ? Number(flag(argv, "steps")) : undefined,
    cfg: flag(argv, "cfg") ? Number(flag(argv, "cfg")) : undefined,
    prefix: genPrefix("concept", char.name, char.name),
  });

  if (argv.includes("--dry")) {
    console.log(JSON.stringify(workflow.prompt, null, 2));
    return;
  }

  const api = await connect();
  console.log(`[concept] ${char.name} seed ${seed} enqueueing...`);
  try {
    const files = await runWorkflow(api, workflow, "concept");
    console.log("");
    for (const f of files) console.log(`  ${f}`);
    console.log(`\nnext: pick one and run  bun run px dataset ${char.name} --hero <that file>`);
  } catch (e) {
    console.error(`\r[concept] failed: ${(e as Error).message}`);
    process.exitCode = 1;
  }
  api.destroy();
}
