#!/usr/bin/env bash
# shoot-pages.sh — 全 SSR 画面を 1 コマンドで撮る（#303）
#
# ══════════════════════════════════════════════════════════════════════════════
# なぜこれが要るのか
# ══════════════════════════════════════════════════════════════════════════════
#
# **M8（#266 / #267 / #268）は、全画面を撮って見比べながら進めた。**
# #282 の 2 件（フッタ位置・スマホで縮む入力欄）も、M8-2 で CTA をボタンにした失敗も、
# **撮った 1 枚目で分かったもの**である——どれも `curl` も型検査も 1,400 件超のテストも
# 通り抜けている。**見た目は、見ないと分からない。**
#
# ══════════════════════════════════════════════════════════════════════════════
# 判定はしない
# ══════════════════════════════════════════════════════════════════════════════
#
# **これは道具であって検査ではない。** 見た目の良し悪しは機械が決めない（M8 の
# acceptance が「見た目の良し悪しは acceptance に入れない」と決めている）。
# 出すのは PNG と観測値だけで、判断するのは人である。
#
# 幅が端末に収まっているかの**合否**は `scripts/check-page-width.sh` が持つ。
#
# ══════════════════════════════════════════════════════════════════════════════
# scripts/verify.sh へは入れない
# ══════════════════════════════════════════════════════════════════════════════
#
# ブラウザの実行ファイルを前提にするうえ、そもそも合否を返さない。
# ループの接地信号に混ぜるものではない。
#
# 前提:
#   - Node.js 22 以降（`WebSocket` が組み込みであること）
#   - Chromium 系の実行ファイル。`GF_BROWSER_BIN` で渡すか、既知の場所に置く
#     （入手手順は `docs/local-dev.md`）
#
# 使い方:
#   bash scripts/shoot-pages.sh                     # dist/shots/ へ撮る
#   GF_SHOT_DIR=/tmp/before bash scripts/shoot-pages.sh
#   GF_SHOT_WIDTHS=360,768,1280 bash scripts/shoot-pages.sh
#
# **撮影物はコミットしない。** 既定の出力先は `dist/` の下（追跡除外）である。
#
# 終了コード: 0 = 撮れた / 非0 = 撮れなかった
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$(dirname "$HERE")"

OUT_DIR="${GF_SHOT_DIR:-dist/shots}"
WIDTHS="${GF_SHOT_WIDTHS:-390,1280}"
TIMEOUT_MS="${GF_SHOT_TIMEOUT_MS:-20000}"

fail() {
  printf '[shoot] %s\n' "$*" >&2
  exit 1
}

note() { printf '[shoot] %s\n' "$*"; }

# 下ごしらえ（ブラウザの解決・使い捨ての state・仕込み・セッション・dev サーバ）は
# `scripts/lib/dev-fixture.sh` が持つ。**幅の検査と同じものを使う。**
#
# **ポートを分ける。** 検査と撮影を続けて回すことがあるため。
export GF_FIXTURE_LABEL='[shoot]'
export GF_FIXTURE_PORT="${GF_SHOT_PORT:-8796}"

# shellcheck source=scripts/lib/dev-fixture.sh
. scripts/lib/dev-fixture.sh
trap dev_fixture_down EXIT
dev_fixture_up

# 経路の一覧は `/__dev/pages` から受け取る。**書き写さない**（#282 / #290）。
PATHS="$(dev_fixture_paths)"
COUNT="$(printf '%s\n' "$PATHS" | tr ',' '\n' | wc -l | tr -d ' ')"

# **1 枚も無い状態を成功にしない。** 導出が壊れて空になったとき、以下は「全部撮れた」を
# 返してしまう。
[[ "$COUNT" -ge 5 ]] || fail "撮影対象が ${COUNT} 経路しかありません。/__dev/pages の導出を確認してください。"

note "対象 ${COUNT} 経路 / 幅 ${WIDTHS} / 出力先 ${OUT_DIR}"

mkdir -p "$OUT_DIR"

node scripts/shoot-pages.mjs \
  --browser "$BROWSER_BIN" \
  --base "$BASE" \
  --out "$OUT_DIR" \
  --paths "$PATHS" \
  --widths "$WIDTHS" \
  --cookie "__Host-gf_session=$COOKIE_VALUE" \
  --timeout-ms "$TIMEOUT_MS" >"$WORK/shots.json" ||
  fail "撮影できませんでした。"

# **観測値のうち、後から効くものだけを 1 行にして出す。** 画像を開く前に
# 「土台に乗っているか」「非 200 が混ざっていないか」が読めると、見る枚数が減る。
node -e '
const fs = require("node:fs");
const { out, shots } = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
const widest = Math.max(...shots.map((s) => s.path.length));
for (const s of shots) {
  const css = s.stylesheets.length === 0 ? "css=なし" : `css=${s.stylesheets.length}`;
  const style = s.inlineStyles === 0 ? "" : ` <style>×${s.inlineStyles}`;
  const vp = s.viewport === null ? " viewport=なし" : "";
  const loaded = s.loaded ? "" : " 読み込み未完了";
  console.log(
    `  ${s.path.padEnd(widest)}  ${String(s.width).padStart(4)}×${String(s.height).padEnd(5)}` +
      ` ${s.status} ${css}${style}${vp}${loaded}`,
  );
}
console.log(`[shoot] ${shots.length} 枚を ${out} へ書きました。`);
' "$WORK/shots.json" || fail "観測結果を読めませんでした。"

echo "SHOT_PASS"
