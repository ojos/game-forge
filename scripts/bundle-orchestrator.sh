#!/usr/bin/env bash
# bundle-orchestrator.sh — オーケストレータ Lambda の配備物を組み立てる（#160）
#
# **成果物はコミットしない**（shared-ai-rules 2 章「再生成できる大容量の生成物は
# コミットしない」）。出力先の dist/ は .gitignore で追跡から外してある。宣言
# （terraform/orchestrator.tf）が持つのは仮のコードだけで、本物はこのスクリプトが
# 作り、scripts/deploy-orchestrator.sh が載せる。
#
# ## なぜ束ねるのか
#
# **`src/` を書き直さないためである**（#160 の制約）。5.2-5 の許可パッケージ検査
# （src/go-imports.ts / src/go-import-allowlist.ts）は #17 が仕様書と機械照合している
# セキュリティ層で、Go で書き直すと複製が生まれる（shared-ai-rules 12 章）。
# Node へそのまま載せるには、TypeScript を 1 ファイルの ESM へ束ねるのが一番短い。
#
# 依存は aws4fetch だけで、あとは global fetch と WebCrypto である。どちらも
# Node 22 のランタイムが持っている。
#
# ## esbuild はどこから来るか
#
# **wrangler / vite が連れてくる**（node_modules/.bin/esbuild）。package.json の
# devDependencies へ直接足していないのは、この環境でロックファイルを更新するには
# ネットワークが要り、**それを配備スクリプトの前提にしたくない**ためである。
# 無ければ理由付きで落ちる（下記）。
#
# 使い方:
#   bash scripts/bundle-orchestrator.sh
#
# 出力:
#   dist/orchestrator/index.mjs   束ねた ESM（Lambda の handler は index.handler）
#   dist/orchestrator.zip         配備物
#
# 終了コード: 0 = 成功 / 非0 = 失敗
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$(dirname "$HERE")"

ENTRY="src/orchestrator/handler.ts"
OUT_DIR="dist/orchestrator"
OUT_FILE="$OUT_DIR/index.mjs"
ZIP="dist/orchestrator.zip"
ESBUILD="node_modules/.bin/esbuild"

if [[ ! -f "$ENTRY" ]]; then
  echo "[bundle-orchestrator] エントリが見つかりません: $ENTRY" >&2
  exit 1
fi

if [[ ! -x "$ESBUILD" ]]; then
  echo "[bundle-orchestrator] esbuild がありません: $ESBUILD" >&2
  echo "[bundle-orchestrator] npm ci を実行してください（wrangler の依存として入ります）。" >&2
  exit 1
fi

command -v zip >/dev/null 2>&1 || {
  echo "[bundle-orchestrator] zip コマンドがありません。" >&2
  exit 1
}

rm -rf "$OUT_DIR" "$ZIP"
mkdir -p "$OUT_DIR"

echo "[bundle-orchestrator] esbuild $ENTRY -> $OUT_FILE"
# --platform=node で Node の組み込みを外部化する。**このコードは node: を 1 つも
# import していない**ので実際には何も外部化されないが、明示しておくと、うっかり
# 足したときにバンドルへ取り込まれて壊れるのではなく、素直に require される。
#
# --format=esm で `export { handler }` を保つ。Lambda の Node ランタイムは
# 拡張子 .mjs を ESM として読む（package.json を zip へ入れずに済む）。
"$ESBUILD" "$ENTRY" \
  --bundle \
  --platform=node \
  --target=node22 \
  --format=esm \
  --legal-comments=none \
  --outfile="$OUT_FILE"

# **時刻を固定して zip を作る。** 固定しないと、同じソースからでも毎回違う
# CodeSha256 になり、「載っているコードが手元と同じか」を機械で確かめられない
# （scripts/acceptance-remote.sh の orchestrator code matches the local bundle）。
touch -t 202001010000.00 "$OUT_FILE"
( cd "$OUT_DIR" && zip -q -X ../orchestrator.zip index.mjs )

BYTES="$(wc -c <"$ZIP" | tr -d ' ')"
SHA="$(openssl dgst -sha256 -binary "$ZIP" | base64)"
echo "[bundle-orchestrator] $ZIP (${BYTES} bytes)"
echo "[bundle-orchestrator] CodeSha256: $SHA"
echo "BUNDLE_PASS"
