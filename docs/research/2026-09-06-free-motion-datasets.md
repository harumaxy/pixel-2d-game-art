# Mixamo 以外の無料モーションデータ源の調査（2026-09-06）

対象: `scripts/mixamo_poses.py` が Mixamo FBX から openpose + depth ヒントを描いている現行パイプラインに対して、代替または補完になる「無料で公開されているモーションデータ」を、ゲーム（商用）で使える前提で洗い出した。ライセンスは一次情報（LICENSE ファイル、公式ページ、公式 README）を開いて確認し、開けなかったものは「未確認」と明記している。

現行スクリプトの前提（調査の基準）:

- `bpy.ops.import_scene.fbx` で `Y Bot.fbx`（メッシュ付き）を 1 回読み、各モーション FBX からは Action だけを借りて Y Bot のリグに割り当てる（`import_armature` / `rig.animation_data.action = action`）。
- 関節は `"mixamorig:" + name` で引く（`BONES` / `joint_world`）。腰は `mixamorig:Hips`、頭の 5 点は `mixamorig:Head` のボーン座標系オフセット（`HEAD_OFFSETS`、単位はメートル、x = 左・y = 上・z = 前を仮定）。
- 向きは `base_yaw` が骨盤（左右の `UpLeg`）から推定し、無回転の Mixamo リグが -Y を向く前提。
- depth は Workbench の Z パスをカメラ距離 ±0.8 m でマッピングするので、**メッシュが無いと depth が真っ黒になる**。
- フレームは `action.frame_range` を等分してサンプルするので、元データの fps 自体は問題にならない（ループ判定は `motions.json` の `loop`）。

---

## 1. 結論（このパイプライン向けの推奨順）

| 順位 | ソース | 一言理由 |
|---|---|---|
| 1 | **Quaternius Universal Animation Library（無料 Standard 版）** | CC0。1 つの FBX に Mannequin メッシュ + 45 アクション（Idle / Walk / Jog / Sprint / Jump_Start / Jump_Loop / Jump_Land / Crouch_Fwd / Crouch_Idle / Roll / Sword_Attack …）が入っており、必要な 7 モーションを全部まかなえる。ボーン名は UE5 Manny 系なので `BONES` の対応表を差し替えるだけで済む。実ファイルを Blender 5.2 で開いて確認済み。 |
| 2 | **CMU Graphics Lab Motion Capture Database + cgspeed BVH 変換** | 「free for all uses」「商用プロジェクトでも可」と公式に明記。2,548 クリップで walk / run / jump / crouch / stealthy walk / fall まで揃う。ボーン名は Mixamo から接頭辞を外したものにほぼ一致。ただし BVH なのでメッシュが無く、depth のために Y Bot へのリターゲットか簡易メッシュ生成が要る。120 fps・先頭 1 フレームが T ポーズ・ノイズ多め。 |
| 3 | **Rokoko 無料 Motion Library パック（263 本 FBX）** | 公式ページに「商用利用を含めて使える」と明記され、**Mixamo スケルトン向けにエクスポート済みの FBX** が配られているので、接頭辞まで一致していれば現行スクリプトにほぼ無改造で載る可能性が高い。ただし規約本文（Terms of Use）は取得できず「未確認」、取得にメール登録が必要。 |
| 4 | **KayKit Character Animations（無料ティア）** | CC0。161 本で sneaking / crouching / dodging / 各種攻撃まである唯一の無料 CC0 セット。反面、KayKit の低頭身リグ（Rig_Medium）なので openpose ヒントの体型が現在の参照画像（8 頭身寄りの scavenger）とずれる。ボーン名は未確認。 |
| 5 | **100STYLE**（補完用） | CC BY 4.0（帰属表示で商用可）。100 スタイル × 歩き / 走り / アイドル / 横歩き で、Crouched・Zombie・Drunk・Old など「歩き方のバリエーション」を増やしたいときに強い。jump / attack は無い。BVH（Xsens 由来、60 fps）でメッシュ無し。 |

補足: **ACCAD**（CC BY 3.0、BVH/FBX、歩き・走り・格闘）も商用可で使えるが、クリップ数が少なく上記で足りるので次点扱い。

「データ量」「ゲーム向けクリップの網羅」「Blender への載せやすさ」「ライセンスの明快さ」を総合すると、まず Quaternius UAL を `motions.json` に追加して試すのが最短。CMU は歩き方のバリエーション（stealthy walk、stagger など）を拾うときの二番手。

---

## 2. 比較表

