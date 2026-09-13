# 削除依頼と送信防止措置の手順

**仕様書 8.4 は「送信防止措置の手順と記録を残す（情報流通プラットフォーム対処法への対応）。
削除依頼フォームの設置だけでは足りない」と定めています。この文書がその「手順」です。**

- 位置づけ: **手順と、記録の読み方。** 規約の本文は `/terms`（`src/legal.ts`）、
  受付と記録の実装は `src/takedown.ts` にあります。**ここへ複製しません。**
- **これは法的助言ではありません。** 書いたのは弁護士ではなく、**β 公開前に専門家の
  確認を受けてください。**

---

## 1. 依頼はどこから来るか

**フッターの「権利者の方へ（削除依頼）」から、`/takedown` のフォームで受けます。**
フッターは全 SSR 画面に出ます（`siteFooter()`。書き忘れは `test/legal.test.ts` が
経路表から導いて機械照合します）。

**ログインを要求しません。** 権利者は本サービスの利用者とは限りません。

**依頼が来ても、作品は 1 ビットも動きません。** 8.4 が通報について「自動非表示は組織的
通報で正常なコンテンツを消せてしまう」と書いているのと同じ理由が、削除依頼にも当てはまり
ます——**依頼は主張であって、認定ではありません。**

---

## 2. 気づく経路

**受付時に運用者へメールが 1 通飛びます**（宛先は `OPERATOR_EMAIL`）。

**同じ作品につき 1 通だけです。** 濫用されても送信量が作品数で頭打ちになります。
**記録のほうは全件残ります**——8.4 が求めているのは記録なので、そこは削りません。

**メールに依頼の中身は載りません。** 「見に行け」という合図だけで、連絡先も本文も
含みません（`src/takedown.ts`）。中身は次の手順で読みます。

---

## 3. 依頼を読む

```bash
set -a; source scripts/load-project-env.sh; set +a
bash scripts/takedown-queue.sh --remote
```

**未対応（`handled_at` が NULL）の依頼だけが出ます。**

終了コード: `0` = 未対応なし / `1` = 有る / `2` = 調べられなかった。
**`1` と `2` を分けています**——「未対応が有った」と「認証が切れていた」は別です。

---

## 4. 判断して記録する

**判断は人が行います。** 次の 3 つから選びます（綴りの正本は `src/takedown.ts` の
`TAKEDOWN_ACTIONS`）。

| 措置 | 意味 | 実際にすること |
|---|---|---|
| `removed` | 依頼を認め、作品を削除する | **画面で記録したあと、手作業で** `games.status` を `removed` にする（画面は取り下げない。仕様 2.4.3） |
| `restricted` | 新規露出だけ止める | **画面で記録すると、作品が審査キューへ入る**（`review_state = 'queued'`。8.4 の「新規露出のみ停止」。審査キューから戻せる） |
| `rejected` | 依頼を認めない | 作品は動かさない |

**`rejected` も必ず記録します。** 残さないと「見ていない」と区別がつきません——
8.4 が求めているのは**措置の記録**であって、措置をしたことの記録ではありません。

**記録は運営の管理画面の「削除依頼」（`/takedowns`）で行います**（#406）。未対応の依頼に
措置と理由を選んで「措置を記録する」を押すと、**措置が `takedown_requests` に、誰がいつ何を
理由にしたかが `admin_actions`（操作の履歴）に、同時に残ります。** 理由は依頼への回答に使うので、
必須です。

**依頼の内容（依頼者・連絡先・本文）は書き換わりません。** 変わるのは措置の側だけで、これが
#41 の acceptance が求める「追記のみ」の実体です。

> **1 度記録した行は上書きできません。** 画面は措置済みの行にフォームを出さず、口も断ります。
> 判断を変える場合は、**変えた事実ごと分かるように**新しい依頼として扱うか、運用として別途記録してください。

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

**アイコン画像は作品ではないので、上の措置（`games.status`）の対象になりません。** 削除依頼・通報・運営が
自分で見つけたもの、どこから知っても**同じ端末手順で消します。**

