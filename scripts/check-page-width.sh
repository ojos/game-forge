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
# **段を足すときは、この秒数を測り直すこと**——2.3.9 は「収まらなければ段を減らす」と
# 定めている。
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

# ── 実ブラウザで開く ──────────────────────────────────────────────────────────

node scripts/page-width-probe.mjs \
  --browser "$BROWSER_BIN" \
  --base "$BASE" \
  --paths "$PATHS" \
  --widths "$WIDTHS" \
  --cookie "__Host-gf_session=$COOKIE_VALUE" \
  --timeout-ms "$TIMEOUT_MS" >"$WORK/probe.json" ||
  fail "ブラウザでの観測ができませんでした。"

# ── 判定 ──────────────────────────────────────────────────────────────────────
#
# 判定はここが持つ（観測と判定を分ける理由は scripts/page-width-probe.mjs の冒頭）。
#
# **幅ごとに分けて数え、分けて報告する。** 「どこかで落ちた」ではなく「どの幅の
# どの画面か」が出ないと、3 段になった分だけ原因の切り分けが遠くなる。
node -e '
const fs = require("node:fs");
const { runs } = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
// **頼んだ幅がそのまま返ってきたことを先に見る。** 観測が 1 段も無い（または段が
// 欠けた）状態は、以下の判定では「すべて収まっている」になる。
const wanted = process.argv[2];
const got = runs.map((run) => run.width).join(",");
if (got !== wanted) {
  console.error(`[page-width] 観測した幅が ${got || "（無し）"} で、頼んだ ${wanted} と違います。`);
  process.exit(1);
}
let failed = 0;
for (const { width, observations } of runs) {
  const problems = [];
  for (const o of observations) {
    if (!o.loaded) {
      problems.push(`${o.path}: 読み込みが完了しませんでした`);
      continue;
    }
    if (o.status !== 200 && o.status !== 404) {
      // 404 は作品ページの「見つかりません」があるので通す。それ以外の非 200 は、
      // **画面を見ずに緑になっている**ことの現れなので落とす。
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
    console.error(`[page-width] 幅 ${width}px / ${problem}`);
  }
  if (problems.length > 0) {
    console.error(`[page-width] 幅 ${width}px: ${problems.length} 経路が収まっていません。`);
    failed += problems.length;
    continue;
  }
  console.log(`[page-width] 幅 ${width}px: ${observations.length} 経路すべてが収まっています。`);
}
if (failed > 0) {
  process.exit(1);
}
' "$WORK/probe.json" "$WIDTHS" || fail "幅の検査が通りませんでした。"

echo "PAGE_WIDTH_PASS"
