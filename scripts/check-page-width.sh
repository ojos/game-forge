#!/usr/bin/env bash
# check-page-width.sh — 全 SSR 画面が、狭い端末の幅に収まっていることを実ブラウザで確かめる（#282）
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
# 使い方:
#   bash scripts/check-page-width.sh
#   GF_BROWSER_BIN=/path/to/headless_shell bash scripts/check-page-width.sh
#   GF_PAGE_WIDTH=360 bash scripts/check-page-width.sh
#
# 終了コード: 0 = PAGE_WIDTH_PASS / 1 = 収まっていない・検査不能
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$(dirname "$HERE")"

# 幅の既定を 390 にする。iPhone 系の論理幅として広く使われる値で、#282 の実測もこの幅。
# **これより狭い端末は存在する。** 収まることの下限を保証する値ではなく、
# 「よくある狭い端末で壊れていない」を見る値である。
WIDTH="${GF_PAGE_WIDTH:-390}"
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
note "対象 ${COUNT} 経路 / 幅 ${WIDTH}px"

# **1 枚も無い状態を緑にしない。** 導出が壊れて空になったとき、以下の判定は
# 「すべて収まっている」を返してしまう。
[[ "$COUNT" -ge 5 ]] || fail "検査対象が ${COUNT} 経路しかありません。/__dev/pages の導出を確認してください。"

# ── 実ブラウザで開く ──────────────────────────────────────────────────────────

node scripts/page-width-probe.mjs \
  --browser "$BROWSER_BIN" \
  --base "$BASE" \
  --paths "$PATHS" \
  --width "$WIDTH" \
  --cookie "__Host-gf_session=$COOKIE_VALUE" \
  --timeout-ms "$TIMEOUT_MS" >"$WORK/probe.json" ||
  fail "ブラウザでの観測ができませんでした。"

# ── 判定 ──────────────────────────────────────────────────────────────────────
#
# 判定はここが持つ（観測と判定を分ける理由は scripts/page-width-probe.mjs の冒頭）。
node -e '
const fs = require("node:fs");
const { width, observations } = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
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
  console.error(`[page-width] ${problem}`);
}
if (problems.length > 0) {
  console.error(`[page-width] ${problems.length} 経路が幅 ${width}px に収まっていません。`);
  process.exit(1);
}
console.log(`[page-width] ${observations.length} 経路すべてが幅 ${width}px に収まっています。`);
' "$WORK/probe.json" || fail "幅の検査が通りませんでした。"

echo "PAGE_WIDTH_PASS"
