# 削除申請と送信防止措置の手順

**仕様書 8.4 は「送信防止措置の手順と記録を残す（情報流通プラットフォーム対処法への対応）。
削除申請フォームの設置だけでは足りない」と定めています。この文書がその「手順」です。**

- 位置づけ: **手順と、記録の読み方。** 規約の本文は `/terms`（`src/legal.ts`）、
  受付と記録の実装は `src/takedown.ts` にあります。**ここへ複製しません。**
- **これは法的助言ではありません。** 書いたのは弁護士ではなく、**β 公開前に専門家の
  確認を受けてください。**

---

## 1. 申請はどこから来るか

**フッターの「権利者の方へ（削除申請）」から、`/takedown` のフォームで受けます。**
フッターは全 SSR 画面に出ます（`siteFooter()`。書き忘れは `test/legal.test.ts` が
経路表から導いて機械照合します）。

**ログインを要求しません。** 権利者は本サービスの利用者とは限りません。

**申請が来ても、作品は 1 ビットも動きません。** 8.4 が通報について「自動非表示は組織的
通報で正常なコンテンツを消せてしまう」と書いているのと同じ理由が、削除申請にも当てはまり
ます——**申請は主張であって、認定ではありません。**

---

## 2. 気づく経路

**受付時に運用者へメールが 1 通飛びます**（宛先は `OPERATOR_EMAIL`）。

**同じ作品につき 1 通だけです。** 濫用されても送信量が作品数で頭打ちになります。
**記録のほうは全件残ります**——8.4 が求めているのは記録なので、そこは削りません。

**メールに申請の中身は載りません。** 「見に行け」という合図だけで、連絡先も本文も
含みません（`src/takedown.ts`）。中身は次の手順で読みます。

---

## 3. 申請を読む

```bash
set -a; source scripts/load-project-env.sh; set +a
bash scripts/takedown-queue.sh --remote
```

**未対応（`handled_at` が NULL）の申請だけが出ます。**

終了コード: `0` = 未対応なし / `1` = 有る / `2` = 調べられなかった。
**`1` と `2` を分けています**——「未対応が有った」と「認証が切れていた」は別です。

---

## 4. 判断して記録する

**判断は人が行います。** 次の 3 つから選びます（綴りの正本は `src/takedown.ts` の
`TAKEDOWN_ACTIONS`）。

| 措置 | 意味 | 実際にすること |
|---|---|---|
| `removed` | 申請を認め、作品を削除する | **画面で記録したあと、手作業で** `games.status` を `removed` にする（画面は取り下げない。仕様 2.4.3） |
| `restricted` | 新規露出だけ止める | **画面で記録すると、作品が審査キューへ入る**（`review_state = 'queued'`。8.4 の「新規露出のみ停止」。審査キューから戻せる） |
| `rejected` | 申請を認めない | 作品は動かさない |

**`rejected` も必ず記録します。** 残さないと「見ていない」と区別がつきません——
8.4 が求めているのは**措置の記録**であって、措置をしたことの記録ではありません。

**記録は運営の管理画面の「削除申請」（`/takedowns`）で行います**（#406）。未対応の申請に
措置と理由を選んで「措置を記録する」を押すと、**措置が `takedown_requests` に、誰がいつ何を
理由にしたかが `admin_actions`（操作の履歴）に、同時に残ります。** 理由は申請への回答に使うので、
必須です。

**申請の内容（申請者・連絡先・本文）は書き換わりません。** 変わるのは措置の側だけで、これが
#41 の acceptance が求める「追記のみ」の実体です。

> **1 度記録した行は上書きできません。** 画面は措置済みの行にフォームを出さず、口も断ります。
> 判断を変える場合は、**変えた事実ごと分かるように**新しい申請として扱うか、運用として別途記録してください。

> **`removed` を記録しても、作品は取り下げられません。** 画面の行に「作品はまだ公開中です」と出るあいだは、
> 取り下げの手作業が残っています。
>
> ```bash
> npx wrangler d1 execute DB --remote --env production \
>   --command "update games set status = 'removed' where id = '<作品の id>' and status = 'published';"
> ```

> **画面より前（#406 以前）に端末で記録した措置には、実行者の履歴がありません。** 画面はその行に
> 「履歴なし」と出します。

---

## 4.5 不適切なアイコン画像を消す（#380 / 仕様 5.10）

**アイコン画像は作品ではないので、上の措置（`games.status`）の対象になりません。** 削除申請・通報・運営が
自分で見つけたもの、どこから知っても**同じ端末手順で消します。**

- **管理画面には置きません**（戻せない操作を画面に置かない決定を保つ。仕様 2.4）
- **BAN と自動では連動させません**（BAN は戻せる操作で、画像の削除は戻せない。戻せる操作に戻せない
  副作用を付けない）。BAN した利用者のアイコンを消すときも、この手順を別に打ちます
- **自動検査は入れていません**（招待制・50 人の段階。**一般公開の前に見直す**——仕様 5.10）
- **期限（30 日）を待たずに、いまのアイコンと差し替え前の画像の両方を消します**（`/privacy` にそう書いた）。
  **アカウントの削除を希望されたとき（退会の機能はまだありません）も、この手順で画像を消します**

### 手順: R2 から消す → 列を空にする → 履歴を 1 行積む

**R2 を先に消します。** 列を先に空にすると、ヘッダのアバター（D1 を読まずに R2 のキーだけで配る。
`src/avatar-delivery.ts`）が消すまでのあいだ画像を出し続けます。

