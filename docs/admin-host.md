# 運営の管理画面（admin ホスト）の配備と運用

- 位置づけ: 仕様 **2.4（運営の管理画面）** を実際に立てるための手順書。**手順であって、
  実行の記録ではない。** 配備は外部状態の変更なので、行った時点で結果を本文書の
  「実施の記録」へ残すこと。
- 対象: **`admin.game-forge.ojos.jp`**（3 つ目のホスト）。
- 正本は仕様 2.4 である。**ここへ仕様を書き写さない**——この文書が持つのは
  「どの順で何を叩くか」と「機構で代替できない手作業」だけである。
- 一般的な Pages の配備（プロジェクト・D1・R2・シークレット・自動配備）は
  [pages-deploy.md](pages-deploy.md) にある。**この文書はその差分だけを扱う。**

---

## 何が立つのか

**`admin.game-forge.ojos.jp` が `app` と同じ Pages プロジェクトを指し、`src/index.ts` が
`Host` ヘッダで 3 つ目として振り分ける。** `users.is_admin = 1` の利用者だけが入れ、
**権限が無い要求は 404**（2.4.2。403 は画面の存在を教える）。

| 要素 | 値 / 置き場 |
|---|---|
| ホスト名 | `admin.game-forge.ojos.jp`（`wrangler.toml` の `ADMIN_HOST`。3 環境すべて） |
| DNS | `terraform/dns.tf` の `aws_route53_record.admin`（CNAME → `game-forge.pages.dev`） |
| 外部層の検査 | `terraform/outputs.tf` の `admin_host` → `scripts/acceptance-remote.sh`（CNAME の実在と `wrangler.toml` との一致） |
| ローカル HTTPS | `scripts/dev-certs.sh` の SAN に入っている（**3 ホストぶん**） |
| カスタムドメイン | Cloudflare API（`wrangler` にコマンドが無い。下記） |
| 権限の列 | `users.is_admin`（`migrations/0025_users_is_admin.sql`。既定 0） |
| 操作の履歴 | `admin_actions`（`migrations/0026_admin_actions.sql`。**M10-3 / #361**。追記のみ） |
| 振り分け | `src/index.ts` |
| 経路表 | `src/admin/routes.ts`（**`src/app.ts` とは別**） |
| 認可 | `src/admin/guard.ts` |
| 画面（3 枚） | `src/admin/review.ts`（`/` 審査キュー）/ `src/admin/users.ts`（`/users`）/ `src/admin/history.ts`（`/actions`） |
| 書き込みの口（2 本） | `POST /api/review`・`POST /api/ban`（**操作と履歴を 1 つの batch で書く**。`src/admin/actions.ts`） |
| 見た目 | `public/assets/app.css` の上に `public/assets/admin.css` を重ねる（`src/admin/shell.ts`） |

---

## 守る経路の境界

**admin ホストで未ログインのまま通すのは OAuth の 3 つだけ。ほかはすべて 404。**

| 要求 | 未ログイン | `is_admin = 0` | `is_admin = 1` |
|---|---|---|---|
| `GET /auth/google/start` | **通す**（Google へ 303） | 通す | 通す |
| `GET /auth/google/callback` | **通す**（セッションを発行） | 通す | 通す |
| `POST /auth/logout` | **通す**（cookie を消す） | 通す | 通す |
| `GET /`（審査キュー） | 404 | 404 | 200 |
| `GET /users`（利用者と BAN） | 404 | 404 | 200 |
| `GET /actions`（操作の履歴） | 404 | 404 | 200 |
| `POST /api/review`・`POST /api/ban` | 404 | 404 | 303（一覧へ戻す） |
| **上記以外のすべて**（`POST /` や `GET /auth/logout` を含む） | 404 | 404 | 経路表が決める |

**M10-3（#361）が足した 5 本は、`ADMIN_OPEN_ROUTES` へ 1 行も足さずに守られている。**
既定が「閉」なので、**何もしなければ守られる**——`test/admin-guard.test.ts` が経路表を
歩いて、開いていない経路すべてが未ログインで 404 になることを確かめる（一覧を書き写して
いないので、次に足す人も同じ検査に乗る）。

**開いているのは「パス」ではなく「メソッドとパスの組」である。** 判定は経路表を引く
**手前**（`handleAdminRequest`）で掛かる。**#359 のレビューで直した点で、それまでは
破れていた**——`dispatch` はハンドラを呼ぶ前にメソッドを照合して 405 と `Allow` を
返すため、経路ごとに包む形では**未ログインの `POST /` が
`405 + Allow: GET, HEAD` を返していた。405 は 403 と同じものを漏らす**
（「そこに経路がある」）。

**いまは既定が「閉」である。** `ADMIN_OPEN_ROUTES` に無い要求は、**経路表に在るか
どうかに関わらず** 404 になる。M10-3 が経路を足しても、何もしなければ守られる。

**405 が消えたわけではない。** 権限のある管理者が `POST /` を叩けば 405 が返る
——**通してよい相手には正しい HTTP の意味を返す。** 隠すのは「入れない相手から見た
経路の存在」だけである。

**なぜ OAuth を通すのか。** そこまで 404 にすると**ログインへ到達できない。** セッション
cookie は `__Host-` 接頭辞で `Domain` 属性を持てないため（7.2 必須要件 2）、**app ホストの
セッションは admin ホストへ届かない。** admin 側で独立にログインする以外の道が無く、
その入口を閉じると誰も入れない画面になる。

