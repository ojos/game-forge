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
#
# 終了コード:
#   0 = KPI_REPORT_PASS（出力した）
#   2 = 前提の不成立（未認証・道具が無い・応答の形が違う）
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

while [[ $# -gt 0 ]]; do
  case "$1" in
    --remote)     SCOPE="--remote"; shift ;;
    --local)      SCOPE="--local"; shift ;;
    --persist-to) PERSIST_TO="${2:-}"; shift 2 ;;
    --format)     FORMAT="${2:-}"; shift 2 ;;
    -h|--help)    sed -n '2,25p' "${BASH_SOURCE[0]}" >&2; exit 0 ;;
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

# 10.1 主 KPI。**分母は games の全行**である（新規＋フォーク）。
SQL_FORK="select
  count(*) as total_games,
  sum(case when parent_id is not null then 1 else 0 end) as fork_games,
  sum(case when parent_id is null then 1 else 0 end) as new_games
from games"

# 10.2 3 世代以上の系統の本数。**status を見ない**（冒頭の但し書き）。
SQL_LINEAGE="with recursive lineage(id, root, depth) as (
    select id, id, 1 from games where parent_id is null
  union all
    select g.id, lineage.root, lineage.depth + 1
      from games g join lineage on g.parent_id = lineage.id
)
select
  (select count(*) from (select root from lineage group by root having max(depth) >= 3)) as deep_lineages,
  (select count(distinct root) from lineage) as roots,
  (select max(depth) from lineage) as max_depth"

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
  --argjson forkCta "$FORK_CTA" --argjson cost "$COST" --argjson revise "$REVISE" '
  def num(v): (v // 0);
  def ratio(a; b): if num(b) == 0 then null else (num(a) / num(b)) end;
  {
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
