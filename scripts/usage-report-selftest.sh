#!/usr/bin/env bash
# usage-report-selftest.sh — 集計スクリプトの自己検査（#149）
#
# **#149 の acceptance は「手元の D1 に既知の行を入れると、期待どおりの集計が出ることを
# テストで確認できる」ことを求めている。** 台帳を読む処理は wrangler と SQL の上にあり、
# workerd 上の vitest からは同じ経路を通せない（あちらは Worker の中から D1 を触る）。
# **スクリプトそのものを、スクリプトとして検査する。**
#
# 使い方:
#   bash scripts/usage-report-selftest.sh
#
# 終了コード: 0 = 合格（USAGE_REPORT_SELFTEST_PASS） / 1 = 不合格
#
# ── 手元の D1 を汚さない ────────────────────────────────────────────────────
#
# 既知の行を入れる以上、**開発者が普段使っている .wrangler の D1 へ書いてはいけない。**
# 使い捨ての置き場所（--persist-to）へマイグレーションを適用し、そこへ入れる。
# 検査が途中で落ちても、消すのは自分で作った一時ディレクトリだけである。
#
# **本番 D1 には触れない。** このスクリプトは --remote を一度も渡さない。
#
# ── 何を検査するか ──────────────────────────────────────────────────────────
#
#   1. 数え方の定義が 1 か所であること（#166 と別々の数え方をしないための担保）
#   2. 日の境界が src/quota.ts の jstDayRange と同じであること
#   3. 既知の行に対して、期待どおりの集計が出ること
#   4. モデル別に割っても、合計が変わらないこと（#25 が同じ台帳へ乗れる形）
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)" || exit 1
ROOT="$(dirname "$HERE")"
cd "$ROOT" || exit 1

# shellcheck source=scripts/report-window.sh
. "$HERE/report-window.sh"

failed=0

##
# 1 件の判定。**失敗しても続ける**（乖離は複数あることが多く、1 件ずつ往復すると
# 回数だけ増える。scripts/acceptance-remote.sh と同じ方針）。
#
# @param $1 ラベル
# @param $2 期待値
# @param $3 実際の値
##
expect_eq() {
  if [[ "$2" == "$3" ]]; then
    echo "  ok   $1"
  else
    echo "  FAIL $1" >&2
    echo "       expected: $2" >&2
    echo "       actual:   $3" >&2
    failed=1
  fi
}

# ── 1. 数え方の定義が 1 か所であること ──────────────────────────────────────
#
# **#149 と #166 が別々の定義を持つと、2 つの表を並べても比較が成立しない**
# （#166 の constraints）。共有していることを、呼びかけではなく機械で見る。
#
# 消費側の一覧はここが持つ。**新しい集計を足したらここへ足す。** 足し忘れると
# 「共有していない集計が 1 本ある」状態が緑のまま通る。
echo "[selftest] 数え方の定義が 1 か所であること"

CONSUMERS=(scripts/usage-report.sh)

for consumer in "${CONSUMERS[@]}"; do
  if [[ ! -f "$consumer" ]]; then
    echo "  FAIL ${consumer} がありません（一覧が実体と食い違っています）" >&2
    failed=1
    continue
  fi
  if grep -q 'report-window\.sh' "$consumer"; then
    echo "  ok   ${consumer} が report-window.sh を読んでいる"
  else
    echo "  FAIL ${consumer} が report-window.sh を読んでいません" >&2
    failed=1
  fi
  # **自前のオフセットを持っていないこと。** 定数名で参照している行は写しではない。
  own_offset="$(grep -nE '(^|[^_A-Z])32400([^0-9]|$)|9 \* 60 \* 60' "$consumer" \
    | grep -v 'REPORT_WINDOW_JST_OFFSET_SECONDS' || true)"
  if [[ -n "$own_offset" ]]; then
    echo "  FAIL ${consumer} が自前の JST オフセットを持っています:" >&2
    printf '       %s\n' "$own_offset" >&2
    failed=1
  else
    echo "  ok   ${consumer} が自前の JST オフセットを持っていない"
  fi
done

# ── 2. 日の境界が src/quota.ts と同じであること ─────────────────────────────
#
# **確定25 は日の境界を JST の 0 時と定めており、日次枠の判定はそこで切っている。**
# 集計だけが UTC で切ると、「枠を使い切った日」と「表に出る日」が 9 時間ずれる。
#
# src/quota.ts の定数は TypeScript の式（9 * 60 * 60）なので、シェルから実行時に
# 引けない。**式を読んで計算し、写しと突き合わせる。**
echo "[selftest] 日の境界が src/quota.ts の jstDayRange と同じであること"

