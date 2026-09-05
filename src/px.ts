/**
 * `px` — the pixel-sprite pipeline as one CLI with subcommands.
 *
 *   bun run px concept scavenger
 *   bun run px poses
 *
 * Stages are imported lazily so a broken sibling cannot stop the working ones,
 * and so `--help` costs nothing.
 */

export const STAGES = {
  concept: () => import("./stages/concept"),
  dataset: () => import("./stages/dataset"),
  poses: () => import("./stages/poses"),
  sprites: () => import("./stages/sprites"),
  pixelate: () => import("./stages/pixelate"),
  sheet: () => import("./stages/sheet"),
} satisfies Record<string, () => Promise<{ run(argv: string[]): Promise<void> }>>;

export type Stage = keyof typeof STAGES;

export const usage = () => `usage: bun run px <${Object.keys(STAGES).join("|")}> [options]`;

if (import.meta.main) {
  const [stage, ...rest] = process.argv.slice(2);
  if (stage === undefined || !(stage in STAGES)) {
    console.error(stage === undefined ? usage() : `unknown stage "${stage}"\n${usage()}`);
    process.exit(1);
  }
  const mod = await STAGES[stage as Stage]();
  await mod.run(rest);
}