| 名前 | ライセンス | 商用 | 形式 | リグ / スケルトン | 関連クリップ | Blender 取り込み |
|---|---|---|---|---|---|---|
| Quaternius Universal Animation Library 1 / 2 | CC0 1.0 | 可 | FBX / GLB（Source 版は .blend） | 独自「universal humanoid rig」。実体は UE5 Manny 系の命名（`pelvis`, `spine_01`, `thigh_l`, `calf_l`, `upperarm_l`, `Head`…）、65 ボーン、メッシュ `Mannequin` 同梱 | Idle_Loop, Walk_Loop, Walk_Formal_Loop, Jog_Fwd_Loop, Sprint_Loop, Jump_Start / Jump_Loop / Jump_Land, Crouch_Idle_Loop, Crouch_Fwd_Loop, Roll, Sword_Attack, Punch_Jab / Cross, Death01 など 45（無料）/ 120+（Pro）。UAL2 はさらに 130+（パルクール、コンボ、ゾンビ） | FBX ネイティブ。1 ファイルに全 Action |
| CMU Mocap（cgspeed BVH 変換） | 独自（「free for all uses」/「research and commercial projects worldwide」、再販のみ不可の趣旨） | 可 | BVH（元は ASF/AMC、C3D） | cgspeed 独自。MotionBuilder 版は `Hips, LHipJoint, LeftUpLeg, LeftLeg, LeftFoot, LeftToeBase, LowerBack, Spine, Spine1, Neck, Neck1, Head, LeftShoulder, LeftArm, LeftForeArm, LeftHand …`（Mixamo から接頭辞を外した名前にほぼ一致） | 2,548 クリップ。walk（02_01, 07_01, 35_01, 69_01, 91_02）、run（09_01, 16_35, 35_17）、jump（13_11, 16_01, 118_01）、crouch/sneak（77_14, 139_29）、walk stealthily（17_03）、fall（90_16〜18）、standing（77_02, 82_01） | BVH インポータ（`bpy.ops.import_anim.bvh`）でアーマチュアのみ。メッシュ無し |
| Rokoko 無料パック（263 本） | 独自（公式ページ「商用利用を含めて可」。規約本文は未確認） | 可（公式ページの記述） | FBX、30 fps | **Mixamo / UE4・UE5 / HumanIK 向けにエクスポート済み**と記載 | 歩き・走りサイクル、スポーツ、スーパーヒーロー系（詳細一覧は未確認） | FBX ネイティブ。Mixamo 版なら接頭辞一致の可能性 |
| KayKit Character Animations | CC0 1.0 | 可 | FBX / glTF（Source 版は .blend） | KayKit 独自 Rig_Medium（100+）/ Rig_Large（25+）。低頭身。ボーン名は未確認 | 161 本: idling, walking, running, jumping, crawling, **sneaking, dodging, crouching**, 近接 / 遠隔攻撃、被弾、死亡、道具 | FBX / glTF ネイティブ |
| 100STYLE | CC BY 4.0 | 可（帰属表示） | BVH、60 fps | Xsens MVN 由来 28 ボーン（ボーン名は未確認） | 100 スタイル × {FW 前歩き, BW 後ろ歩き, SW 横歩き, FR 前走り, BR 後ろ走り, SR 横走り, ID アイドル, TR 遷移}。スタイル例: Crouched, Zombie, Drunk, Depressed, BentForward, BigSteps… | BVH インポータ。メッシュ無し |
| ACCAD Motion Lab | CC BY 3.0 | 可（帰属表示） | C3D / FBX / BVH / AMC / TXT | Vicon → MotionBuilder 由来（ボーン名は未確認） | walking, running, sprinting, martial arts（kicks, punches）, dance, gesture | FBX / BVH ネイティブ |
| Kenney Animated Characters 1–3 / Modular Characters | CC0 1.0 | 可 | zip（形式詳細は未確認） | 独自ブロック体型 | Idle, Jump（ポーズ）, Running の 3 本（Modular は 17 本） | 未確認 |
| mocapflow Free-Mocap-Library-FBX-GLB | CC0 1.0 | 可 | FBX / GLB / BVH | 「標準ヒューマノイド」（詳細未記載） | アメフト、ボクシング、ダンス、走り高跳びなどスポーツ中心。walking が 1 本 | FBX / glTF ネイティブ |
| Bandai Namco Research Motiondataset 1 / 2 | CC BY-NC 4.0 | **不可** | BVH、30 fps | `joint_Root > Hips > Spine > Chest > Neck > Head`, `Shoulder_L / UpperArm_L / LowerArm_L / Hand_L`, `UpperLeg_L / LowerLeg_L / Foot_L / Toes_L`（22 ジョイント） | walk / run / dash / walk-back / walk-left / walk-right / kick / punch / slash / dance × 15 スタイル（175 本）、walk / run / turn / wave × 7 スタイル（2,902 本） | BVH インポータ |
| Ubisoft LaFAN1 | CC BY-NC-ND 4.0 | **不可** | BVH、30 fps | 独自 22 ジョイント | walk, run, sprint, dance, fight, jumps, crawl, crouch, fall/get up, obstacles, push, stumble（77 シーケンス、4.6 時間） | BVH インポータ |
| AMASS / HumanML3D / Motion-X | 非商用の独自ライセンス（AMASS）/ MIT だがデータは AMASS 由来（HumanML3D）/ 研究限定（Motion-X） | **不可** | npz（SMPL / SMPL-X） | SMPL 系 | 大量だがゲーム用クリップとしては未整理 | SMPL アドオン + 変換が必要 |
| SFU Motion Capture Database | 独自（研究目的無料、商用製品・再販不可） | **不可** | BVH / FBX / C3D | Vicon 由来 | locomotion, obstacles, dance, martial arts, sports | FBX / BVH ネイティブ |
| Human3.6M | 独自（学術利用のみ、学術メールアドレス必須） | **不可** | 独自 | 独自 | discussion, smoking, walking など 17 シナリオ | 変換が必要 |
| KIT Whole-Body Human Motion Database | 明文の利用条件は未確認（登録必須、引用要請のみ） | 未確認 | MMM XML / C3D | MMM 参照モデル | walk, run, carry など | MMM → BVH の変換が必要 |
| Epic Animation Starter Pack / Game Animation Sample | Fab 標準ライセンス。ただし GAS は「UE 専用コンテンツ」ラベル、両方とも「AI の使用を許可: いいえ（NoAI）」 | 条件付き | Unreal Engine 形式のみ（uasset） | UE4 Mannequin / UE5 Manny | 62 本 / 500+ 本（walk, run, jump, fall, traversal） | UE から FBX 書き出しが必要 |
| Ready Player Me animation-library | 独自（無料・商用可だが **RPM アバター以外との使用禁止**） | 実質不可 | FBX | RPM（Mixamo 互換命名、feminine / masculine） | idle, walk, run, dance, expression（200+） | FBX ネイティブ |
| MoCap Online 無料サンプル | 独自 Standard License（AI 用途は事前の書面許可が必要） | 条件付き | FBX 等 | Mixamo / UE / Unity など | サンプル数本 | FBX ネイティブ |
| Truebones Free 500 Pak | 未確認 | 未確認 | BVH / FBX | 独自（iPi Soft 由来） | 多数 | BVH / FBX |
| Blender Studio Character Library | CC BY | 可 | .blend | Rigify 系の高機能リグ | クリップ集ではなくリグ配布 | ネイティブ |
| 4TU「FBX Conversion of the CMU database」 | **CC BY-NC 4.0**（元の CMU より厳しい） | **不可** | FBX | 独自 | CMU 全体 | FBX |
| Hugging Face gbionics/cmu-fbx | CMU の条件を継承と記載 | 可（記載上） | FBX（Anims_Only、メッシュ無し） | Quaternius の CC0 キャラにリターゲット | CMU 全体 2,548 本 | FBX |