quota_expr="$(sed -n 's/^const JST_OFFSET_SECONDS = \(.*\);$/\1/p' src/quota.ts | head -1)"
if [[ -z "$quota_expr" ]]; then
  echo "  FAIL src/quota.ts から JST_OFFSET_SECONDS を読めません（綴りが変わった可能性）" >&2
  failed=1
else
  quota_offset=$(( quota_expr ))
  expect_eq "JST オフセット（src/quota.ts = ${quota_expr}）" \
    "$quota_offset" "$REPORT_WINDOW_JST_OFFSET_SECONDS"
fi

# 境界そのものの検査。JST の 23:59:59 と、その 1 秒後が別の日に入ること。
last_second="$(date -u -d "2026-08-29T14:59:59Z" +%s)"   # 2026-08-29 23:59:59 JST
next_second=$(( last_second + 1 ))                        # 2026-08-30 00:00:00 JST
expect_eq "JST 23:59:59 の日付" "2026-08-29" "$(report_window_label "$last_second")"
expect_eq "その 1 秒後の日付"   "2026-08-30" "$(report_window_label "$next_second")"

# ── 3. 既知の行に対して期待どおりの集計が出ること ───────────────────────────
echo "[selftest] 既知の行に対する集計"

if ! report_window_require_tools jq npx; then
  echo "[selftest] 前提の道具が揃っていません。" >&2
  echo "USAGE_REPORT_SELFTEST_FAIL"
  exit 1
fi

SANDBOX="$(mktemp -d "${TMPDIR:-/tmp}/usage-report-selftest.XXXXXX")" || exit 1
trap 'rm -rf "$SANDBOX"' EXIT

d1() {
  CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV=false \
    npx wrangler d1 execute DB --local --persist-to "$SANDBOX" "$@"
}

echo "  ... 使い捨ての D1 を作る（${SANDBOX}）"
if ! CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV=false \
     npx wrangler d1 migrations apply DB --local --persist-to "$SANDBOX" >/dev/null 2>&1; then
  echo "  FAIL 使い捨ての D1 へマイグレーションを適用できません" >&2
  echo "USAGE_REPORT_SELFTEST_FAIL"
  exit 1
fi

# JST の壁時計から UNIX 秒を作る。**期待値の側も report-window.sh の境界を使う。**
# 別の計算式で期待値を作ると、両方が同じだけずれたときに検査が通ってしまう……のではなく、
# ここで見たいのは「窓の中の行が正しく畳まれるか」なので、時刻の指定は素直な形にする。
at() { date -u -d "$1" +%s; }   # 引数は UTC。JST = UTC+9 を呼び出し側で織り込む。

# 台帳の行は user_id で users を参照する（migrations/0001_init.sql）。
d1 --command "insert into users (id, google_sub, email, display_name, created_at)
              values ('u-selftest', 'sub-selftest', 'selftest@example.invalid', 'selftest', 0)" \
  >/dev/null 2>&1 || { echo "  FAIL users を作れません" >&2; failed=1; }

##
# 台帳へ 1 行入れる。
#
# @param $1 id
# @param $2 created_at（UNIX 秒）
# @param $3 model
# @param $4 succeeded（0/1）
# @param $5 cost_jpy
##
seed() {
  d1 --command "insert into generations
      (id, game_id, user_id, prompt, model,
       input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens,
       cost_jpy, succeeded, created_at)
     values ('$1', null, 'u-selftest', 'p', '$3', 0, 0, 0, 0, $5, $4, $2)" >/dev/null 2>&1 \
    || { echo "  FAIL 台帳へ行を入れられません: $1" >&2; failed=1; }
}

# 2026-08-27（JST）… 3 回・成功 2・合計 60.00 円
seed g1 "$(at 2026-08-26T15:30:00Z)" 'sonnet-4-6' 1 10.00
seed g2 "$(at 2026-08-27T03:00:00Z)" 'sonnet-4-6' 1 20.00
seed g3 "$(at 2026-08-27T10:00:00Z)" 'sonnet-4-6' 0 30.00
# 2026-08-28（JST）… 2 回・成功 2・合計 10.00 円（モデル 2 種）
seed g4 "$(at 2026-08-27T16:00:00Z)" 'deepseek-v3-2' 1 5.50
seed g5 "$(at 2026-08-28T05:00:00Z)" 'sonnet-4-6' 1 4.50
# 2026-08-29（JST）の最後の 1 秒 … 1 回・成功 0・7.25 円
seed g6 "$(at 2026-08-29T14:59:59Z)" 'sonnet-4-6' 0 7.25
# 窓の外（前後 1 行ずつ）。**入ってはいけない。**
seed g7 "$(at 2026-08-25T12:00:00Z)" 'sonnet-4-6' 1 999.00
seed g8 "$(at 2026-08-29T15:00:00Z)" 'sonnet-4-6' 1 888.00