**運営が覚えておく URL は 1 本ある。**

```
https://admin.game-forge.ojos.jp/auth/google/start
```

**`https://admin.game-forge.ojos.jp/` を未ログインで開くと 404 である**（仕様どおり）。
**404 なので「ログインしてください」とは出ない。** 上の URL をブックマークすること。

**引き受けた代償。** admin ホストに OAuth の口があることは外から分かる（`/auth/google/start`
が Google へ 303 を返す）。隠すには入口も 404 にするしかなく、それは画面ごと使えなくする
ことである。**漏れるのは「ログインの口がある」ことまで**で、画面の綴りも、管理者が誰かも、
機能が何かも漏れない。境界の正本は `src/admin/routes.ts` の `ADMIN_OPEN_ROUTES` で、
`test/admin-guard.test.ts` が経路表を歩いて 4 方向から機械照合する（開いていない要求が
404 / 開いている要求が登録されている / 開いている要求が通る / **メソッド違いが 405 を
漏らさない**）。

---

## 配備の順序

**手作業 2 つが先である。** どちらも機構で代替できない。

```
① OAuth のリダイレクト URI を登録（Google Cloud Console。利用者）
② Route53 の CNAME を apply（terraform。利用者の端末）
③ Pages のカスタムドメインを登録（Cloudflare API。利用者の端末）
④ Pages を配備（main へマージ → GitHub Actions。統合担当）
⑤ 本番 D1 へ 0025 を適用（利用者の端末）
⑥ is_admin の最初の 1 人を立てる（利用者の端末）
⑦ 本番で開いて確認
```

**②③ は順序を入れ替えてよい**が、**片方だけでは `active` にならない**（証明書は DNS が
引けてから発行される）。**⑤ は ④ より先でもよい**（列を足すだけで、既存の振る舞いを
変えない）。**⑥ は ⑤ の後**でなければならない（列が無い表は UPDATE できない）。

**④ より前に ①〜③ を済ませておくと、配備の直後に ⑦ まで確かめられる。**

### ① OAuth のリダイレクト URI（Google Cloud Console。**利用者の手作業**）

**これが無いとログインできない。** OAuth クライアントは API から操作できないため、
ここだけは手作業である（`docs/gcp-oauth-setup.md` 1 章 / `docs/pages-deploy.md`）。

<https://console.cloud.google.com/auth/clients?project=ojos-game-forge>

既存のクライアントの「承認済みのリダイレクト URI」へ次を**追加**する
（**既存の URI を消さないこと。** app 用とローカル用がある）。

```
https://admin.game-forge.ojos.jp/auth/google/callback
```

- **app 用の登録では代用できない。** `redirect_uri` は要求のホストから組み立てる
  （`src/auth/google.ts` の `redirectUri`）。ホストごとに登録が要る。
- **登録が無いと、失敗するのは同意画面である。** ログインの開始（303）は成功し、
  Google 側が `redirect_uri_mismatch` で止まる。**アプリのログには何も出ない。**
- **テストユーザーの登録は要らない**（既に登録済みの運営のアカウントで入るため）。
  同意画面は Testing のまま運用する（仕様 8.1）。

### ② Route53 の CNAME（terraform。**宣言はこのリポジトリが持つ**）

**ダッシュボードや `aws` コマンドで手で作らないこと**（確定17 が Route53 へ委譲した
目的がそもそもこれである）。

```bash
export AWS_PROFILE=game-forge-prod
set -a; source scripts/load-project-env.sh; set +a   # CLOUDFLARE_API_TOKEN が要る
terraform -chdir=terraform plan     # 差分は admin の CNAME 1 本だけであること
terraform -chdir=terraform apply
```

| 名前 | 型 | 値 | TTL |
|---|---|---|---|
| `admin.game-forge.ojos.jp` | CNAME | `game-forge.pages.dev` | 300 |

**`terraform` を叩くときは `CLOUDFLARE_API_TOKEN` を載せること。** 載せ忘れると R2 の
リソースの読み戻しが 9106 で落ち、**プロバイダの不具合に見える**（`docs/handoff.md` 3 章）。

**state は primary の作業ツリーにしかない。** worktree から回すと 26 件の検査が
「terraform output から取得できません」で落ちる（乖離ではない）。`ACCEPTANCE_TF_DIR` で
primary の宣言を指すこと。

### ③ Pages のカスタムドメイン（Cloudflare API。**`wrangler` にコマンドが無い**）

```bash
set -a; source scripts/load-project-env.sh; set +a
API="https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/pages/projects/game-forge/domains"

curl -s -X POST "$API" \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  -H "Content-Type: application/json" \
  --data '{"name":"admin.game-forge.ojos.jp"}'

curl -s "$API" -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN"   # 状態の確認
```

追加した直後の状態は `initializing`（DNS 検証待ち）。CNAME が引けるようになると `active`
へ変わり、証明書が発行される。**`app` / `sandbox` のときは登録から `active` まで約 7 分
かかった**（`docs/pages-deploy.md` の実施の記録）。**`active` になるまで待つこと**
——`initializing` のまま開くと TLS で失敗し、「配備が壊れている」に見える。