---

## 3. 各ソースの詳細

### 3.1 Quaternius Universal Animation Library（UAL 1 / UAL 2）

- URL: https://quaternius.com/packs/universalanimationlibrary.html 、 https://quaternius.com/packs/universalanimationlibrary2.html 、itch: https://quaternius.itch.io/universal-animation-library 、Godot Asset Store: https://store.godotengine.org/asset/quaternius/universal-animation-library/
- ライセンス: 公式ページに「CC0」「Free to use in personal, educational and commercial projects.」（quaternius.com の両ページ、itch ページは「Creative Commons Zero v1.0 Universal」）。Godot Asset Store 側の License 欄も「CC0 1.0 Universal」。**商用可、帰属表示不要。**
- 形式: FBX / GLB。Standard（無料）は 45 アニメーション、Pro（$9.99〜）が 120+ 全部、Source（$14.99〜）に .blend。UAL2 は 130+（近接 / 武器コンボ、パルクール、農作業、釣り、ゾンビ歩行）。公式ページは「60〜70% は無料」とも書いている。
- 実ファイルの確認（Godot Asset Store 経由で配られている Standard 1.0 と同一と思われる `UAL1_Standard.fbx`、24.9 MB を Blender 5.2.1 でインポートして dump）:
  - オブジェクト: `Armature`（65 ボーン、インポート時 Z 回転 180°）と `Mannequin` メッシュ（高さ約 1.83 m）。**メッシュ同梱なので depth がそのまま出る。**
  - ボーン名: `root, pelvis, spine_01, spine_02, spine_03, neck_01, Head, clavicle_l, upperarm_l, lowerarm_l, hand_l, (指 4×5), thigh_l, calf_l, foot_l, ball_l, …_r`。UE5 Manny と同じ命名規約（公式ページの「Unreal / Godot / Unity で retarget 可能」「Mixamo 等の一般的なリグと互換」という記述と整合）。UAL v2.0（2026-01-23）で「新しい命名規約に更新（Modular Outfits / Base Characters と同じ）」とあるので、版によってボーン名が変わる点に注意: https://quaternius.itch.io/universal-animation-library/devlog/1326702/updated-files-v20-new-animation-library
  - Action（45 本、`Armature|Armature|<name>`）: A_TPose, Idle_Loop, Idle_Talking_Loop, Idle_Torch_Loop, Walk_Loop, Walk_Formal_Loop, Jog_Fwd_Loop, Sprint_Loop, Jump_Start, Jump_Loop, Jump_Land, Crouch_Idle_Loop, Crouch_Fwd_Loop, Roll, Roll_RM, Push_Loop, Swim_Fwd_Loop, Swim_Idle_Loop, Sitting_*, Sword_Idle, Sword_Attack, Sword_Attack_RM, Punch_Jab, Punch_Cross, Pistol_*, Spell_Simple_*, Hit_Chest, Hit_Head, Death01, Dance_Loop, Driving_Loop, Fixing_Kneeling, Interact, PickUp_Table。
  - フレーム範囲: Idle_Loop 1–76、Walk_Loop 1–41、Jog_Fwd_Loop 1–29、Sprint_Loop 1–21、Jump_Start 1–41、Jump_Loop 1–76、Jump_Land 1–39、Crouch_Fwd_Loop 1–61、Roll 1–45、Sword_Attack 1–47。元の fps は未確認（Blender 側のシーン fps は 24 のまま）。
