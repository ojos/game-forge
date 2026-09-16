# 退会の後続の処理（`game-forge-cleanup`）の運用手順

退会した利用者の作品を最後まで消す経路（仕様 3.7 / 5.8 / #518 / M15-3。土台は #586 / M15-3a）の、
配備と確認の手順。

**コードの正本は `workers/cleanup/`（Worker `game-forge-cleanup` と DO `WithdrawalHub`）と
`src/withdrawal.ts` / `src/withdrawal-purge.ts`（退会そのものの処理）** で、**宣言の正本は
`workers/cleanup/wrangler.toml`** である。この文書が持つのは、宣言で表せない手順——初回の配備、
権限、確認のしかた、確かめられていないこと——だけである。

**#518 で利用者が押せる口が開いた**（登録情報の「アカウント」→ 確認の画面 → `POST /api/account/withdraw`。
`src/account-withdrawal.ts`）。**この文書の経路は 1 つも変わっていない**——変わったのは、
5 分ごとに起きたときに拾う行が実際に現れるようになったことだけである。

> **旧記述（#586 の時点）。** 「この土台の時点では、利用者が押せる退会の口は無い。口・画面・
> ログインの停止・法務文書は #518 が足す。ここに書いた経路は、口が来るまで何もせずに 5 分ごとに
> 起きて終わる。」

**2026-09-16 の本番の実態。** `game-forge-cleanup` は本番にあり（#586 / PR #588 / `f1d10ae`）、
cron `*/5 * * * *` が **5 本中 1 本目**として登録されている。`wrangler tail` で 07:20:34 UTC の
起動を観測し、**退会が 0 件なので何もせず `Ok` で終えた**。**#518 の本番の確認（acceptance 8。
2026-09-16）は作品 1 本の利用者で通り、押した要求の中で消え切って 30 秒で完了した**ので、
**この文書の経路（5 分ごとのアラームが候補を拾って少しずつ消す）は、本番ではまだ実際に
作品を消していない**（下の「確かめられていないこと」）。画面は #590（PR #591 / `5a2f80e`）で
確認画面と完了画面が読み物の器（42rem・中央）に乗ったが、**経路も口も変わっていない。**

## なぜ 3 つ目の Cloudflare のデプロイ単位が要るのか

**作品の削除は 1 件あたり D1 の 14 文である**（`src/game-deletion.ts`）。Workers Free の D1 は
1 呼び出し 50 クエリなので、**押した要求の中では 2〜3 件しか消せない。** 作品が 60 本ある利用者を
要求の中で消し切ることはできず、途中で落ちれば「どこまで消したか」を知る者もいない。
そこで、**状態を D1 に置き、5 分ごとに起きる Worker が少しずつ消す。**

**`game-forge-likes` に相乗りしない**（#518 の J2）。この Worker は **R2 のバケット全体を消せる**
資格情報を持つ。いいねの Worker は D1 しか持たず、`scripts/check-likes-worker.sh` は「R2 を
持たない」ことを前提に書いてある。相乗りすると、いいねの同期の不具合が成果物を消す事故に化けうる
範囲まで権限が広がる。

**Pages は DO のクラスを自分で持てない**（`docs/likes.md` と同じ事情）。クラスは Worker に置く。

## 構成

