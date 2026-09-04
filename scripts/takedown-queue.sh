#!/usr/bin/env bash
# takedown-queue.sh — 未対応の削除申請を、本番の台帳から読む（8.4 / #41）
#
# **手順の正本は docs/takedown.md である。** ここは読み出しだけを持つ。
#
# 使い方:
#   bash scripts/takedown-queue.sh --remote            # 本番（読み取りのみ）
#   bash scripts/takedown-queue.sh                     # 手元の D1（既定）
#   bash scripts/takedown-queue.sh --remote --format json
#
# 終了コード:
#   0 = TAKEDOWN_QUEUE_EMPTY（未対応なし）
#   1 = TAKEDOWN_QUEUE_FOUND（有る）
#   2 = 前提の不成立（未認証・道具が無い・応答の形が違う）
#
# ── 申請の中身はここに出す ──────────────────────────────────────────────────
#
# **`scripts/report-queue.sh` とは判断が違う。** あちらは利用者からの通報で、題名も
# 理由も UGC なので出さない。**こちらは権利者からの申請で、中身を読まなければ判断
# できない**——誰が、どの権利に基づき、何を求めているかが分からなければ、
# `removed` / `restricted` / `rejected` のどれも選べない。
#
# **したがって連絡先と本文を出す。** 出す先は運用者の端末だけである（本番へは
# select しか送らない）。
#
# ── 進めるのはこのスクリプトの仕事ではない ──────────────────────────────────
#
# 措置の記録は `recordTakedownAction`（`src/takedown.ts`）が行う。ここに `--handle` の
# ような口を付けない。**読むことと変えることを、別の操作に分ける。**
#
# **GNU 拡張を使わない**（利用者の端末は macOS / bash 3.2。docs/handoff.md 3 章）。
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)" || exit 2
ROOT="$(dirname "$HERE")"
cd "$ROOT" || exit 2

SCOPE="--local"
PERSIST_TO=""
FORMAT="table"

##
# 値を取る引数に、値が付いていることを確かめる（#276 で 3 本に同じ形があった）。
#
# @param $1 引数の綴り
# @param $2 残りの個数
##
require_value() {
  if [[ "$2" -lt 2 ]]; then
    echo "[takedown] $1 には値が要ります。" >&2
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
    *) echo "[takedown] 不明な引数です: $1" >&2; exit 2 ;;
  esac
done

if [[ "$FORMAT" != "table" && "$FORMAT" != "json" ]]; then
  echo "[takedown] --format は table か json です: ${FORMAT}" >&2
  exit 2
fi
if [[ -n "$PERSIST_TO" && "$SCOPE" == "--remote" ]]; then
  echo "[takedown] --persist-to は手元の D1 専用です（--remote とは併用できません）。" >&2
  exit 2
fi
if ! command -v jq >/dev/null 2>&1; then
  echo "[takedown] jq がありません（応答の形を確かめるのに要ります）。" >&2
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
    echo "[takedown] select で始まらない文は送りません（読み取りのみ）。" >&2
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
    echo "[takedown] D1 を読めません（${SCOPE}）:" >&2
    printf '%s\n' "$out" >&2
    if printf '%s' "$out" | grep -q 'no such'; then
      echo "[takedown] 表がありません。マイグレーションが未適用の可能性があります:" >&2
      echo "[takedown]   npm run db:migrate" >&2
    fi
    return 1
  fi

  local json
  json="$(printf '%s' "$out" | sed -n '/^\[/,$p')"
  if [[ -z "$json" ]]; then
    echo "[takedown] wrangler の応答に JSON が含まれていません:" >&2
    printf '%s\n' "$out" >&2
    return 1
  fi
  # **形を先に検査する。** 静かに 0 行にすると「未対応なし」と読める。
  if ! jq -e '(type == "array") and (.[0] | type == "object") and (.[0].results | type == "array")' \
       <<<"$json" >/dev/null 2>&1; then
    echo "[takedown] D1 の応答の形が想定と違います:" >&2
    printf '%s' "$json" | head -c 500 >&2
    echo >&2
    return 1
  fi
  jq -c '.[0].results' <<<"$json"
}

ROWS="$(send_query "select id, game_id, claimant_name, claimant_contact, body, received_at
                      from takedown_requests
                     where handled_at is null
                     order by received_at asc")" || exit 2

if [[ -z "$ROWS" || "$ROWS" == "null" ]]; then
  echo "[takedown] 行を取り出せませんでした。判定しません。" >&2
  exit 2
fi

COUNT="$(jq 'length' <<<"$ROWS")"

if [[ "$FORMAT" == "json" ]]; then
  jq '{ count: length, rows: . }' <<<"$ROWS"
else
  echo "[takedown] 対象: ${SCOPE}${PERSIST_TO:+（--persist-to ${PERSIST_TO}）}"
  echo "[takedown] 未対応: ${COUNT} 件"
  if [[ "$COUNT" -gt 0 ]]; then
    echo
    jq -r '.[] | "── 受付 " + .id + " ──\n  作品: " + .game_id
                 + "\n  申請者: " + .claimant_name + " <" + .claimant_contact + ">"
                 + "\n  受付時刻: " + (.received_at | tostring)
                 + "\n  内容:\n" + (.body | split("\n") | map("    " + .) | join("\n")) + "\n"' \
      <<<"$ROWS"
    echo "[takedown] 判断と記録の手順: docs/takedown.md"
  fi
fi

if [[ "$COUNT" -gt 0 ]]; then
  [[ "$FORMAT" == "table" ]] && echo "TAKEDOWN_QUEUE_FOUND"
  exit 1
fi
[[ "$FORMAT" == "table" ]] && echo "TAKEDOWN_QUEUE_EMPTY"
exit 0
