# ピクセルアート スプライト生成パイプライン 設計

日付: 2026-09-05

## 目的

トップダウン 2D アクションゲーム（ポストアポカリプス、北斗の拳 / Fallout / Mad Max 系）向けに、
キャラクターのアニメーションスプライトシートを ComfyUI + bun/TypeScript で半自動生成する。

- 出力: 64px（または 32px）、2〜3 頭身、8 方向
- モーション: idle / walk / run / attack / aim / dodge
- 最終手直しは Aseprite で行う前提。パイプラインは「手直しの土台」を量産する

## 前提・決定事項

| 項目 | 決定 | 理由 |
|---|---|---|
| ベースモデル | SD1.5（`dreamshaper_8` / `aziibpixelmix_v10`、ローカル既存） | 生成・LoRA 学習ともに最速。64px に落とすので高精度不要 |
| ControlNet | `control_v11p_sd15_openpose`（要 DL） | SD1.5 用 openpose はローカル未所持 |
| キャラ LoRA 学習 | ローカル ai-toolkit（SD1.5） | RTX 4080 で 10〜20 分。fal.ai は使わない |
| データセット多視点化 | Qwen-Image-Edit（2511 Lightning、ローカル既存） | 1 枚の hero 画像から同一人物の多視点を出せる。SD1.5 単体では一貫性が出ない |
| ドット化 | bun/TS 側で `sharp` により後処理 | GPU 不要でパラメータ試行が速い。テストが書ける |
| 方向 | 5 方向生成（down/up/side/downside/upside）+ 横系 3 方向を水平反転で 8 方向 | 生成コスト半減。片手武器の持ち手が反転で入れ替わるのは許容 |
| 骨格 | 関節座標を TS で定義し openpose 形式 PNG を自前描画 | 全制御。キャラ非依存で 1 回生成すれば使い回せる |
| 出力形式 | スプライトシート PNG + JSON | Aseprite の Import Sprite Sheet でそのまま読める |
| 実行環境 | bun、ComfyUI `http://127.0.0.1:8188`（`COMFY_URL` で上書き） | |

参考実装: `../ai-game-asset-workflow`（`lib/comfy.ts`、`workflows/post-apocalyptic-art/sheet.ts`、`lib/qwen-edit.ts` を移植）。

## 全体フロー

```
bun run px concept  scavenger                       # SD1.5 t2i、候補を複数出す
bun run px dataset  scavenger --hero out/concept/scavenger/00003.png
                                                    # Qwen-Edit 多視点 + caption + train.yaml
# (手動) 不良画像を削除 → ai-toolkit で学習 → ComfyUI loras/ に配置 → chars/scavenger.yaml に lora: 追記
bun run px poses                                    # 骨格 PNG（キャラ非依存、1 回）
bun run px sprites  scavenger [--motion walk] [--dir down]
                                                    # SD1.5 + LoRA + openpose CN、512px
bun run px pixelate scavenger [--size 64] [--palette apoc]
                                                    # 背景除去 + 縮小 + 減色 + 反転
bun run px sheet    scavenger                       # シート PNG + JSON
```

各ステージは前ステージの `out/` を読む。ステージ単体で再実行できる。

### 出力ディレクトリ

```
out/
  concept/<char>/*.png
  dataset/<char>/{*.png,*.txt,train.yaml}
  poses/<motion>/<dir5>/<frame>.png
  sprites/<char>/<motion>/<dir5>/<frame>.png      # 512x512
  px/<char>/<motion>/<dir8>/<frame>.png           # 64x64 (or --size)
  sheets/<char>.png, <char>.json
```

## ソース構成

```
src/
  px.ts                 # サブコマンド dispatcher（lazy import）
  lib/
    comfy.ts            # ComfyApi 接続、argv flag、runWorkflow、collectOutputs、LoRA 解決
    chars.ts            # chars/<name>.yaml のロードと型検証
    sd15.ts             # SD1.5 グラフビルダー（t2i / +LoRA / +openpose CN）
    qwen-edit.ts        # Qwen-Image-Edit グラフビルダー
    skeleton.ts         # Pose → openpose 形式 PNG（sharp、SVG 経由）
    pixelate.ts         # 背景除去、bbox 整列、縮小、量子化、反転
    sheet.ts            # グリッド合成 + JSON
  motions/
    index.ts            # MOTIONS 一覧、DIRS5 / DIRS8、Pose 型
    idle.ts walk.ts run.ts attack.ts aim.ts dodge.ts
  stages/
    concept.ts dataset.ts poses.ts sprites.ts pixelate.ts sheet.ts
  types/nodes.ts        # cfli codegen 出力
chars/<name>.yaml
palettes/apoc.json
```

