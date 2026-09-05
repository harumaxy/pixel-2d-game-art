/**
 * chars/<name>.yaml -> Char. One file per character; every stage reads it so
 * the prompt and LoRA name are typed once, not per command line.
 */

import { join } from "node:path";
import { CHARS_DIR } from "./paths";

const KNOWN = ["name", "trigger", "lora", "strength", "positive", "negative"] as const;
type Key = (typeof KNOWN)[number];

export interface Char {
  name: string;
  /** LoRA trigger word; used in dataset captions and every sprite prompt. */
  trigger: string;
  /** Fragment of the LoRA filename in ComfyUI's loras/ dir; absent until trained. */
  lora?: string;
  strength: number;
  positive: string;
  negative: string;
}

/** One tag per line -> one comma-separated run; `#` / `//` to end of line is a comment. */
function joinTags(body: unknown): string {
  return String(body ?? "")
    .split("\n")
    .map((line) =>
      line
        .replace(/(#|\/\/).*$/, "")
        .trim()
        .replace(/,+$/, ""),
    )
    .filter(Boolean)
    .join(", ");
}

export function parseChar(src: string, label = "<string>"): Char {
  const doc = Bun.YAML.parse(src);
  if (doc === null || typeof doc !== "object" || Array.isArray(doc))
    throw new Error(`${label}: expected a YAML mapping of ${KNOWN.join(", ")}`);
  const f = doc as Record<string, unknown>;

  for (const key of Object.keys(f))
    if (!KNOWN.includes(key as Key))
      throw new Error(`${label}: unknown key "${key}", expected one of ${KNOWN.join(", ")}`);

  const req = (key: "name" | "trigger"): string => {
    const v = String(f[key] ?? "").trim();
    if (!v) throw new Error(`${label}: "${key}" is required`);
    return v;
  };

  const positive = joinTags(f.positive);
  if (!positive) throw new Error(`${label}: "positive" is required and cannot be empty`);

  const strength = f.strength == null ? 0.8 : Number(f.strength);
  if (Number.isNaN(strength)) throw new Error(`${label}: "strength" must be a number`);

  return {
    name: req("name"),
    trigger: req("trigger"),
    lora: f.lora == null ? undefined : String(f.lora).trim() || undefined,
    strength,
    positive,
    negative: joinTags(f.negative),
  };
}

export async function loadChar(name: string): Promise<Char> {
  const id = name.replace(/\.yaml$/, "");
  const file = Bun.file(join(CHARS_DIR, `${id}.yaml`));
  if (!(await file.exists())) throw new Error(`no such character: chars/${id}.yaml`);
  return parseChar(await file.text(), `chars/${id}.yaml`);
}
