#!/usr/bin/env bash
# check-page-width.sh — 全 SSR 画面が、3 段すべての幅に収まっていることを実ブラウザで確かめる（#282 / #371）
#
# ══════════════════════════════════════════════════════════════════════════════
# なぜ実ブラウザが要るのか
# ══════════════════════════════════════════════════════════════════════════════
#
# **#282 の 2 件目は、機械的な代理検査を全部すり抜けた。** 削除依頼フォームの
# `size="50"` は、幅 390px の端末で **layout viewport を 498px へ広げる**。
#
#   - `meta[name=viewport]` は `width=device-width, initial-scale=1` で正しく入っている
#     → viewport の検査は緑のまま
#   - HTML の文字列照合では「属性が 1 つある」以上のことが分からない
#   - `curl` はレイアウトを組まない
#
# **レイアウトを組んだブラウザだけが捕まえられる。** これは #180 が
# 「CSP は許しているのに CORS が塞ぐ」で通り抜けたのと同じ構造である
# （`docs/handoff.md` 4 章「実物を通すまで、動いているかは分からない」）。
#
# ══════════════════════════════════════════════════════════════════════════════
# なぜ画面の一覧を持たないのか
# ══════════════════════════════════════════════════════════════════════════════
#
# **パスをここへ書き並べない。** 書き並べると、画面を 1 枚足した日から検査だけが
# 古い一覧を見続ける（`.ai-playbook/shared-ai-rules.md` 12 章）。この検査が捕まえたい
# のはまさに「足した画面が土台に乗っていない」ことなので、一覧を写した時点で目的を失う。
#
# 一覧は **`/__dev/pages`** から受け取る。あれは `src/page-paths.ts` の導出を通して
# 経路表そのものを読んでおり、`test/page-shell.test.ts` と同じ一覧になる。
#
# ══════════════════════════════════════════════════════════════════════════════
# なぜ scripts/verify.sh のローカル層に入れないのか
# ══════════════════════════════════════════════════════════════════════════════
#
# **ブラウザの実行ファイルを前提にするため**である。ループの接地信号
# （`.ai-playbook/loop-workflow.md`）が道具の有無で止まると、実装が正しいのに
# ループが止まる。`scripts/check-sandbox-browser.sh` を単一入口へ含めていないのと
# 同じ理由で、この検査も**画面を触ったときに手で回す層**に置く。
#
# 前提:
#   - Node.js 22 以降（`WebSocket` が組み込みであること。CDP を素で話す）
#   - Chromium 系の実行ファイル。`GF_BROWSER_BIN` で渡すか、既知の場所に置く
#
# Chromium の入手（この devcontainer で実測した手順）:
#   npm i playwright-core && npx playwright install chromium-headless-shell
#   sudo npx playwright install-deps chromium-headless-shell
#
# ══════════════════════════════════════════════════════════════════════════════
# なぜ 3 つの幅で回すのか（#371）
# ══════════════════════════════════════════════════════════════════════════════
#
# **画面幅を 3 段で持つと決めた**（2.3.9）。段ごとに器の上限・ガター・カラムの数が
# 変わるので、**1 幅だけを見る検査は、残り 2 段を 1 度も見ないまま緑になる。**
#
# 幅と段の対応が崩れていないことは `scripts/check-app-css.sh` が機械照合する
# （CSS の `@media` から段を導き、下の既定値がその全部の段を覆っているかを見る）。
# **だから、この既定値と CSS のどちらか片方だけを変えると落ちる。**
#
# 実行時間は **app 19 経路 ＋ admin 3 経路 × 3 幅で実測 17.2 秒**である（2026-09-13 / #398。
# ブラウザの起動は観測 1 回につき 1 度なので、admin の観測で 1 回増えた）。
# **経過:** 1 幅だった #282 のときが 8.9 秒、3 幅にした #371 のとき（14 経路。2026-09-12）が
# 12.0 秒で、増えたのは 3.1 秒だった——**ブラウザと dev サーバの起動が費用の大半で、幅を
# 足しても増えない**（`scripts/page-width-probe.mjs`）。
# **段を足すときは、この秒数を測り直すこと**——2.3.9 は「収まらなければ段を減らす」と
# 定めている。
#
# ══════════════════════════════════════════════════════════════════════════════
# アカウントのメニューを、JavaScript を止めて開閉する（#372）
# ══════════════════════════════════════════════════════════════════════════════
#
# **ヘッダのアバターのドロップダウンは JavaScript を要求しない**（2.3.7 v1.57。
# `<details>` / `<summary>`）。幅ごとにトップを **JavaScript を止めて**開き直し、
# 閉じた状態で配られること、**Enter で開いて閉じ、クリックで開くこと**、開いた中身
# （ログアウトのボタンまで）が**その幅に収まること**、読み上げに名前と開閉の状態が
# 渡ることを見る。
#
# **ここに載せるのは、開いた中身も「幅に収まっているか」の対象だからである。** 閉じた
# 状態だけを見る判定は、開くと横にはみ出すメニューを通してしまう。**開くのは 1 画面だけ**
# で足りる——メニューは全画面で同じ外枠が出しており、それは `test/page-shell.test.ts`
# が全画面 × ログイン両状態で照合している。**開く画面はトップ（`/`）にする。** 経路表に
# 必ずあり、ログイン済みの cookie で開けばメニューが出る。
#
# ══════════════════════════════════════════════════════════════════════════════
# admin の画面も同じ網に乗せる（2.4.5 / #398）
# ══════════════════════════════════════════════════════════════════════════════
#
# **運営の管理画面（`ADMIN_HOST`）も 3 幅すべてで開く。** 2.4.5 は「乗せない選択を
# 採らない」と定め、その理由に「#282 が捕まえたい失敗は、**運営しか見ない画面でこそ
# 起きやすい**」を挙げている。
#
#   - **dev サーバは 1 つのまま**である。`*.localtest.me` は公開 DNS が 127.0.0.1 を返し、
#     `src/index.ts` が `Host` で振り分けるので、2 つ目を起動する必要が無い
#   - **一覧は `/__dev/pages` の `adminPaths` から受け取る**（`scripts/lib/dev-fixture.sh` の
#     `dev_fixture_admin_paths`）。admin ホストに診断経路は置いていない
#   - **仕込む利用者に `is_admin = 1` を立ててある**（同ファイル）。**立て忘れると、ブラウザが
#     見るのは 404 だけになる**——#330 が実際に踏んだ「画面を 1 度も開かずに緑」の形
#
# **admin では 404 を通さない。** app の側は作品ページの「見つかりません」があるので 404 を
# 通すが、**admin の画面は権限が無いときにだけ 404 を返す**（2.4.2）。admin で 404 を見た
# ことは、そのまま「仕込みか cookie が効いていない」ことを意味する。
#
# **アカウントのメニューは admin では開かない。** admin の外枠はメニューを持たない
# （`src/admin/shell.ts`。ヘッダとフッタは app と別）。
#
# 使い方:
#   bash scripts/check-page-width.sh
#   GF_BROWSER_BIN=/path/to/headless_shell bash scripts/check-page-width.sh
#   GF_PAGE_WIDTHS=360 bash scripts/check-page-width.sh
#
# 終了コード: 0 = PAGE_WIDTH_PASS / 1 = 収まっていない・検査不能
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$(dirname "$HERE")"

