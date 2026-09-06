# motions/mixamo/

`px poses` が読む Mixamo の FBX。git には入れない（`motions/**/*.fbx` は ignore）。

入手: https://www.mixamo.com/ で Character = **Y Bot** を選び、
- `Y Bot.fbx`: Character を Format FBX Binary, Pose T-pose でダウンロード
- 各モーション: Animations の **Action Adventure Pack** を FBX Binary, Skin = Without Skin, 30 fps でダウンロードし、ファイル名はそのまま（`walking.fbx`, `running.fbx`, `jumping up.fbx`, `falling idle.fbx`, `hard landing.fbx`, `crouched sneaking right.fbx`, `idle.fbx`）

どのモーションを使うかは `src/motions/index.ts` の `MOTIONS`。
