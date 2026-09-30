#!/usr/bin/env bash
# check-second-opinion-gate-exempt.sh — scripts/second-opinion-gate-exempt.sh の判定を表で確かめる（#838）
#
# ワークフロー（.github/workflows/second-opinion-gate.yml）は GitHub 上でしか動かないので、
# **除外の判定はここで機械的に押さえる。** 形は check-writeback-serial.sh（#650）と同じ。
#
# 終了コード: 0 = すべて期待どおり / 1 = 1 件でも外れた
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TARGET="$HERE/second-opinion-gate-exempt.sh"

fail=0

# case <名前> <期待する終了コード> <期待する出力> <入力>
case_() {
  local name="$1" want_rc="$2" want_out="$3" input="$4" got_out got_rc=0
  got_out="$(printf '%b' "$input" | bash "$TARGET" 2>/dev/null)" || got_rc=$?
  if [ "$got_rc" != "$want_rc" ] || [ "$got_out" != "$want_out" ]; then
    echo "[second-opinion-gate-exempt] FAIL: $name" >&2
    echo "  want rc=$want_rc out=$want_out" >&2
    echo "  got  rc=$got_rc out=$got_out" >&2
    fail=1
  fi
}

case_ "Dependabot の PR（コミットも Dependabot）は除外" 0 exempt \
  "dependabot[bot]\ndependabot[bot]\n"
case_ "コミットが複数でも全部 Dependabot なら除外" 0 exempt \
  "dependabot[bot]\ndependabot[bot]\ndependabot[bot]\n"
case_ "人の PR は判定する" 0 judge "ido-ojos\nido-ojos\n"
# Dependabot のブランチへ人が足したコミットを、第二意見なしで通さない。
case_ "Dependabot の PR に人のコミットが混ざれば判定する" 0 judge \
  "dependabot[bot]\ndependabot[bot]\nido-ojos\n"
case_ "アカウントに紐づかないコミットが混ざれば判定する" 0 judge \
  "dependabot[bot]\ndependabot[bot]\n-\n"
case_ "人の PR に Dependabot のコミットだけでも判定する" 0 judge \
  "ido-ojos\ndependabot[bot]\n"
case_ "ほかの bot は除外しない" 0 judge \
  "github-actions[bot]\ngithub-actions[bot]\n"
case_ "似た名前は除外しない" 0 judge "dependabot\ndependabot\n"
case_ "CRLF でも同じ答え" 0 exempt "dependabot[bot]\r\ndependabot[bot]\r\n"
case_ "末尾の改行が無くても読む" 0 exempt "dependabot[bot]\ndependabot[bot]"
# 読めないことを exempt に倒さない。
case_ "空の入力は判定できない" 2 "" ""
case_ "コミットが無ければ判定できない" 2 "" "dependabot[bot]\n"
case_ "著者が空なら判定できない" 2 "" "\ndependabot[bot]\n"

if [ "$fail" -ne 0 ]; then
  echo "[second-opinion-gate-exempt] 判定が期待と食い違いました（上記）" >&2
  exit 1
fi
echo "SECOND_OPINION_GATE_EXEMPT_PASS"
