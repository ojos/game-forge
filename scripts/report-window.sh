#!/usr/bin/env bash
# report-window.sh — 集計の「数え方」の正本（#149 / #166）
#
# **このファイルが 1 本あることが、2 つの集計が同じ数え方であることの担保である。**
#
# #149（生成回数と費用）と #166（ビルド時間）は、読む先が違う（D1 の generations と
# CloudWatch の REPORT 行）。それでも **期間の切り方・日の境界・日付の綴り** を別々に
# 持たせない。持たせると、同じ「2026-08-29 の」という語が 2 つの表で別の 24 時間を
# 指すようになり、**並べても比較が成立しない**（#166 の constraints）。
#
# 使い方: 実行ではなく source する。
#
#   . "$(dirname "${BASH_SOURCE[0]}")/report-window.sh"
#
# 直接実行すると、定義そのもの（境界と窓の切り方）を印字して終わる。
# 定義を確かめたい人がスクリプトを読まずに済むようにするためで、検査ではない。
#
#   bash scripts/report-window.sh
#
# ── 日の境界 ────────────────────────────────────────────────────────────────
#
# **JST の 0 時で切る**（確定25 / src/quota.ts の jstDayRange）。UTC で切ると日次枠の
# 判定（1 人 1 日 10 回。#284 で 12 回から）と食い違い、「枠を使い切った日」と
# 「表に出る日」が 9 時間ずれる。
#
# **オフセットの値をここへ書き写しているように見えるが、写しは機械照合される。**
# scripts/usage-report-selftest.sh が src/quota.ts の JST_OFFSET_SECONDS と突き合わせ、
# 一致しなければ落とす（shared-ai-rules 12 章「一覧の複製は機械照合で担保する」）。
# シェルから TypeScript の定数を実行時に引く手段が無い以上、写しを置かない選択肢は
# 無いが、**古くなったまま通る経路は塞げる。**

# JST の UTC からの差（秒）。日本は夏時間を持たないため固定でよい。
# src/quota.ts / src/cost-ledger.ts の JST_OFFSET_SECONDS と同じ値である
# （一致は scripts/usage-report-selftest.sh が機械で見る）。
REPORT_WINDOW_JST_OFFSET_SECONDS=32400

# 1 日の秒数。閏秒は UNIX 時間に現れないため固定でよい。
REPORT_WINDOW_DAY_SECONDS=86400

# --days の既定。**2 週間である。**
#
# #166 が予告に失敗した分布は 15 回で、そこには「旧設定に張り付いていた頃」の 3 回が
# 混ざっていた。設定を変えた前後が 1 つの窓に入ると、分布が二山になって傾向が読めない。
# 生成が月およそ 840 本（4.3 の想定）なら 2 週間で 400 本前後になり、割合の判定に足りる。
REPORT_WINDOW_DEFAULT_DAYS=14

##
# 前提となる道具があるか確かめる。
#
# **道具の不在は「異常な分布」ではなく前提の不成立である。** 確認せずに進むと、jq が
# 無いだけの状態が「集計できない」として報告され、直すべきものを取り違える
# （scripts/wasm-exec-versions.sh と同じ方針）。
#
# @param $@ 必要なコマンド名
# @return 0 = 揃っている / 1 = 足りない
##
report_window_require_tools() {
  local tool missing=0
  for tool in "$@"; do
    command -v "$tool" >/dev/null 2>&1 || {
      echo "[report-window] ${tool} がありません。集計できません。" >&2
      missing=1
    }
  done
  # date は GNU 拡張（-d @<epoch>）を使う。BusyBox や BSD の date では綴りが違い、
  # **黙って別の日付を出す**ことがあるので、書式ではなく実際の変換で確かめる。
  if [[ "$(date -u -d @0 +%F 2>/dev/null)" != "1970-01-01" ]]; then
    echo "[report-window] date が -d @<epoch> を解釈しません（GNU date が要ります）。" >&2
    missing=1
  fi
  return "$missing"
}

##
# ある時刻が属する JST の暦日の始まり（UNIX 秒）を返す。
#
# src/quota.ts の jstDayRange().fromSeconds と同じ値になる。
#
# @param $1 基準時刻（UNIX 秒）
# @return 標準出力へ JST 0 時の UNIX 秒
##
report_window_day_start() {
  local at="$1" shifted
  # JST の壁時計を UTC のまま読むために、先に 9 時間ぶん進めてから切り捨てる。
  shifted=$(( at + REPORT_WINDOW_JST_OFFSET_SECONDS ))
  # bash の整数除算は 0 方向へ丸める。1970-01-01 より前は扱わないので、
  # 切り捨てと床関数の差は問題にならない（generations.created_at は常に正）。
  echo $(( shifted / REPORT_WINDOW_DAY_SECONDS * REPORT_WINDOW_DAY_SECONDS \
           - REPORT_WINDOW_JST_OFFSET_SECONDS ))
}