必要な権限は `Account / Cloudflare Pages: Edit`（`docs/pages-deploy.md` の表と同じ。
**admin のために増やす権限は無い**）。

### ④ Pages の配備

**`main` へマージすると GitHub Actions が本番へ配備する**（#95。`docs/pages-deploy.md` の
「自動配備」）。**admin のために特別なことは無い**——同じ Pages プロジェクト・同じ
`functions/[[path]].ts` で、増えたのは `ADMIN_HOST` の `[vars]` と経路表 1 つである。

### ⑤ 本番 D1 へ 0025 を適用（**手作業。デプロイでは走らない**）

```bash
npx wrangler d1 migrations list DB --remote --env production   # 0024 まで適用済みを確認
npx wrangler d1 migrations apply DB --remote --env production
```

**`origin/main` を checkout したツリーから打つこと**（古いブランチで打つと未適用を
見落とす。`docs/handoff.md` 1 章）。**忘れると管理画面は 404 のまま**になる
——`select is_admin` が「no such column」で落ち、認可は fail-closed で拒否へ倒れる
（`src/admin/guard.ts`）。**その形は正しく安全だが、原因はログにしか出ない。**

### ⑥ `is_admin` の最初の 1 人（**利用者の手作業**）

**画面から管理者を増やす経路は作らない**（2.4.2。増やせる画面は、乗っ取られたときに
権限を配る道具になる）。**BAN（`banned_at`）と運営フラグ（`is_operator`）と同じ運用**で、
前例が 2 つある（`docs/operator-account.md`）。

```bash
# 1. 対象のアカウントで一度ログインして users 行を作る（app ホストでよい）
#    → https://app.game-forge.ojos.jp/auth/google/start
# 2. id を確かめる。**email で引いて id を目で確認する**（UPDATE を id で打つため）
npx wrangler d1 execute DB --remote --env production \
  --command "select id, email, is_operator, is_admin from users where email = '<運営のアドレス>';"
# 3. 立てる
npx wrangler d1 execute DB --remote --env production \
  --command "update users set is_admin = 1 where id = '<上で確かめた id>';"
# 4. 立ったことを確かめる（**1 行だけであること**）
npx wrangler d1 execute DB --remote --env production \
  --command "select count(*) as admins from users where is_admin = 1;"
```

- **`where email = ...` で UPDATE しない。** `email` は一意ではなく（0001 の
  `google_sub` の注記。同一性の判定に使わない値である）、**複数行に権限を配りうる。**
  id を目で確かめてから id で打つ。
- **`is_operator` は立てない**（別の列である。2.4.2 / #334）。運営名義で作品を出すことと、
  他人のアカウントを止められることは別の集合である。
- **`is_admin = 'yes'` や `= 2` は CHECK が弾く**（0025）。
- **外し方は `is_admin = 0` を打つだけ**（戻せる操作である）。

### ⑦ 本番で開いて確認

```bash
# 未ログインは 404（仕様どおり。**これが 200 なら認可が効いていない**）
curl -si https://admin.game-forge.ojos.jp/ | head -1

# 未知のホストの 404 と区別できること（本文が `not found` で、`unknown host` ではない）
curl -s https://admin.game-forge.ojos.jp/ | head -5

# ログインの入口が Google へ送ること
curl -si https://admin.game-forge.ojos.jp/auth/google/start | grep -i '^location:'

# **メソッド違いが 405 を漏らさないこと**（#359 で直した点。`Allow` が出たら回帰）
curl -s -o /dev/null -w '%{http_code}\n' -X POST https://admin.game-forge.ojos.jp/
curl -si -X POST https://admin.game-forge.ojos.jp/ | grep -i '^allow:' && echo '↑ 出てはいけない'
```

そのうえで**ブラウザで `/auth/google/start` を開き、管理画面が出ることを見る。**
出たら `docs/handoff.md` へ書き戻す（#356 の acceptance 最終項）。

**確認の観点。**

- `<h1>審査キュー</h1>` が出る（`is_admin = 1` が効いている。**M10-2 の時点では
  `<h1>管理</h1>` だった**——M10-3 がトップを審査キューにした）
- ヘッダが「Game Forge 管理」で、**利用者向けのナビ（作品をさがす / つくる）が無い**
- **別のアカウント（`is_admin = 0`）で開くと 404** になる
- `app.game-forge.ojos.jp` へログインしても **admin は 404 のまま**である
  （cookie が `__Host-` で `Domain` を持てないことの現れ。**2 回ログインするのが正しい**）

---

## M10-3（#361）を出すときに増える手順

**画面と口が増えただけで、ホスト側の手作業（①〜③）は 1 つも増えない。** 増えるのは
**マイグレーション 1 本の適用**と、**戻せる操作を 1 往復ずつ通す確認**である。

```
Ⓐ 本番 D1 へ 0026 を適用（利用者の端末。**マージの前に**）
Ⓑ main へマージ → Pages が配備される
Ⓒ 審査の往復を 1 件通す（queued → cleared → queued）
Ⓓ BAN の往復を 1 件通す（BAN → 解除）
Ⓔ 履歴（`/actions`）に 4 行積まれていることを見る
```