- **管理画面には置きません**（戻せない操作を画面に置かない決定を保つ。仕様 2.4）
- **BAN と自動では連動させません**（BAN は戻せる操作で、画像の削除は戻せない。戻せる操作に戻せない
  副作用を付けない）。BAN した利用者のアイコンを消すときも、この手順を別に打ちます
- **自動検査は入れていません**（招待制・50 人の段階。**一般公開の前に見直す**——仕様 5.10）
- **期限（30 日）を待たずに、いまのアイコンと差し替え前の画像の両方を消します**（`/privacy` にそう書いた）。
  **アカウントの削除を希望されたとき（退会の機能はまだありません）も、この手順で画像を消します**

### 手順: 排他を取る → 値を D1 から読む → R2 から消す → 自分の排他を持つ行だけ確定する → 確かめる

**外から渡す値は利用者の `id` だけです。** 現行の `avatar_sha256` も `history_key` も、手順の中で D1 から読みます。
**事前に読んだ値を手で写して打たないこと**——#380 の本番の削除で、値を読んだ後に利用者が「外す → 再設定」し、
R2 の現行の画像だけが消え、D1 の UPDATE は 0 行、写しが 1 つ残りました（`docs/handoff.md` 1 章の「M12 の波 4 が
本番に出ました」。直しは #445）。

**順序の理由:**

- **排他を最初に取ります。** 取った後は、利用者の保存・外すが排他を取れず、変換にも R2 にも D1 にも触りません
  （下の「排他の条件」）。**だから 2 で読んだ値は、4 で確定するまで変わりません**
- **R2 を D1 より先に消します。** 列を先に空にすると、ヘッダのアバター（D1 を読まずに R2 のキーだけで配る。
  `src/avatar-delivery.ts`）が消すまでのあいだ画像を出し続けます。**また、R2 を消している途中で落ちても、列は元の
  値のまま残る**ので、打ち直せば D1 にある値で同じキーを消し直せます（列を先に空にすると、打ち直しで現行の値を
  読めない）
- **確定は最後に、自分の排他を持っている行だけに当てます。** 持ち時間が切れて利用者が取り直していれば 0 行になり、
  5 で止まります

**ブロックをまとめて貼って実行します。** `set -euo pipefail` の bash のサブシェルで動くので、**利用者がいない・排他が
取れない・JSON が読めない・想定外の値がある・R2 の削除が落ちる・排他を失った・確定が当たらない・R2 に残っている・
R2 を確かめられない・60 秒後に現行のキーへ書かれていた、のどれでも、その場で止まり先へ進みません**（止まっても対話
シェルは閉じない）。**最後に `AVATAR_REMOVE_DONE` が出なければ、完了していません**（どこで止まったかは、直前に出た
文言で分かる）。**5 の最後で 60 秒待つので、全体で 1 分あまりかかります。**