- 現行 7 モーションとの対応: idle → Idle_Loop、walk → Walk_Loop、run → Jog_Fwd_Loop または Sprint_Loop、jump → Jump_Start、fall → Jump_Loop、land → Jump_Land、sneak → Crouch_Fwd_Loop。追加候補: Roll（回避）、Sword_Attack / Punch（攻撃）、Hit_*（被弾）、Death01。
- 落とし穴: `_RM` 付きはルートモーション版（`root` が進む）。無印の Loop はその場。1 FBX に全 Action が入るので「モーション毎に FBX」を前提にした `motions.json` の `fbx` 指定を「ファイル + Action 名」に変える必要がある（第 5 節）。

### 3.2 CMU Graphics Lab Motion Capture Database + cgspeed BVH 変換

- URL: 公式 https://mocap.cs.cmu.edu/ （FAQ: http://mocap.cs.cmu.edu/faqs.php ）、cgspeed MotionBuilder 版: https://sites.google.com/a/cgspeed.com/cgspeed/motion-capture/the-motionbuilder-friendly-bvh-conversion-release-of-cmus-motion-capture-database 、README: https://sites.google.com/a/cgspeed.com/cgspeed/motion-capture/the-motionbuilder-friendly-bvh-conversion-release-of-cmus-motion-capture-database/readme-file-for-the-bvh-conversion-release 、Daz 版 README: https://sites.google.com/a/cgspeed.com/cgspeed/motion-capture/the-daz-friendly-bvh-release-of-cmus-motion-capture-database/readmefirst-file-for-daz-friendly-primary-release 、モーション一覧: https://sites.google.com/a/cgspeed.com/cgspeed/motion-capture/the-motionbuilder-friendly-bvh-conversion-release-of-cmus-motion-capture-database/bvh-conversion-release-motions-list
- ライセンス（公式サイト本文）: トップページ「This dataset of motions is free for all uses.」、FAQ「The motion capture data may be copied, modified, or redistributed without permission.」。cgspeed README に転記された CMU の文言は「Use this data! This data is free for use in research and commercial projects worldwide.」で、論文発表時の引用先 `jkh+mocap@cs.cmu.edu` への連絡と「The data used in this project was obtained from mocap.cs.cmu.edu. The database was created with funding from NSF EIA-0196217.」の謝辞を求めている。正式なライセンス文書（CC 等）は存在せず、この文言が全てなので、**商用ゲームでの使用は可、データそのものの再販は避ける**、という理解になる。cgspeed の変換自体も「free to use worldwide for any purpose」。
- 形式: 元は ASF/AMC と C3D。cgspeed 変換は BVH、**120 fps**、フレーム 1 に T ポーズを追加（腕は水平から 5° 下げ）。MotionBuilder 版と Daz 版と 3dsMax 版があり、MotionBuilder 版（2010 再リリース推奨）が T ポーズが +Z を向く標準的なもの。
- スケルトン（MotionBuilder 版、README より）: Hips, LHipJoint, LeftUpLeg, LeftLeg, LeftFoot, LeftToeBase, RHipJoint, RightUpLeg, RightLeg, RightFoot, RightToeBase, LowerBack, Spine, Spine1, Neck, Neck1, Head, LeftShoulder, LeftArm, LeftForeArm, LeftHand, LeftFingerBase, LFingers, LThumb, Right 側同様。指 / 親指にはモーションデータが無い。
- 関連クリップ（モーション一覧より、subject_trial）: walk 02_01 / 07_01 / 35_01 / 69_01 / 91_02、run/jog 09_01 / 16_35 / 35_17 / 69_06、jump 13_11 / 16_01 / 75_01 / 118_01、crouch/sneak 77_14 / 139_29 / 143_41、walk stealthily 17_03、fall 90_16〜18、standing 77_02 / 82_01。被験者 91 は感情付きの歩き 62 本、被験者 16 は方向転換を含む移動 58 本。
- 落とし穴: マーカー追跡ミス由来の関節フリップが未清掃、Daz 版はヒップ補正でフットスリップが出る例あり（144_05）。単位（インチかセンチか）は README に記載が無く未確認なので、インポート時に `global_scale` を試して `rest_height` が 1.6〜1.9 m になるよう合わせる。**メッシュが無い**ため depth を出すには別途対策が要る（第 5 節）。

### 3.3 Rokoko 無料 Motion Library パック

