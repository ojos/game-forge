#!/usr/bin/env bash
# usage-report.sh — 日毎の生成回数・成功率・費用の推移を出す（#149 / M3-8）
#
# **台帳はあったが、読む手段が無かった。** generations は 1 呼び出しにつき 1 行を持ち
# （4.3 の記録規約 / #22）、created_at / cost_jpy / succeeded / model が入っている。
# それを読むのに毎回 SQL を手で書いて wrangler へ渡していた。
#
# **推移が見えないと、ずれに気づくのが「本番で 1 回通したとき」になる。** ~~2026-08-28 の
# 本番初通過で、1 生成あたりの実測が約 16 円（見込み 12 円）と分かった。4.3 の月次上限は
# 1 万円で、**上限へ張り付いてから気づくのでは遅い。**~~
#
# **→ この例は 1 度きりではなかった（#296）。** 同じずれがもう一段進んでいる。
#
#   見込み 12 円 → 実測 約 16 円（2026-08-28 / n=2） → **¥22.41**（2026-09-04 /
#   本番の既定群 20 件の平均。直近 10 件は ¥26.75）
#
# **見込みの 1.87 倍である。** 月次上限も #284 で 1 万 → 2 万円へ引き直した。数え直すと
# 2 万円 ÷ ¥22.41 ＝ **892 生成/月**、30 日で割って **29.7 生成/日** で、4.3 の逆算が
# いま置いている母数と一致する。**上限へ張り付いてから気づくのでは遅い、はそのまま
# 生きている**——むしろ #284 でソース上限を 64KB へ上げた以上、単価はこれからも上がる
# （上限まで出したときの試算は ¥75）。**このスクリプトを定期的に回す理由がそれである。**
#
# 使い方:
#   bash scripts/usage-report.sh                          # 手元の D1・直近 14 日
#   bash scripts/usage-report.sh --remote --days 30       # 本番の D1・直近 30 日
#   bash scripts/usage-report.sh --by-model               # モデル別に割る（#25 が乗る形）
#   bash scripts/usage-report.sh --from 2026-08-01 --to 2026-08-31 --format json
#
# 期間の指定・日の境界・日付の綴りは scripts/report-window.sh が持つ（**#166 の
# ビルド時間の集計と同じ定義である**）。ここへ書き写さない。
#
# 出力: 日付 / 生成回数 / LLM成功 / LLM成功率 / 費用合計 / 1 回あたり（+ --by-model でモデル）
# 終了コード: 0 = 表を出せた（0 行でも成功） / 1 = 出せなかった
#
# ── 読み取りのみ ────────────────────────────────────────────────────────────
#
# **本番 D1 へ書き込まない**（#149 の constraints）。呼びかけではなく、送る前に
# 組み立てた SQL が select で始まることを検査して担保する（send_query）。
#
# ── succeeded を「成功率」と呼ばない理由 ────────────────────────────────────
#
# **succeeded は LLM 呼び出しの成否であって、パイプライン全体の成否ではない**
# （src/cost-ledger.ts の isUsableGeneration。end_turn で返ったかどうか）。3.3 の順序では
# 費用計上がビルドより前にあり、**この列が立った時点でビルドはまだ走っていない。**
#
# **2026-08-29 に succeeded=1 のまま作品にならなかった行が実際に出ている**（ビルドの
# タイムアウト。#164 / #166）。この列を「作品ができた率」と読むと、その日は 100% に
# 見える。**列の意味は表のたびに印字する**（凡例を読まずに数字だけ持ち出されるため）。
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(dirname "$HERE")"
cd "$ROOT"

# shellcheck source=scripts/report-window.sh
. "$HERE/report-window.sh"

SCOPE="--local"
DAYS=""
FROM=""
TO=""
BY_MODEL=0
FORMAT="table"
PERSIST_TO=""
NOW="${USAGE_REPORT_NOW:-$(date -u +%s)}"