```bash
# リポジトリのルートで打つ（scripts/load-project-env.sh を相対パスで読む）。
# 外から渡すのは利用者の id だけ。bash のサブシェルで実行する（exit で対話シェルを閉じない）。
# 本体は関数にしてから呼ぶ——bash は関数を最後まで読んでから動かすので、中のコマンドが標準入力（このヒアドキュメント）を食わない。
id='<利用者の id>' bash -s <<'SCRIPT'
set -a; source scripts/load-project-env.sh; set +a
set -euo pipefail

main() {
  [[ "$id" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$ ]] \
    || { echo "id が UUID の形ではありません: ${id}" >&2; exit 1; }

  # 本番の D1 に 1 文を投げ、JSON の配列だけを返す（wrangler は前置きの行を混ぜることがある。失敗は pipefail で止まる）
  d1() {
    CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV=false \
      npx wrangler d1 execute DB --remote --env production --json --command "$1" | sed -n '/^\[/,$p'
  }
  # `select count(*) as n ...` の n を返す（JSON が読めなければ止まる）
  n() { node -e 'console.log(JSON.parse(require("fs").readFileSync(0, "utf8"))[0].results[0].n)'; }
  r2() { CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV=false npx wrangler r2 object "$@" --remote; }
  # 排他を持ち続ける。自分のトークンを持つ行の avatar_lock_at を今の時刻へ進め、読み直して持っていなければ止まる
  keep() {
    local h
    d1 "update users set avatar_lock_at = $(date +%s) where id = '${id}' and avatar_lock_token = '${token}';" >/dev/null
    h=$(d1 "select count(*) as n from users where id = '${id}' and avatar_lock_token = '${token}';" | n)
    [ "$h" = 1 ] || { echo '排他を失いました（持ち時間が切れて、利用者の操作が取り直した）。1 からやり直してください' >&2; exit 1; }
  }
  # R2 にキーが無いと確かめられたら 0、在れば 1 を返す。「見つからない」以外の失敗（認証・権限・一時的な失敗）なら止まる
  #   wrangler 4 の `r2 object get --remote` は、API が 404 を返したときだけ "The specified key does not exist." を出して 1 で終わる
  #   （それ以外の失敗は "Failed to fetch ... - <status>: ..." で、同じく 1 で終わる。終了コードでは見分けられない）
  gone() {
    local err
    if err=$(r2 get "game-forge/$1" --pipe 2>&1 >/dev/null); then return 1; fi
    if grep -qF 'The specified key does not exist.' <<<"$err"; then return 0; fi
    printf 'R2 を確かめられません（見つからない以外の失敗）。やり直してください: %s\n%s\n' "$1" "$err" >&2; exit 1
  }

  # 0. 利用者の行があるかを読む（無い id を「保存中」と取り違えない）
  exists=$(d1 "select count(*) as n from users where id = '${id}';" | n)
  [ "$exists" = 1 ] || { echo "その id の利用者がいません。id を確かめてください: ${id}" >&2; exit 1; }

  # 1. 排他を取る。トークンと時刻は、ここで 1 度だけ作る（以降の文はすべてこの 2 つを使う。3 の keep だけが avatar_lock_at を今へ進める）
  #    条件は acquireAvatarLock（src/avatar.ts）の WHERE から、間隔（avatar_set_at）の条件だけを外したもの
  #    利用者が保存中なら取れずに止まる。持ち時間が切れて利用者が取り直したら、3 の keep か 5 で止まる（下の「途中で利用者の保存・外すが割り込んだら」）
  token=$(node -e 'console.log(crypto.randomUUID())')
  now=$(date +%s)
  d1 "update users set avatar_lock_token = '${token}', avatar_lock_at = ${now}
       where id = '${id}'
         and (avatar_lock_token is null or avatar_lock_at is null or avatar_lock_at <= ${now} - 60);" >/dev/null
  #    取れたかは meta.changes ではなく、行を読み直して確かめる
  held=$(d1 "select count(*) as n from users where id = '${id}' and avatar_lock_token = '${token}';" | n)
  [ "$held" = 1 ] || { echo '排他が生きています（利用者が保存中か、途中で止まった前回の手順の排他）。60 秒待ってやり直してください' >&2; exit 1; }

  # 2. 値を D1 から実行時に読む（手で写さない）。排他を持っていない・想定外の値なら止まる
  old=$(d1 "select avatar_sha256 as s from users where id = '${id}' and avatar_lock_token = '${token}';" \
    | node -e 'const r = JSON.parse(require("fs").readFileSync(0, "utf8"))[0].results;
               if (r.length !== 1) { console.error("排他を持っていません。やり直してください"); process.exit(1); }
               const s = r[0].s ?? "";
               if (s !== "" && !/^[0-9a-f]{64}$/.test(s)) { console.error(`想定外の sha: ${s}`); process.exit(1); }
               console.log(s)')
  #    写しは、保存期間（30 日。terraform/r2-lifecycle.tf の avatar_history_retention_days）に余裕 2 日を足した範囲だけを回す。
  #    それより古い写しはライフサイクル規則が R2 から消している（履歴の行は D1 に残り続けるので、絞らないと回す数が増え続ける）
  keys=$(d1 "select history_key as k from avatar_changes
              where user_id = '${id}' and history_key is not null and changed_at >= ${now} - (30 + 2) * 86400
              order by changed_at;" \
    | node -e 'const re = new RegExp(`^avatars/history/${process.argv[1]}/[0-9]+-[0-9a-f]{64}-[0-9a-f-]{36}\\.webp$`);
               for (const r of JSON.parse(require("fs").readFileSync(0, "utf8"))[0].results) {
                 if (!re.test(r.k)) { console.error(`想定外のキー: ${r.k}`); process.exit(1); }
                 console.log(r.k);
               }' "$id")
  #    確定の WHERE に入れる「読んだときの画像」（アプリの `avatar_sha256 is ?` と同じ綴り）。空なら、もう外れている
  if [ -n "$old" ]; then oldsql="'${old}'"; else oldsql=null; fi
  echo "old=${old:-（なし）}"; echo "keys:"; echo "${keys}"

  # 3. R2 から消す。現行のキーと、2 で読んだ history_key をすべて（無いキーの削除は失敗しない。失敗は set -e で止まる）
  #    削除のたびに keep で排他を今へ進める（写しが多くて直列の削除が 60 秒を超えても、持ち時間を切らさない）
  for k in "avatars/${id}.webp" $keys; do
    keep
    r2 delete "game-forge/${k}"
  done
  keep

  # 4. 確定する。WHERE は writeAvatarBatch と同じ「id・自分のトークン・読んだときの画像」（avatar_lock_at は見ないので、keep で進めても当たる）
  #    履歴を先に、列を後に書く（端末からの 2 文は 1 つのトランザクションにならない。落ちたら履歴が欠ける側ではなく、残る側に倒す）
  #    履歴は、いまの画像を運営が消した行がまだ無いときだけ積む（4 の途中で落ちて打ち直しても 2 行にならない）
  #    old が空（もう外れていた）なら履歴は積まない
  if [ -n "$old" ]; then
    d1 "insert into avatar_changes (id, user_id, old_sha256, new_sha256, history_key, changed_at)
          select lower(hex(randomblob(16))), u.id, u.avatar_sha256, null, null, ${now}
            from users u
           where u.id = '${id}' and u.avatar_lock_token = '${token}' and u.avatar_sha256 is ${oldsql}
             and not exists (select 1 from avatar_changes c
                              where c.user_id = u.id and c.old_sha256 = u.avatar_sha256
                                and c.new_sha256 is null and c.history_key is null
                                and c.changed_at >= coalesce(u.avatar_set_at, 0));" >/dev/null
  fi
  d1 "update users set avatar_sha256 = null, avatar_set_at = ${now}, avatar_lock_token = null, avatar_lock_at = null
       where id = '${id}' and avatar_lock_token = '${token}' and avatar_sha256 is ${oldsql};" >/dev/null

  # 5. 確かめる。列（sha も排他も NULL で、avatar_set_at が 1 の時刻）でなければ、割り込まれている
  settled=$(d1 "select count(*) as n from users
                 where id = '${id}' and avatar_sha256 is null and avatar_lock_token is null and avatar_lock_at is null
                   and avatar_set_at = ${now};" | n)
  [ "$settled" = 1 ] || { echo '確定が当たっていません（割り込まれた）。1 からやり直してください' >&2; exit 1; }
  if [ -n "$old" ]; then
    recorded=$(d1 "select count(*) as n from avatar_changes
                    where user_id = '${id}' and old_sha256 = '${old}' and new_sha256 is null and history_key is null;" | n)
    [ "$recorded" -ge 1 ] || { echo '列は空になりましたが、削除の履歴がありません' >&2; exit 1; }
  fi
  d1 "select old_sha256, new_sha256, history_key, changed_at from avatar_changes
       where user_id = '${id}' order by changed_at desc limit 1;"
  #    R2 は「見つからない」と確かめられたキーだけを「消えています」にする（gone）
  left=0
  for k in "avatars/${id}.webp" $keys; do
    if gone "$k"; then echo "消えています: ${k}"; else echo "まだ残っています: ${k}"; left=1; fi
  done
  [ "$left" = 0 ] || { echo 'R2 に残っています。1 からやり直してください' >&2; exit 1; }
  #    遅れた書き込みを見張る。60 秒おいて、現行のキーをもう一度確かめる（在れば、遅れて届いたアプリの書き込みなので 1 からやり直す）
  echo '60 秒おいて、現行のキーをもう一度確かめます'
  sleep 60
  gone "avatars/${id}.webp" \
    || { echo "60 秒後に現行のキーへ画像が書かれていました（遅れた書き込み）。1 からやり直してください: avatars/${id}.webp" >&2; exit 1; }
  echo AVATAR_REMOVE_DONE
}

main </dev/null
SCRIPT
```

