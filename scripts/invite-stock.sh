#!/usr/bin/env bash
# invite-stock.sh — 参加者の人数と、未使用の招待コードの本数を、D1 から読む（8.1 / #397）
#
# 使い方:
#   bash scripts/invite-stock.sh --remote            # 本番（読み取りのみ）
#   bash scripts/invite-stock.sh                     # 手元の D1（既定）
#   bash scripts/invite-stock.sh --remote --format json
#
# 終了コード:
#   0 = INVITE_STOCK_UNDER_CAP（参加者が上限未満。招待を発行できる）
#   1 = INVITE_STOCK_CAP_REACHED（参加者が上限に達している。誰も発行できない）
#   2 = 前提の不成立（未認証・道具が無い・応答の形が違う）
#
# ── なぜ要るのか ──────────────────────────────────────────────────────────
#
# **人数の上限は「発行を止める」だけの緩い締め切りである**（8.1）。上限に達する前に発行された
# 未使用のコードは、そのあとでも使える。**参加者は、そのときの未使用のコードの本数だけ上限を
# 超えうる**——費用の見積もりはその幅を含める（50 人 ＋ 未使用のコード）。その本数を運営が
# 数える手段がここである（#397 の scope.in）。
#
# **見直しの契機も同じ出力で読める**（8.1。参加者が 40 人に達した時点で上限と速さを再検討する）。
#
# ── 数え方を書き写さない ──────────────────────────────────────────────────
#
# **参加者の条件と上限の値は `src/participant-cap.ts` から取り出す**（`PARTICIPANT_WHERE_SQL` /
# `PARTICIPANT_CAP`）。書き写すと、片方だけが古くなったときに**画面と端末で人数が食い違う**
# （`scripts/report-queue.sh` が `REVIEW_QUEUED` を取り出すのと同じ規律）。
#
# **未使用のコード**は「使われておらず、期限も切れていない」行である。期限の境界は
# `src/invites.ts` の `consumeInvite` の条件（`expires_at is null or expires_at > now`）と揃える
# ——**使えるコードだけを数える。**
#
# ── 変えるのはこのスクリプトの仕事ではない ──────────────────────────────────
#
# **本番へは select しか送らない。** コードを取り消す口や上限を変える口をここへ付けない
# （未使用の招待の取り消しは 8.1 にも #397 にも無い）。
#
# **コードそのものは出さない。** 数えるのに要らず、端末のログに残すと使える招待が漏れる。
#
# **GNU 拡張を使わない**（利用者の端末は macOS / bash 3.2。docs/handoff.md 3 章）。
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)" || exit 2
ROOT="$(dirname "$HERE")"
cd "$ROOT" || exit 2

CAP_TS="src/participant-cap.ts"
SCOPE="--local"
PERSIST_TO=""
FORMAT="table"

##
# 値を取る引数に、値が付いていることを確かめる。
#
# @param $1 引数の綴り
# @param $2 残りの個数
##
require_value() {
  if [[ "$2" -lt 2 ]]; then
    echo "[invite-stock] $1 には値が要ります。" >&2
    exit 2
  fi
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --remote)     SCOPE="--remote"; shift ;;
    --local)      SCOPE="--local"; shift ;;
    --persist-to) require_value "$1" "$#"; PERSIST_TO="$2"; shift 2 ;;
    --format)     require_value "$1" "$#"; FORMAT="$2"; shift 2 ;;
    -h|--help)    sed -n '2,12p' "${BASH_SOURCE[0]}" >&2; exit 0 ;;
    *) echo "[invite-stock] 不明な引数です: $1" >&2; exit 2 ;;
  esac
done

if [[ "$FORMAT" != "table" && "$FORMAT" != "json" ]]; then
  echo "[invite-stock] --format は table か json です: ${FORMAT}" >&2
  exit 2
fi
if [[ -n "$PERSIST_TO" && "$SCOPE" == "--remote" ]]; then
  echo "[invite-stock] --persist-to は手元の D1 専用です（--remote とは併用できません）。" >&2
  exit 2
fi
if ! command -v jq >/dev/null 2>&1; then
  echo "[invite-stock] jq がありません（応答の形を確かめるのに要ります）。" >&2
  exit 2
fi
if [[ ! -f "$CAP_TS" ]]; then
  echo "[invite-stock] 定義の正本がありません: ${CAP_TS}" >&2
  exit 2
fi

