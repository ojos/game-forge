#!/usr/bin/env bash
# kpi-report.sh — 10 章の KPI を台帳から読み出す（#42 / M7-1）
#
# ## なぜ要るのか
#
# **10.3 の撤退条件は、この集計が動かないと判定できない。** 判定日を決めても
# （#44）、フォーク率と 3 世代以上の系統の本数を取り出す手が無ければ、判定の日に
# 「数えられません」と言うことになる。
#
# 使い方:
#   bash scripts/kpi-report.sh                       # 手元の D1（既定）
#   bash scripts/kpi-report.sh --remote              # 本番（読み取りのみ）
#   bash scripts/kpi-report.sh --format json
#   bash scripts/kpi-report.sh --persist-to <dir>    # 使い捨ての手元 D1（自己検査用）
#   bash scripts/kpi-report.sh --since <時刻>         # 開始の時刻より後に作られた作品で数える
#
# --since の時刻は `YYYY-MM-DDTHH:MM:SS+09:00` の形（`Z` / 任意の `±HH:MM` も可）。
# **日付だけ・時差の無い時刻は受け付けない**（秒の単位で切る。日に丸めない）。
# 撤退判定で渡す値の正本は docs/retreat-review.md 1 章の表である（ここへ書き写さない）。
#
# 終了コード:
#   0 = KPI_REPORT_PASS（出力した）
#   2 = 前提の不成立（未認証・道具が無い・応答の形が違う・引数が不正）
#
# **1 を使わない。** このスクリプトは「良い / 悪い」を判定しない。判定するのは #44 の
# 手順であり、ここは数を出すだけである。`ogp-stale-report.sh` が 1 と 2 を分けたのは
# あちらが「中断が有る」を判定するからで、ここには判定が無い。
#
# ── 定義の正本は仕様書 10.1 / 10.2 である ───────────────────────────────────
#
# **フォーク率の分母は「新規生成数＋フォーク生成数」であって「全生成数」ではない**
# （10.1 の v1.35 注記）。推敲（5.7）を分母へ入れると、1 本を数回推敲して仕上げる
# 運用が定着した瞬間に分母が数倍になり、**フォークが健全に起きていても 10.3 の 40% を
# 割る。** 撤退条件が「作者が丁寧になったから」発火することになる。
#
# **分子・分母はどちらも `games` から数える**（10.1 / 確定27）。`generations` からは
# 数えない——リトライ（5.2-7）で 1 作品に複数行が対応するためである。
#
# ── 生成に失敗した行（`generation_state = 'failed'`）を数えない（#456）─────────
#
# 10.1 は「作品を生まない試行は分子にも分母にも現れない」とする。失敗した下書きは
# `games` に行が残るので、**そのまま数えると作品を生まなかった試行が「新規」や
# 「フォーク」になる。** フォーク率の分子・分母から外し、系統でも 3 世代目以降に
# いることの根拠に使わない。**--since の有無によらず効かせる。**
#
# ── --since は作成日時で切る。系統の根は開始前でもよい（#456）────────────────
#
# 10.3 は「サンプルが無い期間のフォーク率を撤退の根拠に含めない」とする。
#
# - **フォーク率:** 開始より後に作られた作品だけで数える。**開始前の作品へのフォークも、
#   開始より後に作られていれば数える**（サンプルを改造するのがまさに測りたいことである）
# - **3 世代以上の系統:** 開始より後に作られた作品が 3 世代目以降にいる系統を数える。
#   **根は開始前でもよい。** 根で切ると、サンプルから伸びた系統が 1 本も数えられない
#
# **境界は「より後」（`created_at > 開始`）で、秒の単位である。** 日の境界
# （scripts/report-window.sh）には合わせない——開始の時刻は 10 本目の公開時刻であり、
# 同じ日の開始前にはサンプルづくりの行がある。**それを 1 行も入れないため**に丸めない。
#
# **補助指標（招待者あたりの生成数・推敲回数など）は期間で絞らない**（#456 の scope.out）。
#
# ── 系統は `status` ではなく `parent_id` で数える ───────────────────────────
#
# **本番に、真ん中が `removed` の 3 世代系統が実在する**（docs/handoff.md 1 章）。
# M5-4 の tombstone は行を消さず `status` だけを変えるので、`parent_id` のリンクは
# 残っている。**「公開済みだけ」で数えると、この系統が勘定から消える。**
#
# ── 本番へは select しか送らない ────────────────────────────────────────────
#
# `scripts/usage-report.sh` と同じ規律である。組み立てた SQL が select で始まることを
# 検査してから送る。**この検査は 1 つ 1 つの問い合わせに掛かる**（KPI ごとに別の文を
# 送るため、1 か所で見て済ませない）。
#
# ── UGC を持ち出さない（8.2）────────────────────────────────────────────────
#
# 取り出すのは**数だけ**である。id も題名もプロンプトもメールアドレスも載らない
# （`scripts/ogp-stale-report.sh` が題名を落としたのと同じ判断）。
#
# **GNU 拡張を使わない**（利用者の端末は macOS / bash 3.2。docs/handoff.md 3 章）。
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)" || exit 2
ROOT="$(dirname "$HERE")"
cd "$ROOT" || exit 2

