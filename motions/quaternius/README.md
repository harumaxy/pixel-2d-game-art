# motions/quaternius/

Quaternius「Universal Animation Library」1 / 2 の Standard（無料版、CC0 1.0、`UAL2_License.txt`）の FBX。git には入れない（`motions/**/*.fbx` は ignore）。

入手:
- `UAL1_Standard.fbx`: https://store.godotengine.org/asset/quaternius/universal-animation-library/ の Download（Standard-1.0、zip 直下）
- `UAL2_Standard.fbx`: https://quaternius.itch.io/universal-animation-library-2 の Download → `Universal Animation Library 2[Standard].zip` 内 `Unity/UAL2_Standard.fbx`（`_RM` 付きはルートモーション版、使わない）
配布元・ライセンス: https://quaternius.com/packs/universalanimationlibrary.html

どちらも 1 ファイルに Mannequin メッシュ（身長約 1.83 m）+ 全アクション（UAL1 = 基本動作 45: Idle_Loop / Walk_Loop / Jog_Fwd_Loop / Sprint_Loop / Jump_* / Crouch_* / Roll / Sword_Attack …、UAL2 = 43: Zombie_Walk_Fwd_Loop / Slide_* / NinjaJump_* / Sword_Regular_* / Melee_Hook / Hit_Knockback / ClimbUp_1m / Idle_FoldArms_Loop …）。リグは同一。ボーン名は UE5 Manny 系（`pelvis`, `spine_01`, `Head`, `thigh_l`, `calf_l`, `foot_l`, `upperarm_l` …）。
現行モーションとの対応案: idle → Idle_Loop、walk → Walk_Loop、run → Jog_Fwd_Loop / Sprint_Loop、jump → Jump_Start、fall → Jump_Loop、land → Jump_Land、sneak → Crouch_Fwd_Loop。

調査ノート: `docs/research/2026-09-06-free-motion-datasets.md`

`src/motions/index.ts` の `MOTIONS` で `source: "quaternius"` + `action: "<アクション名>"` を指定したモーションが、このファイルからヒントを描く（現在 idle = Idle_Loop）。
