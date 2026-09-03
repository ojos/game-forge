#!/usr/bin/env bash
# ogp-stale-report.sh — 中断したままの OGP 撮影を、本番の台帳に対して数える（#235）
#
# ## なぜ要るのか
#
# 撮影関数が**関数ごと落ちる**と（Lambda のタイムアウト・メモリ不足・送信中の切断）、
# 失敗のコールバックすら飛ばず、`games.ogp_state` が **`capturing` のまま残る**。
# 共有 URL は OGP 無しで拡散し、**気づく経路がどこにも無かった**
# （`docs/ogp-capture.md` 7 章）。**作品ページはこの状態を待たずに出る**ので、
# 運用側が自分で見に行かないと分からない。
#
# 使い方:
#   bash scripts/ogp-stale-report.sh                    # 本番（読み取りのみ）
#   bash scripts/ogp-stale-report.sh --format json
#   bash scripts/ogp-stale-report.sh --rows-file saved.json   # 検査用（本番へ触れない）
#
# 終了コード:
#   0 = OGP_STALE_NONE（中断したままの行は無い）
#   1 = OGP_STALE_FOUND（有る。一覧を出す）
#   2 = 前提の不成立（未認証・道具が無い・行を取れない・定数を取り出せない）
#
# **1 と 2 を分ける。** 「中断が有った」と「調べられなかった」は別である。
# 混ぜると、認証が切れているだけの日に「中断が有る」と読むことになる
# （`scripts/build-time-report.sh` が `BUILD_HEADROOM_UNKNOWN` を分けたのと同じ理由）。
#
# ── 閾値と「いつ撮り始めたか」は src/ogp.ts から取り出す（書き写さない）─────────
#
# 期限切れの定義は `OGP_STALE_AFTER_SECONDS` と `OGP_CAPTURE_SINCE_SQL` が持つ。
# **ここへ数字や式を写すと、掴み直す側（`reclaimStaleOgpCapture`）と食い違う**
# ——「検出できるのに掴めない」行や、その逆が生まれる。取り出せなければ**落とす**
# （空のまま比較すると、空どうしが一致して緑になる。`scripts/check-ogp-copies.sh` の
# `require` と同じ規律）。
#
# **この検査が約束しないこと**: 取り出すのは 2 つの定数だけである。SQL の残り
# （`status = 'published'` と `ogp_state = 'capturing'`）は状態の綴りそのものなので
# ここにも書いてある。**綴りを変えたら、ここも直すこと。**
#
# ── 本番へは select しか送らない ────────────────────────────────────────────
#
# `scripts/effort-ab-report.sh` と同じ規律である。組み立てた SQL が select で
# 始まることを検査してから送る。**進める（掴み直す）のはこのスクリプトの仕事ではない**
# ——それは作者が作品ページから押す（`src/ogp-recapture.ts`）。**手作業の UPDATE を
# 別の形で復活させない。**
#
# ── 題名を持ち出さない（8.2）────────────────────────────────────────────────
#
# 題名はプロンプト由来の UGC である（`src/games.ts` の `draftTitleFromPrompt`）。
# 運用の一覧に要るのは id だけで、**5.1 の入力そのものはローカルへ落とさない**
# （`src/ogp.ts` の `listStaleOgpCaptures` と同じ判断）。
#
# **GNU 拡張を使わない**（利用者の端末は macOS / bash 3.2。docs/handoff.md 3 章）。
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)" || exit 2
ROOT="$(dirname "$HERE")"
cd "$ROOT" || exit 2

OGP_TS="src/ogp.ts"
FORMAT="table"
ROWS_FILE=""
NOW="${OGP_STALE_NOW:-$(date -u +%s)}"

##
# 値を取る引数に、値が付いていることを確かめる。**無ければ落とす。**
#
# `shift 2` は残りが 1 個のとき**シフトせずに失敗する**。`set -e` を使っていないので
# そのまま次の周回へ進み、`while [[ $# -gt 0 ]]` が同じ引数を読み続けて**無限ループ**に
# なる（`bash scripts/ogp-stale-report.sh --format` で再現した。exit 124）。
#
# **黙って既定値へ倒さない。** 値を書いた人は既定でないものを求めており、既定へ倒すと
# 「指定したのに効かなかった」になる。
#
# @param $1 引数の綴り
# @param $2 残りの個数
##
require_value() {
  if [[ "$2" -lt 2 ]]; then
    echo "[ogp-stale] $1 には値が要ります。" >&2
    exit 2
  fi
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --format) require_value "$1" "$#"; FORMAT="$2"; shift 2 ;;
    # 本番の代わりに、保存しておいた行を読む（本番にも認証にも触れない）。
    --rows-file) require_value "$1" "$#"; ROWS_FILE="$2"; shift 2 ;;
    -h|--help) sed -n '2,25p' "${BASH_SOURCE[0]}" >&2; exit 0 ;;
    *) echo "[ogp-stale] 不明な引数です: $1" >&2; exit 2 ;;
  esac
done

if [[ "$FORMAT" != "table" && "$FORMAT" != "json" ]]; then
  echo "[ogp-stale] --format は table か json です: ${FORMAT}" >&2
  exit 2
fi

if [[ ! -f "$OGP_TS" ]]; then
  echo "[ogp-stale] 定義の正本がありません: ${OGP_TS}" >&2
  echo "[ogp-stale] 閾値を推測しません（見ていないことを合格にしない）。" >&2
  exit 2
fi