| 対象 | 実体 | 持ち主 |
|---|---|---|
| Worker | `game-forge-cleanup`（**公開の入口なし**: `workers_dev = false` / `preview_urls = false` / ルートなし） | `workers/cleanup/wrangler.toml` |
| DO | `WithdrawalHub`（**SQLite 版**。インスタンスは `withdrawal` の 1 個。DO のマイグレーションはタグ `v1`） | `workers/cleanup/src/hub.ts` |
| 起こし方 | **cron `*/5 * * * *`** → `scheduled()` が DO のアラームを立てる | `workers/cleanup/wrangler.toml` の `[triggers]` |
| 進め方 | アラーム 1 回で作品 2 件（進んだら 1 秒後・待ちだけなら 30 分後・何も無ければ立てない） | `src/withdrawal-purge.ts` |
| 押した要求の中の処理 | 掴む → R2（アイコン）→ 1 batch・13 文で確定 | `src/withdrawal.ts` |
| D1 の列と索引 | `users` の 3 列 / `users_withdrawal_pending_idx` / トリガ 3 本 | `migrations/0045_user_withdrawal.sql` |
| 配備 | `scripts/deploy-cleanup.sh`（マージ後は deploy ジョブが **Pages より前に**叩く） | `.github/workflows/verify.yml` |
| 宣言の検査 | `scripts/check-cleanup-worker.sh`（`scripts/acceptance.sh` から呼ぶ） | — |
| 運営の確認 | `scripts/withdrawal-status.sh`（**読み取りだけ**） | — |

## 1 回の退会に何が起きるか

```
利用者 → 退会（#518 が足す口。この土台には無い）
          段1 掴む   条件付き UPDATE 1 文（退会の開始・アイコンの排他・断る条件）
          段2 R2     アイコンの現行と avatars/history/<id>/ の一覧を消す
          段3 確定   1 batch・13 文（匿名化・履歴・ハンドル・台帳・一括の取り下げ・withdrawn_at）
          → この時点で users からは個人を識別できる値が消えている

cron（5 分ごと）→ scheduled() → WithdrawalHub のアラーム
          1 始めて 10 分たった処理中の要求があれば、段1〜3 を代わりに打って終える
          2 退会済みで未完了の利用者の公開中の作品に、取り下げを打ち直す
          3 候補（中身を消していない・公開中でない・進行中でない）を 10 件引く
          4 deleteGame を 2 件だけ呼ぶ（失敗した作品は指数的に待つ。上限 1 時間）
          5 残りの作品が 0 件の利用者を 1 人だけ完了させる
              アイコンを消し直し、**R2 の接頭辞が空だと確かめてから** withdrawal_completed_at を立てる
          6 次のアラーム（進んだら +1 秒 / 待ちだけなら +30 分 / 何も無ければ立てない）
```

**平常時（終わっていない退会が 0 件）は、D1 を 5 文読んで終わる。** 5 分ごとに走っても
1 日 1,440 文で、無料枠に対して無視できる。

**60 件の利用者は 31 回のアラームで終わる**（テスト環境の実測。`test/withdrawal-purge.test.ts`）。
進んだ回は 1 秒後に次を立てるので、**約 30 秒〜1 分**である。

## 初回の配備（利用者の端末で行う）

**エージェントの実行環境は本番への書き込みを拒否する**ので、以下は利用者が叩く。

### 1. API トークンの権限

**足すものは無い。** `game-forge-likes` を配るために **Account / Workers Scripts: Edit** を
2026-09-11 に足してある（`docs/likes.md`）。cron の登録も同じスコープで足りる。

### 2. マイグレーション 0045 を本番に当てる

**マージの前に、PR のツリーから当てる**（`docs/handoff.md` の land の手順）。

```bash
# 0045 を含むツリーで
set -a; . scripts/load-project-env.sh; set +a
npx wrangler d1 migrations apply DB --remote --env production
```

**Worker より先に当てる。** 後続の処理は `users` の退会の 3 列を読むので、未適用のまま配ると
5 分ごとに失敗し続ける（deploy ジョブでは「未適用のマイグレーションが無いこと」の関門が先に
落ちるので、機構でも守られる）。

### 3. Worker を配る

```bash
set -a; . scripts/load-project-env.sh; set +a
bash scripts/deploy-cleanup.sh
```

**cron はこのコマンドが宣言（`[triggers]`）から登録する。** 別の手順は要らない。

## 確認のしかた

### cron が登録されているか

