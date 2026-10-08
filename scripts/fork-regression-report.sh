#!/usr/bin/env bash
# fork-regression-report.sh — フォークが親の土台を継承しているかを数える（#798）
#
# ## なぜ要るのか
#
# **いまのフォークは、土台を継承する保証を持っていない。** 親ソースに付く前置きは
# `src/bedrock.ts` の `BASE_SOURCE_PREFACE` の 1 文だけで、親の勝ち負けの条件や状態の分割を
# 壊すなとは書いていない。出力も差分ではなく毎回ほぼ全文の書き直しである。10.3 の撤退条件が
# 見るのは 3 世代以上の系統なので、2 世代目で土台が崩れるならサンプルを磨いても戻ってこない。
# **止める前に、まず数える。** このスクリプトは止めない・警告しない。
#
# 使い方:
#   bash scripts/fork-regression-report.sh                       # 手元の D1（既定）
#   bash scripts/fork-regression-report.sh --remote              # 本番（読み取りのみ）
#   bash scripts/fork-regression-report.sh --format json
#   bash scripts/fork-regression-report.sh --persist-to <dir>    # 使い捨ての手元 D1（自己検査用）
#   bash scripts/fork-regression-report.sh --since <時刻>         # 子が開始の時刻より後に作られた組で数える
#
# --since の形は scripts/kpi-report.sh と同じ（`YYYY-MM-DDTHH:MM:SS+09:00`。`Z` / 任意の `±HH:MM` も可）。
#
# 終了コード:
#   0 = FORK_REGRESSION_REPORT_PASS（出力した。退行の有無によらない）
#   2 = 前提の不成立（未認証・道具が無い・応答の形が違う・引数が不正）
#
# **1 を使わない。** kpi-report.sh と同じく、数を出すだけで良い / 悪いを判定しない。
#
# ── 退行 0 は「土台が継承されている」ではない ────────────────────────────────
#
# **3 項目はどれも語と宣言の照合である。** アワアワイルカは「ざんねん...」が書かれていても
# 負けの分岐が死んだ枝だった（docs/cold-start-samples.md の #617）。**退行が 0 でも、
# 土台が継承されているとは言えない。** 言えるのは「この 3 項目で見える壊れ方は無かった」だけである。
# **母数も小さい**（親子の組は 10 組に満たない見込み）。出力には組の数を必ず併記する。
#
# ── 何を退行と数えるか ──────────────────────────────────────────────────────
#
# 親子とも `source_quality_metrics`（migrations/0046）の行があり、`rule_version` が揃った組
# （＝測れた組）だけで、次のどれかが起きたら退行である。
#
#   - `has_win_text` が 1 → 0
#   - `has_lose_text` が 1 → 0
#   - `state_count` が減った
#
# **`color_count` / `sprite_count` の増減は退行と見なさない。** 減るのは整理されただけのことがある。
#
# **測れない組は別に数える**（退行なしに混ぜない）。指標の行がどちらかに無い組（`source_key` が
# NULL の組を含む）と、`rule_version` が揃わない組である。混ぜると「測っていない」が
# 「壊れていない」に化ける。
#
# ── どのソースを比べるか ─────────────────────────────────────────────────────
#
# **双方の `games.source_key` である。** 親は公開済みでなければフォークできず（src/fork.ts）、
# 公開済みは推敲できない（src/revisions.ts の `status = 'draft'`）ので、**親の現在のソースは
# フォークの元にしたソースと同じ**である。子は下書きのあいだ推敲されうるので、**子の現在の版**
# （フォーク後の推敲を含む）を比べる。推敲も同じ前置きで全文を書き直すので、土台が残ったかを見る
# 対象としてはこれで足りる。
#
# ── 数えない作品 ────────────────────────────────────────────────────────────
#
# **親か子が `generation_state = 'failed'` の組は数えない**（10.1 / #456 と同じ扱い）。
# 作品を生まなかった試行であって、土台を壊したフォークではない。--since は**子の作成日時**で
# 切る（kpi-report.sh と同じく「より後」・秒の単位）。親は開始前でよい（サンプルを改造するのが
# まさに測りたいことである）。
#
# ── 本番へは select しか送らない・UGC を持ち出さない ─────────────────────────
#
# kpi-report.sh と同じ規律である。組み立てた SQL が select で始まることを確かめてから送る。
# **作品の id も題名も出さない。** 下書きの子は作者にしか見えない作品であり、組ごとの行は
# 指標の数だけで出す（何組目かは子の作成順）。
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
# 値を取る引数に、値が付いていることを確かめる。**無ければ落とす**（kpi-report.sh と同じ理由。
# `shift 2` が失敗したまま同じ引数を読み続ける無限ループを塞ぐ）。
#
# @param $1 引数の綴り
# @param $2 残りの個数
##
require_value() {
  if [[ "$2" -lt 2 ]]; then
    echo "[fork-regression] $1 には値が要ります。" >&2
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
    -h|--help)    sed -n '2,24p' "${BASH_SOURCE[0]}" >&2; exit 0 ;;
    *) echo "[fork-regression] 不明な引数です: $1" >&2; exit 2 ;;
  esac
