#!/usr/bin/env bash
# lib/showcase-fixture.sh — 運営報告の画像を撮るときの見せ方（#962）
#
# ══════════════════════════════════════════════════════════════════════════════
# 何をするか
# ══════════════════════════════════════════════════════════════════════════════
#
# `scripts/lib/dev-fixture.sh` の仕込みの中身を、**読者が見て機能が伝わる自然な中身**へ差し替える。
# 読み込むと `GF_FIXTURE_CONTENT=showcase` になり、`dev_fixture_up` は幅の検査の seed.sql の代わりに
# `showcase_fixture_write_seed` が書いた seed.sql を入れ、`showcase_fixture_put_assets` で公開作品の
# 紹介用の画像を置く。dev サーバ・セッション・後片付けは dev-fixture.sh のものをそのまま使う。
#
#   . scripts/lib/dev-fixture.sh
#   . scripts/lib/showcase-fixture.sh     # dev-fixture.sh の後に読む（読む順が逆だと幅の検査に戻る）
#   trap dev_fixture_down EXIT
#   dev_fixture_up
#
# ══════════════════════════════════════════════════════════════════════════════
# なぜ幅の検査の仕込みと分けるのか
# ══════════════════════════════════════════════════════════════════════════════
#
# 幅の検査の仕込みは、**わざと長い発言・20 通を超える履歴・長い題名**を入れて、画面が崩れないかを測る
# ためのものである（#715 / #726 / #739）。2026-09 の運営報告の画像に、その会話（「10 往復目: …」の繰り返し）
# がそのまま写った（#962）。読者向けに書き換えると幅の検査が弱くなるので、**撮影の中身はここに別に持つ。**
# 片方を変えても、もう片方は変わらない。
#
# ══════════════════════════════════════════════════════════════════════════════
# 中身の決まり
# ══════════════════════════════════════════════════════════════════════════════
#
# - 題名・会話・名前は、Game Forge で実際にありそうな短い自然な文にする。**実在の利用者の作品・名前は使わない。**
# - 日時は「いま」から数日前にする（1970-01-01 と出さない）。
# - **検査の文言（`SHOWCASE_FORBIDDEN_WORDS`）を書かない。** 撮った画面の本文にこれらが無いことを
#   `scripts/ops-report-images.sh` が確かめ、あれば画像を残さない。
# - 管理者にしない（ヘッダの管理の導線を写さない）。
# - id の変数名（`GAME_ID` / `PUBLISHED_GAME_ID` / `PLAIN_USER_ID` / `HANDLE`）は dev-fixture.sh と同じものを使う。
#   `dev_fixture_paths` が前方一致の経路をこれらで埋めるため。ここでは `GAME_ID` も公開済みの作品にする
#   （作品ページを、読者が見る公開の形で撮る）。
#
# `fail` と `note` は呼ぶ側が定義する（dev-fixture.sh と同じ）。

GF_FIXTURE_CONTENT=showcase

# 撮った画面の本文に出てはいけない語（幅の検査の仕込みに由来するもの）。
# `scripts/ops-report-images.sh` が撮った画面の本文（innerText と題名）をこの語で調べる。
# **ここの中身にこれらの語を書かない。** 書けば撮影が落ちるので、黙って写ることはない。
SHOWCASE_FORBIDDEN_WORDS=('幅の検査' '往復目' 'width_check' 'width-check' 'pagewidth' '検査用')

# 接続中のアプリの名前（`/account/apps`。dev-fixture.sh が KV へ置く許可の記録に使う）。
SHOWCASE_GRANT_CLIENT_NAME='Claude'

