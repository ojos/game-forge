#!/usr/bin/env bash
# effort-ab-report.sh — #25 の A/B の結果を、本番の台帳に対して読み出す（#238）
#
# **これまで読み出す手段が無かった。** `effortExperimentTotals` を呼んでいるのは
# `test/cost-ledger.test.ts` だけで、経路もスクリプトも無く、**本番の台帳に対しては
# 1 度も動いていなかった**（#25 の acceptance は「テストの中では動く」までだった）。
#
# 使い方:
#   bash scripts/effort-ab-report.sh --from 2026-09-01 --to 2026-09-02
#   bash scripts/effort-ab-report.sh --days 3 --format json
#   bash scripts/effort-ab-report.sh --rows-file saved.json --from ... --to ...  # 検査用
#
# 期間の指定・日の境界・日付の綴りは scripts/report-window.sh が持つ。ここへ書き写さない。
#
# 終了コード: 0 = 出力した / 2 = 前提の不成立（未認証・道具が無い・行が取れない）
#
# ── 集計を SQL へ写さない ────────────────────────────────────────────────────
#
# **`src/cost-ledger.ts` の `effortExperimentTotals` をそのまま回す。** あれは依頼の
# 切り分け・層別・元ソースの有無の判定を持っており、SQL へ写すと**数え方の定義が
# 2 か所になる**。`scripts/report-selftest.sh` が「定義は 1 か所であること」を機械で
# 検査しているので、それを自分で壊すことになる。
#
# ── 本番へは select しか送らない ────────────────────────────────────────────
#
# `scripts/usage-report.sh` と同じ規律である。組み立てた SQL が select で始まることを
# 検査してから送る。
#
# ── プロンプトの本文を持ち出さない（8.2）────────────────────────────────────
#
# 集計は依頼の切り分けに `prompt` を使うが、**必要なのは「等しいかどうか」だけ**である。
# 取り出す側で `dense_rank()` の番号へ置き換えるので、**5.1 の入力そのものはローカルへ
# 落ちない。** 集計の結果にも prompt は載らない（`effortExperimentTotals` の但し書き）。
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)" || exit 2
ROOT="$(dirname "$HERE")"
cd "$ROOT" || exit 2

# shellcheck source=scripts/report-window.sh
. "$HERE/report-window.sh"

DAYS=""
FROM=""
TO=""
FORMAT="table"
ROWS_FILE=""
NOW="${EFFORT_AB_NOW:-$(date -u +%s)}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --days)   DAYS="${2:-}"; shift 2 ;;
    --from)   FROM="${2:-}"; shift 2 ;;
    --to)     TO="${2:-}"; shift 2 ;;
    --format) FORMAT="${2:-}"; shift 2 ;;
    # 本番の代わりに、保存しておいた行を読む。**scripts/report-selftest.sh が
    # 集計そのものを検査するための口である**（本番にも認証にも触れない）。
    --rows-file) ROWS_FILE="${2:-}"; shift 2 ;;
    -h|--help) sed -n '2,20p' "${BASH_SOURCE[0]}" >&2; exit 0 ;;
    *) echo "[effort-ab] 不明な引数です: $1" >&2; exit 2 ;;
  esac
done

case "$FORMAT" in
  table|json) ;;
  *) echo "[effort-ab] --format は table / json のいずれかです: ${FORMAT}" >&2; exit 2 ;;
esac

report_window_require_tools jq node || exit 2
report_window_resolve "$DAYS" "$FROM" "$TO" "$NOW" || exit 2

SANDBOX="$(mktemp -d "${TMPDIR:-/tmp}/effort-ab.XXXXXX")" || exit 2
trap 'rm -rf "$SANDBOX"' EXIT

