# GCP プロジェクトと Google OAuth クライアントの手順書

- 対象: M1-2（issue #12）の P1
- 位置づけ: **宣言できる範囲は `terraform/gcp.tf` が持ち、宣言できない範囲だけをこの文書が持つ。**
  この文書だけを見て、同じ外部状態を再現できることを目標とする。

---

## 1. 宣言と手作業の線引き

共通規範「外部サービスの状態管理」は、恒久的な外部状態を宣言的に管理し、UI での直接作成を
恒久的な変更手段にしないことを求める。GCP 側はこの線で分かれる。

| 対象 | 持ち主 | 理由 |
|---|---|---|
| GCP プロジェクト | `terraform/gcp.tf`（`google_project`） | 宣言できる |
| OAuth 同意画面（Google Auth Platform） | この文書（手作業） | 宣言できない |
| OAuth クライアント（ウェブアプリ） | この文書（手作業） | 宣言できない |

**OAuth クライアントを宣言できない理由。** google プロバイダの `google_iap_client` は IAP
ブランド配下のクライアント専用で、一般公開のコンシューマ向けアプリには使えない。その IAP
OAuth Admin API 自体も、Google の告知により **2026-01-19 以降は新規プロジェクトで利用できない**
（`gcloud alpha iap oauth-brands list` が出す非推奨警告に記載。実際に `ojos-game-forge` では
利用できないことを確認済み）。gcloud にも対応するコマンドはない。

したがって Console での手作業が唯一の経路であり、この文書がその代替になる。

---

## 2. 前提

| 要件 | 値（構築時） | 確認方法 |
|---|---|---|
| GCP 組織 | `ojos.jp` / ID `1012332125944` | `gcloud organizations list` |
| プロジェクト作成権限 | `roles/resourcemanager.projectCreator` が `domain:ojos.jp` に付与済み | `gcloud organizations get-iam-policy 1012332125944` |
| gcloud CLI | devcontainer に同梱（`ghcr.io/dhoeric/features/google-cloud-cli:1`） | `gcloud --version` |
| CLI 認証 | `gcloud auth login` | `gcloud auth list` |
| Terraform 認証（ADC） | `gcloud auth application-default login --no-launch-browser` | `gcloud auth application-default print-access-token` |

CLI 用の認証（`gcloud auth login`）と Terraform 用の認証（ADC）は別物で、**両方が要る**。

**ADC のアカウントは、ブラウザでサインインしたアカウントになる**（#89 で踏んだ）。
別のアカウントでサインインしたままだと認証自体は成功し、`print-access-token` も通るのに、
`terraform plan` が `the user does not have permission to access Project "ojos-game-forge"`
で落ちる。**認証が失敗したのではなく、別人として成功している**ため、メッセージから
原因へ辿りにくい。次で実際のアカウントを確かめられる。

```bash
curl -s https://www.googleapis.com/oauth2/v3/userinfo \
  -H "Authorization: Bearer $(gcloud auth application-default print-access-token)" \
  | jq -r .email
# => ido@ojos.jp であること
```

`--no-launch-browser` を付けるのは devcontainer 内にブラウザが無いため（AWS SSO で
`--use-device-code` が要るのと同じ事情）。どちらの資格情報も named volume `gcloud-storage`
（`~/.config/gcloud`）に入り、リビルドを跨いで残る。

---

## 3. プロジェクト（Terraform）

宣言は `terraform/gcp.tf`。値は `terraform.tfvars`（追跡外）から受ける。

```bash
terraform -chdir=terraform apply
```

構築時の結果:

| 項目 | 値 |
|---|---|
| プロジェクト ID | `ojos-game-forge`（変更不可） |
| プロジェクト番号 | `859544169721` |
| 親 | 組織 `ojos.jp`（`1012332125944`） |
| 請求先アカウント | **紐付けない** |

**請求先アカウントを紐付けない。** OAuth クライアントの発行と利用に課金は要らない。紐付ければ
意図しない課金の経路を先に作ることになる。課金が要る API を使う段階で `billing_account` を足す。

**`auto_create_network = false` を指定してはいけない。** プロバイダはこれを「プロジェクトを
作ってから既定ネットワークを削除する」手順で実装しており、削除のために Compute Engine API の
有効化を要求する。API の有効化には課金の紐付けが要るため、上記の方針と衝突して apply が
`Error 400 UREQ_PROJECT_BILLING_NOT_FOUND` で落ちる（構築時に実際に踏んだ）。そもそも既定 VPC は
Compute Engine API を有効にしない限り実体化しないため、既定の `true` のままでネットワークは
存在しない。

---

## 4. OAuth 同意画面（手作業）

<https://console.cloud.google.com/auth/overview?project=ojos-game-forge>

| 項目 | 値 | 理由 |
|---|---|---|
| 対象（Audience） | **External** | Internal は Workspace `ojos.jp` のアカウントしかログインできない。招待コードを持つ一般ユーザーが対象（仕様書 8.1） |
| アプリ名 | `Game Forge` | 同意画面に表示される。変更可 |
| ユーザーサポートメール / 開発者連絡先 | `ido@ojos.jp` | |
| 公開ステータス | **Testing** | テストユーザーに登録したアカウントだけがログインできる（100 人上限）。未登録の人はログインを試みることすらできない |
| テストユーザー | `ido@ojos.jp` | Testing では必須。ここに無いアカウントは弾かれる |
| スコープ | `openid` / `.../auth/userinfo.email` / `.../auth/userinfo.profile` | 3 つとも非機密（Non-sensitive） |
| ロゴ | **登録しない** | 登録すると Google のブランド審査の対象になり、承認まで待たされる |