```bash
set -a; source scripts/load-project-env.sh; set +a
id='<利用者の id>'

# 1. いまの画像の値と、差し替え前の画像の写しを確かめる（2 と 4 に写す）
npx wrangler d1 execute DB --remote --env production --command "
select avatar_sha256, avatar_set_at from users where id = '${id}';
select history_key, changed_at from avatar_changes
 where user_id = '${id}' and history_key is not null order by changed_at;"

# 2. R2 から、いまの画像と、1 で出た history_key をすべて消す
#    （30 日を過ぎた写しはライフサイクル規則が既に消している。無いキーの削除は失敗しない）
CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV=false npx wrangler r2 object delete "game-forge/avatars/${id}.webp" --remote
CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV=false npx wrangler r2 object delete "game-forge/<1 で出た history_key>" --remote
#    （history_key の行の数だけ繰り返す）

# 3. 値を 1 度だけ決める。**時刻もここで 1 度だけ取る**
old='<1 で見た avatar_sha256>'; now=$(date +%s)

# 4. 列を空にし、「空になった後の状態になっている行」についてだけ履歴を積む（**打ち直しても結果が同じ**）
#    history_key は NULL（画像を残さないため）
npx wrangler d1 execute DB --remote --env production --command "
update users set avatar_sha256 = null, avatar_set_at = ${now}
 where id = '${id}' and avatar_sha256 = '${old}' and avatar_lock_token is null;
insert into avatar_changes (id, user_id, old_sha256, new_sha256, history_key, changed_at)
  select lower(hex(randomblob(16))), id, '${old}', null, null, ${now}
    from users
   where id = '${id}' and avatar_sha256 is null and avatar_set_at = ${now}
     and not exists (select 1 from avatar_changes
                      where user_id = '${id}' and changed_at = ${now} and old_sha256 = '${old}');"

# 5. 列と履歴と R2 を確かめる（R2 の get は「見つからない」で失敗するのが正しい）
npx wrangler d1 execute DB --remote --env production --command "
select avatar_sha256, avatar_set_at from users where id = '${id}';
select old_sha256, new_sha256, history_key, changed_at from avatar_changes
 where user_id = '${id}' order by changed_at desc limit 1;"
CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV=false npx wrangler r2 object get "game-forge/avatars/${id}.webp" --remote --pipe >/dev/null \
  && echo '**まだ残っています**' || echo '消えています'
```

**4 の後の 5 で列が空になっていなければ、利用者がちょうど保存の途中です**（`avatar_lock_token` が入っている。
アプリは保存のあいだ利用者ごとの排他を持ち、確定のときに外す。`src/avatar.ts`）。**60 秒待って 1 からやり直します**
（保存が終われば新しい画像が現行のキーに入っているので、2 でそれも消す。排他を持ったまま落ちた要求も 60 秒で解ける）。
**排他を無視して列を直さないこと**——保存の途中の要求が「確定が当たらなかった」として現行のキーを戻し、消した画像が
R2 に戻りうる。

**時刻は `date +%s` で 1 度だけ取り、両方の文に同じ値を渡します**（表示名を直す手順と同じ理由。
`docs/admin-host.md` の「運営が D1 を直接 UPDATE して表示名を直すとき」）。

**`avatar_set_at` を進めるので、利用者はそこから 60 秒は新しいアイコンを設定できません。** それ以上は
止めません（同じ画像を上げ直されたら、もう一度この手順を打ちます。続くなら BAN を別に判断します）。

**ブラウザに残った表示は消せません。** 一覧と作者ページは版つきの URL（`?v=`）で長くキャッシュさせて
いますが、**列を空にした時点で、その URL を指す HTML が出なくなります**（ヘッダの画像は毎回再検証する
ので、R2 から消した時点で透明な画像に替わり、既定の図形が見える）。

**措置の記録:** 削除申請から来たときは、上の 4 の画面でその申請にも措置と理由を記録します
（理由に「アイコン画像を削除した」と書く）。**アイコンそのものの記録は、4 で積んだ `avatar_changes` の 1 行です。**

---

## 5. この表を掃除しません

`moderation_blocks`（8.2 の遮断記録）には 90 日の保持期間がありますが、
**`takedown_requests` には保持期間を設けていません。**

**8.4 が求めているのは記録を残すことであり、保持期間を切ることではない**ためです。
`scripts/moderation-prune.sh` に相当するものを、この表に対して作らないでください。

---

## 6. まだ通していないこと

**本番で 1 件も受け付けていません**（2026-09-04 時点）。実装と検査は通っていますが、
**「テストの中では動く」と「本番で動く」は別**です（`docs/handoff.md` 4 章）。

最初の 1 件を受けたときに確かめること:

- メールが**届く**こと（Resend が受理したことと、受信箱に入ることは別です）
- メールに**申請者の連絡先も本文も入っていない**こと
- `scripts/takedown-queue.sh --remote` にその行が出ること

---

## 関連

- 条文: `/terms`（`src/legal.ts`）
- 受付: `src/takedown.ts` / `migrations/0018_takedown_requests.sql`
- 措置の記録（管理画面）: `src/admin/takedowns.ts` / `src/admin/actions.ts` の `recordTakedownAction` / `migrations/0031_admin_actions_takedown.sql`（手順は `docs/admin-host.md`）
- 通報と審査キュー（利用者からの通報。**権利者からの申請とは別経路**）: [usage-report.md](usage-report.md)
- アイコン画像: `src/avatar.ts` / `src/avatar-delivery.ts` / `migrations/` の user_avatars / 保存期間の規則 `terraform/r2-lifecycle.tf`