依存: `@saintno/comfyui-sdk`、`sharp`、`yaml`。dev: typescript、oxlint、oxfmt、@types/bun。
`@fal-ai/client` と `fflate` は削除する。

## キャラ定義 `chars/<name>.yaml`

```yaml
name: scavenger
trigger: sc4v_char            # LoRA トリガーワード。dataset の caption と sprites のプロンプトで使う
lora: scavenger               # ComfyUI loras/ 内ファイル名の断片。concept 段階では未設定
strength: 0.8
positive: "gas mask, torn leather coat, bandaged arms, ..."
negative: "blurry, extra limbs, deformed, text, watermark"
```

- `lora` 未設定で `px sprites` を実行 → エラー（学習が先だと案内）。
- 未知キー・必須キー欠損は起動時に検証してエラー。

## ステージ詳細

### concept

- SD1.5 t2i。`--ckpt` 既定 `dreamshaper_8`、`-n` 既定 4、512×768、25 steps、cfg 6、`dpmpp_2m` / `karras`。
- プロンプト = yaml の `positive` + 固定尾 `"full body, standing straight, front view, flat grey background, even lighting"`。LoRA / ControlNet は使わない。
- 出力 `out/concept/<char>/`。

### dataset

- `--hero <png>` 必須。hero は `source.png` としてコピー（再描画しない）。
- Qwen-Image-Edit で 16 バリエーション（three-quarter / side / back / bust / portrait / walking / running / crouching / aiming / wasteland / ruins など）。各バリエーションは `prompt`（編集指示）と `caption`（学習用）を持つ。caption は構図・ポーズ・背景のみを記述し、キャラの特徴は書かない（トリガーワードの役目）。
- caption の `[trigger]` は yaml の `trigger` に置換して `.txt` に書く。
- `train.yaml` を生成する（ai-toolkit の SD1.5 LoRA 設定、データセットパスと LoRA 名を埋め込み済み）。
- 学習はパイプライン外。`ai-toolkit run out/dataset/<char>/train.yaml` を手で実行し、完成した safetensors を ComfyUI の `loras/` に置く。
- 完了メッセージで「目視で不良画像を削除してから学習する」ことを案内。

### poses

- OpenPose COCO 18 キーポイント。線と関節丸を標準の色分けで描画。512×512。
- 関節座標は正規化 `{x, y}`（0..1）。体格定数（頭半径、肩幅、胴長、脚長など）を `motions/index.ts` に 1 箇所で定義。
- モーション定義:
  ```ts
  interface Motion {
    id: string;
    fps: number;
    frames: number;
    prompt: string;                       // "walking", "aiming a rifle" など 1 語句
    key: (dir: Dir5, t: number) => Pose;  // t = 0..1
  }
  ```
  | motion | frames | fps | 動き |
  |---|---|---|---|
  | idle | 4 | 4 | 上下に軽く揺れる |
  | walk | 6 | 8 | 脚・腕を sin で交互に振る |
  | run | 6 | 12 | walk の振幅大 + 前傾 |
  | attack | 4 | 10 | 腕の振り下ろし |
  | aim | 2 | 4 | 構え静止（銃口の上下だけ） |
  | dodge | 4 | 12 | 前傾 + 脚を曲げて低姿勢 |
- 方向 5 種は `down / up / side / downside / upside`。side 系は右向きで定義。
- 出力 `out/poses/<motion>/<dir5>/<frame>.png`。`--only walk,run` で部分再生成。

### sprites

- グラフ: `CheckpointLoaderSimple → LoraLoader → CLIPTextEncode ×2 → ControlNetLoader → ControlNetApplyAdvanced → KSampler → VAEDecode → SaveImage`。
- 骨格 PNG は既に openpose 形式なので preprocessor は通さない。
- `--ckpt` 既定 `aziibpixelmix_v10`（ドット絵らしい面と線を出す。写実寄りにしたい場合は `dreamshaper_8`）。
- 設定: 512×512、25 steps、cfg 6、`dpmpp_2m` / `karras`。ControlNet strength 既定 0.65（openpose は成人比率で学習されているため、2〜3 頭身では配置ガイド程度に留める）、`end_percent` 0.85。
- プロンプト = `trigger, positive` + motion の `prompt` + 固定尾 `"full body, chibi, 2 heads tall, flat grey background, no shadow, centered"`。negative は yaml。
- seed は 1 キャラ × 1 モーションで固定（フレーム間で変えない）。変化するのは骨格だけにしてブレを抑える。`--seed` で上書き。
- 1 フレーム 1 enqueue、逐次実行。失敗はスキップして末尾に `N/M failed` を出し exit 1。
- `--motion` `--dir` で絞り込み。再生成は上書き。
- `--dry` でグラフ JSON を印字（サーバ不要）。
- 出力 `out/sprites/<char>/<motion>/<dir5>/<frame>.png`。