### 排他の条件（`src/avatar.ts` と照らした）

**アプリは、保存・外すのたびに D1 で利用者ごとの排他（`users.avatar_lock_token` / `avatar_lock_at`。
`migrations/` の user_avatars）を取ってから R2 に触ります。** 手順はその規律（操作ごとの乱数のトークン・取った時刻・
持ち時間 60 秒）に揃えています。行番号は #445 の時点（`3007e8c`）の `src/avatar.ts` です。

| 手順 | 手順の条件 | `src/avatar.ts` |
|---|---|---|
| 1 排他を取る | `avatar_lock_token is null or avatar_lock_at is null or avatar_lock_at <= now - 60` で、トークンと時刻を書く | `acquireAvatarLock` の WHERE（379〜381 行）。60 は `AVATAR_LOCK_SECONDS`（333 行。384 行で `nowSeconds - AVATAR_LOCK_SECONDS` として渡す） |
| 1 間隔 | **置かない**（下） | 382 行の `avatar_set_at is null or avatar_set_at <= ?`（`AVATAR_CHANGE_INTERVAL_SECONDS`。92 行） |
| 1 取れたか | 行を読み直し、`avatar_lock_token = <自分のトークン>` の行が 1 行あること | アプリは `meta.changes`（386 行）。持っているかの判定は `holdsAvatarLock` の `id = ? and avatar_lock_token = ?`（431 行） |
| 2 値を読む | `avatar_lock_token = <自分のトークン>` の行から `avatar_sha256` を読む | `holdsAvatarLock`（431 行）の後に列を読む `saveAvatar` / `removeAvatar`（454・458 行 / 502・505 行） |
| 3 排他を持ち続ける | 削除のたびに `avatar_lock_at = <今の時刻>`（`id = <id> and avatar_lock_token = <自分のトークン>` の行だけ）へ進め、読み直して持っていなければ止まる | **アプリには無い**（1 回の操作の R2 の書き込みは 2 回で、変換の関数のタイムアウト 15 秒の 2 倍以上の 60 秒に収まる前提。326〜331 行）。持っているかの見方は `holdsAvatarLock`（431 行）と同じ |
| 4 確定する | 履歴も列も `id = <id> and avatar_lock_token = <自分のトークン> and avatar_sha256 is <読んだ値>`。列は sha と排他を NULL にし、`avatar_set_at` を 1 の時刻にする | `writeAvatarBatch` の `conditions`（624 行）を履歴の insert（629〜633 行）と列の update（638〜639 行）の両方に使う。update が書く 4 列も同じ |
| 5 確かめる | 列が `avatar_sha256 is null and avatar_lock_token is null and avatar_lock_at is null and avatar_set_at = <1 の時刻>` | 確定の update（638 行）が書いた後の形 |
| 失敗したとき | 解かない。60 秒で自然に解ける | 失敗した操作は `releaseAvatarLock`（412 行）で自分のトークンのときだけ解き、解けなくても 60 秒で解ける（404 行） |

