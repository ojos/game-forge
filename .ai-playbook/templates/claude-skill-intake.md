---
name: intake
description: 実装・修正・issue 起票を求められたときに、intake の要否を判定し、必要なら intake 票を作成する。実装依頼、バグ修正依頼、機能追加、リファクタ、インフラ変更、「〜を実装して」「〜を直して」「issue にして」といった要求で使う。質問・説明・調査のみの要求では使わない。
---

# Intake 判定

このスキルは判定の起点のみを担います。**規範の正本は `.ai-playbook/intake/` と `.ai-playbook/role-contracts/intake-manager.md` です。** 判定基準・intake 票の項目定義・`reason_code` の一覧をここへ複製せず、必ずこれらを参照して判断します。ここへ複製すると規範と二重管理になり、更新のたびに乖離するためです。

## 手順

1. **要求を分類する。** 実装依頼か、質問・説明・調査のみか。
2. **`.ai-playbook/intake/REASON_CODES.md` を読む。** 該当する `reason_code` を 1 つ選ぶ。軽微修正として免除する場合は、`.ai-playbook/intake/REASON_CODES.md` の「軽微修正の免除条件」を満たすことを確認する（条件はそちらに定義されている）。
3. **免除なら** `reason_code` を 1 行で示して、そのまま作業へ進む。
4. **必須なら** `.ai-playbook/intake/intake-template.md` に従って intake 票を起票する。必須項目・任意項目の定義は同テンプレートに従う。不足項目は `.ai-playbook/shared-ai-rules.md` 9 章に従い、**一問ずつ・意図を添えて・選択肢形式で**確認する。
5. **ユーザー承認を得るまで issue を作成しない。** 承認後に起票し、実装フローへ引き渡す。

## 判定に迷った場合

intake 必須側へ倒します。免除の誤りは要件未確定のまま実装が進む形で表面化し、発見が遅れるためです（`.ai-playbook/intake/REASON_CODES.md` の「安全側の既定」）。

## 参照

- ロール契約: `.ai-playbook/role-contracts/intake-manager.md`
- 判定根拠の分類: `.ai-playbook/intake/REASON_CODES.md`
- 票の雛形: `.ai-playbook/intake/intake-template.md`
- 起票後の手順: `.ai-playbook/task-playbooks/issue-triage.md`
