# ピクセルアート スプライト生成パイプライン 実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `bun run px <stage>` で、SD1.5 + openpose ControlNet + キャラ LoRA から 64px・8 方向のスプライトシート PNG + JSON を生成する CLI を作る。

**Architecture:** サブコマンド CLI 1 本（`src/px.ts`）が `src/stages/*.ts` を lazy import する。ComfyUI を叩く部分は `lib/comfy.ts` + グラフビルダー（`lib/sd15.ts`, `lib/qwen-edit.ts`）、画像処理は `lib/skeleton.ts` / `lib/pixelate.ts` / `lib/sheet.ts` の純関数群で、ステージ間は `out/` のディレクトリ規約で受け渡す。

**Tech Stack:** bun 1.4、TypeScript 5.9、`@saintno/comfyui-sdk` 0.3（`cfli codegen` で `src/types/nodes.ts` を生成）、`sharp`（PNG デコード / エンコード / SVG ラスタライズのみ）、`Bun.YAML`（yaml ライブラリは入れない）、oxlint / oxfmt、`bun test`。

## Global Constraints

- spec: `docs/superpowers/specs/2026-09-05-pixel-sprite-pipeline-design.md`
- ComfyUI は `http://127.0.0.1:8188`（`COMFY_URL` で上書き）。モデル置き場 `C:\Users\harum\AppData\Local\Comfy-Desktop\ComfyUI-Shared\models\`
- ckpt: concept は `SD1.5\dreamshaper_8.safetensors`、sprites は `aziibpixelmix_v10.safetensors`（ComfyUI が返す名前をそのまま使う。`SD1.5\` の区切りはバックスラッシュ）
- ControlNet: `control_v11p_sd15_openpose_fp16.safetensors`（Task 3 で DL）
- Qwen-Image-Edit: `qwen-image-edit-2511-Q5_0.gguf` + `qwen\Qwen-Image-Edit-2511-Lightning-4steps-V1.0-bf16.safetensors`（既存）
- 出力はすべて `out/` 配下。`in/`, `out/`, `node_modules`, `.env` は gitignore 済み
- `src/` を編集したら `bun run check`（format → lint → typecheck）を通す。`src/types/nodes.ts` は生成物で lint / format 対象外
- ステージ実装は既存パターン `flag() / flags() / resolveSeed() / runWorkflow()` を使い、argv パーサを別途入れない
- 生成失敗フレームはスキップして続行し、末尾で `N/M failed` を出して `process.exitCode = 1`
- コミットメッセージは日本語の Conventional Commits。末尾に `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`
- spec からの変更点（Task 7 で適用）: dataset の caption は `[trigger], <ポーズ/視点語>` のみにする。参照リポの実走結果（`../ai-game-asset-workflow/docs/fal-lora-training/results-apoc-char-01.md`）で、全枚数共通の定型句（`full body shot`、背景・照明句）が trigger に癒着してポーズが効かなくなったため

## ファイル構成

| パス | 責務 |
|---|---|
| `package.json` | scripts: `px`, `codegen`, `check`, `test` |
| `src/px.ts` | サブコマンド dispatcher |
| `src/lib/paths.ts` | `REPO_ROOT`, `OUT_DIR`, `CHARS_DIR`, `PALETTES_DIR` |
| `src/lib/comfy.ts` | ComfyApi 接続、argv flag、seed、LoRA 解決、`runWorkflow` |
| `src/lib/chars.ts` | `chars/<name>.yaml` ロード + 検証 |
| `src/lib/sd15.ts` | SD1.5 グラフビルダー（t2i / LoRA / openpose CN） |
| `src/lib/qwen-edit.ts` | Qwen-Image-Edit グラフビルダー |
| `src/motions/index.ts` | `Joint`, `Pose`, `Dir5`, `Dir8`, `Motion` 型、体格定数、`basePose(dir)`、`MOTIONS` |
| `src/motions/{idle,walk,run,attack,aim,dodge}.ts` | 各モーションの `key(dir, t)` |
| `src/lib/skeleton.ts` | `Pose` → openpose 形式 PNG |
| `src/lib/pixelate.ts` | RGBA 純関数: 背景除去、bbox、整列、box 縮小、量子化、反転 |
| `src/lib/sheet.ts` | フレーム群 → シート RGBA + JSON |
| `src/stages/concept.ts` | `px concept <char>` |
| `src/stages/dataset.ts` | `px dataset <char> --hero <png>` |
| `src/stages/poses.ts` | `px poses [--only a,b]` |
| `src/stages/sprites.ts` | `px sprites <char> [--motion m] [--dir d]` |
| `src/stages/pixelate.ts` | `px pixelate <char> [--size 64] [--palette apoc\|auto]` |
| `src/stages/sheet.ts` | `px sheet <char>` |
| `chars/scavenger.yaml` | サンプルキャラ |
| `palettes/apoc.json` | 固定 32 色 |
| `README.md`, `CLAUDE.md` | 使い方 / 作業ルール |

テストは対象ファイルの隣に `*.test.ts`（`bun test` が拾う）。

---

### Task 1: 足場（scripts、paths、dispatcher）

**Files:**
- Modify: `package.json`
- Create: `src/lib/paths.ts`, `src/px.ts`, `src/px.test.ts`

**Interfaces:**
- Produces: `REPO_ROOT`, `OUT_DIR`, `CHARS_DIR`, `PALETTES_DIR: string`（`paths.ts`）。`STAGES` の型 `Record<string, () => Promise<{ run(argv: string[]): Promise<void> }>>`（後続の各 stage は `export async function run(argv: string[]): Promise<void>` を必ず持つ）

- [ ] **Step 1: package.json を書き換える**

```json
{
  "name": "pixel-2d-game-art",
  "private": true,
  "type": "module",
  "scripts": {
    "px": "bun run src/px.ts",
    "codegen": "cfli codegen -H http://127.0.0.1:8188 -o ./src/types/nodes.ts",
    "typecheck": "tsc --noEmit",
    "lint": "oxlint src --ignore-pattern src/types/nodes.ts",
    "format": "oxfmt 'src/**/*.ts' '!src/types/nodes.ts'",
    "check": "bun run format && bun run lint && bun run typecheck",
    "test": "bun test"
  },
  "dependencies": {
    "@saintno/comfyui-sdk": "^0.3.1",
    "sharp": "^0.34.3"
  },
  "devDependencies": {
    "@types/bun": "^1.3.14",
    "bun-types": "^1.3.14",
    "oxfmt": "^0.63.0",
    "oxlint": "^1.78.0",
    "typescript": "^5.9.0"
  }
}
```

- [ ] **Step 2: 依存を入れ直す**

Run: `bun install`
Expected: `+ sharp@0.34.x` が出て、`@fal-ai/client` と `fflate` が消える。`bun.lock` が更新される。

- [ ] **Step 3: paths.ts を書く**

```ts
// src/lib/paths.ts
import { join } from "node:path";

/** Repo root resolved from this file, not cwd — `bun run` inherits whatever cwd the shell had. */
export const REPO_ROOT = join(import.meta.dir, "../..");
export const OUT_DIR = join(REPO_ROOT, "out");
export const CHARS_DIR = join(REPO_ROOT, "chars");
export const PALETTES_DIR = join(REPO_ROOT, "palettes");
```

- [ ] **Step 4: dispatcher の失敗テストを書く**

```ts
// src/px.test.ts
import { expect, test } from "bun:test";
import { STAGES, usage } from "./px";

test("usage lists every stage", () => {
  for (const name of Object.keys(STAGES)) expect(usage()).toContain(name);
});

test("every stage is a lazy module import", () => {
  for (const load of Object.values(STAGES)) expect(typeof load).toBe("function");
});
```

- [ ] **Step 5: テストが失敗することを確認**

Run: `bun test src/px.test.ts`
Expected: FAIL — `Cannot find module "./px"`

- [ ] **Step 6: px.ts を書く**

```ts
// src/px.ts
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
```

- [ ] **Step 7: 各 stage のスタブを置く（後続 Task で置き換える）**

`src/stages/concept.ts`, `dataset.ts`, `poses.ts`, `sprites.ts`, `pixelate.ts`, `sheet.ts` それぞれに:

```ts
export async function run(_argv: string[]): Promise<void> {
  throw new Error("not implemented");
}
```

- [ ] **Step 8: テストと typecheck を通す**

Run: `bun test src/px.test.ts && bun run typecheck`
Expected: 2 pass。typecheck は `src/types/nodes.ts` がまだ無くても通る（誰も import していない）。

- [ ] **Step 9: Commit**

```bash
git add package.json bun.lock src/px.ts src/px.test.ts src/lib/paths.ts src/stages
git commit -m "feat: px サブコマンド dispatcher と依存の入れ替え"
```

---

### Task 2: lib/comfy.ts（ComfyUI 接続と argv ユーティリティ）

**Files:**
- Create: `src/lib/comfy.ts`, `src/lib/comfy.test.ts`

**Interfaces:**
- Produces:
  - `COMFY: string`
  - `connect(): Promise<ComfyApi>`
  - `flag(argv, name, alias?): string | undefined`
  - `flags(argv, name): string[]`
  - `positional(argv, valueFlags: Set<string>): string | undefined` — 最初の非フラグトークン
  - `resolveSeed(argv): number`
  - `uploadImage(api, path): Promise<string>`
  - `interface Lora { name: string; strength: number }`
  - `parseLora(spec)`, `matchLora(names, query)`, `resolveLoras(api, specs): Promise<Lora[]>`
  - `runWorkflow(api, workflow, label): Promise<string[]>` — 戻りは repo 相対パス
  - `ensureDir(path): Promise<void>`

- [ ] **Step 1: 純関数のテストを書く**

```ts
// src/lib/comfy.test.ts
import { describe, expect, test } from "bun:test";
import { flag, flags, matchLora, parseLora, positional, resolveSeed } from "./comfy";

describe("flag", () => {
  test("reads --name value", () => expect(flag(["--size", "64"], "size")).toBe("64"));
  test("reads alias", () => expect(flag(["-n", "4"], "count", "n")).toBe("4"));
  test("absent is undefined", () => expect(flag(["--size", "64"], "seed")).toBeUndefined());
});

test("flags collects every repeat", () => {
  expect(flags(["--lora", "a", "--lora", "b"], "lora")).toEqual(["a", "b"]);
  expect(flags(["--lora"], "lora")).toEqual([]);
});

describe("positional", () => {
  const V = new Set(["--hero", "--size"]);
  test("skips flag values", () => expect(positional(["--hero", "x.png", "scav"], V)).toBe("scav"));
  test("name before flags", () => expect(positional(["scav", "--size", "64"], V)).toBe("scav"));
  test("none", () => expect(positional(["--size", "64"], V)).toBeUndefined());
});

test("resolveSeed pins --seed", () => expect(resolveSeed(["--seed", "42"])).toBe(42));

describe("lora", () => {
  const NAMES = ["scavenger.safetensors", "SD15\\scavenger_v2.safetensors"];
  test("parse bare", () => expect(parseLora("scav")).toEqual({ query: "scav", strength: 1 }));
  test("parse strength", () =>
    expect(parseLora("scav:0.7")).toEqual({ query: "scav", strength: 0.7 }));
  test("bad strength throws", () => expect(() => parseLora("scav:x")).toThrow());
  test("exact basename wins", () => expect(matchLora(NAMES, "scavenger")).toBe(NAMES[0]));
  test("substring", () => expect(matchLora(NAMES, "v2")).toBe(NAMES[1]));
  test("ambiguous throws", () => expect(() => matchLora(NAMES, "scav")).toThrow(/ambiguous/));
  test("missing throws", () => expect(() => matchLora(NAMES, "nope")).toThrow(/no LoRA/));
});
```

- [ ] **Step 2: 失敗を確認**

Run: `bun test src/lib/comfy.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: comfy.ts を書く**

```ts
// src/lib/comfy.ts
/** Shared ComfyUI plumbing for every stage. */

import { mkdir } from "node:fs/promises";
import { basename, join, relative } from "node:path";
import { CallWrapper, ComfyApi, type PromptBuilder } from "@saintno/comfyui-sdk";
import { OUT_DIR, REPO_ROOT } from "./paths";

export const COMFY = process.env.COMFY_URL ?? "http://127.0.0.1:8188";

export const connect = () => new ComfyApi(COMFY).init().waitForReady();

export const ensureDir = (path: string) => mkdir(path, { recursive: true }).then(() => {});

/** `--name value` from argv; `alias` adds a short form (`-n`). */
export function flag(argv: string[], name: string, alias?: string): string | undefined {
  const i = argv.findIndex((a) => a === `--${name}` || (alias !== undefined && a === `-${alias}`));
  return i === -1 ? undefined : argv[i + 1];
}

/** Every value of a repeatable flag, in order: `--lora a --lora b` -> ["a", "b"]. */
export const flags = (argv: string[], name: string): string[] =>
  argv.flatMap((a, i) => (a === `--${name}` && argv[i + 1] !== undefined ? [argv[i + 1]!] : []));

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
export async function uploadImage(api: ComfyApi, path: string): Promise<string> {
  const upload = await api.uploadImage(await Bun.file(path).arrayBuffer(), basename(path), {
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
  const base = (s: string) => norm(s).split("/").pop()!.replace(/\.safetensors$/, "");

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
```