##
# 撮影の見せ方の seed.sql を書く。**`dev_fixture_up` の中から呼ばれる**（id の変数はそこで決まっている）。
#
# ハンドル名（`HANDLE`）と、ここで足す作品の id もここで決める。
#
# @param $1 書き出す SQL のパス
#
showcase_fixture_write_seed() {
  local out="$1"
  # 利用者の id も差し替える（セッションと接続中のアプリの記録は、この後で dev-fixture.sh がこの id で作る）。
  USER_ID="showcase-aoi"
  PLAIN_USER_ID="showcase-minato"
  HANDLE="aoi_makes"
  SHOWCASE_DRAFT_ID="$(node -e 'console.log(crypto.randomUUID())')"
  SHOWCASE_CAT_ID="$(node -e 'console.log(crypto.randomUUID())')"
  SHOWCASE_STAIRS_ID="$(node -e 'console.log(crypto.randomUUID())')"
  SHOWCASE_BLOCKS_ID="$(node -e 'console.log(crypto.randomUUID())')"
  SHOWCASE_CARDS_ID="$(node -e 'console.log(crypto.randomUUID())')"
  SHOWCASE_THIRD_USER_ID="showcase-third"

  note "seeding the showcase: three users, six published works and a draft, a chat conversation and a connected app"
  # 値は変数で埋める（dev-fixture.sh の seed.sql と同じく、ヒアドキュメントの中に逆引用符を書かない）。
  # 日時は秒の整数。「いま」から数日前にして、カードと表の日付を自然にする。
  cat >"$out" <<SQL
    insert into users (id, google_sub, email, display_name, created_at, bio, profile_links)
      values ('$USER_ID', 'sub-$USER_ID', 'aoi@example.invalid', 'あおい', strftime('%s', 'now') - 86400 * 40,
              '週末に小さなゲームを作っています。1 分くらいで遊べるものが好きです。', '[]');
    insert into handles (handle, user_id, claimed_at) values ('$HANDLE', '$USER_ID', strftime('%s', 'now') - 86400 * 40);
    insert into users (id, google_sub, email, display_name, created_at)
      values ('$PLAIN_USER_ID', 'sub-$PLAIN_USER_ID', 'minato@example.invalid', 'みなと', strftime('%s', 'now') - 86400 * 30);
    insert into users (id, google_sub, email, display_name, created_at)
      values ('$SHOWCASE_THIRD_USER_ID', 'sub-$SHOWCASE_THIRD_USER_ID', 'koharu@example.invalid', 'こはる',
              strftime('%s', 'now') - 86400 * 20);
    insert into games (id, author_id, status, title, go_version, created_at, published_at,
                       generation_state, preview_key, like_count, play_count, tag1, tag2,
                       source_key, wasm_key)
      values ('$GAME_ID', '$USER_ID', 'published', '星あつめジャンプ', '', strftime('%s', 'now') - 86400 * 3,
              strftime('%s', 'now') - 86400 * 3 + 3600, 'ready', 'showcase-stars', 18, 236, 'action', 'other',
              '$SOURCE_KEY', '$WASM_KEY');
    update games set description = '遊び方: 左右キーで動き、スペースキーでジャンプします。夜空から落ちてくる星を集めましょう。' ||
      char(10) || char(10) ||
      'ルール: 1 分たつと終わりです。ときどき落ちてくる岩に当たると、少しのあいだ動けなくなります。'
      where id = '$GAME_ID';
    insert into source_input_keys (source_key, codes, rule_version, extracted_at)
      values ('$SOURCE_KEY', '["ArrowLeft","ArrowRight","Space"]', 1, 1);
    insert into build_cache (source_sha256, go_version, source_key, wasm_key, wasm_bytes, wasm_sha256,
                             compressed_bytes, compressed_sha256, content_encoding, created_at)
      values ('$SOURCE_SHA', 'go1.26.5', '$SOURCE_KEY', '$WASM_KEY', 11404411, '$SOURCE_SHA',
              2282839, '$SOURCE_SHA', 'br', 1);
    insert into games (id, author_id, status, title, go_version, created_at, published_at,
                       generation_state, preview_key, like_count, play_count, tag1, source_key, wasm_key)
      values ('$PUBLISHED_GAME_ID', '$USER_ID', 'published', '30 秒よけゲーム', '', strftime('%s', 'now') - 86400 * 9,
              strftime('%s', 'now') - 86400 * 9 + 1800, 'ready', 'showcase-dodge', 7, 95, 'action',
              '$SOURCE_KEY', '$WASM_KEY');
    insert into games (id, author_id, status, title, go_version, created_at, generation_state, preview_key, tag1)
      values ('$SHOWCASE_DRAFT_ID', '$USER_ID', 'draft', '色そろえパズル', '', strftime('%s', 'now') - 86400,
              'ready', '$DRAFT_PREVIEW_KEY', 'puzzle');
    insert into games (id, author_id, status, title, go_version, created_at, published_at,
                       generation_state, preview_key, like_count, play_count, fork_count, tag1)
      values ('$SHOWCASE_CAT_ID', '$PLAIN_USER_ID', 'published', 'ねこの玉ころがし', '', strftime('%s', 'now') - 86400 * 6,
              strftime('%s', 'now') - 86400 * 6 + 600, 'ready', 'showcase-cat', 31, 412, 2, 'puzzle');
    insert into games (id, author_id, status, title, go_version, created_at, published_at,
                       generation_state, preview_key, like_count, play_count, tag1)
      values ('$SHOWCASE_STAIRS_ID', '$PLAIN_USER_ID', 'published', 'リズムで階段のぼり', '', strftime('%s', 'now') - 86400 * 4,
              strftime('%s', 'now') - 86400 * 4 + 900, 'ready', 'showcase-stairs', 12, 158, 'rhythm-sound');
    insert into games (id, author_id, status, title, go_version, created_at, published_at,
                       generation_state, preview_key, like_count, play_count, tag1)
      values ('$SHOWCASE_BLOCKS_ID', '$SHOWCASE_THIRD_USER_ID', 'published', '夜のブロック崩し', '', strftime('%s', 'now') - 86400 * 2,
              strftime('%s', 'now') - 86400 * 2 + 1200, 'ready', 'showcase-blocks', 9, 87, 'action');
    insert into games (id, author_id, status, title, go_version, created_at, published_at,
                       generation_state, preview_key, like_count, play_count, tag1)
      values ('$SHOWCASE_CARDS_ID', '$SHOWCASE_THIRD_USER_ID', 'published', 'どうぶつカードめくり', '', strftime('%s', 'now') - 86400 * 1,
              strftime('%s', 'now') - 86400 * 1 + 300, 'ready', 'showcase-cards', 5, 44, 'board-card');
    update games set ogp_state = 'ready', ogp_key = '$OGP_KEY' where id = '$PUBLISHED_GAME_ID';
    update games set ogp_state = 'ready', ogp_key = 'ogp/' || id || '/showcase.png'
      where id in ('$GAME_ID', '$SHOWCASE_CAT_ID', '$SHOWCASE_STAIRS_ID', '$SHOWCASE_BLOCKS_ID', '$SHOWCASE_CARDS_ID');
    -- チャットの会話（作品を作る画面）。3 往復で、2 回目の返事から【指示文】の下書きを出す（src/chat-prompt.ts の
    -- 「遅くとも 3 回目の返事までに」「毎回全文を出し直す」の形）。JSON の二重引用符はそのまま書く。
    insert into chat_conversations (id, user_id, messages, created_at, updated_at)
      values ('showcase-chat', '$USER_ID',
              '[{"role":"user","text":"空から落ちてくる星を集める、短いジャンプのゲームを作りたいです。"},{"role":"assistant","text":"楽しそうですね。1 回の遊びはどのくらいの長さにしますか。操作は左右の移動とジャンプでよいでしょうか。"},{"role":"user","text":"1 分くらいで、操作はそれで大丈夫です。"},{"role":"assistant","text":"では、まず下書きにします。\n\n【指示文】\n夜空から星が落ちてくる。左右キーで移動し、スペースキーでジャンプして星を集める。1 分たつと終わりで、集めた星の数を大きく出す。ときどき岩が落ちてきて、当たると 3 秒動けなくなる。"},{"role":"user","text":"岩は少なめにして、星を 10 個集めるごとに音が鳴るようにしたいです。"},{"role":"assistant","text":"岩を少なめにして、10 個ごとに音が鳴るようにしました。\n\n【指示文】\n夜空から星が落ちてくる。左右キーで移動し、スペースキーでジャンプして星を集める。1 分たつと終わりで、集めた星の数を大きく出す。ときどき岩が落ちてきて、当たると 3 秒動けなくなる。岩は少なめにする。星を 10 個集めるごとに短い効果音を鳴らす。"}]',
              strftime('%s', 'now') - 3600, strftime('%s', 'now') - 600);
SQL
}