##
# ある時刻の JST の日付（YYYY-MM-DD）を返す。
#
# **表に出る日付の綴りはここだけで決まる。** SQL 側（usage-report.sh）は
# strftime('%Y-%m-%d', created_at + <オフセット>, 'unixepoch') で同じ値を作るが、
# オフセットは同じ定数から渡す。
#
# @param $1 時刻（UNIX 秒）
# @return 標準出力へ YYYY-MM-DD
##
report_window_label() {
  date -u -d "@$(( $1 + REPORT_WINDOW_JST_OFFSET_SECONDS ))" +%F
}

##
# YYYY-MM-DD（JST の暦日）を、その日の 0 時の UNIX 秒へ写す。
#
# **綴りを先に閉じる。** date は "2026-8-3" や "yesterday" も解釈するため、
# 受け取った文字列をそのまま渡すと、指定した覚えのない窓で集計した表が出る。
#
# @param $1 YYYY-MM-DD
# @return 標準出力へ UNIX 秒 / 1 = 綴りが不正
##
report_window_parse_date() {
  local text="$1" epoch
  if [[ ! "$text" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]]; then
    echo "[report-window] 日付は YYYY-MM-DD で指定してください: ${text}" >&2
    return 1
  fi
  if ! epoch="$(date -u -d "${text}T00:00:00Z" +%s 2>/dev/null)"; then
    echo "[report-window] 日付として解釈できません: ${text}" >&2
    return 1
  fi
  # 上で UTC の 0 時として読んだので、JST の 0 時へ戻す。
  echo $(( epoch - REPORT_WINDOW_JST_OFFSET_SECONDS ))
}

##
# 集計する窓を決める。**両方の集計がこの 1 か所から窓を受け取る。**
#
# 決まるもの（すべて大域変数として置く）:
#   REPORT_WINDOW_FROM        下端（UNIX 秒。この値を含む）
#   REPORT_WINDOW_TO          上端（UNIX 秒。この値を含まない）
#   REPORT_WINDOW_FROM_LABEL  下端の JST 日付
#   REPORT_WINDOW_LAST_LABEL  上端の直前の JST 日付（表の最終行になる日）
#   REPORT_WINDOW_DAYS        窓に入る暦日の数
#
# **半開区間である**（src/quota.ts / src/cost-ledger.ts と同じ）。境界の 1 行が
# 2 つの日に数えられる経路を作らない。
#
# **--days は「今日を含む直近 N 日」である。** 最終日は途中までしか埋まっていない。
# 途中の日を落とすと「今日の急増」が翌日まで見えず、#166 が防ごうとしている
# 「踏んでから気づく」に戻る。**部分的な日であることは表の側で明示する。**
#
# @param $1 days（--from/--to を使うときは空文字）
# @param $2 from（YYYY-MM-DD。使わないときは空文字）
# @param $3 to（YYYY-MM-DD。**その日を含む**。使わないときは空文字）
# @param $4 現在時刻（UNIX 秒）
# @return 0 = 決まった / 1 = 指定が不正
##
report_window_resolve() {
  local days="$1" from="$2" to="$3" now="$4"

  if [[ -n "$days" && ( -n "$from" || -n "$to" ) ]]; then
    echo "[report-window] --days と --from/--to は同時に指定できません。" >&2
    return 1
  fi

  if [[ -n "$from" || -n "$to" ]]; then
    if [[ -z "$from" || -z "$to" ]]; then
      echo "[report-window] --from と --to は両方を指定してください。" >&2
      return 1
    fi
    REPORT_WINDOW_FROM="$(report_window_parse_date "$from")" || return 1
    local to_start
    to_start="$(report_window_parse_date "$to")" || return 1
    # --to はその日を含む。上端は翌 0 時になる。
    REPORT_WINDOW_TO=$(( to_start + REPORT_WINDOW_DAY_SECONDS ))
  else
    [[ -n "$days" ]] || days="$REPORT_WINDOW_DEFAULT_DAYS"
    if [[ ! "$days" =~ ^[0-9]+$ ]] || (( days < 1 )); then
      echo "[report-window] --days は 1 以上の整数で指定してください: ${days}" >&2
      return 1
    fi
    local today
    today="$(report_window_day_start "$now")"
    REPORT_WINDOW_FROM=$(( today - (days - 1) * REPORT_WINDOW_DAY_SECONDS ))
    REPORT_WINDOW_TO=$(( today + REPORT_WINDOW_DAY_SECONDS ))
  fi

  if (( REPORT_WINDOW_FROM >= REPORT_WINDOW_TO )); then
    echo "[report-window] 窓が空です（--from が --to より後）。" >&2
    return 1
  fi

  REPORT_WINDOW_DAYS=$(( (REPORT_WINDOW_TO - REPORT_WINDOW_FROM) / REPORT_WINDOW_DAY_SECONDS ))
  REPORT_WINDOW_FROM_LABEL="$(report_window_label "$REPORT_WINDOW_FROM")"
  REPORT_WINDOW_LAST_LABEL="$(report_window_label $(( REPORT_WINDOW_TO - 1 )))"
  return 0
}