- [ ] **Step 4: テスト通過を確認**

Run: `bun test src/lib/comfy.test.ts && bun run check`
Expected: 13 pass、check 通過

- [ ] **Step 5: Commit**

```bash
git add src/lib/comfy.ts src/lib/comfy.test.ts
git commit -m "feat: ComfyUI 接続・argv・LoRA 解決の共通 lib"
```

---

### Task 3: openpose ControlNet の DL と codegen

**Files:**
- Create: `src/types/nodes.ts`（生成物）
- Create: `src/types/README.md`

**Interfaces:**
- Produces: `WorkflowBuilder` と各ノードの `*Inputs` 型。以降のグラフビルダーは `import { WorkflowBuilder, type LoadImageInputs } from "../types/nodes"` で使う

- [ ] **Step 1: ControlNet を DL する**

ComfyUI Desktop のモデル置き場は `C:\Users\harum\AppData\Local\Comfy-Desktop\ComfyUI-Shared\models\controlnet\`。

```powershell
$dst = "C:\Users\harum\AppData\Local\Comfy-Desktop\ComfyUI-Shared\models\controlnet\control_v11p_sd15_openpose_fp16.safetensors"
Invoke-WebRequest -Uri "https://huggingface.co/comfyanonymous/ControlNet-v1-1_fp16_safetensors/resolve/main/control_v11p_sd15_openpose_fp16.safetensors" -OutFile $dst
(Get-Item $dst).Length
```

Expected: 約 723 MB。ComfyUI が起動中なら再起動不要（ControlNetLoader はファイル一覧を都度読む）。ただし codegen の union に入れるには次の Step の前に置いておく。

- [ ] **Step 2: codegen を実行**

Run（ComfyUI 起動中）: `bun run codegen`
Expected: `src/types/nodes.ts` が生成される（5 万行前後）。

- [ ] **Step 3: 必要ノードが入っているか確認**

```powershell
Select-String -Path src\types\nodes.ts -Pattern "control_v11p_sd15_openpose_fp16|aziibpixelmix_v10|dreamshaper_8|UnetLoaderGGUF|TextEncodeQwenImageEditPlus" | Select-Object -First 5
```

Expected: 5 行ともヒット。`control_v11p_sd15_openpose_fp16` が無ければ Step 1 の置き場所を疑う。

- [ ] **Step 4: typecheck**

Run: `bun run typecheck`
Expected: 通過

- [ ] **Step 5: 生成物の README を置く**

```md
<!-- src/types/README.md -->
`nodes.ts` は `bun run codegen` の生成物（ComfyUI 起動中に実行）。手で編集しない。
モデル・カスタムノードを追加したら再生成する。lint / format の対象外。
```

- [ ] **Step 6: Commit**

```bash
git add src/types
git commit -m "chore: ComfyUI ノード型を codegen（SD1.5 openpose ControlNet 追加後）"
```

---

### Task 4: lib/chars.ts（キャラ定義 yaml）

**Files:**
- Create: `src/lib/chars.ts`, `src/lib/chars.test.ts`, `chars/scavenger.yaml`

**Interfaces:**
- Produces:
  ```ts
  interface Char {
    name: string; trigger: string; positive: string; negative: string;
    lora?: string; strength: number;   // strength 既定 0.8
  }
  parseChar(src: string, label?: string): Char
  loadChar(name: string): Promise<Char>   // chars/<name>.yaml、無ければ候補付きで throw
  ```

- [ ] **Step 1: テストを書く**

```ts
// src/lib/chars.test.ts
import { describe, expect, test } from "bun:test";
import { parseChar } from "./chars";

const OK = `name: scavenger
trigger: sc4v_char
positive: |
  gas mask, torn leather coat,
  bandaged arms
negative: blurry, extra limbs
`;

describe("parseChar", () => {
  test("joins multi-line tags", () => {
    const c = parseChar(OK);
    expect(c.positive).toBe("gas mask, torn leather coat, bandaged arms");
    expect(c.negative).toBe("blurry, extra limbs");
    expect(c.lora).toBeUndefined();
    expect(c.strength).toBe(0.8);
  });
  test("lora + strength", () => {
    const c = parseChar(`${OK}lora: scavenger\nstrength: 0.6\n`);
    expect(c.lora).toBe("scavenger");
    expect(c.strength).toBe(0.6);
  });
  test("strips # comments inside block scalars", () => {
    expect(parseChar(OK.replace("bandaged arms", "bandaged arms # todo")).positive).toBe(
      "gas mask, torn leather coat, bandaged arms",
    );
  });
  test("unknown key throws", () => expect(() => parseChar(`${OK}colour: red\n`)).toThrow(/colour/));
  test("missing trigger throws", () =>
    expect(() => parseChar(OK.replace("trigger: sc4v_char\n", ""))).toThrow(/trigger/));
  test("non-mapping throws", () => expect(() => parseChar("just text")).toThrow());
});
```

- [ ] **Step 2: 失敗確認**

Run: `bun test src/lib/chars.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: chars.ts を書く**

```ts
// src/lib/chars.ts
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
    .map((line) => line.replace(/(#|\/\/).*$/, "").trim().replace(/,+$/, ""))
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
```

- [ ] **Step 4: サンプル yaml を置く**

```yaml
# chars/scavenger.yaml
name: scavenger
trigger: sc4v_char
# lora: scavenger        # 学習後にここへ追記する
strength: 0.8
positive: |
  1boy, solo,
  gas mask with two round filters,
  hooded olive jacket, torn leather straps,
  bandaged forearms, fingerless gloves,
  tan cargo pants, worn boots,
  post-apocalyptic wasteland scavenger
negative: |
  blurry, lowres, extra limbs, deformed hands,
  text, watermark, signature
```

- [ ] **Step 5: テスト通過 + check**

Run: `bun test src/lib/chars.test.ts && bun run check`
Expected: 6 pass

- [ ] **Step 6: Commit**

```bash
git add src/lib/chars.ts src/lib/chars.test.ts chars/scavenger.yaml
git commit -m "feat: chars/<name>.yaml のロードと検証"
```

---

### Task 5: lib/sd15.ts（SD1.5 グラフビルダー）

**Files:**
- Create: `src/lib/sd15.ts`, `src/lib/sd15.test.ts`

**Interfaces:**
- Produces:
  ```ts
  interface Sd15Opts {
    ckpt: string; positive: string; negative: string;
    width: number; height: number; count: number; seed: number;
    prefix: string;                 // SaveImage filename_prefix (out/ 配下のサブパス)
    steps?: number; cfg?: number;   // 既定 25 / 6
    loras?: Lora[];
    control?: { image: string; strength: number; endPercent?: number };  // image は input/ 内の名前、既に openpose 形式
  }
  buildSd15(o: Sd15Opts): ReturnType<WorkflowBuilder["build"]>
  const SD15_CONTROLNET_OPENPOSE = "control_v11p_sd15_openpose_fp16.safetensors"
  ```

- [ ] **Step 1: テストを書く（グラフ JSON の構造を見る）**

```ts
// src/lib/sd15.test.ts
import { describe, expect, test } from "bun:test";
import { buildSd15, SD15_CONTROLNET_OPENPOSE } from "./sd15";

const base = {
  ckpt: "aziibpixelmix_v10.safetensors",
  positive: "sc4v_char, walking",
  negative: "blurry",
  width: 512,
  height: 512,
  count: 1,
  seed: 42,
  prefix: "sprites/scavenger/walk/down/0",
};

const nodes = (wf: ReturnType<typeof buildSd15>) =>
  Object.values(wf.prompt as Record<string, { class_type: string; inputs: Record<string, unknown> }>);
const byType = (wf: ReturnType<typeof buildSd15>, t: string) =>
  nodes(wf).filter((n) => n.class_type === t);

describe("buildSd15", () => {
  test("plain t2i has no lora / controlnet", () => {
    const wf = buildSd15(base);
    expect(byType(wf, "CheckpointLoaderSimple")).toHaveLength(1);
    expect(byType(wf, "LoraLoader")).toHaveLength(0);
    expect(byType(wf, "ControlNetApplyAdvanced")).toHaveLength(0);
    const ks = byType(wf, "KSampler")[0]!;
    expect(ks.inputs.seed).toBe(42);
    expect(ks.inputs.steps).toBe(25);
    expect(ks.inputs.cfg).toBe(6);
    expect(ks.inputs.sampler_name).toBe("dpmpp_2m");
    expect(ks.inputs.scheduler).toBe("karras");
  });

  test("loras chain in order", () => {
    const wf = buildSd15({ ...base, loras: [{ name: "a.safetensors", strength: 0.8 }, { name: "b.safetensors", strength: 0.5 }] });
    const loras = byType(wf, "LoraLoader");
    expect(loras.map((l) => l.inputs.lora_name)).toEqual(["a.safetensors", "b.safetensors"]);
    expect(loras[0]!.inputs.strength_model).toBe(0.8);
    expect(loras[0]!.inputs.strength_clip).toBe(0.8);
  });

  test("control wires openpose without a preprocessor", () => {
    const wf = buildSd15({ ...base, control: { image: "walk_down_0.png", strength: 0.65 } });
    expect(byType(wf, "ControlNetLoader")[0]!.inputs.control_net_name).toBe(SD15_CONTROLNET_OPENPOSE);
    const apply = byType(wf, "ControlNetApplyAdvanced")[0]!;
    expect(apply.inputs.strength).toBe(0.65);
    expect(apply.inputs.end_percent).toBe(0.85);
    expect(nodes(wf).some((n) => n.class_type.includes("Preprocessor"))).toBe(false);
    expect(byType(wf, "LoadImage")[0]!.inputs.image).toBe("walk_down_0.png");
  });

  test("save prefix and batch size", () => {
    const wf = buildSd15({ ...base, count: 4 });
    expect(byType(wf, "SaveImage")[0]!.inputs.filename_prefix).toBe(base.prefix);
    expect(byType(wf, "EmptyLatentImage")[0]!.inputs.batch_size).toBe(4);
  });
});
```

- [ ] **Step 2: 失敗確認**

Run: `bun test src/lib/sd15.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: sd15.ts を書く**

```ts
// src/lib/sd15.ts
/**
 * SD1.5 as a graph builder: one checkpoint, optional LoRA chain, optional
 * openpose ControlNet. Used by concept (plain) and sprites (LoRA + CN).
 */

import {
  WorkflowBuilder,
  type CheckpointLoaderSimpleInputs,
  type ControlNetLoaderInputs,
  type LoadImageInputs,
  type LoraLoaderInputs,
} from "../types/nodes";
import type { Lora } from "./comfy";

export const SD15_CONTROLNET_OPENPOSE = "control_v11p_sd15_openpose_fp16.safetensors";

export interface Sd15Opts {
  ckpt: string;
  positive: string;
  negative: string;
  width: number;
  height: number;
  count: number;
  seed: number;
  /** filename_prefix for SaveImage, i.e. the subpath under out/. */
  prefix: string;
  steps?: number;
  cfg?: number;
  loras?: Lora[];
  /**
   * Pose hint already in openpose form and already in ComfyUI's input/ dir.
   * No preprocessor: running a detector over a stick figure finds no body.
   */
  control?: { image: string; strength: number; endPercent?: number };
}