**Ⓐ はマージより前である。** `0025` は「④ より先でもよい」（列を足すだけで既存の
振る舞いを変えない）だったが、**こちらは違う**——マージすると新しい画面が先に本番へ
出るので、**適用までの間、押した操作と `/actions` が `admin_actions` 不在で失敗する。**
壊れ方は安全側だが（下記）、**運営から見れば「出たのに使えない画面」である。**

### Ⓐ 本番 D1 へ 0026 を適用（**手作業。デプロイでは走らない**）

```bash
npx wrangler d1 migrations list DB --remote --env production   # 0025 まで適用済みを確認
npx wrangler d1 migrations apply DB --remote --env production
```

**`origin/main` を checkout したツリーから打つこと**（古いブランチで打つと未適用を
見落とす。`docs/handoff.md` 1 章）。

**忘れるとどうなるか。** `/` と `/users` は**開ける**（読むのは `games` と `users` で、
どちらも既存の表である）。**落ちるのは押したときと `/actions` を開いたときだけ**で、
`admin_actions` が「no such table」になる。

- 押したとき: **batch ごと落ちるので、状態も動かない**（`src/admin/actions.ts` の
  `runWithHistory` が例外を捕まえ、「書き込めませんでした」を返す）。**履歴の無い
  操作は入らない**——適用漏れが「記録だけ落ちる」形にはならない
- `/actions`: 500 になる（表が無い）

### Ⓒ〜Ⓓ 戻せる操作を 1 往復ずつ通す

**本番の実データで往復させる。** 対象が無ければ、**確認のためだけに通報を作らない**
——`queued` の作品が 1 本も無いときは、`docs/handoff.md` へ「対象が無いので未確認」と
書いて残すほうがよい（**作れば作品の露出が実際に止まる**）。

BAN は**運営自身では試せない**（自分自身には口が無い。`src/admin/users.ts`）。
**別のアカウントで 1 往復**させ、**解除まで必ず戻すこと。**

### Ⓔ 履歴を見る

`https://admin.game-forge.ojos.jp/actions` に**4 行**（審査 2 行・BAN 2 行）が並び、
**それぞれに理由が付いている**こと。**取り消しも 1 行として積まれる**（前の行は
書き換わらない。2.4.4）。

---

## #367（改名のあとに通報が付いた作品）を出すときに増える手順

> **#394 で節の条件と文言が変わった**（下記「既知の穴（#394 で塞いだ）」）。以下の手順は
> **いまの見出し・札・定数名で書いてある**（#367 の時点では「問題なしとしたあと、改名されて
> 通報が付いた作品」／「改名後に通報あり」／`REVIEW_RENAMED_SQL` だった）。

**審査キュー（`/`）に節が 1 つ増える。** `queued` と `cleared` の間に
**「問題なしとしたあとに通報が付いた作品」** を置き、行の頭に
**「問題なしのあとに通報あり」** の札と**最終改名の時刻**を出す。**操作も口も経路も増えない**
——行が持つのは `cleared` の行と同じ「審査待ちへ戻す」だけで、`ADMIN_OPEN_ROUTES` にも
1 行も足していない（権限が無ければ `/` は 404 のまま）。

**条件は `src/reports.ts` の `REVIEW_REPORTED_AFTER_CLEAR_SQL` 1 か所にある。** 画面はそれを import し、
`scripts/report-queue.sh` はソースから取り出す。**片方だけを直す手段が無い**ので、
条件を変えるときは `src/reports.ts` だけを直せば両方が追随する。

```
Ⓕ 本番 D1 へ 0027 を適用（利用者の端末。**マージの前に**。#366 の改名も同じ表を使う）
Ⓖ main へマージ → Pages が配備される
Ⓗ 画面と report-queue.sh が同じ作品を出すことを見る
```

### Ⓕ 0027 の適用（**マージの前に**）

```bash
npx wrangler d1 migrations list DB --remote --env production   # 0027 が未適用なら出る
npx wrangler d1 migrations apply DB --remote --env production
```

**`origin/main` を checkout したツリーから打つこと**（上記 ⑤ / Ⓐ と同じ理由）。

**忘れるとどうなるか。** 「問題なしとしたあとに通報が付いた作品」の節が最終改名の時刻のために
`title_changes` を読むので、3 節の batch が「no such table」で落ち、履歴の表に依る 2 節
（その節と「問題なしとした作品」。#394 以降はどちらも `admin_actions` も読む）が読めなくなる。**画面ごとは落とさない**——**審査待ちの節は出る**。
落ちた 2 節は**件数の代わりに「読み込めませんでした」**と出し（0 件と区別する）、
画面の上に**「一覧の一部を読み込めませんでした。下の一覧は不完全です。」**を出し、
**画面のステータスは 500** になる（成功したかのようにログへ残さない。
`src/admin/review.ts` の `readSections`）。**押した直後なら「操作しました」の知らせも
並んで出る**——操作と履歴は既にコミットされているので、それは事実である
（押し直さないこと。`/actions` に行が積まれている）。

**3 つの節は 1 つの `D1.batch` で読む**（同じ時点の状態から描くため。PR #392 の
Copilot レビュー）。`0027` の適用漏れで batch が落ちたときだけ、`title_changes` に依らない
審査待ちの節を読み直す。

### Ⓗ 画面と `report-queue.sh` の突き合わせ

