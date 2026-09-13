#!/usr/bin/env bash
# check-page-width.sh — 全 SSR 画面が、3 段すべての幅に収まっていることを実ブラウザで確かめる（#282 / #371）
#
# ══════════════════════════════════════════════════════════════════════════════
# なぜ実ブラウザが要るのか
# ══════════════════════════════════════════════════════════════════════════════
#
# **#282 の 2 件目は、機械的な代理検査を全部すり抜けた。** 削除申請フォームの
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
# 実行時間は 14 経路 × 3 幅で**実測 12.0 秒**である（2026-09-12。1 幅だった #282 のときが
# 8.9 秒で、増えたのは 3.1 秒——**ブラウザと dev サーバの起動が費用の大半で、幅を足しても
# 増えない**。ブラウザの起動は 1 回だけ。`scripts/page-width-probe.mjs`）。
# **#398 で admin の 3 経路を足して、app 19 経路 ＋ admin 3 経路 × 3 幅で実測 17.2 秒**
# （2026-09-13。ブラウザの起動は観測 1 回につき 1 度なので、admin の観測で 1 回増えた）。
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
#   1280 デスクトップ。器の上限（80rem = 1280px）にちょうど届く幅で、
#        **器が広がりきったところ**を見る。
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

COUNT="$(printf '%s\n' "$PATHS" | tr ',' '\n' | wc -l | tr -d ' ')"
note "対象 ${COUNT} 経路 / 幅 ${WIDTHS}"

# **1 枚も無い状態を緑にしない。** 導出が壊れて空になったとき、以下の判定は
# 「すべて収まっている」を返してしまう。
[[ "$COUNT" -ge 5 ]] || fail "検査対象が ${COUNT} 経路しかありません。/__dev/pages の導出を確認してください。"

ADMIN_PATHS="$(dev_fixture_admin_paths)"
ADMIN_COUNT="$(printf '%s\n' "$ADMIN_PATHS" | tr ',' '\n' | wc -l | tr -d ' ')"
note "admin の対象 ${ADMIN_COUNT} 経路 / 幅 ${WIDTHS}"

# **admin も空を緑にしない。** いまは審査キュー・利用者・履歴の 3 枚がある（2.3.1 の admin の表）。
[[ "$ADMIN_COUNT" -ge 3 ]] || fail "admin の検査対象が ${ADMIN_COUNT} 経路しかありません。/__dev/pages の adminPaths を確認してください。"

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
      const finalPath = o.responseUrl === null ? null : new URL(o.responseUrl).pathname;
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
judge(process.argv[3], "admin", { expectMenu: false, allow404: false });
if (failed > 0) {
  process.exit(1);
}
' "$WORK/probe.json" "$WIDTHS" "$WORK/admin-probe.json" || fail "幅の検査が通りませんでした。"

echo "PAGE_WIDTH_PASS"