- URL: https://www.rokoko.com/resources/download-263-rokoko-motion-capture-assets 、Motion Library 製品ページ https://www.rokoko.com/products/motion-library 、サポート https://support.rokoko.com/hc/en-us/articles/4410021327121-Getting-Started-Rokoko-Studio-Motion-Library
- ライセンス: 263 本パックの公式ページに「any animation, VFX, game, 3D project, including for commercial use」で使えると記載。Terms of Use 本文（「Rokoko Asset のライセンスはアカウント保有期間に限る」という条項があるとの検索結果あり）は 403 / 404 で取得できず **未確認**。再配布不可は確実と考えるべき。
- 形式: FBX、30 fps。**Mixamo / UE4・UE5 / HumanIK スケルトン向けにエクスポート済み**と記載（263 本ページ）。取得は名前・メール・会社規模・使用ソフトのフォーム送信 → Google Drive リンク。Motion Library 本体（数千本、無料 100〜150 本 + Eric Jacobus のアクション 50 本）は Rokoko Studio アプリ内からのブラウズ / 書き出し（Basic プランで FBX / BVH / CSV）。
- 関連クリップ: 歩き・走りサイクル、スポーツ、スーパーヒーロー系。一覧は未確認。
- 落とし穴: フォーム登録とマーケティングメール同意が必要。Mixamo 版 FBX のボーンが `mixamorig:` 接頭辞付きかどうかは実物で確認が必要（Mixamo からダウンロードした FBX は接頭辞付きだが、他社が「Mixamo 互換」で出す場合は接頭辞無しのこともある）。

### 3.4 KayKit Character Animations

- URL: https://kaylousberg.itch.io/kaykit-character-animations （旧版: https://kaylousberg.itch.io/kaykit-animations ）、GitHub（キャラクターパック）: https://github.com/KayKit-Game-Assets/KayKit-Character-Pack-Adventures-1.0 （LICENSE.txt に「License: (Creative Commons Zero, CC0)」）
- ライセンス: itch ページ「Creative Commons Zero v1.0 Universal」「free for personal and commercial use, no attribution required」。GitHub の Adventurers パックも README / LICENSE.txt で CC0 1.0。**商用可。**
- 形式: FBX / glTF。Source 版（$14.99〜）に .blend。
- リグ: Rig_Medium（100+ 本）と Rig_Large（25+ 本）。低頭身の KayKit キャラ用。ボーン名は未確認。Adventurers パック（4 体、75 アニメーション）にはキャラメッシュが付くので depth も出せる。
- 関連クリップ: General（idling, getting hit, death, spawning, interacting）、Movement（walking, running, jumping, crawling, **sneaking, dodging, crouching**）、Melee（片手 / 両手 / 素手 / 二刀流 / ガード）、Ranged（射撃 / 照準 / リロード / 魔法）、Simulation（waving, cheering, sitting, lying）、Tools（digging, lockpicking, fishing…）。無料ティアで 150+。
- 落とし穴: 体型が 2〜3 頭身なので openpose の関節配置がそのままだと参照画像（scavenger）とプロポーションが合わない。逆に 64px スプライトでは低頭身が読みやすい面もあり、A/B の価値はある。

### 3.5 100STYLE

- URL: https://www.ianxmason.com/100style/ 、Zenodo: https://zenodo.org/records/8127870 、リターゲット版: https://github.com/orangeduck/100style-retarget/
- ライセンス: 公式ページと Zenodo の両方で「Creative Commons Attribution 4.0 International」。**帰属表示すれば商用可。** リターゲット版（orangeduck）も同じ CC BY 4.0。
- 形式: BVH、60 fps、Xsens MVN で収録、28 ボーン。ボーン名は一次資料で確認できず未確認。`100STYLE.zip` 1.5 GB。
- クリップ: 100 スタイル × 8 種（BR / BW / FR / FW / ID / SR / SW / TR1–3）。スタイル名の例: Aeroplane, Akimbo, Angry, ArmsFolded, BentForward, BentKnees, BigSteps, Cat, Chicken, **Crouched**, Depressed, Dinosaur, DragLeftLeg, Drunk, Elated, FairySteps, Zombie など。
- 落とし穴: 長尺の連続収録なので、ループ 1 周期を自分で切り出す必要がある（現行の `frame_range` 等分では不可）。メッシュ無し。

### 3.6 ACCAD Motion Lab

- URL: https://accad.osu.edu/research/motion-lab/mocap-system-and-data
- ライセンス: 公式ページに「Creative Commons Attribution 3.0 Unported License」、帰属先は「ACCAD/The Ohio State University」。**商用可（帰属表示）。**
- 形式: C3D / FBX / BVH / AMC / TXT。Vicon（12 台 Valkyrie）→ MotionBuilder。
- クリップ: walking, running, sprinting、handspring / cartwheel、martial arts（kicks, punches, stances）、gesture、dance。被験者ごとに 15〜149 ファイル。
- 落とし穴: ボーン名・単位は未確認。数が少ないので補完用。

### 3.7 Kenney（Animated Characters 1–3、Modular Characters）