export function buildSd15(o: Sd15Opts): ReturnType<WorkflowBuilder["build"]> {
  const w = new WorkflowBuilder();

  const ckpt = w.CheckpointLoaderSimple({
    ckpt_name: o.ckpt as CheckpointLoaderSimpleInputs["ckpt_name"],
  });

  // Both MODEL and CLIP are patched: a character LoRA also moves what its
  // trigger means to the text encoder, so model-only would half-apply it.
  let model = ckpt.MODEL;
  let clip = ckpt.CLIP;
  for (const lora of o.loras ?? []) {
    const loaded = w.LoraLoader({
      model,
      clip,
      lora_name: lora.name as LoraLoaderInputs["lora_name"],
      strength_model: lora.strength,
      strength_clip: lora.strength,
    });
    model = loaded.MODEL;
    clip = loaded.CLIP;
  }

  const positive = w.CLIPTextEncode({ clip, text: o.positive });
  const negative = w.CLIPTextEncode({ clip, text: o.negative });

  const guided = o.control
    ? w.ControlNetApplyAdvanced({
        positive: positive.CONDITIONING,
        negative: negative.CONDITIONING,
        control_net: w.ControlNetLoader({
          control_net_name: SD15_CONTROLNET_OPENPOSE as ControlNetLoaderInputs["control_net_name"],
        }).CONTROL_NET,
        image: w.LoadImage({ image: o.control.image as LoadImageInputs["image"] }).IMAGE,
        strength: o.control.strength,
        start_percent: 0,
        // Releasing before the end lets the last steps clean up anatomy the
        // skeleton was forcing; holding to 1 keeps the pose but stiffens it.
        end_percent: o.control.endPercent ?? 0.85,
      })
    : undefined;

  const latent = w.EmptyLatentImage({ width: o.width, height: o.height, batch_size: o.count });

  const sampled = w.KSampler({
    model,
    positive: guided?.positive ?? positive.CONDITIONING,
    negative: guided?.negative ?? negative.CONDITIONING,
    latent_image: latent.LATENT,
    seed: o.seed,
    steps: o.steps ?? 25,
    cfg: o.cfg ?? 6,
    sampler_name: "dpmpp_2m",
    scheduler: "karras",
    denoise: 1,
  });

  const decoded = w.VAEDecode({ samples: sampled.LATENT, vae: ckpt.VAE });
  const save = w.SaveImage({ images: decoded.IMAGE, filename_prefix: o.prefix });

  return w.build({ outputs: { images: save.__id } });
}
```

- [ ] **Step 4: テスト通過 + check**

Run: `bun test src/lib/sd15.test.ts && bun run check`
Expected: 4 pass。`wf.prompt` のプロパティ名が違って型エラーになった場合は `PromptBuilder` の公開プロパティ（`prompt`）を `node_modules/@saintno/comfyui-sdk/dist/index.d.ts` で確認して直す。

- [ ] **Step 5: Commit**

```bash
git add src/lib/sd15.ts src/lib/sd15.test.ts
git commit -m "feat: SD1.5 グラフビルダー（LoRA チェーン + openpose ControlNet）"
```

---

### Task 6: stages/concept.ts

**Files:**
- Modify: `src/stages/concept.ts`

**Interfaces:**
- Consumes: `loadChar`, `buildSd15`, `connect / flag / positional / resolveSeed / runWorkflow`
- Produces: `out/concept/<char>/<char>_00001_.png` ...（ComfyUI の連番）

- [ ] **Step 1: concept.ts を書く**

```ts
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
    prefix: `concept/${char.name}/${char.name}`,
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
```

- [ ] **Step 2: --dry で動作確認**

Run: `bun run px concept scavenger --dry | Select-String -Pattern "dreamshaper|flat grey" | Select-Object -First 2`
Expected: ckpt 名とプロンプト末尾が出る

- [ ] **Step 3: 実機で 1 回回す（ComfyUI 起動中）**

Run: `bun run px concept scavenger -n 2`
Expected: `out/concept/scavenger/scavenger_00001_.png`, `_00002_` が保存される。

- [ ] **Step 4: check + Commit**

```bash
bun run check
git add src/stages/concept.ts
git commit -m "feat: px concept — SD1.5 でキャラ候補生成"
```

---

### Task 7: lib/qwen-edit.ts + stages/dataset.ts

**Files:**
- Create: `src/lib/qwen-edit.ts`, `src/lib/dataset.ts`, `src/lib/dataset.test.ts`
- Modify: `src/stages/dataset.ts`

**Interfaces:**
- Produces:
  - `buildQwenEdit({ image, prompt, seed, prefix }): ReturnType<WorkflowBuilder["build"]>`
  - `lib/dataset.ts`: `VARIATIONS: Record<VariationId, { prompt: string; caption: string }>`, `SOURCE_CAPTION`, `caption(template, trigger): string`, `trainYaml(o: { name, trigger, datasetDir }): string`

- [ ] **Step 1: テストを書く**

```ts
// src/lib/dataset.test.ts
import { describe, expect, test } from "bun:test";
import { caption, SOURCE_CAPTION, trainYaml, VARIATIONS } from "./dataset";

describe("captions", () => {
  test("substitute trigger", () =>
    expect(caption("[trigger], side view", "sc4v_char")).toBe("sc4v_char, side view"));
  test("every variation caption starts with the trigger and has no fixed studio phrase", () => {
    for (const v of Object.values(VARIATIONS)) {
      expect(v.caption.startsWith("[trigger]")).toBe(true);
      expect(v.caption).not.toMatch(/full body shot|grey background|studio lighting/);
    }
    expect(SOURCE_CAPTION).toBe("[trigger], front view");
  });
  test("prompts all keep the character", () => {
    for (const v of Object.values(VARIATIONS)) expect(v.prompt).toContain("Keep the exact same character");
  });
});

test("trainYaml embeds name, trigger and folder", () => {
  const y = trainYaml({ name: "scavenger", trigger: "sc4v_char", datasetDir: "C:/x/out/dataset/scavenger" });
  const doc = Bun.YAML.parse(y) as any;
  expect(doc.config.name).toBe("scavenger");
  const p = doc.config.process[0];
  expect(p.trigger_word).toBe("sc4v_char");
  expect(p.datasets[0].folder_path).toBe("C:/x/out/dataset/scavenger");
  expect(p.model.name_or_path).toBe("stable-diffusion-v1-5/stable-diffusion-v1-5");
  expect(p.model.is_flux).toBeUndefined();
});
```

- [ ] **Step 2: 失敗確認**

Run: `bun test src/lib/dataset.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: qwen-edit.ts を書く**

```ts
// src/lib/qwen-edit.ts
/**
 * Qwen-Image-Edit 2511 as a graph builder. Identity travels as pixels, not as
 * text: the prompt says what to change, the reference image carries who it is.
 * That is why this builds a LoRA dataset out of one hero image.
 */

import { WorkflowBuilder, type LoadImageInputs } from "../types/nodes";

const UNET = "qwen-image-edit-2511-Q5_0.gguf";
const CLIP = "qwen_2.5_vl_7b_fp8_scaled.safetensors";
const VAE = "qwen_image_vae.safetensors";
const LIGHTNING_LORA = "qwen\\Qwen-Image-Edit-2511-Lightning-4steps-V1.0-bf16.safetensors";

export interface QwenEditOpts {
  /** Filename already inside ComfyUI's input/ directory. */
  image: string;
  prompt: string;
  seed: number;
  prefix: string;
}

export function buildQwenEdit(o: QwenEditOpts): ReturnType<WorkflowBuilder["build"]> {
  const w = new WorkflowBuilder();

  const unet = w.UnetLoaderGGUF({ unet_name: UNET });
  const clip = w.CLIPLoader({ clip_name: CLIP, type: "qwen_image" });
  const vae = w.VAELoader({ vae_name: VAE });

  // 4-step Lightning distill: KSampler must stay at steps 4 / cfg 1.
  const model = w.LoraLoaderModelOnly({
    model: unet.MODEL,
    lora_name: LIGHTNING_LORA,
    strength_model: 1,
  });

  const src = w.LoadImage({ image: o.image as LoadImageInputs["image"] });
  const scaled = w.ImageScaleToTotalPixels({
    image: src.IMAGE,
    upscale_method: "lanczos",
    megapixels: 1,
    resolution_steps: 16,
  });

  const ref = { clip: clip.CLIP, vae: vae.VAE, image1: scaled.IMAGE };
  const positive = w.TextEncodeQwenImageEditPlus({ ...ref, prompt: o.prompt });
  const negative = w.TextEncodeQwenImageEditPlus({ ...ref, prompt: "" });

  const latent = w.VAEEncode({ pixels: scaled.IMAGE, vae: vae.VAE });
  const sampled = w.KSampler({
    model: model.MODEL,
    positive: positive.CONDITIONING,
    negative: negative.CONDITIONING,
    latent_image: latent.LATENT,
    seed: o.seed,
    steps: 4,
    cfg: 1,
    sampler_name: "euler",
    scheduler: "simple",
    denoise: 1,
  });

  const decoded = w.VAEDecode({ samples: sampled.LATENT, vae: vae.VAE });
  const save = w.SaveImage({ images: decoded.IMAGE, filename_prefix: o.prefix });

  return w.build({ outputs: { images: save.__id } });
}
```

`UnetLoaderGGUF` などの名前が codegen に無ければ、ComfyUI-GGUF が入っていない。`src/types/nodes.ts` を `Select-String UnetLoaderGGUF` で確認し、無ければ ComfyUI Manager で `ComfyUI-GGUF` を入れて `bun run codegen`。

- [ ] **Step 4: lib/dataset.ts を書く**

```ts
// src/lib/dataset.ts
/**
 * What the dataset stage generates: one Qwen-Image-Edit instruction plus one
 * training caption per variation, and the ai-toolkit config that consumes them.
 *
 * Captions are deliberately minimal — `[trigger], <view or pose>` and nothing
 * else. A phrase that appears in every caption ("full body shot", the studio
 * backdrop) gets welded into the trigger word, and the LoRA then ignores pose
 * prompts entirely (seen on the reference repo's first FLUX run).
 */

const KEEP =
  "Keep the exact same character, mask, outfit, gear, colours, materials and body " +
  "proportions completely unchanged. Sharp focus.";
const STUDIO = "Plain neutral grey background, even diffuse lighting, no scenery.";

export const VARIATIONS = {
  threequarter: {
    prompt: `Rotate the character 45 degrees to a three-quarter view, body angled to the left. Full body, head to toe. ${STUDIO} ${KEEP}`,
    caption: "[trigger], three-quarter view",
  },
  side: {
    prompt: `Rotate the character 90 degrees to a full side profile facing left. Full body, head to toe. ${STUDIO} ${KEEP}`,
    caption: "[trigger], side view",
  },
  back: {
    prompt: `Rotate the character 180 degrees to show the back, seen from directly behind. Full body, head to toe. ${STUDIO} ${KEEP}`,
    caption: "[trigger], back view",
  },
  backthreequarter: {
    prompt: `Rotate the character 135 degrees to a three-quarter rear view. Full body, head to toe. ${STUDIO} ${KEEP}`,
    caption: "[trigger], three-quarter rear view",
  },
  bust: {
    prompt: `Reframe to an upper body shot from the waist up, facing the viewer. ${STUDIO} ${KEEP}`,
    caption: "[trigger], upper body",
  },
  portrait: {
    prompt: `Reframe to a head and shoulders portrait, close on the face. ${STUDIO} ${KEEP}`,
    caption: "[trigger], portrait",
  },
  walking: {
    prompt: `Repose the character mid-stride walking toward the viewer, one leg forward, arms swinging. Full body, head to toe. ${STUDIO} ${KEEP}`,
    caption: "[trigger], walking",
  },
  running: {
    prompt: `Repose the character running to the left, both legs off the ground, leaning forward. Full body, head to toe. ${STUDIO} ${KEEP}`,
    caption: "[trigger], running",
  },
  crouching: {
    prompt: `Repose the character crouching low on one knee, weight forward. Full body, head to toe. ${STUDIO} ${KEEP}`,
    caption: "[trigger], crouching",
  },
  sitting: {
    prompt: `Repose the character sitting on the ground, one knee up, leaning back on one arm. Full body. ${STUDIO} ${KEEP}`,
    caption: "[trigger], sitting",
  },
  armsraised: {
    prompt: `Repose the character with both arms raised out to the sides at shoulder height, T-pose. Full body, head to toe. ${STUDIO} ${KEEP}`,
    caption: "[trigger], arms raised",
  },
  aiming: {
    prompt: `Repose the character aiming a scavenged rifle to the left, both hands on the weapon, shoulders squared. Full body, head to toe. ${STUDIO} ${KEEP}`,
    caption: "[trigger], aiming a rifle",
  },
  lowangle: {
    prompt: `Re-shoot the character from a low angle looking up, camera near the ground. Full body, head to toe. ${STUDIO} ${KEEP}`,
    caption: "[trigger], low angle",
  },
  // Two shots off the grey backdrop, or the LoRA learns "this character = grey".
  wasteland: {
    prompt: `Place the character standing in an open sunlit desert wasteland with blown dust and distant ruins. Full body, head to toe. Low harsh sun, atmospheric haze. ${KEEP}`,
    caption: "[trigger], desert wasteland",
  },
  ruins: {
    prompt: `Place the character standing inside a ruined concrete building, rubble and broken rebar, shafts of dusty light. Full body, head to toe. ${KEEP}`,
    caption: "[trigger], ruined building",
  },
} satisfies Record<string, { prompt: string; caption: string }>;

export type VariationId = keyof typeof VARIATIONS;

export const SOURCE_CAPTION = "[trigger], front view";

export const caption = (template: string, trigger: string): string =>
  template.replaceAll("[trigger]", trigger);

/** ai-toolkit sd_trainer config for an SD1.5 character LoRA on a 16GB card. */
export function trainYaml(o: { name: string; trigger: string; datasetDir: string }): string {
  return `---
# SD1.5 character LoRA — generated by \`px dataset\`. Run from your ai-toolkit checkout:
#   python run.py "${o.datasetDir}/train.yaml"
job: extension
config:
  name: "${o.name}"
  process:
    - type: sd_trainer
      training_folder: output
      device: cuda:0
      trigger_word: "${o.trigger}"
      network:
        type: lora
        linear: 16
        linear_alpha: 16
      save:
        dtype: float16
        save_every: 250
        max_step_saves_to_keep: 4
        push_to_hub: false
      datasets:
        - folder_path: "${o.datasetDir}"
          caption_ext: txt
          caption_dropout_rate: 0.05
          shuffle_tokens: false
          cache_latents_to_disk: true
          resolution: [512]
      train:
        batch_size: 1
        steps: 1500
        gradient_accumulation_steps: 1
        train_unet: true
        train_text_encoder: false
        gradient_checkpointing: true
        noise_scheduler: ddpm
        optimizer: adamw8bit
        lr: 1e-4
        ema_config:
          use_ema: true
          ema_decay: 0.99
        dtype: bf16
      model:
        name_or_path: "stable-diffusion-v1-5/stable-diffusion-v1-5"
        is_v2: false
        is_xl: false
      sample:
        sampler: ddpm
        sample_every: 250
        sample_start_step: 0
        width: 512
        height: 512
        prompts:
          - "[trigger], front view"
          - "[trigger], side view"
          - "[trigger], walking"
          - "[trigger], aiming a rifle"
        neg: "blurry, lowres, extra limbs"
        seed: 42
        walk_seed: true
        guidance_scale: 6
        sample_steps: 25