```bash
bash scripts/report-queue.sh --remote --format json | jq -r '.rows[].game_id' | sort
```

**2 つの節がどちらも 50 件以内のとき、画面の「審査待ち」と「問題なしとしたあとに通報が付いた
作品」の 2 節に並ぶ id と、同じ集合になる**こと。**ずれてよいのは次の 3 つだけである**。

- **節が 50 件を超えたとき**は、画面に出るのが各節の**公開の新しい順の 50 件**だけになる
  （`ADMIN_LIST_LIMIT`。スクリプトは全件を返す）。**このときは「画面の id がすべて
  スクリプトの出力に含まれる」ことだけを見る**（包含であって一致ではない。PR #392 の
  Copilot レビュー）。見出しの件数が `（50 件）` なら上限に達している
- **取り下げた作品**はスクリプトにだけ出る（画面は公開中だけを並べる。PR #364 の判断）
- **通報の行が 1 件も無い `queued`** は画面にだけ出る（スクリプトは `reports` と結合する。
  通常は起こらない——`queued` は通報でしか入らない）

（後ろの 2 つは #367 より前からの差である。）

**手元では実際に揃うことを確かめた**（2026-09-12。同じ使い捨ての D1 に 6 本を仕込み、
スクリプトの JSON と画面の 2 節がどちらも `q1 rn1 rn2` だった。改名が 2 回ある作品・
改名前の古い通報を持つ作品・同じ秒の通報を含む）。

### 既知の穴（#394 で塞いだ）: もう一度「問題なし」にしても、この節から消えなかった

**#367 の時点では**、`renameGame` が `cleared` を `NULL` へ戻すので、改名のあとの通報は
**まず `queued` へ入り**（閾値は 1 人）、運営がそれを見て「問題なし」にすると、**改名以降の
通報が残っているので条件に当たり、改名の節へ戻ってきた**——次に作者が改名するまで
出続けた（`recordReport` → `setReviewState` → `renameGame` → `recordReport` →
`setReviewState` の順で、最後の 1 手で当たり始める）。

**#394 で条件そのものを直した**（スクリプトと画面は同じ定数を借りているので、同時に直る）。
**基準を「最後の改名の時刻」から「最後に問題なし（`cleared`）にした時刻」へ変え、改名に
絞らず一般化した**——`cleared` は終端なので、そのあとに付いた通報は改名が無くてもどこにも
出ない（理由の全文は `src/reports.ts` の `REVIEW_REPORTED_AFTER_CLEAR_SQL`）。

- **節の見出しは「問題なしとしたあとに通報が付いた作品」、札は「問題なしのあとに通報あり」**
  になった。最終改名の時刻は、条件ではなく手がかりとして引き続き出す
- **見終えたら「審査待ちへ戻す」→「問題なしにする」で節から外れる。** 問題なしにした時刻
  （`admin_actions` の `review-cleared`）が新しい基準になる。**操作は増やしていない**
- **履歴の無い `cleared`（#361 より前に端末で問題なしにした作品）は、通報があればこの節に
  出る。** いつ問題なしにしたかが分からないので、見落とす側へ倒さない。**上の往復を 1 度
  通せば外れる**（2.4.4 の記録の欠けもそこで埋まる）。**配備の直後に見覚えの無い作品が
  並んでいたら、この扱いである**
- **`0029`（`admin_actions` の索引）を本番 D1 へ適用する**（上記 Ⓕ と同じ手順・同じツリーから）。
  **忘れても画面は壊れない**が、読み取りが `cleared` の作品数の 2 乗になる（1000 本で
  1 回約 165 万行。実測は `migrations/0029_admin_actions_target_idx.sql` の冒頭）
- **手元で画面とスクリプトが揃うことを確かめた**（2026-09-12。上記 Ⓗ と同じ突き合わせを、
  `scripts/report-selftest.sh` の 11 節と同じ 9 本を仕込んだ使い捨ての D1 で行った）

### 既知の穴（#404 で塞いだ）: 作者の改名・説明の変更で、この節の作品が消えていた

**#394 の時点では**、「問題なしとしたあとに通報が付いた作品」の節に出ていた作品を、**作者が
改名するか説明を変えると `NULL` へ戻り、どの節からも消えた**（通報は届いた時点でしかキューへ
上げず、同じ人は同じ作品を 2 度通報できないので、その通報は埋もれた）。

**#404 から、その作品は変更の時点で「審査待ち」の節へ移る**（`cleared` にしたあとの通報が
届いていれば `NULL` ではなく `queued` にする。判定は同じ `REVIEW_REPORTED_AFTER_CLEAR_SQL`）。
**画面の文言・節・スクリプトは変わっていない。**

- **配備の直後から、この節の作品が「審査待ち」へ移ることがある。** 作者が題名や説明を変えた
  作品で、**露出は止まっている**（審査待ちと同じ）。作品ページで確かめて「問題なしにする」
- **`report-queue.sh` の出力の集合は変わらない**（行の `review_state` が `cleared` から `queued` に
  なるだけ）。上記 Ⓗ の突き合わせはそのまま使える
- **#361 より前に端末で問題なしにした作品**は、見終えた通報しか無くても、作者が変更すると
  審査待ちへ入る（D1 の上で区別できない。#394 と同じ扱い）。**この節に並んだものを 1 度
  往復させておけば起きない**