- URL: https://kenney-assets.itch.io/animated-characters-3 、 https://kenney.nl/assets/modular-characters
- ライセンス: 「CC0 1.0 Universal. You're allowed to use these game assets in any project including commercial ones.」（itch）、kenney.nl 側も「Creative Commons CC0」。
- クリップ: Animated Characters は Idle / Jump（ポーズ）/ Running の 3 本のみ。Modular Characters は 17 本と記載。形式の詳細は取得できず未確認。
- 評価: ブロック体型かつ本数が少ないので、このパイプラインの主データにはならない。

### 3.8 mocapflow Free-Mocap-Library-FBX-GLB

- URL: https://github.com/mocapflow/Free-Mocap-Library-FBX-GLB （LICENSE は CC0 1.0 Universal の全文）
- 内容: 5 秒程度のスポーツ・ダンス系クリップ（アメフト、ボクシング、ブレイクダンス、走り高跳び…）。ASSET_LIST 中で移動系は「walking」1 本と「Football Run」程度。
- 評価: ライセンスは最良だが、収録内容が合わない。攻撃モーションの参考程度。

### 3.9 Hugging Face gbionics/cmu-fbx（CMU の FBX 変換）

- URL: https://huggingface.co/datasets/gbionics/cmu-fbx
- 内容: cgspeed BVH を Blender + Auto-Rig Pro で Quaternius の CC0 キャラにリターゲットし、メッシュ無し（Anims_Only）の FBX 2,548 本にしたもの。データセットカードは CMU の条件（商用製品への組み込み可、データ自体の販売不可）を継承すると記載。
- 評価: BVH の扱いを避けたい場合の代替。ただし第三者の変換なので品質・ボーン名は実物確認が必要。

---

## 4. 除外したものと理由

| ソース | 理由 | 根拠 |
|---|---|---|
| Bandai Namco Research Motiondataset 1 / 2 | **CC BY-NC 4.0**（非商用）。データは walk / run / dash × 15 スタイル等で質は高いが、ゲームには使えない | `dataset/Bandai-Namco-Research-Motiondataset-1/LICENSE` と `-2/LICENSE` の冒頭が「Attribution-NonCommercial 4.0 International」 https://github.com/BandaiNamcoResearchInc/Bandai-Namco-Research-Motiondataset |
| Ubisoft LaFAN1 | **CC BY-NC-ND 4.0**（非商用・改変禁止） | リポジトリの `license.txt` 冒頭「Creative Commons Attribution-NonCommercial-NoDerivatives 4.0 International Public License」 https://github.com/ubisoft/ubisoft-laforge-animation-dataset 。orangeduck の lafan1-resolved も「NOT licensed for commercial use」 |
| AMASS | 「non-commercial scientific research, non-commercial education, or non-commercial artistic projects」のみ。「any use for commercial purposes, is prohibited」。商用は別途 ps-license@tue.mpg.de へ | https://amass.is.tue.mpg.de/license.html |
| HumanML3D | コードは MIT だが、モーション本体は AMASS から自前で生成する仕組み（「we are not allowed to distribute the data directly」）なので AMASS の非商用条件に従う | https://github.com/EricGuo5513/HumanML3D |
| Motion-X | 「Motion-X License」で研究目的限定、Google Form で非商用の申請が必要 | https://github.com/IDEA-Research/Motion-X |
| SFU Motion Capture Database | 「free for research purposes. The data cannot be used for commercial products or resale.」 | https://mocap.cs.sfu.ca/ |
| Human3.6M | EULA 第 1 条「GRANT OF LICENSE FREE OF CHARGE FOR ACADEMIC USE ONLY」、学術メールアドレスからの申請必須 | http://vision.imar.ro/human3.6m/eula.php |
| KIT Whole-Body Human Motion Database | 利用条件の明文が見つからず**未確認**（FAQ は登録必須と引用要請のみ、re3data の License 欄は「Copyrights」）。形式も MMM XML / C3D で BVH は無く、変換コストが高い | https://motion-database.humanoids.kit.edu/faq/ 、 https://www.re3data.org/repository/r3d100012184 |
| Epic Animation Starter Pack | Fab 標準ライセンス自体は「使用は Unreal Engine に限定されません」だが、配布形式が Unreal Engine（uasset）のみで FBX 書き出しに UE が要る。さらに商品ページが「AI の使用を許可: いいえ」（EULA 第 6 条(b)vii / 第 16 条(l) の NoAI コンテンツ = 生成 AI プログラムが利用するデータセット・開発・学習入力に使えない）。ControlNet の条件画像として使う本パイプラインはグレーなので避ける | EULA: https://www.fab.com/eula 、商品ページ: https://www.fab.com/listings/98ff449d-79db-4f54-9303-75486c4fb9d9 |
| Epic Game Animation Sample | 商品ページに「UE 専用コンテンツ - Unreal Engine ベースの製品のみに使用がライセンスされます」と明記、形式は Unreal Engine の完全プロジェクトのみ、NoAI | https://www.fab.com/listings/880e319a-a59e-4ed2-b268-b32dac7fa016 |
| Ready Player Me animation-library | 無料・商用可だが「Any use of the Animations with avatars or characters other than those from Ready Player Me is prohibited」。別キャラの参照画像で生成する本用途に合わない | https://github.com/readyplayerme/animation-library/blob/master/LICENSE.md |
| MoCap Online 無料サンプル | Standard License 第 3 条で「artificial intelligence applications」に関わる使用は事前の書面許可が必要（AI Permit）。1M ユーザー / $1M 収益の上限もある | https://mocaponline.com/pages/standard-license |
| Truebones Free 500 Pak | Gumroad ページから利用条件を取得できず**未確認**。iPi Soft 由来の手作り BVH で品質もばらつく | https://truebones.gumroad.com/p/free-500-pak-only-from-truebones |
| Blender Studio Character Library | CC BY のリグ配布であって、歩き・走りのクリップ集ではない | https://studio.blender.org/characters/ |
| 4TU「FBX Conversion of the CMU database」 | 変換物が **CC BY-NC 4.0** で、元の CMU（商用可）より厳しい。CMU を使うなら cgspeed か HF 版を使う | https://data.4tu.nl/datasets/0448aab2-3332-449f-a8e2-d208cb58c7df/1 |
| Kenney / mocapflow | ライセンスは CC0 で問題ないが、必要なクリップ（walk / run / jump / sneak）がほぼ無い | 上記 3.7 / 3.8 |