**3 で進める `avatar_lock_at` は、4 と 5 と矛盾しません。** 4 の WHERE はトークンだけで排他を見て（`avatar_lock_at` を
見ない）、4 の update が `avatar_lock_at` を NULL に戻し、5 は NULL を確かめます。`avatar_set_at` と履歴の `changed_at`
には、3 で進めた時刻ではなく 1 の時刻を使います。**アプリの側から見ると、3 で進めているあいだ排他は生きていて、
利用者の保存・外すは `avatar-saving` で断られ続けます。**

**運営の手順だけが、間隔（`avatar_set_at`）の条件を外しています。** 間隔は利用者の連打（1 回の設定が Lambda の
呼び出し 1 回と R2 の書き込み 2 回を伴う）を絞るための条件で、R2 と D1 の食い違いを防ぐのは排他の条件だけです。
**外しても排他の性質は変わらず、不適切な画像を上げた直後（前回の変更から 60 秒以内）でも待たずに消せます。**

**手順が履歴を積む条件は、アプリと 2 点違います。** ①`old` が空（もう外れていた）なら積まない（アプリの外すも、
外すものが無ければ積まない。506〜509 行）②同じ画像を運営が消した行（`old_sha256` が同じ・`new_sha256` と
`history_key` が NULL・`changed_at` がその画像を設定した時刻以降）が既にあれば積まない。②は、4 の履歴を積んだ後・
列を書く前に落ちて打ち直したときに、同じ削除を 2 行にしないためです（アプリは 1 つの `D1.batch` で書くので要らない）。

