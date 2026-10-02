#!/usr/bin/env bash
# chat-bundle-changed.sh — チャットの関数（game-forge-chat）の束が、この差分で変わったか（#903）
#
# Worker を配る直前の関門のうち、**チャットの関数の側**を起動するかどうかを決める。
# 起動しなければ AWS を 1 度も読まない（外部の可用性を配備の前提条件へ持ち込まないため。
# `scripts/orchestrator-bundle-changed.sh` と同じ線）。
#
# ## なぜ要るのか
#
# **2026-09-21 に、関門が無いせいで黙ってずれた。** #740 がチャットの束（システムプロンプトの
# 用語。`src/chat-prompt.ts`）を変えたのに、レーンが「束は変わらない」と報告し、配り直されなかった。
# main の deploy は止まらず、**本番のチャットは古いプロンプトのまま動いていた**（#742 の配り直しで
# 上書きされるまで）。頼りは「束を main と PR で比べる」という注意を人が覚えていることだけだった。
#
# ## なぜファイル名の一覧で決めないのか
#
# `scripts/orchestrator-bundle-changed.sh` の冒頭（#263）と同じ理由である。チャットの束には
# `src/chat/**` のほかに `src/chat-prompt.ts`・`src/chat-payload.ts`・`src/bedrock.ts`・
# `src/generation-models.ts`・`src/input-moderation.ts` が入っており、**次に増えた依存を
# 書き忘れた日に同じ窓が開く。** 束そのものを 2 回作って比べる。
#
# ## オーケストレータの判定と混ぜない
#
# **別の zip・別の関数である**（#695 / 仕様 5.16）。チャットだけが変わった日にオーケストレータの
# 配り直しを求めない（逆も同じ）ために、判定もスクリプトも分けてある。作りは
# `scripts/orchestrator-bundle-changed.sh` と揃えてあり、違うのは束ねるスクリプトと合図の綴りだけである。
#
# ## 使い方
#
#   bash scripts/chat-bundle-changed.sh [<比較元。既定は HEAD^>]
#
# 標準出力の最終行:
#   CHAT_BUNDLE_CHANGED    — 束が変わった。関門を起動すること
#   CHAT_BUNDLE_UNCHANGED  — 変わっていない。AWS を読まなくてよい
#
# 終了コード: 0 = 判定できた / 1 = 判定できない（作業ツリーが汚れている・比較元を解決できない・
# 束を作れない等）
#
# **判定できないことを「変わっていない」に倒さない。** 倒すと、判定できない日に
# 関門が黙って外れる。
#
# 自己検査: scripts/chat-bundle-changed-selftest.sh（scripts/acceptance.sh が回す）
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$HERE"

BASE_REF="${1:-HEAD^}"

if ! git rev-parse --verify --quiet "$BASE_REF" >/dev/null; then
  echo "[chat-bundle-changed] 比較元を解決できません: $BASE_REF" >&2
  exit 1
fi

# **作業ツリーを一時的に比較元へ戻すので、汚れていたら断る。** 戻す前の状態を
# 復元できないまま終わると、利用者の変更を失う。
if [ -n "$(git status --porcelain)" ]; then
  echo "[chat-bundle-changed] 作業ツリーが汚れています。commit か stash をしてから実行してください。" >&2
  exit 1
fi

# **束を作れなければ失敗で返す。** `$(...)` の中では `set -e` が引き継がれないので、
# 明示的に受ける（受けないと、壊れた束の古い zip や空の値を比べてしまう）。
bundle_sha() {
  bash scripts/bundle-chat.sh >/dev/null || return 1
  [ -f dist/chat.zip ] || return 1
  openssl dgst -sha256 -binary dist/chat.zip | base64
}

# **比較元にあって HEAD に無いファイル**を先に数えておく（`orchestrator-bundle-changed.sh` と
# 同じ理由。`git checkout HEAD -- .` は HEAD に無いものを消さない）。
EXTRA_FILES="$(git diff --name-only --diff-filter=D "$BASE_REF" HEAD)"

# **必ず戻す。** 途中で落ちても比較元のまま放置しない。
restore() {
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

# 追跡外（node_modules）はそのまま残るので、比較元でも束を作れる。この差分で足されたファイルは
# 残るが、比較元の `src/chat/handler.ts` から import されないので束には入らない。
git checkout --quiet "$BASE_REF" -- .
base_sha="$(bundle_sha)"

restore
trap - EXIT

echo "[chat-bundle-changed] $BASE_REF: ${base_sha}"
echo "[chat-bundle-changed] HEAD:      ${head_sha}"

if [ "$head_sha" != "$base_sha" ]; then
  echo "CHAT_BUNDLE_CHANGED"
else
  echo "CHAT_BUNDLE_UNCHANGED"
fi