### pixelate

`lib/pixelate.ts` は raw RGBA `Uint8Array` を扱う純関数群。sharp はデコード / エンコードのみ。

1. **背景除去**: 四隅から flood fill。`#808080` との RGB 距離が `--bg-tolerance`（既定 40）未満のピクセルを透明化。キャラ内部の灰色は fill が届かないので残る。
2. **bbox 整列**: 不透明ピクセルの bbox を取り、下端中央を基準点にして正方形キャンバスへ配置。1 モーション内では最大 bbox 高さに合わせて統一スケール（フレームごとに拡縮しない）。
3. **縮小**: box filter で `--size`（既定 64）へ。alpha は 0 / 255 に二値化。
4. **量子化**: `palettes/apoc.json`（固定 32 色）へ RGB 最近傍。`--palette auto` で median cut 16 色。ディザなし。
5. **反転**: `side → right / left`、`downside → downright / downleft`、`upside → upright / upleft` を水平反転で生成。`down / up` はそのまま。

出力 `out/px/<char>/<motion>/<dir8>/<frame>.png`。

### sheet

- 行 = motion × dir8（motions 定義順 × `down, downright, right, upright, up, upleft, left, downleft`）、列 = frame。列数は最大フレーム数、不足分は透明。
- `out/sheets/<char>.png` と `<char>.json`:
  ```json
  {
    "frameSize": 64,
    "columns": 6,
    "animations": [
      { "name": "walk_down", "row": 0, "frames": 6, "fps": 8 }
    ]
  }
  ```

## エラー処理

- ComfyUI に接続できない → `connect()` で exit 1。
- 生成失敗フレーム → スキップして続行、末尾に集計、exit 1。
- 入力欠損（poses 未生成で sprites、sprites 未生成で pixelate、yaml に lora 未設定で sprites）→ 先に実行すべきコマンドを示して exit 1。
- yaml 検証エラー → キー名を示して exit 1。

## テスト（`bun test`）

- `skeleton`: 全 motion × dir × frame で関節座標が 0..1 内。walk の脚が周期的に動く。
- `pixelate`: 合成画像（灰背景 + 色矩形）で flood fill、bbox 整列、量子化の結果ピクセルを assert。
- `sheet`: 行列配置と JSON の内容。
- ComfyUI 経路: `--dry` の JSON をスナップショット比較。サーバ不要。

## v1 スコープ外

- IPAdapter による追加の一貫性補強
- 装備パーツ分け、武器レイヤー分離（装備差分は `chars/<name>-<gear>.yaml` を別キャラとして扱う）
- タイルセット、背景、建物などキャラ以外のアセット
- 8 方向の直接生成（非対称装備が必要になったら検討）
- ディザリング

## 実装時の変更点（2026-09-05 実装完了時点）

実装中に判明した事実に基づき、以下を上記の記述から変更した。

- **dataset の caption**: `[trigger], <視点/ポーズ語>` のみにした。全枚数共通の定型句（`full body shot`、背景・照明句）が trigger に癒着してポーズ指定が効かなくなった前例（参照リポの FLUX LoRA 実走結果）があるため。
- **骨格の体格定数**: 当初の値は成人比率（約 6 頭身）になっていたため、`BODY` を 2〜3 頭身寄り（noseY 0.30 / neckY 0.46 / hipY 0.66 / kneeY 0.78 / ankleY 0.90）に変更した。
- **pixelate の背景キー**: `aziibpixelmix` は「flat grey background」を薄ベージュで描くため、固定の `#808080` ではなく各レンダーの四隅の色の中央値をキーにする。`--bg #rrggbb` で明示できる。
- **pixelate のスケール**: モーション単位ではなく**キャラ単位で 1 つ**（全モーション・全方向の最大 bbox 高さ・幅から算出）。しゃがみモーションや横向きが他と違うサイズにならないようにするため。この都合で pixelate は常に全モーションを処理し、`--motion` は持たない。`--palette auto` も同様にキャラ全体で 1 パレット。
- **sheet の `--size`**: 廃止。フレームサイズは最初のフレームから読む。
- **sprites のアップロード名**: `<motion>_<dir>_<frame>.png` で一意にする。
- **dataset のバリエーション数**: 15（+ source.png で学習画像 16 枚）。
- **spec 未着手の検証**: 8 方向展開（反転）と複数モーションのシート組立は、キャラ LoRA 学習後の初回フル実行で実データ確認が必要。実装済みスモークは idle/down のみ。
