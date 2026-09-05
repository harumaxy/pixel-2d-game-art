// src/stages/clean.ts
/**
 * `px clean` — remove generated files under out/.
 *
 *   bun run px clean                       # list what exists, delete nothing
 *   bun run px clean scavenger             # this character's concept/sprites/px/sheet
 *   bun run px clean scavenger --dataset   # ...and its curated dataset + train.yaml
 *   bun run px clean --all                 # everything except datasets
 *   bun run px clean --all --dataset       # everything
 *   bun run px clean --stage sprites,px    # only these stages (any of the above)
 *   bun run px clean ... --dry             # print what would go
 *
 * Datasets are the one output that carries hand work (the eyeballed cull), so
 * they are only touched with --dataset. out/gen itself is a junction onto
 * ComfyUI's output/px and is never removed — only its children are.
 */

import { readdir, rm, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import { flag, positional } from "../lib/comfy";
import { GEN_DIR, OUT_DIR, REPO_ROOT } from "../lib/paths";

/** Stage id -> the directory it writes into, and whether it is per-character. */
const STAGES = {
  concept: { dir: join(GEN_DIR, "concept"), perChar: true },
  dataset: { dir: join(GEN_DIR, "dataset"), perChar: true },
  sprites: { dir: join(GEN_DIR, "sprites"), perChar: true },
  poses: { dir: join(OUT_DIR, "poses"), perChar: false },
  px: { dir: join(OUT_DIR, "px"), perChar: true },
  sheets: { dir: join(OUT_DIR, "sheets"), perChar: true },
} as const;
type StageId = keyof typeof STAGES;

const VALUE_FLAGS = new Set(["--stage"]);
const ids = () => Object.keys(STAGES) as StageId[];
const rel = (p: string) => relative(REPO_ROOT, p).replaceAll("\\", "/");

const usage = () =>
  `usage: bun run px clean [<char>] [--all] [--dataset] [--stage ${ids().join(",")}] [--dry]`;

/** Bytes and file count under `path` (0/0 when absent). */
async function measure(path: string): Promise<{ files: number; bytes: number }> {
  let files = 0;
  let bytes = 0;
  const walk = async (p: string) => {
    const entries = await readdir(p, { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      const full = join(p, e.name);
      if (e.isDirectory()) await walk(full);
      else {
        files++;
        bytes += (await stat(full).catch(() => ({ size: 0 }))).size;
      }
    }
  };
  await walk(path);
  return { files, bytes };
}

const mb = (b: number) => `${(b / 1024 / 1024).toFixed(1)} MB`;

/** What `clean` would remove for one stage: the char's subtree, or the stage's children. */
async function targets(id: StageId, char: string | undefined): Promise<string[]> {
  const { dir, perChar } = STAGES[id];
  if (!perChar) return [dir];
  if (char === undefined) {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    return entries.map((e) => join(dir, e.name));
  }
  if (id === "sheets") return [join(dir, `${char}.png`), join(dir, `${char}.json`)];
  return [join(dir, char)];
}

export async function run(argv: string[]): Promise<void> {
  const char = positional(argv, VALUE_FLAGS);
  const all = argv.includes("--all");
  const withDataset = argv.includes("--dataset");
  const dry = argv.includes("--dry");

  const stageFlag = flag(argv, "stage");
  const selected = stageFlag ? (stageFlag.split(",").map((s) => s.trim()) as StageId[]) : ids();
  const unknown = selected.filter((s) => !Object.hasOwn(STAGES, s));
  if (unknown.length) {
    console.error(
      `unknown --stage ${unknown.join(", ")}; expected ${ids().join(", ")}\n${usage()}`,
    );
    process.exit(1);
  }

  // No target named: report and stop. Deleting everything must be asked for.
  if (!char && !all) {
    console.log("generated output (nothing deleted — pass <char> or --all):");
    for (const id of ids()) {
      const { files, bytes } = await measure(STAGES[id].dir);
      if (files)
        console.log(
          `  ${rel(STAGES[id].dir).padEnd(18)} ${String(files).padStart(5)} files  ${mb(bytes)}`,
        );
    }
    console.log(`\n${usage()}`);
    return;
  }

  const stages = selected.filter((id) => {
    if (id === "dataset" && !withDataset && !stageFlag?.includes("dataset")) return false;
    if (id === "poses" && char !== undefined && !stageFlag) return false; // poses are not per-char
    return true;
  });

  let removed = 0;
  let bytes = 0;
  for (const id of stages)
    for (const t of await targets(id, char)) {
      const m = await measure(t);
      const exists = m.files > 0 || (await stat(t).catch(() => undefined)) !== undefined;
      if (!exists) continue;
      console.log(
        `${dry ? "would remove" : "removing"}  ${rel(t)}  (${m.files} files, ${mb(m.bytes)})`,
      );
      if (!dry) await rm(t, { recursive: true, force: true });
      removed += m.files;
      bytes += m.bytes;
    }

  if (!removed) {
    console.log(`nothing to remove for ${char ?? "--all"}`);
    return;
  }
  console.log(`${dry ? "would free" : "freed"} ${mb(bytes)} (${removed} files)`);
  if (!withDataset && stages.every((s) => s !== "dataset"))
    console.log("datasets kept — add --dataset to remove them too");
}
