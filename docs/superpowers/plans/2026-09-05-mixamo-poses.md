# Mixamo → OpenPose + Depth 骨格生成 実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 手書き TS 骨格を捨て、Mixamo の Y Bot + Action Adventure Pack を Blender headless で再生して 8 方向 × N フレームの openpose 骨格 JSON と depth PNG を書き出し、`px sprites` で openpose + depth の 2 段 ControlNet を使う。

**Architecture:** `px poses` が `scripts/mixamo_poses.py` を Blender に渡して `out/poses/<motion>/<dir8>/<k>.json` と `<k>.depth.png` を作らせ、JSON を既存 `renderPose` で openpose PNG に描く。`src/motions/index.ts` は宣言だけ（`{id, fbx, frames, loop, fps, prompt}`）になり、`sd15.ts` の ControlNet は配列で chain する。生成方向は `GEN_DIRS`（5 方向）+ pixelate の反転で 8 方向。

**Tech Stack:** bun / TypeScript、sharp、Blender 5.2.1 LTS（MS Store 版、Python 3.11 + numpy 内蔵）、ComfyUI SD1.5 + `control_v11p_sd15_openpose_fp16` + `control_v11f1p_sd15_depth_fp16`。

Spec: `docs/superpowers/specs/2026-09-05-mixamo-poses-design.md`

## Global Constraints

- `src/` を触ったら `bun run check`（format → lint → typecheck）と `bun test` を通す。`src/types/nodes.ts` は手で編集しない。
- Blender は通常インストール版 5.2.1（`C:\Program Files\Blender Foundation\Blender 5.2\blender.exe`、PATH には無い）。Bun から直接 spawn でき、stdout / stderr も取れる（検証済）。**MS Store 版は使わない**（`blender.exe` が ACL で起動不可、launcher は stdout を返さない）。
- Blender で未捕捉例外が出ても終了コードは 0（検証済）。**Python の `main()` は try/except で包み、失敗時は `sys.exit(1)`**。
- Blender 5.x API: compositor は `scene.compositing_node_group`（`scene.node_tree` は無い）、出力ノードは `NodeGroupOutput` + `interface.new_socket`、Map Range は `ShaderNodeMapRange`（`CompositorNodeMapRange` は無い、clamp 属性は `.clamp`）。`read_factory_settings` は使わない（FBX importer の context が壊れる）。既定シーンのオブジェクトを全部消して使う。
- Mixamo 座標（Blender import 後）: キャラの正面は **-Y**、右腕は -X、左腕は +X、上は +Z。armature の scale は 0.01 なので、ボーン行列から取る方向ベクトルは必ず正規化する。Head ボーンのローカル軸は **Y = 上、Z = 前**。
- 方位（camera azimuth、度）: `down 0, downright 315, right 270, upright 225, up 180, upleft 135, left 90, downleft 45`。カメラ位置 = 注視点 + `(sin az · cos el, −cos az · cos el, sin el) × 10`。**az=90 はキャラが画面左向きになる**ので `right` は 270。
- テキスト系ファイル（.md / .yaml / README）は通常の日本語で書く。

### spec からの変更点（実装前検証で判明）

- Depth は `Normalize` ではなく `ShaderNodeMapRange`（From = カメラ距離 ±0.8 m、To = 1→0、clamp）。フレーム間で絶対深度が揃う。背景は 0（黒）。
- `frameTimes` の TS 複製は作らない。Python 側に `frame_times()` と起動時の `assert` 自己チェックを置く。
- Blender の探索順: `--blender <exe>` → 環境変数 `BLENDER` → PATH の `blender` → win32 なら `C:\Program Files\Blender Foundation\Blender */blender.exe`（新しい版を優先）。

---

## File Structure

| ファイル | 役割 |
|---|---|
| `src/motions/index.ts` | JOINTS / Pose / DIRS8 / GEN_DIRS / FLIP と MOTIONS 宣言。骨格計算は持たない |
| `src/motions/{idle,walk,run,attack,aim,dodge}.ts` | 削除 |
| `src/motions/index.test.ts`, `motions.test.ts` | 宣言の整合テストに書き換え |
| `src/lib/skeleton.ts` | `poseSvg` / `renderPose`（visible 対応）+ `poseFromJson` |
| `src/lib/sd15.ts` | `controls: Control[]` で ControlNet を chain。`SD15_CONTROLNET_DEPTH` 追加 |
| `scripts/mixamo_poses.py` | Blender 内で FBX 再生 → JSON + depth PNG |
| `mixamo/` | FBX 置き場（gitignore）。`mixamo/README.md` に入手先 |
| `src/stages/poses.ts` | Blender 起動 + JSON → openpose PNG。`posePath` / `depthPath` |
| `src/stages/sprites.ts` | GEN_DIRS、depth CN、`from behind`、SUFFIX 変更 |
| `src/stages/pixelate.ts` | `Dir5` → `GenDir`、`DIRS5` → `GEN_DIRS` |
| `README.md`, `.gitignore` | 使い方 / mixamo/ の ignore |

---

### Task 1: MOTIONS を宣言だけにする

**Files:**
- Modify: `src/motions/index.ts`（全面書き換え）
- Delete: `src/motions/idle.ts`, `walk.ts`, `run.ts`, `attack.ts`, `aim.ts`, `dodge.ts`
- Modify: `src/motions/index.test.ts`（全面書き換え）
- Delete: `src/motions/motions.test.ts`（内容は index.test.ts に統合）

**Interfaces:**
- Produces: `JOINTS`, `Joint`, `Pt { x; y; visible? }`, `Pose`, `DIRS8`, `Dir8`, `GEN_DIRS`, `GenDir`, `FLIP: Record<GenDir, [Dir8, Dir8?]>`, `Motion { id; fbx; frames; loop; fps; prompt }`, `MOTIONS: Motion[]`
- 後続タスクは `basePose` / `BODY` / `DIRS5` / `Dir5` / `Motion.key` を一切使わない。

- [ ] **Step 1: 新しいテストを書く**

`src/motions/index.test.ts` を次の内容で置き換える:

```ts
import { describe, expect, test } from "bun:test";
import { DIRS8, FLIP, GEN_DIRS, JOINTS, MOTIONS } from "./index";

test("JOINTS is COCO-18 in openpose order", () => {
  expect(JOINTS).toHaveLength(18);
  expect(JOINTS[0]).toBe("nose");
  expect(JOINTS[1]).toBe("neck");
  expect(JOINTS[17]).toBe("lear");
});

test("FLIP covers every Dir8 exactly once", () => {
  const covered = Object.values(FLIP).flat().filter(Boolean);
  expect(covered.slice().sort()).toEqual([...DIRS8].sort());
});

test("GEN_DIRS are a subset of DIRS8 and the keys of FLIP", () => {
  for (const d of GEN_DIRS) expect(DIRS8).toContain(d);
  expect(Object.keys(FLIP).sort()).toEqual([...GEN_DIRS].sort());
});

describe("MOTIONS", () => {
  test("ids are unique", () => {
    const ids = MOTIONS.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
  test("every motion names an .fbx and at least one frame", () => {
    for (const m of MOTIONS) {
      expect(m.fbx).toMatch(/\.fbx$/);
      expect(m.frames).toBeGreaterThanOrEqual(1);
      expect(m.fps).toBeGreaterThan(0);
      expect(m.prompt.length).toBeGreaterThan(0);
    }
  });
  test("sheet order starts with idle, walk, run", () => {
    expect(MOTIONS.slice(0, 3).map((m) => m.id)).toEqual(["idle", "walk", "run"]);
  });
});
```