# 幅の既定は 3 段から 1 つずつ取る（2.3.9。段の境界は `public/assets/app.css` が正本）。
#
#   390  スマホ。iPhone 系の論理幅として広く使われる値で、#282 の実測もこの幅。
#        **この下限を緩めない**（2.3.9）。これより狭い端末は存在するので、
#        「収まることの下限の保証」ではなく「よくある狭い端末で壊れていない」を見る値である。
#   768  タブレット段の下限。**段が切り替わるまさにその幅**を見る。
#   1280 デスクトップ。器の上限（65.5rem = 1048px）を超える幅で、器が
#        中央に置かれ、左右に等しい余白が出ることまで含めて観測する。
#        **1048 に変えない**——1048 は段 2 の範囲なので、段 3 が無検査になる（#761）。
#
# **この行の綴りは `scripts/check-app-css.sh` が読む。** 変えるなら、あちらの
# 読み取り（sed）も一緒に直すこと。
WIDTHS="${GF_PAGE_WIDTHS:-390,768,1280}"
# **空白を落として正規化する。** 観測側（`scripts/page-width-probe.mjs`）は要素ごとに
# `trim()` するので `'390, 768, 1280'` も受け付ける。正規化せずに渡すと、**幅の検査は
# 通っているのに、下の「頼んだ幅と返ってきた幅」の突き合わせだけが必ず落ちる**
# （Copilot の指摘。2026-09-12）。
WIDTHS="$(printf '%s' "$WIDTHS" | tr -d '[:space:]')"
TIMEOUT_MS="${GF_PAGE_WIDTH_TIMEOUT_MS:-20000}"

