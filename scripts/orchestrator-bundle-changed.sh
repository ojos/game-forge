#!/usr/bin/env bash
# orchestrator-bundle-changed.sh — オーケストレータの束が、この差分で変わったか
#
# Worker を配る直前の関門（#241）を起動するかどうかを決める。**起動しなければ
# AWS を 1 度も読まない**（外部の可用性を配備の前提条件へ持ち込まないため。
# .github/project-ai-rules.md「外部層を単一入口へ含めない理由」）。
#
# ## なぜファイル名の一覧で決めないのか（#263）
#
# 以前はここが `wrangler.toml` と `src/generation-models.ts` の 2 本を見ていた。
# 9/01 の事故（登録簿を知らない Lambda が Worker のペイロードを拒否し、本番の
# 生成が 12 分止まった）から採った一覧である。
#
# **2026-09-02 に、その一覧では捕まらない同じ形を踏んだ。** #258 が
# `src/orchestrator/payload.ts` を変えてペイロードの版 3 を足したが、一覧に無いので
# 関門は 1 度も起動せず、**送り側だけが版 3 を知っている窓が約 25 分開いた**
# （実害は 0 件だった。窓の間の生成が 0 行だったという偶然による）。
#
# **一覧を広げても同じことが起きる。** 束には `src/orchestrator/**` のほかに
# `src/bedrock.ts` や `src/generate.ts` が入っており、**次に増えた依存を書き忘れた日に
# 同じ窓がまた開く。** 関門が知りたいのは「動いている Lambda が、これから配る Worker の
# 話し相手として古いか」であって、それはファイル名では決まらない。
#
# **だから束そのものを 2 回作って比べる。** 一覧を維持する場所が消える。
# esbuild は 15ms で、`CodeSha256` は決定的である（配備済みとの比較に既に使っている値）。
#
# ## 使い方
#
#   bash scripts/orchestrator-bundle-changed.sh [<比較元。既定は HEAD^>]
#
# 標準出力の最終行:
#   ORCHESTRATOR_BUNDLE_CHANGED    — 束が変わった。関門を起動すること
#   ORCHESTRATOR_BUNDLE_UNCHANGED  — 変わっていない。AWS を読まなくてよい
#
# 終了コード: 0 = 判定できた / 1 = 判定できない（作業ツリーが汚れている等）
#
# **判定できないことを「変わっていない」に倒さない。** 倒すと、判定できない日に
# 関門が黙って外れる。
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$HERE"

BASE_REF="${1:-HEAD^}"

if ! git rev-parse --verify --quiet "$BASE_REF" >/dev/null; then
  echo "[orchestrator-bundle-changed] 比較元を解決できません: $BASE_REF" >&2
  exit 1
fi

# **作業ツリーを一時的に比較元へ戻すので、汚れていたら断る。** 戻す前の状態を
# 復元できないまま終わると、利用者の変更を失う。
if [ -n "$(git status --porcelain)" ]; then
  echo "[orchestrator-bundle-changed] 作業ツリーが汚れています。commit か stash をしてから実行してください。" >&2
  exit 1
fi

bundle_sha() {
  bash scripts/bundle-orchestrator.sh >/dev/null
  openssl dgst -sha256 -binary dist/orchestrator.zip | base64
}

# **比較元にあって HEAD に無いファイル**を先に数えておく。`git checkout <ref> -- .` は
# それらを復元するが、`git checkout HEAD -- .` は**HEAD に無いものを消さない**ので、
# 数えずに戻すと残骸として作業ツリーに残る。
EXTRA_FILES="$(git diff --name-only --diff-filter=D "$BASE_REF" HEAD)"

# **必ず戻す。** 途中で落ちても比較元のまま放置しない。
restore() {
  # 索引を先に戻す。`git checkout <ref> -- .` は索引も書き換えるので、作業ツリーだけ
  # 戻しても復元されたファイルが staged のまま残る。
  git reset --quiet HEAD -- . >/dev/null 2>&1 || true
  git checkout --quiet HEAD -- . >/dev/null 2>&1 || true
  if [ -n "$EXTRA_FILES" ]; then
    printf '%s\n' "$EXTRA_FILES" | while IFS= read -r f; do
      [ -n "$f" ] && rm -f -- "$f"
    done
  fi
  return 0
}
trap restore EXIT

head_sha="$(bundle_sha)"

# **`git checkout <ref> -- .` は HEAD を動かさない。** 追跡外（node_modules）は
# そのまま残るので、比較元でも束を作れる。
#
# **この差分で足されたファイルは消えずに残るが、束には入らない。** esbuild は
# `src/orchestrator/handler.ts` からの import を辿るだけで、比較元の handler.ts は
# 新しいファイルを import しないためである。
git checkout --quiet "$BASE_REF" -- .
base_sha="$(bundle_sha)"

restore
trap - EXIT

echo "[orchestrator-bundle-changed] $BASE_REF: ${base_sha}"
echo "[orchestrator-bundle-changed] HEAD:      ${head_sha}"

if [ "$head_sha" != "$base_sha" ]; then
  echo "ORCHESTRATOR_BUNDLE_CHANGED"
else
  echo "ORCHESTRATOR_BUNDLE_UNCHANGED"
fi
