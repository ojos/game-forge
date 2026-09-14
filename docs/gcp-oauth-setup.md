# GCP プロジェクトと Google OAuth クライアントの手順書

- 対象: M1-2（issue #12）の P1。2 プロジェクト構成への書き直しは #479
- 位置づけ: **宣言できる範囲は `terraform/gcp.tf` が持ち、宣言できない範囲だけをこの文書が持つ。**
  この文書だけを見て、同じ外部状態を再現できることを目標とする。

---

## 1. 宣言と手作業の線引き

共通規範「外部サービスの状態管理」は、恒久的な外部状態を宣言的に管理し、UI での直接作成を
恒久的な変更手段にしないことを求める。GCP 側はこの線で分かれる。

| 対象 | 持ち主 | 理由 |
|---|---|---|
| GCP プロジェクト（本番・開発の 2 つ） | `terraform/gcp.tf`（`google_project`） | 宣言できる |
| 請求先アカウントの紐付け（本番は #487、開発は #479） | `terraform/gcp.tf`（`billing_account`。ID は `terraform.tfvars`） | 宣言できる |
| OAuth 同意画面（Google Auth Platform） | この文書（手作業） | 宣言できない |
| OAuth クライアント（ウェブアプリ） | この文書（手作業） | 宣言できない |
| `ojos.jp` の所有証明（Search Console の TXT レコード） | この文書（手作業。4.3） | `ojos.jp` のゾーンはさくら側（dns.ne.jp）にあり、DNS の API が無い（`terraform/dns.tf` の冒頭） |

**OAuth クライアントを宣言できない理由。** google プロバイダの `google_iap_client` は IAP
ブランド配下のクライアント専用で、一般公開のコンシューマ向けアプリには使えない。その IAP
OAuth Admin API 自体も、Google の告知により **2026-01-19 以降は新規プロジェクトで利用できない**
（`gcloud alpha iap oauth-brands list` が出す非推奨警告に記載。実際に `ojos-game-forge` では
利用できないことを確認済み）。gcloud にも対応するコマンドはない。

したがって Console での手作業が唯一の経路であり、この文書がその代替になる。

### 1.1 本番と開発の 2 プロジェクト（#479）

**2026-09-14 から、Google OAuth のプロジェクトは本番と開発の 2 つに分かれている。**

**分けた理由。** 本番の同意画面を外部・本番環境へ切り替えてブランド確認に出すには、承認済み
ドメインをすべて Search Console で所有証明する必要がある。他人のドメインである `localtest.me`
は証明できないため、本番の承認済みドメインから外した。すると本番のクライアントにローカル用の
リダイレクト URI を置けなくなるので、ローカル開発用に別のプロジェクトを作った。

| 項目 | 本番 | 開発 |
|---|---|---|
| プロジェクト ID | `ojos-game-forge`（変更不可） | `ojos-game-forge-dev`（変更不可） |
| プロジェクト番号 | `859544169721` | `558074593204` |
| 表示名 | `game-forge` | `game-forge-dev` |
| 親 | 組織 `ojos.jp` | 組織 `ojos.jp` |
| 作り方 | terraform で作成 | 2026-09-14 に Console で手作成し、terraform に取り込んだ（3.2） |
| terraform のリソース | `google_project.game_forge` | `google_project.game_forge_dev` |
| 請求先アカウント | **紐付けた**（ブランド確認のため。#487） | **紐付いている**（Console の作成時に自動で紐付いた。利用者の判断で残した。3.3） |
| 同意画面の対象（Audience） | **外部** | **内部** |
| 公開ステータス | **本番環境**（In production） | —（内部のアプリには無い） |
| ログインできるアカウント | Google アカウントなら誰でも（絞るのはアプリ側の招待コード） | **Workspace `ojos.jp` のアカウントだけ** |
| ロゴ | **登録した** | **登録しない** |
| ブランド確認 | **審査に提出した**（2026-09-14） | 出さない |
| 承認済みドメイン | `ojos.jp`（Search Console で所有証明。4.3） | — |
| スコープ | `openid` / `email` / `profile` | `openid` / `email` / `profile` |
| OAuth クライアント | `game-forge-prod` | `game-forge-dev` |
| リダイレクト URI | app と admin の 2 本（5.1） | `localtest.me` の 2 本（5.2） |
| `client_id` / `client_secret` の置き場所 | Cloudflare Pages の secret（`docs/pages-deploy.md`） | 各自の `.dev.vars`（6 章） |

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