report() {
  bash scripts/usage-report.sh --persist-to "$SANDBOX" --format json "$@"
}

json="$(report --from 2026-08-27 --to 2026-08-29)"
if [[ -z "$json" ]]; then
  echo "  FAIL 集計を取得できません" >&2
  failed=1
else
  expect_eq "行数" "3" "$(jq -r 'length' <<<"$(jq -c '.rows' <<<"$json")")"
  expect_eq "2026-08-27 の行" '{"day":"2026-08-27","model":null,"calls":3,"llmSucceeded":2,"costJpy":60}' \
    "$(jq -c '.rows[0]' <<<"$json")"
  expect_eq "2026-08-28 の行" '{"day":"2026-08-28","model":null,"calls":2,"llmSucceeded":2,"costJpy":10}' \
    "$(jq -c '.rows[1]' <<<"$json")"
  expect_eq "2026-08-29 の行（JST 23:59:59 が入る）" \
    '{"day":"2026-08-29","model":null,"calls":1,"llmSucceeded":0,"costJpy":7.25}' \
    "$(jq -c '.rows[2]' <<<"$json")"
  expect_eq "合計（窓の外の 999 円と 888 円が入らない）" \
    '{"calls":6,"llmSucceeded":4,"costJpy":77.25}' "$(jq -c '.totals' <<<"$json")"
  expect_eq "窓の綴り" "2026-08-27" "$(jq -r '.window.fromLabel' <<<"$json")"
  expect_eq "窓の綴り（最終日）" "2026-08-29" "$(jq -r '.window.lastLabel' <<<"$json")"
  expect_eq "境界の名乗り" "jst-midnight" "$(jq -r '.window.boundary' <<<"$json")"
  # **列の意味が出力に載っていること**（#149 の constraints）。
  if jq -e '.notes | map(select(test("succeeded"))) | length > 0' <<<"$json" >/dev/null; then
    echo "  ok   succeeded の意味が出力に載っている"
  else
    echo "  FAIL succeeded の意味が出力に載っていません" >&2
    failed=1
  fi
fi

# 窓の外だと言った行が、窓を移せば出てくること。**「入らない」が「消えている」ではない
# ことを確かめる。** 検査の対象が「窓の切り方」である以上、ここを見ないと
# 「何も入れられていないから空だった」と区別が付かない。
after="$(report --from 2026-08-30 --to 2026-08-30)"
expect_eq "翌日（JST 00:00:00）は翌日の窓に入る" \
  '{"calls":1,"llmSucceeded":1,"costJpy":888}' "$(jq -c '.totals' <<<"$after")"

# ── 4. モデル別に割っても合計が変わらないこと ───────────────────────────────
#
# **#25（M3-4 の effort の A/B）が同じ台帳から集計する。** 割り方を変えたら合計が
# 変わる、という状態だと、2 つの集計を並べた比較がそもそも成立しない。
echo "[selftest] モデル別に割っても合計が変わらないこと"
by_model="$(report --from 2026-08-27 --to 2026-08-29 --by-model)"
expect_eq "モデル別の行数" "4" "$(jq -r '.rows | length' <<<"$by_model")"
expect_eq "モデル別でも合計は同じ" "$(jq -c '.totals' <<<"$json")" "$(jq -c '.totals' <<<"$by_model")"
expect_eq "2026-08-28 は 2 モデルに割れる" '["deepseek-v3-2","sonnet-4-6"]' \
  "$(jq -c '[.rows[] | select(.day == "2026-08-28") | .model]' <<<"$by_model")"

# 表の形（既定の出力）でも落ちないこと。**JSON だけ通って表が落ちる状態を作らない。**
if bash scripts/usage-report.sh --persist-to "$SANDBOX" --from 2026-08-27 --to 2026-08-29 \
     | grep -q 'USAGE_REPORT_PASS'; then
  echo "  ok   表の出力が通過信号を返す"
else
  echo "  FAIL 表の出力が通過信号を返しません" >&2
  failed=1
fi

if (( failed )); then
  echo "USAGE_REPORT_SELFTEST_FAIL"
  exit 1
fi
echo "USAGE_REPORT_SELFTEST_PASS"
