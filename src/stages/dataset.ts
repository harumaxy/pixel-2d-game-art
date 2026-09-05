/**
 * `px dataset <char> --hero <png>` — one hero image -> an ai-toolkit dataset.
 *
 *   bun run px dataset scavenger --hero out/concept/scavenger/scavenger_00002_.png
 *   bun run px dataset scavenger --hero hero.png --only side,back,portrait
 *   bun run px dataset scavenger --hero hero.png --dry
 *   bun run px dataset scavenger --hero hero.png --engine qwen      (Qwen Image Edit instead of FLUX.2 Klein 9B)
 *
 * Writes out/dataset/<char>/: source.png (the hero, copied), one image + one
 * same-named .txt per variation, and train.yaml. Training itself is manual.
 */

import { basename, join } from "node:path";
import {
  connect,
  ensureDir,
  flag,
  positional,
  resolveSeed,
  runWorkflow,
  uploadImage,
} from "../lib/comfy";
import { loadChar } from "../lib/chars";
import { caption, SOURCE_CAPTION, trainYaml, VARIATIONS, type VariationId } from "../lib/dataset";
import { GEN_DIR, REPO_ROOT, genPrefix } from "../lib/paths";
import { buildFlux2Edit, type KleinModel } from "../lib/flux2-edit";
import { buildQwenEdit } from "../lib/qwen-edit";

const VALUE_FLAGS = new Set(["--hero", "--only", "--seed", "--engine"]);
type Engine = "qwen" | KleinModel;
const ENGINES: Engine[] = ["qwen", "klein4b", "klein9b"];
// klein9b: ~5x faster than qwen at near-equal quality (measured 2026-09-05). klein4b breaks poses.
const DEFAULT_ENGINE: Engine = "klein9b";
const ids = () => Object.keys(VARIATIONS) as VariationId[];

const usage = () =>
  `usage: bun run px dataset <char> --hero hero.png [--only ${ids().slice(0, 3).join(",")},...] [--seed n] [--dry]\n` +
  `       variations: ${ids().join(", ")}`;

export async function run(argv: string[]): Promise<void> {
  const name = positional(argv, VALUE_FLAGS);
  const heroPath = flag(argv, "hero");
  if (!name || !heroPath) {
    console.error(usage());
    process.exit(1);
  }
  if (!(await Bun.file(heroPath).exists())) {
    console.error(`no such file: ${heroPath}`);
    process.exit(1);
  }

  let char;
  try {
    char = await loadChar(name);
  } catch (e) {
    console.error((e as Error).message);
    process.exit(1);
  }

  const onlyFlag = flag(argv, "only");
  const selected =
    onlyFlag === undefined ? ids() : (onlyFlag.split(",").map((s) => s.trim()) as VariationId[]);
  const unknown = selected.filter((v) => !Object.hasOwn(VARIATIONS, v));
  if (unknown.length) {
    console.error(`unknown --only ${unknown.join(", ")}; expected ${ids().join(", ")}`);
    process.exit(1);
  }

  const engine = (flag(argv, "engine") ?? DEFAULT_ENGINE) as Engine;
  if (!ENGINES.includes(engine)) {
    console.error(`unknown --engine ${engine}; expected ${ENGINES.join(", ")}`);
    process.exit(1);
  }

  const dry = argv.includes("--dry");
  const api = dry ? undefined : await connect();
  let image: string;
  if (api) {
    try {
      image = await uploadImage(api, heroPath);
    } catch (e) {
      console.error(`upload failed: ${(e as Error).message}`);
      process.exit(1);
    }
  } else {
    image = basename(heroPath);
  }
  const baseSeed = resolveSeed(argv);
  const dir = join(GEN_DIR, "dataset", char.name);

  if (!dry) {
    await ensureDir(dir);
    await Bun.write(join(dir, "source.png"), Bun.file(heroPath));
    await Bun.write(join(dir, "source.txt"), caption(SOURCE_CAPTION, char.trigger));
    await Bun.write(
      join(dir, "train.yaml"),
      trainYaml({ name: char.name, trigger: char.trigger, datasetDir: dir.replaceAll("\\", "/") }),
    );
    console.log("  source.png (copied), train.yaml");
  }

  let failed = 0;
  for (const id of selected) {
    const opts = {
      image,
      prompt: VARIATIONS[id].prompt,
      seed: baseSeed + ids().indexOf(id),
      // Non-default engines get a suffix so the two can sit side by side for comparison.
      prefix: genPrefix("dataset", char.name, engine === DEFAULT_ENGINE ? id : `${id}-${engine}`),
    };
    const workflow =
      engine === "qwen" ? buildQwenEdit(opts) : buildFlux2Edit({ ...opts, model: engine });

    if (dry) {
      console.log(JSON.stringify(workflow.prompt, null, 2));
      continue;
    }

    try {
      const files = await runWorkflow(api!, workflow, id);
      // ai-toolkit pairs captions by filename, so follow whatever counter SaveImage used.
      for (const f of files)
        await Bun.write(
          join(REPO_ROOT, f.replace(/\.png$/, ".txt")),
          caption(VARIATIONS[id].caption, char.trigger),
        );
      console.log(`\r  ${files.map((f) => basename(f)).join(", ")}`);
    } catch (e) {
      console.error(`\r[${id}] failed: ${(e as Error).message}`);
      failed++;
    }
  }

  api?.destroy();
  if (dry) return;

  console.log(`\ndataset: ${dir}`);
  if (failed) {
    console.error(`${failed}/${selected.length} variations failed`);
    process.exitCode = 1;
  }
  console.log(
    `next: DELETE every image where the character drifted, then train:\n` +
      `      python run.py "${dir.replaceAll("\\", "/")}/train.yaml"   (from your ai-toolkit checkout)\n` +
      `      copy the .safetensors into ComfyUI's loras/ and add  lora: ${char.name}  to chars/${char.name}.yaml`,
  );
}
