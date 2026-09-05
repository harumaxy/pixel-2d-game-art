# Mixamo → OpenPose + Depth 骨格生成 設計

日付: 2026-09-05
前提: [pixel-sprite-pipeline-design](2026-09-05-pixel-sprite-pipeline-design.md) の `px poses` / `px sprites` を置き換える。

## 目的

手書きの TS 骨格（`src/motions/*.ts` の `basePose` + `swingLeg` 等）は関節位置の質が低く、
生成画像の姿勢・向きが安定しない。Mixamo のモーションキャプチャ（Y Bot + Action Adventure Pack）を
Blender で再生し、8 方向 × N フレームの **openpose 骨格** と **depth** を書き出して ControlNet の
リファレンスにする。

## 決定事項

| 項目 | 決定 | 理由 |
|---|---|---|
| 体型 | Y Bot 実寸（成人比率）。chibi をやめる | LoRA の学習画像が成人体型で整合する。depth を使うと体型は強制されるので chibi と両立しない。縮小で十分ドット感が出る |
| 方向 | Blender は 8 方向すべて書き出す。生成は 5 方向（down / up / right / downright / upright）+ pixelate で水平反転 | 生成コスト半減。8 方向生成への切替はリストの差し替えだけ |
| カメラ | 正射影、方位 45° 刻み、仰角 25°（`--elev` で変更） | トップダウン 2D の標準的な見え方 |
| フレーム | クリップを N 等分（fps 固定ではない） | ループ整合が取りやすい。既存 `frames` と同じ意味 |
| 実装 | Blender headless（`blender --background --python`）+ 既存 TS 描画。アドオン不使用 | 再現性、依存ゼロ。toyxyz rig は retarget が手作業になる |
| Depth ControlNet | `control_v11f1p_sd15_depth_fp16.safetensors` を追加 DL。openpose と 2 段 chain | |
| モーション | idle / walk / run / jump / fall / land / sneak。aim / attack / dodge は廃止 | Pack に無い。必要なら FBX を追加して MOTIONS に 1 行足す |

## 全体フロー

```
bun run px poses [--only walk,run] [--size 512] [--elev 25] [--blender <exe>] [--skip-blender]
  (a) blender --background --python scripts/mixamo_poses.py -- --out out/poses --motions <tmp json> --size 512 --elev 25
      → out/poses/<motion>/<dir8>/<i>.json, <i>.depth.png
  (b) JSON → out/poses/<motion>/<dir8>/<i>.png   (既存 renderPose)
bun run px sprites scavenger [--motion walk] [--dir down] [--strength 0.6] [--depth-strength 0.5]
  → openpose CN + depth CN
bun run px pixelate / sheet   （変更なし。MOTIONS と方向名の変更に追従するだけ）
```

## ファイル

```
mixamo/                         # 新規。FBX の置き場。gitignore。README に入手先（Mixamo: Y Bot + Action Adventure Pack）
  Y Bot.fbx
  walking.fbx ...
scripts/mixamo_poses.py         # 新規。Blender 内で実行
src/motions/index.ts            # MOTIONS を宣言のみに縮小。JOINTS / Pose / DIRS8 / FLIP は残す
src/motions/{idle,walk,run,attack,aim,dodge}.ts   # 削除
src/lib/skeleton.ts             # visible: false の関節・辺をスキップ
src/lib/sd15.ts                 # control を配列に
src/stages/poses.ts             # blender 起動 + JSON → PNG
src/stages/sprites.ts           # 方向名を dir8 に、depth CN 追加、SUFFIX から chibi を除去
src/stages/pixelate.ts          # Dir5 → 生成方向リストに追従
out/poses/<motion>/<dir8>/<i>.json        # 関節座標
out/poses/<motion>/<dir8>/<i>.depth.png   # 512², グレースケール
out/poses/<motion>/<dir8>/<i>.png         # openpose
```

## モーション定義（`src/motions/index.ts`）

```ts
export interface Motion {
  id: string;
  /** mixamo/ 直下のファイル名 */
  fbx: string;
  frames: number;
  /** 末尾フレームが先頭に戻る直前で止まる（walk 等）。false なら末尾フレームを含む（jump 等） */
  loop: boolean;
  /** シート JSON に書く再生 fps */
  fps: number;
  prompt: string;
}

export const MOTIONS: Motion[] = [
  { id: "idle",  fbx: "idle.fbx",                    frames: 4, loop: true,  fps: 4,  prompt: "standing idle" },
  { id: "walk",  fbx: "walking.fbx",                 frames: 8, loop: true,  fps: 8,  prompt: "walking" },
  { id: "run",   fbx: "running.fbx",                 frames: 8, loop: true,  fps: 10, prompt: "running" },
  { id: "jump",  fbx: "jumping up.fbx",              frames: 6, loop: false, fps: 8,  prompt: "jumping up" },
  { id: "fall",  fbx: "falling idle.fbx",            frames: 4, loop: true,  fps: 6,  prompt: "falling in the air" },
  { id: "land",  fbx: "hard landing.fbx",            frames: 6, loop: false, fps: 8,  prompt: "landing from a fall, crouching" },
  { id: "sneak", fbx: "crouched sneaking right.fbx", frames: 8, loop: true,  fps: 8,  prompt: "sneaking crouched" },
];

export const DIRS8 = ["down","downright","right","upright","up","upleft","left","downleft"] as const;
/** 生成する方向と、pixelate が反転で作る方向 */
export const GEN_DIRS = ["down","downright","right","upright","up"] as const;
export const FLIP: Record<GenDir, [Dir8, Dir8?]> = {
  down: ["down"], up: ["up"],
  right: ["right","left"], downright: ["downright","downleft"], upright: ["upright","upleft"],
};
```