SCOPE="--local"
PERSIST_TO=""
FORMAT="table"
SINCE=""
SINCE_GIVEN=0

##
# 値を取る引数に、値が付いていることを確かめる。**無ければ落とす。**
#
# `shift 2` は残りが 1 個のとき**シフトせずに失敗する**。`set -e` を使っていないので
# そのまま次の周回へ進み、`while [[ $# -gt 0 ]]` が同じ引数を読み続けて**無限ループ**に
# なる。`bash scripts/kpi-report.sh --format` で再現する（打ち切らないと止まらない）。
#
# **黙って既定値へ倒さない。** `--format` と書いた人は既定でないものを求めており、
# 既定へ倒すと「指定したのに効かなかった」になる。
#
# @param $1 引数の綴り
# @param $2 残りの個数
##
require_value() {
  if [[ "$2" -lt 2 ]]; then
    echo "[kpi] $1 には値が要ります。" >&2
    exit 2
  fi
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --remote)     SCOPE="--remote"; shift ;;
    --local)      SCOPE="--local"; shift ;;
    --persist-to) require_value "$1" "$#"; PERSIST_TO="$2"; shift 2 ;;
    --format)     require_value "$1" "$#"; FORMAT="$2"; shift 2 ;;
    --since)      require_value "$1" "$#"; SINCE="$2"; SINCE_GIVEN=1; shift 2 ;;
    -h|--help)    sed -n '2,31p' "${BASH_SOURCE[0]}" >&2; exit 0 ;;
    *) echo "[kpi] 不明な引数です: $1" >&2; exit 2 ;;
  esac
done

if [[ "$FORMAT" != "table" && "$FORMAT" != "json" ]]; then
  echo "[kpi] --format は table か json です: ${FORMAT}" >&2
  exit 2
fi
if [[ -n "$PERSIST_TO" && "$SCOPE" == "--remote" ]]; then
  echo "[kpi] --persist-to は手元の D1 専用です（--remote とは併用できません）。" >&2
  exit 2
fi
if ! command -v jq >/dev/null 2>&1; then
  echo "[kpi] jq がありません（応答の形を確かめるのに要ります）。" >&2
  exit 2
fi