# 定数を取り出す。**取り出せなければ落とす**（冒頭の規律）。
STALE_AFTER="$(sed -n 's/^export const OGP_STALE_AFTER_SECONDS = \([0-9][0-9]*\);.*/\1/p' "$OGP_TS" | head -1)"
SINCE_SQL="$(sed -n "s/^export const OGP_CAPTURE_SINCE_SQL = '\(.*\)';.*/\1/p" "$OGP_TS" | head -1)"

if [[ -z "$STALE_AFTER" ]]; then
  echo "[ogp-stale] ${OGP_TS} から OGP_STALE_AFTER_SECONDS を取り出せません。" >&2
  echo "[ogp-stale] 綴りが変わったなら、このスクリプトの sed も直してください。" >&2
  exit 2
fi
if [[ -z "$SINCE_SQL" ]]; then
  echo "[ogp-stale] ${OGP_TS} から OGP_CAPTURE_SINCE_SQL を取り出せません。" >&2
  echo "[ogp-stale] 綴りが変わったなら、このスクリプトの sed も直してください。" >&2
  exit 2
fi

CUTOFF=$((NOW - STALE_AFTER))

if ! command -v jq >/dev/null 2>&1; then
  echo "[ogp-stale] jq がありません（応答の形を確かめるのに要ります）。" >&2
  exit 2
fi

# 読み取りだけを送る。**select で始まらない文は送らない。**
send_query() {
  local sql="$1"
  if [[ ! "$sql" =~ ^[[:space:]]*select[[:space:]] ]]; then
    echo "[ogp-stale] select で始まらない文は送りません（読み取りのみ）。" >&2
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
    echo "[ogp-stale] 本番の D1 を読めません:" >&2
    printf '%s\n' "$out" >&2
    return 1
  fi

  # --json でも wrangler は前置きの行を混ぜることがある。最初の [ から後ろを渡す。
  local json
  json="$(printf '%s' "$out" | sed -n '/^\[/,$p')"
  if [[ -z "$json" ]]; then
    echo "[ogp-stale] wrangler の応答に JSON が含まれていません:" >&2
    printf '%s\n' "$out" >&2
    return 1
  fi
  if ! jq -e '(type == "array") and (.[0] | type == "object") and (.[0].results | type == "array")' \
       <<<"$json" >/dev/null 2>&1; then
    echo "[ogp-stale] wrangler の --json の形が想定と違います（静かに 0 行にしません）:" >&2
    printf '%s\n' "$json" | head -5 >&2
    return 1
  fi

  jq -c '[.[] | .results] | add' <<<"$json"
}

if [[ -n "$ROWS_FILE" ]]; then
  if [[ ! -f "$ROWS_FILE" ]]; then
    echo "[ogp-stale] 保存済みの行が見つかりません: ${ROWS_FILE}" >&2
    exit 2
  fi
  ROWS="$(cat "$ROWS_FILE")"
  SOURCE_LABEL="${ROWS_FILE}（保存済みの行。本番へは触れていません）"
  # 保存済みの行にも同じ閾値を当てる（行の側では絞り込まれていない）。
  ROWS="$(jq -c --argjson cutoff "$CUTOFF" \
    '[ .[] | select((.since // 0) <= $cutoff) ] | sort_by(.since)' <<<"$ROWS" 2>/dev/null)" || {
      echo "[ogp-stale] 保存済みの行の形が想定と違います（id と since の配列）。" >&2
      exit 2
    }
else
  ROWS="$(send_query "select id, ${SINCE_SQL} as since
     from games
    where status = 'published' and ogp_state = 'capturing' and ${SINCE_SQL} <= ${CUTOFF}
    order by since asc")" || exit 2
  SOURCE_LABEL="本番の D1（読み取りのみ）"
fi

if [[ -z "$ROWS" || "$ROWS" == "null" ]]; then
  echo "[ogp-stale] 行を取り出せませんでした。判定しません。" >&2
  exit 2
fi

COUNT="$(jq 'length' <<<"$ROWS")"

if [[ "$FORMAT" == "json" ]]; then
  jq --argjson now "$NOW" --argjson after "$STALE_AFTER" \
     '{ staleAfterSeconds: $after, now: $now, count: length,
        rows: [ .[] | { gameId: .id, since: .since, elapsedSeconds: ($now - (.since // 0)) } ] }' \
     <<<"$ROWS"
else
  echo "[ogp-stale] 対象: ${SOURCE_LABEL}"
  echo "[ogp-stale] 閾値: ${STALE_AFTER} 秒（src/ogp.ts の OGP_STALE_AFTER_SECONDS）"
  echo "[ogp-stale] 起点: ${SINCE_SQL}"
  if [[ "$COUNT" -gt 0 ]]; then
    printf '%-38s %12s %14s\n' "game_id" "since" "elapsed(s)"
    jq -r --argjson now "$NOW" \
      '.[] | [ .id, (.since // 0), ($now - (.since // 0)) ] | @tsv' <<<"$ROWS" \
      | while IFS=$'\t' read -r id since elapsed; do
          printf '%-38s %12s %14s\n' "$id" "$since" "$elapsed"
        done
  fi
fi

if [[ "$COUNT" -gt 0 ]]; then
  if [[ "$FORMAT" == "table" ]]; then
    echo "[ogp-stale] 撮り直しは作者が作品ページから押します（/api/ogp/recapture）。"
    echo "[ogp-stale] **本番 D1 を手で UPDATE しないこと**（docs/ogp-capture.md 7 章）。"
    echo "OGP_STALE_FOUND"
  fi
  exit 1
fi

if [[ "$FORMAT" == "table" ]]; then
  echo "OGP_STALE_NONE"
fi
exit 0