**`wrangler` には cron トリガを読むコマンドが無い**（`wrangler triggers` が持つのは `deploy`
だけである。2026-09-16 に確認）。ダッシュボード（Workers & Pages → `game-forge-cleanup` →
Settings → Triggers）で見るか、**Cloudflare の API を読み取りだけで叩く。**

```bash
set -a; . scripts/load-project-env.sh; set +a
curl -sS -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  "https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/workers/scripts/game-forge-cleanup/schedules"
```

`{"schedules":[{"cron":"*/5 * * * *", ...}]}` が返れば登録されている。

**アカウントの cron は 5 本まで**（Workers Free）。**#586 が本番に出たので（2026-09-16。PR #588 /
`f1d10ae`）、いま使っているのは 1 本である**——`game-forge-cleanup` の `*/5 * * * *` が
**5 本中 1 本目**で、残りは 4 本。**アカウントの Worker スクリプトは `game-forge-likes` と
`game-forge-cleanup` の 2 本**（`game-forge-likes` の `schedules` は空のまま。Pages プロジェクトは
cron を持てない）。残りを数えるには、上の URL の `workers/scripts` までを叩いてスクリプトを
列挙し、1 本ずつ `schedules` を見る。

> **旧記述（#586 の配備より前）。** 「2026-09-16 の時点で使っているのは 0 本で（アカウントの
> Worker スクリプトは `game-forge-likes` の 1 本だけ、その `schedules` は空。Pages プロジェクトは
> cron を持てない）、これが 1 本目である。」

### 退会がどこまで進んだか

```bash
# 終わっていない退会の一覧
bash scripts/withdrawal-status.sh --remote

# 1 人ぶんの判定（1 行ずつ PASS / FAIL）
bash scripts/withdrawal-status.sh --remote <user_id>
```

最終行は次のいずれかになる。

| 合図 | 終了コード | 意味 |
|---|---|---|
| `WITHDRAWAL_COMPLETE` | 0 | 終わっている（または終わっていない退会が 1 件も無い） |
| `WITHDRAWAL_PENDING` | 1 | 進行中。次のアラームを待つ |
| `WITHDRAWAL_BROKEN` | 3 | **完了の印が立っているのに消えていないものがある。** 人が見る |

**このスクリプトは書き込まない。** 止まった退会を押し直す口は付けていない——押し直すのは
後続の処理の仕事で（掴んでから 10 分で代打する）、人が D1 を直接書くと、掴みと排他の規律
（`src/withdrawal.ts` の段1）を外から破ることになる。

### アラームが動いているか

```bash
npx wrangler tail game-forge-cleanup
```

平常時は 5 分ごとに何も出さずに終わる（進んだときだけログが出る）。

## 止まったときに何が起きるか

| 止まったもの | 起きること | 直し方 |
|---|---|---|
| cron | 退会した作品が消えないまま残る。**匿名化は済んでいる**（押した要求の中で終わっている） | 配り直す（`scripts/deploy-cleanup.sh`）。次のアラームが候補を拾い直す |
| アラームが例外で落ちる | DO が自動で再試行する。同じ理由で落ち続けるなら `wrangler tail` で見る | 原因を直して配り直す。**状態は D1 にあるので、途中から続けられる** |
| 1 本の作品だけが消せない | その作品は指数的に待ち（上限 1 時間）に入り、**残りの削除は進む** | `scripts/withdrawal-status.sh <user_id>` で残りを見る |
| DO が退避されて待ちが消えた | 次のアラームが同じ候補を拾い直す（**害は無い**） | 何もしない |

## 確かめられていないこと

