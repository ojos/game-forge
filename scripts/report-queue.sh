#!/usr/bin/env bash
# report-queue.sh — 審査待ちの作品を、本番の台帳から読む（8.4 / #40）
#
# ## なぜスクリプトなのか
#
# **仕様書 8.4 は運用画面を要求していない。** 求めているのはワンタップ通報・審査キューへの
# 投入・削除申請フォーム・記録の 4 つで、画面はどこにも出てこない（#40 の intake /
# 2026-09-03）。
#
# **画面を作らないと、管理者の識別が不要になる。** 権限は Cloudflare の資格情報そのもので、
# **新しい認証経路を 1 つも作らない。** このリポジトリの運用は既にすべてスクリプトである
# （usage-report.sh / ogp-stale-report.sh / kpi-report.sh / moderation-prune.sh）。
#
# 使い方:
#   bash scripts/report-queue.sh --remote            # 本番（読み取りのみ）
#   bash scripts/report-queue.sh                     # 手元の D1（既定）
#   bash scripts/report-queue.sh --remote --format json
#
# 終了コード:
#   0 = REPORT_QUEUE_EMPTY（審査待ちは無い）
#   1 = REPORT_QUEUE_FOUND（有る。一覧を出す）
#   2 = 前提の不成立（未認証・道具が無い・応答の形が違う）
#
# **1 と 2 を分ける。** 「審査待ちが有った」と「調べられなかった」は別である
# （`scripts/ogp-stale-report.sh` と同じ線）。
#
# ── 進めるのはこのスクリプトの仕事ではない ──────────────────────────────────
#
# **本番へは select しか送らない。** 見た結果どうするか（`cleared` にする／`status` を
# 動かす／利用者を BAN する）は**別の操作**であり、`--delete` のような口をここへ付けない。
# `scripts/ogp-stale-report.sh` が「進めるのはこのスクリプトの仕事ではない」と書いたのと
# 同じ規律である。**読むことと変えることを、別のコマンドに分ける。**
#
# ── UGC を持ち出さない（8.2 / 8.3）────────────────────────────────────────
#
# **題名も通報の理由も出さない。** 題名はプロンプト由来の UGC で（`src/games.ts` の
# `draftTitleFromPrompt`）、理由は通報者が書いた自由記述である。**運用が最初に要るのは
# 「どれを見るか」だけ**なので、id と件数と時刻に留める。**中身は作品ページで見る**
# ——そこには既に権限の判定がある。
#
# **GNU 拡張を使わない**（利用者の端末は macOS / bash 3.2。docs/handoff.md 3 章）。
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)" || exit 2
ROOT="$(dirname "$HERE")"
cd "$ROOT" || exit 2

REPORTS_TS="src/reports.ts"
SCOPE="--local"
PERSIST_TO=""
FORMAT="table"

##
# 値を取る引数に、値が付いていることを確かめる（#42 / #276 で 3 本に同じ形があった）。
#
# @param $1 引数の綴り
# @param $2 残りの個数
##
require_value() {
  if [[ "$2" -lt 2 ]]; then
    echo "[queue] $1 には値が要ります。" >&2
    exit 2
  fi
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --remote)     SCOPE="--remote"; shift ;;
    --local)      SCOPE="--local"; shift ;;
    --persist-to) require_value "$1" "$#"; PERSIST_TO="$2"; shift 2 ;;
    --format)     require_value "$1" "$#"; FORMAT="$2"; shift 2 ;;
    -h|--help)    sed -n '2,20p' "${BASH_SOURCE[0]}" >&2; exit 0 ;;
    *) echo "[queue] 不明な引数です: $1" >&2; exit 2 ;;
  esac
done

if [[ "$FORMAT" != "table" && "$FORMAT" != "json" ]]; then
  echo "[queue] --format は table か json です: ${FORMAT}" >&2
  exit 2
fi
if [[ -n "$PERSIST_TO" && "$SCOPE" == "--remote" ]]; then
  echo "[queue] --persist-to は手元の D1 専用です（--remote とは併用できません）。" >&2
  exit 2
fi
if ! command -v jq >/dev/null 2>&1; then
  echo "[queue] jq がありません（応答の形を確かめるのに要ります）。" >&2
  exit 2
fi

# **状態の綴りを src/reports.ts から取り出す。書き写さない。**
# 綴りがずれると、**キューに入っているのに 0 件と報告する**——いちばん気づけない
# 壊れ方である（`scripts/ogp-stale-report.sh` が閾値でやっているのと同じ）。
if [[ ! -f "$REPORTS_TS" ]]; then
  echo "[queue] 定義の正本がありません: ${REPORTS_TS}" >&2
  exit 2