# 下ごしらえ（ブラウザの解決・使い捨ての state・仕込み・セッション・dev サーバ）は
# `scripts/lib/dev-fixture.sh` が持つ。**撮影（#303）と同じものを使う。**
export GF_FIXTURE_LABEL='[page-width]'
export GF_FIXTURE_PORT="${GF_PAGE_WIDTH_PORT:-8793}"

fail() {
  printf '[page-width] %s\n' "$*" >&2
  exit 1
}

note() { printf '[page-width] %s\n' "$*"; }

# shellcheck source=scripts/lib/dev-fixture.sh
. scripts/lib/dev-fixture.sh
trap dev_fixture_down EXIT
dev_fixture_up
# ── 検査対象の一覧を経路表から受け取る ────────────────────────────────────────
#
# 導出は `scripts/lib/dev-fixture.sh` の `dev_fixture_paths` が持つ（#303）。

PATHS="$(dev_fixture_paths)"

# **公開済みの作品ページも開く**（#622）。`dev_fixture_paths` の `/works/` に入るのは下書きの
# `GAME_ID` 1 枚だけである——接頭辞ごとに補う id を 1 つしか決められないため（同関数の `ids`）。
# そのため **公開後の画面は 1 度も開かれていなかった。** あちらには下書きには無いものが並ぶ
# （埋め込みの枠・4 要素のブロック・タグ・共有 URL・改造の一覧・詳細情報パネル）。
#
# **この 1 行は接頭辞の仕組みの外で足している。** `dev_fixture_paths` を「接頭辞ごとに複数の id」
# へ広げる手もあるが、**足したいのは 1 枚だけ**で、経路表の導出（#303）はそのままにしておくほうが
# 読み手にとって単純である。cookie は作者本人のものなので、**作者にしか出ない行**も測れる。
PATHS="${PATHS},/works/${PUBLISHED_GAME_ID}"

# **他人の公開済みの作品ページも開く**（#767）。通報のフォームは「ログインしていて作者でない人」にしか出ない
# ので、作者本人の cookie で開く上の 1 枚には描かれない。**描かれないまま、送信ボタンの置き場所の判定が緑に
# なっていた**（PR #768 の Copilot の指摘。docs/handoff.md 3 章「仕込みに無いものは測れない」）。仕込みの
# フォーク元の作品（作者は `pagewidth-plain`）を開く。
PATHS="${PATHS},/works/${RELATED_PARENT_ID}"
export GF_REPORT_PATH="/works/${RELATED_PARENT_ID}"

