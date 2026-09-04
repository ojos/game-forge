#!/usr/bin/env bash
# build-time-report.sh — ビルド時間が天井へ近づいていることを、踏む前に読み取る（#166 / M3-10）
#
# **2026-08-29 のタイムアウト（#164）は、利用者が踏んで初めて分かった。** あとから
# CloudWatch を掘ると、分布はすでに天井に迫っていた（15 回中 5 回が 29 秒以上、天井は
# 30 秒）。**見ていれば予告できた。**
#
# 使い方:
#   bash scripts/build-time-report.sh                    # 直近 14 日（AWS の認証が要る）
#   bash scripts/build-time-report.sh --days 3
#   bash scripts/build-time-report.sh --explain-threshold # 閾値の導出だけを見る（AWS 不要）
#   bash scripts/build-time-report.sh --format json
#   bash scripts/build-time-report.sh --events-file saved.json --from 2026-08-27 --to 2026-08-27
#                                                        # 保存済みの応答を読む（AWS 不要）
#
# 期間の指定・日の境界・日付の綴りは scripts/report-window.sh が持つ（**#149 の費用の
# 集計と同じ定義である**）。ここへ書き写さない。
#
# 終了コード:
#   0 = BUILD_HEADROOM_PASS     天井に対して余裕がある
#   1 = BUILD_HEADROOM_NEAR     接近している（または打ち切られた呼び出しがある）
#   2 = BUILD_HEADROOM_UNKNOWN  判定できない（未認証・ログが無い・
#                               **現在の構成での呼び出しが 0 件**）
#
# **0 件を「余裕あり」にしない。** 測っていないことと、測って余裕があることは別である
# （scripts/acceptance.sh の ran_any と同じ考え方）。
#
# ── 新しい計測を足していない ────────────────────────────────────────────────
#
# #166 は「新しい計測を足す前に、いま捨てている値を残せないか」を求めている。**調べた
# 結果、足さずに済んだ。** 経緯は docs/usage-report.md の「なぜ CloudWatch を読むのか」に
# 書いた。要点だけ:
#
#   - ビルド関数の応答の buildMs / compressMs は、src/build-client.ts が BuildTimings へ
#     読んだあと**どこへも残していない**（ログにも D1 にも出ない）。
#   - 残すには D1 への書き込みを増やすか src/ を変えるかになる。**前者は 3.6 と #166 の
#     constraints が禁じている**（観測のために本番への書き込みを増やさない）。
#   - **CloudWatch の REPORT 行は、すでに全呼び出しぶん 14 日保持されている**
#     （terraform/build-function.tf の aws_cloudwatch_log_group.build）。追加の計測も
#     追加の書き込みも無しに読める。
#   - しかも **REPORT の Duration こそがタイムアウトの掛かる量である。**
#     buildMs + compressMs はその内訳（部分集合）でしかない。
#
# ── 閾値を決め打ちで書き写さない ────────────────────────────────────────────
#
# **天井は宣言から導く**（terraform/build-function.tf の build_function_timeout_seconds）。
# #164 が第 4 波でこの値を動かす。書き写すと、その日にずれる。
#
# ── 天井を動かした直後に、過去の完走を「打ち切り」と呼ばない（#211） ────────
#
# **天井は現在の宣言から読み、所要は過去のログから読む。** どちらも単体では正しいが、
# 突き合わせると事故になる。2026-08-31 にメモリを 3,008 → 10,240 MB、天井を 45 → 20 秒
# へ動かした直後、`--days 7` が **3,008 MB 時代の完走（23〜37 秒）を 19 件「打ち切られて
# います」と報告した。** どれも当時の天井 45 秒の内側で完走している。
#
# **嘘の赤は、ゲートへの信頼を削る**（scripts/check-deps-installed.sh の冒頭と同じ理由）。
# しかもこの道具は「踏む前に読み取る」ためのものである。直したのは 2 点。
#
#   1. **REPORT の `Memory Size` を読み、現在の宣言と違うメモリで走った呼び出しを
#      判定から外す。** Lambda はメモリに比例して vCPU を割り当てるので、メモリが違えば
#      所要も違う。**同じ天井に対する余裕として並べられない。**
#      **ただし表からは消さない。** 別の構成での実測として、**なぜ外したか**を添えて残す
#      （消すと「データが無い」と読まれる。0 件を「余裕あり」にしないという本スクリプトの
#      方針と同じ線である）。
#   2. **打ち切りは `Task timed out` の実ログで数える。** 「所要 ≧ 天井」からの推測を
#      やめた。**推測は、天井を下げた日に過去を書き換えてしまう。**
#
# **打ち切りの行と REPORT の行は RequestId で突き合わせる。** そうしないと、その打ち切りが
# どの構成で起きたのかが分からない。**突き合わない打ち切り**（REPORT が窓の外にある等）は
# 件数を注記に出し、**判定には使わない**——どの構成のものか確かめられていないからである。
#
# **`Task timed out` の綴りは、本番ログのこの窓では 0 件だった**（保持は 14 日で、#164 の
# 打ち切りはすでに流れている。2026-08-31 に確認）。**綴りに寄りかからない形にしてある**
# ——判定に使うのは "Task timed out" を含むかどうかだけで、後続の書式は読まない
# （`docs/handoff.md` 4 章「綴りを絞った検査は、対象の綴りが変わった日に黙って空振りする」）。
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)" || exit 2
ROOT="$(dirname "$HERE")"
cd "$ROOT" || exit 2