**回す写しは、`changed_at` が「保存期間 30 日＋余裕 2 日」より新しい行だけです。** 保存期間は
`terraform/r2-lifecycle.tf` の `avatar_history_retention_days`（`src/avatar.ts` の `AVATAR_HISTORY_RETENTION_DAYS` は
その写し）で、それより古い写しはライフサイクル規則が R2 から消しています（規則は期限の後 24 時間ほどで消すので、
余裕を 2 日とった）。**`avatar_changes` の行は消えないので、絞らないと、削除のたびに回す数が増え続けます。**
**30 日後に規則が写しを消すことは、本番ではまだ確かめていません**（`docs/handoff.md`）。規則が効いていなければ、
32 日より古い写しはこの手順では消えません。

**端末の時計を使います**（`date +%s`）。**Worker の時計と大きくずれていると、持ち時間と間隔がそのぶんずれます。**
端末の時刻が合っていることを前提にします。

**R2 の「消えています」は、wrangler が「見つからない」と答えたときだけです。** wrangler 4（手元の 4.121.0 の
`wrangler-dist/cli.js`）の `r2 object get --remote` は、API が 404 を返したときだけ `The specified key does not exist.`
を出して終了コード 1 で終わり、それ以外の失敗（認証・権限・一時的な失敗）は `Failed to fetch ... - <status>` を出して
同じく 1 で終わります。**終了コードでは見分けられないので、文言で見分け、それ以外の失敗は止めてやり直させます。**
wrangler を上げてこの文言が変わると、5 は「確かめられません」で止まります（黙って「消えています」にはならない）。

### 途中で利用者の保存・外すが割り込んだら

- **1 の時点で利用者が保存中（排他が生きている）なら、1 で排他が取れず「排他が生きています」で止まります。** R2 にも
  D1 にも触っていません。**60 秒待って、もう一度打ちます**（保存が終わっていれば、新しい画像も 3 で消える）。
  **id の利用者がいないときは、その前に「その id の利用者がいません」で止まります**（待っても直らないので、id を確かめる）
- **1〜4 のあいだに利用者が保存・外すを押しても、アプリは排他を取れずに断ります**（`acquireAvatarLock` が 0 行で、
  生きている排他を見て `avatar-saving` を返す。396〜398 行。画面には「アイコンを保存しています。少し待ってから画面を
  開き直してください。」。157 行）。**変換にも R2 にも触らないので、手順はそのまま進みます**
- **写しが多くて 3 が 60 秒を超えても、排他は切れません**（削除のたびに `avatar_lock_at` を今へ進める）。
  **切れるのは、1 つの削除か D1 の 1 文が 60 秒以上止まったときです。** その間に利用者の保存・外すが排他を取り直すと、
  **次の削除の前の確かめが「排他を失いました」で止まります**（4 と 5 に進まない）。3 の最後の削除の後に取り直された
  ときは、4 の確定が自分のトークンを持たずに 0 行になり、**5 が「確定が当たっていません」で止まります。** どちらの
  場合も、利用者の新しい画像を 3 で消しているかもしれず、R2 と D1 は食い違っていることがあります。**必ず 1 から
  やり直します**（そのとき D1 にある値で消し直す。利用者の操作がまだ続いていれば、1 で止まる）