done

if [[ "$FORMAT" != "table" && "$FORMAT" != "json" ]]; then
  echo "[fork-regression] --format は table か json です: ${FORMAT}" >&2
  exit 2
fi
if [[ -n "$PERSIST_TO" && "$SCOPE" == "--remote" ]]; then
  echo "[fork-regression] --persist-to は手元の D1 専用です（--remote とは併用できません）。" >&2
  exit 2
fi
if ! command -v jq >/dev/null 2>&1; then
  echo "[fork-regression] jq がありません（応答の形を確かめるのに要ります）。" >&2
  exit 2
fi

##
# 時差つきの時刻を UNIX 秒へ写す。**scripts/kpi-report.sh の `since_to_epoch` と同じ規則である。**
#
# kpi-report.sh は #798 の scope.out（変えない）なので、関数を共有の場所へ切り出していない。
# **2 つが同じ値を返すことは scripts/report-selftest.sh が機械で見る**（片方だけ直すと赤くなる）。
# `date` を使わない・存在しない日時を落とす・日付だけや時差の無い時刻を受け付けない、の 3 点も同じ。
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
  local yy=$y mm=$m
  if (( mm <= 2 )); then
    yy=$(( yy - 1 )); mm=$(( mm + 12 ))
  fi
  local days=$(( 365 * yy + yy / 4 - yy / 100 + yy / 400 + (153 * (mm - 3) + 2) / 5 + d - 719469 ))
  echo $(( days * 86400 + hh * 3600 + mi * 60 + ss - offset ))
}

# **空の --since を全期間へ倒さない**（kpi-report.sh と同じ理由）。
SINCE_EPOCH=""
if [[ "$SINCE_GIVEN" -eq 1 ]]; then
  if ! SINCE_EPOCH="$(since_to_epoch "$SINCE")"; then
    echo "[fork-regression] --since は時差つきの時刻です（例: 2030-01-02T03:04:05+09:00）: ${SINCE}" >&2
    echo "[fork-regression]   日付だけ・時差の無い時刻・存在しない日時は受け付けません（日に丸めません）。" >&2
    exit 2
  fi
fi

