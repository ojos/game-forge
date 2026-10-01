#!/usr/bin/env bash
# verify-commit-identity-selftest.sh — コミット identity の検証ゲートが、通すべき形を通し、
# 落とすべき形を落とすことを、仕込みのリポジトリで確かめる（#860）。
#
# ## なぜ要るのか
#
# **本物の main を検査しても、落ちるべき形はほとんど現れない。** #833 の squash merge で
# GitHub が足した `Co-authored-by: dependabot[bot] <…@users.noreply.github.com>` は、
# PR の検査では見えず（マージの瞬間に付く）、push(main) の全履歴検査で初めて赤になった。
# 逆に、許可を広げた結果「何でも通る」になっても、本物の履歴だけでは気づけない。
#
# そこで 1 コミットだけの仕込みのリポジトリを場合ごとに作り、スクリプトをそこへ写して
# `--full` で回す（スクリプトは自分の置き場所のリポジトリへ cd するため）。
#
# ## 何を見るか
#
# - 通る: 許可 email の author / GitHub の squash merge（committer=noreply@github.com）で
#   dependabot[bot] の noreply を author・co-author に持つコミット / AI の trailer
# - 落ちる: ローカルで作ったコミット（committer が許可 email）の co-author が noreply 形式 /
#   @ を 2 つ持つ noreply 形式 / 許可外の個人 email の co-author・author
#
# 使い方:
#   bash scripts/verify-commit-identity-selftest.sh
#
# 終了コード: 0 = IDENTITY_SELFTEST_PASS / 1 = どれかの場合が期待と違う
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

tmp="$(mktemp -d "${TMPDIR:-/tmp}/verify-commit-identity-selftest.XXXXXX")"
cleanup() { rm -rf "$tmp"; }
trap cleanup EXIT

readonly ME='me@example.com'
readonly GH='noreply@github.com'
readonly BOT='49699333+dependabot[bot]@users.noreply.github.com'

failures=0
n=0

# check <名前> <期待の終了コード> <author email> <committer email> [co-author email...]
check() {
  local name="$1" want="$2" author="$3" committer="$4"
  shift 4
  n=$((n + 1))
  local repo="$tmp/repo-$n"
  mkdir -p "$repo/scripts"
  cp "$HERE/verify-commit-identity.sh" "$repo/scripts/"
  git -C "$repo" init -q
  local msg="case: ${name}" email
  if [[ "$#" -gt 0 ]]; then
    msg+=$'\n'
    for email in "$@"; do
      msg+=$'\n'"Co-authored-by: someone <${email}>"
    done
  fi
  GIT_AUTHOR_NAME=a GIT_AUTHOR_EMAIL="$author" \
    GIT_COMMITTER_NAME=c GIT_COMMITTER_EMAIL="$committer" \
    git -C "$repo" commit -q --allow-empty -m "$msg"

  local got=0 out
  out="$(ALLOWED_AUTHOR_EMAILS="$ME" bash "$repo/scripts/verify-commit-identity.sh" --full 2>&1)" || got=$?
  if [[ "$got" -ne "$want" ]]; then
    echo "[identity-selftest] FAIL: ${name}: 終了コード ${got}（期待 ${want}）"
    printf '%s\n' "$out" | sed 's/^/    /'
    failures=$((failures + 1))
    return 0
  fi
  echo "[identity-selftest] ok: ${name}"
}

# 通る
check "許可 email の author と committer" 0 "$ME" "$ME"
check "AI の trailer" 0 "$ME" "$ME" "noreply@anthropic.com"
check "squash merge の committer" 0 "$ME" "$GH"
check "Dependabot の PR の squash merge（#833 の形）" 0 "$BOT" "$GH" "$BOT"
check "人の PR を別の人が squash merge" 0 "$ME" "$GH" "12345+someone@users.noreply.github.com"

# 落ちる
check "ローカルのコミットに noreply 形式の co-author" 1 "$ME" "$ME" "$BOT"
check "@ を 2 つ持つ noreply 形式の co-author" 1 "$ME" "$GH" "x@evil.com@users.noreply.github.com"
check "ローカル部が空の noreply 形式の co-author" 1 "$ME" "$GH" "@users.noreply.github.com"
check "許可外の個人 email の co-author" 1 "$ME" "$GH" "other@example.org"
check "許可外の個人 email の author" 1 "other@example.org" "$GH"
check "ローカルのコミットに noreply 形式の author" 1 "$BOT" "$ME"

if [[ "$failures" -gt 0 ]]; then
  echo "[identity-selftest] ${failures} / ${n} 件が期待と違います。"
  echo "IDENTITY_SELFTEST_FAIL"
  exit 1
fi
echo "[identity-selftest] ${n} 件すべて期待どおり。"
echo "IDENTITY_SELFTEST_PASS"