# shellcheck source=scripts/report-window.sh
. "$HERE/report-window.sh"

# 天井（タイムアウト）の宣言の在り処。**値ではなく在り処を既定にする。**
TIMEOUT_SOURCE="terraform/build-function.tf"

##
# 接近とみなす、天井に対する割合。
#
# **0.8 は「余裕が 20% を切った」という意味で、宣言が意図して買った余裕そのものである。**
#
# #103 はタイムアウトを 25 秒から 30 秒へ改めている。理由は
# terraform/build-function.tf と docs/build-function.md に残っており、**コールドの実測
# 23.685 秒に対して 25 秒では余裕が 1.3 秒（天井の 5.3%）しかない**ためだった。
# 30 秒にしたことで余裕は 6.315 秒、すなわち**天井の 21.1%** になった。
#
# つまり宣言は「天井の 2 割ほどの余裕」を意図して買っている。**実際の呼び出しがその
# 余裕を食い始めたら、その値を選んだ理由がもう成り立っていない。** 0.8 はその線である。
#
# **天井そのものは書かない。** #164 が動かすのは天井であって、この割合ではない。
NEAR_RATIO="0.8"

##
# 接近が何割を占めたら「近づいている」と言うか。
#
# **0.10 は #164 の分布から導いた。** あのとき 15 回中 5 回（33%）が天井の 96% 以上に
# 達していて、それでも誰も気づかなかった。**33% で気づけないなら、線はそれよりずっと
# 手前に要る。** 10% なら、15 回中 2 回で鳴る。
#
# **1 回でも超過があれば、割合を問わず落とす**（超過は予告ではなく発生である）。
NEAR_SHARE="0.10"

DAYS=""
FROM=""
TO=""
FORMAT="table"
LOG_GROUP=""
EVENTS_FILE=""
EXPLAIN_ONLY=0
NOW="${BUILD_TIME_REPORT_NOW:-$(date -u +%s)}"

usage() {
  # **行番号で切らない。** 冒頭の説明はこれまで何度も伸びており、そのたびに help が
  # 途中で切れる（#211 でこの節を伸ばしたとき、実際に終了コードの説明が 1 行だけ
  # 切れた状態で出た）。最初の区切り（`# ── `）の手前までを出す。
  sed -n '2,/^# ── /p' "${BASH_SOURCE[0]}" | sed '$d' >&2
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --days)              DAYS="${2:-}"; shift 2 ;;
    --from)              FROM="${2:-}"; shift 2 ;;
    --to)                TO="${2:-}"; shift 2 ;;
    --format)            FORMAT="${2:-}"; shift 2 ;;
    --near-ratio)        NEAR_RATIO="${2:-}"; shift 2 ;;
    --near-share)        NEAR_SHARE="${2:-}"; shift 2 ;;
    # 宣言の在り処を差し替える。scripts/report-selftest.sh が
    # 「#164 が天井を動かしたら閾値も動くこと」を検査するための口である。
    --timeout-source)    TIMEOUT_SOURCE="${2:-}"; shift 2 ;;
    --log-group)         LOG_GROUP="${2:-}"; shift 2 ;;
    # CloudWatch の代わりに、保存しておいた filter-log-events の応答（JSON）を読む。
    # **scripts/report-selftest.sh が集計そのものを検査するための口である**
    # （--timeout-source と同じ位置づけ。AWS も認証もネットワークも要らない）。
    --events-file)       EVENTS_FILE="${2:-}"; shift 2 ;;
    --explain-threshold) EXPLAIN_ONLY=1; shift ;;
    -h|--help)           usage; exit 0 ;;
    *)
      echo "[build-time] 不明な引数です: $1" >&2
      exit 2 ;;
  esac
done

case "$FORMAT" in
  table|json) ;;
  *)
    echo "[build-time] --format は table / json のいずれかです: ${FORMAT}" >&2
    exit 2 ;;
esac