# **エディットページの 4 つの状態も開く**（#664。下書き・公開・生成中・失敗）。エディットページは作品ページの
# 前方一致の経路の続き（`/works/<id>/edit`）なので `/__dev/pages` に出ない。**足さないと、2 列のフォームと
# プレビュー・公開設定を 1 度も描かないまま緑になる。** cookie は 4 つの作品の作者のものである（作者以外は作品ページへ
# 303 で送り返される。#690）。**下書きのプレビュー（帯つきの作品ページ）は、上の `/works/${GAME_ID}` が既に開いている**
# ——作者が下書きを作品ページで開くとプレビューになる（`scripts/lib/dev-fixture.sh` の冒頭）。
for edit_id in "$GAME_ID" "$PUBLISHED_GAME_ID" "$WORKING_GAME_ID" "$FAILED_GAME_ID"; do
  PATHS="${PATHS},/works/${edit_id}/edit"
done

# **「あなたの作品」の一括操作の確認画面も開く**（#666）。経路表から導く `/works/mine/bulk` は問い合わせを持たないので、
# 「作品が選ばれていません」の画面しか描かない。**3 つの操作それぞれで、対象と「対象から外す作品」の両方が並ぶ形**を
# 足す（公開: 下書きが対象で、公開中と生成中を外す／下書きへ戻す: 公開中が対象で、下書きを外す／削除: 下書きと失敗が
# 対象で、公開中を外す）。**問い合わせの綴りは `src/works-bulk-paths.ts` の写しである**（シェルからは import できない。
# 変われば、確認画面が「選ばれていません」になり、下の最終 URL の照合ではなく目視と単体テストが気づく）。
BULK="/works/mine/bulk?action"
PATHS="${PATHS},${BULK}=publish&game_id=${GAME_ID}&game_id=${PUBLISHED_GAME_ID}&game_id=${GENERATING_GAME_ID}"
PATHS="${PATHS},${BULK}=unpublish&game_id=${PUBLISHED_GAME_ID}&game_id=${GAME_ID}"
PATHS="${PATHS},${BULK}=delete&game_id=${GAME_ID}&game_id=${FAILED_GAME_ID}&game_id=${PUBLISHED_GAME_ID}"

# **チャットの画面は、対象つきの 2 枚も開く**（#727 / 確定38）。`/generate` は `/__dev/pages` に出るが、
# **対象は問い合わせで渡す**ので、出るのは「新しく作る」の 1 枚だけである。**足さないと、
# リフォージとフォークのチャット（見出し・説明・主のボタン・対象ごとのフォーム）を 1 度も描かないまま
# 緑になる**（docs/handoff.md 3 章「仕込みに無いものは測れない」）。
#
# **リフォージは自分の下書き、フォークは公開済みの作品を指す**——どちらも仕込んだ作品で、
# cookie はその作者のものである。**引数の綴りは `src/chat-target.ts` の写しである**（シェルからは
# import できない。変われば、画面が「新しく作る」に倒れ、下の目視と単体テストが気づく）。
PATHS="${PATHS},/generate?revise=${GAME_ID}"
PATHS="${PATHS},/generate?fork=${PUBLISHED_GAME_ID}"

COUNT="$(printf '%s\n' "$PATHS" | tr ',' '\n' | wc -l | tr -d ' ')"
note "対象 ${COUNT} 経路 / 幅 ${WIDTHS}"

# **1 枚も無い状態を緑にしない。** 導出が壊れて空になったとき、以下の判定は
# 「すべて収まっている」を返してしまう。
[[ "$COUNT" -ge 5 ]] || fail "検査対象が ${COUNT} 経路しかありません。/__dev/pages の導出を確認してください。"

ADMIN_PATHS="$(dev_fixture_admin_paths)"
ADMIN_COUNT="$(printf '%s\n' "$ADMIN_PATHS" | tr ',' '\n' | wc -l | tr -d ' ')"
note "admin の対象 ${ADMIN_COUNT} 経路 / 幅 ${WIDTHS}"

