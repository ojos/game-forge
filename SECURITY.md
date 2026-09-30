# セキュリティの報告

Game Forge の脆弱性を見つけたときは、**公開の issue ではなく、GitHub の非公開の報告から**知らせてください。

## 報告のしかた

1. このリポジトリの [Security タブ](https://github.com/ojos/game-forge/security) を開きます。
2. **Report a vulnerability** から報告します。内容は運営者だけが読めます。

書いていただきたいこと:

- 影響を受ける場所（URL・画面・API のパス、またはリポジトリのファイル）
- 再現の手順と、確かめた日時
- 想定される影響（何ができてしまうか）

**公開の issue・PR・SNS には書かないでください。** 直す前に広まると、利用者が危険にさらされます。

## 対象

- このリポジトリのコード
- サービスの 3 つのホスト: `app.game-forge.ojos.jp`・`sandbox.game-forge.ojos.jp`・`admin.game-forge.ojos.jp`

対象にしないもの:

- **利用者が生成・公開した作品の中身**（不適切な作品は、ログインしたうえで、その作品ページの「この作品を通報する」から知らせてください）
- 大量のリクエストでサービスを止める試み（DoS）や、自動の大量スキャン
- 他の利用者のアカウントやデータに実際に触れる試み。確かめるのは、ご自身のアカウントの範囲にとどめてください
- 運営者や利用者へのソーシャルエンジニアリング

## 対応の目安

運営は 1 人で行っています。**受け取ったことの返信は、7 日以内を目安にします。** 直し方と公開の時期は、報告者と相談して決めます。

## In English

Please report vulnerabilities **privately** via [Security → Report a vulnerability](https://github.com/ojos/game-forge/security), not in public issues. In scope: this repository and the three service hosts listed above. Out of scope: the content of user-generated games, denial-of-service or high-volume automated scanning, and accessing other users' accounts or data. We aim to acknowledge reports within 7 days.