`BODY` / `basePose` / `facing` / `swingLeg` / `swingArm` / `shift` / `clonePose` / `Motion.key` は削除。
`JOINTS`（COCO-18 順）と `Pose` は残し、`Pt` に `visible?: boolean` を足す（省略時 true）。

## Blender スクリプト（`scripts/mixamo_poses.py`）

引数（`--` 以降）: `--out <dir> --motions <json> --fbx-dir <dir> --size 512 --elev 25`。
`--motions` は `px poses` が MOTIONS から書き出す一時 JSON（`[{id, fbx, frames, loop}]`）。定義は TS 側にだけ持つ。

手順:

1. 既定シーンのオブジェクトを全部削除する（`read_factory_settings` は FBX importer の context を壊す）。
2. `Y Bot.fbx` を import（mesh 2 個 + armature）。armature を `rig` とする。
3. 各 motion:
   1. `<fbx>` を import。armature のみ入る。その `animation_data.action` を取り、`rig.animation_data.action` に assign。import した armature は削除。
   2. action の `frame_range = (s, e)`。フレーム k (0..N-1) の時刻:
      - loop: `s + k * (e - s) / N`
      - 非 loop: `s + k * (e - s) / (N - 1)`（N = 1 なら s）
      `scene.frame_set(round(t))`（Mixamo は 30fps、丸め誤差は許容）。
   3. 最初にサンプルするフレームで骨盤の左右ベクトル（LeftUpLeg − RightUpLeg）から初期向き（world −Y からの偏差、度）を求め、その motion 全体で定数として使う（clip ごとに 1 回のみ計算）。`crouched sneaking right.fbx` のように rest 向きが −Y でない clip があるため、方位に加算して補正する。
   4. 各方向 d (0..7、`DIRS8` 順) × 各フレーム:
      - Hips ボーンのワールド位置 `h` を求め、カメラを `h` を注視点として方位 `azimuth(d) + 初期向き`、仰角 `elev` に置く（root motion をキャンセルし、キャラを常に画面中央に置く）。方位は `down` = キャラの正面（Mixamo の +Z 前方をカメラが見る）、以降時計回りに 45° ずつ。
      - 正射影、`ortho_scale = 身長 × 1.15`（身長は rest pose の HeadTop_End − 足元。全フレーム共通で固定し、フレーム間でスケールが変わらないようにする）。
      - 関節: 以下の対応で 3D 点を取り、`bpy_extras.object_utils.world_to_camera_view` で (x, y) ∈ [0,1]² にし、`y` を反転（画像座標）。
        | openpose | Mixamo |
        |---|---|
        | neck | `mixamorig:Neck` head |
        | rsho / lsho | `RightArm` / `LeftArm` head |
        | relb / lelb | `RightForeArm` / `LeftForeArm` head |
        | rwri / lwri | `RightHand` / `LeftHand` head |
        | rhip / lhip | `RightUpLeg` / `LeftUpLeg` head |
        | rkne / lkne | `RightLeg` / `LeftLeg` head |
        | rank / lank | `RightFoot` / `LeftFoot` head |
        | nose | `Head` の local 空間で前 0.10 m、上 0.05 m |
        | reye / leye | 同 前 0.09 m、上 0.08 m、左右 ∓0.03 m |
        | rear / lear | 同 前 0.0 m、上 0.07 m、左右 ∓0.07 m |
        オフセットは Y Bot の頭のサイズ（約 0.2 m）に合わせた定数。Head の前方向とカメラ方向の内積が −0.3（`FACE_HIDE_DOT`）未満なら後ろ向きとみなし nose / eyes を `visible: false`。真横（Head の左方向とカメラ方向の内積の絶対値が 0.8 超、`EAR_HIDE_DOT`）では遠い側の eye と ear も `visible: false`。
      - JSON: `{ "<joint>": { "x": 0.5, "y": 0.3, "visible": true }, ... }` を `<out>/<id>/<dir>/<k>.json` に書く。
      - Depth: Workbench レンダ、`view_layer.use_pass_z = True`、compositor で `Render Layers.Depth → Map Range (From カメラ距離 ±0.8 m → To 1..0, clamp) → Group Output`。近い面ほど白、背景（無限遠）は黒。`<out>/<id>/<dir>/<k>.depth.png`（512²、グレースケール PNG）。カメラ距離を基準にした固定レンジなので、フレーム間・方向間で絶対深度が揃う。