# **書式のゆれに耐える形で取り出す**（空白の数が変わっただけで取り出せなくなると、
# 上限の判定が黙って外れる）。取り出せなければ判定しない。
CAP="$(sed -n "s/^export const PARTICIPANT_CAP[[:space:]]*=[[:space:]]*\([0-9][0-9]*\);.*/\1/p" "$CAP_TS" | head -1)"
if [[ -z "$CAP" ]]; then
  echo "[invite-stock] ${CAP_TS} から PARTICIPANT_CAP を取り出せません。綴りが変わったなら、このスクリプトの sed も直してください。" >&2
  exit 2
fi
WHERE="$(sed -n "s/^export const PARTICIPANT_WHERE_SQL[[:space:]]*=[[:space:]]*'\([^']*\)'.*/\1/p" "$CAP_TS" | head -1)"
if [[ -z "$WHERE" ]]; then
  echo "[invite-stock] ${CAP_TS} から PARTICIPANT_WHERE_SQL を取り出せません。綴りが変わったなら、このスクリプトの sed も直してください。" >&2
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
    echo "[invite-stock] select で始まらない文は送りません（読み取りのみ）。" >&2
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
    echo "[invite-stock] D1 を読めません（${SCOPE}）:" >&2
    printf '%s\n' "$out" >&2
    if printf '%s' "$out" | grep -q 'no such'; then
      echo "[invite-stock] 表や列がありません。マイグレーションが未適用の可能性があります:" >&2
      echo "[invite-stock]   npm run db:migrate" >&2
    fi
    return 1
  fi

  local json
  json="$(printf '%s' "$out" | sed -n '/^\[/,$p')"
  if [[ -z "$json" ]]; then
    echo "[invite-stock] wrangler の応答に JSON が含まれていません:" >&2
    printf '%s\n' "$out" >&2
    return 1
  fi
  # **形を先に検査する。** 静かに 0 にすると「参加者が居ない」「未使用が無い」と読める。
  if ! jq -e '(type == "array") and (.[0].results | type == "array") and (.[0].results | length == 1)' \
       <<<"$json" >/dev/null 2>&1; then
    echo "[invite-stock] D1 の応答の形が想定と違います:" >&2
    printf '%s' "$json" | head -c 500 >&2
    echo >&2
    return 1
  fi
  jq -c '.[0].results[0]' <<<"$json"
}

NOW="$(date +%s)"
ROW="$(send_query "select
    (select count(*) from users where ${WHERE}) as participants,
    (select count(*) from users where not (${WHERE})) as banned,
    (select count(*) from invites
      where used_by is null and (expires_at is null or expires_at > ${NOW})) as unused")" || exit 2

PARTICIPANTS="$(jq -r '.participants' <<<"$ROW")"
BANNED="$(jq -r '.banned' <<<"$ROW")"
UNUSED="$(jq -r '.unused' <<<"$ROW")"
for value in "$PARTICIPANTS" "$BANNED" "$UNUSED"; do
  if [[ ! "$value" =~ ^[0-9]+$ ]]; then
    echo "[invite-stock] 数として読めない値が返りました: ${ROW}" >&2
    exit 2
  fi
done

REACHED=false
if [[ "$PARTICIPANTS" -ge "$CAP" ]]; then
  REACHED=true
fi

if [[ "$FORMAT" == "json" ]]; then
  jq -n --argjson cap "$CAP" --argjson participants "$PARTICIPANTS" --argjson banned "$BANNED" \
    --argjson unused "$UNUSED" --argjson reached "$REACHED" \
    '{ cap: $cap, participants: $participants, banned: $banned, unused: $unused,
       capReached: $reached, worstCase: ($participants + $unused) }'
else
  echo "[invite-stock] 対象: ${SCOPE}${PERSIST_TO:+（--persist-to ${PERSIST_TO}）}"
  echo "[invite-stock] 参加者: ${PARTICIPANTS} 人 / 上限 ${CAP} 人（BAN 済み ${BANNED} 人は数えない。src/participant-cap.ts）"
  echo "[invite-stock] 未使用で期限内の招待コード: ${UNUSED} 本"
  echo "[invite-stock] すべて使われたときの参加者: $((PARTICIPANTS + UNUSED)) 人（上限は発行を止めるだけで、使用は止めない。8.1）"
fi

if [[ "$REACHED" == true ]]; then
  [[ "$FORMAT" == "table" ]] && echo "INVITE_STOCK_CAP_REACHED"
  exit 1
fi
[[ "$FORMAT" == "table" ]] && echo "INVITE_STOCK_UNDER_CAP"
exit 0
