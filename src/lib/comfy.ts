/** Shared ComfyUI plumbing for every stage. */

import { mkdir } from "node:fs/promises";
import { basename, join, relative } from "node:path";
import { CallWrapper, ComfyApi, type PromptBuilder } from "@saintno/comfyui-sdk";
import { OUT_DIR, REPO_ROOT } from "./paths";

export const COMFY = process.env.COMFY_URL ?? "http://127.0.0.1:8188";

export async function connect(): Promise<ComfyApi> {
  try {
    return await new ComfyApi(COMFY).init().waitForReady();
  } catch (e) {
    console.error(`ComfyUI unreachable at ${COMFY}: ${(e as Error).message}`);
    process.exit(1);
  }
}

export const ensureDir = (path: string) => mkdir(path, { recursive: true }).then(() => {});

/** `--name value` from argv; `alias` adds a short form (`-n`). */
export function flag(argv: string[], name: string, alias?: string): string | undefined {
  const i = argv.findIndex((a) => a === `--${name}` || (alias !== undefined && a === `-${alias}`));
  return i === -1 ? undefined : argv[i + 1];
}

/**
 * First argv token that is neither a flag nor a flag's value. `valueFlags` is
 * the set of flags that eat the next token; a flag missing from it swallows
 * its own value as the positional.
 */
export const positional = (argv: string[], valueFlags: Set<string>): string | undefined =>
  argv.find((a, i) => !a.startsWith("-") && !valueFlags.has(argv[i - 1] ?? ""));

/** Random 32-bit seed unless `--seed` pinned one. */
export function resolveSeed(argv: string[]): number {
  const pinned = flag(argv, "seed");
  return pinned === undefined ? Math.floor(Math.random() * 2 ** 32) : Number(pinned);
}

/** Push a local file into ComfyUI's input/ dir; returns the name LoadImage wants. */
export async function uploadImage(api: ComfyApi, path: string, name?: string): Promise<string> {
  const upload = await api.uploadImage(await Bun.file(path).arrayBuffer(), name ?? basename(path), {
    override: true,
  });
  if (!upload) throw new Error(`upload failed: ${path}`);
  return upload.info.filename;
}

// --- LoRA ------------------------------------------------------------------

export interface Lora {
  /** Exact filename ComfyUI knows, as LoraLoader wants it. */
  name: string;
  strength: number;
}

/** `name` or `name:0.7` -> query + strength. */
export function parseLora(spec: string): { query: string; strength: number } {
  const cut = spec.lastIndexOf(":");
  if (cut === -1) return { query: spec, strength: 1 };
  const strength = Number(spec.slice(cut + 1));
  if (Number.isNaN(strength))
    throw new Error(`bad lora ${JSON.stringify(spec)}, expected name or name:strength`);
  return { query: spec.slice(0, cut), strength };
}

/**
 * Case-insensitive substring over the normalised path; an exact basename match
 * wins outright. Ambiguity is an error rather than a first-match guess.
 */
export function matchLora(names: string[], query: string): string {
  const norm = (s: string) => s.replaceAll("\\", "/").toLowerCase();
  const q = norm(query);
  const base = (s: string) =>
    norm(s)
      .split("/")
      .pop()!
      .replace(/\.safetensors$/, "");

  const exact = names.filter((n) => base(n) === q);
  const hits = exact.length ? exact : names.filter((n) => norm(n).includes(q));

  if (!hits.length)
    throw new Error(`no LoRA matching ${JSON.stringify(query)}; have:\n  ${names.join("\n  ")}`);
  if (hits.length > 1)
    throw new Error(`lora ${JSON.stringify(query)} is ambiguous:\n  ${hits.join("\n  ")}`);
  return hits[0]!;
}

export async function resolveLoras(api: ComfyApi, specs: string[]): Promise<Lora[]> {
  if (!specs.length) return [];
  const names = await api.getLoras();
  return specs.map((spec) => {
    const { query, strength } = parseLora(spec);
    return { name: matchLora(names, query), strength };
  });
}

// --- run -------------------------------------------------------------------

/** Pull ComfyUI's outputs into out/ over HTTP, preserving the filename_prefix subfolder. */
export async function collectOutputs(files: string[]): Promise<string[]> {
  const saved: string[] = [];
  for (const file of files) {
    const cut = file.lastIndexOf("/");
    const subfolder = cut === -1 ? "" : file.slice(0, cut);
    const filename = cut === -1 ? file : file.slice(cut + 1);

    const query = new URLSearchParams({ filename, subfolder, type: "output" });
    const res = await fetch(`${COMFY}/view?${query}`);
    if (!res.ok) throw new Error(`could not fetch ${file}: HTTP ${res.status}`);

    const dest = join(OUT_DIR, subfolder, filename);
    await Bun.write(dest, res);
    saved.push(relative(REPO_ROOT, dest).replaceAll("\\", "/"));
  }
  return saved;
}

/**
 * Enqueue a workflow whose output map has an `images` key, wait, copy results
 * into out/, return repo-relative paths. onFailed also fires on websocket
 * drops the job survives, so it is only fatal when nothing came back.
 */
export async function runWorkflow(
  api: ComfyApi,
  workflow: PromptBuilder<never, "images", any, any>,
  label: string,
): Promise<string[]> {
  let failure: Error | undefined;

  const result = await new CallWrapper(api, workflow)
    .onProgress((p) => process.stdout.write(`\r[${label}] ${p.value}/${p.max}   `))
    .onFailed((e) => (failure = e))
    .run();

  const saved = result
    ? (result.images as { images?: { filename: string; subfolder: string }[] })
    : undefined;
  const files = (saved?.images ?? []).map((f) =>
    [f.subfolder, f.filename].filter(Boolean).join("/"),
  );

  if (!files.length) throw new Error(failure?.message ?? "no output");
  return collectOutputs(files);
}