meta:
  name: "[name]"
  version: "1.0"
`;
}
```

- [ ] **Step 5: テスト通過**

Run: `bun test src/lib/dataset.test.ts`
Expected: 4 pass

- [ ] **Step 6: stages/dataset.ts を書く**

```ts
// src/stages/dataset.ts
/**
 * `px dataset <char> --hero <png>` — one hero image -> an ai-toolkit dataset.
 *
 *   bun run px dataset scavenger --hero out/concept/scavenger/scavenger_00002_.png
 *   bun run px dataset scavenger --hero hero.png --only side,back,portrait
 *   bun run px dataset scavenger --hero hero.png --dry
 *
 * Writes out/dataset/<char>/: source.png (the hero, copied), one image + one
 * same-named .txt per variation, and train.yaml. Training itself is manual.
 */

import { basename, join } from "node:path";
import { connect, ensureDir, flag, positional, resolveSeed, runWorkflow, uploadImage } from "../lib/comfy";
import { loadChar } from "../lib/chars";
import { caption, SOURCE_CAPTION, trainYaml, VARIATIONS, type VariationId } from "../lib/dataset";
import { OUT_DIR, REPO_ROOT } from "../lib/paths";
import { buildQwenEdit } from "../lib/qwen-edit";

const VALUE_FLAGS = new Set(["--hero", "--only", "--seed"]);
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
  const selected = onlyFlag === undefined ? ids() : (onlyFlag.split(",").map((s) => s.trim()) as VariationId[]);
  const unknown = selected.filter((v) => !(v in VARIATIONS));
  if (unknown.length) {
    console.error(`unknown --only ${unknown.join(", ")}; expected ${ids().join(", ")}`);
    process.exit(1);
  }

  const dry = argv.includes("--dry");
  const api = dry ? undefined : await connect();
  const image = api ? await uploadImage(api, heroPath) : basename(heroPath);
  const baseSeed = resolveSeed(argv);
  const dir = join(OUT_DIR, "dataset", char.name);

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
  for (const [i, id] of selected.entries()) {
    const workflow = buildQwenEdit({
      image,
      prompt: VARIATIONS[id].prompt,
      seed: baseSeed + i,
      prefix: `dataset/${char.name}/${id}`,
    });

    if (dry) {
      console.log(JSON.stringify(workflow.prompt, null, 2));
      continue;
    }

    try {
      const files = await runWorkflow(api!, workflow, id);
      // ai-toolkit pairs captions by filename, so follow whatever counter SaveImage used.
      for (const f of files)
        await Bun.write(join(REPO_ROOT, f.replace(/\.png$/, ".txt")), caption(VARIATIONS[id].caption, char.trigger));
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
```

- [ ] **Step 7: --dry で確認**

Run: `bun run px dataset scavenger --hero out/concept/scavenger/scavenger_00001_.png --only side --dry | Select-String "TextEncodeQwenImageEditPlus"`
Expected: 2 行ヒット

- [ ] **Step 8: 実機で 2 バリエーション回す**

Run: `bun run px dataset scavenger --hero out/concept/scavenger/scavenger_00001_.png --only side,back`
Expected: `out/dataset/scavenger/` に `source.png`, `source.txt`, `side_00001_.png`, `side_00001_.txt`, `back_*`, `train.yaml`。`.txt` の中身が `sc4v_char, side view`。

- [ ] **Step 9: check + Commit**

```bash
bun run check
git add src/lib/qwen-edit.ts src/lib/dataset.ts src/lib/dataset.test.ts src/stages/dataset.ts
git commit -m "feat: px dataset — Qwen-Image-Edit 多視点 + caption + ai-toolkit 設定"
```

---

### Task 8: motions/index.ts + lib/skeleton.ts（骨格の型と描画）

**Files:**
- Create: `src/motions/index.ts`, `src/motions/index.test.ts`, `src/lib/skeleton.ts`, `src/lib/skeleton.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // motions/index.ts
  type Joint = "nose"|"neck"|"rsho"|"relb"|"rwri"|"lsho"|"lelb"|"lwri"|"rhip"|"rkne"|"rank"|"lhip"|"lkne"|"lank"|"reye"|"leye"|"rear"|"lear"
  const JOINTS: readonly Joint[]            // COCO18 の順
  interface Pt { x: number; y: number }     // 0..1 正規化
  type Pose = Record<Joint, Pt>
  const DIRS5 = ["down","up","side","downside","upside"] as const; type Dir5
  const DIRS8 = ["down","downright","right","upright","up","upleft","left","downleft"] as const; type Dir8
  const FLIP: Record<Dir5, [Dir8, Dir8?]>  // side→[right,left], down→[down]
  const BODY = { headR, neckY, shoulderY, shoulderHalf, hipY, hipHalf, kneeY, ankleY, elbowDrop, wristDrop }
  facing(dir: Dir5): number                 // down=1, downside=0.5, side=0, upside=-0.5, up=-1
  basePose(dir: Dir5): Pose                 // 直立
  interface Motion { id: string; fps: number; frames: number; prompt: string; key(dir: Dir5, t: number): Pose }
  const MOTIONS: Motion[]                   // Task 9 で埋める。ここでは [] で開始
  // lib/skeleton.ts
  poseSvg(pose: Pose, size: number): string
  renderPose(pose: Pose, size: number): Promise<Buffer>   // PNG
  ```

- [ ] **Step 1: motions/index.ts のテスト**

```ts
// src/motions/index.test.ts
import { describe, expect, test } from "bun:test";
import { basePose, DIRS5, facing, JOINTS } from "./index";

describe("basePose", () => {
  test("every joint inside 0..1 for every dir", () => {
    for (const dir of DIRS5) {
      const p = basePose(dir);
      for (const j of JOINTS) {
        expect(p[j].x).toBeGreaterThanOrEqual(0);
        expect(p[j].x).toBeLessThanOrEqual(1);
        expect(p[j].y).toBeGreaterThanOrEqual(0);
        expect(p[j].y).toBeLessThanOrEqual(1);
      }
    }
  });
  test("front view: character's right shoulder is on the viewer's left", () => {
    const p = basePose("down");
    expect(p.rsho.x).toBeLessThan(p.lsho.x);
  });
  test("back view mirrors", () => {
    const p = basePose("up");
    expect(p.rsho.x).toBeGreaterThan(p.lsho.x);
  });
  test("side view collapses shoulders onto one x", () => {
    const p = basePose("side");
    expect(p.rsho.x).toBeCloseTo(p.lsho.x, 5);
    expect(facing("side")).toBe(0);
  });
  test("head above hips above ankles", () => {
    const p = basePose("down");
    expect(p.nose.y).toBeLessThan(p.rhip.y);
    expect(p.rhip.y).toBeLessThan(p.rank.y);
  });
});
```

- [ ] **Step 2: 失敗確認**

Run: `bun test src/motions/index.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: motions/index.ts を書く**

```ts
// src/motions/index.ts
/**
 * Skeleton model shared by every motion: COCO-18 joints in openpose order,
 * a chibi body in normalised coordinates, and the five generated directions.
 *
 * All poses are authored facing RIGHT for side-ish views; the pixelate stage
 * mirrors them to get the left-facing half of the 8 directions.
 */

export const JOINTS = [
  "nose", "neck",
  "rsho", "relb", "rwri",
  "lsho", "lelb", "lwri",
  "rhip", "rkne", "rank",
  "lhip", "lkne", "lank",
  "reye", "leye", "rear", "lear",
] as const;
export type Joint = (typeof JOINTS)[number];

export interface Pt { x: number; y: number }
export type Pose = Record<Joint, Pt>;

export const DIRS5 = ["down", "up", "side", "downside", "upside"] as const;
export type Dir5 = (typeof DIRS5)[number];

export const DIRS8 = ["down", "downright", "right", "upright", "up", "upleft", "left", "downleft"] as const;
export type Dir8 = (typeof DIRS8)[number];

/** Which 8-way directions each generated 5-way one becomes; the second is the mirror. */
export const FLIP: Record<Dir5, [Dir8, Dir8?]> = {
  down: ["down"],
  up: ["up"],
  side: ["right", "left"],
  downside: ["downright", "downleft"],
  upside: ["upright", "upleft"],
};

/**
 * 2-3 heads tall on a square canvas: head fills the top third, legs are
 * short. Tune here, not per motion.
 */
export const BODY = {
  headR: 0.11,
  noseY: 0.24,
  neckY: 0.36,
  shoulderY: 0.40,
  shoulderHalf: 0.12,
  elbowDrop: 0.10,
  wristDrop: 0.20,
  hipY: 0.58,
  hipHalf: 0.07,
  kneeY: 0.74,
  ankleY: 0.90,
  centerX: 0.5,
} as const;

/** +1 facing the viewer, -1 facing away, 0 in profile. Scales left/right spread. */
export const facing = (dir: Dir5): number =>
  ({ down: 1, downside: 0.5, side: 0, upside: -0.5, up: -1 })[dir];

/** Standing upright, arms down. Every motion starts from this. */
export function basePose(dir: Dir5): Pose {
  const f = facing(dir);
  const B = BODY;
  const cx = B.centerX;
  // In profile the body's depth axis is the viewer's x, so shift the whole
  // figure so the nose leads to the right.
  const lean = (1 - Math.abs(f)) * 0.03;

  // Character's RIGHT is on the viewer's LEFT when facing the viewer (f > 0).
  const rx = (half: number) => cx - half * f;
  const lx = (half: number) => cx + half * f;

  return {
    nose: { x: cx + lean, y: B.noseY },
    neck: { x: cx, y: B.neckY },
    rsho: { x: rx(B.shoulderHalf), y: B.shoulderY },
    relb: { x: rx(B.shoulderHalf + 0.02), y: B.shoulderY + B.elbowDrop },
    rwri: { x: rx(B.shoulderHalf + 0.03), y: B.shoulderY + B.wristDrop },
    lsho: { x: lx(B.shoulderHalf), y: B.shoulderY },
    lelb: { x: lx(B.shoulderHalf + 0.02), y: B.shoulderY + B.elbowDrop },
    lwri: { x: lx(B.shoulderHalf + 0.03), y: B.shoulderY + B.wristDrop },
    rhip: { x: rx(B.hipHalf), y: B.hipY },
    rkne: { x: rx(B.hipHalf), y: B.kneeY },
    rank: { x: rx(B.hipHalf), y: B.ankleY },
    lhip: { x: lx(B.hipHalf), y: B.hipY },
    lkne: { x: lx(B.hipHalf), y: B.kneeY },
    lank: { x: lx(B.hipHalf), y: B.ankleY },
    reye: { x: rx(0.04) + lean, y: B.noseY - 0.03 },
    leye: { x: lx(0.04) + lean, y: B.noseY - 0.03 },
    rear: { x: rx(B.headR * 0.9), y: B.noseY - 0.01 },
    lear: { x: lx(B.headR * 0.9), y: B.noseY - 0.01 },
  };
}

export interface Motion {
  id: string;
  fps: number;
  frames: number;
  /** One phrase appended to the sprite prompt, e.g. "walking". */
  prompt: string;
  /** Pose at normalised time t in [0, 1). */
  key(dir: Dir5, t: number): Pose;
}

/** Deep-copy helper so a motion can mutate a base pose freely. */
export const clonePose = (p: Pose): Pose =>
  Object.fromEntries(JOINTS.map((j) => [j, { ...p[j] }])) as Pose;

/** Filled in by Task 9; kept here so stages import one list. */
export const MOTIONS: Motion[] = [];
```

- [ ] **Step 4: index テスト通過**

Run: `bun test src/motions/index.test.ts`
Expected: 5 pass

- [ ] **Step 5: skeleton.ts のテスト**

```ts
// src/lib/skeleton.test.ts
import { expect, test } from "bun:test";
import sharp from "sharp";
import { basePose } from "../motions";
import { poseSvg, renderPose } from "./skeleton";

test("svg has 18 joints and 17 limbs", () => {
  const svg = poseSvg(basePose("down"), 512);
  expect(svg.match(/<circle /g)).toHaveLength(18);
  expect(svg.match(/<line /g)).toHaveLength(17);
  expect(svg).toContain('fill="#000"'); // black background
});

test("renders a 512px png with a black background and coloured pixels", async () => {
  const png = await renderPose(basePose("down"), 512);
  const { data, info } = await sharp(png).raw().toBuffer({ resolveWithObject: true });
  expect(info.width).toBe(512);
  expect(info.height).toBe(512);
  // corner is black
  expect([data[0], data[1], data[2]]).toEqual([0, 0, 0]);
  // something is not black
  let coloured = 0;
  for (let i = 0; i < data.length; i += info.channels) if (data[i]! + data[i + 1]! + data[i + 2]! > 0) coloured++;
  expect(coloured).toBeGreaterThan(500);
});
```

- [ ] **Step 6: 失敗確認**

Run: `bun test src/lib/skeleton.test.ts`
Expected: FAIL — module not found

- [ ] **Step 7: skeleton.ts を書く**

```ts
// src/lib/skeleton.ts
/**
 * Pose -> openpose-style image. The colours and limb order match
 * controlnet_aux's draw_bodypose exactly, which is what
 * control_v11p_sd15_openpose was trained on; anything else reads as noise.
 * Background is pure black, as the ControlNet expects.
 */

