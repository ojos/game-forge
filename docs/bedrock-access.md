# Bedrock のモデルアクセスと資格情報

- 対象: #82（M2-13）
- 位置づけ: **宣言できる範囲は `terraform/bedrock.tf` が持ち、宣言できない範囲だけをこの文書が持つ。**
  この文書だけを見て、同じ外部状態を再現できることを目標とする。

---

## 1. 宣言と手作業の線引き

| 対象 | 持ち主 | 理由 |
|---|---|---|
| モデルアクセス（agreement の承諾） | `terraform/bedrock.tf` | 宣言できる |
| IAM ユーザーとポリシー | `terraform/bedrock.tf` | 宣言できる |
| **アクセスキーの実体** | **この文書（手作業）** | 宣言すると tfstate へ平文で落ちる |
| use case の申請 | **この文書（手作業）** | Console のフォームで、Anthropic 側の審査を伴う |
| TPM / RPM クォータ、AWS Budgets | 未定（#81 が値を決める） | 機構そのものが未設計 |

**対象は Dev / Prod の 2 アカウントである**（仕様 9.2 / 確定21）。`terraform/bedrock.tf` が
両方の agreement を宣言する。IAM ユーザーを置くのは Prod だけで、Dev では SSO の一時
資格情報を使う。

### アクセスキーを宣言しない理由

`aws_iam_access_key` は生成した秘密鍵を **tfstate へ平文で書く。** tfstate は
`.gitignore` で追跡から外しているが、ディスク上は平文である。`terraform/providers.tf` が
「資格情報を Terraform 変数として受け取ると tfstate や plan ファイルへ平文で落ちる経路が
できる」として避けているのと同じ経路を、出力側に作ることになる。

**ロールではなくユーザーである理由。** Cloudflare Pages Functions は AWS の外で動くため、
IAM ロールを引き受ける経路（インスタンスプロファイル、IRSA、OIDC フェデレーション）が
どれも使えない。長命キーになるのは構成上の帰結であり、選好ではない（仕様 4.1）。

---

## 2. アクセス開通の順序

**3 段ある。前の段が済むまで次は通らない。**

| 段 | 確認方法 | 済んでいないときの症状 |
|---:|---|---|
| 1. use case の申請 | `authorizationStatus` が `AUTHORIZED` | 申請フォームへ誘導される |
| 2. アカウント検証 | — | `Your account is currently being verified`（通常 2 時間以内） |
| 3. agreement の承諾 | `agreementAvailability` が `AVAILABLE` | `<model> is not available for this account` |

```bash
aws bedrock get-foundation-model-availability \
  --region ap-northeast-1 --model-id anthropic.claude-sonnet-5
```

**段 1 と 2 は Console と AWS 側の処理で、宣言できない。段 3 は `terraform apply` が行う。**

`deepseek.v3.2` は段 3 が要らない（`Agreement not supported for this model`）。

### use case の申請内容（構築時）

Console の「Submit use case details for Anthropic」で提出する。**アカウントごと、または
組織の管理アカウントで 1 回。**

| 項目 | 値 |
|---|---|
| Company name | OJOS |
| Company website URL | `https://github.com/ojos/` |
| Industry | Gaming |
| Intended users | External users |
| Use cases | 下記 |

```
Game Forge lets users describe a small 2D game in natural language. We use Claude to
generate Go source built on the Ebitengine library, compile it to WebAssembly in an
isolated container, and serve it from a sandboxed origin to play in a browser. Users
can fork and remix published games. Claude does code generation only and receives no
personal data. Invite-only closed beta, roughly 12-17 generations per day, with a hard
monthly spend cap, input/output moderation and a Go import allowlist.
```

**個人情報と知的財産を書かない**（フォームの注意書き）。

---

## 3. アクセスキーの発行

`terraform apply` で IAM ユーザーが出来た後に行う。

```bash
export AWS_PROFILE=game-forge-prod
aws iam create-access-key --user-name game-forge-bedrock-invoker
```

出力の `AccessKeyId` と `SecretAccessKey` を Pages のシークレットへ入れる。
**`SecretAccessKey` は発行時にしか表示されない。**

```bash
npx wrangler pages secret put BEDROCK_AWS_ACCESS_KEY_ID
npx wrangler pages secret put BEDROCK_AWS_SECRET_ACCESS_KEY
npx wrangler pages secret put BEDROCK_AWS_REGION   # ap-northeast-1
```

**`BEDROCK_AWS_SESSION_TOKEN` は本番では登録しない。** 一時資格情報はローカル開発で SSO を
使うときだけのものである（`docs/local-dev.md`）。

**値をリポジトリへ書かない。** `.dev.vars` は追跡除外済みで、`scripts/check-no-secrets.sh` が
毎回検査する。

---

## 4. ローテーション手順

**IAM ユーザーは同時に 2 本までアクセスキーを持てる。** これを使って無停止で入れ替える。

```bash
export AWS_PROFILE=game-forge-prod
USER=game-forge-bedrock-invoker

# 1. 新しいキーを作る（この時点で 2 本になる）
aws iam create-access-key --user-name "$USER"

# 2. Pages のシークレットを新しい値へ更新し、デプロイして疎通を確認する
npx wrangler pages secret put BEDROCK_AWS_ACCESS_KEY_ID
npx wrangler pages secret put BEDROCK_AWS_SECRET_ACCESS_KEY

# 3. 古いキーを **まず無効化する**（削除ではない。切り戻せる状態を残す）
aws iam update-access-key --user-name "$USER" \
  --access-key-id <OLD_KEY_ID> --status Inactive

# 4. 一定期間なにも壊れないことを確認してから削除する
aws iam delete-access-key --user-name "$USER" --access-key-id <OLD_KEY_ID>
```

**手順 3 と 4 を分ける理由。** 削除は取り消せない。無効化なら `--status Active` で
すぐ戻せる。切り戻せない操作を、確認より前に置かない。

現在のキーの一覧と最終使用日:

```bash
aws iam list-access-keys --user-name game-forge-bedrock-invoker
aws iam get-access-key-last-used --access-key-id <KEY_ID>
```

---

## 5. まだ決まっていないこと

- **TPM / RPM クォータと AWS Budgets の値**（#81）。仕様 4.3 の最外周は Bedrock では
  前払いクレジットを使えないため、機構そのものの設計から要る。**この文書と
  `terraform/bedrock.tf` は、それが決まるまでモデルアクセスと呼び出し権限だけを持つ。**
**分離方法は決着済み**（仕様 v1.1 / 9.2 / 確定21）。Dev / Prod の 2 アカウントに分け、
それぞれで agreement を承諾する。**Bedrock のクォータがアカウント単位でしか割れず、
4.3 の最外周で即時に効く唯一の層がそこにあるため。** 残っているのは上の値の決定だけ。