**機密スコープを足さない。** 非機密スコープのみなら Google の審査は要らない。1 つでも機密・
制限付きスコープを足すと審査待ちが発生し、その間ログインが本番で使えなくなる。

**Testing の「リフレッシュトークンが 7 日で失効」はこの設計に影響しない。** セッションは Google の
リフレッシュトークンではなく、自前の署名付き Cookie（`src/session.ts`）で保持するため。Google を
使うのは初回ログインの本人確認だけである。

**クローズドβの間は Testing のまま運用する**（2026-08-25 決定 / #89）。**その代償として、
招待するたびにこの画面のテストユーザーへ相手のメールアドレスを手登録する必要がある。**
アプリ側の招待コードと合わせて招待が二重になり、上限は 100 人である。運用上の制約として
仕様書 8.1「Google OAuth を Testing のまま運用する」に記録した。

---

## 5. OAuth クライアント（手作業）

同じ画面の左メニュー「クライアント」→「クライアントを作成」。

| 項目 | 値 |
|---|---|
| アプリケーションの種類 | ウェブ アプリケーション |
| 名前 | `game-forge-local` |
| 承認済みのリダイレクト URI | `https://game-forge.localtest.me:8787/auth/google/callback` |
| 承認済みの JavaScript 生成元 | 空 |

**リダイレクト URI はポートまで含めて完全一致で照合される。** ローカルの起動は 8787 番
（`docs/local-dev.md` 4 章）なので、`:8787` を省くと実機のコールバックが `redirect_uri_mismatch`
で弾かれる。

**JavaScript 生成元は要らない。** 認可コードの交換は Workers 側のサーバ処理で行い、ブラウザから
直接 Google のトークンエンドポイントを叩かないため。

**`localtest.me` は所有ドメインではないが、Testing では登録できた**（構築時に確認）。ただし
公開ステータスを In production へ切り替えるときに、承認済みドメインの要求が変わって登録が
維持できない可能性がある。その場合は `game-forge.ojos.jp`（Route53 で宣言済み、issue #53）の
サブドメインを 127.0.0.1 へ向けて使う。所有ドメインなので Search Console で所有権を証明できる。

### 本番のリダイレクト URI（#89）

**別クライアントを作らず、このクライアントへ URI を 1 本追加する。** クライアントを分けると
`GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` が 2 組になり、同意画面の設定（テストユーザーを
含む）も二重に管理することになる。Testing のまま運用する以上、テストユーザーの一覧を
1 か所に保つほうが運用の事故が少ない。

| 項目 | 値 |
|---|---|
| 承認済みのリダイレクト URI（追加） | `https://app.game-forge.ojos.jp/auth/google/callback` |
| 承認済みのリダイレクト URI（既存・維持） | `https://game-forge.localtest.me:8787/auth/google/callback` |

**ホストが `app.` 付きなのは DNS の制約による**（仕様書 1.2.11 / `docs/pages-deploy.md`）。
`game-forge.ojos.jp` は Route53 ホストゾーンの apex で CNAME を張れない。

**既存のローカル用 URI は消さないこと。** 消すと手元の開発でログインできなくなる。
リダイレクト URI は**完全一致**で照合されるため、本番は 443 番（ポート表記なし）、
ローカルは `:8787` 付きで別々に登録する必要がある。

**サンドボックス側（`sandbox.game-forge.ojos.jp`）は登録しない。** あちらは cookie も認証も
持たない（仕様書 7.2）。

`src/auth/google.ts` の `redirectUri` はリクエストの `Host` から組み立てるため、
コードにホスト名を持たない。登録した URI と実際のホストが食い違うと
`redirect_uri_mismatch` で落ちる。

---

## 6. 発行した値の扱い

`client_id` と `client_secret` は Console にしか存在しない。**リポジトリには置かない。**

- 置き場所は `.dev.vars`（`.gitignore` で追跡除外、`scripts/acceptance.sh` が除外されていることを毎回検査する）
- 共有する雛形は `.dev.vars.example`（キー名だけ。値を書くと acceptance が落ちる）
- `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` の配線は M1-2 の T4 が行う。P1 の時点では発行までが範囲

`client_id` は `<プロジェクト番号>-<ランダム>.apps.googleusercontent.com` の形式になる。
先頭がプロジェクト番号 `859544169721` と一致することが、正しいプロジェクトで発行した確認になる。

---

## 7. 確認方法

宣言側（プロジェクト）は機械判定できる。

```bash
gcloud projects describe ojos-game-forge --format="value(projectId,projectNumber,lifecycleState)"
# => ojos-game-forge	859544169721	ACTIVE

terraform -chdir=terraform plan   # 差分なしであること
```

同意画面と OAuth クライアントは API から列挙できない（1 章）。**Console での目視が唯一の確認手段**
であり、`scripts/acceptance-remote.sh` に検査を置けない。宣言と実状態の乖離を機械照合できない
範囲がここに残ることを、承知の上で受け入れている。

実効的な検査は T4 以降の実機ログインになる。ログインが通ればこの章の設定は正しく、通らなければ
どこかが違う、という形でしか判定できない。