usage() {
  sed -n '2,26p' "${BASH_SOURCE[0]}" >&2
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --local)      SCOPE="--local"; shift ;;
    --remote)     SCOPE="--remote"; shift ;;
    --days)       DAYS="${2:-}"; shift 2 ;;
    --from)       FROM="${2:-}"; shift 2 ;;
    --to)         TO="${2:-}"; shift 2 ;;
    --by-model)   BY_MODEL=1; shift ;;
    --format)     FORMAT="${2:-}"; shift 2 ;;
    # 手元の D1 の置き場所を差し替える。scripts/report-selftest.sh が
    # 使い捨ての D1 を作って検査するための口で、**開発者の手元の D1 を汚さない。**
    --persist-to) PERSIST_TO="${2:-}"; shift 2 ;;
    -h|--help)    usage; exit 0 ;;
    *)
      echo "[usage-report] 不明な引数です: $1" >&2
      exit 1 ;;
  esac
done

case "$FORMAT" in
  table|tsv|json) ;;
  *)
    echo "[usage-report] --format は table / tsv / json のいずれかです: ${FORMAT}" >&2
    exit 1 ;;
esac

if [[ -n "$PERSIST_TO" && "$SCOPE" == "--remote" ]]; then
  echo "[usage-report] --persist-to は手元の D1 専用です（--remote とは併用できません）。" >&2
  exit 1
fi

report_window_require_tools jq npx || exit 1
report_window_resolve "$DAYS" "$FROM" "$TO" "$NOW" || exit 1

##
# D1 へ問い合わせ、results（JSON 配列）を標準出力へ返す。
#
# **select で始まらない文は送らない。** #149 は「読み取りのみ」を制約に挙げている。
# 呼びかけで守るものにせず、送る直前に見る。組み立てるのはこのファイル自身だが、
# **組み立てを間違えたときに本番へ届く経路を残さない。**
#
# @param $1 SQL
##
send_query() {
  local sql="$1"
  if [[ ! "$sql" =~ ^[[:space:]]*select[[:space:]] ]]; then
    echo "[usage-report] select で始まらない文は送りません（読み取りのみ）。" >&2
    return 1
  fi

  local args=(d1 execute DB --command "$sql" --json)
  if [[ "$SCOPE" == "--remote" ]]; then
    # 本番の D1 は [env.production] 側にしか宣言が無い。--env を落とすと
    # トップレベル（local-only-placeholder）を引きに行く。
    args+=(--remote --env production)
    # wrangler は CLOUDFLARE_API_TOKEN を自分で読むが、非対話シェルには .env が
    # 載っていない。値はこのスクリプトへ持ち込まず、環境へ移すだけにする
    # （scripts/wasm-exec-versions.sh と同じ形）。
    if [[ -z "${CLOUDFLARE_API_TOKEN:-}" && -f "$HERE/load-project-env.sh" ]]; then
      # shellcheck source=scripts/load-project-env.sh
      . "$HERE/load-project-env.sh"
    fi
  else
    args+=(--local)
    if [[ -n "$PERSIST_TO" ]]; then
      args+=(--persist-to "$PERSIST_TO")
    fi
  fi

  local out
  # CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV=false は本リポジトリの規約
  # （docs/local-dev.md「シークレットの置き場所」）。Worker を起動しないが例外を作らない。
  if ! out="$(CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV=false npx wrangler "${args[@]}" 2>&1)"; then
    echo "[usage-report] D1 を読めません（${SCOPE}）:" >&2
    printf '%s\n' "$out" >&2
    return 1
  fi

  # --json でも wrangler は前置きの行を混ぜることがある。最初の [ から後ろを渡す。
  local json
  json="$(printf '%s' "$out" | sed -n '/^\[/,$p')"
  if [[ -z "$json" ]]; then
    echo "[usage-report] wrangler の応答に JSON が含まれていません（${SCOPE}）:" >&2
    printf '%s\n' "$out" >&2
    return 1
  fi

  # **形を先に検査する。** jq の `?` は型が違っても黙って空を返すため、これに頼ると
  # **wrangler の --json の形が変わった日に、集計が静かに 0 行になる。** 0 行は
  # 「その期間に生成が無かった」と読めてしまい、いちばん気づけない壊れ方になる。
  if ! jq -e '(type == "array") and (.[0] | type == "object") and (.[0].results | type == "array")' \
       <<<"$json" >/dev/null 2>&1; then
    echo "[usage-report] D1 の応答の形が想定と違います（wrangler --json の形が変わった可能性があります）。" >&2
    echo "[usage-report] 想定: [{\"results\": [ ... ]}]" >&2
    printf '%s' "$json" | head -c 1000 >&2
    echo >&2
    return 1
  fi
  jq -c '.[0].results' <<<"$json"
}