# **admin も空を緑にしない。** いまは審査キュー・利用者・削除依頼・履歴の 4 枚がある
# （2.3.1 の admin の表。#406 で削除依頼を足した）。
[[ "$ADMIN_COUNT" -ge 4 ]] || fail "admin の検査対象が ${ADMIN_COUNT} 経路しかありません。/__dev/pages の adminPaths を確認してください。"

# ── 実ブラウザで開く ──────────────────────────────────────────────────────────

node scripts/page-width-probe.mjs \
  --browser "$BROWSER_BIN" \
  --base "$BASE" \
  --paths "$PATHS" \
  --widths "$WIDTHS" \
  --cookie "__Host-gf_session=$COOKIE_VALUE" \
  --timeout-ms "$TIMEOUT_MS" \
  --menu-path / >"$WORK/probe.json" ||
  fail "ブラウザでの観測ができませんでした。"

# admin は同じ cookie を admin のホストへ載せて開く（セッションの読み方は app と同じ
# `resolveSessionUser`。cookie は host-only なので、base のホストへ付け直される）。
node scripts/page-width-probe.mjs \
  --browser "$BROWSER_BIN" \
  --base "$ADMIN_BASE" \
  --paths "$ADMIN_PATHS" \
  --widths "$WIDTHS" \
  --cookie "__Host-gf_session=$COOKIE_VALUE" \
  --timeout-ms "$TIMEOUT_MS" >"$WORK/admin-probe.json" ||
  fail "admin の画面をブラウザで観測できませんでした。"

# ── 判定 ──────────────────────────────────────────────────────────────────────
#
# 判定はここが持つ（観測と判定を分ける理由は scripts/page-width-probe.mjs の冒頭）。
#
# **幅ごとに分けて数え、分けて報告する。** 「どこかで落ちた」ではなく「どの幅の
# どの画面か」が出ないと、3 段になった分だけ原因の切り分けが遠くなる。
node -e '
const fs = require("node:fs");
const wanted = process.argv[2];
let failed = 0;
/**
 * 文字の塊を必ず観測する経路（#763 / #767）。**フォームと説明文を持つ画面**で、段 3 で文字や面の右に
 * 空きが残っていた。**ここに挙げた経路で 1 つも観測できなければ落とす**——仕込みや経路が変わって塊が
 * 描かれなくなると、文字の幅の判定は空のまま緑になる。`/authorize` は dev fixture ではクライアントの
 * 引数を持たず、面の無い断りの画面になるので挙げない。
 */
const BLOCK_TEXT_PATHS = ["/account", "/account/details", "/account/chat", "/account/mail", "/account/apps", "/invites", "/takedown"];
/**
 * 版面（42rem）で止めると決めた塊（#764 / #767）。**会話のログは読む面**なので、区画が器いっぱいに広がっても
 * 672px で止める。**#767 で文字の塊の上限を全体で外した後も、例外はこの 1 つだけ**である。上限を超えていないことは、
 * 下の 1 カラムの判定が見る。
 */
const KEPT_AT_MEASURE = ["ol.gf-chat-log"];
/** 版面の幅（`public/assets/app.css` の `--gf-measure`。42rem = 672px。1rem = 16px の前提）。会話のログの上限に使う。 */
const MEASURE_PX = 672;
/** 段 3 を代表する観測の幅（面が器いっぱいに広がり、上限が効く幅）。 */
const WIDEST = Math.max(...wanted.split(",").map(Number));
const seenBlockText = new Set();
/** 1 カラムの画面（#764）。生成画面の 3 つの対象（新しく作る・リフォージ・フォーク）を必ず観測する。 */
const seenColumn = new Set();
let seenInputs = 0;
let seenSubmits = 0;
/** 通報のフォームを持つ画面（#767）。畳んだ口の中の送信ボタンを必ず観測する。 */
const REPORT_PATH = process.env.GF_REPORT_PATH || "";
let seenReport = 0;
/**
 * アカウントのメニューの観測値を判定する（#372。観測は scripts/page-width-probe.mjs）。
 *
 * **観測が 1 つでも欠けたら落とす。** メニューが無い・読み込めなかった状態を
 * 「開閉の問題は無かった」で通さない。
 */