宣言は `terraform/gcp.tf`。値は `terraform.tfvars`（追跡外）から受ける。**terraform は main に
置いたプライマリのツリーから回す**（state と tfvars が追跡外で、プライマリにしか無いため）。

```bash
terraform -chdir=terraform plan    # 差分を読んでから
terraform -chdir=terraform apply
```

### 3.1 本番（`google_project.game_forge`）

| 項目 | 値 |
|---|---|
| プロジェクト ID | `ojos-game-forge`（変更不可） |
| プロジェクト番号 | `859544169721` |
| 親 | 組織 `ojos.jp`（`1012332125944`） |
| 請求先アカウント | **紐付けた**（2026-09-14。#487） |

**請求先アカウントは、ブランド確認のために紐付けた。** 2026-09-14 に利用者が Console で紐付け、
後追いで宣言へ取り込んだ（#487）。ID は公開する必要が無いので、宣言にもこの文書にも書かず、
`terraform.tfvars` の `gcp_billing_account` から受ける。**変数に既定値は無い**——値の無い
環境で plan すると、紐付けを外す差分を出す前に変数の不足で止まる。紐付けを外すとブランド確認に
影響しうるので、外す前に同意画面（ブランド）の確認状態を確かめる。**紐付けは課金が要る API を
使い始めたことを意味しない。** 課金が要る API はいまも有効にしておらず、OAuth クライアントの
発行と利用に課金は要らない。

> **注記（#479）。旧記述**——表の「請求先アカウント」は「**紐付けない**」で、本文は「**請求先アカウントを
> 紐付けない。** OAuth クライアントの発行と利用に課金は要らない。紐付ければ意図しない課金の経路を
> 先に作ることになる。課金が要る API を使う段階で `billing_account` を足す。」だった。ブランド確認の
> ために紐付けた（#487）ので改めた。

**`auto_create_network = false` を指定してはいけない。** プロバイダはこれを「プロジェクトを
作ってから既定ネットワークを削除する」手順で実装しており、削除のために Compute Engine API の
有効化を要求する。構築時は請求先アカウントが無かったため、有効化が
`Error 400 UREQ_PROJECT_BILLING_NOT_FOUND` で落ち、apply が止まった（実際に踏んだ）。
**紐付けた今はこの失敗が歯止めにならない**が、ネットワークを消すためだけに課金が発生しうる
Compute Engine API を有効にする指定になることは変わらないので、既定の `true` のままにする。

- **実測した現状（2026-09-14、読み取りのみ）:** Compute Engine API は無効で、既定ネットワークは無い
  （`compute/v1/projects/ojos-game-forge/global/networks` が `accessNotConfigured` を返す）
- **新規作成・API 有効化時の挙動は別である。** プロバイダのドキュメントは、`true` なら既定ネットワークが
  作られ、`false` でも一度作られてから Terraform が削除する、としている。上の実測は既存のこの
  プロジェクトのもので、新規作成時に作られないことを確かめたものではない。Compute Engine API を
  有効にする段階で、`auto_create_network` を含めて既定ネットワークの扱いを決め直す（`terraform/gcp.tf` の注記）

> **注記（#479）。旧記述**——「API の有効化には課金の紐付けが要るため、上記の方針と衝突して apply が
> `Error 400 UREQ_PROJECT_BILLING_NOT_FOUND` で落ちる（構築時に実際に踏んだ）。そもそも既定 VPC は
> Compute Engine API を有効にしない限り実体化しないため、既定の `true` のままでネットワークは
> 存在しない。」。請求先アカウントを紐付けた（#487）ことと、新規作成時の挙動を断定していた点
> （PR #488 の Copilot の指摘）に合わせて改めた。

### 3.2 開発（`google_project.game_forge_dev`）

