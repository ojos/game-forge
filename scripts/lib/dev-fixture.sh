#!/usr/bin/env bash
# lib/dev-fixture.sh — 実ブラウザで画面を開くための下ごしらえ（#303）
#
# ══════════════════════════════════════════════════════════════════════════════
# 何をするか
# ══════════════════════════════════════════════════════════════════════════════
#
#   1. ブラウザの実行ファイルを見つける（無ければ赤で落とす）
#   2. 使い捨ての `.wrangler` state を作り、D1 を仕込む（利用者の手元を汚さない）
#   3. 署名付きセッションを作る（ログインが要る画面まで開けるようにする）
#   4. dev サーバを HTTPS で起動し、応答するまで待つ
#
# 終わると、呼ぶ側は次を使える。
#
#   BROWSER_BIN         ブラウザの実行ファイル
#   BASE                https://<APP_HOST>:<PORT>
#   ADMIN_BASE          https://<ADMIN_HOST>:<PORT>（同じ dev サーバ。`src/index.ts` がホストで振り分ける）
#   COOKIE_VALUE        `__Host-gf_session` の値
#   GAME_ID             仕込んだ draft の作品の id（`/works/` の続きに使う）
#   PUBLISHED_GAME_ID   仕込んだ公開済みの作品の id（カードが並ぶ画面と、`/source/` の続きのため）
#   WORKING_GAME_ID     仕込んだ生成中の作品の id（エディットページの「生成中」を測るため。#664）
#   FAILED_GAME_ID      仕込んだ生成に失敗した作品の id（エディットページの「生成できませんでした」を測るため。#664）
#   GENERATING_GAME_ID  仕込んだ生成中で止まっている作品の id（#666。「あなたの作品」の表と一括の確認画面のため。
#                       `WORKING_GAME_ID` は作成の時刻が「いま」なので「時間がかかっています」を描かない）
#
# **公開済みの作品（`PUBLISHED_GAME_ID`）に、関連作品の 3 種類（フォーク元・フォーク先・同じタグ）を持たせる**（#665）。
# 無いと、作品ページの右カラム（`.gf-related`）が 1 度も描かれないまま幅の検査が緑になる。フォーク元と同じタグの作品は
# ハンドル名の無い利用者の作品にし、公開済みの作品に「…」メニュー（ソースへのリンク）が出ることも測る。下書き（`GAME_ID`）にも
# タグを 1 つ付け、作者の下書きのプレビューに関連作品の列が並ぶ形を測る。
#
# **エディットページ（`/works/<id>/edit`。#664）の 4 つの状態と、下書きのプレビュー（帯つきの作品ページ）を
# 測れるように仕込む。** エディットページは作品ページの前方一致の経路の続きなので `/__dev/pages` には出ない——
# 呼ぶ側（`scripts/check-page-width.sh`）が 4 つの id から足す。**仕込んだ利用者は 4 つの作品の作者である**ので、
# 同じ cookie で本体が開く（作者以外が開くと作品ページへ 303 で送り返され〔#690〕、エディットページを 1 度も描かないまま緑になる）。
# `GAME_ID`（下書き）は作者が開くので、`/works/$GAME_ID` は**下書きのプレビュー（帯つき）**になる。そのために
# 試遊の鍵も持たせる（無いとプレビューの埋め込みが描かれない）。
#
# **「あなたの作品」の表（#666）が 4 つの状態（公開中・下書き・生成中・失敗）をすべて描くように仕込む。** 生成中と失敗は
# #664 の `WORKING_GAME_ID` / `FAILED_GAME_ID` を使い、それに加えて止まっている生成中（札の外の「時間がかかっています」）を 1 件足す。こちらは、題名も 1 行に収まらない長さにしてある——
# 表の狭い列とカード表示で、いちばん折り返す形を 3 幅で測るためである。**公開済みの作品には紹介用の画像も置く**
# （`ogp_state = 'ready'` と R2 の実体）。置かないと、表の画像の枠もカードのスクリーンショットも「準備中」の形しか
# 描かれず、`<img>` の寸法を 1 度も測らないまま緑になる。
#
# **審査キューの公開作品は「撮影に失敗した」形にする**（`ogp_state = 'failed'`。PR #669）。表の画像の枠が「撮影中」と
# 「画像なし」を出し分けることを、画面でも見られるようにするためである。
#
# **公開済みの作品には、説明も入れる**（#627 / 仕様 5.4）。入れないと、遊ぶ枠の直前の折りたたみ
# （`.gf-work-description-peek`）と説明の本文が **1 度も描かれないまま幅の検査が緑になる**。
# 3 段落・約 180 字にしてあり、狭い段での折り返しも測れる。
#
# **引き換えに、説明がまだ無いことを作者へ伝える 1 行（#616）は幅の検査に出なくなる**——あれは
# 「説明が空のとき」にだけ出るためである。**本文と折りたたみのほうが面積が大きく、壊れ方も多い**ので
# こちらを取った（1 行のほうは単体テストが担保する）。公開済みの作品をもう 1 件仕込めば両方を測れるが、
# それは経路と仕込みを増やす話なので別に扱う。
#
# **作品には、読むキーの行（`source_input_keys`）も入れる**（#599 / 仕様 3.9.11）。
# 入れないと、作品ページのデスクトップの操作の案内（`.gf-key-legend`）が 1 度も描かれず、
# **幅の検査がその 1 行を見ないまま緑になる。** 集合は 9 つ（方向 4・Space・Z・X・Esc と、
# 文字を縮める `PrintScreen`）にしてあり、390px で札が折り返す形を測れる。
#
# **下書きの作品にも同じソースキーを持たせる。** `dev_fixture_paths` が作品ページに使うのは
# `GAME_ID`（下書き）のほうで、キーの行は `games.source_key` で結ぶ——公開済みの側だけに
# 入れても、**開かれる画面には案内が出ない。** 成果物が作品をまたいで共有されることは
# 確定26 が定めており、同じソースを 2 つの作品が指すのは平常の形である。
#
# **`scripts/check-sandbox-browser.sh` には影響しない**——あちらは自前のソースキーで
# 作品とキーの行を仕込む（同ファイルの「同じソースだと層 7 の作品にもパッドが出て」）。
#   USER_ID             仕込んだ利用者の id。**`is_admin = 1` を立ててある**
#                       （admin の画面を 404 でなく本体で開くため。#398）。**ハンドル名 `$HANDLE` を決めてある**（#381）
#   HANDLE              仕込んだ利用者のハンドル名（`/@` の続きに使う。#381。作品を持つ作者ページの本体はこの綴りで測る）
#   PLAIN_USER_ID       ハンドル名を決めていない利用者の id（`/users/` の続きに使う。#381——ハンドル名を決めた
#                       利用者の `/users/<id>` は `/@handle` へ 301 で送り、幅の検査は「別の画面へ移動した」として落とす）
#   WORK                使い捨ての作業場
#
# ══════════════════════════════════════════════════════════════════════════════
# なぜ共有するのか
# ══════════════════════════════════════════════════════════════════════════════
#
# **M8 で踏んだ失敗は、すべてここで起きた**（#303）——別の worktree でサーバを立てて
# いた / `certs/` が無い / 仕込みが別ツリーへ入った / 古い workerd がポートを掴んだまま /
# セッションを手で作り直した。**撮る部分では 1 度も失敗していない。**
#
# 幅の検査（`scripts/check-page-width.sh`）と撮影（`scripts/shoot-pages.sh`）が
# 同じ下ごしらえを要るので、**写しを作らずここへ置く**（shared-ai-rules 12 章）。
#
# ══════════════════════════════════════════════════════════════════════════════
# 使い方
# ══════════════════════════════════════════════════════════════════════════════
#
#   GF_FIXTURE_LABEL='[shoot]'
#   GF_FIXTURE_PORT=8795
#   . scripts/lib/dev-fixture.sh
#   trap dev_fixture_down EXIT
#   dev_fixture_up
#
# **`fail` と `note` は呼ぶ側が定義する。** 文言の接頭辞をそれぞれの道具が持つため。
#
# シェルの関数として読み込む前提なので `set -euo pipefail` はここで宣言しない
# （呼ぶ側の設定を上書きしない）。

