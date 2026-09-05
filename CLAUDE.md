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