| 項目 | 値 |
|---|---|
| プロジェクト ID | `ojos-game-forge-dev`（変更不可。変数 `gcp_dev_project_id` の既定値） |
| プロジェクト番号 | `558074593204` |
| 表示名 | `game-forge-dev`（変数 `gcp_dev_project_name` の既定値） |
| 親 | 組織 `ojos.jp`（本番と同じ `gcp_org_id`） |
| 請求先アカウント | **紐付いている**（変数 `gcp_dev_billing_account`。3.3） |
| `deletion_policy` | `PREVENT`（本番と同じ） |

**2026-09-14 に利用者が Console で手作成し、後追いで宣言へ取り込んだ**（#479）。取り込みは
`terraform/gcp.tf` の `import` ブロックで行う。CLI の `terraform import` にしなかったのは、
取り込みも plan に並ぶので、置き換えや削除の差分が無いことを state を書き換える前に確かめられる
ためである。**`import` ブロックは取り込んだ後も残す**（state に既にあれば何もしない）。

- **plan に置き換え（replace）や削除の差分が出たら、apply しないで止める**
- `import` ブロックの `id` は文字列で `projects/ojos-game-forge-dev` を持つ（変数を使えるのは Terraform 1.6 から）。
  `gcp_dev_project_id` を変えるときは両方を変える。合わないと置き換えの差分になる
- `auto_create_network` は本番と同じく既定の `true` のまま。取り込みでもプロバイダは state に `true` を
  入れるので、差分は出ない。Compute Engine API は無効で、既定ネットワークは無い（2026-09-14 の実測）
- Console が作成時に有効にした API（BigQuery など）は残っている。整理は #479 の範囲外

**ゼロから作り直すとき**は、Console で作らず `import` ブロックを外して `terraform apply` で作る
（削除したプロジェクトの ID は再利用できないので、別の ID になる。変数と `import` ブロックの両方を変える）。

### 3.3 開発用プロジェクトの請求先アカウント（紐付いている。利用者の判断で残した）

**開発用プロジェクトにも請求先アカウントが紐付いている。** 2026-09-14 に Console でプロジェクトを
作成したときに、**自動で紐付いた**とみられる（手作成のときに紐付けの操作はしていない）。
**Console でプロジェクトを作ると、既定の請求先アカウントが自動で紐付くことがある**ので、作り直すときも作成後に確かめる。

**根拠は terraform の plan である**（2026-09-14、PR #497 のコメント）。本番の `gcp_billing_account` と同じ値を
`gcp_dev_billing_account` に入れた plan で `billing_account` に差分が出なかったので、**本番と同じ請求先アカウントが
紐付いている。** 取り込みは「Plan: 1 to import, 0 to add, 0 to change, 0 to destroy.」で、2026-09-14 08:37 UTC に
apply した（`Apply complete! Resources: 1 imported, 0 added, 0 changed, 0 destroyed.`）。apply 後の plan は
終了コード 0 / No changes で、`state show` に `project_id = "ojos-game-forge-dev"` / `number = "558074593204"` /
`deletion_policy = "PREVENT"` が出た。紐付いていることに最初に気づいたのは、レーンが ADC で Cloud Billing API を
読んだとき（`billingEnabled` が `true`）だが、親の環境では Cloud Billing API が両プロジェクトとも無効で読めず、
再現できなかったので、根拠にはしない。

**利用者の判断で残し、宣言を実物に合わせた**（2026-09-14。#479）。`google_project.game_forge_dev` の
`billing_account` は、`terraform.tfvars` の `gcp_dev_billing_account` から受ける。ID は宣言にもこの文書にも
書かない。**本番と同じアカウントかどうかは宣言で決め打ちせず**、本番の `gcp_billing_account` とは別の変数に
してある。**変数に既定値は無い**——値の無い環境で plan すると、紐付けを外す差分を出す前に変数の不足で止まる。

- **紐付けは、課金が要る API を使っていることを意味しない。** このサービスが開発用プロジェクトで使うのは
  OAuth クライアントだけで、発行と利用に課金は要らない。Console が作成時に既定で有効にした API（BigQuery
  など）は残っている（整理は #479 の範囲外）
- **外すときは**、`terraform/gcp.tf` の `billing_account` の行と変数 `gcp_dev_billing_account` を消し、
  `terraform plan` で `billing_account` を外す in-place の差分だけが出ることを確かめてから apply する