fi
# **書式のゆれに耐える形にする。** 空白が 1 つ増えただけ・値に `-` が入っただけで
# 取り出せなくなると、**キューに入っているのに 0 件と報告する**（実測で両方壊れた）。
# `scripts/check-ogp-copies.sh` が採っている `[[:space:]]*` と `[^']*` に揃える。
QUEUED="$(sed -n "s/^export const REVIEW_QUEUED[[:space:]]*=[[:space:]]*'\([^']*\)'.*/\1/p" "$REPORTS_TS" | head -1)"
if [[ -z "$QUEUED" ]]; then
  echo "[queue] ${REPORTS_TS} から REVIEW_QUEUED を取り出せません。" >&2
  echo "[queue] 綴りが変わったなら、このスクリプトの sed も直してください。" >&2
  exit 2
fi

##
# 読み取りだけを送る。**select で始まらない文は送らない。**
#
# @param $1 SQL
##
send_query() {
  local sql="$1"
  if [[ ! "$sql" =~ ^[[:space:]]*select[[:space:]] ]]; then
    echo "[queue] select で始まらない文は送りません（読み取りのみ）。" >&2
    return 1
  fi

  local args=(d1 execute DB --command "$sql" --json)
  if [[ "$SCOPE" == "--remote" ]]; then
    args+=(--remote --env production)
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
  if ! out="$(CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV=false npx wrangler "${args[@]}" 2>&1)"; then
    echo "[queue] D1 を読めません（${SCOPE}）:" >&2
    printf '%s\n' "$out" >&2
    if printf '%s' "$out" | grep -q 'no such'; then
      echo "[queue] 表や列がありません。マイグレーションが未適用の可能性があります:" >&2
      echo "[queue]   npm run db:migrate" >&2
    fi
    return 1
  fi

  local json
  json="$(printf '%s' "$out" | sed -n '/^\[/,$p')"
  if [[ -z "$json" ]]; then
    echo "[queue] wrangler の応答に JSON が含まれていません:" >&2
    printf '%s\n' "$out" >&2
    return 1
  fi
  # **形を先に検査する。** 静かに 0 行にすると「審査待ちが無い」と読める。
  if ! jq -e '(type == "array") and (.[0] | type == "object") and (.[0].results | type == "array")' \
       <<<"$json" >/dev/null 2>&1; then
    echo "[queue] D1 の応答の形が想定と違います:" >&2
    printf '%s' "$json" | head -c 500 >&2
    echo >&2
    return 1
  fi
  jq -c '.[0].results' <<<"$json"
}

# **題名も理由も引かない**（冒頭の但し書き）。
ROWS="$(send_query "select g.id as game_id, g.status,
                           count(distinct r.reporter_id) as reporters,
                           min(r.created_at) as first_report,
                           max(r.created_at) as last_report
                      from games g join reports r on r.game_id = g.id
                     where g.review_state = '${QUEUED}'
                     group by g.id, g.status
                     order by last_report desc")" || exit 2

if [[ -z "$ROWS" || "$ROWS" == "null" ]]; then
  echo "[queue] 行を取り出せませんでした。判定しません。" >&2
  exit 2
fi

COUNT="$(jq 'length' <<<"$ROWS")"

if [[ "$FORMAT" == "json" ]]; then
  jq --arg state "$QUEUED" '{ reviewState: $state, count: length, rows: . }' <<<"$ROWS"
else
  echo "[queue] 対象: ${SCOPE}${PERSIST_TO:+（--persist-to ${PERSIST_TO}）}"
  echo "[queue] 審査待ちの綴り: ${QUEUED}（src/reports.ts の REVIEW_QUEUED）"
  if [[ "$COUNT" -gt 0 ]]; then
    printf '%-38s %-10s %10s %12s\n' "game_id" "status" "通報者" "最終通報"
    jq -r '.[] | [ .game_id, .status, .reporters, .last_report ] | @tsv' <<<"$ROWS" \
      | while IFS=$'\t' read -r id status reporters last; do
          printf '%-38s %-10s %10s %12s\n' "$id" "$status" "$reporters" "$last"
        done
    echo
    echo "[queue] 中身は作品ページで見てください（題名も理由もここには出しません）。"
    echo "[queue] 見た結果どうするかは、このスクリプトの仕事ではありません。"
  fi
fi

if [[ "$COUNT" -gt 0 ]]; then
  [[ "$FORMAT" == "table" ]] && echo "REPORT_QUEUE_FOUND"
  exit 1
fi
[[ "$FORMAT" == "table" ]] && echo "REPORT_QUEUE_EMPTY"
exit 0