- **マイグレーションは無い**（Pages の配備だけで効く。オーケストレータの配り直しも要らない）
- **手元で画面とスクリプトが揃うことを確かめた**（2026-09-13。使い捨ての D1 に 7 本を仕込み、
  `wrangler pages dev` へ実際に改名と説明の変更を POST した前後で、スクリプトの JSON と画面の
  2 節が同じ 5 本だった。main のコードでは同じ操作で 3 本がどちらからも消えた）

### 幅 390px（残した穴は変わっていない）

**#367 でも `scripts/check-page-width.sh` に admin は乗っていない**（上記「残した穴」の
3 つは 1 つも解いていない。`scripts/` はこのレーンの所有外である）。**画面に増えたのは
札 1 つと時刻 1 つ**で、どちらも `public/assets/admin.css` の既存の行の枠の中にある。

**代わりに手で 1 度測った**（2026-09-12。`scripts/page-width-probe.mjs` を admin ホストの
`/` へ直接向け、`is_admin = 1` の cookie を載せ、改名の節に長い題名の行がある状態で
390 / 768 / 1280 の 3 幅。**3 幅とも 200 で本体を開き**、`innerWidth` と `scrollWidth` が
端末の幅と一致した）。

---

## #405（通報された時点の題名・説明・作者名）を出すときに増える手順

**審査キュー（`/`）の行ごとに、通報ごとの「通報の時点」と「いま」の値が並ぶ。** 題名・説明・
作者名の 3 つで、変わっていれば「変わっています」、通報と同じ秒に変更があれば前後の両方と
「通報と同じ秒に変更がありました」、表示名の履歴を書き始める前の通報では「この時点の作者名の
記録はありません」と出る。**操作・口・経路は増えない**（`ADMIN_OPEN_ROUTES` にも足していない）。

**表示名の変更の履歴（`display_name_changes`）と、書き始めた時刻の 1 行（`display_name_history_start`）
を足す**（`migrations/0030_display_name_changes.sql`）。**`/account` での変更と Google の名前への
追随の両方が、名前が実際に変わったときだけ 1 行積む。**

```
Ⓘ 本番 D1 へ 0030 を適用（利用者の端末。**マージの直前に**）
Ⓙ main へマージ → Pages が配備される
Ⓚ 配備を確かめたら、表示名の履歴の基準の時刻をその時刻へ進める
Ⓛ 画面で 1 件確かめる
```

### Ⓘ 0030 の適用（**マージの直前に**）

```bash
npx wrangler d1 migrations list DB --remote --env production   # 0030 が未適用なら出る
npx wrangler d1 migrations apply DB --remote --env production
npx wrangler d1 execute DB --remote --env production \
  --command "select id, started_at from display_name_history_start;"   # 1 行、適用した時刻
```

**`origin/main` を checkout したツリーから打つこと**（上記 ⑤ / Ⓐ と同じ理由）。

**マージより後にしてはいけない。** CI の配備は未適用のマイグレーションがあると止まる
（`scripts/check-migrations-applied.sh`）が、**止まらずに出た場合はログインが落ちる**
——既存の利用者のログインは、履歴の表が無いと batch ごと失敗する（`src/auth/google.ts` の
`refreshExistingUser`）。

**早すぎてもいけない（直前に当てる理由）。** 適用した時刻が「表示名の履歴を書き始めた時刻」として
記録されるが、**実際に履歴を書くのは新しいコードが配られてから**である。その間に古いコードが名前を
変えると記録されず、**その間に付いた通報では、いまの名前が通報の時点の名前として出てしまう。**
窓を狭くするために直前に当て、Ⓚ で詰める。

### Ⓚ 基準の時刻を、配備を確かめた時刻へ進める

`docs/pages-deploy.md` の「配備ずれの検知」（`production deployment matches main HEAD`）で配備を確かめたら、
**その時刻（UNIX 秒）**へ進める。

```bash
now=$(date +%s)
npx wrangler d1 execute DB --remote --env production \
  --command "update display_name_history_start set started_at = ${now} where id = 1 and started_at < ${now};"
```

**進める向きは「記録がありません」を増やす側だけである**——誤った名前を出す側へは動かない。
打ち忘れても壊れはしないが、Ⓘ から配備までの窓の分だけ上の誤りが残りうる。**戻す（小さくする）
コマンドは打たないこと。**

### Ⓛ 画面で確かめる

- 既存の審査待ちの作品の行に、通報ごとの塊が出ていること。**配備より前の通報では、作者名が
  「この時点の作者名の記録はありません」になっている**（正しい。いまの名前を当時の名前として出さない）
- 題名と説明は、配備より前の通報でも「通報の時点」が出ていること（履歴は 0027 / 0028 からある）
- **確認のためだけに通報や名前の変更を作らない**（Ⓒ〜Ⓓ と同じ理由）

**忘れるとどうなるか（0030 の適用漏れ）。** 画面は落とさない——一覧の 3 節は出し、行ごとに
「通報の時点の題名・説明・作者名を読み込めませんでした」と書いて **500** を返す（`src/admin/review.ts` の
`readQueue`）。**ログインと名前の変更は失敗する**（上記）。

### 運営が D1 を直接 UPDATE して表示名を直すとき（5.9）