> **注記（#479）。** issue #479 の起票時は、開発用プロジェクトを「課金なし」（請求先アカウントを紐付けない）で
> 取り込む前提だった。取り込みの準備中に紐付いていることが分かり、利用者が残すと判断した（2026-09-14）。

**確認の手順（利用者が Console で行う）。** 取り込みの apply の後に行う。

1. <https://console.cloud.google.com/billing/linkedaccount?project=ojos-game-forge-dev> を開く
   （Console の「お支払い」で、プロジェクトの選択を `ojos-game-forge-dev` にする）
2. 請求先アカウントがリンクされている（紐付いている）ことを確かめる

CLI でも確かめられる（請求先アカウントの ID を表示しない形にしてある）。

```bash
gcloud billing projects describe ojos-game-forge-dev --format="value(billingEnabled)"
# => True であること
```

**2026-09-14 時点の確認結果:** （利用者の確認待ち）

---

## 4. OAuth 同意画面（手作業）

**同意画面の設定はプロジェクトごとにある。** 本番と開発で対象（外部・内部）が違う（1.1 の対照表）。

### 4.1 本番（`ojos-game-forge`）

<https://console.cloud.google.com/auth/overview?project=ojos-game-forge>

| 項目 | 値 | 理由 |
|---|---|---|
| 対象（Audience） | **外部**（External） | 内部は Workspace `ojos.jp` のアカウントしかログインできない。招待コードを持つ一般ユーザーが対象（仕様書 8.1） |
| 公開ステータス | **本番環境**（In production。2026-09-14 に切り替え） | Google アカウントなら誰でも同意画面へ進める。登録できるかはアプリ側の招待コードで決まる（仕様書 8.1「Google OAuth を本番環境で運用する」） |
| アプリ名 | `Game Forge` | 同意画面に表示される。変えると、ブランド確認をもう一度受けることになりうる |
| ユーザーサポートメール / 開発者連絡先 | `ido@ojos.jp` | |
| スコープ | `openid` / `.../auth/userinfo.email` / `.../auth/userinfo.profile` | 3 つとも非機密（Non-sensitive） |
| ロゴ | **登録した** | ブランド確認の対象になる。同意画面にアプリ名とロゴを出すため |
| 承認済みドメイン | `ojos.jp` | Search Console で所有を証明してある（4.3）。`localtest.me` は 2026-09-14 に外した（1.1） |
| ブランド確認 | **審査に提出した**（2026-09-14） | 状態は Console でしか見られない |

> **注記（#479）。旧記述**——表の「公開ステータス」は「**Testing**」（テストユーザーに登録したアカウントだけが
> ログインできる。100 人上限）、「テストユーザー」の行は「`ido@ojos.jp`（Testing では必須）」、
> 「ロゴ」は「**登録しない**（登録すると Google のブランド審査の対象になり、承認まで待たされる）」だった。
> 表の下には「**クローズドβの間は Testing のまま運用する**（2026-08-25 決定 / #89）。**その代償として、
> 招待するたびにこの画面のテストユーザーへ相手のメールアドレスを手登録する必要がある。**」とあった。
> 2026-09-14 に本番環境へ切り替え、ロゴを登録してブランド確認に出したので改めた（決定の正本は
> 仕様書 8.1。#478）。

**機密スコープを足さない。** 非機密スコープのみなら、スコープの審査（機密・制限付きスコープの確認）は
要らない。1 つでも機密・制限付きスコープを足すと審査待ちが発生し、その間ログインが本番で使えなくなる。

**リフレッシュトークンの寿命はこの設計に影響しない。** セッションは Google の
リフレッシュトークンではなく、自前の署名付き Cookie（`src/session.ts`）で保持するため。Google を
使うのは初回ログインの本人確認だけである（Testing の間の「リフレッシュトークンが 7 日で失効」も、
この理由で影響していなかった）。

### 4.2 開発（`ojos-game-forge-dev`）

<https://console.cloud.google.com/auth/overview?project=ojos-game-forge-dev>

| 項目 | 値 | 理由 |
|---|---|---|
| 対象（Audience） | **内部**（Internal） | ローカル開発で使うのは `ojos.jp` のアカウントだけ。内部なら公開ステータスもブランド確認も無く、`localtest.me` を所有証明する必要も無い |
| スコープ | `openid` / `.../auth/userinfo.email` / `.../auth/userinfo.profile` | 本番と同じにする。違うと、手元で通ったログインが本番で通る保証にならない |
| ロゴ | **登録しない** | 開発用の同意画面をブランド確認に出す理由が無い |