# ── 集計 ────────────────────────────────────────────────────────────────────
#
# **日の綴りは SQL の中で作るが、オフセットは report-window.sh の定数から渡す。**
# ここへ値そのものを書くと、#166 の集計と別々に古くなる余地ができる（持っていないことは
# scripts/report-selftest.sh の 1 節が機械で見る）。
#
# **model 別に割れる形にしてある**（#25 / M3-4 の effort の A/B が同じ台帳から成功率と
# 実コストを集計する）。--by-model の有無で group by の粒度だけが変わり、数え方
# （窓・境界・1 行 = 1 呼び出し）は変わらない。**合計が変わらないことは自己検査が見る。**
GROUP_COLS="day"
SELECT_COLS="strftime('%Y-%m-%d', created_at + ${REPORT_WINDOW_JST_OFFSET_SECONDS}, 'unixepoch') as day"
if (( BY_MODEL )); then
  SELECT_COLS="${SELECT_COLS}, model"
  GROUP_COLS="day, model"
fi

SQL="select ${SELECT_COLS},
       count(*) as calls,
       sum(succeeded) as llm_succeeded,
       sum(cost_jpy) as cost_jpy
  from generations
 where created_at >= ${REPORT_WINDOW_FROM} and created_at < ${REPORT_WINDOW_TO}
 group by ${GROUP_COLS}
 order by ${GROUP_COLS}"

ROWS="$(send_query "$SQL")" || exit 1