import sharp from "sharp";
import { JOINTS, type Pose } from "../motions";

/** Limb pairs by joint index, in openpose order (colour i goes with limb i). */
const LIMBS: [number, number][] = [
  [1, 2], [1, 5], [2, 3], [3, 4], [5, 6], [6, 7],
  [1, 8], [8, 9], [9, 10], [1, 11], [11, 12], [12, 13],
  [1, 0], [0, 14], [14, 16], [0, 15], [15, 17],
];

const COLORS = [
  [255, 0, 0], [255, 85, 0], [255, 170, 0], [255, 255, 0], [170, 255, 0], [85, 255, 0],
  [0, 255, 0], [0, 255, 85], [0, 255, 170], [0, 255, 255], [0, 170, 255], [0, 85, 255],
  [0, 0, 255], [85, 0, 255], [170, 0, 255], [255, 0, 255], [255, 0, 170], [255, 0, 85],
];

const rgb = (i: number) => `rgb(${COLORS[i]!.join(",")})`;

export function poseSvg(pose: Pose, size: number): string {
  const pts = JOINTS.map((j) => ({ x: pose[j].x * size, y: pose[j].y * size }));
  const stroke = size / 64; // 8px at 512
  const r = size / 85; // 6px at 512

  const limbs = LIMBS.map(([a, b], i) => {
    const p = pts[a]!, q = pts[b]!;
    return `<line x1="${p.x.toFixed(1)}" y1="${p.y.toFixed(1)}" x2="${q.x.toFixed(1)}" y2="${q.y.toFixed(1)}" stroke="${rgb(i)}" stroke-width="${stroke}" stroke-linecap="round" opacity="0.6"/>`;
  });
  const joints = pts.map(
    (p, i) => `<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="${r}" fill="${rgb(i)}"/>`,
  );

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}">` +
    `<rect width="${size}" height="${size}" fill="#000"/>` +
    limbs.join("") +
    joints.join("") +
    `</svg>`
  );
}

export async function renderPose(pose: Pose, size: number): Promise<Buffer> {
  return sharp(Buffer.from(poseSvg(pose, size))).png().toBuffer();
}
```

- [ ] **Step 8: テスト通過 + check**

Run: `bun test src/lib/skeleton.test.ts src/motions && bun run check`
Expected: 7 pass

- [ ] **Step 9: Commit**

```bash
git add src/motions/index.ts src/motions/index.test.ts src/lib/skeleton.ts src/lib/skeleton.test.ts
git commit -m "feat: 骨格モデルと openpose 形式 PNG の描画"
```

---

### Task 9: motions/*.ts（6 モーション）

**Files:**
- Create: `src/motions/idle.ts`, `walk.ts`, `run.ts`, `attack.ts`, `aim.ts`, `dodge.ts`, `src/motions/motions.test.ts`
- Modify: `src/motions/index.ts`（`MOTIONS` を埋める）

**Interfaces:**
- Consumes: `basePose`, `clonePose`, `facing`, `Motion`, `Dir5`, `Pose`
- Produces: `MOTIONS: Motion[]` = `[idle, walk, run, attack, aim, dodge]`（この順がシートの行順）

- [ ] **Step 1: テストを書く**

```ts
// src/motions/motions.test.ts
import { describe, expect, test } from "bun:test";
import { DIRS5, JOINTS, MOTIONS } from "./index";

describe("MOTIONS", () => {
  test("six motions in sheet order", () => {
    expect(MOTIONS.map((m) => m.id)).toEqual(["idle", "walk", "run", "attack", "aim", "dodge"]);
  });

  test("every frame of every motion and dir stays inside 0..1", () => {
    for (const m of MOTIONS)
      for (const dir of DIRS5)
        for (let i = 0; i < m.frames; i++) {
          const p = m.key(dir, i / m.frames);
          for (const j of JOINTS) {
            expect(p[j].x).toBeGreaterThanOrEqual(0);
            expect(p[j].x).toBeLessThanOrEqual(1);
            expect(p[j].y).toBeGreaterThanOrEqual(0);
            expect(p[j].y).toBeLessThanOrEqual(1);
          }
        }
  });

  test("walk swings the legs in opposite phase (side view)", () => {
    const walk = MOTIONS.find((m) => m.id === "walk")!;
    const a = walk.key("side", 0.25);
    const b = walk.key("side", 0.75);
    expect(a.rank.x - a.lank.x).toBeGreaterThan(0.02);
    expect(b.rank.x - b.lank.x).toBeLessThan(-0.02);
  });

  test("attack raises the right wrist above the shoulder at its peak", () => {
    const attack = MOTIONS.find((m) => m.id === "attack")!;
    expect(attack.key("side", 0).rwri.y).toBeLessThan(attack.key("side", 0).rsho.y);
  });

  test("dodge lowers the whole body", () => {
    const dodge = MOTIONS.find((m) => m.id === "dodge")!;
    const base = MOTIONS.find((m) => m.id === "idle")!.key("down", 0);
    expect(dodge.key("down", 0.5).nose.y).toBeGreaterThan(base.nose.y);
  });
});
```

- [ ] **Step 2: 失敗確認**

Run: `bun test src/motions/motions.test.ts`
Expected: FAIL — `MOTIONS` が空

- [ ] **Step 3: 共通ヘルパを index.ts に追加**

`src/motions/index.ts` の末尾（`MOTIONS` の前）に追加:

```ts
/**
 * Swing one leg forward/back by `amt` (positive = forward). Forward is +x in
 * profile and, when facing the viewer, a slightly lower ankle with a bent
 * knee; the mix follows `facing`.
 */
export function swingLeg(p: Pose, side: "r" | "l", dir: Dir5, amt: number): void {
  const f = facing(dir);
  const depth = 1 - Math.abs(f); // 1 in profile, 0 front/back
  const kne = p[`${side}kne`], ank = p[`${side}ank`];
  kne.x += depth * amt * 0.6;
  ank.x += depth * amt * 1.2;
  // Facing the viewer a forward leg reads as knee bend + shorter shin.
  kne.y -= Math.abs(amt) * (1 - depth) * 0.08;
  ank.y -= Math.abs(amt) * (1 - depth) * 0.04 * (amt > 0 ? 1 : 0);
}

/** Swing one arm like swingLeg; wrist leads. */
export function swingArm(p: Pose, side: "r" | "l", dir: Dir5, amt: number): void {
  const depth = 1 - Math.abs(facing(dir));
  const elb = p[`${side}elb`], wri = p[`${side}wri`];
  elb.x += depth * amt * 0.5;
  wri.x += depth * amt * 1.0;
  wri.y -= Math.abs(amt) * 0.06;
}

/** Move every joint by (dx, dy). */
export function shift(p: Pose, dx: number, dy: number): void {
  for (const j of JOINTS) {
    p[j].x += dx;
    p[j].y += dy;
  }
}
```

- [ ] **Step 4: 6 モーションを書く**

```ts
// src/motions/idle.ts
import { basePose, clonePose, shift, type Motion } from "./index";

export const idle: Motion = {
  id: "idle",
  fps: 4,
  frames: 4,
  prompt: "standing idle",
  key(dir, t) {
    const p = clonePose(basePose(dir));
    // Breathe: 1px-scale bob at 512 is 0.004; keep it visible at 64px.
    shift(p, 0, 0.01 * Math.sin(2 * Math.PI * t));
    return p;
  },
};
```

```ts
// src/motions/walk.ts
import { basePose, clonePose, swingArm, swingLeg, type Motion } from "./index";

export const walk: Motion = {
  id: "walk",
  fps: 8,
  frames: 6,
  prompt: "walking",
  key(dir, t) {
    const p = clonePose(basePose(dir));
    const s = Math.sin(2 * Math.PI * t);
    swingLeg(p, "r", dir, 0.06 * s);
    swingLeg(p, "l", dir, -0.06 * s);
    swingArm(p, "r", dir, -0.05 * s);
    swingArm(p, "l", dir, 0.05 * s);
    return p;
  },
};
```

```ts
// src/motions/run.ts
import { basePose, clonePose, facing, shift, swingArm, swingLeg, type Motion } from "./index";

export const run: Motion = {
  id: "run",
  fps: 12,
  frames: 6,
  prompt: "running",
  key(dir, t) {
    const p = clonePose(basePose(dir));
    const s = Math.sin(2 * Math.PI * t);
    swingLeg(p, "r", dir, 0.1 * s);
    swingLeg(p, "l", dir, -0.1 * s);
    swingArm(p, "r", dir, -0.08 * s);
    swingArm(p, "l", dir, 0.08 * s);
    // Lean into the run in profile; bob everywhere.
    const depth = 1 - Math.abs(facing(dir));
    for (const j of ["nose", "neck", "rsho", "lsho", "reye", "leye", "rear", "lear"] as const) p[j].x += 0.03 * depth;
    shift(p, 0, 0.015 * Math.abs(s));
    return p;
  },
};
```

```ts
// src/motions/attack.ts
import { basePose, clonePose, facing, type Motion } from "./index";

/** Overhead melee swing with the right arm: raised at t=0, down and forward by t=0.5. */
export const attack: Motion = {
  id: "attack",
  fps: 10,
  frames: 4,
  prompt: "swinging a melee weapon, attacking",
  key(dir, t) {
    const p = clonePose(basePose(dir));
    const depth = 1 - Math.abs(facing(dir));
    // angle: -90deg (straight up) -> +30deg (forward-down)
    const a = (-Math.PI / 2) + (Math.PI * 2) / 3 * Math.min(1, t * 2);
    const len = 0.22;
    p.relb.x = p.rsho.x + Math.cos(a) * len * 0.5 * (depth || 0.3);
    p.relb.y = p.rsho.y + Math.sin(a) * len * 0.5;
    p.rwri.x = p.rsho.x + Math.cos(a) * len * (depth || 0.3);
    p.rwri.y = p.rsho.y + Math.sin(a) * len;
    // Step forward on the downswing.
    p.rkne.x += depth * 0.04 * Math.min(1, t * 2);
    p.rank.x += depth * 0.08 * Math.min(1, t * 2);
    return p;
  },
};
```

```ts
// src/motions/aim.ts
import { basePose, clonePose, facing, type Motion } from "./index";

/** Two-handed rifle stance, both wrists forward at shoulder height; frame 2 is recoil. */
export const aim: Motion = {
  id: "aim",
  fps: 4,
  frames: 2,
  prompt: "aiming a rifle, two-handed stance",
  key(dir, t) {
    const p = clonePose(basePose(dir));
    const depth = 1 - Math.abs(facing(dir));
    const reach = 0.18 * (depth || 0.35);
    const recoil = t >= 0.5 ? -0.02 : 0;
    p.relb.x = p.rsho.x + reach * 0.5 + recoil;
    p.relb.y = p.rsho.y + 0.02;
    p.rwri.x = p.rsho.x + reach + recoil;
    p.rwri.y = p.rsho.y;
    p.lelb.x = p.lsho.x + reach * 0.6 + recoil;
    p.lelb.y = p.lsho.y + 0.01;
    p.lwri.x = p.lsho.x + reach * 1.1 + recoil;
    p.lwri.y = p.lsho.y - 0.01;
    return p;
  },
};
```

```ts
// src/motions/dodge.ts
import { basePose, clonePose, facing, shift, type Motion } from "./index";

/** Crouching lunge: lowest at the middle frame. */
export const dodge: Motion = {
  id: "dodge",
  fps: 12,
  frames: 4,
  prompt: "dodging, crouching lunge",
  key(dir, t) {
    const p = clonePose(basePose(dir));
    const depth = 1 - Math.abs(facing(dir));
    const k = Math.sin(Math.PI * t); // 0 -> 1 -> 0
    // Drop the upper body; knees come up to meet it.
    for (const j of ["nose", "neck", "rsho", "lsho", "relb", "lelb", "rwri", "lwri", "rhip", "lhip", "reye", "leye", "rear", "lear"] as const)
      p[j].y += 0.08 * k;
    p.rkne.y -= 0.03 * k;
    p.lkne.y -= 0.03 * k;
    p.rkne.x += depth * 0.05 * k;
    p.lkne.x -= depth * 0.03 * k;
    shift(p, depth * 0.04 * k, 0);
    return p;
  },
};
```

- [ ] **Step 5: index.ts の MOTIONS を埋める**

`export const MOTIONS: Motion[] = [];` を削除し、ファイル末尾に:

```ts
import { idle } from "./idle";
import { walk } from "./walk";
import { run } from "./run";
import { attack } from "./attack";
import { aim } from "./aim";
import { dodge } from "./dodge";