- **期限切れの排他を運営が取り直した後に、遅れていたアプリの操作が R2 の現行のキーへ書くと**（アプリは R2 に書く
  直前に `holdsAvatarLock` で確かめるが、確かめてから書くまで（454 行から 474 行）の間は防げない）、アプリの確定は
  当たらず戻しもしません（`writeAvatarBatch` が 0 行、`restoreIfHeld` は排他を持たないので何もしない。673 行）。
  **書き込みが 5 の確かめより前に届けば「まだ残っています」で、後に届けば「60 秒後に現行のキーへ画像が書かれて
  いました」で止まるので、1 からやり直します**（窓は狭い。運営が 1 で排他を取れるのはアプリの排他が 60 秒以上前に
  取られたときだけで、アプリの要求はふつう変換のタイムアウト 15 秒を含めてそれより前に終わる）
- **途中で落ちたら（端末を閉じた・ネットワーク・R2 の削除の失敗）、排他は最後に進めた時刻から 60 秒で解けます**
  （1 の条件の `avatar_lock_at <= now - 60`。アプリの 381 行と同じ）。4 より前なら列は元のままなので、**60 秒待って
  打ち直せば、そのとき D1 にある値で消し直します**（60 秒たたずに打ち直すと、自分の前回の排他で「排他が生きています」と止まる）。4 の履歴を積んだ後・列を書く前に落ちたときも、打ち直しで履歴は
  2 行になりません（上の②）

**遅れた書き込みは、手順で見張るだけで、塞げてはいません。** 5 の 60 秒の見張りより後に届く書き込みは見逃します。
**アプリ側で塞ぐなら、現行のキーへの書き込みを排他のトークンに結び付ける必要があります**（例: 確定で行が指すまで、
トークンを含む別のキーに置き、確定の後に現行のキーへ移す）。**別 issue の候補です**（`src/` の変更は #445 の範囲外）。

**排他を無視して列を直さないこと**——保存の途中の要求が「確定が当たらなかった」として現行のキーを戻し
（`restoreIfHeld`。自分のトークンを持っている間だけ戻す）、消した画像が R2 に戻りえます。

**`avatar_set_at` を進めるので、利用者はそこから 60 秒は新しいアイコンを設定できません**（`acquireAvatarLock` の
382 行）。それ以上は止めません（同じ画像を上げ直されたら、もう一度この手順を打ちます。続くなら BAN を別に判断します）。

**D1 に記録の無い写しは、この手順では消せません。** アプリの保存・外すが現行の画像を `avatars/history/` へ写した後に
確定できなかったとき（`moveCurrentToHistory` の 560 行の後に失敗。戻しは現行のキーだけを戻す）、その写しは
`avatar_changes` に行を持たないまま残ります。**wrangler の `r2 object` には一覧のコマンドが無い**ので探さず、
ライフサイクル規則が 30 日で消します（`terraform/r2-lifecycle.tf`）。

**ブラウザに残った表示は消せません。** 一覧と作者ページは版つきの URL（`?v=`）で長くキャッシュさせて
いますが、**列を空にした時点で、その URL を指す HTML が出なくなります**（ヘッダの画像は毎回再検証する
ので、R2 から消した時点で透明な画像に替わり、既定の図形が見える）。

**措置の記録:** 削除依頼から来たときは、4 章の画面でその依頼にも措置と理由を記録します
（理由に「アイコン画像を削除した」と書く）。**アイコンそのものの記録は、手順の 4 で積んだ `avatar_changes` の 1 行です。**

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
- メールに**依頼者の連絡先も本文も入っていない**こと
- `scripts/takedown-queue.sh --remote` にその行が出ること

---

## 関連

- 条文: `/terms`（`src/legal.ts`）
- 受付: `src/takedown.ts` / `migrations/0018_takedown_requests.sql`
- 措置の記録（管理画面）: `src/admin/takedowns.ts` / `src/admin/actions.ts` の `recordTakedownAction` / `migrations/0031_admin_actions_takedown.sql`（手順は `docs/admin-host.md`）
- 通報と審査キュー（利用者からの通報。**権利者からの依頼とは別経路**）: [usage-report.md](usage-report.md)
- アイコン画像: `src/avatar.ts` / `src/avatar-delivery.ts` / `migrations/` の user_avatars / 保存期間の規則 `terraform/r2-lifecycle.tf`