# **数値へ寄せてから整形する。** 0 行のときの sum は null になる。null をそのまま
# 割ると "null" という文字列が表へ出る。
NORMALIZED="$(jq -c '
  map({
    day:   (.day // ""),
    model: (.model // null),
    calls: (.calls // 0),
    llmSucceeded: (.llm_succeeded // 0),
    costJpy: (.cost_jpy // 0)
  })
' <<<"$ROWS")"

TOTALS="$(jq -c '
  {
    calls: (map(.calls) | add // 0),
    llmSucceeded: (map(.llmSucceeded) | add // 0),
    costJpy: (map(.costJpy) | add // 0)
  }
' <<<"$NORMALIZED")"

# 列の意味。**表と JSON の両方へ同じ文を載せる。** 凡例を出力の外（この文書や docs/）
# だけに置くと、数字を貼り付けた先には意味が付いてこない。
NOTE_CALLS='生成回数 は台帳の行数です。1 行 = 費用の出る LLM 呼び出し 1 回（リトライも 1 行、費用ゼロの機械修正は行を作りません）。'
NOTE_SUCCEEDED='LLM成功 は generations.succeeded の合計です。「LLM 呼び出しが使えるソースを返したか」であって、作品ができたかではありません（ビルドはこの列より後段にあり、succeeded=1 のまま作品にならなかった行が実在します）。'
NOTE_PARTIAL='最終日は途中までの集計です（--days は今日を含みます）。'
readonly NOTE_CALLS NOTE_SUCCEEDED NOTE_PARTIAL

# 小数の桁を固定する jq の定義。**表の桁を揃えるためだけのものである。**
# jq に printf は無く、tostring は 3.5 を "3.5" にする。列の中で 3.5 と 15.75 が
# 混ざると、幅を揃えても小数点の位置が揃わない。
JQ_FORMAT_DEFS='
  def fixed2: (. * 100 | round) as $c
    | (($c / 100) | floor) as $i
    | ($c - $i * 100) as $f
    | ($i | tostring) + "." + (if $f < 10 then "0" else "" end) + ($f | tostring);
  def fixed1: (. * 10 | round) as $c
    | (($c / 10) | floor) as $i
    | ($c - $i * 10) as $f
    | ($i | tostring) + "." + ($f | tostring);
'
readonly JQ_FORMAT_DEFS

##
# 集計を TSV で書き出す（1 行目が見出し、最終行が合計）。
#
# 表・TSV の両方がここを通る。**見出しの綴りを 2 か所に持たない。**
##
emit_tsv() {
  if (( BY_MODEL )); then
    printf '日付\tモデル\t生成回数\tLLM成功\tLLM成功率\t費用合計(円)\t1回あたり(円)\n'
  else
    printf '日付\t生成回数\tLLM成功\tLLM成功率\t費用合計(円)\t1回あたり(円)\n'
  fi
  jq -r --argjson byModel "$BY_MODEL" "${JQ_FORMAT_DEFS}"'
    .[] |
    [ .day ]
    + (if $byModel == 1 then [ (.model // "(不明)") ] else [] end)
    + [ (.calls | tostring),
        (.llmSucceeded | tostring),
        (if .calls > 0 then ((.llmSucceeded * 100 / .calls) | fixed1) + "%" else "-" end),
        (.costJpy | fixed2),
        (if .calls > 0 then ((.costJpy / .calls) | fixed2) else "-" end) ]
    | @tsv
  ' <<<"$NORMALIZED"
  # 合計行。**窓の全体をひとまとめにした数字を必ず出す。** 日毎だけだと
  # 「月次上限 1 万円に対していまどこか」を読むのに読み手が足し算をすることになる。
  jq -r --argjson byModel "$BY_MODEL" "${JQ_FORMAT_DEFS}"'
    [ "合計" ]
    + (if $byModel == 1 then [ "" ] else [] end)
    + [ (.calls | tostring),
        (.llmSucceeded | tostring),
        (if .calls > 0 then ((.llmSucceeded * 100 / .calls) | fixed1) + "%" else "-" end),
        (.costJpy | fixed2),
        (if .calls > 0 then ((.costJpy / .calls) | fixed2) else "-" end) ]
    | @tsv
  ' <<<"$TOTALS"
}

case "$FORMAT" in
  json)
    jq -n \
      --argjson rows "$NORMALIZED" \
      --argjson totals "$TOTALS" \
      --arg scope "$SCOPE" \
      --argjson from "$REPORT_WINDOW_FROM" \
      --argjson to "$REPORT_WINDOW_TO" \
      --arg fromLabel "$REPORT_WINDOW_FROM_LABEL" \
      --arg lastLabel "$REPORT_WINDOW_LAST_LABEL" \
      --argjson days "$REPORT_WINDOW_DAYS" \
      --argjson byModel "$BY_MODEL" \
      --arg noteCalls "$NOTE_CALLS" \
      --arg noteSucceeded "$NOTE_SUCCEEDED" \
      --arg notePartial "$NOTE_PARTIAL" \
      '{
         source: "d1:generations",
         scope: $scope,
         byModel: ($byModel == 1),
         window: { from: $from, to: $to, fromLabel: $fromLabel, lastLabel: $lastLabel,
                   days: $days, boundary: "jst-midnight", interval: "[from, to)" },
         notes: [ $noteCalls, $noteSucceeded, $notePartial ],
         rows: $rows,
         totals: $totals
       }'
    ;;
  tsv)
    emit_tsv
    ;;
  table)
    if [[ "$SCOPE" == "--remote" ]]; then
      echo "[usage-report] 生成の台帳（generations）／ 本番 D1（読み取りのみ）"
    else
      echo "[usage-report] 生成の台帳（generations）／ 手元の D1"
    fi
    report_window_describe
    echo
    if [[ "$(jq 'length' <<<"$NORMALIZED")" == "0" ]]; then
      echo "(この期間に generations の行はありません)"
    else
      emit_tsv | report_table
    fi
    echo
    echo "注記:"
    printf '  - %s\n' "$NOTE_CALLS"
    printf '  - %s\n' "$NOTE_SUCCEEDED"
    printf '  - %s\n' "$NOTE_PARTIAL"
    ;;
esac

# 一意な通過信号。**0 行でも成功である**（「その期間に生成が無かった」は正常な答えで、
# 集計できなかったこととは別である）。TSV と JSON は機械が読む出力なので混ぜない。
if [[ "$FORMAT" == "table" ]]; then
  echo "USAGE_REPORT_PASS"
fi
exit 0