/** Sheet row order. */
export const MOTIONS: Motion[] = [idle, walk, run, attack, aim, dodge];
export const motionById = (id: string): Motion | undefined => MOTIONS.find((m) => m.id === id);
```

循環 import（各 motion が `./index` を import し、index が各 motion を import）は ESM では動く。`basePose` 等は関数なので評価順の問題なし。oxlint が `import/no-cycle` を出したら `.oxlintrc.json` で `"import/no-cycle": "off"` にする。

- [ ] **Step 6: テスト通過 + check**

Run: `bun test src/motions && bun run check`
Expected: 10 pass。範囲外の関節が出たら該当モーションの振幅を下げる。

- [ ] **Step 7: Commit**

```bash
git add src/motions
git commit -m "feat: idle/walk/run/attack/aim/dodge のモーション定義"
```

---

### Task 10: stages/poses.ts

**Files:**
- Modify: `src/stages/poses.ts`

**Interfaces:**
- Consumes: `MOTIONS`, `DIRS5`, `renderPose`
- Produces: `out/poses/<motion>/<dir5>/<frame>.png`（frame は 0 始まり、ゼロ埋めなし）。後続は `posePath(motion, dir, frame)` を使う:
  ```ts
  export const posePath = (motion: string, dir: Dir5, frame: number) => join(OUT_DIR, "poses", motion, dir, `${frame}.png`)
  ```

- [ ] **Step 1: poses.ts を書く**

```ts
// src/stages/poses.ts
/**
 * `px poses [--only walk,run] [--size 512]` — render every openpose skeleton.
 * Character-independent; run once, rerun after editing src/motions/.
 */

import { dirname, join } from "node:path";
import { ensureDir, flag } from "../lib/comfy";
import { OUT_DIR } from "../lib/paths";
import { renderPose } from "../lib/skeleton";
import { DIRS5, MOTIONS, type Dir5 } from "../motions";

export const posePath = (motion: string, dir: Dir5, frame: number): string =>
  join(OUT_DIR, "poses", motion, dir, `${frame}.png`);

export async function run(argv: string[]): Promise<void> {
  const size = Number(flag(argv, "size") ?? 512);
  const only = flag(argv, "only")?.split(",").map((s) => s.trim());
  const selected = only ? MOTIONS.filter((m) => only.includes(m.id)) : MOTIONS;
  const unknown = only?.filter((id) => !MOTIONS.some((m) => m.id === id)) ?? [];
  if (unknown.length) {
    console.error(`unknown --only ${unknown.join(", ")}; expected ${MOTIONS.map((m) => m.id).join(", ")}`);
    process.exit(1);
  }

  let n = 0;
  for (const m of selected)
    for (const dir of DIRS5)
      for (let i = 0; i < m.frames; i++) {
        const dest = posePath(m.id, dir, i);
        await ensureDir(dirname(dest));
        await Bun.write(dest, await renderPose(m.key(dir, i / m.frames), size));
        n++;
      }
  console.log(`${n} poses -> out/poses/`);
}
```

- [ ] **Step 2: 実行して目視**

Run: `bun run px poses`
Expected: `130 poses -> out/poses/`（(4+6+6+4+2+4) × 5）。`out/poses/walk/side/0.png` と `3.png` を開いて脚が前後していることを確認。

- [ ] **Step 3: check + Commit**

```bash
bun run check
git add src/stages/poses.ts
git commit -m "feat: px poses — 骨格 PNG を一括生成"
```

---

### Task 11: stages/sprites.ts

**Files:**
- Modify: `src/stages/sprites.ts`

**Interfaces:**
- Consumes: `loadChar`, `resolveLoras`, `buildSd15`, `MOTIONS`, `DIRS5`, `posePath`, `uploadImage`
- Produces: `out/sprites/<char>/<motion>/<dir5>/<frame>_00001_.png`（ComfyUI が連番を付ける。pixelate は `<frame>_*.png` の最新 1 枚を取る）

- [ ] **Step 1: sprites.ts を書く**

```ts
// src/stages/sprites.ts
/**
 * `px sprites <char> [--motion walk] [--dir down] [--seed n] [--strength 0.65] [--dry]`
 *
 * One SD1.5 generation per (motion, dir, frame): character LoRA + the
 * pre-rendered openpose skeleton. The seed is fixed per (char, motion) so the
 * only thing that changes between frames is the skeleton.
 */

import { basename } from "node:path";
import { connect, flag, positional, resolveLoras, resolveSeed, runWorkflow, uploadImage } from "../lib/comfy";
import { loadChar } from "../lib/chars";
import { buildSd15 } from "../lib/sd15";
import { DIRS5, MOTIONS, type Dir5 } from "../motions";
import { posePath } from "./poses";

const DEFAULT_CKPT = "aziibpixelmix_v10.safetensors";
const SUFFIX = "full body, chibi, 2 heads tall, flat grey background, no shadow, centered, pixel art style";
const VALUE_FLAGS = new Set(["--motion", "--dir", "--seed", "--strength", "--ckpt", "--steps", "--cfg"]);

const usage = () =>
  `usage: bun run px sprites <char> [--motion ${MOTIONS.map((m) => m.id).join("|")}] [--dir ${DIRS5.join("|")}]\n` +
  `                          [--seed n] [--strength 0.65] [--ckpt file] [--steps 25] [--cfg 6] [--dry]`;