4. 件数を stdout に出して終了。FBX が無ければ最初に列挙して exit 1。

## `px poses`（`src/stages/poses.ts`）

- `--blender <exe>` > 環境変数 `BLENDER` > PATH の `blender`。見つからなければ exit 1 とインストール案内。
- MOTIONS（`--only` で絞る）を一時 JSON に書き、`Bun.spawn` で blender を起動。stdout/stderr をそのまま流す。非 0 で exit 1。
- 終了後、`<id>/<dir>/<k>.json` を読んで `renderPose(pose, size)` → `<k>.png`。
- `--skip-blender`: (a) を飛ばして JSON → PNG だけやり直す（描画パラメータの試行用）。
- `posePath(motion, dir8, frame)` はそのまま。`depthPath` を追加。

## `renderPose`（`src/lib/skeleton.ts`）

- `visible === false` の関節は円を描かない。辺は両端が visible のときだけ描く。
- それ以外（COCO-18 の色・線幅・SVG 経由 sharp）は変更なし。

## `px sprites`（`src/stages/sprites.ts`, `src/lib/sd15.ts`）

- `Sd15Opts.control` を配列 `{ model: string; image: string; strength: number; endPercent?: number }[]` に変更。`ControlNetApplyAdvanced` を順に chain（前段の positive/negative を次段へ）。
- sprites は `[openpose (strength 0.6), depth (strength 0.5)]`。`--strength` は openpose、`--depth-strength` は depth。`--depth-strength 0` で depth を外す。
- depth 画像は `uploadImage` で `<motion>_<dir>_<i>.depth.png` として送る。
- `SUFFIX` = `"full body, flat grey background, no shadow, centered, pixel art style"`（chibi 系を除去）。
- 方向は `GEN_DIRS`。`--dir` のバリデーションもそれに合わせる。
- 背面（`up` / `upright`）は positive に `"from behind"` を足す（骨格に顔が無くても SD1.5 は正面を描きがちなため）。

## `px pixelate` / `px sheet`

- `Dir5` → `GenDir`、`DIRS5` → `GEN_DIRS`。`FLIP` の引き方は同じ。
- 体型変更に伴い `--size 64` での見え方は再確認する（設計変更なし）。

## テスト

- `frameTimes(s, e, n, loop)`（TS 側にも同じ式を置き、Python の実装と結果を突き合わせる固定値テスト）。
- `renderPose`: `visible: false` の関節で円・辺が出ないこと（SVG 文字列で確認）。
- `poseFromJson`: JSON → `Pose`、`visible` 省略時 true。
- `MOTIONS`: id 重複なし、`frames >= 1`、`fbx` 文字列非空。
- `buildSd15`: control 2 段で `ControlNetApplyAdvanced` が 2 つ chain されること（既存テストの拡張）。
- Blender 本体は自動テストしない。`px poses --only walk` を実行し、`out/poses/walk/right/*.png` と depth を目視。

## 開発手順

1. Blender MCP で `walking.fbx` を対話的に読み、カメラ配置と関節投影をスクリーンショットで確認する（骨格 PNG を viewport 上の Y Bot と重ねて位置ずれを見る）。
2. 確認できたロジックを `scripts/mixamo_poses.py` に headless 化。
3. TS 側を差し替え、`px poses` → `px sprites scavenger --motion walk --dir right` で 8 枚生成して品質を見る。
4. 全モーション → pixelate → sheet。

## 既知の制約・後回し

- Y Bot に顔ボーンが無いため nose / eyes / ears は Head からの固定オフセット。頭の傾きには追従する。
- 反転で作る左向きは、左右非対称モーション（sneak 等）では厳密には鏡像になる。許容。
- Depth は Map Range（カメラ距離 ±0.8 m 固定、clamp）。フレーム間・方向間で絶対深度が揃う。
- Blender は通常インストール版 5.2.1（`C:\Program Files\Blender Foundation\Blender 5.2\blender.exe`）。`px poses` は `--blender` → `BLENDER` → PATH → `C:\Program Files\Blender Foundation\Blender *` の順で探す。MS Store 版は exe が ACL で起動できず launcher も stdout を返さないので非対応。
- 実装時の変更: `frameTimes` の TS 複製は作らず Python 側の assert 自己チェックのみ。
- 実装時の変更: 全 clip が world −Y を向いている前提は誤りだった（`crouched sneaking right.fbx` は逆向き）。骨盤の左右ベクトルから初期向きを求め、方位に加算して補正するようにした（`base_yaw`、clip ごとに 1 回のみ計算）。