- [ ] **Step 2: 失敗を確認**

Run: `bun test src/motions/index.test.ts`
Expected: FAIL（`GEN_DIRS` が export されていない）

- [ ] **Step 3: `src/motions/index.ts` を書き換える**

```ts
/**
 * The joint model every stage shares (COCO-18 in openpose order) and the
 * motion catalogue. Skeletons are no longer authored here: `px poses` renders
 * them from the Mixamo clips named below via scripts/mixamo_poses.py.
 */

export const JOINTS = [
  "nose",
  "neck",
  "rsho",
  "relb",
  "rwri",
  "lsho",
  "lelb",
  "lwri",
  "rhip",
  "rkne",
  "rank",
  "lhip",
  "lkne",
  "lank",
  "reye",
  "leye",
  "rear",
  "lear",
] as const;
export type Joint = (typeof JOINTS)[number];

export interface Pt {
  /** Normalised image coords, 0..1, y down. */
  x: number;
  y: number;
  /** false = occluded (e.g. the face seen from behind); drawn as absent. Default true. */
  visible?: boolean;
}
export type Pose = Record<Joint, Pt>;

export const DIRS8 = [
  "down",
  "downright",
  "right",
  "upright",
  "up",
  "upleft",
  "left",
  "downleft",
] as const;
export type Dir8 = (typeof DIRS8)[number];

/** Directions we actually generate; pixelate mirrors them into the rest. */
export const GEN_DIRS = ["down", "downright", "right", "upright", "up"] as const;
export type GenDir = (typeof GEN_DIRS)[number];

/** Which Dir8s each generated direction becomes; the second is the mirror. */
export const FLIP: Record<GenDir, [Dir8, Dir8?]> = {
  down: ["down"],
  up: ["up"],
  right: ["right", "left"],
  downright: ["downright", "downleft"],
  upright: ["upright", "upleft"],
};

export interface Motion {
  id: string;
  /** File name under mixamo/. */
  fbx: string;
  frames: number;
  /** true: the last frame stops just before the clip wraps (walk cycles). false: the last frame is the clip's end (jump). */
  loop: boolean;
  /** Playback fps written to the sheet JSON. */
  fps: number;
  /** One phrase appended to the sprite prompt. */
  prompt: string;
}

/** Sheet row order. */
export const MOTIONS: Motion[] = [
  { id: "idle", fbx: "idle.fbx", frames: 4, loop: true, fps: 4, prompt: "standing idle" },
  { id: "walk", fbx: "walking.fbx", frames: 8, loop: true, fps: 8, prompt: "walking" },
  { id: "run", fbx: "running.fbx", frames: 8, loop: true, fps: 10, prompt: "running" },
  { id: "jump", fbx: "jumping up.fbx", frames: 6, loop: false, fps: 8, prompt: "jumping up" },
  { id: "fall", fbx: "falling idle.fbx", frames: 4, loop: true, fps: 6, prompt: "falling in the air" },
  {
    id: "land",
    fbx: "hard landing.fbx",
    frames: 6,
    loop: false,
    fps: 8,
    prompt: "landing from a fall, crouching",
  },
  {
    id: "sneak",
    fbx: "crouched sneaking right.fbx",
    frames: 8,
    loop: true,
    fps: 8,
    prompt: "sneaking crouched",
  },
];
```

- [ ] **Step 4: 旧ファイルを削除**

```powershell
git rm src/motions/idle.ts src/motions/walk.ts src/motions/run.ts src/motions/attack.ts src/motions/aim.ts src/motions/dodge.ts src/motions/motions.test.ts
```

- [ ] **Step 5: テスト実行**

Run: `bun test src/motions/index.test.ts`
Expected: PASS（6 tests）。他のテスト（skeleton.test.ts, sprites.test.ts）はこの時点で壊れる。Task 2 / 6 で直す。`bun run typecheck` もまだ通らない。

- [ ] **Step 6: Commit**

```powershell
git add src/motions
git commit -m "refactor: MOTIONS を Mixamo クリップの宣言だけにする"
```

---

### Task 2: skeleton.ts の visible 対応と poseFromJson

**Files:**
- Modify: `src/lib/skeleton.ts`
- Modify: `src/lib/skeleton.test.ts`（全面書き換え）

**Interfaces:**
- Consumes: `JOINTS`, `Pose`, `Pt` from `../motions`
- Produces: `poseSvg(pose: Pose, size: number): string`（変更なしのシグネチャ）、`renderPose(pose: Pose, size: number): Promise<Buffer>`（変更なし）、**新規** `poseFromJson(raw: unknown, label: string): Pose`

- [ ] **Step 1: テストを書き換える**

`src/lib/skeleton.test.ts`:

```ts
import { expect, test } from "bun:test";
import sharp from "sharp";
import { JOINTS, type Pose } from "../motions";
import { poseFromJson, poseSvg, renderPose } from "./skeleton";

/** Every joint at a distinct spot inside the canvas. */
const standing = (): Pose =>
  Object.fromEntries(JOINTS.map((j, i) => [j, { x: 0.3 + i * 0.02, y: 0.2 + i * 0.03 }])) as Pose;

test("svg has 18 joints and 17 limbs", () => {
  const svg = poseSvg(standing(), 512);
  expect(svg.match(/<circle /g)).toHaveLength(18);
  expect(svg.match(/<line /g)).toHaveLength(17);
  expect(svg).toContain('fill="#000"');
});

test("an invisible joint drops its circle and every limb touching it", () => {
  const p = standing();
  p.nose.visible = false; // nose touches neck, reye, leye -> 3 limbs
  const svg = poseSvg(p, 512);
  expect(svg.match(/<circle /g)).toHaveLength(17);
  expect(svg.match(/<line /g)).toHaveLength(14);
});

test("renders a 512px png with a black background and coloured pixels", async () => {
  const png = await renderPose(standing(), 512);
  const { data, info } = await sharp(png).raw().toBuffer({ resolveWithObject: true });
  expect(info.width).toBe(512);
  expect(info.height).toBe(512);
  expect([data[0], data[1], data[2]]).toEqual([0, 0, 0]);
  let coloured = 0;
  for (let i = 0; i < data.length; i += info.channels)
    if (data[i]! + data[i + 1]! + data[i + 2]! > 0) coloured++;
  expect(coloured).toBeGreaterThan(500);
});

test("poseFromJson accepts the blender output and defaults visible to true", () => {
  const raw = Object.fromEntries(JOINTS.map((j) => [j, { x: 0.5, y: 0.5 }]));
  (raw.nose as { visible?: boolean }).visible = false;
  const p = poseFromJson(raw, "walk/down/0");
  expect(p.nose.visible).toBe(false);
  expect(p.neck.visible).toBe(true);
  expect(p.lank).toEqual({ x: 0.5, y: 0.5, visible: true });
});

test("poseFromJson rejects a missing joint", () => {
  const raw = Object.fromEntries(JOINTS.slice(1).map((j) => [j, { x: 0.5, y: 0.5 }]));
  expect(() => poseFromJson(raw, "walk/down/0")).toThrow(/walk\/down\/0.*nose/);
});
```