function menuProblems(width, menu) {
  const where = menu && menu.url ? new URL(menu.url).pathname : "（未観測）";
  const problems = [];
  const fail = (message) => problems.push(`アカウントのメニュー（${where}）: ${message}`);
  if (menu === null || menu === undefined) {
    fail("観測されていません（--menu-path が渡っていない）");
    return problems;
  }
  if (!menu.loaded) {
    fail("JavaScript を止めた状態で読み込みが完了しませんでした");
    return problems;
  }
  if (menu.scriptsDisabled !== true) {
    fail("JavaScript が止まっていません（止めた状態での開閉を確かめられない）");
  }
  if (!menu.initial || menu.initial.present !== true) {
    fail("ヘッダにメニューがありません（ログイン済みの cookie で開いているか確認）");
    return problems;
  }
  if (menu.initial.open !== false || menu.initial.logoutRendered !== false) {
    fail("読み込んだ直後から開いています");
  }
  const within = (label, state) => {
    if (!state || state.open !== true) {
      fail(`${label}で開きませんでした`);
      return;
    }
    if (state.logoutRendered !== true) {
      fail(`${label}で開いたのに、ログアウトのボタンが描かれていません`);
    }
    if (state.listLeft < 0 || state.listRight > width) {
      fail(`${label}で開いた中身が幅からはみ出しています（left=${state.listLeft} / right=${state.listRight} / 端末 ${width}px）`);
    }
    if (state.innerWidth !== width || state.scrollWidth > width) {
      fail(`${label}で開くと横にはみ出します（innerWidth=${state.innerWidth} / scrollWidth=${state.scrollWidth}）`);
    }
  };
  within("Enter", menu.openedByKey);
  if (!menu.closedByKey || menu.closedByKey.open !== false || menu.closedByKey.logoutRendered !== false) {
    fail("もう一度 Enter を押しても閉じませんでした");
  }
  within("クリック", menu.openedByClick);
  const ax = menu.accessible || {};
  if (ax.name !== "アカウントのメニュー") {
    fail(`読み上げに渡る名前が「${ax.name}」です（role=${ax.role}）`);
  }
  if (ax.expanded !== true) {
    fail(`開いたのに、読み上げに「開いている」が渡っていません（expanded=${ax.expanded}）`);
  }
  return problems;
}
/**
 * 1 つのホストの観測を判定する。
 *
 * @param file 観測の JSON（scripts/page-width-probe.mjs の出力）
 * @param host 報告に出すホストの名前
 * @param expectMenu アカウントのメニューを観測しているはずか（app だけ）
 * @param allow404 404 を通すか（app だけ。admin の 404 は「権限が効いていない」である）
 */
