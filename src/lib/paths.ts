import { join } from "node:path";

/** Repo root resolved from this file, not cwd — `bun run` inherits whatever cwd the shell had. */
export const REPO_ROOT = join(import.meta.dir, "../..");
export const OUT_DIR = join(REPO_ROOT, "out");
export const CHARS_DIR = join(REPO_ROOT, "chars");
export const PALETTES_DIR = join(REPO_ROOT, "palettes");

/**
 * Where ComfyUI-generated images live on our side. Meant to be a directory
 * junction onto `<ComfyUI output>/px/` so the files exist once; without the
 * junction collectOutputs falls back to copying over HTTP into the same path.
 */
export const GEN_DIR = join(OUT_DIR, "gen");

/** Namespace every SaveImage prefix under, so our files sit apart from other projects in ComfyUI's output/. */
export const GEN_PREFIX = "px";

/** SaveImage filename_prefix for a path under GEN_DIR: genPrefix("concept", "scav", "scav") -> "px/concept/scav/scav". */
export const genPrefix = (...parts: string[]): string => [GEN_PREFIX, ...parts].join("/");