- [ ] **Step 2: 失敗を確認**

Run: `bun test src/lib/skeleton.test.ts`
Expected: FAIL（`poseFromJson` が無い、invisible テストが 18/17 のまま）

- [ ] **Step 3: 実装**

`src/lib/skeleton.ts` の `poseSvg` を置き換え、`poseFromJson` を追加:

```ts
export function poseSvg(pose: Pose, size: number): string {
  const pts = JOINTS.map((j) => ({
    x: pose[j].x * size,
    y: pose[j].y * size,
    visible: pose[j].visible !== false,
  }));
  const stroke = size / 64; // 8px at 512
  const r = size / 85; // 6px at 512

  // An occluded joint is simply absent, the way a detector would report it.
  const limbs = LIMBS.flatMap(([a, b], i) => {
    const p = pts[a]!,
      q = pts[b]!;
    if (!p.visible || !q.visible) return [];
    return `<line x1="${p.x.toFixed(1)}" y1="${p.y.toFixed(1)}" x2="${q.x.toFixed(1)}" y2="${q.y.toFixed(1)}" stroke="${rgb(i)}" stroke-width="${stroke}" stroke-linecap="round" opacity="0.6"/>`;
  });
  const joints = pts.flatMap((p, i) =>
    p.visible
      ? `<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="${r}" fill="${rgb(i)}"/>`
      : [],
  );

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}">` +
    `<rect width="${size}" height="${size}" fill="#000"/>` +
    limbs.join("") +
    joints.join("") +
    `</svg>`
  );
}

/** Parse one `<k>.json` written by scripts/mixamo_poses.py. `label` names the frame in errors. */
export function poseFromJson(raw: unknown, label: string): Pose {
  const obj = (raw ?? {}) as Record<string, { x?: unknown; y?: unknown; visible?: unknown }>;
  const pose = {} as Pose;
  for (const j of JOINTS) {
    const p = obj[j];
    if (!p || typeof p.x !== "number" || typeof p.y !== "number")
      throw new Error(`${label}: joint ${j} missing or not {x, y}`);
    pose[j] = { x: p.x, y: p.y, visible: p.visible !== false };
  }
  return pose;
}
```

- [ ] **Step 4: テスト実行**

Run: `bun test src/lib/skeleton.test.ts`
Expected: PASS（5 tests）

- [ ] **Step 5: Commit**

```powershell
git add src/lib/skeleton.ts src/lib/skeleton.test.ts
git commit -m "feat: skeleton の visible 関節スキップと poseFromJson"
```

---

### Task 3: sd15.ts の ControlNet を配列で chain

**Files:**
- Modify: `src/lib/sd15.ts`
- Modify: `src/lib/sd15.test.ts`

**Interfaces:**
- Produces: `SD15_CONTROLNET_OPENPOSE`（既存）、**新規** `SD15_CONTROLNET_DEPTH = "control_v11f1p_sd15_depth_fp16.safetensors"`、**新規** `interface Control { model: string; image: string; strength: number; endPercent?: number }`、`Sd15Opts.controls?: Control[]`（`control` は削除）

- [ ] **Step 1: テストを書き換える**

`src/lib/sd15.test.ts` の `"control wires openpose without a preprocessor"` を次の 2 つに置き換える:

```ts
  test("one control wires openpose without a preprocessor", () => {
    const wf = buildSd15({
      ...base,
      controls: [{ model: SD15_CONTROLNET_OPENPOSE, image: "walk_down_0.png", strength: 0.65 }],
    });
    expect(byType(wf, "ControlNetLoader")[0]!.inputs.control_net_name).toBe(
      SD15_CONTROLNET_OPENPOSE,
    );
    const apply = byType(wf, "ControlNetApplyAdvanced")[0]!;
    expect(apply.inputs.strength).toBe(0.65);
    expect(apply.inputs.end_percent).toBe(0.85);
    expect(nodes(wf).some((n) => n.class_type.includes("Preprocessor"))).toBe(false);
    expect(byType(wf, "LoadImage")[0]!.inputs.image).toBe("walk_down_0.png");
  });

  test("two controls chain: the second apply consumes the first's conditioning", () => {
    const wf = buildSd15({
      ...base,
      controls: [
        { model: SD15_CONTROLNET_OPENPOSE, image: "walk_down_0.png", strength: 0.6 },
        { model: SD15_CONTROLNET_DEPTH, image: "walk_down_0.depth.png", strength: 0.5 },
      ],
    });
    const prompt = wf.prompt as Record<string, { class_type: string; inputs: Record<string, unknown> }>;
    const applies = Object.entries(prompt).filter(([, n]) => n.class_type === "ControlNetApplyAdvanced");
    expect(applies).toHaveLength(2);
    const [[firstId, first], [, second]] = applies as [string, { inputs: Record<string, unknown> }][];
    expect(first.inputs.strength).toBe(0.6);
    expect(second.inputs.strength).toBe(0.5);
    // second.positive is a link [nodeId, outputIndex] into the first apply
    expect((second.inputs.positive as [string, number])[0]).toBe(firstId);
    expect(byType(wf, "ControlNetLoader").map((n) => n.inputs.control_net_name)).toEqual([
      SD15_CONTROLNET_OPENPOSE,
      SD15_CONTROLNET_DEPTH,
    ]);
    const ks = byType(wf, "KSampler")[0]!;
    expect((ks.inputs.positive as [string, number])[0]).toBe(applies[1]![0]);
  });
```

import 行を `import { buildSd15, SD15_CONTROLNET_DEPTH, SD15_CONTROLNET_OPENPOSE } from "./sd15";` にする。

- [ ] **Step 2: 失敗を確認**

Run: `bun test src/lib/sd15.test.ts`
Expected: FAIL（`SD15_CONTROLNET_DEPTH` が無い、`controls` が無視される）

- [ ] **Step 3: 実装**

`src/lib/sd15.ts` を次で置き換える:

```ts
/**
 * SD1.5 as a graph builder: one checkpoint, optional LoRA chain, optional
 * ControlNet chain. Used by concept (plain) and sprites (LoRA + openpose + depth).
 */

import {
  WorkflowBuilder,
  type CheckpointLoaderSimpleInputs,
  type ControlNetLoaderInputs,
  type KSamplerInputs,
  type LoadImageInputs,
  type LoraLoaderInputs,
} from "../types/nodes";
import type { Lora } from "./comfy";

export const SD15_CONTROLNET_OPENPOSE = "control_v11p_sd15_openpose_fp16.safetensors";
export const SD15_CONTROLNET_DEPTH = "control_v11f1p_sd15_depth_fp16.safetensors";

