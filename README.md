# pixel-2d-game-art

ComfyUI + bun/TypeScript で、トップダウン 2D アクションゲーム向けのキャラクタースプライトシートを生成する。
SD1.5 + openpose / depth ControlNet（Mixamo の骨格を Blender で書き出し）+ キャラ LoRA で 512px のフレームを出し、TS 側で 64px に落として 8 方向のシートに組む。

設計: `docs/superpowers/specs/2026-09-05-pixel-sprite-pipeline-design.md`

## 必要なもの

- Bun（`mise install`）
- ComfyUI 起動中（既定 `http://127.0.0.1:8188`、`COMFY_URL` で変更）
- モデル: `SD1.5\realisticVisionV60B1_v51VAE`（sprites 既定。滑らかな fine-tune の方が ControlNet のポーズ追従が安定し、ピクセル化は pixelate 側で行う）, `control_v11p_sd15_openpose_fp16`, `control_v11f1p_sd15_depth_fp16`, `ip-adapter-plus_sd15` + `CLIP-ViT-H-14`, AnimateDiff v3 `v3_sd15_mm.ckpt` + `v3_sd15_adapter.ckpt`（`animatediff_models/` と `loras/`）, RMBG-2.0 / BiRefNet ToonOut（comfyui-rmbg が自動 DL）, Qwen-Image-Edit 2511 (GGUF Q5) + Lightning LoRA
- LoRA 学習用に ai-toolkit（別途 checkout。`px dataset` が出力する `train.yaml` を `python run.py` に渡す）
- Blender 5.0 以上（5.2 LTS で検証）の通常インストール版（MS Store 版は不可。PATH か `C:\Program Files\Blender Foundation\` から自動で見つける。別の場所なら `--blender <exe>` か環境変数 `BLENDER`）
- `mixamo/` に Y Bot と Action Adventure Pack の FBX（`mixamo/README.md` 参照）

## セットアップ

```bash
bun install
bun run codegen      # ComfyUI 起動中に。src/types/nodes.ts を生成
bun test
```

## 使い方

```bash
bun run px concept  scavenger                        # 候補 4 枚 -> out/gen/concept/scavenger/
bun run px dataset  scavenger --hero out/gen/concept/scavenger/scavenger_00002_.png
                                                     # -> out/gen/dataset/scavenger/ + train.yaml
# 目視で不良画像を削除 -> ai-toolkit で学習 -> safetensors を ComfyUI の loras/ へ
#   -> chars/scavenger.yaml に lora: scavenger を追記
bun run px poses     [--only walk,run] [--size 512] [--elev 25] [--blender exe] [--skip-blender]  # Blender で骨格 + depth (1 回)
bun run px sprites  scavenger [--motion walk,run] [--dir down] [--seed n] [--strength 0.6] [--depth-strength 0.5] [--matte rmbg2|toonout|none]
bun run px pixelate scavenger [--size 64] [--palette apoc|auto] [--only walk,run] [--render NNNNN] [--outline] [--bg-tolerance 40] [--bg #rrggbb]
bun run px sheet    scavenger                              # -> out/sheets/scavenger.png + .json
bun run px clean    [scavenger] [--all] [--dataset] [--dry]  # 生成物の削除。引数無しなら一覧表示のみ
```

sprites は (モーション, 方向) ごとに AnimateDiff v3 で 1 クリップを生成する。hint は `HINT_STEP`（2）倍の密度で描いてあり、8 フレームの walk は 16 フレームとして生成して偶数フレームだけ保存する（motion module のネイティブ長が 16 で、8 で回すより壁の染みや足元の屑が出ない）。既定でサーバ側マッティング（RMBG-2.0、`--matte toonout` で BiRefNet ToonOut）を通し、RGBA で保存する。pixelate は入力に透明画素があればその alpha を信用し、無ければ（`--matte none`）四隅の色を背景キーとして自動検出して抜く（checkpoint によって「灰色」の実際の色が違うため。--bg で明示できる）。足元の影はどちらの場合も pixelate 側で除去する。
pixelate は常に全モーションを処理する（スケールとパレットをキャラ全体で統一するため。`--only` で対象を絞れる）。縮小はセルの輝度分布で暗い側/明るい側が突出していればその帯を採るコントラスト適応方式、パレットへの吸着は Oklab 距離、量子化後に 4px 未満の孤立成分を除去する。`--outline` で最暗色の 1px 縁取り。

ComfyUI を使う concept / dataset / sprites は `--dry` でグラフ JSON だけ印字する（サーバ不要）。poses / pixelate / sheet は ComfyUI を使わない。

sprites は 1 キャラ 1 モーションで seed を固定し、フレーム間では骨格だけを変える。生成結果はアニメ間でサイズが揃うよう、pixelate が全モーション横断で 1 つのスケールを使う。

キャラ定義は `chars/<name>.yaml`。モーションは `src/motions/index.ts` の `MOTIONS`（Mixamo の FBX 名とフレーム数）、パレットは `palettes/`。

## ComfyUI 出力との共有（junction）

ComfyUI が生成した画像（concept / dataset / sprites）は `out/gen/` 配下に置く。`out/gen` を ComfyUI の `output/px/` への directory junction にしておくと、ファイルは 1 つだけ存在し、コピーが発生しない。

```powershell
$px = "C:\Users\harum\AppData\Local\Comfy-Desktop\ComfyUI-Shared\output\px"   # ComfyUI の output/px（無ければ作る）
New-Item -ItemType Directory -Force $px | Out-Null
New-Item -ItemType Junction -Path out\gen -Target $px
```

junction が無い環境では、各ステージが HTTP で同じパスにコピーするので動作は変わらない。
`out/poses` `out/px` `out/sheets` は TS 側の生成物で、junction の外にそのまま置く。`out/poses` は Blender の出力（JSON + depth + openpose PNG）。