##
# 天井（タイムアウト秒）を宣言から読む。
#
# **読めなければ落とす。既定値へ倒さない。** 決め打ちの値へ静かに落ちると、#164 が
# 宣言を動かした日に**古い天井で「余裕あり」と言い続ける。** それはこのスクリプトが
# 防ごうとしている事故そのものである。
#
# @return 標準出力へ秒（整数）
##
declared_timeout_seconds() {
  if [[ ! -f "$TIMEOUT_SOURCE" ]]; then
    echo "[build-time] 天井の宣言が見つかりません: ${TIMEOUT_SOURCE}" >&2
    return 1
  fi
  local values count
  values="$(sed -n 's/^[[:space:]]*build_function_timeout_seconds[[:space:]]*=[[:space:]]*\([0-9][0-9]*\)[[:space:]]*$/\1/p' \
    "$TIMEOUT_SOURCE")"
  count="$(printf '%s' "$values" | grep -c . || true)"
  if [[ "$count" != "1" ]]; then
    echo "[build-time] ${TIMEOUT_SOURCE} の build_function_timeout_seconds を 1 つに決められません（${count} 件）。" >&2
    echo "[build-time] 綴りが変わったら本スクリプトを直すこと。決め打ちの値へは倒しません。" >&2
    return 1
  fi
  printf '%s\n' "$values"
}

##
# メモリの宣言（MB）を読む。
#
# **天井と同じ理由で、値を書き写さない。** #212 がこの値を動かした（3,008 → 10,240）。
# 書き写していたら、動かした日から「別の構成かどうか」の判定が丸ごとずれる——それは
# #211 が起きた形そのものである。
#
# @return 標準出力へ MB（整数）
##
declared_memory_mb() {
  if [[ ! -f "$TIMEOUT_SOURCE" ]]; then
    echo "[build-time] メモリの宣言が見つかりません: ${TIMEOUT_SOURCE}" >&2
    return 1
  fi
  local values count
  values="$(sed -n 's/^[[:space:]]*build_function_memory_mb[[:space:]]*=[[:space:]]*\([0-9][0-9]*\)[[:space:]]*$/\1/p' \
    "$TIMEOUT_SOURCE")"
  count="$(printf '%s' "$values" | grep -c . || true)"
  if [[ "$count" != "1" ]]; then
    echo "[build-time] ${TIMEOUT_SOURCE} の build_function_memory_mb を 1 つに決められません（${count} 件）。" >&2
    echo "[build-time] 綴りが変わったら本スクリプトを直すこと。決め打ちの値へは倒しません。" >&2
    return 1
  fi
  printf '%s\n' "$values"
}