export interface Control {
  /** ControlNet filename as ControlNetLoader wants it. */
  model: string;
  /**
   * Hint image already in the model's input form (openpose stick figure, depth
   * map) and already in ComfyUI's input/ dir. No preprocessor.
   */
  image: string;
  strength: number;
  endPercent?: number;
}

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
  /** Applied in order; each one conditions on the previous one's output. */
  controls?: Control[];
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

  const encoded = {
    positive: w.CLIPTextEncode({ clip, text: o.positive }),
    negative: w.CLIPTextEncode({ clip, text: o.negative }),
  };
  let cond: Pick<KSamplerInputs, "positive" | "negative"> = {
    positive: encoded.positive.CONDITIONING,
    negative: encoded.negative.CONDITIONING,
  };
  for (const c of o.controls ?? []) {
    const applied = w.ControlNetApplyAdvanced({
      positive: cond.positive,
      negative: cond.negative,
      control_net: w.ControlNetLoader({
        control_net_name: c.model as ControlNetLoaderInputs["control_net_name"],
      }).CONTROL_NET,
      image: w.LoadImage({ image: c.image as LoadImageInputs["image"] }).IMAGE,
      strength: c.strength,
      start_percent: 0,
      // Releasing before the end lets the last steps clean up anatomy the
      // hint was forcing; holding to 1 keeps the pose but stiffens it.
      end_percent: c.endPercent ?? 0.85,
    });
    cond = { positive: applied.positive, negative: applied.negative };
  }

  const latent = w.EmptyLatentImage({ width: o.width, height: o.height, batch_size: o.count });

  const sampled = w.KSampler({
    model,
    positive: cond.positive,
    negative: cond.negative,
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

`KSamplerInputs` が `src/types/nodes.ts` に無ければ（`grep -n "export interface KSamplerInputs" src/types/nodes.ts` で確認）、`cond` の型を `{ positive: Parameters<WorkflowBuilder["KSampler"]>[0]["positive"]; negative: Parameters<WorkflowBuilder["KSampler"]>[0]["negative"] }` にする。

- [ ] **Step 4: テスト実行**

Run: `bun test src/lib/sd15.test.ts`
Expected: PASS（5 tests）。`sprites.ts` がまだ `control:` を渡しているので typecheck は Task 6 まで通らない。

- [ ] **Step 5: Commit**

```powershell
git add src/lib/sd15.ts src/lib/sd15.test.ts
git commit -m "feat: sd15 の ControlNet を配列で chain、depth 定数追加"
```

---

### Task 4: Blender スクリプト `scripts/mixamo_poses.py` と `mixamo/`

**Files:**
- Create: `scripts/mixamo_poses.py`
- Create: `mixamo/README.md`
- Modify: `.gitignore`（`mixamo/*.fbx` を追加）
- 手動: `C:\Users\harum\Downloads\Action Adventure Pack\*.fbx` を `mixamo/` にコピー

**Interfaces:**
- Consumes: 起動引数 `-- --out <dir> --motions <json> --fbx-dir <dir> --size 512 --elev 25`。`--motions` の JSON は `[{ "id": "walk", "fbx": "walking.fbx", "frames": 8, "loop": true }, ...]`
- Produces: `<out>/<id>/<dir8>/<k>.json`（`{ "<joint>": { "x", "y", "visible" } }` × 18）、`<out>/<id>/<dir8>/<k>.depth.png`（`size`² グレースケール）。進捗は stdout、失敗時は stderr に traceback と終了コード 1。

- [ ] **Step 1: FBX を配置して ignore**

```powershell
New-Item -ItemType Directory -Force mixamo | Out-Null
Copy-Item "C:\Users\harum\Downloads\Action Adventure Pack\*.fbx" mixamo\
Add-Content .gitignore "mixamo/*.fbx"
```

`mixamo/README.md`:

```markdown
# mixamo/

`px poses` が読む Mixamo の FBX。git には入れない（`mixamo/*.fbx` は ignore）。

入手: https://www.mixamo.com/ で Character = **Y Bot** を選び、
- `Y Bot.fbx`: Character を Format FBX Binary, Pose T-pose でダウンロード
- 各モーション: Animations の **Action Adventure Pack** を FBX Binary, Skin = Without Skin, 30 fps でダウンロードし、ファイル名はそのまま（`walking.fbx`, `running.fbx`, `jumping up.fbx`, `falling idle.fbx`, `hard landing.fbx`, `crouched sneaking right.fbx`, `idle.fbx`）

どのモーションを使うかは `src/motions/index.ts` の `MOTIONS`。
```

- [ ] **Step 2: スクリプトを書く**

`scripts/mixamo_poses.py`:

```python
"""
Render openpose joints + depth maps for every motion / direction / frame from
Mixamo FBX clips. Runs inside Blender:

  blender --background --python scripts/mixamo_poses.py -- \
      --out out/poses --motions out/poses/motions.json --fbx-dir mixamo --size 512 --elev 25

Writes <out>/<id>/<dir>/<k>.json and <k>.depth.png. Progress goes to stdout.
Blender exits 0 even on an uncaught exception, so main() is wrapped and exits
1 on failure.
"""

import json
import math
import os
import sys
import traceback

import bpy
from bpy_extras.object_utils import world_to_camera_view
from mathutils import Vector

DIRS8 = ["down", "downright", "right", "upright", "up", "upleft", "left", "downleft"]
# Camera azimuth per direction. The character faces -Y after FBX import; a
# camera at -Y (az 0) sees the front, az 270 (-X) sees the character walking
# to the viewer's right.
AZIMUTH = {"down": 0, "downright": 315, "right": 270, "upright": 225,
           "up": 180, "upleft": 135, "left": 90, "downleft": 45}
CAM_DIST = 10.0
DEPTH_RANGE = 0.8  # metres either side of the hips that map to white..black

# openpose joint -> mixamorig bone whose head is the joint.
BONES = {
    "neck": "Neck",
    "rsho": "RightArm", "relb": "RightForeArm", "rwri": "RightHand",
    "lsho": "LeftArm", "lelb": "LeftForeArm", "lwri": "LeftHand",
    "rhip": "RightUpLeg", "rkne": "RightLeg", "rank": "RightFoot",
    "lhip": "LeftUpLeg", "lkne": "LeftLeg", "lank": "LeftFoot",
}
# Face points as offsets in the Head bone's frame (x = character's left, y = up, z = forward), metres.
HEAD_OFFSETS = {
    "nose": (0.0, 0.05, 0.10),
    "reye": (-0.03, 0.08, 0.09), "leye": (0.03, 0.08, 0.09),
    "rear": (-0.07, 0.07, 0.0), "lear": (0.07, 0.07, 0.0),
}
EAR_HIDE_DOT = 0.8  # |head.x · camera| above this = profile view, far ear hidden


def log(msg):
    print("[mixamo_poses] " + msg, flush=True)


def frame_times(start, end, n, loop):
    """Clip frame numbers for n samples. loop: stop before the wrap; else include the end."""
    if n == 1:
        return [start]
    span = end - start
    step = span / n if loop else span / (n - 1)
    return [start + k * step for k in range(n)]


def self_check():
    assert frame_times(1, 33, 4, True) == [1, 9, 17, 25]
    assert frame_times(1, 31, 4, False) == [1, 11, 21, 31]
    assert frame_times(5, 9, 1, True) == [5]


def parse_args():
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    opts = {"size": "512", "elev": "25"}
    key = None
    for a in argv:
        if a.startswith("--"):
            key = a[2:]
            opts[key] = True
        elif key:
            opts[key] = a
            key = None
    for k in ("out", "motions", "fbx-dir"):
        if k not in opts or opts[k] is True:
            raise SystemExit(f"missing --{k}")
    return opts


def clear_scene():
    for o in list(bpy.data.objects):
        bpy.data.objects.remove(o, do_unlink=True)
    for a in list(bpy.data.actions):
        bpy.data.actions.remove(a)


def import_armature(path):
    before = set(bpy.data.objects)
    bpy.ops.import_scene.fbx(filepath=path)
    new = [o for o in bpy.data.objects if o not in before]
    return next(o for o in new if o.type == "ARMATURE"), new


def setup_camera(scene, size):
    cam_data = bpy.data.cameras.new("cam")
    cam_data.type = "ORTHO"
    cam_data.clip_start = 0.1
    cam_data.clip_end = 100
    cam = bpy.data.objects.new("cam", cam_data)
    scene.collection.objects.link(cam)
    scene.camera = cam
    scene.render.resolution_x = scene.render.resolution_y = size
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = "PNG"
    scene.render.image_settings.color_mode = "BW"
    scene.render.image_settings.color_depth = "8"
    scene.render.engine = "BLENDER_WORKBENCH"
    scene.view_settings.view_transform = "Standard"
    return cam


def setup_depth_compositor(scene):
    """Depth pass -> map [CAM_DIST-R, CAM_DIST+R] to [1, 0], clamped. Background is 0."""
    bpy.context.view_layer.use_pass_z = True
    scene.render.use_compositing = True
    ng = bpy.data.node_groups.new("px_depth", "CompositorNodeTree")
    scene.compositing_node_group = ng
    rl = ng.nodes.new("CompositorNodeRLayers")
    mr = ng.nodes.new("ShaderNodeMapRange")
    mr.inputs["From Min"].default_value = CAM_DIST - DEPTH_RANGE
    mr.inputs["From Max"].default_value = CAM_DIST + DEPTH_RANGE
    mr.inputs["To Min"].default_value = 1.0
    mr.inputs["To Max"].default_value = 0.0
    mr.clamp = True
    ng.interface.new_socket("Image", in_out="OUTPUT", socket_type="NodeSocketColor")
    out = ng.nodes.new("NodeGroupOutput")
    ng.links.new(rl.outputs["Depth"], mr.inputs["Value"])
    ng.links.new(mr.outputs[0], out.inputs[0])


def place_camera(cam, target, az_deg, el_deg):
    az, el = math.radians(az_deg), math.radians(el_deg)
    d = Vector((math.sin(az) * math.cos(el), -math.cos(az) * math.cos(el), math.sin(el)))
    cam.location = target + d * CAM_DIST
    cam.rotation_euler = d.to_track_quat("Z", "Y").to_euler()
    return d


def rest_height(rig):
    zs = []
    for b in rig.data.bones:
        zs.append((rig.matrix_world @ b.head_local).z)
        zs.append((rig.matrix_world @ b.tail_local).z)
    return max(zs) - min(zs)


def joint_world(rig, name):
    return rig.matrix_world @ rig.pose.bones["mixamorig:" + name].head


def head_frame(rig):
    """(origin, x, y, z) of the Head bone in world space, axes normalised (the rig is scaled 0.01)."""
    m = rig.matrix_world @ rig.pose.bones["mixamorig:Head"].matrix
    return (m.translation.copy(), m.col[0].xyz.normalized(), m.col[1].xyz.normalized(), m.col[2].xyz.normalized())


def pose_json(scene, cam, rig, cam_dir):
    def project(p):
        v = world_to_camera_view(scene, cam, p)
        return round(v.x, 4), round(1 - v.y, 4)

    pose = {}
    for joint, bone in BONES.items():
        x, y = project(joint_world(rig, bone))
        pose[joint] = {"x": x, "y": y, "visible": True}
    origin, ax, ay, az = head_frame(rig)
    facing = az.dot(cam_dir)      # >0 face toward camera
    side = ax.dot(cam_dir)        # >0 character's left side toward camera
    for joint, (ox, oy, oz) in HEAD_OFFSETS.items():
        x, y = project(origin + ax * ox + ay * oy + az * oz)
        visible = True
        if joint in ("nose", "reye", "leye") and facing < 0:
            visible = False
        if joint == "rear" and side > EAR_HIDE_DOT:
            visible = False
        if joint == "lear" and side < -EAR_HIDE_DOT:
            visible = False
        pose[joint] = {"x": x, "y": y, "visible": visible}
    return pose


def main():
    self_check()
    opts = parse_args()
    out_dir, fbx_dir = os.path.abspath(opts["out"]), os.path.abspath(opts["fbx-dir"])
    size, elev = int(opts["size"]), float(opts["elev"])
    os.makedirs(out_dir, exist_ok=True)
    with open(opts["motions"], encoding="utf-8") as f:
        motions = json.load(f)

    missing = [m["fbx"] for m in motions if not os.path.exists(os.path.join(fbx_dir, m["fbx"]))]
    ybot = os.path.join(fbx_dir, "Y Bot.fbx")
    if not os.path.exists(ybot):
        missing.append("Y Bot.fbx")
    if missing:
        sys.stderr.write("missing in " + fbx_dir + ": " + ", ".join(missing) + "\n")
        sys.exit(1)

    scene = bpy.context.scene
    clear_scene()
    rig, _ = import_armature(ybot)
    rig.animation_data_create()
    cam = setup_camera(scene, size)
    setup_depth_compositor(scene)
    cam.data.ortho_scale = rest_height(rig) * 1.15
    log(f"blender {bpy.app.version_string}, rig height {rest_height(rig):.2f} m, {len(motions)} motions, elev {elev}")

    written = 0
    for m in motions:
        anim, new = import_armature(os.path.join(fbx_dir, m["fbx"]))
        action = anim.animation_data.action
        rig.animation_data.action = action
        for o in new:
            bpy.data.objects.remove(o, do_unlink=True)
        start, end = action.frame_range
        times = frame_times(start, end, int(m["frames"]), bool(m["loop"]))
        log(f"{m['id']}: {m['fbx']} frames {start:.0f}..{end:.0f} -> {[round(t, 1) for t in times]}")
        for d in DIRS8:
            dest = os.path.join(out_dir, m["id"], d)
            os.makedirs(dest, exist_ok=True)
            for k, t in enumerate(times):
                scene.frame_set(int(t), subframe=t - int(t))
                bpy.context.view_layer.update()
                hips = joint_world(rig, "Hips")
                cam_dir = place_camera(cam, hips, AZIMUTH[d], elev)
                bpy.context.view_layer.update()
                with open(os.path.join(dest, f"{k}.json"), "w", encoding="utf-8") as f:
                    json.dump(pose_json(scene, cam, rig, cam_dir), f)
                scene.render.filepath = os.path.join(dest, f"{k}.depth.png")
                bpy.ops.render.render(write_still=True)
                written += 1
    log(f"done: {written} frames -> {out_dir}")


try:
    main()
except SystemExit:
    raise
except Exception:
    sys.stderr.write(traceback.format_exc())
    sys.exit(1)
```

- [ ] **Step 3: 単体で実行して確認**

`out/poses/motions.json` を手で作って走らせる:

```powershell
New-Item -ItemType Directory -Force out\poses | Out-Null
Set-Content out\poses\motions.json '[{"id":"walk","fbx":"walking.fbx","frames":4,"loop":true}]'
& "C:\Program Files\Blender Foundation\Blender 5.2\blender.exe" --background --python scripts\mixamo_poses.py -- --out out\poses --motions out\poses\motions.json --fbx-dir mixamo --size 512 --elev 25
"exit=$LASTEXITCODE"
ls out\poses\walk\right
```

Expected: exit 0、stdout に `[mixamo_poses] walk: walking.fbx frames 1..32 -> [1.0, 8.8, 16.5, 24.2]` と `[mixamo_poses] done: 32 frames`、`out/poses/walk/right/` に `0.json .. 3.json` と `0.depth.png .. 3.depth.png`。

`0.json` を開き、`rank.x > lank.x` か `rank.x < lank.x` のどちらかで足が前後に開いていること、`nose.visible` が `right` で true、`up` で false であることを見る。`0.depth.png` を画像ビューアで開き、白っぽい人型が中央、背景が黒、**画面右を向いている**ことを見る（左向きなら AZIMUTH の 90/270 が逆）。

- [ ] **Step 4: Commit**

```powershell
git add scripts/mixamo_poses.py mixamo/README.md .gitignore
git commit -m "feat: Blender で Mixamo クリップから openpose 関節 JSON と depth を書き出す"
```

---

### Task 5: `px poses` を Blender 起動 + JSON 描画にする

**Files:**
- Modify: `src/stages/poses.ts`（全面書き換え）
- Create: `src/stages/poses.test.ts`

**Interfaces:**
- Consumes: `renderPose`, `poseFromJson` (Task 2)、`MOTIONS`, `DIRS8`, `Dir8` (Task 1)、`ensureDir`, `flag` from `../lib/comfy`、`OUT_DIR`, `REPO_ROOT` from `../lib/paths`
- Produces: `posePath(motion: string, dir: Dir8, frame: number): string`（`out/poses/<motion>/<dir>/<frame>.png`）、`depthPath(motion, dir, frame)`（`.depth.png`）、`findBlender(explicit: string | undefined): Promise<string | undefined>`

- [ ] **Step 1: テストを書く**

`src/stages/poses.test.ts`:

```ts
import { expect, test } from "bun:test";
import { depthPath, findBlender, posePath } from "./poses";

test("depthPath sits next to posePath", () => {
  expect(depthPath("walk", "right", 3)).toBe(
    posePath("walk", "right", 3).replace(/\.png$/, ".depth.png"),
  );
});

test("an explicit exe wins without being checked", async () => {
  expect(await findBlender("C:\\nowhere\\blender.exe")).toBe("C:\\nowhere\\blender.exe");
});
```

- [ ] **Step 2: 失敗を確認**

Run: `bun test src/stages/poses.test.ts`
Expected: FAIL（`findBlender` / `depthPath` が無い）

- [ ] **Step 3: 実装**

`src/stages/poses.ts`:

```ts
/**
 * `px poses [--only walk,run] [--size 512] [--elev 25] [--blender exe] [--skip-blender]`
 *
 * Character-independent; run once, rerun after editing MOTIONS or mixamo/.
 * Step 1 drives Blender (scripts/mixamo_poses.py) to write joint JSON + depth
 * PNGs for every motion x 8 directions x frames; step 2 draws the openpose PNGs
 * from the JSON. `--skip-blender` reruns only step 2.
 */

import { dirname, join } from "node:path";
import { ensureDir, flag } from "../lib/comfy";
import { OUT_DIR, REPO_ROOT } from "../lib/paths";
import { poseFromJson, renderPose } from "../lib/skeleton";
import { DIRS8, MOTIONS, type Dir8 } from "../motions";

const POSES_DIR = join(OUT_DIR, "poses");
const SCRIPT = join(REPO_ROOT, "scripts", "mixamo_poses.py");
const FBX_DIR = join(REPO_ROOT, "mixamo");

export const posePath = (motion: string, dir: Dir8, frame: number): string =>
  join(POSES_DIR, motion, dir, `${frame}.png`);
export const depthPath = (motion: string, dir: Dir8, frame: number): string =>
  join(POSES_DIR, motion, dir, `${frame}.depth.png`);
const jsonPath = (motion: string, dir: Dir8, frame: number): string =>
  join(POSES_DIR, motion, dir, `${frame}.json`);

/**
 * `--blender` > $BLENDER > PATH > the Windows installer's default location
 * (newest version first). The Microsoft Store build is not usable: its exe is
 * ACL-locked and its launcher alias swallows stdout.
 */
export async function findBlender(explicit: string | undefined): Promise<string | undefined> {
  if (explicit) return explicit;
  if (process.env.BLENDER) return process.env.BLENDER;
  const onPath = Bun.which("blender");
  if (onPath) return onPath;
  if (process.platform !== "win32") return undefined;
  const root = "C:\\Program Files\\Blender Foundation";
  const hits = await Array.fromAsync(new Bun.Glob("Blender */blender.exe").scan({ cwd: root }));
  return hits.length ? join(root, hits.sort().at(-1)!) : undefined;
}

export async function run(argv: string[]): Promise<void> {
  const size = Number(flag(argv, "size") ?? 512);
  const elev = Number(flag(argv, "elev") ?? 25);
  const only = flag(argv, "only")
    ?.split(",")
    .map((s) => s.trim());
  const selected = only ? MOTIONS.filter((m) => only.includes(m.id)) : MOTIONS;
  const unknown = only?.filter((id) => !MOTIONS.some((m) => m.id === id)) ?? [];
  if (unknown.length) {
    console.error(
      `unknown --only ${unknown.join(", ")}; expected ${MOTIONS.map((m) => m.id).join(", ")}`,
    );
    process.exit(1);
  }

  if (!argv.includes("--skip-blender")) {
    await ensureDir(POSES_DIR);
    const motionsJson = join(POSES_DIR, "motions.json");
    await Bun.write(
      motionsJson,
      JSON.stringify(selected.map(({ id, fbx, frames, loop }) => ({ id, fbx, frames, loop }))),
    );
    const exe = await findBlender(flag(argv, "blender"));
    if (!exe) {
      console.error(`blender not found — install it, pass --blender <exe>, or set BLENDER`);
      process.exit(1);
    }
    console.log(`[poses] ${selected.map((m) => m.id).join(", ")} via ${exe} ...`);
    const proc = Bun.spawn(
      [exe, "--background", "--python", SCRIPT, "--", "--out", POSES_DIR, "--motions", motionsJson,
        "--fbx-dir", FBX_DIR, "--size", String(size), "--elev", String(elev)],
      { stdout: "inherit", stderr: "inherit" },
    );
    const code = await proc.exited;
    if (code !== 0) {
      console.error(`[poses] blender exited ${code}`);
      process.exit(1);
    }
  }

  let n = 0;
  let missing = 0;
  for (const m of selected)
    for (const dir of DIRS8)
      for (let i = 0; i < m.frames; i++) {
        const src = Bun.file(jsonPath(m.id, dir, i));
        if (!(await src.exists())) {
          missing++;
          continue;
        }
        const pose = poseFromJson(await src.json(), `${m.id}/${dir}/${i}`);
        const dest = posePath(m.id, dir, i);
        await ensureDir(dirname(dest));
        await Bun.write(dest, await renderPose(pose, size));
        n++;
      }
  console.log(`${n} poses -> out/poses/`);
  if (missing) {
    console.error(`${missing} frames have no JSON — see blender output above`);
    process.exitCode = 1;
  }
}
```

- [ ] **Step 4: テスト + 実機**

Run: `bun test src/stages/poses.test.ts`
Expected: PASS（2 tests）

Run: `bun run px poses --only walk`
Expected: `via C:\Program Files\Blender Foundation\Blender 5.2\blender.exe` と出て Blender が数十秒走り、`[mixamo_poses] done: 64 frames`、続けて `64 poses -> out/poses/`。`out/poses/walk/right/0.png` を開いて棒人間が右向きで depth と重なる位置にあること（depth の頭・手・足と骨格の nose / wri / ank が一致）を目視。ずれていたら Blender 側の投影（`world_to_camera_view`）か `1 - v.y` を疑う。

Run: `bun run px poses --only walk --skip-blender`
Expected: Blender を起動せず `64 poses -> out/poses/`。

- [ ] **Step 5: Commit**

```powershell
git add src/stages/poses.ts src/stages/poses.test.ts
git commit -m "feat: px poses が Blender を起動して Mixamo 骨格を描く"
```

---

### Task 6: `px sprites` に depth CN と GEN_DIRS

**Files:**
- Modify: `src/stages/sprites.ts`
- Modify: `src/stages/sprites.test.ts`
- 手動: depth ControlNet を DL

**Interfaces:**
- Consumes: `buildSd15({ controls })`, `SD15_CONTROLNET_OPENPOSE`, `SD15_CONTROLNET_DEPTH` (Task 3)、`posePath`, `depthPath` (Task 5)、`GEN_DIRS`, `GenDir`, `MOTIONS` (Task 1)
- Produces: `motionSeed`（既存）、**新規** `spritePrompt(char: { trigger: string; positive: string }, motionPrompt: string, dir: GenDir): string`

- [ ] **Step 1: depth ControlNet を DL**

```powershell
$dst = "$env:LOCALAPPDATA\Comfy-Desktop\ComfyUI-Shared\models\controlnet\control_v11f1p_sd15_depth_fp16.safetensors"
Invoke-WebRequest -Uri "https://huggingface.co/comfyanonymous/ControlNet-v1-1_fp16_safetensors/resolve/main/control_v11f1p_sd15_depth_fp16.safetensors" -OutFile $dst
(Get-Item $dst).Length   # 約 723 MB
```

- [ ] **Step 2: テストを書き換える**

`src/stages/sprites.test.ts`:

```ts
import { expect, test } from "bun:test";
import { MOTIONS } from "../motions";
import { motionSeed, spritePrompt } from "./sprites";

test("motionSeed offsets by 1000 per motion index", () => {
  expect(motionSeed(42, 3)).toBe(3042);
});

test("motionSeed is independent of any --motion filtering", () => {
  const index = MOTIONS.findIndex((m) => m.id === "jump");
  expect(motionSeed(42, index)).toBe(42 + index * 1000);
});

const char = { trigger: "sc4v_char", positive: "1boy, gas mask" };

test("prompt is trigger, character, motion, suffix", () => {
  const p = spritePrompt(char, "walking", "down");
  expect(p.startsWith("sc4v_char, 1boy, gas mask, walking,")).toBe(true);
  expect(p).not.toContain("chibi");
  expect(p).not.toContain("from behind");
});

test("back views say so, since the skeleton has no face to show it", () => {
  expect(spritePrompt(char, "walking", "up")).toContain("from behind");
  expect(spritePrompt(char, "walking", "upright")).toContain("from behind");
  expect(spritePrompt(char, "walking", "right")).not.toContain("from behind");
});
```

- [ ] **Step 3: 失敗を確認**

Run: `bun test src/stages/sprites.test.ts`
Expected: FAIL（`spritePrompt` が無い）

- [ ] **Step 4: 実装**

`src/stages/sprites.ts`:

```ts
// src/stages/sprites.ts
/**
 * `px sprites <char> [--motion walk] [--dir down] [--seed n] [--strength 0.6] [--depth-strength 0.5] [--dry]`
 *
 * One SD1.5 generation per (motion, dir, frame): character LoRA + openpose
 * ControlNet + depth ControlNet, both hints pre-rendered by `px poses` from
 * Mixamo. The seed is fixed per (char, motion) so the only thing that changes
 * between frames is the skeleton.
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
import { genPrefix } from "../lib/paths";
import { buildSd15, SD15_CONTROLNET_DEPTH, SD15_CONTROLNET_OPENPOSE, type Control } from "../lib/sd15";
import { GEN_DIRS, MOTIONS, type GenDir } from "../motions";
import { depthPath, posePath } from "./poses";

const DEFAULT_CKPT = "aziibpixelmix_v10.safetensors";
const SUFFIX = "full body, flat grey background, no shadow, centered, pixel art style";
const VALUE_FLAGS = new Set([
  "--motion",
  "--dir",
  "--seed",
  "--strength",
  "--depth-strength",
  "--ckpt",
  "--steps",
  "--cfg",
]);

const usage = () =>
  `usage: bun run px sprites <char> [--motion ${MOTIONS.map((m) => m.id).join("|")}] [--dir ${GEN_DIRS.join("|")}]\n` +
  `                          [--seed n] [--strength 0.6] [--depth-strength 0.5] [--ckpt file] [--steps 25] [--cfg 6] [--dry]`;

/** Seed per (char, motion): base seed from --seed or random, plus a stable per-motion offset. */
export const motionSeed = (base: number, motionIndex: number) =>
  (base + motionIndex * 1000) % 2 ** 32;

/** The skeleton carries no face when seen from behind, so the prompt has to say it. */
export function spritePrompt(
  char: { trigger: string; positive: string },
  motionPrompt: string,
  dir: GenDir,
): string {
  const view = dir === "up" || dir === "upright" ? ", from behind, back view" : "";
  return `${char.trigger}, ${char.positive}, ${motionPrompt}${view}, ${SUFFIX}`;
}

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
  const dirFlag = flag(argv, "dir") as GenDir | undefined;
  const dirs: readonly GenDir[] = dirFlag ? [dirFlag] : GEN_DIRS;
  if (dirFlag && !GEN_DIRS.includes(dirFlag)) {
    console.error(`unknown --dir ${dirFlag}\n${usage()}`);
    process.exit(1);
  }

  const strength = Number(flag(argv, "strength") ?? 0.6);
  const depthStrength = Number(flag(argv, "depth-strength") ?? 0.5);

  // Every hint must exist before we touch the server.
  for (const m of motions)
    for (const dir of dirs)
      for (let i = 0; i < m.frames; i++)
        for (const p of [posePath(m.id, dir, i), ...(depthStrength > 0 ? [depthPath(m.id, dir, i)] : [])])
          if (!(await Bun.file(p).exists())) {
            console.error(`missing ${p} — run  bun run px poses  first`);
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
  const ckpt = flag(argv, "ckpt") ?? DEFAULT_CKPT;
  const steps = flag(argv, "steps") ? Number(flag(argv, "steps")) : undefined;
  const cfg = flag(argv, "cfg") ? Number(flag(argv, "cfg")) : undefined;

  let done = 0,
    failed = 0;
  for (const m of motions) {
    const seed = motionSeed(baseSeed, MOTIONS.indexOf(m));
    for (const dir of dirs)
      for (let i = 0; i < m.frames; i++) {
        const label = `${m.id}/${dir}/${i}`;
        const stem = `${m.id}_${dir}_${i}`;
        try {
          const controls: Control[] = [
            {
              model: SD15_CONTROLNET_OPENPOSE,
              image: api ? await uploadImage(api, posePath(m.id, dir, i), `${stem}.png`) : `${stem}.png`,
              strength,
            },
          ];
          if (depthStrength > 0)
            controls.push({
              model: SD15_CONTROLNET_DEPTH,
              image: api
                ? await uploadImage(api, depthPath(m.id, dir, i), `${stem}.depth.png`)
                : `${stem}.depth.png`,
              strength: depthStrength,
            });
          const workflow = buildSd15({
            ckpt,
            positive: spritePrompt(char, m.prompt, dir),
            negative: `${char.negative}, black background`,
            width: 512,
            height: 512,
            count: 1,
            seed,
            steps,
            cfg,
            prefix: genPrefix("sprites", char.name, m.id, dir, String(i)),
            loras,
            controls,
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
  console.log(`\n${done} frames -> out/gen/sprites/${char.name}/  (base seed ${baseSeed})`);
  if (failed) {
    console.error(`${failed}/${done + failed} frames failed`);
    process.exitCode = 1;
  }
}
```

- [ ] **Step 5: テスト + dry run**

Run: `bun test src/stages/sprites.test.ts`
Expected: PASS（4 tests）

Run: `bun run px sprites scavenger --motion walk --dir right --dry | Select-String "control_net_name|from behind|\.depth\.png"`
Expected: `control_v11p_sd15_openpose_fp16` と `control_v11f1p_sd15_depth_fp16` が各フレームに 1 回ずつ、`walk_right_0.depth.png` が出る。`from behind` は出ない（right なので）。

- [ ] **Step 6: Commit**

```powershell
git add src/stages/sprites.ts src/stages/sprites.test.ts
git commit -m "feat: px sprites に depth ControlNet、5 方向を GEN_DIRS に"
```

---

### Task 7: pixelate / sheet を新しい型に追従させ、全体チェック

**Files:**
- Modify: `src/stages/pixelate.ts:33,93,101`
- Modify: `src/stages/sheet.ts`（変更不要のはず。typecheck で確認）

- [ ] **Step 1: pixelate.ts の型を差し替え**

```ts
// 33 行目
import { FLIP, GEN_DIRS, MOTIONS, type Dir8, type GenDir } from "../motions";
// 93 行目
    dir: GenDir;
// 101 行目
    for (const dir of GEN_DIRS)
```

- [ ] **Step 2: 全体チェック**

Run: `bun run check; bun test`
Expected: format / lint / typecheck すべて OK、全テスト PASS。`grep -rn "DIRS5\|Dir5\|basePose\|\.key(" src` が空。

- [ ] **Step 3: Commit**

```powershell
git add src/stages/pixelate.ts
git commit -m "refactor: pixelate を GEN_DIRS に追従"
```

---

### Task 8: 全モーション実行 + README

**Files:**
- Modify: `README.md`
- Modify: `docs/superpowers/specs/2026-09-05-mixamo-poses-design.md`（spec からの変更点 3 つを「既知の制約・後回し」に追記）

- [ ] **Step 1: 全モーションの poses を生成**

Run: `bun run px poses`
Expected: ログに 7 motion、`done: 352 frames`（4+8+8+6+4+6+8 = 44 × 8）、`352 poses -> out/poses/`。`out/poses/{jump,land}/down/` の末尾フレームがクリップ末尾（非 loop）になっていることをログの frame 列で確認（`jump` は `[1.0, ..., <end>]`）。

- [ ] **Step 2: 1 モーション生成して品質を見る**

Run: `bun run px sprites scavenger --motion walk --seed 1`
Expected: 40 枚（8 frames × 5 dirs）が `out/gen/sprites/scavenger/walk/` に。`right` が右向き、`up` が背中、体型が成人。分身・小道具は既知の問題（別途対応）。10 分を超えるなら `Start-Process cmd.exe -ArgumentList '/c bun run src/px.ts sprites scavenger --motion walk --seed 1 > out\sprites.log 2>&1'` で detached 起動してログを追う。

- [ ] **Step 3: README を更新**

`README.md` の該当箇所:

- 冒頭の説明: 「SD1.5 + openpose ControlNet」→「SD1.5 + openpose / depth ControlNet（Mixamo の骨格を Blender で書き出し）」
- 必要なもの: `control_v11f1p_sd15_depth_fp16` を追加、`Blender 4.2 以上の通常インストール版（MS Store 版は不可。PATH か C:\Program Files\Blender Foundation\ から自動で見つける。別の場所なら --blender <exe> か環境変数 BLENDER）`、`mixamo/ に Y Bot と Action Adventure Pack の FBX（mixamo/README.md 参照）`
- 使い方の `px poses` 行: `bun run px poses     [--only walk,run] [--size 512] [--elev 25] [--blender exe] [--skip-blender]  # Blender で骨格 + depth (1 回)`
- `px sprites` 行: `[--strength 0.6] [--depth-strength 0.5]`
- 「モーションは `src/motions/`」→「モーションは `src/motions/index.ts` の `MOTIONS`（Mixamo の FBX 名とフレーム数）」
- 末尾に: `out/poses` は Blender の出力（JSON + depth + openpose PNG）。

spec の「既知の制約・後回し」に追記:

```markdown
- 実装時の変更: depth は `Normalize` ではなく Map Range（カメラ距離 ±0.8 m 固定、clamp）。`frameTimes` の TS 複製は作らず Python 側の assert 自己チェックのみ。Blender は通常インストール版のみ対応（MS Store 版は exe が起動不可・launcher が stdout を返さない）。
```

- [ ] **Step 4: Commit**

```powershell
git add README.md docs/superpowers/specs/2026-09-05-mixamo-poses-design.md
git commit -m "docs: Mixamo 骨格生成の使い方と Blender 要件"
```

---

## Self-Review

- **Spec coverage**: 決定事項（体型 / 方向 / カメラ / フレーム / 実装 / depth CN / モーション）→ Task 1, 4, 5, 6。ファイル一覧 → Task 1〜7。Blender スクリプト手順 1〜4 → Task 4。`px poses` の `--blender` / `BLENDER` / `--skip-blender` / ログ表示 → Task 5。`renderPose` visible → Task 2。sprites の CN 2 段 / `--depth-strength` / SUFFIX / `from behind` / GEN_DIRS → Task 6。pixelate / sheet → Task 7。テスト節の各項目: frameTimes → Python assert（Task 4）、renderPose visible → Task 2、poseFromJson → Task 2、MOTIONS 整合 → Task 1、buildSd15 2 段 → Task 3。開発手順の MCP 対話確認は headless probe で代替済み。
- **Placeholder**: なし。
- **Type consistency**: `Control` / `controls` (Task 3 ↔ 6)、`posePath` / `depthPath` / `findBlender` (Task 5)、`GenDir` / `GEN_DIRS` (Task 1 ↔ 6, 7)、`poseFromJson(raw, label)` (Task 2 ↔ 5)、`spritePrompt(char, motionPrompt, dir)` (Task 6 内)。
