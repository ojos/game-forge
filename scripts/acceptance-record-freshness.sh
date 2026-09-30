#!/usr/bin/env bash
# acceptance-record-freshness.sh — 固定の issue から外部層の定期実行の記録を読み、判定へ渡す（#844）
#
# .github/workflows/acceptance-remote-freshness.yml が毎日呼ぶ。手元からも同じように回せる。
#
#   REPO=ojos/game-forge bash scripts/acceptance-record-freshness.sh
#
# 判定そのものは scripts/acceptance-record-judge.sh が持つ。ここは取得と、結果の分かれ目を
# 終了コードへ写すだけである。
#
# 終了コード:
#   0 = 記録は新しく、乖離も無い
#   1 = 記録が無い・古い・乖離がある・ある系統の前提が 3 日通っていない（判定の結果）
#   2 = **確かめられなかった**（記録先が未設定・GitHub API から読めない・入力が壊れている）
#
# **2 を 1 に混ぜない。** GitHub の一時的な不調を「記録が無い」と報告すると、止まっていない
# 定期実行を止まったように見せる。逆に 0 にすると確かめていないものを通す。どちらも
# 赤（ジョブの失敗）にはなるが、注記の文面で読み分けられるようにする。
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)" || exit 2
# shellcheck source=scripts/lib/acceptance-record.sh
. "$HERE/lib/acceptance-record.sh" || exit 2

unreadable() {
  echo "::error::外部層の記録を確かめられませんでした（記録が無いのではありません）: $*"
  exit 2
}

if [ -z "${ACCEPTANCE_RECORD_ISSUE:-}" ]; then
  unreadable "記録先の issue が未設定です（scripts/lib/acceptance-record.sh の ACCEPTANCE_RECORD_ISSUE）"
fi
[[ "$ACCEPTANCE_RECORD_ISSUE" =~ ^[0-9]+$ ]] || unreadable "ACCEPTANCE_RECORD_ISSUE が番号ではありません"

repo="${REPO:-}"
if [ -z "$repo" ]; then
  repo="$(gh repo view --json nameWithOwner --jq .nameWithOwner 2>/dev/null)" || unreadable "リポジトリ名を取得できません（REPO を渡してください）"
fi
[[ "$repo" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || unreadable "REPO の形が owner/name ではありません"
owner="${repo%%/*}"

echo "記録先: ${repo}#${ACCEPTANCE_RECORD_ISSUE}（持ち主 ${owner} のコメントだけを数えます）"

# ロックしていない issue は、協力者以外もコメントできる。判定は持ち主の記録しか数えないので
# 落とさないが、手順書（docs/acceptance-remote-schedule.md）どおりにロックしてあるかは知らせる。
locked="$(gh api "repos/${repo}/issues/${ACCEPTANCE_RECORD_ISSUE}" --jq '.locked' 2>/dev/null)" ||
  unreadable "issue #${ACCEPTANCE_RECORD_ISSUE} を読めません（GitHub API の失敗）"
if [ "$locked" != "true" ]; then
  echo "::warning::issue #${ACCEPTANCE_RECORD_ISSUE} がロックされていません（gh issue lock ${ACCEPTANCE_RECORD_ISSUE} --reason off-topic）"
fi

# **--paginate を外さない。** 毎日 1 件ずつ増えるので、1 ページ（30 件）は 1 か月で埋まる。
comments="$(gh api --paginate "repos/${repo}/issues/${ACCEPTANCE_RECORD_ISSUE}/comments" --jq '.[]' 2>/dev/null)" ||
  unreadable "issue #${ACCEPTANCE_RECORD_ISSUE} のコメントを読めません（GitHub API の失敗）"

rc=0
printf '%s\n' "$comments" | bash "$HERE/acceptance-record-judge.sh" --owner "$owner" || rc=$?
case "$rc" in
  0) exit 0 ;;
  1)
    echo "::error::外部層の定期実行の記録が古いか、乖離があります（上の FAIL の行）。手元のログは ~/Library/Logs/game-forge/acceptance-remote/ にあります（docs/acceptance-remote-schedule.md）"
    exit 1
    ;;
  *) unreadable "判定スクリプトが入力を読めませんでした（終了コード ${rc}）" ;;
esac