- **「R2 の接頭辞が空だった」と確かめてから `withdrawal_completed_at` を立てるまでの窓**は、
  ゼロにはなっていない。**#518 で利用者の口が開いた後も、この記述は変わらない**（PR #589 の
  Copilot の指摘 2 を実測して確かめた。測った内容は `test/withdrawal-routes.test.ts` の
  「退会の最中のアイコンの保存」にある）。

  **塞がっているもの。**

  1. **退会を始めた利用者は、アイコンの排他を新しく取れない**
     （`migrations/0045_user_withdrawal.sql` の `users_skip_avatar_lock_for_withdrawal`）。
     確かめた後に R2 へ書き**始める**要求は生まれない
  2. **排他が生きている間は、退会そのものを 409 で断る**（`src/withdrawal.ts` の段1 の
     `avatar_lock_at <= now - AVATAR_LOCK_SECONDS`）。書き手と退会が重なるには、
     **排他を取ってから 60 秒**（`src/avatar.ts` の `AVATAR_LOCK_SECONDS`）が要る
  3. **排他を失った書き手は、R2 に 1 バイトも書かない。** `saveAvatar` と `removeAvatar` は
     **R2 へ書く直前に D1 で排他を確かめる**（`src/avatar.ts` の `holdsAvatarLock`）
  4. **D1 の側は戻らない。** 確定の batch（`writeAvatarBatch`）は排他の token を WHERE に
     持つので 0 行になり、匿名化した `users` の列は書き換わらない

  **残るのは 1 つだけ**——**排他を確かめてから R2 へ put するまでのあいだに、上の 60 秒を
  またいだ要求**である。この 2 つの間にあるのは D1 の 1 読みと R2 の写し 1 回だけなので、
  またぐには要求がそこで約 1 分止まっている必要がある。その要求は自分が書いた画像を戻そうと
  するが、**排他を持っていないので戻さない**（`src/avatar.ts` の `restoreIfHeld`。他の書き手の
  版を壊さないための規律であり、退会の場合だけを分けてはいない）。

  **したがって、完了の印は立ちうる。** 完了の文の WHERE は
  `avatar_sha256 is null and avatar_lock_token is null` だが、**またいだ書き手の排他は段1 で
  奪われて D1 に残っていない**ので、その条件では捕まらない（**「排他が残っていれば完了に
  しない」は、D1 に排他が残っている場合の話である**）。

  **運用の網は `scripts/withdrawal-status.sh <user_id>` である。** 完了の印が立った後でも
  何度でも打て、現行のアイコンが R2 に残っていれば FAIL で出る（写しの接頭辞も出力の最後に
  案内する）。消し方は `docs/takedown.md` 4.5 である。**`avatars/history/` の写しは R2 の
  ライフサイクル規則で 30 日で消える**ので、残りうるのは現行のキー 1 つである。

  **塞ぐなら書き手の側である**（この PR ではやっていない）——`restoreIfHeld` が「排他を退会に
  奪われたとき**だけ**は、自分が書いた分を消す」と分ければ閉じる。`src/avatar.ts` の 4.5 の
  排他の意味を変える変更になるので、**別の issue で扱う。**
- **本番の Worker が実際に公開されていないこと**は、`scripts/check-cleanup-worker.sh` では
  見ていない（宣言だけを見る）。ダッシュボードで手で workers.dev を有効にした場合は捕まらない
- **cron が本番で実際に登録されていること**も検査には入っていない（上の手順で人が見る）。
  **※ 2026-09-16: #586 の配備の後に人が見て、`*/5 * * * *` が 1 本登録されていることを確かめた**
  （検査に入っていないことは変わらない）
- **Workers Free の CPU 時間でアラーム 1 回に `deleteGame` 2 件が収まるか**は、本番のログでしか
  測れない（テスト環境の所要は 1 回あたり約 11 ms で、その大半は D1 と R2 の待ちである）。
  足りなければ `src/withdrawal-purge.ts` の `GAMES_PER_STEP` を 1 にする。
  **※ 2026-09-16: 本番のアラームはまだ候補 0 件でしか起きていない**（#518 の本番の確認は
  作品 1 本で、押した要求の中で消え切った）。**作品が多い利用者で回をまたぐ経路は、
  本番では通っていない**（miniflare の 60 件・31 回は #586 で実測済み）