**内部なので、ローカルでログインできるのは Workspace `ojos.jp` のアカウントだけである。** それ以外の
Google アカウントは同意画面で弾かれる（`docs/local-dev.md` の「ログインを試す」）。

### 4.3 `ojos.jp` の所有証明（Search Console）

**本番の承認済みドメイン `ojos.jp` は、Search Console で所有を証明してある**（2026-09-14）。証明は
`ojos.jp` の DNS に置いた `google-site-verification=...` の TXT レコードで行っている。

- **このレコードは terraform の外にある。** `ojos.jp` のゾーンはさくら側（ネームサーバは dns.ne.jp）で、
  terraform が持つのは委譲した `game-forge.ojos.jp` の Route53 ゾーンだけである（`terraform/dns.tf`）。
  さくら側は DNS の API を持たない
- **消すと所有証明が外れる。** 承認済みドメインの要件を満たさなくなり、ブランド確認と本番の同意画面に
  影響しうる。`ojos.jp` のゾーンを整理するときに消さないこと
- 値そのものはこの文書に書かない。Search Console の「所有権の確認」の画面で確かめる

---

## 5. OAuth クライアント（手作業）

同意画面と同じ画面の左メニュー「クライアント」→「クライアントを作成」。**本番と開発で 1 つずつ、
それぞれのプロジェクトに作る。**

| 項目 | 本番 | 開発 |
|---|---|---|
| プロジェクト | `ojos-game-forge` | `ojos-game-forge-dev` |
| アプリケーションの種類 | ウェブ アプリケーション | ウェブ アプリケーション |
| 名前 | `game-forge-prod` | `game-forge-dev` |
| 承認済みのリダイレクト URI | 5.1 の 2 本 | 5.2 の 2 本 |
| 承認済みの JavaScript 生成元 | 空 | 空 |

**リダイレクト URI はポートまで含めて完全一致で照合される。** 本番は 443 番（ポート表記なし）、
ローカルは `:8787` 付きになる。`src/auth/google.ts` の `redirectUri` はリクエストの `Host` から
組み立てるため、コードにホスト名を持たない。登録した URI と実際のホストが食い違うと
`redirect_uri_mismatch` で落ちる。**ホストごとに登録が要る**（app 用の登録で admin は代用できない）。

**JavaScript 生成元は要らない。** 認可コードの交換は Workers 側のサーバ処理で行い、ブラウザから
直接 Google のトークンエンドポイントを叩かないため。

**サンドボックス側（`sandbox.game-forge.ojos.jp`）はどちらにも登録しない。** あちらは cookie も
認証も持たない（仕様書 7.2）。

### 5.1 本番のリダイレクト URI（`game-forge-prod`）

<https://console.cloud.google.com/auth/clients?project=ojos-game-forge>

| 項目 | 値 |
|---|---|
| 承認済みのリダイレクト URI（app） | `https://app.game-forge.ojos.jp/auth/google/callback`（#89） |
| 承認済みのリダイレクト URI（admin） | `https://admin.game-forge.ojos.jp/auth/google/callback`（#356。`docs/admin-host.md`） |

**本番のクライアントに置くのは、この 2 本だけである**（2026-09-14 から）。

**ホストが `app.` 付きなのは DNS の制約による**（仕様書 1.2.11 / `docs/pages-deploy.md`）。
`game-forge.ojos.jp` は Route53 ホストゾーンの apex で CNAME を張れない。

