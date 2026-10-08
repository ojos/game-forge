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
# ## 比較元: 直前のコミットではなく「本番の Pages に居るコミット」（deploy ジョブの呼び方）
#
# **直前のコミット（`HEAD^`）と比べると、照合が 1 度も行われない順序が 2 つある**（#903 の第二意見）。
#
#   - 束を変えたコミット A の配備が、直後のマージ B に譲って何もしなかった（`deploy-head`。#427）。
#     B の配備は A と B を比べて「変わっていない」と読む
#   - A の配備がこの関門で落ちたまま、配り直す前に無関係な B がマージされた。B の配備は同じく
#     「変わっていない」と読み、Worker だけが先へ進む
#
# どちらも、比べたいのが「直前のコミット」ではなく**「最後にこの関門を通って配ったコミット」**
# だから起きる。deploy ジョブは、この関門の**後ろ**で Pages を `--commit-hash` 付きで配る
# （deploy.yml。#95 / #938）ので、**本番の Pages に居るコミットは、最後にこの関門を通ったコミットである。**
# `--base-from-pages <Cloudflare の Pages プロジェクトの応答 JSON>` を渡すと、そのコミットを比較元にする。
#
#   - 応答を読めない・形が違う（`success` が true でない）  → **判定できない（終了コード 1）**
#   - 本番の配備が無い・コミットが記録されていない・汚れた作業ツリーから配られた・
#     そのコミットを取得できない                          → **CHAT_BUNDLE_CHANGED**
#     （比較元を決められないので、実物の `CodeSha256` との照合へ回す。終了コード 1 にすると、
#     手で配った Pages の記録が欠けた日から CI の配備が 1 本も通らなくなる——照合へ回せば、
#     束が同じなら通り、違えば配り直しを求める。どちらも正しい）
#
# ## 使い方
#
#   bash scripts/chat-bundle-changed.sh [<比較元。既定は HEAD^>]
#   bash scripts/chat-bundle-changed.sh --base-from-pages <応答 JSON のファイル>
#
# 標準出力の最終行:
#   CHAT_BUNDLE_CHANGED    — 束が変わった（か、比較元を決められない）。関門を起動すること
#   CHAT_BUNDLE_UNCHANGED  — 変わっていない。AWS を読まなくてよい
#
# 終了コード: 0 = 判定できた / 1 = 判定できない（作業ツリーが汚れている・比較元を解決できない・
# 束を作れない・Pages の応答を読めない等）
#
# **判定できないことを「変わっていない」に倒さない。** 倒すと、判定できない日に
# 関門が黙って外れる。
#
# 自己検査: scripts/chat-bundle-changed-selftest.sh（scripts/acceptance.sh が回す）
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$HERE"

##
# 比較元を決められないので、実物との照合へ回す（上の「比較元」の節）。
#
# @param $1 理由
##
changed_without_base() {
  echo "[chat-bundle-changed] $1 比較元を決められないので、変わったものとして扱います（照合へ回します）。"
  echo "CHAT_BUNDLE_CHANGED"
  exit 0
}

if [ "${1:-}" = "--base-from-pages" ]; then
  PAGES_JSON="${2:-}"
  if [ -z "$PAGES_JSON" ] || [ ! -r "$PAGES_JSON" ]; then
    echo "[chat-bundle-changed] Pages の応答のファイルを読めません: ${PAGES_JSON:-（未指定）}" >&2
    exit 1
  fi
  command -v jq >/dev/null 2>&1 || {
    echo "[chat-bundle-changed] jq がありません（Pages の応答を読むのに要ります）。" >&2
    exit 1
  }
  if ! jq -e '.success == true' "$PAGES_JSON" >/dev/null 2>&1; then
    echo "[chat-bundle-changed] Pages の応答が成功を示していません（読めない・形が違う）: $PAGES_JSON" >&2
    exit 1
  fi
  if ! jq -e '.result.canonical_deployment != null' "$PAGES_JSON" >/dev/null; then
    changed_without_base "本番の Pages に配備がありません。"
  fi
  pages_commit="$(jq -r '.result.canonical_deployment.deployment_trigger.metadata.commit_hash // ""' "$PAGES_JSON")"
  pages_dirty="$(jq -r '.result.canonical_deployment.deployment_trigger.metadata.commit_dirty // false' "$PAGES_JSON")"
  if ! printf '%s\n' "$pages_commit" | grep -Eq '^[0-9a-f]{40}$'; then
    changed_without_base "本番の Pages の配備にコミットが記録されていません（${pages_commit:-空}）。"
  fi
  if [ "$pages_dirty" = "true" ]; then
    changed_without_base "本番の Pages は汚れた作業ツリーから配られています（${pages_commit}）。"
  fi
  # **ツリーだけあれば比べられる**ので、浅く 1 コミットだけ取る（deploy ジョブの checkout は 2 コミット）。
  if ! git cat-file -e "${pages_commit}^{commit}" 2>/dev/null; then
    git fetch --quiet --no-tags --depth=1 origin "$pages_commit" >/dev/null 2>&1 || true
  fi
  if ! git cat-file -e "${pages_commit}^{commit}" 2>/dev/null; then
    changed_without_base "本番の Pages に居るコミット（${pages_commit}）を取得できません。"
  fi
  echo "[chat-bundle-changed] 比較元は本番の Pages に居るコミットです: ${pages_commit}"
  BASE_REF="$pages_commit"
else
  BASE_REF="${1:-HEAD^}"
fi

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

# **依存（`package.json` / `package-lock.json`）が変わったら、束を作らずに CHANGED とする。**
# 下の比較は比較元の側も**いまの `node_modules`** で束ねるので、`aws4fetch`（束に入る）や
# esbuild（束を作る）の版だけが変わった差分では、両方が同じ版で束ねられて UNCHANGED に化ける。
# 依存の差分は広めに拾う（束に効かない更新でも AWS を 1 回読むだけで、照合は実物の値で行うので
# 束が同じなら関門は通る）。**逆向きの取りこぼし（依存の更新で本番だけ古いまま）は拾えない
# 誤りなので、広いほうへ倒す。**
dep_rc=0
git diff --quiet "$BASE_REF" HEAD -- package.json package-lock.json || dep_rc=$?
if [ "$dep_rc" -eq 1 ]; then
  echo "[chat-bundle-changed] 依存（package.json / package-lock.json）が変わりました。束は作り比べず、変わったものとして扱います。"
  echo "CHAT_BUNDLE_CHANGED"
  exit 0
elif [ "$dep_rc" -ne 0 ]; then
  echo "[chat-bundle-changed] 依存の差分を読めません（git diff の終了コード ${dep_rc}）。" >&2
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
#
# **`--no-renames` を外さない。** 既定の `git diff` は改名を検出し、改名の旧パスは `D` ではなく
# `R` として出る。旧パスがここから漏れると、比較元から復元されたまま残骸として作業ツリーに残る。
EXTRA_FILES="$(git diff --no-renames --name-only --diff-filter=D "$BASE_REF" HEAD)"

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
