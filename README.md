# pixel-2d-game-art

ComfyUI + bun/TypeScript で、トップダウン 2D アクションゲーム向けのキャラクタースプライトシートを生成する。
SD1.5 + openpose ControlNet + キャラ LoRA で 512px のフレームを出し、TS 側で 64px に落として 8 方向のシートに組む。

設計: `docs/superpowers/specs/2026-09-05-pixel-sprite-pipeline-design.md`

## 必要なもの

- Bun（`mise install`）
- ComfyUI 起動中（既定 `http://127.0.0.1:8188`、`COMFY_URL` で変更）
- モデル: `SD1.5\dreamshaper_8`, `aziibpixelmix_v10`, `control_v11p_sd15_openpose_fp16`, Qwen-Image-Edit 2511 (GGUF Q5) + Lightning LoRA
- LoRA 学習用に ai-toolkit（別途 checkout。`px dataset` が出力する `train.yaml` を `python run.py` に渡す）

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
bun run px pixelate scavenger [--size 64] [--palette apoc|auto] [--bg #rrggbb] [--bg-tolerance 40]
bun run px sheet    scavenger                        # -> out/sheets/scavenger.png + .json
```

pixelate は各レンダーの四隅の色を背景キーとして自動検出する（checkpoint によって「灰色」の実際の色が違うため）。--bg で明示できる。

どのコマンドも `--dry` でグラフ JSON だけ印字する（ComfyUI 不要）。

sprites は 1 キャラ 1 モーションで seed を固定し、フレーム間では骨格だけを変える。生成結果はアニメ間でサイズが揃うよう、pixelate が全モーション横断で 1 つのスケールを使う。

キャラ定義は `chars/<name>.yaml`。モーションは `src/motions/`、パレットは `palettes/`。