##
# 時差つきの時刻（`YYYY-MM-DDTHH:MM:SS` ＋ `Z` か `±HH:MM`）を UNIX 秒へ写す。
#
# **`date` を使わない。** GNU の `date -d` と BSD の `date -j -f` は綴りが違い、利用者の
# 端末は macOS である（冒頭）。暦日から通日を出す計算（proleptic Gregorian）を算術で行う。
#
# **形が合っても、存在しない日時は落とす**（2 月 30 日・25 時など）。黙って翌月へ繰り越すと、
# 打ち間違えた境界で数えたことに気づけない。
#
# **日付だけ・時差の無い時刻は受け付けない。** 前者は日に丸めることになり、後者は
# UTC か JST かが読み手によって変わる。
#
# @param $1 時刻の文字列
# @return 標準出力へ UNIX 秒。形が違えば 1
##
since_to_epoch() {
  local re='^([0-9]{4})-([0-9]{2})-([0-9]{2})T([0-9]{2}):([0-9]{2}):([0-9]{2})(Z|([+-])([0-9]{2}):([0-9]{2}))$'
  if [[ ! "$1" =~ $re ]]; then
    return 1
  fi
  local y=$((10#${BASH_REMATCH[1]})) m=$((10#${BASH_REMATCH[2]})) d=$((10#${BASH_REMATCH[3]}))
  local hh=$((10#${BASH_REMATCH[4]})) mi=$((10#${BASH_REMATCH[5]})) ss=$((10#${BASH_REMATCH[6]}))
  local offset=0
  if [[ "${BASH_REMATCH[7]}" != "Z" ]]; then
    local oh=$((10#${BASH_REMATCH[9]})) om=$((10#${BASH_REMATCH[10]}))
    if (( oh > 23 || om > 59 )); then
      return 1
    fi
    offset=$(( oh * 3600 + om * 60 ))
    if [[ "${BASH_REMATCH[8]}" == "-" ]]; then
      offset=$(( -offset ))
    fi
  fi
  if (( y < 1970 || m < 1 || m > 12 || d < 1 || hh > 23 || mi > 59 || ss > 59 )); then
    return 1
  fi
  local dim=31
  case "$m" in
    4|6|9|11) dim=30 ;;
    2) if (( (y % 4 == 0 && y % 100 != 0) || y % 400 == 0 )); then dim=29; else dim=28; fi ;;
  esac
  if (( d > dim )); then
    return 1
  fi
  # 通日（1970-01-01 からの日数）。1 月・2 月を前年の 13・14 月として数える定石。
  local yy=$y mm=$m
  if (( mm <= 2 )); then
    yy=$(( yy - 1 )); mm=$(( mm + 12 ))
  fi
  local days=$(( 365 * yy + yy / 4 - yy / 100 + yy / 400 + (153 * (mm - 3) + 2) / 5 + d - 719469 ))
  echo $(( days * 86400 + hh * 3600 + mi * 60 + ss - offset ))
}

# **--since に空の値が来たら落とす。黙って全期間へ倒さない。** 撤退判定の手順は表から
# 読んだ値を渡すので、表の行を見つけ損ねると空になる。そこで全期間を数えると、
# 開始前の作品が入った数で判定することになり、しかも出力だけでは気づけない。
SINCE_EPOCH=""
if [[ "$SINCE_GIVEN" -eq 1 ]]; then
  if ! SINCE_EPOCH="$(since_to_epoch "$SINCE")"; then
    echo "[kpi] --since は時差つきの時刻です（例: 2030-01-02T03:04:05+09:00）: ${SINCE}" >&2
    echo "[kpi]   日付だけ・時差の無い時刻・存在しない日時は受け付けません（日に丸めません）。" >&2
    exit 2
  fi
fi

##
# 読み取りだけを送る。**select で始まらない文は送らない。**
#
# @param $1 SQL
##
send_query() {
  local sql="$1"
  if [[ ! "$sql" =~ ^[[:space:]]*(select|with)[[:space:]] ]]; then
    echo "[kpi] select / with で始まらない文は送りません（読み取りのみ）。" >&2
    return 1
  fi
  # `with` を許すのは系統の深さが再帰 CTE を要るためである。**書き込みを伴う CTE
  # （insert / update / delete）を弾く**ので、許容を広げても読み取りのままである。
  if printf '%s' "$sql" | tr 'A-Z' 'a-z' | grep -Eq '(^|[^a-z_])(insert|update|delete|drop|create|alter|replace)([^a-z_]|$)'; then
    echo "[kpi] 書き込みを伴う語が含まれています（読み取りのみ）。" >&2
    return 1
  fi

  local args=(d1 execute DB --command "$sql" --json)
  if [[ "$SCOPE" == "--remote" ]]; then
    # 本番の D1 は [env.production] 側にしか宣言が無い（scripts/usage-report.sh と同じ）。
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
    echo "[kpi] D1 を読めません（${SCOPE}）:" >&2
    printf '%s\n' "$out" >&2
    # **黙って 0 を返さない。** 表が無いだけのときに 0 を返すと「まだ 1 本も無い」と
    # 読める。いちばん気づけない壊れ方なので、原因の候補をここで出す。
    if printf '%s' "$out" | grep -q 'no such table'; then
      echo "[kpi] 表がありません。マイグレーションが未適用の可能性があります:" >&2
      echo "[kpi]   npm run db:migrate    # 手元の D1 へ適用する" >&2
    fi
    return 1
  fi

  local json
  json="$(printf '%s' "$out" | sed -n '/^\[/,$p')"
  if [[ -z "$json" ]]; then
    echo "[kpi] wrangler の応答に JSON が含まれていません（${SCOPE}）:" >&2
    printf '%s\n' "$out" >&2
    return 1
  fi
  # **形を先に検査する。** jq の `?` に頼ると、wrangler の --json の形が変わった日に
  # 集計が静かに 0 行になる。0 は「まだ 1 本も無い」と読めてしまい、いちばん気づけない
  # 壊れ方になる（scripts/usage-report.sh と同じ理由）。
  if ! jq -e '(type == "array") and (.[0] | type == "object") and (.[0].results | type == "array")' \
       <<<"$json" >/dev/null 2>&1; then
    echo "[kpi] D1 の応答の形が想定と違います（wrangler --json の形が変わった可能性があります）。" >&2
    printf '%s' "$json" | head -c 500 >&2
    echo >&2
    return 1
  fi
  jq -c '.[0].results[0] // {}' <<<"$json"
}

# ── 問い合わせ ──────────────────────────────────────────────────────────────

# フォーク率と系統で「数える作品」の条件。**failed は --since の有無によらず外す**（冒頭）。
# 開始の時刻は数字だけになっている（since_to_epoch を通った値）ので、SQL へ直接置いてよい。
COUNTED_GAME="generation_state <> 'failed'"
if [[ -n "$SINCE_EPOCH" ]]; then
  COUNTED_GAME="${COUNTED_GAME} and created_at > ${SINCE_EPOCH}"
fi

# 10.1 主 KPI。**分母は数える作品の全行**である（新規＋フォーク）。
SQL_FORK="select
  count(*) as total_games,
  sum(case when parent_id is not null then 1 else 0 end) as fork_games,
  sum(case when parent_id is null then 1 else 0 end) as new_games
from games
where ${COUNTED_GAME}"

# 10.2 3 世代以上の系統の本数。**status を見ない**（冒頭の但し書き）。
#
# **辿るのは全行、数えるのは条件を満たす作品だけ**である。系統は parent_id で辿るので、
# 開始前の根や、途中の removed / 開始前の世代を経由してよい。**そのうえで、条件を満たす
# 作品（失敗していない・開始より後）が 3 世代目以降にいる系統だけを数える。**
# 根の数と最大の世代も、条件を満たす作品について出す（根は、その系統の根）。
SQL_LINEAGE="with recursive lineage(id, root, depth) as (
    select id, id, 1 from games where parent_id is null
  union all
    select g.id, lineage.root, lineage.depth + 1
      from games g join lineage on g.parent_id = lineage.id
),
counted as (
  select lineage.root, lineage.depth
    from lineage join games on games.id = lineage.id
   where ${COUNTED_GAME}
)
select
  (select count(*) from (select root from counted group by root having max(depth) >= 3)) as deep_lineages,
  (select count(distinct root) from counted) as roots,
  (select max(depth) from counted) as max_depth"

# 10.2 招待者あたりの生成数。
SQL_PER_USER="select
  (select count(*) from games) as games,
  (select count(*) from users) as users"

# 10.2 「改造する」からの待機リスト登録。**分母（押した人数）は台帳に無い**（下記）。
SQL_FORK_CTA="select
  sum(case when source = 'fork-cta' then 1 else 0 end) as from_fork_cta,
  count(*) as waitlist_total
from waitlist"

# 10.2 1 生成あたりの実コスト。**generations は 1 行 = 1 呼び出し**で、リトライも
# 含む（4.3）。作品単位ではない。
SQL_COST="select
  count(*) as calls,
  sum(cost_jpy) as total_jpy
from generations"

# 10.2 1 作品あたりの推敲回数。**seq = 1 は初回生成なので数えない**
# （migrations/0009_game_revisions.sql）。
SQL_REVISE="select
  (select count(*) from game_revisions where seq >= 2) as revisions,
  (select count(distinct game_id) from game_revisions where seq >= 2) as works_revised,
  (select count(*) from games) as games"

FORK="$(send_query "$SQL_FORK")"       || exit 2
LINEAGE="$(send_query "$SQL_LINEAGE")" || exit 2
PER_USER="$(send_query "$SQL_PER_USER")" || exit 2
FORK_CTA="$(send_query "$SQL_FORK_CTA")" || exit 2
COST="$(send_query "$SQL_COST")"       || exit 2
REVISE="$(send_query "$SQL_REVISE")"   || exit 2

REPORT="$(jq -n \
  --argjson fork "$FORK" --argjson lineage "$LINEAGE" --argjson perUser "$PER_USER" \
  --argjson forkCta "$FORK_CTA" --argjson cost "$COST" --argjson revise "$REVISE" \
  --arg since "$SINCE" --arg sinceEpoch "$SINCE_EPOCH" '
  def num(v): (v // 0);
  def ratio(a; b): if num(b) == 0 then null else (num(a) / num(b)) end;
  {
    since: (if $since == "" then null else {
      at: $since,
      epoch: ($sinceEpoch | tonumber),
      appliesTo: ["forkRate", "deepLineages"]
    } end),
    forkRate: {
      totalGames: num($fork.total_games),
      forkGames: num($fork.fork_games),
      newGames: num($fork.new_games),
      rate: ratio($fork.fork_games; $fork.total_games)
    },
    deepLineages: {
      count: num($lineage.deep_lineages),
      roots: num($lineage.roots),
      maxDepth: num($lineage.max_depth)
    },
    generationsPerUser: {
      games: num($perUser.games),
      users: num($perUser.users),
      perUser: ratio($perUser.games; $perUser.users)
    },
    forkCtaWaitlist: {
      registrations: num($forkCta.from_fork_cta),
      waitlistTotal: num($forkCta.waitlist_total),
      conversionRate: null,
      unmeasurable: "押した人数が台帳に無い（3.6 がリクエスト毎の D1 書き込みを禁じている）。分子だけが出る。"
    },
    costPerGeneration: {
      calls: num($cost.calls),
      totalJpy: num($cost.total_jpy),
      perCall: ratio($cost.total_jpy; $cost.calls)
    },
    firstCompileSuccess: {
      rate: null,
      unmeasurable: "確定27 が generations.game_id を結ばないと決めており（常に NULL が正常）、リトライ行を作品へ寄せられない。generations.succeeded は end_turn か否かであってコンパイルの成否ではない（src/cost-ledger.ts の isUsableGeneration）。build_health は失敗時のみ書かれ成功で消えるので履歴が残らない。"
    },
    revisionsPerWork: {
      revisions: num($revise.revisions),
      worksRevised: num($revise.works_revised),
      games: num($revise.games),
      perWork: ratio($revise.revisions; $revise.games)
    }
  }')" || exit 2

if [[ "$FORMAT" == "json" ]]; then
  printf '%s\n' "$REPORT"
  exit 0
fi

echo "[kpi] 対象: ${SCOPE}${PERSIST_TO:+（--persist-to ${PERSIST_TO}）}"
echo "[kpi] 定義の正本は仕様書 10.1 / 10.2 です。ここへ書き写していません。"
if [[ -n "$SINCE" ]]; then
  echo "[kpi] 期間: 作成が ${SINCE}（UNIX ${SINCE_EPOCH}）より後の作品（フォーク率と 3 世代以上の系統だけに効きます）"
else
  echo "[kpi] 期間: 指定なし（全期間）"
fi
echo "[kpi] 生成に失敗した作品（generation_state = 'failed'）は、フォーク率と系統に数えていません。"
echo
jq -r '
  def pct(v): if v == null then "—" else ((v * 1000 | floor) / 10 | tostring) + "%" end;
  def n(v): if v == null then "—" else (v | tostring) end;
  def jpy(v): if v == null then "—" else ((v * 100 | floor) / 100 | tostring) + " 円" end;
  def r2(v): if v == null then "—" else ((v * 100 | floor) / 100 | tostring) end;
  "主 KPI  フォーク率            " + pct(.forkRate.rate)
    + "  （フォーク " + n(.forkRate.forkGames) + " / 新規 " + n(.forkRate.newGames)
    + " ＝ 全 " + n(.forkRate.totalGames) + " 作品）",
  "補助    3 世代以上の系統       " + n(.deepLineages.count) + " 本"
    + "  （根 " + n(.deepLineages.roots) + " / 最大 " + n(.deepLineages.maxDepth) + " 世代）",
  "補助    招待者あたりの生成数   " + r2(.generationsPerUser.perUser)
    + "  （作品 " + n(.generationsPerUser.games) + " / 利用者 " + n(.generationsPerUser.users) + "）",
  "補助    改造 CTA → 待機リスト  登録 " + n(.forkCtaWaitlist.registrations) + " 件"
    + "  （待機リスト全体 " + n(.forkCtaWaitlist.waitlistTotal) + " 件。**登録率は出せません**）",
  "補助    1 生成あたりの実コスト " + jpy(.costPerGeneration.perCall)
    + "  （呼び出し " + n(.costPerGeneration.calls) + " 回 / 計 " + jpy(.costPerGeneration.totalJpy) + "）",
  "補助    初回コンパイル成功率   —  **出せません**",
  "補助    1 作品あたりの推敲回数 " + r2(.revisionsPerWork.perWork)
    + "  （推敲 " + n(.revisionsPerWork.revisions) + " 回 / 作品 " + n(.revisionsPerWork.games)
    + "。うち推敲された作品 " + n(.revisionsPerWork.worksRevised) + " 本）"
' <<<"$REPORT"
echo
echo "[kpi] 出せない 2 件の理由:"
jq -r '"  - 改造 CTA の登録率: " + .forkCtaWaitlist.unmeasurable,
       "  - 初回コンパイル成功率: " + .firstCompileSuccess.unmeasurable' <<<"$REPORT"
echo
echo "KPI_REPORT_PASS"
exit 0