: "${GF_FIXTURE_LABEL:=[dev-fixture]}"
: "${GF_FIXTURE_PORT:=8793}"

##
# 下ごしらえを行う。
#
# 失敗したら `fail` で落ちる（呼ぶ側が定義した関数）。
#
dev_fixture_up() {
  # ── 前提の確認 ────────────────────────────────────────────────────────────────
  #
  # **満たされないなら赤で落とす。** 「道具が無いので飛ばした」を緑にすると、
  # 検査していないことと、検査して通ったことが区別できなくなる。

  command -v node >/dev/null 2>&1 || fail "node が見つかりません。"
  command -v npx >/dev/null 2>&1 || fail "npx が見つかりません（wrangler の起動に使います）。"

  node -e 'if (typeof WebSocket !== "function") { process.exit(1) }' 2>/dev/null ||
    fail "この Node には WebSocket が組み込まれていません（Node 22 以降が要ります）: $(node --version)"

  BROWSER_BIN="${GF_BROWSER_BIN:-}"
  if [[ -z "$BROWSER_BIN" ]]; then
    # 既知の場所を順に見る。**playwright のキャッシュも見る**——冒頭の入手手順が
    # そこへ置くため、手順どおりに入れた人が毎回 GF_BROWSER_BIN を書く羽目にならない。
    while IFS= read -r candidate; do
      if [[ -n "$candidate" && -x "$candidate" ]]; then
        BROWSER_BIN="$candidate"
        break
      fi
    done < <(
      printf '%s\n' \
        /usr/bin/chromium /usr/bin/chromium-browser /usr/bin/google-chrome \
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
      ls -1d "${HOME}"/.cache/ms-playwright/chromium_headless_shell-*/chrome-linux/headless_shell \
        "${HOME}"/.cache/ms-playwright/chromium-*/chrome-linux/chrome 2>/dev/null | sort -r
    )
  fi
  [[ -n "$BROWSER_BIN" && -x "$BROWSER_BIN" ]] ||
    fail "Chromium の実行ファイルが見つかりません。GF_BROWSER_BIN で渡してください（入手手順はこのファイルの冒頭）。"
  note "browser: $BROWSER_BIN"

  # ホスト名は wrangler.toml の宣言から読む。**ここへ書き写さない**——設定を変えたときに
  # 検査だけが古いホストを見続ける（shared-ai-rules.md 12 章）。
  APP_HOST="$(sed -nE 's/^[[:space:]]*APP_HOST[[:space:]]*=[[:space:]]*"([^"]+)".*/\1/p' wrangler.toml | head -1)"
  [[ -n "$APP_HOST" ]] || fail "wrangler.toml から APP_HOST を読めませんでした。"
  # admin も同じ宣言から読む（#398）。**先頭の 1 つが開発の値である**（APP_HOST と同じ並び）。
  ADMIN_HOST="$(sed -nE 's/^[[:space:]]*ADMIN_HOST[[:space:]]*=[[:space:]]*"([^"]+)".*/\1/p' wrangler.toml | head -1)"
  [[ -n "$ADMIN_HOST" ]] || fail "wrangler.toml から ADMIN_HOST を読めませんでした。"

  # ── 使い捨ての作業場 ──────────────────────────────────────────────────────────
  #
  # **開発者の .wrangler/state を汚さない。** 検査のために作った `games` 行が手元へ残ると、
  # 次に画面を開いた人が「知らない作品」を見ることになる。
  #
  # **ここで `trap` を張らない。** 後片付けは `dev_fixture_down` が持ち、
  # `trap` は呼ぶ側が張る（このファイルの「使い方」）。ここでも張ると、呼ぶ側の
  # `trap dev_fixture_down EXIT` を黙って上書きする——**動いてはいるが、説明と実装が
  # 食い違う**（Copilot の指摘。2026-09-04）。
  WORK="$(mktemp -d "${TMPDIR:-/tmp}/gf-dev-fixture.XXXXXX")"
  DEV_PID=""

  STATE="$WORK/state"
  mkdir -p "$STATE"

  # ── D1 を仕込む ───────────────────────────────────────────────────────────────
  #
  # ログインが要る画面（`/works` / `/invites`）まで開く。**開かないと、それらの画面は
  # リダイレクトになり「幅は正しい」で緑になる。**

  SESSION_SECRET="page-width-check-secret-value-0123456789"
  USER_ID="pagewidth"
  PLAIN_USER_ID="pagewidth-plain"
  # ハンドル名（#381）。`/@` の続きに補う。形は `src/handle-paths.ts` の `HANDLE_PATTERN`。
  HANDLE="width_check"
  GAME_ID="$(node -e 'console.log(crypto.randomUUID())')"

  note "applying migrations"
  npx wrangler d1 migrations apply DB --local --persist-to "$STATE" >"$WORK/d1.log" 2>&1 ||
    { sed 's/^/    /' "$WORK/d1.log" >&2; fail "D1 のマイグレーションに失敗しました。"; }

  # **公開済みの作品には、ラベルの長いタグを 3 つ付ける**（#376）。タグ無しだと、カードの下段が
  # いちばん長くなる形（作者・いいね・日時・タグ 3 つ）を 390px で 1 度も測らないまま緑になる。
  #
  # **公開済みの作品も 1 件仕込む**（#330 / PR #350）。draft だけだと、カードが並ぶ画面
  # （トップ・公開一覧・作者ページ）がすべて「まだ公開された作品がありません」になり、
  # **`.gf-cards` の格子を 390px で 1 度も測らないまま緑になる。** 幅の検査が見たいのは
  # まさにその格子である。
  PUBLISHED_GAME_ID="$(node -e 'console.log(crypto.randomUUID())')"

  # **admin の画面が「測る対象」を持つように、審査キュー・履歴・削除依頼へ 1 行ずつ仕込む**
  # （#398 / #406。削除依頼は未対応のまま置き、措置の選択肢と理由の入力を測る）。
  # 空のままだと、審査キューの表も履歴の表も「まだありません」の 1 文になり、**狭い端末で
  # 崩れうる行（題名・理由の入力・ボタン）を 1 度も測らないまま緑になる**——公開済みの
  # 作品を仕込んだ理由（上）と同じ形である。
  #
  # **審査キューの作品は、上の 2 件とは別に作る。** 公開済みの作品を `queued` にすると、
  # 新規露出の面（トップ・公開一覧）から消え、**`.gf-cards` の格子を測れなくなる。**
  # 題名は 1 行に収まらない長さにする（行が折り返したときの高さと幅を測るため）。
  QUEUED_GAME_ID="$(node -e 'console.log(crypto.randomUUID())')"
  GENERATING_GAME_ID="$(node -e 'console.log(crypto.randomUUID())')"
  OGP_KEY="ogp/${PUBLISHED_GAME_ID}/width-check.png"

  # **エディットページの生成中・失敗の状態を測る作品**（#664）。生成中は作成の時刻を「いま」にする——古い時刻だと
  # 「中断した可能性」の表示になり、生成中の本来の画面を 1 度も測らない。下書き（`GAME_ID`）の試遊の鍵は 16 進 32 桁
  # （`src/games.ts` の `createPreviewKey` と同じ形）。
  WORKING_GAME_ID="$(node -e 'console.log(crypto.randomUUID())')"
  FAILED_GAME_ID="$(node -e 'console.log(crypto.randomUUID())')"
  DRAFT_PREVIEW_KEY="$(node -e 'console.log(require("node:crypto").randomBytes(16).toString("hex"))')"

  # **関連作品の 3 種類**（#665。冒頭の説明）。
  RELATED_PARENT_ID="$(node -e 'console.log(crypto.randomUUID())')"
  RELATED_FORK_ID="$(node -e 'console.log(crypto.randomUUID())')"
  RELATED_TAG_ID="$(node -e 'console.log(crypto.randomUUID())')"

  # **公開済みの作品に、ソースと配信サイズの索引を持たせる**（#383）。無いと、作品ページの
  # 詳細情報パネルは「Wasm のサイズ」とソースへのリンクを出さず、`/source/<id>` は
  # 「読み出せませんでした」の 1 文だけになり、**長い行を持つ `<pre>` を 3 幅で 1 度も
  # 測らないまま緑になる。** キーの綴りは本番と同じ形（`builds/<64 桁>/...`）にする
  # ——パネルは綴りから索引の主キーを切り出して引く（`src/work-page.ts` の `WORK_ROW_SQL`）。
  SOURCE_SHA="$(node -e 'console.log(require("node:crypto").randomBytes(32).toString("hex"))')"
  SOURCE_KEY="builds/${SOURCE_SHA}/source.go"
  WASM_KEY="builds/${SOURCE_SHA}/go1.26.5/game.wasm.br"
  # バケットの名前は wrangler.toml の宣言から読む（**先頭の 1 つが開発の値**。APP_HOST と同じ）。
  BUCKET_NAME="$(sed -nE 's/^[[:space:]]*bucket_name[[:space:]]*=[[:space:]]*"([^"]+)".*/\1/p' wrangler.toml | head -1)"
  [[ -n "$BUCKET_NAME" ]] || fail "wrangler.toml から R2 の bucket_name を読めませんでした。"

  note "seeding an admin user, six games (draft + published + queued + working + stalled + failed), the keys those games read, a report, a history row and a takedown request"
  npx wrangler d1 execute DB --local --persist-to "$STATE" --command "
    insert into users (id, google_sub, email, display_name, created_at, bio, profile_links)
      values ('$USER_ID', 'sub-$USER_ID', '$USER_ID@example.invalid', '幅の検査', 1,
              '幅の検査の自己紹介です。外部リンクは空白を持たない長い URL にしてあり、390px の版面で折り返すことを測ります。',
              '[\"https://example.com/width-check/a-very-long-path-without-any-spaces-that-must-wrap-at-390px-0123456789\"]');
    insert into games (id, author_id, status, title, go_version, created_at, generation_state, source_key, preview_key)
      values ('$GAME_ID', '$USER_ID', 'draft', '幅の検査の作品', '', 1, 'ready', '$SOURCE_KEY', '$DRAFT_PREVIEW_KEY');
    insert into games (id, author_id, status, title, go_version, created_at, generation_state, generation_started_at)
      values ('$WORKING_GAME_ID', '$USER_ID', 'draft', '幅の検査の生成中の作品', '', strftime('%s', 'now'), 'running',
              strftime('%s', 'now'));
    insert into games (id, author_id, status, title, go_version, created_at, generation_state, generation_error)
      values ('$FAILED_GAME_ID', '$USER_ID', 'draft', '幅の検査の生成に失敗した作品', '', 1, 'failed', 'source-rejected');
    insert into games (id, author_id, status, title, go_version, created_at, published_at,
                       generation_state, preview_key, like_count, play_count, tag1, tag2, tag3,
                       source_key, wasm_key)
      values ('$PUBLISHED_GAME_ID', '$USER_ID', 'published', '幅の検査の公開作品', '', 1, 1,
              'ready', 'width-check-preview', 3, 123456, 'puzzle', 'race-sports', 'rhythm-sound',
              '$SOURCE_KEY', '$WASM_KEY');
    insert into source_input_keys (source_key, codes, rule_version, extracted_at)
      values ('$SOURCE_KEY',
              '[\"ArrowLeft\",\"ArrowRight\",\"ArrowUp\",\"ArrowDown\",\"Space\",\"KeyZ\",\"KeyX\",\"Escape\",\"PrintScreen\"]',
              1, 1);
    update games set description = '遊び方: 左右キーで自機を動かし、スペースキーで弾を撃ちます。上から落ちてくるブロックに当たるとゲームオーバーです。' ||
      char(10) || char(10) ||
      'ルール: ブロックを撃つと得点が入ります。赤いブロックは 3 点、青いブロックは 1 点です。60 秒たつと終わりで、そのときの得点が出ます。' ||
      char(10) || char(10) ||
      'クレジット: 効果音は フリー素材サイト さんのものを使っています（CC BY 4.0）。元のアイデアは友人の作品から借りました。'
      where id = '$PUBLISHED_GAME_ID';
    insert into build_cache (source_sha256, go_version, source_key, wasm_key, wasm_bytes, wasm_sha256,
                             compressed_bytes, compressed_sha256, content_encoding, created_at)
      values ('$SOURCE_SHA', 'go1.26.5', '$SOURCE_KEY', '$WASM_KEY', 11404411, '$SOURCE_SHA',
              2282839, '$SOURCE_SHA', 'br', 1);
    update users set is_admin = 1 where id = '$USER_ID';
    insert into users (id, google_sub, email, display_name, created_at)
      values ('$PLAIN_USER_ID', 'sub-$PLAIN_USER_ID', '$PLAIN_USER_ID@example.invalid', '幅の検査（ハンドル名なし）', 1);
    insert into handles (handle, user_id, claimed_at) values ('$HANDLE', '$USER_ID', 1);
    insert into games (id, author_id, status, title, go_version, created_at, published_at,
                       generation_state, preview_key, review_state)
      values ('$QUEUED_GAME_ID', '$USER_ID', 'published',
              '幅の検査の審査キューに入っている作品で、題名が 1 行に収まらない長さになっているもの', '', 1, 1,
              'ready', 'width-check-queued', 'queued');
    insert into reports (id, game_id, reporter_id, reason, created_at)
      values ('width-check-report', '$QUEUED_GAME_ID', '$USER_ID', '幅の検査の通報', 2);
    insert into admin_actions (id, actor_id, created_at, action, target_kind, target_id, reason)
      values ('width-check-action', '$USER_ID', 3, 'review-queued', 'game', '$QUEUED_GAME_ID',
              '幅の検査の履歴の理由');
    update games set ogp_state = 'ready', ogp_key = '$OGP_KEY', fork_count = 12 where id = '$PUBLISHED_GAME_ID';
    update games set ogp_state = 'failed' where id = '$QUEUED_GAME_ID';
    insert into games (id, author_id, status, title, go_version, created_at, generation_state, generation_started_at)
      values ('$GENERATING_GAME_ID', '$USER_ID', 'draft',
              '幅の検査の生成中の作品で、題名が表の狭い列に 1 行では収まらない長さになっているもの', '', 2, 'running', 2);
    insert into takedown_requests
      (id, game_id, claimant_name, claimant_contact, body, received_at, handled_at, action, note)
      values ('width-check-takedown', '$PUBLISHED_GAME_ID', '幅の検査の依頼者',
              'width-check-claimant-with-a-long-address@example.invalid',
              '幅の検査の削除依頼の本文です。改行を含み、1 行に収まらない長さにしてあります。', 4,
              null, null, null);
    insert into games (id, author_id, status, title, go_version, created_at, published_at, generation_state, preview_key, tag1)
      values ('$RELATED_PARENT_ID', '$PLAIN_USER_ID', 'published', '幅の検査のフォーク元の作品', '', 1, 1, 'ready',
              'width-check-related-parent', 'puzzle');
    update games set parent_id = '$RELATED_PARENT_ID' where id = '$PUBLISHED_GAME_ID';
    insert into games (id, author_id, status, title, go_version, created_at, published_at, generation_state, preview_key, parent_id)
      values ('$RELATED_FORK_ID', '$PLAIN_USER_ID', 'published',
              '幅の検査のフォーク先の作品で、題名が関連作品の列では 2 行に折り返す長さになっているもの', '', 1, 2, 'ready',
              'width-check-related-fork', '$PUBLISHED_GAME_ID');
    insert into games (id, author_id, status, title, go_version, created_at, published_at, generation_state, preview_key, tag1)
      values ('$RELATED_TAG_ID', '$PLAIN_USER_ID', 'published', '幅の検査の同じタグの作品', '', 1, 3, 'ready',
              'width-check-related-tag', 'rhythm-sound');
    update games set tag1 = 'puzzle' where id = '$GAME_ID';
  " >"$WORK/seed.log" 2>&1 ||
    { sed 's/^/    /' "$WORK/seed.log" >&2; fail "検査用の行を作れませんでした。"; }

  # **ソースの本体を R2 へ置く**（#383）。**空白を持たない長い行**（配列リテラル・文字列）と、
  # 日本語の長いコメントを含める——`<pre>` は折り返さないので、`<pre>` の中だけが横に送られ、
  # ページ全体が横スクロールしないことを 390px で測る。
  node -e '
const long = Array.from({ length: 120 }, (_, i) => `0x${(i * 2654435761 % 4294967296).toString(16).padStart(8, "0")}`).join(",");
const text = [
  "package main",
  "",
  "// 幅の検査のソースです。長い行が折り返されず、pre の中だけが横に送られることを確かめます。",
  "import \"github.com/hajimehoshi/ebiten/v2\"",
  "",
  `var table = []uint32{${long}}`,
  `var label = "${"とても長い文字列".repeat(40)}"`,
  "",
  "func main() { _ = ebiten.RunGame(nil) }",
  "",
].join("\n");
require("node:fs").writeFileSync(process.argv[1], text);
' "$WORK/source.go" || fail "検査用のソースを作れませんでした。"
  npx wrangler r2 object put "$BUCKET_NAME/$SOURCE_KEY" --local --persist-to "$STATE" \
    --file "$WORK/source.go" --content-type 'text/plain; charset=utf-8' >"$WORK/r2.log" 2>&1 ||
    { sed 's/^/    /' "$WORK/r2.log" >&2; fail "検査用のソースを R2 へ置けませんでした。"; }

  # **紹介用の画像を R2 へ置く**（#666。上の冒頭の注記）。1200 × 630 の PNG を `sharp`（devDependencies）で描く
  # ——**色を持つのは作品だけ**（仕様 2.5.2）なので、ゲームの画面らしい色の塊にしてある。
  node -e '
const sharp = require("sharp");
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630">
<rect width="1200" height="630" fill="#1d2b53"/>
<rect x="80" y="420" width="1040" height="60" fill="#008751"/>
<rect x="520" y="340" width="80" height="80" fill="#ffec27"/>
<circle cx="300" cy="200" r="60" fill="#ff004d"/>
<circle cx="900" cy="160" r="40" fill="#29adff"/>
</svg>`;
sharp(Buffer.from(svg)).png().toFile(process.argv[1]).catch((error) => { console.error(error); process.exit(1); });
' "$WORK/ogp.png" || fail "検査用の紹介用の画像を作れませんでした。"
  npx wrangler r2 object put "$BUCKET_NAME/$OGP_KEY" --local --persist-to "$STATE" \
    --file "$WORK/ogp.png" --content-type 'image/png' >"$WORK/r2-ogp.log" 2>&1 ||
    { sed 's/^/    /' "$WORK/r2-ogp.log" >&2; fail "検査用の紹介用の画像を R2 へ置けませんでした。"; }

  # セッションの署名は `src/session.ts` と同じ形（`<base64url(JSON)>.<base64url(HMAC)>`）。
  # **秘密はこの検査の中だけで作って渡す。** `.dev.vars` を読まないのは、開発者の環境に
  # 依存しない検査にするためであり、値をどこにも書き残さないためでもある。
  COOKIE_VALUE="$(node -e '
  const crypto = require("node:crypto");
  const b64u = (buf) => Buffer.from(buf).toString("base64").replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
  const now = Math.floor(Date.now() / 1000);
  const body = b64u(Buffer.from(JSON.stringify({ userId: process.argv[2], issuedAt: now, expiresAt: now + 3600 }), "utf8"));
  const signature = crypto.createHmac("sha256", process.argv[1]).update(body).digest();
  console.log(body + "." + b64u(signature));
  ' "$SESSION_SECRET" "$USER_ID")"

  # ── dev サーバを起動する ──────────────────────────────────────────────────────
  #
  # **HTTPS で起動する。** セッション cookie は `__Host-` 接頭辞を持ち、ブラウザは
  # `Secure` でなければ受理しない（`src/app.ts` の DEV_SESSION_COOKIE の説明）。
  # 証明書は自己署名で、ブラウザ側で明示的に無視する（検査対象は TLS ではない）。
  bash scripts/dev-certs.sh >/dev/null

  note "starting wrangler pages dev on :$GF_FIXTURE_PORT"
  set -m
  env CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV=false \
    npx wrangler pages dev \
    --ip 127.0.0.1 \
    --port "$GF_FIXTURE_PORT" \
    --local-protocol https \
    --https-key-path certs/dev.key \
    --https-cert-path certs/dev.crt \
    --persist-to "$STATE" \
    --binding "SESSION_SECRET=$SESSION_SECRET" \
    --show-interactive-dev-session false \
    >"$WORK/dev.log" 2>&1 &
  DEV_PID=$!
  set +m

  BASE="https://${APP_HOST}:${GF_FIXTURE_PORT}"
  ADMIN_BASE="https://${ADMIN_HOST}:${GF_FIXTURE_PORT}"

  # 起動を待つ。**固定の sleep にしない**——遅い環境で「起動前に叩いて赤」になると、
  # 実装の問題と区別できない。
  ready=0
  for _ in $(seq 1 60); do
    if curl -sk --max-time 3 --resolve "${APP_HOST}:${GF_FIXTURE_PORT}:127.0.0.1" -o /dev/null "${BASE}/"; then
      ready=1
      break
    fi
    if ! kill -0 "$DEV_PID" 2>/dev/null; then
      break
    fi
    sleep 1
  done
  if [[ "$ready" -ne 1 ]]; then
    sed 's/^/    /' "$WORK/dev.log" >&2
    fail "dev サーバが応答しませんでした（${BASE}）。"
  fi
}

##
# 後片付け。**呼ぶ側が `trap dev_fixture_down EXIT` を張る。**
#
dev_fixture_down() {
  if [[ -n "${DEV_PID:-}" ]]; then
    # プロセスグループごと落とす。wrangler は workerd を子として持つため、
    # 親だけを落とすと workerd がポートを掴んだまま残る（M8 で 3 度踏んだ）。
    kill -- "-$DEV_PID" 2>/dev/null || kill "$DEV_PID" 2>/dev/null || true
    wait "$DEV_PID" 2>/dev/null || true
  fi
  if [[ -n "${WORK:-}" ]]; then
    rm -rf "$WORK"
  fi
}

##
# 経路表から SSR 画面のパスを受け取る（`/__dev/pages`）。
#
# **一覧を書き写さない。** 導出の正本は `src/page-paths.ts` で、`/__dev/pages` が
# それを返す（#282 / #290）。
#
# ## 前方一致の経路には、接頭辞ごとに違う id を補う（#330 / PR #350）
#
# **どれにも作品の id を補うと、別の表を指す画面は 404 しか見られない。** 作者ページ
# （`/users/<user_id>`）へ作品の id を渡すと 404 になり、`check-page-width.sh` は
# 404 を通す（「作品ページの『見つかりません』があるので通す」）ので、**画面の本体を
# 1 度も開かないまま緑になる。** #330 の実装中に実際にそうなっていた。
#
# **綴りの正本はコードにある**——`/works/` は `src/paths.ts` の `WORK_PAGE_PREFIX`、
# `/users/` は `src/users-page-paths.ts` の `AUTHOR_PAGE_PREFIX`、`/source/` は
# `src/work-source.ts` の `WORK_SOURCE_PREFIX`、`/@` は `src/handle-paths.ts` の `HANDLE_PAGE_PREFIX`（#381）。
# **シェルからは
# import できないので、ここは写しである。** 腐らせないために、**知らない接頭辞が来たら
# 落とす**（下）。同じ規則を `test/page-shell.test.ts` の `prefixIds` が定数から組み立てて
# いるので、綴りを変えれば必ずどちらかが赤くなる。
#
# @return カンマ区切りのパス（標準出力）
#
dev_fixture_paths() {
  curl -sk --max-time 10 --resolve "${APP_HOST}:${GF_FIXTURE_PORT}:127.0.0.1" \
    -o "$WORK/pages.json" "${BASE}/__dev/pages" ||
    fail "/__dev/pages を取得できませんでした。DEV_ROUTES が enabled であることを確認してください。"

  node -e '
const fs = require("node:fs");
const { paths } = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
if (!Array.isArray(paths) || paths.length === 0) {
  console.error("/__dev/pages が画面のパスを返しませんでした");
  process.exit(1);
}

// 接頭辞 → 補う id。**画面を 1 枚足した人にここを決めさせる。**
const ids = new Map([
  ["/works/", process.argv[2]],
  ["/users/", process.argv[3]],
  // ソースの閲覧（#383）は公開済みの作品にしか開けない。draft の id では 404 しか測れない。
  ["/source/", process.argv[4]],
  // ハンドル名の作者ページ（#381）。1 セグメントの経路で、接頭辞は `/` で終わらない。
  ["/@", process.argv[5]],
]);

// **続きを補う経路**: `/` で終わる前方一致の接頭辞と、**記号で終わる 1 セグメントの経路の接頭辞**
// （`src/routes.ts` の `segment` の規約。`/@`）。**JSON は `match` を運ばないので綴りで見る**——
// 完全一致の画面は英字・数字・`/` で終わる。
const openEnded = (path) =>
  (path.endsWith("/") && path !== "/") || /[^A-Za-z0-9_.~\/-]$/u.test(path);

const filled = paths.map((path) => {
  if (!openEnded(path)) {
    return path;
  }
  const id = ids.get(path);
  if (id === undefined) {
    // **黙って裸の接頭辞を返さない。** 返すと、その画面は 404 だけを見られて緑になる。
    console.error(
      `前方一致の経路 ${path} に補う id が決まっていません。` +
        "scripts/lib/dev-fixture.sh の dev_fixture_paths と" +
        " test/page-shell.test.ts の prefixIds の両方へ足してください。",
    );
    process.exit(1);
  }
  return path + id;
});
console.log(filled.join(","));
' "$WORK/pages.json" "$GAME_ID" "$PLAIN_USER_ID" "$PUBLISHED_GAME_ID" "$HANDLE" || fail "画面の一覧を読めませんでした。"
}

##
# admin ホストの SSR 画面のパスを受け取る（`/__dev/pages` の `adminPaths`。2.4.5 / #398）。
#
# **口は app ホストの `/__dev/pages` を使う。** admin ホストに診断経路は置いていない
# （`src/app.ts` の `/__dev/pages` の注記）。**`dev_fixture_paths` を先に呼んでおくこと**
# ——取得した JSON を使い回す。
#
# **admin にはまだ前方一致の経路が無い。** 来たら黙って裸の接頭辞を返さず落とす
# （`test/admin-page-shell.test.ts` の getPaths と同じ規律）。
#
# @return カンマ区切りのパス（標準出力）
#
dev_fixture_admin_paths() {
  [[ -f "$WORK/pages.json" ]] || fail "dev_fixture_paths を先に呼んでください（/__dev/pages を取得していません）。"

  node -e '
const fs = require("node:fs");
const { adminPaths } = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
if (!Array.isArray(adminPaths) || adminPaths.length === 0) {
  console.error("/__dev/pages が admin の画面のパスを返しませんでした（adminPaths）");
  process.exit(1);
}
for (const path of adminPaths) {
  if (path.endsWith("/") && path !== "/") {
    console.error(
      `admin の前方一致の経路 ${path} に補う id が決まっていません。` +
        "scripts/lib/dev-fixture.sh の dev_fixture_admin_paths と" +
        " test/admin-page-shell.test.ts の getPaths の両方へ足してください。",
    );
    process.exit(1);
  }
}
console.log(adminPaths.join(","));
' "$WORK/pages.json" || fail "admin の画面の一覧を読めませんでした。"
}