> **注記（#479）。旧記述**——5 章は 1 つのクライアント `game-forge-local` にローカル用の URI
> （`https://game-forge.localtest.me:8787/auth/google/callback`）を登録し、本番の URI は「**別クライアントを
> 作らず、このクライアントへ URI を 1 本追加する。**」（Testing のまま運用する以上、テストユーザーの一覧を
> 1 か所に保つため）としていた。表には「承認済みのリダイレクト URI（既存・維持）」としてローカル用の URI があり、
> 「**既存のローカル用 URI は消さないこと。** 消すと手元の開発でログインできなくなる。」とあった。
> また「**`localtest.me` は所有ドメインではないが、Testing では登録できた**…In production へ切り替えるときに…
> 登録が維持できない可能性がある。その場合は `game-forge.ojos.jp` のサブドメインを 127.0.0.1 へ向けて使う」
> とあった。2026-09-14 に本番環境へ切り替えたとき、実際に `localtest.me` を本番の承認済みドメインから外す
> 必要があり、サブドメインへの変更ではなくプロジェクトを分ける形で解いた（1.1）。ローカル用の URI は
> 開発用のクライアント（5.2）へ移し、本番のクライアントからは消した。

### 5.2 開発のリダイレクト URI（`game-forge-dev`）

<https://console.cloud.google.com/auth/clients?project=ojos-game-forge-dev>

| 項目 | 値 |
|---|---|
| 承認済みのリダイレクト URI（app） | `https://game-forge.localtest.me:8787/auth/google/callback` |
| 承認済みのリダイレクト URI（admin） | `https://admin.game-forge.localtest.me:8787/auth/google/callback` |

ローカルの起動は 8787 番（`docs/local-dev.md` 3 章）で、ホストは `wrangler.toml` の `APP_HOST` /
`ADMIN_HOST`。`:8787` を省くと、手元のコールバックが `redirect_uri_mismatch` で弾かれる。
`PORT` を変えて起動するなら、そのポートの URI も足す。

**開発用のクライアントに本番の URI を足さない。** 足しても本番の Pages が読むのは本番のクライアントの
値なので効かず、どちらのクライアントがどこで使われているかが読めなくなる。

---

## 6. 発行した値の扱い

`client_id` と `client_secret` は Console にしか存在しない。**リポジトリには置かない。**

- **開発用のクライアント（`game-forge-dev`）の値は `.dev.vars` に置く**（`.gitignore` で追跡除外、
  `scripts/acceptance.sh` が除外されていることを毎回検査する）。**手元の `.dev.vars` に本番のクライアントの
  値を入れない**——本番のクライアントにはローカル用の URI が無いので、`redirect_uri_mismatch` で落ちる
- 共有する雛形は `.dev.vars.example`（キー名だけ。値を書くと acceptance が落ちる）
- 本番のクライアント（`game-forge-prod`）の値は Cloudflare Pages の secret に置く（`docs/pages-deploy.md`）

`client_id` は `<プロジェクト番号>-<ランダム>.apps.googleusercontent.com` の形式になる。
**先頭のプロジェクト番号が、正しいプロジェクトで発行した確認になる。** 本番は `859544169721`、
開発は `558074593204`（`terraform -chdir=terraform output gcp_project_number` と
`terraform -chdir=terraform output gcp_dev_project_number` で読める）。

---

## 7. 確認方法

宣言側（プロジェクト）は機械判定できる。

```bash
gcloud projects describe ojos-game-forge --format="value(projectId,projectNumber,lifecycleState)"
# => ojos-game-forge	859544169721	ACTIVE
gcloud projects describe ojos-game-forge-dev --format="value(projectId,projectNumber,lifecycleState)"
# => ojos-game-forge-dev	558074593204	ACTIVE

terraform -chdir=terraform plan -detailed-exitcode   # 終了コード 0（差分なし）であること
terraform -chdir=terraform state show google_project.game_forge_dev
# => project_id = "ojos-game-forge-dev" / number = "558074593204"
```

開発用プロジェクトの請求先アカウントの紐付けは 3.3 の手順で確かめる。

同意画面と OAuth クライアントは API から列挙できない（1 章）。**Console での目視が唯一の確認手段**
であり、`scripts/acceptance-remote.sh` に検査を置けない。宣言と実状態の乖離を機械照合できない
範囲がここに残ることを、承知の上で受け入れている。`ojos.jp` の TXT レコード（4.3）も、Search Console の
「所有権の確認」で目視する。

実効的な検査は実機ログインになる。本番は `app.game-forge.ojos.jp` と `admin.game-forge.ojos.jp` で、
開発は `docs/local-dev.md` の「ログインを試す」で確かめる。ログインが通ればこの章の設定は正しく、
通らなければどこかが違う、という形でしか判定できない。