##
# 本番へ 1 文だけ送る。**select で始まらない文は送らない。**
#
# **形を先に検査する。** `jq` の `?` や `// empty` は型が違っても黙って空を返すため、
# これに頼ると **wrangler の `--json` の形が変わった日に、集計が静かに 0 行になる。**
# 0 行は「その期間に生成が無かった」と読めてしまい、いちばん気づけない壊れ方になる
# （`scripts/usage-report.sh` の `send_query` と同じ理由・同じ形）。
#
# **失敗の中身を捨てない。** 資格情報の失効も CLI の不具合も、ここで握りつぶすと
# 「行が取れない」としか出ず、原因が読み取れない赤になる。
#
# @param $1 SQL
# @return 標準出力へ results の配列（JSON）
##
send_query() {
  local sql="$1"
  if [[ ! "$sql" =~ ^[[:space:]]*select[[:space:]] ]]; then
    echo "[effort-ab] select で始まらない文は送りません（読み取りのみ）。" >&2
    return 1
  fi

  # wrangler は CLOUDFLARE_API_TOKEN を自分で読むが、非対話シェルには .env が
  # 載っていない。値はこのスクリプトへ持ち込まず、環境へ移すだけにする。
  if [[ -z "${CLOUDFLARE_API_TOKEN:-}" && -f "$HERE/load-project-env.sh" ]]; then
    # shellcheck source=scripts/load-project-env.sh
    . "$HERE/load-project-env.sh"
  fi

  local out
  if ! out="$(CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV=false \
    npx wrangler d1 execute DB --remote --env production --json --command "$sql" 2>&1)"; then
    echo "[effort-ab] 本番の D1 を読めません:" >&2
    printf '%s\n' "$out" >&2
    return 1
  fi

  # --json でも wrangler は前置きの行を混ぜることがある。最初の [ から後ろを渡す。
  local json
  json="$(printf '%s' "$out" | sed -n '/^\[/,$p')"
  if [[ -z "$json" ]]; then
    echo "[effort-ab] wrangler の応答に JSON が含まれていません:" >&2
    printf '%s\n' "$out" >&2
    return 1
  fi
  if ! jq -e '(type == "array") and (.[0] | type == "object") and (.[0].results | type == "array")' \
       <<<"$json" >/dev/null 2>&1; then
    echo "[effort-ab] wrangler の --json の形が想定と違います（静かに 0 行にしません）:" >&2
    printf '%s\n' "$json" | head -5 >&2
    return 1
  fi

  jq -c '[.[] | .results] | add' <<<"$json"
}

ROWS="${SANDBOX}/rows.json"

if [[ -n "$ROWS_FILE" ]]; then
  if [[ ! -f "$ROWS_FILE" ]]; then
    echo "[effort-ab] 保存済みの行が見つかりません: ${ROWS_FILE}" >&2
    exit 2
  fi
  cp "$ROWS_FILE" "$ROWS"
  SOURCE_LABEL="${ROWS_FILE}（保存済みの行。本番へは触れていません）"
else
  # **prompt は本文ではなく番号にする**（8.2。上の注記）。
  gens="$(send_query "select id, model, effort, input_tokens, output_tokens,
      cache_creation_input_tokens, cache_read_input_tokens, cost_jpy, succeeded, created_at,
      dense_rank() over (order by user_id, prompt) as prompt
    from generations
   where created_at >= ${REPORT_WINDOW_FROM} and created_at < ${REPORT_WINDOW_TO}")" || exit 2
  games="$(send_query "select id, generation_state, generation_error, created_at
    from games
   where created_at >= ${REPORT_WINDOW_FROM} and created_at < ${REPORT_WINDOW_TO}")" || exit 2
  if [[ -z "$gens" || -z "$games" ]]; then
    echo "[effort-ab] 本番の台帳を読めません（AWS ではなく Cloudflare の認証です）。" >&2
    echo "[effort-ab] これは分布の異常ではなく前提の不成立です。判定しません。" >&2
    exit 2
  fi
  jq -n --argjson g "$gens" --argjson w "$games" '{generations: $g, games: $w}' >"$ROWS"
  SOURCE_LABEL="本番の D1（読み取りのみ。prompt は番号へ置き換え済み）"
fi

# 集計を束ねる。**src/cost-ledger.ts をそのまま使う**（写さない）。
ESBUILD="node_modules/.bin/esbuild"
if [[ ! -x "$ESBUILD" ]]; then
  echo "[effort-ab] esbuild がありません: ${ESBUILD}（npm ci を打つこと）" >&2
  exit 2
fi
BUNDLE="${SANDBOX}/cost-ledger.mjs"
"$ESBUILD" src/cost-ledger.ts --bundle --format=esm --platform=neutral \
  --outfile="$BUNDLE" --log-level=warning || exit 2

# **--format json のときは、標準出力を JSON だけにする。** 混ぜると jq へ素直に
# 渡せない（scripts/build-time-report.sh は末尾に判定の綴りを足す形だが、あちらは
# 判定の信号が要るためである。こちらは読み出しの道具なので混ぜない）。
if [[ "$FORMAT" == "table" ]]; then
  echo "[effort-ab] ${SOURCE_LABEL}"
  report_window_describe
else
  echo "[effort-ab] ${SOURCE_LABEL}" >&2
fi
node "$HERE/effort-ab-report.mjs" \
  --rows "$ROWS" --bundle "$BUNDLE" \
  --from "$REPORT_WINDOW_FROM" --to "$REPORT_WINDOW_TO" --format "$FORMAT"