##
# 読み取りだけを送り、結果の行の配列を返す。**select で始まらない文は送らない。**
#
# @param $1 SQL
# @return 標準出力へ行の JSON 配列
##
send_query() {
  local sql="$1"
  if [[ ! "$sql" =~ ^[[:space:]]*select[[:space:]] ]]; then
    echo "[fork-regression] select で始まらない文は送りません（読み取りのみ）。" >&2
    return 1
  fi
  if printf '%s' "$sql" | tr 'A-Z' 'a-z' | grep -E '(^|[^a-z_])(insert|update|delete|drop|create|alter|replace)([^a-z_]|$)' >/dev/null; then
    echo "[fork-regression] 書き込みを伴う語が含まれています（読み取りのみ）。" >&2
    return 1
  fi

  local args=(d1 execute DB --command "$sql" --json)
  if [[ "$SCOPE" == "--remote" ]]; then
    # 本番の D1 は [env.production] 側にしか宣言が無い（scripts/kpi-report.sh と同じ）。
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
    echo "[fork-regression] D1 を読めません（${SCOPE}）:" >&2
    printf '%s\n' "$out" >&2
    # **黙って 0 組を返さない。** 表が無いだけのときに 0 組と出すと「フォークがまだ無い」と読める。
    if printf '%s' "$out" | grep -q 'no such table'; then
      echo "[fork-regression] 表がありません。マイグレーションが未適用の可能性があります:" >&2
      echo "[fork-regression]   npm run db:migrate    # 手元の D1 へ適用する" >&2
    fi
    return 1
  fi

  local json
  json="$(printf '%s' "$out" | sed -n '/^\[/,$p')"
  if [[ -z "$json" ]]; then
    echo "[fork-regression] wrangler の応答に JSON が含まれていません（${SCOPE}）:" >&2
    printf '%s\n' "$out" >&2
    return 1
  fi
  # **形を先に検査する**（kpi-report.sh と同じ理由。形が変わった日に静かに 0 組にならないように）。
  if ! jq -e '(type == "array") and (.[0] | type == "object") and (.[0].results | type == "array")' \
       <<<"$json" >/dev/null 2>&1; then
    echo "[fork-regression] D1 の応答の形が想定と違います（wrangler --json の形が変わった可能性があります）。" >&2
    printf '%s' "$json" | head -c 500 >&2
    echo >&2
    return 1
  fi
  jq -c '.[0].results' <<<"$json"
}

# ── 問い合わせ ──────────────────────────────────────────────────────────────

# 数える組の条件。**failed は親子とも外す**（冒頭）。開始の時刻は since_to_epoch を通った数字だけ
# なので、SQL へ直接置いてよい。
COUNTED_PAIR="c.generation_state <> 'failed' and p.generation_state <> 'failed'"
if [[ -n "$SINCE_EPOCH" ]]; then
  COUNTED_PAIR="${COUNTED_PAIR} and c.created_at > ${SINCE_EPOCH}"
fi

# **id を select しない**（冒頭の UGC）。並びは子の作成順で、同じ秒は id で決める。
# 指標の行が無ければ左外部結合で NULL になる（`source_key` が NULL の作品も同じ）。
SQL_PAIRS="select
  pm.has_win_text as p_win, pm.has_lose_text as p_lose, pm.state_count as p_states,
  pm.color_count as p_colors, pm.sprite_count as p_sprites, pm.rule_version as p_rule,
  cm.has_win_text as c_win, cm.has_lose_text as c_lose, cm.state_count as c_states,
  cm.color_count as c_colors, cm.sprite_count as c_sprites, cm.rule_version as c_rule
from games c
  join games p on p.id = c.parent_id
  left join source_quality_metrics pm on pm.source_key = p.source_key
  left join source_quality_metrics cm on cm.source_key = c.source_key
where ${COUNTED_PAIR}
order by c.created_at, c.id"

ROWS="$(send_query "$SQL_PAIRS")" || exit 2

# ── 判定（jq の 1 か所だけ）──────────────────────────────────────────────────