参考（現行）: Mixamo は Adobe の FAQ で個人・商用・非営利のゲームや映像での使用がロイヤリティ無料と説明されており、禁止は「生ファイルをアセットとして再配布」のみ。https://helpx.adobe.com/creative-cloud/faq/mixamo-faq.html （今回は 404 で本文を再確認できなかったので、この 1 行は過去の理解に基づく）。

---

## 5. パイプラインへの組み込みメモ

共通して変えるべき箇所は `scripts/mixamo_poses.py` の 4 点。

1. `import_armature` が FBX 前提（`bpy.ops.import_scene.fbx`）。BVH は `bpy.ops.import_anim.bvh`（Blender 5.2 で確認したオプション: `global_scale`, `frame_start`, `use_fps_scale`, `update_scene_fps`, `update_scene_duration`, `use_cyclic`, `rotate_mode`, `axis_forward`, `axis_up`, `target`）、glTF は `bpy.ops.import_scene.gltf`。拡張子で分岐すれば済む。
2. ボーン名。`joint_world` / `head_frame` / `ground_hips_z` が `"mixamorig:" + name` を直書きしている。`motions.json` か CLI にリグ種別を持たせ、`BONES` と接頭辞をリグ毎の辞書にする。
3. depth 用メッシュ。現行は Y Bot のメッシュに他クリップの Action を載せている。ソースにメッシュが付いていればそのリグをそのまま使い、BVH のようにメッシュが無い場合は (a) Y Bot にリターゲットする（Blender 公式 Extensions の「Retarget」や Rokoko Studio Live for Blender、Auto-Rig Pro など。手数は増える）か、(b) ボーンから簡易メッシュを生成する（各ボーンの head–tail を辺にした頂点群に Skin モディファイアを掛けて太さを与える。depth ヒントは輪郭だけ出れば良いので十分）。(b) の方がスクリプト内で完結し、リグ依存も無い。
4. `HEAD_OFFSETS` は Mixamo の Head ボーンの軸（x 左・y 上・z 前）を前提にしたメートル値。UE 系や BVH のボーンはロールが違うので、頭の 5 点は「Head ボーン原点 + 世界座標の上向き + キャラの前向き（`base_yaw` から算出）」で組み直す方が安全。

### 5.1 Quaternius UAL（推奨 1）

- `motions.json` の各エントリを `{"fbx": "UAL1_Standard.fbx", "action": "Idle_Loop"}` のように「ファイル + Action 名」で指定できるようにし、`main()` で FBX を 1 回だけ読んで `bpy.data.actions["Armature|Armature|Idle_Loop"]` を割り当てる（現行の「モーション毎に FBX を読み Action を借りる」ループの代わり）。
- ボーン対応（接頭辞無し）: `Hips→pelvis`, `Neck→neck_01`, `Head→Head`, `RightArm→upperarm_r`, `RightForeArm→lowerarm_r`, `RightHand→hand_r`, `LeftArm→upperarm_l` …, `RightUpLeg→thigh_r`, `RightLeg→calf_r`, `RightFoot→foot_r`, 左も同様。`base_yaw` は左右の `thigh_*` から取る。
- スケールはメートル（身長約 1.83 m）なので `DEPTH_RANGE` と `ortho_scale` はそのまま。Mixamo の 0.01 スケールを前提にしたコメント（`head_frame` の「the rig is scaled 0.01」）は実害無し。
- アーマチュアがインポート時に Z 回転 180° になる。`base_yaw` が骨盤から向きを取るので自動補正されるはずだが、`AZIMUTH` の「down = 正面」が反転していないか、最初の 1 フレームで確認する。
- メッシュ `Mannequin` 同梱なので depth は無改造。`Y Bot.fbx` 必須チェック（`main()` 冒頭）はリグ種別で分岐させる。
- フレーム数: Walk_Loop 41 フレーム（`loop: true` で末尾を除外する現行の `frame_times` がそのまま使える）。Jump_Start（41）→ jump、Jump_Loop（76）→ fall、Jump_Land（39）→ land、Crouch_Fwd_Loop（61）→ sneak。Sprint_Loop は 21 フレームしかないので 16 サンプル（`HINT_STEP = 2`）に対して間隔が粗い。run には Jog_Fwd_Loop（29）の方が無難。
- ルートモーション版（`_RM`）は使わない。使う場合は現行どおりカメラが腰を追うので大きな問題は無い。

