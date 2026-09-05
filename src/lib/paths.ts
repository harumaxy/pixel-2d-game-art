import { join } from "node:path";

/** Repo root resolved from this file, not cwd — `bun run` inherits whatever cwd the shell had. */
export const REPO_ROOT = join(import.meta.dir, "../..");
export const OUT_DIR = join(REPO_ROOT, "out");
export const CHARS_DIR = join(REPO_ROOT, "chars");
export const PALETTES_DIR = join(REPO_ROOT, "palettes");