REPORT="$(jq -n --argjson rows "$ROWS" --arg since "$SINCE" --arg sinceEpoch "$SINCE_EPOCH" '
  def side(r; pre): {
    win: r[pre + "win"], lose: r[pre + "lose"], states: r[pre + "states"],
    colors: r[pre + "colors"], sprites: r[pre + "sprites"], ruleVersion: r[pre + "rule"]
  };
  def judge(r):
    if r.p_rule == null or r.c_rule == null then
      { status: "unmeasurable", reason: "no-metrics" }
    elif r.p_rule != r.c_rule then
      { status: "unmeasurable", reason: "rule-version-mismatch" }
    else
      ({
        winLost: (r.p_win == 1 and r.c_win == 0),
        loseLost: (r.p_lose == 1 and r.c_lose == 0),
        statesDecreased: (r.c_states < r.p_states)
      }) as $items
      | { status: (if ($items | to_entries | any(.value)) then "regressed" else "kept" end),
          items: $items }
    end;
  def count(xs; f): [xs[] | select(f)] | length;
  ([$rows | to_entries[] | ({ pair: (.key + 1) } + judge(.value)
     + { parent: side(.value; "p_"), child: side(.value; "c_") })]) as $pairs
  | ([$pairs[] | select(.status != "unmeasurable")]) as $measured
  | {
      since: (if $since == "" then null else { at: $since, epoch: ($sinceEpoch | tonumber), appliesTo: "child.created_at" } end),
      totals: {
        pairs: ($pairs | length),
        measured: ($measured | length),
        regressed: count($measured; .status == "regressed"),
        byItem: {
          winLost: count($measured; .items.winLost),
          loseLost: count($measured; .items.loseLost),
          statesDecreased: count($measured; .items.statesDecreased)
        },
        unmeasurable: {
          total: count($pairs; .status == "unmeasurable"),
          noMetrics: count($pairs; .reason == "no-metrics"),
          ruleVersionMismatch: count($pairs; .reason == "rule-version-mismatch")
        }
      },
      pairs: $pairs,
      caveat: "3 項目は語と宣言の照合であり、ゲームとして成り立っているかの代理ではない。退行が 0 でも土台が継承されているとは言えない。母数（組の数）と併せて読むこと。"
    }')" || exit 2

if [[ "$FORMAT" == "json" ]]; then
  printf '%s\n' "$REPORT"
  exit 0
fi

echo "[fork-regression] 対象: ${SCOPE}${PERSIST_TO:+（--persist-to ${PERSIST_TO}）}"
if [[ -n "$SINCE" ]]; then
  echo "[fork-regression] 期間: 子の作成が ${SINCE}（UNIX ${SINCE_EPOCH}）より後の組"
else
  echo "[fork-regression] 期間: 指定なし（全期間）"
fi
echo "[fork-regression] 親か子が生成に失敗した組（generation_state = 'failed'）は数えていません。"
echo
jq -r '
  def n(v): (v | tostring);
  def flag(v): if v == null then "—" else n(v) end;
  "組 " + n(.totals.pairs) + "（測れた " + n(.totals.measured) + " / 測れない " + n(.totals.unmeasurable.total) + "）",
  "  退行のあった組     " + n(.totals.regressed) + " / " + n(.totals.measured),
  "    勝ちの語が消えた   " + n(.totals.byItem.winLost),
  "    負けの語が消えた   " + n(.totals.byItem.loseLost),
  "    状態の数が減った   " + n(.totals.byItem.statesDecreased),
  "  測れない組の内訳   指標の行が無い " + n(.totals.unmeasurable.noMetrics)
    + " / rule_version が揃わない " + n(.totals.unmeasurable.ruleVersionMismatch),
  "",
  "組ごと（子の作成順。勝ち/負け/状態の数 を 親 → 子 で）:",
  (.pairs[] | "  #" + n(.pair) + "  " + .status
    + (if .reason then "（" + .reason + "）" else "" end)
    + "  win " + flag(.parent.win) + "→" + flag(.child.win)
    + "  lose " + flag(.parent.lose) + "→" + flag(.child.lose)
    + "  states " + flag(.parent.states) + "→" + flag(.child.states)),
  "",
  "注意: " + .caveat
' <<<"$REPORT"
echo
echo "FORK_REGRESSION_REPORT_PASS"
exit 0