**同じコマンドで履歴も 1 行積むこと。** 積まないと、その作者に付いた通報の時点の名前の復元を誤らせる
（変更が 1 件も記録されていない作者では、直した後の名前が通報の時点の名前として出る）。

```bash
id='<利用者の id>'; name='<直した名前>'   # 名前に ' を含めるなら '' と重ねる
npx wrangler d1 execute DB --remote --env production --command "
insert into display_name_changes (id, user_id, old_display_name, new_display_name, changed_at)
  select lower(hex(randomblob(16))), id, display_name, '${name}', cast(strftime('%s', 'now') as integer)
    from users where id = '${id}' and display_name <> '${name}';
update users set display_name = '${name}', display_name_set_at = cast(strftime('%s', 'now') as integer)
 where id = '${id}';"
```

**アプリの経路と違い、2 文が 1 つのトランザクションになる保証は無い。** 打ったあとに
`select * from display_name_changes where user_id = '<id>' order by rowid desc limit 1` で行を確かめること。

### 幅 390px

**`scripts/check-page-width.sh` に admin は乗っていない**（上記「残した穴」は変わっていない）。
増えた塊は行の枠の中に積み、**利用者が書いた値は `overflow-wrap: anywhere` と `white-space: pre-wrap`**
で折り返す（`public/assets/admin.css`）。

---

## 壊れうる点

| 症状 | いちばんありそうな原因 |
|---|---|
| TLS で繋がらない | ③ のカスタムドメインが `initializing` のまま（`active` を待つ） |
| `unknown host` の 404 が返る | `ADMIN_HOST` の宣言漏れ、または綴り違い。**`expected.admin` に何が入っているかを読む** |
| 同意画面が `redirect_uri_mismatch` | ① の登録漏れ（**admin のぶんは app と別に要る**） |
| ログインは通るのに `/` が 404 | ⑥ の `is_admin` が立っていない。または ⑤ の適用漏れ |
| ログイン後 `/signup` へ飛んで 404 | その Google アカウントに `users` 行が無い（招待が要る）。**先に app ホストでログインして行を作る** |
| 全ホストが 500 | `ADMIN_HOST` とは無関係（`configuredHost` が未設定を 404 へ倒すため、宣言漏れで 500 にはならない） |
| 管理画面が急に 404 になった | 本番の `is_admin` が失われた（行の作り直し・誤った UPDATE・復元）。**検査は緑のまま通る**（下記「限界」） |
| 押すと「書き込めませんでした」と出る | **`0026` の適用漏れ**（`admin_actions` が無い）。**状態は動いていない**（batch ごと巻き戻る） |
| `/actions` だけ 500 | 同上（`admin_actions` が無い） |
| BAN したのに作品が一覧に出ている | **仕様どおり**（7.3。BAN は露出を止めない）。作品を止めるのは審査キューの操作である |

---

## 限界（機械照合を置けないところ）

**本番の行に `1` が立っていることは、どの検査も見ていない。** `test/schema-admin.test.ts` が
見ているのはテスト用 D1 の**列の形**（型・NOT NULL・既定 0・CHECK）で、
`test/admin-guard.test.ts` が見ているのは**認可の分岐**である。**本番で管理者のフラグが
失われても、検査はすべて緑のまま通る**——D1 の行データに機械照合は置けない
（`docs/operator-account.md` が `is_operator` について書いているのと同じ限界）。

**履歴（`admin_actions`）が追記のみであることも、保証できるのは画面と口までである。**
アプリはこの表へ `insert` しか書かず（`src/admin/actions.ts`。`update` も `delete` も
1 文も持たない）、**操作と履歴は 1 つの batch で入る**ので「履歴の無い操作」は作られない。
**しかし端末からは書き換えられる**——

```bash
# これは通る（止める手段が D1 の側に無い）
npx wrangler d1 execute DB --remote --env production \
  --command "delete from admin_actions;"
```

**その資格情報は、この機構より上位にある。** 同じ資格情報で `users.is_admin` を立てられる
以上（上記 ⑥）、**履歴だけを守っても意味が無い**——管理者を増やしてから画面で操作すれば、
正規の行として積める。**防ぐとすれば置き場を D1 の外へ出すことになり**（追記専用のログ
基盤など）、それは 3.6 / 4.3 の費用の枠組みの外にある。**クローズドβ（2.1）の段では
引き受ける。** 同じ限界は `migrations/0026_admin_actions.sql` の冒頭と
`src/admin/actions.ts` にも書いてある。

**カスタムドメインと OAuth の登録も、見ている範囲が違う。** `terraform plan` が見るのは
Route53 の CNAME だけで、**Pages のカスタムドメインが `active` かどうかは見ていない。**
**OAuth クライアントは API から列挙できない**（仕様 8.1 の「Google 側の登録は API から
列挙できない」）。

**CNAME と `wrangler.toml` の一致だけは機械が見る**（`scripts/acceptance-remote.sh` の
`pages custom domain records match` / `wrangler production hosts match dns`）。
**ただし `terraform/outputs.tf` に出力がある分だけである**——#359 のレビューまで
`admin_host` の出力が無く、**admin の CNAME が無くても宣言とずれていても緑のまま
通っていた。** ホストを増やす人は、**宣言・`wrangler.toml`・出力・検査の 4 つ**を
揃えること。

