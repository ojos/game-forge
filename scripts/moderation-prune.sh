#!/usr/bin/env bash
# moderation-prune.sh — 遮断の記録を 90 日で消す（8.2 / #37）
#
# ## なぜ要るのか
#
# **有害な入力そのものを永続化すると決めた**（intake / 2026-09-03）。誤検出かどうかは
# 本文を見ないと判定できず、本文が無ければ閾値を下げる判断が利用者の苦情待ちになる。
# **決めた以上、保持期間も決める**——決めないと「無期限に持つ」が既定になる。
#
# 使い方:
#   bash scripts/moderation-prune.sh                    # 手元の D1 を数える（既定）
#   bash scripts/moderation-prune.sh --remote           # 本番を数える（読み取りのみ）
#   bash scripts/moderation-prune.sh --remote --delete  # 本番から消す
#
# 終了コード:
#   0 = MODERATION_PRUNE_PASS（数えた、または消した）
#   2 = 前提の不成立（未認証・道具が無い・応答の形が違う）
#
# ── 既定は「数えるだけ」である ──────────────────────────────────────────────
#
# **`--delete` を付けない限り 1 行も消さない。** `scripts/ogp-stale-report.sh` が
# 「進めるのはこのスクリプトの仕事ではない」と書いたのと同じ規律で、**読むことと
# 消すことを別の操作にする。** 消すのは戻せない。
#
# ── 保持期間の正本はここである ──────────────────────────────────────────────
#
# 90 日という値は intake の決定であり、**仕様書 8.2 は「保持は 90 日」とだけ書いて
# いる**。運用が変えるならここを変える。**2 か所に数字を置かない。**
#
# **GNU 拡張を使わない**（利用者の端末は macOS / bash 3.2。docs/handoff.md 3 章）。
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)" || exit 2
ROOT="$(dirname "$HERE")"
cd "$ROOT" || exit 2

# 保持期間（日）。**この値が正本である。**
RETENTION_DAYS=90

SCOPE="--local"
PERSIST_TO=""
DELETE=0
NOW="${MODERATION_PRUNE_NOW:-$(date -u +%s)}"

##
# 値を取る引数に、値が付いていることを確かめる。**無ければ落とす。**
#
# `shift 2` は残りが 1 個のときシフトせずに失敗し、`set -e` を使っていないので
# **無限ループ**になる（#42 の PR で実際に踏んだ）。
#
# @param $1 引数の綴り
# @param $2 残りの個数
##
require_value() {
  if [[ "$2" -lt 2 ]]; then
    echo "[prune] $1 には値が要ります。" >&2
    exit 2
  fi
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --remote)     SCOPE="--remote"; shift ;;
    --local)      SCOPE="--local"; shift ;;
    --delete)     DELETE=1; shift ;;
    --persist-to) require_value "$1" "$#"; PERSIST_TO="$2"; shift 2 ;;
    -h|--help)    sed -n '2,20p' "${BASH_SOURCE[0]}" >&2; exit 0 ;;
    *) echo "[prune] 不明な引数です: $1" >&2; exit 2 ;;
  esac
done

if [[ -n "$PERSIST_TO" && "$SCOPE" == "--remote" ]]; then
  echo "[prune] --persist-to は手元の D1 専用です（--remote とは併用できません）。" >&2
  exit 2
fi
if ! command -v jq >/dev/null 2>&1; then
  echo "[prune] jq がありません（応答の形を確かめるのに要ります）。" >&2
  exit 2
fi

CUTOFF=$((NOW - RETENTION_DAYS * 24 * 60 * 60))

##
# D1 へ 1 文送る。
#
# **`--delete` が無ければ select しか送らない。** 書き込みの文を組み立てるのは
# `$DELETE` が立っているときだけで、立っていなければ組み立てもしない。
#
# @param $1 SQL
##
send() {
  local sql="$1"
  if (( ! DELETE )) && [[ ! "$sql" =~ ^[[:space:]]*select[[:space:]] ]]; then
    echo "[prune] --delete が無いので、select 以外は送りません。" >&2
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
    echo "[prune] D1 を操作できません（${SCOPE}）:" >&2
    printf '%s\n' "$out" >&2
    if printf '%s' "$out" | grep -q 'no such table'; then
      echo "[prune] 表がありません。マイグレーションが未適用の可能性があります:" >&2
      echo "[prune]   npm run db:migrate" >&2
    fi
    return 1
  fi

  local json
  json="$(printf '%s' "$out" | sed -n '/^\[/,$p')"
  if [[ -z "$json" ]]; then
    echo "[prune] wrangler の応答に JSON が含まれていません:" >&2
    printf '%s\n' "$out" >&2
    return 1
  fi
  # **形を先に検査する。** 静かに 0 行にすると「消すものが無かった」と読める。
  if ! jq -e '(type == "array") and (.[0] | type == "object")' <<<"$json" >/dev/null 2>&1; then
    echo "[prune] D1 の応答の形が想定と違います:" >&2
    printf '%s' "$json" | head -c 500 >&2
    echo >&2
    return 1
  fi
  printf '%s' "$json"
}

COUNT_JSON="$(send "select count(*) as expired from moderation_blocks where created_at < ${CUTOFF}")" || exit 2
EXPIRED="$(jq -r '.[0].results[0].expired // 0' <<<"$COUNT_JSON")"

echo "[prune] 対象: ${SCOPE}${PERSIST_TO:+（--persist-to ${PERSIST_TO}）}"
echo "[prune] 保持期間: ${RETENTION_DAYS} 日（このスクリプトが正本）"
echo "[prune] 期限切れ: ${EXPIRED} 行"

if (( ! DELETE )); then
  if [[ "$EXPIRED" != "0" ]]; then
    echo "[prune] 消すには --delete を付けてください（既定では 1 行も消しません）。"
  fi
  echo "MODERATION_PRUNE_PASS"
  exit 0
fi

send "delete from moderation_blocks where created_at < ${CUTOFF}" >/dev/null || exit 2

# **報告された数を信じない。数え直す。**
#
# `meta.changes` は手元の D1（miniflare）では返ってこない（`meta` は `duration` だけ。
# 実測 2026-09-03）。**返ってこない値を 0 と読むと「消した行: 0」と報告しながら実際には
# 消えている**——引き継ぎ 4 章の「確認に使う grep そのものを疑うこと」と同じ形である。
# **結果を確かめるほうが、報告を読むより強い。**
AFTER_JSON="$(send "select count(*) as expired from moderation_blocks where created_at < ${CUTOFF}")" || exit 2
REMAINING="$(jq -r '.[0].results[0].expired // 0' <<<"$AFTER_JSON")"
echo "[prune] 消したあとの期限切れ: ${REMAINING} 行"

if [[ "$REMAINING" != "0" ]]; then
  echo "[prune] 期限切れが残っています。消せていません。" >&2
  exit 2
fi
echo "MODERATION_PRUNE_PASS"
exit 0