function judge(file, host, { expectMenu, allow404 }) {
  const { runs } = JSON.parse(fs.readFileSync(file, "utf8"));
  // **頼んだ幅がそのまま返ってきたことを先に見る。** 観測が 1 段も無い（または段が
  // 欠けた）状態は、以下の判定では「すべて収まっている」になる。
  const got = runs.map((run) => run.width).join(",");
  if (got !== wanted) {
    console.error(`[page-width] ${host}: 観測した幅が ${got || "（無し）"} で、頼んだ ${wanted} と違います。`);
    failed += 1;
    return;
  }
  for (const { width, observations, menu } of runs) {
    const problems = expectMenu ? menuProblems(width, menu) : [];
    if (!expectMenu && menu !== null && menu !== undefined) {
      problems.push("アカウントのメニューを観測しています（このホストでは開かない）");
    }
    for (const o of observations) {
      if (!o.loaded) {
        problems.push(`${o.path}: 読み込みが完了しませんでした`);
        continue;
      }
      if (o.status !== 200 && !(allow404 && o.status === 404)) {
        // app の 404 は作品ページの「見つかりません」があるので通す。それ以外の非 200 は、
        // **画面を見ずに緑になっている**ことの現れなので落とす。**admin は 404 も落とす**
        // ——admin の 404 は権限が無いときの応答で（2.4.2）、仕込みか cookie が効いていない。
        problems.push(`${o.path}: 応答が ${o.status}（最終 URL: ${o.responseUrl}）`);
        continue;
      }
      // **ステータスだけではリダイレクトを検出できない。** 303 を返した経路でも、
      // ブラウザが追跡した先の 200 で上書きされる。**要求したパスと最終パスを突き合わせる**
      // ——そうしないと、ログインへ飛ばされた画面を「幅は正しい」で通してしまう
      // （第二意見の指摘。#282）。
      // **問い合わせまで含めて照合する**（#666 で問い合わせ付きの確認画面を足した。問い合わせの無い経路は
      // `search` が空なので、これまでと同じ照合になる）。
      const finalPath = o.responseUrl === null ? null : new URL(o.responseUrl).pathname + new URL(o.responseUrl).search;
      if (finalPath !== o.path) {
        problems.push(`${o.path}: 別の画面へ移動しました（最終 URL: ${o.responseUrl}）`);
        continue;
      }
      if (o.innerWidth !== width) {
        problems.push(
          `${o.path}: layout viewport が ${o.innerWidth}px（端末は ${width}px）。` +
            `いちばん右まで出ている要素: ${o.widest} → right=${o.widestRight}`,
        );
        continue;
      }
      if (o.scrollWidth > width) {
        problems.push(
          `${o.path}: 横に ${o.scrollWidth}px はみ出しています（端末は ${width}px）。` +
            `いちばん右まで出ている要素: ${o.widest} → right=${o.widestRight}`,
        );
      }
      // **文字の塊は、親の内側の右端まで届く**（#763 / #767）。1px までは丸めの差として許す。
      for (const text of o.blockText || []) {
        if (text.gap > 1 && !KEPT_AT_MEASURE.includes(text.element)) {
          problems.push(`${o.path}: ${text.inside} の中の ${text.element} の右に ${text.gap}px の空きがあります（親の幅で組まれていない）`);
        }
      }
      // **入力欄は、フォームの内側いっぱいに広がる**（#767。#763 の「672px を超えない」を置き換えた）。
      for (const input of o.inputs || []) {
        if (input.gap > 1) {
          problems.push(`${o.path}: 入力欄 ${input.element} の右に ${input.gap}px の空きがあります（幅 ${input.width}px。フォームの内側いっぱいではない）`);
        }
      }
      // **入力欄のあるフォームの送信ボタンは、行の右端に置く**（#767）。
      for (const submit of o.submits || []) {
        if (submit.gap > 1) {
          problems.push(`${o.path}: ${submit.form} の ${submit.element} の右に ${submit.gap}px の空きがあります（行の右端に置かれていない）`);
        }
      }
      if (width === WIDEST && BLOCK_TEXT_PATHS.includes(o.path)) {
        seenBlockText.add(o.path);
        if ((o.blockText || []).length === 0) {
          problems.push(`${o.path}: 文字の塊を 1 つも観測できませんでした（文字の幅の判定が空のまま緑になる）`);
        }
      }
      if (width === WIDEST) {
        seenInputs += (o.inputs || []).length;
        seenSubmits += (o.submits || []).length;
        if (o.path === REPORT_PATH) {
          seenReport += (o.submits || []).length;
        }
      }
      // **1 カラムの画面は、他のページと同じ左端・同じ幅に組む**（#764。生成画面）。
      if (o.column) {
        const c = o.column;
        const need = (label, ok, detail) => { if (!ok) problems.push(`${o.path}: ${label}（${detail}）`); };
        const missing = ["breadcrumb", "column", "chat", "log", "field", "form"].filter((key) => c[key] === null);
        if (missing.length > 0) {
          problems.push(`${o.path}: 1 カラムの部品を観測できませんでした: ${missing.join(", ")}`);
        } else {
          need("パンくずの左端が器の左端と揃っていません", c.breadcrumb.left === c.shellLeft, `パンくず ${c.breadcrumb.left} / 器 ${c.shellLeft}`);
          need("1 カラムが器の幅いっぱいではありません", c.column.left === c.shellLeft && c.column.right === c.shellRight, `1 カラム ${c.column.left}〜${c.column.right} / 器 ${c.shellLeft}〜${c.shellRight}`);
          need("チャットの面の右端が器の右端と一致しません", c.chat.right === c.shellRight, `面 ${c.chat.right} / 器 ${c.shellRight}`);
          need("会話のログが版面より広がっています", c.log.width <= MEASURE_PX, `ログ ${c.log.width}px / 上限 ${MEASURE_PX}px`);
          need("指示文の欄が面の内側いっぱいではありません", Math.abs(c.field.right - c.form.innerRight) <= 1, `欄の右端 ${c.field.right} / フォームの内側の右端 ${c.form.innerRight}`);
        }
      }
      if (width === WIDEST && o.path.startsWith("/generate")) {
        seenColumn.add(o.path);
        if (!o.column) {
          problems.push(`${o.path}: 1 カラム（div.gf-column）を観測できませんでした（生成画面の置き方の判定が空のまま緑になる）`);
        }
      }
    }
    for (const problem of problems) {
      console.error(`[page-width] ${host} / 幅 ${width}px / ${problem}`);
    }
    if (problems.length > 0) {
      console.error(`[page-width] ${host} / 幅 ${width}px: ${problems.length} 件の問題があります。`);
      failed += problems.length;
      continue;
    }
    console.log(
      `[page-width] ${host} / 幅 ${width}px: ${observations.length} 経路すべてが収まっています` +
        (expectMenu ? "（アカウントのメニューは JavaScript を止めて開閉でき、開いても収まっています）。" : "。"),
    );
  }
}
judge(process.argv[1], "app", { expectMenu: true, allow404: true });
// **観測すべき経路を観測したかを、app の判定の後で見る**（#763）。経路表から消えた経路を黙って通さない。
for (const path of BLOCK_TEXT_PATHS) {
  if (!seenBlockText.has(path)) {
    console.error(`[page-width] app / 幅 ${WIDEST}px / ${path}: 経路を観測していません（面の中の文字の判定の対象）`);
    failed += 1;
  }
}
if (seenColumn.size < 3) {
  console.error(`[page-width] app / 幅 ${WIDEST}px: 生成画面を ${seenColumn.size} 枚しか観測していません（新しく作る・リフォージ・フォークの 3 枚）`);
  failed += 1;
}
if (REPORT_PATH === "" || seenReport === 0) {
  console.error(`[page-width] app / 幅 ${WIDEST}px: 通報のフォームの送信ボタンを観測できませんでした（${REPORT_PATH || "経路が渡っていない"}。畳んだ口の中のボタンの判定が空のまま緑になる）`);
  failed += 1;
}
if (seenSubmits === 0) {
  console.error(`[page-width] app / 幅 ${WIDEST}px: 入力欄のあるフォームの送信ボタンを 1 つも観測できませんでした（ボタンの置き場所の判定が空のまま緑になる）`);
  failed += 1;
}
if (seenInputs === 0) {
  console.error(`[page-width] app / 幅 ${WIDEST}px: 入力欄を 1 つも観測できませんでした（入力欄の幅の判定が空のまま緑になる）`);
  failed += 1;
}
judge(process.argv[3], "admin", { expectMenu: false, allow404: false });
if (failed > 0) {
  process.exit(1);
}
' "$WORK/probe.json" "$WIDTHS" "$WORK/admin-probe.json" || fail "幅の検査が通りませんでした。"

echo "PAGE_WIDTH_PASS"
