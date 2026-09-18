#!/usr/bin/env bash
# check-writeback-serial.sh — scripts/writeback-serial.sh の判定を表で確かめる（#650）
#
# ワークフロー（.github/workflows/writeback-serial.yml）は GitHub 上でしか動かないので、
# **判定そのものはここで機械的に押さえる。** ワークフローは一覧を集めてこのスクリプトへ渡し、
# 結果を status に書くだけにしてある。判定を YAML へ書き写さないのは、手元と CI で同じ
# コードが判定するようにするため（verify.yml の冒頭と同じ考え方）。
#
# 終了コード: 0 = すべて期待どおり / 1 = 1 件でも外れた
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TARGET="$HERE/writeback-serial.sh"

fail=0
n=0

# case <名前> <期待する終了コード> <期待する出力> <入力>
case_() {
  local name="$1" want_rc="$2" want_out="$3" input="$4" got_out got_rc=0
  n=$((n + 1))
  got_out="$(printf '%b' "$input" | bash "$TARGET" 2>/dev/null)" || got_rc=$?
  if [ "$got_rc" != "$want_rc" ] || [ "$got_out" != "$(printf '%b' "$want_out")" ]; then
    echo "[writeback-serial] FAIL: $name" >&2
    echo "  want rc=$want_rc out=$(printf '%b' "$want_out" | tr '\n' '|')" >&2
    echo "  got  rc=$got_rc out=$(printf '%s' "$got_out" | tr '\n' '|')" >&2
    fail=1
  fi
}

case_ "空の入力は何も出さない" 0 "" ""
case_ "1 本だけなら通す" 0 "662 success" "662 2026-09-18T09:30:00Z\n"
case_ "古いほうを通し、新しいほうを落とす" 0 \
  "662 success\n670 failure 662" \
  "662 2026-09-18T09:30:00Z\n670 2026-09-18T10:00:00Z\n"
case_ "入力の順に依らない" 0 \
  "662 success\n670 failure 662" \
  "670 2026-09-18T10:00:00Z\n662 2026-09-18T09:30:00Z\n"
case_ "同時刻なら番号の小さいほう" 0 \
  "9 success\n10 failure 9" \
  "10 2026-09-18T09:30:00Z\n9 2026-09-18T09:30:00Z\n"
case_ "番号の大小と作成順が逆でも作成順で決める" 0 \
  "700 success\n690 failure 700" \
  "690 2026-09-18T11:00:00Z\n700 2026-09-18T10:00:00Z\n"
case_ "3 本なら 2 本を落とす" 0 \
  "1 success\n2 failure 1\n3 failure 1" \
  "3 2026-09-18T03:00:00Z\n1 2026-09-18T01:00:00Z\n2 2026-09-18T02:00:00Z\n"
case_ "CRLF でも同じ答え" 0 \
  "1 success\n2 failure 1" \
  "1 2026-09-18T01:00:00Z\r\n2 2026-09-18T02:00:00Z\r\n"
case_ "空行は数えない" 0 "5 success" "\n5 2026-09-18T01:00:00Z\n\n"
# 一部だけ判定して出すと、落とすべき PR を黙って緑のままにしうる。全部か無しか。
case_ "形の崩れた行があれば何も出さず 2" 2 "" \
  "1 2026-09-18T01:00:00Z\nnot-a-row\n"
case_ "時刻が欠けた行も崩れとみなす" 2 "" "1\n"

if [ "$fail" -ne 0 ]; then
  echo "[writeback-serial] 判定が期待と食い違いました（上記）" >&2
  exit 1
fi
echo "[writeback-serial] $n 件すべて期待どおり"