##
# 公開作品の紹介用の画像を R2 へ置く。**`dev_fixture_up` の中から、seed.sql を入れた後に呼ばれる。**
#
# `PUBLISHED_GAME_ID` の画像（`OGP_KEY`）は dev-fixture.sh が置く。ここでは残りの公開作品に、
# 色の違う 1200 × 630 の PNG を 1 枚ずつ置く（カードに「画面の準備中」を並べない）。
#
showcase_fixture_put_assets() {
  local id fill accent index=0
  local fills=('#0b1d3a' '#1f4e3d' '#3b1f4e' '#101820' '#4e3b1f')
  local accents=('#ffec27' '#ff8fab' '#29adff' '#00e436' '#ffa300')
  for id in "$GAME_ID" "$SHOWCASE_CAT_ID" "$SHOWCASE_STAIRS_ID" "$SHOWCASE_BLOCKS_ID" "$SHOWCASE_CARDS_ID"; do
    fill="${fills[$index]}"
    accent="${accents[$index]}"
    index=$((index + 1))
    node -e '
const sharp = require("sharp");
const [file, fill, accent, seed] = process.argv.slice(1);
let n = Number(seed) * 7919;
const rand = () => { n = (n * 1103515245 + 12345) % 2147483648; return n / 2147483648; };
const dots = Array.from({ length: 14 }, () =>
  `<circle cx="${Math.round(rand() * 1200)}" cy="${Math.round(rand() * 400)}" r="${Math.round(8 + rand() * 22)}" fill="${accent}"/>`).join("");
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630">
<rect width="1200" height="630" fill="${fill}"/>${dots}
<rect x="0" y="520" width="1200" height="110" fill="#008751"/>
<rect x="560" y="440" width="80" height="80" fill="#fff1e8"/>
</svg>`;
sharp(Buffer.from(svg)).png().toFile(file).catch((error) => { console.error(error); process.exit(1); });
' "$WORK/showcase-ogp-$index.png" "$fill" "$accent" "$index" || fail "撮影用の紹介用の画像を作れませんでした。"
    npx wrangler r2 object put "$BUCKET_NAME/ogp/$id/showcase.png" --local --persist-to "$STATE" \
      --file "$WORK/showcase-ogp-$index.png" --content-type 'image/png' >"$WORK/r2-showcase-ogp.log" 2>&1 ||
      { sed 's/^/    /' "$WORK/r2-showcase-ogp.log" >&2; fail "撮影用の紹介用の画像を R2 へ置けませんでした。"; }
  done
}