##
# 窓の説明を 1 行で返す。**2 つの表が同じ文で窓を名乗る。**
#
# @return 標準出力へ 1 行
##
report_window_describe() {
  printf '期間: %s 〜 %s（JST の暦日で %d 日ぶん / 半開区間 [%d, %d)）\n' \
    "$REPORT_WINDOW_FROM_LABEL" "$REPORT_WINDOW_LAST_LABEL" \
    "$REPORT_WINDOW_DAYS" "$REPORT_WINDOW_FROM" "$REPORT_WINDOW_TO"
}

##
# TSV を読んで、桁を揃えた表として印字する。**2 つの表が同じ見た目になる。**
#
# 1 行目を見出しとして扱う。列の幅は**表示幅**で数える。日本語の見出しは 1 文字が
# 3 バイトなので、バイト数で揃えると見出しだけが右へずれる。
#
# 幅の見積もりは「バイト数 − 3 バイト文字の先頭バイト数」である。3 バイトの UTF-8
# （CJK と全角記号）を幅 2、それ以外を幅 1 とみなす近似で、この表に出る文字
# （日付・数値・日本語の見出し）には十分である。
#
# 数値だけの列は右へ、それ以外は左へ寄せる。
#
# 標準入力: TSV（1 行目が見出し）
##
report_table() {
  LC_ALL=C awk -F '\t' '
    # 表示幅の見積もり。LC_ALL=C なので length() はバイト数を返す。
    # 3 バイト UTF-8（CJK と全角記号）の先頭バイト 0xE0-0xEF 1 つにつき、
    # 3 バイトで幅 2 なので幅を 1 減らす。
    function dwidth(s,   lead) {
      lead = gsub(/[\340-\357]/, "&", s)
      return length(s) - lead
    }
    {
      for (i = 1; i <= NF; i++) {
        cell[NR, i] = $i
        w = dwidth($i)
        if (w > width[i]) width[i] = w
        # 見出し行は判定に入れない（数値列でも見出しは日本語である）。
        if (NR > 1 && $i != "" && $i !~ /^-?[0-9][0-9.,]*%?$/) numeric[i] = 0
      }
      if (NF > cols) cols = NF
      rows = NR
    }
    END {
      if (rows == 0) exit 0
      for (i = 1; i <= cols; i++) if (!(i in numeric)) numeric[i] = 1
      for (r = 1; r <= rows; r++) {
        line = ""
        for (i = 1; i <= cols; i++) {
          v = cell[r, i]
          pad = width[i] - dwidth(v)
          if (pad < 0) pad = 0
          spaces = sprintf("%" pad "s", "")
          line = line (numeric[i] ? spaces v : v spaces)
          if (i < cols) line = line "  "
        }
        sub(/[ ]+$/, "", line)
        print line
        if (r == 1) {
          line = ""
          for (i = 1; i <= cols; i++) {
            for (k = 0; k < width[i]; k++) line = line "-"
            if (i < cols) line = line "  "
          }
          print line
        }
      }
    }
  '
}

# 直接実行されたときは、定義そのものを印字する（検査ではない）。
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
  cat <<DEFN
[report-window] 集計の数え方の定義（#149 / #166 が共有する）

  日の境界        JST の 0 時（UTC+${REPORT_WINDOW_JST_OFFSET_SECONDS} 秒）
                  src/quota.ts の jstDayRange と同じ切り方
  区間            半開区間 [from, to)
  --days N        今日を含む直近 N 日（既定 ${REPORT_WINDOW_DEFAULT_DAYS}。最終日は途中まで）
  --from / --to   どちらも JST の暦日。--to はその日を含む

  この定義を使う集計:
    scripts/usage-report.sh       生成回数・成功率・費用（D1 の generations）
    scripts/build-time-report.sh  ビルド時間の分布（CloudWatch の REPORT 行）
DEFN
fi