/** Seed per (char, motion): base seed from --seed or random, plus a stable per-motion offset. */
const motionSeed = (base: number, motionIndex: number) => (base + motionIndex * 1000) % 2 ** 32;

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
    console.error(`chars/${char.name}.yaml has no  lora:  — train one first (bun run px dataset ${char.name} --hero ...)`);
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

  let done = 0, failed = 0;
  for (const m of motions) {
    const seed = motionSeed(baseSeed, MOTIONS.indexOf(m));
    for (const dir of dirs)
      for (let i = 0; i < m.frames; i++) {
        const pose = posePath(m.id, dir, i);
        const image = api ? await uploadImage(api, pose) : basename(pose);
        const label = `${m.id}/${dir}/${i}`;
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
        try {
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
```

`uploadImage` は同名ファイル（`0.png`）を motion / dir ごとに上書きするので、フレーム名の衝突は問題ない（各 enqueue の直前にアップロードするため）。

- [ ] **Step 2: --dry で確認**

まず `chars/scavenger.yaml` に一時的に `lora: scavenger` を書いて:

Run: `bun run px sprites scavenger --motion aim --dir down --dry | Select-String "control_net_name|lora_name|aiming" `
Expected: 3 種類ヒット。確認後 yaml の `lora:` は学習済みでなければ戻す。

- [ ] **Step 3: 実機で 1 モーション回す（LoRA 学習後）**

Run: `bun run px sprites scavenger --motion idle --dir down`
Expected: `out/sprites/scavenger/idle/down/0_00001_.png` 〜 `3_00001_.png`。灰背景の全身キャラが 4 枚、ポーズがほぼ同じ。

- [ ] **Step 4: check + Commit**

```bash
bun run check
git add src/stages/sprites.ts
git commit -m "feat: px sprites — LoRA + openpose でフレーム差分生成"
```

---

### Task 12: lib/pixelate.ts + palettes/apoc.json

**Files:**
- Create: `src/lib/pixelate.ts`, `src/lib/pixelate.test.ts`, `palettes/apoc.json`

**Interfaces:**
- Produces:
  ```ts
  interface Rgba { width: number; height: number; data: Uint8Array }   // RGBA、行優先
  removeBackground(img: Rgba, key: [r,g,b], tolerance: number): Rgba     // 四隅 flood fill、透明化
  bbox(img: Rgba): { x0, y0, x1, y1 } | undefined                         // 不透明域、x1/y1 は排他
  placeOnSquare(img: Rgba, box, canvas: number, scale: number): Rgba     // 足元中央基準で配置
  boxDownscale(img: Rgba, size: number): Rgba                            // alpha 加重平均、alpha 二値化
  quantize(img: Rgba, palette: [r,g,b][]): Rgba
  medianCut(img: Rgba, n: number): [r,g,b][]
  hflip(img: Rgba): Rgba
  loadPalette(name: string): Promise<[r,g,b][]>                          // palettes/<name>.json
  readRgba(path): Promise<Rgba>; writePng(img: Rgba, path): Promise<void>  // sharp
  ```

- [ ] **Step 1: テストを書く**

```ts
// src/lib/pixelate.test.ts
import { describe, expect, test } from "bun:test";
import { bbox, boxDownscale, hflip, medianCut, placeOnSquare, quantize, removeBackground, type Rgba } from "./pixelate";

const GREY: [number, number, number] = [128, 128, 128];

/** w×h filled with `fill`, then `rects` painted over. */
function img(w: number, h: number, fill: number[], rects: { x: number; y: number; w: number; h: number; c: number[] }[] = []): Rgba {
  const data = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) data.set(fill, i * 4);
  for (const r of rects)
    for (let y = r.y; y < r.y + r.h; y++)
      for (let x = r.x; x < r.x + r.w; x++) data.set(r.c, (y * w + x) * 4);
  return { width: w, height: h, data };
}
const px = (i: Rgba, x: number, y: number) => Array.from(i.data.slice((y * i.width + x) * 4, (y * i.width + x) * 4 + 4));

describe("removeBackground", () => {
  test("clears the backdrop but keeps enclosed grey", () => {
    // 8x8 grey, red 4x4 box in the middle with a grey pixel inside it
    const i = img(8, 8, [...GREY, 255], [
      { x: 2, y: 2, w: 4, h: 4, c: [255, 0, 0, 255] },
      { x: 3, y: 3, w: 1, h: 1, c: [...GREY, 255] },
    ]);
    const out = removeBackground(i, GREY, 40);
    expect(px(out, 0, 0)[3]).toBe(0);
    expect(px(out, 7, 7)[3]).toBe(0);
    expect(px(out, 2, 2)).toEqual([255, 0, 0, 255]);
    expect(px(out, 3, 3)[3]).toBe(255); // enclosed grey survives
  });
  test("tolerance", () => {
    const i = img(4, 4, [140, 130, 120, 255]);
    expect(px(removeBackground(i, GREY, 40), 0, 0)[3]).toBe(0);
    expect(px(removeBackground(i, GREY, 5), 0, 0)[3]).toBe(255);
  });
});

test("bbox of opaque pixels", () => {
  const i = img(8, 8, [0, 0, 0, 0], [{ x: 2, y: 3, w: 3, h: 2, c: [1, 2, 3, 255] }]);
  expect(bbox(i)).toEqual({ x0: 2, y0: 3, x1: 5, y1: 5 });
  expect(bbox(img(2, 2, [0, 0, 0, 0]))).toBeUndefined();
});

test("placeOnSquare anchors the box's bottom-centre", () => {
  const i = img(8, 8, [0, 0, 0, 0], [{ x: 2, y: 3, w: 3, h: 2, c: [9, 9, 9, 255] }]);
  const out = placeOnSquare(i, bbox(i)!, 16, 2);
  // box becomes 6x4, bottom at y=16, centred: x 5..11, y 12..16
  expect(px(out, 5, 12)[3]).toBe(255);
  expect(px(out, 10, 15)[3]).toBe(255);
  expect(px(out, 4, 12)[3]).toBe(0);
  expect(px(out, 5, 11)[3]).toBe(0);
});

test("boxDownscale averages and binarises alpha", () => {
  const i = img(4, 4, [0, 0, 0, 0], [{ x: 0, y: 0, w: 2, h: 2, c: [200, 100, 0, 255] }]);
  const out = boxDownscale(i, 2);
  expect(px(out, 0, 0)).toEqual([200, 100, 0, 255]);
  expect(px(out, 1, 1)[3]).toBe(0);
  // half-covered cell: 2 of 4 pixels opaque -> alpha 255 (>= 50%)
  const j = img(4, 4, [0, 0, 0, 0], [{ x: 0, y: 0, w: 2, h: 1, c: [10, 20, 30, 255] }]);
  expect(px(boxDownscale(j, 2), 0, 0)).toEqual([10, 20, 30, 255]);
});

test("quantize snaps to nearest palette colour and leaves alpha", () => {
  const i = img(1, 2, [0, 0, 0, 0], [{ x: 0, y: 0, w: 1, h: 1, c: [250, 5, 5, 255] }]);
  const out = quantize(i, [[255, 0, 0], [0, 0, 255]]);
  expect(px(out, 0, 0)).toEqual([255, 0, 0, 255]);
  expect(px(out, 0, 1)[3]).toBe(0);
});

test("medianCut returns n colours from opaque pixels only", () => {
  const i = img(4, 1, [0, 0, 0, 0], [
    { x: 0, y: 0, w: 2, h: 1, c: [255, 0, 0, 255] },
    { x: 2, y: 0, w: 2, h: 1, c: [0, 0, 255, 255] },
  ]);
  const pal = medianCut(i, 2).sort((a, b) => a[0] - b[0]);
  expect(pal).toEqual([[0, 0, 255], [255, 0, 0]]);
});

test("hflip mirrors x", () => {
  const i = img(2, 1, [0, 0, 0, 0], [{ x: 0, y: 0, w: 1, h: 1, c: [7, 7, 7, 255] }]);
  expect(px(hflip(i), 1, 0)).toEqual([7, 7, 7, 255]);
  expect(px(hflip(i), 0, 0)[3]).toBe(0);
});
```

- [ ] **Step 2: 失敗確認**

Run: `bun test src/lib/pixelate.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: pixelate.ts を書く**

```ts
// src/lib/pixelate.ts
/**
 * Pure RGBA operations for turning a 512px render into a 64px sprite. sharp
 * only decodes and encodes; everything in between is plain typed arrays so it
 * can be unit-tested without fixtures.
 */

import { join } from "node:path";
import sharp from "sharp";
import { PALETTES_DIR } from "./paths";

export interface Rgba {
  width: number;
  height: number;
  /** Row-major RGBA, 4 bytes per pixel. */
  data: Uint8Array;
}
export type Rgb = [number, number, number];
export interface Box { x0: number; y0: number; x1: number; y1: number }

const blank = (width: number, height: number): Rgba => ({ width, height, data: new Uint8Array(width * height * 4) });

export async function readRgba(path: string): Promise<Rgba> {
  const { data, info } = await sharp(path).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { width: info.width, height: info.height, data: new Uint8Array(data) };
}

export async function writePng(img: Rgba, path: string): Promise<void> {
  await sharp(Buffer.from(img.data), { raw: { width: img.width, height: img.height, channels: 4 } })
    .png()
    .toFile(path);
}

export async function loadPalette(name: string): Promise<Rgb[]> {
  const file = Bun.file(join(PALETTES_DIR, `${name}.json`));
  if (!(await file.exists())) throw new Error(`no such palette: palettes/${name}.json`);
  const doc = (await file.json()) as { colors: string[] };
  return doc.colors.map((hex) => {
    const m = /^#?([0-9a-f]{6})$/i.exec(hex);
    if (!m) throw new Error(`palettes/${name}.json: bad colour ${JSON.stringify(hex)}`);
    const v = parseInt(m[1]!, 16);
    return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
  });
}

const dist2 = (a: Rgb, r: number, g: number, b: number) =>
  (a[0] - r) ** 2 + (a[1] - g) ** 2 + (a[2] - b) ** 2;

/**
 * Flood fill from the four corners through every pixel within `tolerance`
 * (euclidean RGB) of `key`, setting alpha 0. Pixels of the key colour that
 * are enclosed by the character are never reached, so they survive.
 */
export function removeBackground(img: Rgba, key: Rgb, tolerance: number): Rgba {
  const { width: w, height: h } = img;
  const out = { ...img, data: new Uint8Array(img.data) };
  const seen = new Uint8Array(w * h);
  const tol2 = tolerance * tolerance;
  const stack: number[] = [0, w - 1, (h - 1) * w, h * w - 1];

  const isKey = (i: number) => {
    const o = i * 4;
    return dist2(key, out.data[o]!, out.data[o + 1]!, out.data[o + 2]!) <= tol2;
  };

  while (stack.length) {
    const i = stack.pop()!;
    if (seen[i] || !isKey(i)) continue;
    seen[i] = 1;
    out.data[i * 4 + 3] = 0;
    const x = i % w;
    if (x > 0) stack.push(i - 1);
    if (x < w - 1) stack.push(i + 1);
    if (i >= w) stack.push(i - w);
    if (i < (h - 1) * w) stack.push(i + w);
  }
  return out;
}

/** Bounding box of alpha > 0; undefined when the image is fully transparent. x1/y1 exclusive. */
export function bbox(img: Rgba): Box | undefined {
  let x0 = img.width, y0 = img.height, x1 = -1, y1 = -1;
  for (let y = 0; y < img.height; y++)
    for (let x = 0; x < img.width; x++)
      if (img.data[(y * img.width + x) * 4 + 3]! > 0) {
        if (x < x0) x0 = x;
        if (x >= x1) x1 = x + 1;
        if (y < y0) y0 = y;
        if (y >= y1) y1 = y + 1;
      }
  return x1 === -1 ? undefined : { x0, y0, x1, y1 };
}

/**
 * Copy `box` out of `img` onto a `canvas`×`canvas` transparent square, scaled
 * by `scale` (nearest), with the box's bottom-centre pinned to the canvas's
 * bottom-centre. Frames of one motion share one `scale`, so feet stay put.
 */
export function placeOnSquare(img: Rgba, box: Box, canvas: number, scale: number): Rgba {
  const out = blank(canvas, canvas);
  const bw = Math.round((box.x1 - box.x0) * scale);
  const bh = Math.round((box.y1 - box.y0) * scale);
  const ox = Math.round(canvas / 2 - bw / 2);
  const oy = canvas - bh;
  for (let y = 0; y < bh; y++) {
    const sy = box.y0 + Math.floor(y / scale);
    const dy = oy + y;
    if (dy < 0 || dy >= canvas) continue;
    for (let x = 0; x < bw; x++) {
      const sx = box.x0 + Math.floor(x / scale);
      const dx = ox + x;
      if (dx < 0 || dx >= canvas) continue;
      const s = (sy * img.width + sx) * 4, d = (dy * canvas + dx) * 4;
      out.data[d] = img.data[s]!; out.data[d + 1] = img.data[s + 1]!;
      out.data[d + 2] = img.data[s + 2]!; out.data[d + 3] = img.data[s + 3]!;
    }
  }
  return out;
}

/**
 * Box-filter downscale of a square image to `size`. Colour is the alpha-
 * weighted mean of the covered cell; alpha becomes 255 when at least half the
 * cell was opaque, else 0 — no soft edges on a sprite.
 */
export function boxDownscale(img: Rgba, size: number): Rgba {
  const out = blank(size, size);
  const fx = img.width / size, fy = img.height / size;
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const x0 = Math.floor(x * fx), x1 = Math.max(x0 + 1, Math.floor((x + 1) * fx));
      const y0 = Math.floor(y * fy), y1 = Math.max(y0 + 1, Math.floor((y + 1) * fy));
      let r = 0, g = 0, b = 0, a = 0, n = 0;
      for (let sy = y0; sy < y1; sy++)
        for (let sx = x0; sx < x1; sx++) {
          const o = (sy * img.width + sx) * 4;
          const al = img.data[o + 3]!;
          r += img.data[o]! * al; g += img.data[o + 1]! * al; b += img.data[o + 2]! * al;
          a += al; n++;
        }
      const d = (y * size + x) * 4;
      if (a === 0 || a < n * 127.5) continue;
      out.data[d] = Math.round(r / a); out.data[d + 1] = Math.round(g / a);
      out.data[d + 2] = Math.round(b / a); out.data[d + 3] = 255;
    }
  return out;
}

export function quantize(img: Rgba, palette: Rgb[]): Rgba {
  const out = { ...img, data: new Uint8Array(img.data) };
  for (let i = 0; i < img.width * img.height; i++) {
    const o = i * 4;
    if (out.data[o + 3] === 0) continue;
    let best = 0, bd = Infinity;
    for (let p = 0; p < palette.length; p++) {
      const d = dist2(palette[p]!, out.data[o]!, out.data[o + 1]!, out.data[o + 2]!);
      if (d < bd) { bd = d; best = p; }
    }
    const c = palette[best]!;
    out.data[o] = c[0]; out.data[o + 1] = c[1]; out.data[o + 2] = c[2];
  }
  return out;
}

/** Median cut over opaque pixels; returns up to n colours (fewer if the image has fewer). */
export function medianCut(img: Rgba, n: number): Rgb[] {
  const px: Rgb[] = [];
  for (let i = 0; i < img.width * img.height; i++)
    if (img.data[i * 4 + 3]! > 0) px.push([img.data[i * 4]!, img.data[i * 4 + 1]!, img.data[i * 4 + 2]!]);
  if (!px.length) return [];

  let buckets: Rgb[][] = [px];
  while (buckets.length < n) {
    // Split the bucket with the widest channel range.
    let bi = -1, bc = 0, br = -1;
    buckets.forEach((b, i) => {
      if (b.length < 2) return;
      for (let c = 0; c < 3; c++) {
        let lo = 255, hi = 0;
        for (const p of b) { if (p[c]! < lo) lo = p[c]!; if (p[c]! > hi) hi = p[c]!; }
        if (hi - lo > br) { br = hi - lo; bi = i; bc = c; }
      }
    });
    if (bi === -1) break;
    const b = buckets[bi]!.sort((p, q) => p[bc]! - q[bc]!);
    const mid = b.length >> 1;
    buckets.splice(bi, 1, b.slice(0, mid), b.slice(mid));
  }
  return buckets.map((b) => {
    const s = b.reduce((acc, p) => [acc[0] + p[0], acc[1] + p[1], acc[2] + p[2]], [0, 0, 0]);
    return [Math.round(s[0] / b.length), Math.round(s[1] / b.length), Math.round(s[2] / b.length)];
  });
}

export function hflip(img: Rgba): Rgba {
  const out = blank(img.width, img.height);
  for (let y = 0; y < img.height; y++)
    for (let x = 0; x < img.width; x++) {
      const s = (y * img.width + x) * 4, d = (y * img.width + (img.width - 1 - x)) * 4;
      out.data.set(img.data.subarray(s, s + 4), d);
    }
  return out;
}
```

- [ ] **Step 4: パレットを置く**

```json
{
  "name": "apoc",
  "colors": [
    "#0b0a0a", "#1f1b18", "#332c26", "#4a4038", "#6b5a4c", "#8c7a66", "#b09a80", "#d4c2a3",
    "#3a3a3a", "#5c5c5c", "#7f7f7f", "#a5a5a5", "#c8c8c8", "#e8e4dc",
    "#5a3a1e", "#8a5a2a", "#b8773a", "#d9a05b", "#f0c987",
    "#6b2a1e", "#a63d2a", "#d9633f", "#e8935c",
    "#2f3a24", "#4a5a30", "#6f7f45", "#98a662",
    "#243a4a", "#3a5a70", "#5c8aa0",
    "#f2d3b8", "#c99a7a"
  ]
}
```

- [ ] **Step 5: テスト通過 + check**

Run: `bun test src/lib/pixelate.test.ts && bun run check`
Expected: 8 pass

- [ ] **Step 6: Commit**

```bash
git add src/lib/pixelate.ts src/lib/pixelate.test.ts palettes/apoc.json
git commit -m "feat: ドット化の純関数群（背景除去・整列・box 縮小・量子化・反転）"
```

---

### Task 13: stages/pixelate.ts

**Files:**
- Modify: `src/stages/pixelate.ts`

**Interfaces:**
- Consumes: `lib/pixelate.ts` 全部、`MOTIONS`, `DIRS5`, `FLIP`
- Produces: `out/px/<char>/<motion>/<dir8>/<frame>.png`（`--size` の正方形、透明背景）。後続の sheet は `pxPath(char, motion, dir8, frame)`:
  ```ts
  export const pxPath = (char: string, motion: string, dir: Dir8, frame: number) => join(OUT_DIR, "px", char, motion, dir, `${frame}.png`)
  ```

- [ ] **Step 1: pixelate.ts を書く**

```ts
// src/stages/pixelate.ts
/**
 * `px pixelate <char> [--size 64] [--palette apoc|auto] [--bg-tolerance 40] [--motion m]`
 *
 * out/sprites -> out/px: remove the grey backdrop, pin feet, scale every frame
 * of a motion by the same factor, box-filter down, snap to the palette, and
 * mirror the side-ish directions into their left-facing twins.
 */

import { readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { ensureDir, flag, positional } from "../lib/comfy";
import { loadChar } from "../lib/chars";
import { OUT_DIR } from "../lib/paths";
import {
  bbox, boxDownscale, hflip, loadPalette, medianCut, placeOnSquare, quantize, readRgba,
  removeBackground, writePng, type Rgb, type Rgba,
} from "../lib/pixelate";
import { DIRS5, FLIP, MOTIONS, type Dir5, type Dir8 } from "../motions";

const GREY: Rgb = [128, 128, 128];
const VALUE_FLAGS = new Set(["--size", "--palette", "--bg-tolerance", "--motion"]);

export const pxPath = (char: string, motion: string, dir: Dir8, frame: number): string =>
  join(OUT_DIR, "px", char, motion, dir, `${frame}.png`);

/** Newest `<frame>_*.png` ComfyUI wrote for this frame, or undefined. */
async function latestRender(dir: string, frame: number): Promise<string | undefined> {
  const files = (await readdir(dir).catch(() => [] as string[]))
    .filter((f) => f.startsWith(`${frame}_`) && f.endsWith(".png"))
    .sort();
  return files.length ? join(dir, files[files.length - 1]!) : undefined;
}

export async function run(argv: string[]): Promise<void> {
  const name = positional(argv, VALUE_FLAGS);
  if (!name) {
    console.error(`usage: bun run px pixelate <char> [--size 64] [--palette apoc|auto] [--bg-tolerance 40] [--motion m]`);
    process.exit(1);
  }
  const char = await loadChar(name).catch((e: Error) => {
    console.error(e.message);
    process.exit(1);
  });

  const size = Number(flag(argv, "size") ?? 64);
  const paletteName = flag(argv, "palette") ?? "apoc";
  const tolerance = Number(flag(argv, "bg-tolerance") ?? 40);
  const fixed = paletteName === "auto" ? undefined : await loadPalette(paletteName);
  const motionFlag = flag(argv, "motion");
  const motions = motionFlag ? MOTIONS.filter((m) => m.id === motionFlag) : MOTIONS;

  const srcRoot = join(OUT_DIR, "sprites", char.name);
  let written = 0, missing = 0;

  for (const m of motions)
    for (const dir of DIRS5) {
      // Pass 1: cut out every frame, remember the tallest box.
      const cut: { frame: number; img: Rgba; box: ReturnType<typeof bbox> }[] = [];
      for (let i = 0; i < m.frames; i++) {
        const src = await latestRender(join(srcRoot, m.id, dir), i);
        if (!src) { missing++; continue; }
        const img = removeBackground(await readRgba(src), GREY, tolerance);
        cut.push({ frame: i, img, box: bbox(img) });
      }
      const tallest = Math.max(0, ...cut.map((c) => (c.box ? c.box.y1 - c.box.y0 : 0)));
      if (!tallest) continue;
      // Leave 4% headroom on the working canvas; one scale for the whole motion.
      const work = 512;
      const scale = (work * 0.96) / tallest;

      // Pass 2: place, downscale, quantize, write + mirror.
      for (const c of cut) {
        if (!c.box) { missing++; continue; }
        const placed = placeOnSquare(c.img, c.box, work, scale);
        const small = boxDownscale(placed, size);
        const pal = fixed ?? medianCut(small, 16);
        const final = quantize(small, pal);
        const [main, mirror] = FLIP[dir as Dir5];
        for (const [d8, img] of [[main, final], ...(mirror ? [[mirror, hflip(final)] as const] : [])] as const) {
          const dest = pxPath(char.name, m.id, d8, c.frame);
          await ensureDir(dirname(dest));
          await writePng(img, dest);
          written++;
        }
      }
    }

  console.log(`${written} frames -> out/px/${char.name}/  (${size}px, palette ${paletteName})`);
  if (missing) {
    console.error(`${missing} frames had no render in out/sprites/${char.name}/ — run  bun run px sprites ${char.name}`);
    process.exitCode = 1;
  }
  if (!written) process.exitCode = 1;
}
```

- [ ] **Step 2: 実行**

Run: `bun run px pixelate scavenger --motion idle`
Expected: `out/px/scavenger/idle/{down,downright,right,upright,up,upleft,left,downleft}/0..3.png`（sprites が down のみなら `down/` の 4 枚 + 他方向は missing で exit 1）。`down/0.png` が 64×64、透明背景、パレット色のみ。

- [ ] **Step 3: check + Commit**

```bash
bun run check
git add src/stages/pixelate.ts
git commit -m "feat: px pixelate — 64px ドット化と 8 方向展開"
```

---

### Task 14: lib/sheet.ts + stages/sheet.ts

**Files:**
- Create: `src/lib/sheet.ts`, `src/lib/sheet.test.ts`
- Modify: `src/stages/sheet.ts`

**Interfaces:**
- Produces:
  ```ts
  interface SheetRow { name: string; frames: Rgba[]; fps: number }
  interface SheetMeta { frameSize: number; columns: number; animations: { name: string; row: number; frames: number; fps: number }[] }
  composeSheet(rows: SheetRow[], frameSize: number): { image: Rgba; meta: SheetMeta }
  ```

- [ ] **Step 1: テストを書く**

```ts
// src/lib/sheet.test.ts
import { expect, test } from "bun:test";
import type { Rgba } from "./pixelate";
import { composeSheet } from "./sheet";

const solid = (size: number, c: number[]): Rgba => {
  const data = new Uint8Array(size * size * 4);
  for (let i = 0; i < size * size; i++) data.set(c, i * 4);
  return { width: size, height: size, data };
};
const px = (i: Rgba, x: number, y: number) => Array.from(i.data.slice((y * i.width + x) * 4, (y * i.width + x) * 4 + 4));

test("composeSheet lays rows by motion and pads short rows", () => {
  const { image, meta } = composeSheet(
    [
      { name: "walk_down", fps: 8, frames: [solid(2, [1, 0, 0, 255]), solid(2, [2, 0, 0, 255]), solid(2, [3, 0, 0, 255])] },
      { name: "aim_down", fps: 4, frames: [solid(2, [9, 0, 0, 255])] },
    ],
    2,
  );
  expect(image.width).toBe(6); // 3 columns * 2
  expect(image.height).toBe(4);
  expect(px(image, 0, 0)[0]).toBe(1);
  expect(px(image, 4, 1)[0]).toBe(3);
  expect(px(image, 0, 2)[0]).toBe(9);
  expect(px(image, 2, 2)[3]).toBe(0); // padded
  expect(meta).toEqual({
    frameSize: 2,
    columns: 3,
    animations: [
      { name: "walk_down", row: 0, frames: 3, fps: 8 },
      { name: "aim_down", row: 1, frames: 1, fps: 4 },
    ],
  });
});

test("frame of the wrong size throws", () => {
  expect(() => composeSheet([{ name: "x", fps: 1, frames: [solid(3, [0, 0, 0, 255])] }], 2)).toThrow(/3x3/);
});
```

- [ ] **Step 2: 失敗確認**

Run: `bun test src/lib/sheet.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: sheet.ts を書く**

```ts
// src/lib/sheet.ts
/** Grid a set of same-sized frames into one sheet: row = animation, column = frame. */

import type { Rgba } from "./pixelate";

export interface SheetRow { name: string; frames: Rgba[]; fps: number }
export interface SheetMeta {
  frameSize: number;
  columns: number;
  animations: { name: string; row: number; frames: number; fps: number }[];
}

export function composeSheet(rows: SheetRow[], frameSize: number): { image: Rgba; meta: SheetMeta } {
  const columns = Math.max(1, ...rows.map((r) => r.frames.length));
  const width = columns * frameSize, height = rows.length * frameSize;
  const image: Rgba = { width, height, data: new Uint8Array(width * height * 4) };

  rows.forEach((row, r) =>
    row.frames.forEach((f, c) => {
      if (f.width !== frameSize || f.height !== frameSize)
        throw new Error(`${row.name}[${c}] is ${f.width}x${f.height}, expected ${frameSize}x${frameSize}`);
      for (let y = 0; y < frameSize; y++) {
        const s = y * frameSize * 4;
        const d = ((r * frameSize + y) * width + c * frameSize) * 4;
        image.data.set(f.data.subarray(s, s + frameSize * 4), d);
      }
    }),
  );

  return {
    image,
    meta: {
      frameSize,
      columns,
      animations: rows.map((row, r) => ({ name: row.name, row: r, frames: row.frames.length, fps: row.fps })),
    },
  };
}
```

- [ ] **Step 4: テスト通過**

Run: `bun test src/lib/sheet.test.ts`
Expected: 2 pass

- [ ] **Step 5: stages/sheet.ts を書く**

```ts
// src/stages/sheet.ts
/**
 * `px sheet <char> [--size 64]` — out/px/<char> -> out/sheets/<char>.png + .json
 * Rows: MOTIONS order × DIRS8 order. Missing frames are skipped and reported.
 */

import { join } from "node:path";
import { ensureDir, flag, positional } from "../lib/comfy";
import { loadChar } from "../lib/chars";
import { OUT_DIR } from "../lib/paths";
import { readRgba, writePng } from "../lib/pixelate";
import { composeSheet, type SheetRow } from "../lib/sheet";
import { DIRS8, MOTIONS } from "../motions";
import { pxPath } from "./pixelate";

export async function run(argv: string[]): Promise<void> {
  const name = positional(argv, new Set(["--size"]));
  if (!name) {
    console.error(`usage: bun run px sheet <char> [--size 64]`);
    process.exit(1);
  }
  const char = await loadChar(name).catch((e: Error) => {
    console.error(e.message);
    process.exit(1);
  });
  const size = Number(flag(argv, "size") ?? 64);

  const rows: SheetRow[] = [];
  let missing = 0;
  for (const m of MOTIONS)
    for (const dir of DIRS8) {
      const frames = [];
      for (let i = 0; i < m.frames; i++) {
        const p = pxPath(char.name, m.id, dir, i);
        if (await Bun.file(p).exists()) frames.push(await readRgba(p));
        else missing++;
      }
      if (frames.length) rows.push({ name: `${m.id}_${dir}`, frames, fps: m.fps });
    }

  if (!rows.length) {
    console.error(`nothing in out/px/${char.name}/ — run  bun run px pixelate ${char.name}`);
    process.exit(1);
  }

  const { image, meta } = composeSheet(rows, size);
  const dir = join(OUT_DIR, "sheets");
  await ensureDir(dir);
  await writePng(image, join(dir, `${char.name}.png`));
  await Bun.write(join(dir, `${char.name}.json`), JSON.stringify(meta, null, 2));
  console.log(`out/sheets/${char.name}.png  ${image.width}x${image.height}, ${rows.length} rows\nout/sheets/${char.name}.json`);
  if (missing) {
    console.error(`${missing} frames missing (rows shortened)`);
    process.exitCode = 1;
  }
}
```

- [ ] **Step 6: 実行**

Run: `bun run px sheet scavenger`
Expected: `out/sheets/scavenger.png` と `.json`。Aseprite で File → Import Sprite Sheet、64×64 grid で読める。

- [ ] **Step 7: check + Commit**

```bash
bun run check
git add src/lib/sheet.ts src/lib/sheet.test.ts src/stages/sheet.ts
git commit -m "feat: px sheet — スプライトシート PNG + JSON"
```

---

### Task 15: README.md と CLAUDE.md

**Files:**
- Create: `README.md`, `CLAUDE.md`

- [ ] **Step 1: README.md を書く**

```md
# pixel-2d-game-art

ComfyUI + bun/TypeScript で、トップダウン 2D アクションゲーム向けのキャラクタースプライトシートを生成する。
SD1.5 + openpose ControlNet + キャラ LoRA で 512px のフレームを出し、TS 側で 64px に落として 8 方向のシートに組む。

設計: `docs/superpowers/specs/2026-09-05-pixel-sprite-pipeline-design.md`

## 必要なもの

- Bun（`mise install`）
- ComfyUI 起動中（既定 `http://127.0.0.1:8188`、`COMFY_URL` で変更）
- モデル: `SD1.5\dreamshaper_8`, `aziibpixelmix_v10`, `control_v11p_sd15_openpose_fp16`, Qwen-Image-Edit 2511 (GGUF Q5) + Lightning LoRA
- LoRA 学習用に ai-toolkit（別途 checkout）

## セットアップ

```bash
bun install
bun run codegen      # ComfyUI 起動中に。src/types/nodes.ts を生成
bun test
```

## 使い方

```bash
bun run px concept  scavenger                        # 候補 4 枚 -> out/concept/scavenger/
bun run px dataset  scavenger --hero out/concept/scavenger/scavenger_00002_.png
                                                     # -> out/dataset/scavenger/ + train.yaml
# 目視で不良画像を削除 -> ai-toolkit で学習 -> safetensors を ComfyUI の loras/ へ
#   -> chars/scavenger.yaml に lora: scavenger を追記
bun run px poses                                     # 骨格 PNG (1 回)
bun run px sprites  scavenger [--motion walk] [--dir down] [--seed n] [--strength 0.65]
bun run px pixelate scavenger [--size 64] [--palette apoc|auto]
bun run px sheet    scavenger                        # -> out/sheets/scavenger.png + .json
```

どのコマンドも `--dry` でグラフ JSON だけ印字する（ComfyUI 不要）。

キャラ定義は `chars/<name>.yaml`。モーションは `src/motions/`、パレットは `palettes/`。
```

- [ ] **Step 2: CLAUDE.md を書く**

```md
# pixel-2d-game-art

ピクセルアート スプライト生成パイプライン。設計は `docs/superpowers/specs/`、実装計画は `docs/superpowers/plans/`。

## コード編集後

`src/` を触ったら必ず:

```bash
bun run check   # format -> lint -> typecheck
bun test
```

`src/types/nodes.ts` は `bun run codegen` の生成物。手で編集しない。モデル追加後に再生成（ComfyUI 起動中）。

## 構成

- `src/px.ts` サブコマンド dispatcher。ステージは `src/stages/*.ts` の `run(argv)`
- ComfyUI まわりは `src/lib/comfy.ts`、グラフは `src/lib/sd15.ts` / `qwen-edit.ts`
- 画像処理は `src/lib/pixelate.ts` / `skeleton.ts` / `sheet.ts` の純関数。テストは隣の `*.test.ts`
- ステージ間は `out/` のパス規約で受け渡す（`posePath` / `pxPath` を使う）

## 出力

すべて `out/` 配下（gitignore 済み）。
```

- [ ] **Step 3: Commit**

```bash
git add README.md CLAUDE.md
git commit -m "docs: README と CLAUDE.md"
```

---

## Self-review

- **Spec coverage**: concept (T6) / dataset + train.yaml (T7) / poses + 骨格 + 6 モーション (T8-10) / sprites + seed 固定 + CN 0.65 (T11) / pixelate 5 工程 + 反転 (T12-13) / sheet + JSON (T14) / chars yaml 検証 (T4) / エラー処理は各 stage に内包 / テストは各 lib に内包。spec の「caption は構図・ポーズ・背景を記述」は Global Constraints の通り最小 caption に変更（spec を Task 7 完了時に 1 行追記すること）。
- **Placeholder**: なし。
- **Type consistency**: `Rgba` / `Rgb` / `Box` は `lib/pixelate.ts` 由来で `lib/sheet.ts` と stages が import。`Dir5` / `Dir8` / `FLIP` / `MOTIONS` は `motions/index.ts`。`posePath` は `stages/poses.ts`、`pxPath` は `stages/pixelate.ts` を export し sprites / sheet が import。`positional()` は Task 2 で定義、以降全 stage で使用。