---

## 幅 390px の検査に admin が乗っていない（残した穴）

**M8-1 の 3 検査のうち、admin が乗っているのは 2 つである。**

| 検査 | admin | 実体 |
|---|---|---|
| 外枠（ヘッダ・フッタ・CSS・viewport） | **乗っている** | `test/admin-page-shell.test.ts` |
| 画面一覧の導出 | **乗っている** | `src/page-paths.ts` の `ssrPagePaths` を admin の経路表へ通す |
| 幅 390px（実ブラウザ） | **乗っていない** | `scripts/check-page-width.sh` は `app` ホストだけを見る |

**乗せるのに要るもの。** `scripts/lib/dev-fixture.sh` は `wrangler.toml` の `APP_HOST` を
1 つだけ読み、`BASE=https://<APP_HOST>:<PORT>` へブラウザを向ける。admin を乗せるには
次の 3 つが要る。

1. `ADMIN_HOST` も読み、`--resolve` を 2 ホストぶん渡す（`*.localtest.me` は公開 DNS が
   127.0.0.1 を返すので、hosts の編集は要らない）
2. 仕込む利用者へ `update users set is_admin = 1` を打つ（**これが無いと 404 しか見られない。**
   `check-page-width.sh` は 404 を通すので、**画面の本体を 1 度も開かないまま緑になる**
   ——#330 が実際に踏んだ形である）
3. admin の画面一覧を受け取る口（`/__dev/pages` に相当するもの）。**admin ホストに
   診断経路は置いていない**ので、ここは設計の判断が要る

**M10-2 の PR で乗せなかった理由は、所有範囲である**（`scripts/` はあのレーンの所有外）。
**代わりに手で 1 度測った**（下記「実施の記録」）。

### M10-3（#361）でも乗せていない。ただし「測る対象」は生まれた

**M10-3 の scope.out が「幅 390px の実ブラウザ検査へ admin を乗せること」を明記して
おり、acceptance も外枠と画面一覧の導出の 2 つしか求めていない**（`scripts/` は
あちらでも所有外である）。**乗せるのは別の issue の仕事として残す。**

**それでも状況は変わった。** M10-3 が**一覧の行と、行ごとの理由の入力とボタン**を
置いた——**admin ホストに、狭い端末で崩れうるものが初めて出来た。** M10-2 の時点の
「いまの管理画面は空で、装飾すべき中身が無い」はもう当てはまらない。

- **admin だけが読む CSS が 1 枚増えた**（`public/assets/admin.css`）。`app.css` の
  トークンの上に重ねる形で、**版面（`body` の `max-width` / `overflow-wrap`）は
  あちらのままである**——狭い端末で崩れない根拠は引き続き `app.css` にある
- **代理検査は乗っている。** `test/admin-page-shell.test.ts` が `input` の `size` /
  `textarea` の `cols` を禁じている（#282 の 2 件目の原因）。**代理検査は本物の
  代わりにならない**——#282 の 2 件目は機械的な代理検査を全部すり抜けた

**乗せるときに要る 3 つは変わっていない**（上記 1〜3）。**とくに 2 を忘れないこと。**
`is_admin = 1` を立てずに走らせると、**ブラウザが見るのは 404 だけ**である
——`check-page-width.sh` は 404 を通すので、**画面の本体を 1 度も開かないまま緑になる**
（#330 が実際に踏んだ形）。**いま admin には「開けば必ず本体が出る」画面が 3 枚あり、
乗せ損ねたときに緑で通ってしまう範囲は、M10-2 の 1 枚から 3 枚へ広がった。**

---

## 実施の記録

（配備した時点で追記する。カスタムドメインが `active` になった時刻、`is_admin` を立てた
アカウント、`terraform plan` が差分なしになったこと、本番で開いて見たものを残す。）

| 項目 | 結果 |
|---|---|
| ① OAuth のリダイレクト URI | **済**（2026-09-12。利用者の手作業） |
| ② Route53 の CNAME | **済**（2026-09-12） |
| ③ カスタムドメイン | **済**（2026-09-12。`active`） |
| ④ Pages の配備 | **済**（2026-09-12 / PR #359） |
| ⑤ 0025 の適用 | **済**（2026-09-12） |
| ⑥ `is_admin` の 1 人目 | **済**（2026-09-12。直接 UPDATE） |
| ⑦ 本番での確認 | **済**（2026-09-12。未ログインで `/` が 404、`/auth/google/start` が Google へ 303、利用者のログインも成功。`docs/handoff.md` 1 章に 6 点） |

**M10-3（#361）のぶん**（統合担当が本番で通したら追記する。`docs/handoff.md` への
書き戻しもそちらが行う）。

| 項目 | 結果 |
|---|---|
| Ⓐ 0026 の適用（**マージ前**） | **済**（2026-09-12。`MIGRATIONS_APPLIED` と `sqlite_master` の 2 方向で確認） |
| Ⓑ main へマージ（Pages の配備） | **済**（2026-09-12 / PR #364。`deploy` まで緑。**未ログインで 5 経路とも 404** を curl で確認） |
| Ⓒ 審査の往復（queued → cleared → queued） | 未 |
| Ⓓ BAN の往復（BAN → 解除） | 未 |
| Ⓔ `/actions` に 4 行 | 未 |