##
# ロググループ名を宣言から導く。
#
# 関数名は local.build_function_name、綴りは terraform 側の
# `"/aws/lambda/${local.build_function_name}"` である。**その綴りが宣言にまだあることを
# 確かめてから組み立てる。** 宣言側が別の名前へ移った日に、こちらが黙って
# 存在しないロググループを読み（＝0 件になり）、「呼び出しが無かった」と報告する
# 経路を残さない。
#
# @return 標準出力へロググループ名
##
declared_log_group() {
  local name
  name="$(sed -n 's/^[[:space:]]*build_function_name[[:space:]]*=[[:space:]]*"\([^"]*\)"[[:space:]]*$/\1/p' \
    "$TIMEOUT_SOURCE" | head -1)"
  if [[ -z "$name" ]]; then
    echo "[build-time] ${TIMEOUT_SOURCE} から build_function_name を読めません。" >&2
    return 1
  fi
  if ! grep -q '"/aws/lambda/${local.build_function_name}"' "$TIMEOUT_SOURCE"; then
    echo "[build-time] 宣言のロググループ名が /aws/lambda/\${local.build_function_name} ではありません。" >&2
    echo "[build-time] 綴りが変わっています。--log-group で明示するか、本スクリプトを直すこと。" >&2
    return 1
  fi
  printf '/aws/lambda/%s\n' "$name"
}

TIMEOUT_SECONDS="$(declared_timeout_seconds)" || exit 2
MEMORY_MB="$(declared_memory_mb)" || exit 2
# 小数の比較は awk に任せる（bash は整数しか扱えない）。ミリ秒で持つ。
TIMEOUT_MS="$(awk -v t="$TIMEOUT_SECONDS" 'BEGIN { printf "%.0f", t * 1000 }')"
NEAR_MS="$(awk -v t="$TIMEOUT_SECONDS" -v r="$NEAR_RATIO" 'BEGIN { printf "%.0f", t * 1000 * r }')"
NEAR_SECONDS="$(awk -v m="$NEAR_MS" 'BEGIN { printf "%.1f", m / 1000 }')"

if (( EXPLAIN_ONLY )); then
  cat <<EXPLAIN
[build-time] 閾値の導出（AWS へは触れていません）

  天井            ${TIMEOUT_SECONDS} 秒
                  出所: ${TIMEOUT_SOURCE} の build_function_timeout_seconds
                  書き写していない。#164 がこの値を動かせば、下の線も動く
  接近とみなす線  ${NEAR_SECONDS} 秒（天井の ${NEAR_RATIO}。余裕がこれ未満）
                  根拠: #103 が 25 秒を退けたのは余裕が天井の 5.3% しか無かったため。
                        30 秒にして買った余裕は天井の 21.1%。その余裕を食い始めた線
  打ち切り        "Task timed out" の実ログで数える（1 件でも不合格）
                  **「所要 ≧ 天井」からは推測しない**（#211）。推測は、天井を下げた日に
                  過去の完走を打ち切りへ化けさせる
  判定に使う構成  メモリ ${MEMORY_MB} MB
                  出所: ${TIMEOUT_SOURCE} の build_function_memory_mb（書き写していない）
                  **このメモリで走った呼び出しだけを判定に使う**（#211）。別の構成の実測は
                  表に残すが、同じ天井に対する余裕としては並べない
  接近の割合の線  ${NEAR_SHARE}（#164 の分布は 33% が天井の 96% 以上で、それでも
                  気づけなかった。線はそれより手前に要る）
EXPLAIN
  echo "BUILD_HEADROOM_THRESHOLD_OK"
  exit 0
fi

report_window_require_tools jq awk || exit 2
if [[ -z "$EVENTS_FILE" ]]; then
  command -v aws >/dev/null 2>&1 || {
    echo "[build-time] aws CLI がありません。CloudWatch を読めません。" >&2
    exit 2
  }
fi
report_window_resolve "$DAYS" "$FROM" "$TO" "$NOW" || exit 2

if [[ -z "$LOG_GROUP" ]]; then
  LOG_GROUP="$(declared_log_group)" || exit 2
fi

if [[ -n "$EVENTS_FILE" ]]; then
  # 保存しておいた応答を読む。**AWS へは触れない**（--events-file）。
  if [[ ! -f "$EVENTS_FILE" ]]; then
    echo "[build-time] 保存済みの応答が見つかりません: ${EVENTS_FILE}" >&2
    echo "BUILD_HEADROOM_UNKNOWN"
    exit 2
  fi
  EVENTS="$(cat "$EVENTS_FILE")"
  SOURCE_LABEL="${EVENTS_FILE}（保存済みの応答。AWS へは触れていません）"
else
  # **前提の不成立と、実際の乖離を読み分ける。** 未認証やオフラインは「ビルドが速い」
  # ことでも「遅い」ことでもない（scripts/acceptance-remote.sh の冒頭と同じ方針）。
  if ! aws sts get-caller-identity >/dev/null 2>&1; then
    echo "[build-time] AWS へ認証されていません（AWS_PROFILE を設定してください）。" >&2
    echo "[build-time] これは分布の異常ではなく前提の不成立です。判定しません。" >&2
    echo "BUILD_HEADROOM_UNKNOWN"
    exit 2
  fi

  # CloudWatch は UNIX ミリ秒で受け取る。窓は report-window.sh が決めた半開区間そのもの。
  # **--end-time は排他的である**（API の仕様）。半開区間とそのまま噛み合う。
  EVENTS="$(aws logs filter-log-events \
    --log-group-name "$LOG_GROUP" \
    --start-time "$(( REPORT_WINDOW_FROM * 1000 ))" \
    --end-time "$(( REPORT_WINDOW_TO * 1000 ))" \
    --filter-pattern '?"REPORT RequestId" ?"Task timed out"' \
    --output json 2>&1)" || {
    echo "[build-time] ロググループを読めません: ${LOG_GROUP}" >&2
    printf '%s\n' "$EVENTS" | head -5 >&2
    echo "BUILD_HEADROOM_UNKNOWN"
    exit 2
  }
  SOURCE_LABEL="${LOG_GROUP}（CloudWatch の REPORT。読み取りのみ・新しい計測は足していません）"
fi

if ! jq -e '.events | type == "array"' <<<"$EVENTS" >/dev/null 2>&1; then
  echo "[build-time] CloudWatch の応答の形が想定と違います。" >&2
  echo "BUILD_HEADROOM_UNKNOWN"
  exit 2
fi

# REPORT 行から所要時間・メモリ・RequestId を取り出す。
#
#   REPORT RequestId: <id>  Duration: 21086.12 ms  Billed Duration: 21087 ms
#   Memory Size: 3008 MB  Max Memory Used: 432 MB  Init Duration: 475.00 ms
#
# **Duration を使う。** タイムアウトが掛かるのはこの量である（buildMs + compressMs は
# その内訳でしかない）。Init Duration は Duration に含まれないが、コールドかどうかを
# 区別できるよう別に数える（docs/build-function.md: コールドは buildMs 自体が 2 秒伸びる）。
#
# **Memory Size は必ず載っている**（2026-08-31 に本番のログで確認。1769 / 2048 / 3008 /
# 10240 MB の 4 構成が混ざっていた）。載っていない行は 0 として扱い、現在の宣言と
# 一致しないので判定から外れる——**読めなかったものを「現在の構成だ」と見なさない。**
#
# 出力は 1 行 1 呼び出しの TSV: <JST 日番号> <所要ミリ秒> <コールドか> <メモリ MB> <打ち切りか>
PARSED="$(jq -r '.events[] | [(.timestamp | tostring), .message] | @tsv' <<<"$EVENTS" \
  | awk -F '\t' -v off="$REPORT_WINDOW_JST_OFFSET_SECONDS" '
      # RequestId を拾う。**書式に寄りかからない。**
      # REPORT 行は "REPORT RequestId: <id>"、打ち切りの行は
      # "<ISO 時刻> <id> Task timed out after N seconds" である。後者は書式ごと読まず、
      # UUID の形をした語を拾う（ISO 時刻はハイフンが 2 つしかないので当たらない）。
      # **{n} の繰り返し指定は使わない**（awk の実装差。利用者の端末は macOS）。
      function uuid_in(s,   pat) {
        pat = "[0-9a-fA-F][0-9a-fA-F]*-[0-9a-fA-F][0-9a-fA-F]*-[0-9a-fA-F][0-9a-fA-F]*-[0-9a-fA-F][0-9a-fA-F]*-[0-9a-fA-F][0-9a-fA-F]*"
        if (match(s, pat)) return substr(s, RSTART, RLENGTH)
        return ""
      }
      {
        ts = $1; msg = $2
        if (msg ~ /Task timed out/) {
          killed_lines++
          rid = uuid_in(msg)
          if (rid == "") killed_unknown++; else killed[rid] = 1
          next
        }
        if (msg !~ /REPORT RequestId/) next
        if (match(msg, /Duration: [0-9.]+ ms/) == 0) next
        n++
        dur[n] = substr(msg, RSTART + 10, RLENGTH - 13) + 0
        cold[n] = (msg ~ /Init Duration:/) ? 1 : 0
        mem[n] = 0
        if (match(msg, /Memory Size: [0-9]+ MB/)) mem[n] = substr(msg, RSTART + 13, RLENGTH - 16) + 0
        rid_of[n] = uuid_in(msg)
        # 日付は呼び出しの記録時刻から作る。JST の境界は report-window.sh の定数。
        day[n] = int((ts / 1000 + off) / 86400)
      }
      END {
        for (i = 1; i <= n; i++) {
          t = (rid_of[i] != "" && (rid_of[i] in killed)) ? 1 : 0
          if (t) matched[rid_of[i]] = 1
          printf "%d\t%.0f\t%d\t%d\t%d\n", day[i], dur[i], cold[i], mem[i], t
        }
        # **突き合わない打ち切り**（REPORT が窓の外にある等）。どの構成のものか
        # 確かめられないので、件数だけ持って回り、判定には使わない。
        for (k in killed) if (!(k in matched)) orphan++
        printf "#timeout\t%d\t%d\t%d\t0\n", killed_lines + 0, orphan + 0, killed_unknown + 0
      }
    ')"

TIMED_OUT_LINES="$(awk -F '\t' '$1 == "#timeout" { print $2 }' <<<"$PARSED")"
TIMED_OUT_ORPHANS="$(awk -F '\t' '$1 == "#timeout" { print $3 }' <<<"$PARSED")"
TIMED_OUT_UNKNOWN="$(awk -F '\t' '$1 == "#timeout" { print $4 }' <<<"$PARSED")"
SAMPLES="$(awk -F '\t' '$1 != "#timeout"' <<<"$PARSED")"
SAMPLE_COUNT="$(printf '%s' "$SAMPLES" | grep -c . || true)"

# **現在の宣言と同じメモリで走ったものだけを判定に使う**（#211）。
# 外したものは捨てず、別の構成での実測として表に残す。
CURRENT="$(awk -F '\t' -v m="$MEMORY_MB" '$4 == m' <<<"$SAMPLES")"
EXCLUDED="$(awk -F '\t' -v m="$MEMORY_MB" '$4 != m' <<<"$SAMPLES")"
CURRENT_COUNT="$(printf '%s' "$CURRENT" | grep -c . || true)"
EXCLUDED_COUNT="$(printf '%s' "$EXCLUDED" | grep -c . || true)"

# 外したぶんの要約（メモリごと）。<メモリ> <件数> <平均ミリ秒> <最大ミリ秒> <コールド>
EXCLUDED_STATS="$(printf '%s\n' "$EXCLUDED" | awk -F '\t' '
  NF >= 4 { c[$4]++; s[$4] += $2; if ($2 > mx[$4]) mx[$4] = $2; if ($3 == 1) cd[$4]++ }
  END { for (k in c) printf "%d\t%d\t%.0f\t%.0f\t%d\n", k, c[k], s[k] / c[k], mx[k], cd[k] + 0 }' \
  | sort -n)"

##
# 外した理由を出す。**「データが消えた」と読まれない形にする。**
##
emit_excluded() {
  [[ "$EXCLUDED_COUNT" -gt 0 ]] || return 0
  echo
  echo "判定から外した呼び出し（現在の宣言と違うメモリで走ったもの。表からは消していません）:"
  {
    printf 'メモリ(MB)\t呼び出し\t平均(秒)\t最大(秒)\tコールド\n'
    while IFS=$'\t' read -r mem cnt avg mx coldc; do
      [[ -n "$mem" ]] || continue
      printf '%s\t%d\t%.1f\t%.1f\t%d\n' "$mem" "$cnt" \
        "$(awk -v v="$avg" 'BEGIN { print v / 1000 }')" \
        "$(awk -v v="$mx"  'BEGIN { print v / 1000 }')" "$coldc"
    done <<<"$EXCLUDED_STATS"
  } | report_table
  printf '  なぜ外したか: 現在の宣言は %s MB です（%s の build_function_memory_mb）。\n' \
    "$MEMORY_MB" "$TIMEOUT_SOURCE"
  printf '  Lambda はメモリに比例して vCPU を割り当てるため、別のメモリで走った所要は\n'
  printf '  同じ天井に対する余裕として並べられません（#211）。値は上のとおり残しています。\n'
}

if [[ "$SAMPLE_COUNT" -eq 0 ]]; then
  echo "[build-time] ${SOURCE_LABEL}"
  report_window_describe
  echo
  echo "この期間にビルド関数の呼び出しがありません（キャッシュヒットは関数を呼びません）。"
  echo "測っていないことと、測って余裕があることは別です。判定しません。"
  echo "BUILD_HEADROOM_UNKNOWN"
  exit 2
fi

if [[ "$CURRENT_COUNT" -eq 0 ]]; then
  # **「測っていない」と「測って余裕がある」は別である。** 宣言を動かした直後は
  # ここへ来る（新しい構成での呼び出しがまだ 1 件も無い）。**PASS にしない。**
  echo "[build-time] ${SOURCE_LABEL}"
  report_window_describe
  echo
  printf 'この期間に、現在の宣言（メモリ %s MB）で走った呼び出しがありません。\n' "$MEMORY_MB"
  printf '別の構成での呼び出しは %s 件あります（下記）。所要の比較が成立しないため判定しません。\n' \
    "$EXCLUDED_COUNT"
  emit_excluded
  echo
  echo "判定: 現在の構成での実測がありません（測っていないことと、余裕があることは別です）。"
  echo "BUILD_HEADROOM_UNKNOWN"
  exit 2
fi

##
# 日付（JST の日番号）を YYYY-MM-DD へ戻す。
##
day_label() {
  date -u -d "@$(( $1 * 86400 ))" +%F
}

# 日毎の集計と、窓全体の集計。**#149 と同じ日の境界で畳む。**
# **打ち切りは 5 列目（Task timed out と RequestId で突き合わせた結果）で数える。**
# 所要と天井の比較では数えない（#211）。
STATS="$(printf '%s\n' "$CURRENT" | awk -F '\t' -v near="$NEAR_MS" '
  { d[$1]++; sum[$1] += $2; if ($2 > max[$1]) max[$1] = $2
    if ($2 >= near) nearc[$1]++
    if ($5 == 1) overc[$1]++
    if ($3 == 1) cold[$1]++
    n[$1]++; v[$1 "," n[$1]] = $2 }
  END {
    for (k in d) {
      # 中央値と p95 は nearest-rank（並べて位置で選ぶ）。標本が数十件なので
      # 補間しても読み取れるものは変わらず、値が実測のどれかであるほうが追いやすい。
      cnt = n[k]
      for (i = 1; i <= cnt; i++) a[i] = v[k "," i]
      for (i = 2; i <= cnt; i++) { x = a[i]; j = i - 1
        while (j > 0 && a[j] > x) { a[j+1] = a[j]; j-- } ; a[j+1] = x }
      p50 = a[int((cnt * 50 + 99) / 100) < 1 ? 1 : int((cnt * 50 + 99) / 100)]
      p95 = a[int((cnt * 95 + 99) / 100) < 1 ? 1 : int((cnt * 95 + 99) / 100)]
      printf "%s\t%d\t%d\t%d\t%d\t%d\t%d\t%d\n", k, cnt, p50, p95, max[k], nearc[k]+0, overc[k]+0, cold[k]+0
      delete a
    }
  }' | sort)"

TOTAL="$(printf '%s\n' "$CURRENT" | awk -F '\t' -v near="$NEAR_MS" '
  { n++; if ($2 > max) max = $2; if ($2 >= near) nearc++; if ($5 == 1) overc++
    if ($3 == 1) cold++; a[n] = $2 }
  END {
    for (i = 2; i <= n; i++) { x = a[i]; j = i - 1
      while (j > 0 && a[j] > x) { a[j+1] = a[j]; j-- } ; a[j+1] = x }
    p50 = a[int((n * 50 + 99) / 100) < 1 ? 1 : int((n * 50 + 99) / 100)]
    p95 = a[int((n * 95 + 99) / 100) < 1 ? 1 : int((n * 95 + 99) / 100)]
    printf "%d\t%d\t%d\t%d\t%d\t%d\t%d\n", n, p50, p95, max, nearc+0, overc+0, cold+0
  }')"

read -r T_COUNT T_P50 T_P95 T_MAX T_NEAR T_OVER T_COLD <<<"$(tr '\t' ' ' <<<"$TOTAL")"
NEAR_ACTUAL_SHARE="$(awk -v a="$T_NEAR" -v n="$T_COUNT" 'BEGIN { printf "%.4f", (n > 0 ? a / n : 0) }')"

# ── 判定 ────────────────────────────────────────────────────────────────────
#
# **打ち切りが 1 件でもあれば落とす。** 打ち切りは予告ではなく発生であり、そのとき
# 利用者はすでに踏んでいる。接近は割合で見る（1 回の外れ値で鳴らすと、鳴っても見なくなる）。
#
# **打ち切りは実ログで数えている。** 所要が天井を超えているだけの呼び出しは、ここでは
# 打ち切りにしない（#211）——天井を下げた直後、それは過去の完走を指してしまう。
VERDICT="BUILD_HEADROOM_PASS"
EXIT_CODE=0
REASON="天井に対して余裕があります。"
if (( T_OVER > 0 )); then
  VERDICT="BUILD_HEADROOM_NEAR"
  EXIT_CODE=1
  REASON="打ち切られた呼び出しが ${T_OVER} 件あります（\"Task timed out\" の実ログで数えています）。"
elif awk -v s="$NEAR_ACTUAL_SHARE" -v l="$NEAR_SHARE" 'BEGIN { exit !(s >= l) }'; then
  VERDICT="BUILD_HEADROOM_NEAR"
  EXIT_CODE=1
  REASON="接近が ${T_NEAR}/${T_COUNT} 件で、線（${NEAR_SHARE}）を超えています。"
fi

emit_table() {
  echo "[build-time] ${SOURCE_LABEL}"
  report_window_describe
  echo
  {
    printf '日付\t呼び出し\t中央値(秒)\tp95(秒)\t最大(秒)\t接近\t打ち切り\tコールド\n'
    while IFS=$'\t' read -r day cnt p50 p95 mx nearc overc coldc; do
      [[ -n "$day" ]] || continue
      printf '%s\t%d\t%.1f\t%.1f\t%.1f\t%d\t%d\t%d\n' \
        "$(day_label "$day")" "$cnt" \
        "$(awk -v v="$p50" 'BEGIN { print v / 1000 }')" \
        "$(awk -v v="$p95" 'BEGIN { print v / 1000 }')" \
        "$(awk -v v="$mx"  'BEGIN { print v / 1000 }')" \
        "$nearc" "$overc" "$coldc"
    done <<<"$STATS"
    printf '合計\t%d\t%.1f\t%.1f\t%.1f\t%d\t%d\t%d\n' \
      "$T_COUNT" \
      "$(awk -v v="$T_P50" 'BEGIN { print v / 1000 }')" \
      "$(awk -v v="$T_P95" 'BEGIN { print v / 1000 }')" \
      "$(awk -v v="$T_MAX" 'BEGIN { print v / 1000 }')" \
      "$T_NEAR" "$T_OVER" "$T_COLD"
  } | report_table
  echo
  echo "天井とその導出:"
  printf '  - 天井 %s 秒（%s の build_function_timeout_seconds。書き写していません）\n' \
    "$TIMEOUT_SECONDS" "$TIMEOUT_SOURCE"
  printf '  - 接近とみなす線 %s 秒（天井の %s。余裕がこれ未満）\n' "$NEAR_SECONDS" "$NEAR_RATIO"
  printf '  - 打ち切り "Task timed out" の実ログ（1 件でも不合格。所要と天井の比較では数えません）\n'
  printf '  - 判定に使う構成 メモリ %s MB（同じ宣言の build_function_memory_mb）\n' "$MEMORY_MB"
  echo
  echo "注記:"
  printf '  - 呼び出し はビルド関数の実行回数です。ビルド結果キャッシュに当たった生成は関数を呼びません（#149 の生成回数とは母数が違います）。\n'
  printf '  - 中央値・p95 は並べて位置で選んだ実測値です（補間していません）。\n'
  printf '  - コールド は Init Duration が付いた呼び出しです。コールドは buildMs 自体が約 2 秒伸びます（docs/build-function.md）。\n'
  printf '  - 打ち切り は "Task timed out" のログを RequestId で REPORT と突き合わせた件数です（#211）。\n'
  if [[ -n "$TIMED_OUT_ORPHANS" && "$TIMED_OUT_ORPHANS" != "0" ]]; then
    printf '  - 突き合わない打ち切りが %s 件あります（REPORT が窓の外にある等）。どの構成のものか確かめられないため、判定には使っていません。\n' \
      "$TIMED_OUT_ORPHANS"
  fi
  if [[ -n "$TIMED_OUT_UNKNOWN" && "$TIMED_OUT_UNKNOWN" != "0" ]]; then
    printf '  - RequestId を読み取れない打ち切りの行が %s 件あります。同じく判定には使っていません。\n' \
      "$TIMED_OUT_UNKNOWN"
  fi
  emit_excluded
  echo
  echo "判定: ${REASON}"
}

case "$FORMAT" in
  json)
    jq -n \
      --arg logGroup "$LOG_GROUP" \
      --argjson from "$REPORT_WINDOW_FROM" \
      --argjson to "$REPORT_WINDOW_TO" \
      --arg fromLabel "$REPORT_WINDOW_FROM_LABEL" \
      --arg lastLabel "$REPORT_WINDOW_LAST_LABEL" \
      --argjson days "$REPORT_WINDOW_DAYS" \
      --argjson timeoutSeconds "$TIMEOUT_SECONDS" \
      --argjson memoryMb "$MEMORY_MB" \
      --arg timeoutSource "$TIMEOUT_SOURCE" \
      --argjson nearRatio "$NEAR_RATIO" \
      --argjson nearMs "$NEAR_MS" \
      --argjson nearShareLimit "$NEAR_SHARE" \
      --argjson nearShare "$NEAR_ACTUAL_SHARE" \
      --argjson count "$T_COUNT" \
      --argjson p50 "$T_P50" --argjson p95 "$T_P95" --argjson max "$T_MAX" \
      --argjson near "$T_NEAR" --argjson over "$T_OVER" --argjson cold "$T_COLD" \
      --argjson excludedCount "$EXCLUDED_COUNT" \
      --argjson timedOutLines "${TIMED_OUT_LINES:-0}" \
      --argjson timedOutOrphans "${TIMED_OUT_ORPHANS:-0}" \
      --argjson timedOutUnknown "${TIMED_OUT_UNKNOWN:-0}" \
      --arg verdict "$VERDICT" --arg reason "$REASON" \
      --arg rows "$STATS" \
      --arg excludedRows "$EXCLUDED_STATS" \
      '{
         source: "cloudwatch:REPORT",
         logGroup: $logGroup,
         window: { from: $from, to: $to, fromLabel: $fromLabel, lastLabel: $lastLabel,
                   days: $days, boundary: "jst-midnight", interval: "[from, to)" },
         ceiling: { timeoutSeconds: $timeoutSeconds, source: $timeoutSource,
                    memoryMb: $memoryMb,
                    nearRatio: $nearRatio, nearMs: $nearMs, nearShareLimit: $nearShareLimit },
         totals: { calls: $count, p50Ms: $p50, p95Ms: $p95, maxMs: $max,
                   near: $near, over: $over, cold: $cold, nearShare: $nearShare },
         days: ($rows | split("\n") | map(select(length > 0) | split("\t") |
                  { day: (.[0] | tonumber * 86400 | strftime("%Y-%m-%d")),
                    calls: (.[1] | tonumber), p50Ms: (.[2] | tonumber),
                    p95Ms: (.[3] | tonumber), maxMs: (.[4] | tonumber),
                    near: (.[5] | tonumber), over: (.[6] | tonumber),
                    cold: (.[7] | tonumber) })),
         excluded: { calls: $excludedCount,
                     reason: "現在の宣言と違うメモリで走った呼び出し（所要の比較が成立しないため判定から外した。値は残している）",
                     byMemory: ($excludedRows | split("\n") | map(select(length > 0) | split("\t") |
                       { memoryMb: (.[0] | tonumber), calls: (.[1] | tonumber),
                         meanMs: (.[2] | tonumber), maxMs: (.[3] | tonumber),
                         cold: (.[4] | tonumber) })) },
         timedOut: { lines: $timedOutLines, unmatched: $timedOutOrphans,
                     withoutRequestId: $timedOutUnknown,
                     countedFrom: "log:Task timed out" },
         verdict: $verdict,
         reason: $reason
       }'
    ;;
  table)
    emit_table
    ;;
esac

echo "$VERDICT"
exit "$EXIT_CODE"