### 5.2 CMU + cgspeed BVH（推奨 2）

- 取り込みは `bpy.ops.import_anim.bvh(filepath=..., global_scale=s, update_scene_fps=False, use_fps_scale=False, rotate_mode="NATIVE")`。120 fps のフレーム番号がそのまま Action に入るので、`frame_range` 等分の `frame_times` はそのまま使える。**フレーム 1 は追加された T ポーズ**なので `start` を 2 以上にずらす（`motions.json` に `start`/`end` を持たせて、長尺クリップから 1 周期を切り出せるようにする。CMU のクリップは連続収録が多く、walk なら数歩分入っている）。
- ボーン名は MotionBuilder 版なら `Hips, Neck, Head, RightArm, RightForeArm, RightHand, RightUpLeg, RightLeg, RightFoot, …` で、**現行 `BONES` の値から `mixamorig:` 接頭辞を外しただけ**。接頭辞を空文字にできれば対応表の変更は不要。Daz 版は命名が違うので使わない。
- 単位が未確認。`rest_height(rig)` が 1.6〜1.9 m になる `global_scale` を最初に決める（インチなら 0.0254、センチなら 0.01）。`DEPTH_RANGE`（0.8 m）と `HEAD_OFFSETS` はメートル前提なので合わせないと depth が飽和する。
- メッシュ無し。上記 3.(b) の Skin モディファイア方式で depth 用メッシュを生成するか、Y Bot にリターゲットする。
- T ポーズが +Z 向きなので、`base_yaw` の前提（-Y 向き）とは異なるが、骨盤から実測するので問題無い。
- ノイズ（関節フリップ）があるクリップは 64px では目立たないことが多いが、サンプル間隔が粗いと足が跳ぶので、候補クリップは一度 GIF で確認してから採用する。

### 5.3 Rokoko 263 本パック（Mixamo スケルトン版）

- ボーンが `mixamorig:` 付きなら `motions.json` にファイル名を足すだけ。接頭辞無しなら 5.2 と同じく接頭辞を可変にする。
- Rokoko の FBX にメッシュが付いているかは未確認。付いていなければ現行どおり Y Bot に Action を載せる（Mixamo 命名なら現行コードそのもの）。
- 30 fps、ループの切れ目は自前で確認。

### 5.4 KayKit Character Animations

- glTF なら `bpy.ops.import_scene.gltf`（Blender 標準）。FBX 版もある。
- ボーン名は未確認なので、まず 1 体読み込んで `rig.data.bones` を dump し、`BONES` の辞書を作る。Adventurers パックのキャラを使えばメッシュ付きで depth が出る。
- 低頭身なので `HEAD_OFFSETS` のメートル値（鼻 z 0.10、耳 x ±0.07 など）が頭のサイズに対して小さすぎる可能性がある。Head ボーンの長さに比例させる形に変えると、Quaternius / Mixamo との共用もしやすい。

### 5.5 100STYLE

- BVH（60 fps、Xsens 命名、要確認）。5.2 と同じ BVH 経路だが、収録が長尺連続なので `start`/`end` の切り出し指定が必須。
- 用途は「歩き / 走り / アイドルのスタイル差分」なので、`motions.json` に `walk_zombie` / `sneak`（Crouched スタイルの FW）などを増やす形になる。jump / attack は無いので Quaternius か CMU と併用する。

### 5.6 変更の最小案

`motions.json` の 1 エントリを次の形に拡張し、`mixamo_poses.py` を「リグ種別 → (インポート関数, 接頭辞, ボーン対応表, メッシュ有無)」の辞書で分岐させれば、Mixamo・Quaternius・CMU の 3 系統を 1 スクリプトで扱える。

```json
{ "id": "walk", "rig": "ual", "file": "UAL1_Standard.fbx", "action": "Walk_Loop",
  "frames": 8, "loop": true, "fps": 8, "prompt": "walking" }
{ "id": "sneak_cmu", "rig": "cmu", "file": "17_03.bvh", "start": 120, "end": 260,
  "frames": 8, "loop": true, "fps": 8, "prompt": "walking stealthily" }
```

`src/motions/index.ts` の `Motion.fbx` も同じ形（`file` + 任意の `action` / `start` / `end` / `rig`）に合わせる。
