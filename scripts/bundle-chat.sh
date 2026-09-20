#!/usr/bin/env bash
# bundle-chat.sh — 相談の Lambda を 1 ファイルへ束ねる（#695 / 仕様 5.16）
#
# `scripts/bundle-orchestrator.sh` と同じ形である。違うのは入口と出力先だけで、
# **束ね方（esbuild のフラグ・zip の時刻の固定）は同じにしてある**——ずらすと、
# 「載っているコードが手元と同じか」の確かめ方が関数ごとに変わる。
#
# ## オーケストレータの束と混ぜない
#
# **別の zip・別の関数である。** これが #695 で関数を分けた理由そのもので
# （仕様 5.16）、`scripts/orchestrator-bundle-changed.sh` の判定にこの入口は入らない。
# **相談を直してもオーケストレータの配り直しは要らない。**
#
# 使い方:
#   bash scripts/bundle-chat.sh
#
# 出力:
#   dist/chat/index.mjs   束ねた ESM（Lambda の handler は index.handler）
#   dist/chat.zip         配備物
#
# 終了コード: 0 = 成功 / 非0 = 失敗
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$(dirname "$HERE")"

ENTRY="src/chat/handler.ts"
OUT_DIR="dist/chat"
OUT_FILE="$OUT_DIR/index.mjs"
ZIP="dist/chat.zip"
ESBUILD="node_modules/.bin/esbuild"

if [[ ! -f "$ENTRY" ]]; then
  echo "[bundle-chat] エントリが見つかりません: $ENTRY" >&2
  exit 1
fi

if [[ ! -x "$ESBUILD" ]]; then
  echo "[bundle-chat] esbuild がありません: $ESBUILD" >&2
  echo "[bundle-chat] npm ci を実行してください（wrangler の依存として入ります）。" >&2
  exit 1
fi

command -v zip >/dev/null 2>&1 || {
  echo "[bundle-chat] zip コマンドがありません。" >&2
  exit 1
}

command -v openssl >/dev/null 2>&1 || {
  echo "[bundle-chat] openssl がありません（CodeSha256 の計算に要ります）。" >&2
  exit 1
}

rm -rf "$OUT_DIR" "$ZIP"
mkdir -p "$OUT_DIR"

echo "[bundle-chat] esbuild $ENTRY -> $OUT_FILE"
"$ESBUILD" \
  "$ENTRY" \
  --bundle \
  --platform=node \
  --target=node22 \
  --format=esm \
  --legal-comments=none \
  --outfile="$OUT_FILE"

# **時刻を固定して zip を作る**（`scripts/bundle-orchestrator.sh` と同じ理由。
# 固定しないと、同じソースからでも毎回違う CodeSha256 になる）。
touch -t 202001010000.00 "$OUT_FILE"
( cd "$OUT_DIR" && zip -q -X ../chat.zip index.mjs )

BYTES="$(wc -c <"$ZIP" | tr -d ' ')"
SHA="$(openssl dgst -sha256 -binary "$ZIP" | base64)"
echo "[bundle-chat] $ZIP (${BYTES} bytes)"
echo "[bundle-chat] CodeSha256: $SHA"
echo "BUNDLE_PASS"
