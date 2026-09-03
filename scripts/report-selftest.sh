#!/usr/bin/env bash
# report-selftest.sh — 運用のための集計の自己検査（#149 / #166）
#
# **#149 の acceptance は「手元の D1 に既知の行を入れると、期待どおりの集計が出ることを
# テストで確認できる」ことを求めている。** 台帳を読む処理は wrangler と SQL の上にあり、
# workerd 上の vitest からは同じ経路を通せない（あちらは Worker の中から D1 を触る）。
# **スクリプトそのものを、スクリプトとして検査する。**
#
# 使い方:
#   bash scripts/report-selftest.sh
#
# 終了コード: 0 = 合格（REPORT_SELFTEST_PASS） / 1 = 不合格
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
#   1. 数え方の定義が 1 か所であること（2 つの集計が別々の数え方をしないための担保）
#   2. 日の境界が src/quota.ts の jstDayRange と同じであること
#   3. 既知の行に対して、期待どおりの集計が出ること
#   4. モデル別に割っても、合計が変わらないこと（#25 が同じ台帳へ乗れる形）
#   5. ビルド時間の閾値が、天井の宣言から導かれていること（#166 / #164 が動かす値）
#   6. 天井を動かした直後に、過去の完走が「打ち切り」に化けないこと（#211）
#
# **5 は AWS へ触れない。** 閾値の導出だけを見るので、認証もネットワークも要らない
# （分布そのものを見るには CloudWatch が要るが、それは外部層の関心事である）。
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)" || exit 1
ROOT="$(dirname "$HERE")"
cd "$ROOT" || exit 1

# shellcheck source=scripts/report-window.sh
. "$HERE/report-window.sh"

failed=0

# ── 前提の道具（いちばん先に見る）────────────────────────────────────────────
#
# **この検査は GNU date を要する**（`date -d @<epoch>`）。`report-window.sh` が
# 書式ではなく実際の変換で確かめ、明示して落とす——**黙って別の日付を出さない。**
#
# **以前はこの判定が 3 節にあった。** ところが 2 節が先に `date -u -d` を使うため、
# **macOS（BSD date）では「GNU date が要ります」に辿り着く前に、読み取りにくい FAIL が
# 2 件出た。** 原因が読み取りにくい赤は、ゲートへの信頼を削る
# （`scripts/check-deps-installed.sh` の冒頭と同じ理由）。**前提はいちばん先に見る。**
#
# **利用者の端末は macOS である**（`docs/handoff.md` 3 章）。手元で回すなら
# coreutils の `gdate` を `date` として見せるか、devcontainer の中で回すこと。
# CI（`.github/workflows/verify.yml`）は ubuntu-latest なので、そのまま通る。
if ! report_window_require_tools jq npx; then
  echo "[selftest] 前提の道具が揃っていません。" >&2
  echo "REPORT_SELFTEST_FAIL"
  exit 1
fi

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

CONSUMERS=(scripts/usage-report.sh scripts/build-time-report.sh)

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

SANDBOX="$(mktemp -d "${TMPDIR:-/tmp}/report-selftest.XXXXXX")" || exit 1
trap 'rm -rf "$SANDBOX"' EXIT

d1() {
  CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV=false \
    npx wrangler d1 execute DB --local --persist-to "$SANDBOX" "$@"
}

echo "  ... 使い捨ての D1 を作る（${SANDBOX}）"
if ! CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV=false \
     npx wrangler d1 migrations apply DB --local --persist-to "$SANDBOX" >/dev/null 2>&1; then
  echo "  FAIL 使い捨ての D1 へマイグレーションを適用できません" >&2
  echo "REPORT_SELFTEST_FAIL"
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

# ── 5. ビルド時間の閾値が天井の宣言から導かれていること ─────────────────────
#
# **#164 が第 4 波で天井を動かす（30 → 60 秒を想定）。** 閾値を書き写していたら、
# その日にずれる。ここで見るのは「宣言を差し替えたら閾値も動くか」である。
#
# **AWS へは触れない。** --explain-threshold は導出だけを印字して終わる。
echo "[selftest] ビルド時間の閾値が天井の宣言から導かれていること"

declared="$(sed -n 's/^[[:space:]]*build_function_timeout_seconds[[:space:]]*=[[:space:]]*\([0-9][0-9]*\)[[:space:]]*$/\1/p' \
  terraform/build-function.tf | head -1)"
if [[ -z "$declared" ]]; then
  echo "  FAIL terraform/build-function.tf から天井を読めません" >&2
  failed=1
else
  actual="$(bash scripts/build-time-report.sh --explain-threshold \
    | sed -n 's/^  天井  *\([0-9][0-9]*\) 秒$/\1/p')"
  expect_eq "天井が宣言と一致する" "$declared" "$actual"
fi

# **宣言を差し替えたら閾値が動くこと。** #164 が 60 秒にした日を先に踏んでおく。
fixture="${SANDBOX}/build-function.tf"
cat >"$fixture" <<'FIXTURE'
locals {
  build_function_name = "game-forge-build"

  # #211 以降、メモリの宣言も必須である（判定に使う構成を、ここから読む）。
  build_function_memory_mb = 3008

  build_function_timeout_seconds = 60
}

resource "aws_cloudwatch_log_group" "build" {
  name = "/aws/lambda/${local.build_function_name}"
}
FIXTURE
moved="$(bash scripts/build-time-report.sh --explain-threshold --timeout-source "$fixture")"
expect_eq "天井を 60 秒にすると天井が動く" "60" \
  "$(sed -n 's/^  天井  *\([0-9][0-9]*\) 秒$/\1/p' <<<"$moved")"
expect_eq "天井を 60 秒にすると接近の線も動く" "48.0" \
  "$(sed -n 's/^  接近とみなす線  *\([0-9.]*\) 秒.*$/\1/p' <<<"$moved")"

# **宣言が読めないときは落ちること。** 決め打ちの値へ静かに倒れると、
# このスクリプトが防ごうとしている事故（古い天井で「余裕あり」と言い続ける）を
# 自分で起こす。
missing="${SANDBOX}/no-timeout.tf"
echo 'locals { build_function_name = "x" }' >"$missing"
if bash scripts/build-time-report.sh --explain-threshold --timeout-source "$missing" >/dev/null 2>&1; then
  echo "  FAIL 天井の宣言が無くても通ってしまいます（決め打ちへ倒れています）" >&2
  failed=1
else
  echo "  ok   天井の宣言が読めなければ落ちる"
fi

# **メモリの宣言が読めないときも落ちること。** 天井と同じ理由である（#211）。
# 決め打ちの 10,240 へ倒れると、宣言を動かした日に「別の構成かどうか」が丸ごとずれる。
no_mem="${SANDBOX}/no-memory.tf"
cat >"$no_mem" <<'FIXTURE'
locals {
  build_function_name = "game-forge-build"

  build_function_timeout_seconds = 60
}
FIXTURE
if bash scripts/build-time-report.sh --explain-threshold --timeout-source "$no_mem" >/dev/null 2>&1; then
  echo "  FAIL メモリの宣言が無くても通ってしまいます（決め打ちへ倒れています）" >&2
  failed=1
else
  echo "  ok   メモリの宣言が読めなければ落ちる"
fi

# ── 6. 天井を動かした直後に、過去の完走が「打ち切り」に化けないこと（#211） ──
#
# **2026-08-31 に実際に起きた形をそのまま置く。** メモリを 3,008 → 10,240 MB、天井を
# 45 → 20 秒へ動かした直後、3,008 MB 時代の完走が「打ち切られています」と報告された。
#
# **AWS へは触れない。** --events-file が filter-log-events の応答の形をそのまま受ける
# （--timeout-source と同じ位置づけの口である）。
echo "[selftest] 天井を動かした直後に、過去の完走が打ち切りに化けないこと（#211）"

events="${SANDBOX}/events.json"
base="$(at 2026-08-27T03:00:00Z)000"   # ミリ秒。at() は 3 節で定義済み

# 5 件を置く。**それぞれが 1 つの罠に対応している。**
#
#   1  3008 MB / 10.0 秒          … 普通の完走
#   2  3008 MB / 65.0 秒 / ログ無  … **天井（60 秒）を超えているが打ち切られていない。**
#                                     #211 の核心。ここを打ち切りに数えてはいけない
#   3  3008 MB / 55.0 秒 / ログ有  … **天井より短いが実際に打ち切られた。** 実ログで数える
#   4  3008 MB / 50.0 秒 / ログ有  … 同上。**打ち切りを 2 件にするために置いている**
#   5  1769 MB / 70.0 秒          … 別の構成。判定から外れるが表には残る
#
# **4 が無いと、この検査は「所要 >= 天井」の推測を捕まえられない。** 推測でも実ログでも
# 打ち切りが 1 件になり、数が一致してしまう（実際に変異を当てて緑になることを確かめた）。
# **当てた変異が緑なら、検査の欠陥を疑うこと**（docs/handoff.md 4 章）。
cat >"$events" <<EVENTS
{"events":[
 {"timestamp":${base},"message":"REPORT RequestId: 11111111-1111-4111-8111-111111111111\tDuration: 10000.00 ms\tBilled Duration: 10001 ms\tMemory Size: 3008 MB\tMax Memory Used: 432 MB\tInit Duration: 475.00 ms\t"},
 {"timestamp":${base},"message":"REPORT RequestId: 22222222-2222-4222-8222-222222222222\tDuration: 65000.00 ms\tBilled Duration: 65001 ms\tMemory Size: 3008 MB\tMax Memory Used: 432 MB\t"},
 {"timestamp":${base},"message":"REPORT RequestId: 33333333-3333-4333-8333-333333333333\tDuration: 55000.00 ms\tBilled Duration: 55001 ms\tMemory Size: 3008 MB\tMax Memory Used: 432 MB\t"},
 {"timestamp":${base},"message":"2026-08-27T03:00:03.100Z 33333333-3333-4333-8333-333333333333 Task timed out after 60.00 seconds"},
 {"timestamp":${base},"message":"REPORT RequestId: 55555555-5555-4555-8555-555555555555\tDuration: 50000.00 ms\tBilled Duration: 50001 ms\tMemory Size: 3008 MB\tMax Memory Used: 432 MB\t"},
 {"timestamp":${base},"message":"2026-08-27T03:00:04.100Z 55555555-5555-4555-8555-555555555555 Task timed out after 60.00 seconds"},
 {"timestamp":${base},"message":"REPORT RequestId: 44444444-4444-4444-8444-444444444444\tDuration: 70000.00 ms\tBilled Duration: 70001 ms\tMemory Size: 1769 MB\tMax Memory Used: 423 MB\tInit Duration: 38.90 ms\t"}
]}
EVENTS

# **最終行は判定の綴り**（BUILD_HEADROOM_*）であって JSON ではない。落としてから読む。
btr() {
  bash scripts/build-time-report.sh --events-file "$events" \
    --from 2026-08-27 --to 2026-08-27 --format json "$@" 2>/dev/null | sed '$d'
}

# 宣言が 3,008 MB のとき（= 当時の構成）。
same="$(btr --timeout-source "$fixture")"
if [[ -z "$same" ]]; then
  echo "  FAIL --events-file で集計を取得できません" >&2
  failed=1
else
  expect_eq "判定に使う構成は宣言から読む" "3008" "$(jq -r '.ceiling.memoryMb' <<<"$same")"
  expect_eq "判定の母数は現在の構成の 4 件" "4" "$(jq -r '.totals.calls' <<<"$same")"
  # **これが #211 そのものである。** 65 秒は天井 60 秒を超えているが打ち切られておらず、
  # 55 秒と 50 秒は天井より短いが打ち切られている。**推測なら 1 件、実ログなら 2 件になる。**
  expect_eq "打ち切りは実ログの 2 件（所要 >= 天井 では数えない）" "2" \
    "$(jq -r '.totals.over' <<<"$same")"
  expect_eq "打ち切りのログは 2 行" "2" "$(jq -r '.timedOut.lines' <<<"$same")"
  expect_eq "打ち切りの出所を名乗る" "log:Task timed out" \
    "$(jq -r '.timedOut.countedFrom' <<<"$same")"
  expect_eq "突き合わない打ち切りは 0 件" "0" "$(jq -r '.timedOut.unmatched' <<<"$same")"
  # **外したぶんは消えていない。**
  expect_eq "別の構成の 1 件は表に残る" '[{"memoryMb":1769,"calls":1}]' \
    "$(jq -c '[.excluded.byMemory[] | {memoryMb, calls}]' <<<"$same")"
  if jq -e '.excluded.reason | test("判定から外した")' <<<"$same" >/dev/null; then
    echo "  ok   なぜ外したかが出力に載っている"
  else
    echo "  FAIL なぜ外したかが出力に載っていません" >&2
    failed=1
  fi
fi

# 宣言を 10,240 MB へ動かした直後（= 2026-08-31 に起きた状態）。
# **過去の完走は 1 件も判定に使われず、UNKNOWN で止まる。**
moved_mem="${SANDBOX}/build-function-10240.tf"
sed 's/build_function_memory_mb = 3008/build_function_memory_mb = 10240/' "$fixture" >"$moved_mem"
after_move="$(bash scripts/build-time-report.sh --events-file "$events" \
  --timeout-source "$moved_mem" --from 2026-08-27 --to 2026-08-27 2>/dev/null)"
after_code=$?
expect_eq "現在の構成での呼び出しが 0 件なら UNKNOWN" "2" "$after_code"
expect_eq "その判定の綴り" "BUILD_HEADROOM_UNKNOWN" "$(tail -1 <<<"$after_move")"
if grep -Fq "表からは消していません" <<<"$after_move"; then
  echo "  ok   0 件でも、別の構成での実測は表に残る"
else
  echo "  FAIL 0 件のときに別の構成での実測が消えています" >&2
  failed=1
fi
# **「打ち切られています」と言っていないこと。** #211 が報告した文言そのものを見る。
if grep -Fq "打ち切られています" <<<"$after_move"; then
  echo "  FAIL 過去の完走を「打ち切られています」と報告しています（#211 の再発）" >&2
  failed=1
else
  echo "  ok   過去の完走を打ち切りと呼んでいない"
fi

# ── 7. A/B の読み出しが、既知の行に対して期待どおりに出ること（#238）──────────
#
# **`effortExperimentTotals` は長らくテストからしか呼ばれていなかった**（#238）。
# `scripts/effort-ab-report.sh` がその集計を本番の台帳へ向けて回す道具で、ここでは
# **本番にも認証にも触れずに**（`--rows-file`）、既知の行に対する出力を見る。
#
# **集計そのものは検査していない**（それは test/cost-ledger.test.ts が持つ）。
# ここが見るのは**読み出しの経路**——行の詰め替え、D1 の形をした覆い、束ね方である。
echo "[selftest] A/B の読み出しが既知の行に対して期待どおりに出ること（#238）"

ab_rows="${SANDBOX}/ab-rows.json"
# high 3 本（全部成功・出力が長い）/ medium 3 本（1 本は succeeded=0）。
# **prompt は番号である**（本番から取り出すときも dense_rank へ置き換える。8.2）。
cat >"$ab_rows" <<'ABROWS'
{"generations":[
 {"id":"g1","model":"sonnet-4-6-high","effort":"high","input_tokens":1100,"output_tokens":6000,"cache_creation_input_tokens":0,"cache_read_input_tokens":0,"cost_jpy":20.0,"succeeded":1,"created_at":1788192000,"prompt":1},
 {"id":"g2","model":"sonnet-4-6-high","effort":"high","input_tokens":1100,"output_tokens":6200,"cache_creation_input_tokens":0,"cache_read_input_tokens":0,"cost_jpy":21.0,"succeeded":1,"created_at":1788192600,"prompt":2},
 {"id":"g3","model":"sonnet-4-6-high","effort":"high","input_tokens":1100,"output_tokens":5800,"cache_creation_input_tokens":0,"cache_read_input_tokens":0,"cost_jpy":19.0,"succeeded":1,"created_at":1788193200,"prompt":3},
 {"id":"g4","model":"sonnet-4-6-medium","effort":"medium","input_tokens":1100,"output_tokens":4000,"cache_creation_input_tokens":0,"cache_read_input_tokens":0,"cost_jpy":14.0,"succeeded":1,"created_at":1788193800,"prompt":1},
 {"id":"g5","model":"sonnet-4-6-medium","effort":"medium","input_tokens":1100,"output_tokens":4200,"cache_creation_input_tokens":0,"cache_read_input_tokens":0,"cost_jpy":15.0,"succeeded":1,"created_at":1788194400,"prompt":2},
 {"id":"g6","model":"sonnet-4-6-medium","effort":"medium","input_tokens":1100,"output_tokens":3800,"cache_creation_input_tokens":0,"cache_read_input_tokens":0,"cost_jpy":13.0,"succeeded":0,"created_at":1788195000,"prompt":3}
],"games":[
 {"id":"w1","generation_state":"ready","generation_error":null,"created_at":1788192100},
 {"id":"w2","generation_state":"failed","generation_error":"source-rejected","created_at":1788192200}
]}
ABROWS

ab_json="$(bash scripts/effort-ab-report.sh --rows-file "$ab_rows" \
  --from 2026-09-01 --to 2026-09-01 --format json 2>/dev/null)"
if [[ -z "$ab_json" ]]; then
  echo "  FAIL A/B の読み出しが何も返しません" >&2
  failed=1
else
  expect_eq "群は 2 つに分かれる" '["sonnet-4-6-high","sonnet-4-6-medium"]' \
    "$(jq -c '[.groups[].modelKey] | sort' <<<"$ab_json")"
  expect_eq "high の実コスト" "60" \
    "$(jq -r '.groups[] | select(.modelKey=="sonnet-4-6-high") | .costJpy' <<<"$ab_json")"
  expect_eq "medium の実コスト" "42" \
    "$(jq -r '.groups[] | select(.modelKey=="sonnet-4-6-medium") | .costJpy' <<<"$ab_json")"
  # **succeeded=0 の 1 本は初回完了に数えない。**
  expect_eq "high の初回完了" "3" \
    "$(jq -r '.groups[] | select(.modelKey=="sonnet-4-6-high") | .firstCallCompleted' <<<"$ab_json")"
  expect_eq "medium の初回完了" "2" \
    "$(jq -r '.groups[] | select(.modelKey=="sonnet-4-6-medium") | .firstCallCompleted' <<<"$ab_json")"
  expect_eq "1 呼び出しあたりの出力（high）" "6000" \
    "$(jq -r '.groups[] | select(.modelKey=="sonnet-4-6-high") | .outputTokensPerCall' <<<"$ab_json")"
  # **依頼の切り分けが崩れていないこと。** 1 群の中で文面が重なると立つ。
  expect_eq "曖昧な依頼は 0 件" "0" "$(jq -r '[.groups[].ambiguousJobs] | add' <<<"$ab_json")"
  expect_eq "作品行の内訳も出る" '{"total":2,"byState":{"failed":1,"ready":1},"byError":{"source-rejected":1}}' \
    "$(jq -c '.games' <<<"$ab_json")"
fi

# **本番へ select 以外を送らないこと。**
#
# これは**構造の検査**である（実行時ではない）。`d1 execute` を呼ぶ場所が 1 か所だけで、
# そこが select で始まることを確かめてから送る、という形を見る。**呼び出し場所が増えたら
# ここが落ちる**ので、guard を通らない経路が黙って増えることは無い。
# **綴りを絞る。** `d1 execute` だけだと、コメントに同じ語が入っただけで数が増える
# （この節の説明文がまさにそれである）。**実際の呼び出しの形**で数える。
ab_calls="$(grep -cF 'npx wrangler d1 execute DB --remote --env production' scripts/effort-ab-report.sh || true)"
expect_eq "本番を叩く場所は 1 か所だけ" "1" "$ab_calls"
if grep -Fq 'select で始まらない文は送りません' scripts/effort-ab-report.sh; then
  echo "  ok   select で始まらない文を送らない guard がある"
else
  echo "  FAIL select の guard がありません" >&2
  failed=1
fi

# ── 8. KPI の集計が、既知の行に対して期待どおりに出ること（#42）──────────────
#
# **10.3 の撤退条件はこの集計で判定する。** 判定日に「数えられません」とならないよう、
# 数え方そのものをここで見る。
#
# **見たいのは 1 点に尽きる**——**系統を `status` ではなく `parent_id` で数えているか**。
# 本番には**真ん中が `removed` の 3 世代系統が実在する**（docs/handoff.md 1 章）ので、
# 「公開済みだけ」で数えるとその系統が勘定から消える。**下の行はその形をそのまま作る。**
echo "[selftest] KPI の集計が既知の行に対して期待どおりに出ること（#42）"

KPI_SANDBOX="$(mktemp -d "${TMPDIR:-/tmp}/kpi-selftest.XXXXXX")" || exit 1
trap 'rm -rf "$SANDBOX" "$KPI_SANDBOX"' EXIT

kpi_d1() {
  CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV=false \
    npx wrangler d1 execute DB --local --persist-to "$KPI_SANDBOX" "$@"
}

if ! CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV=false \
     npx wrangler d1 migrations apply DB --local --persist-to "$KPI_SANDBOX" >/dev/null 2>&1; then
  echo "  FAIL KPI 用の使い捨て D1 へマイグレーションを適用できません" >&2
  echo "REPORT_SELFTEST_FAIL"
  exit 1
fi

# 利用者 2 / 作品 4（新規 2・フォーク 2）。**g1 → g2 → g3 が 3 世代で、真ん中の g2 は
# `removed`**。待機リストは fork-cta が 1 件。台帳は 2 呼び出しで計 30 円。
# 推敲は g1 に seq 2 と 3（seq 1 は初回生成なので数えない）。
kpi_d1 --command "
insert into users (id, google_sub, email, display_name, created_at) values
  ('k1','ks1','k1@example.invalid','K1',0), ('k2','ks2','k2@example.invalid','K2',0);
insert into games (id, author_id, parent_id, status, title, go_version, fork_count, created_at) values
  ('kg1','k1',null,'published','root','1.23',1,0),
  ('kg2','k2','kg1','removed','mid','1.23',1,0),
  ('kg3','k1','kg2','published','leaf','1.23',0,0),
  ('kg4','k2',null,'draft','other','1.23',0,0);
insert into waitlist (id, email, source, created_at) values
  ('kw1','kw1@example.invalid','fork-cta',0), ('kw2','kw2@example.invalid','landing',0);
insert into generations (id, game_id, user_id, prompt, model, input_tokens, output_tokens,
  cache_creation_input_tokens, cache_read_input_tokens, cost_jpy, succeeded, created_at) values
  ('kn1',null,'k1','p','m',1,1,0,0,10.0,1,0),
  ('kn2',null,'k1','p','m',1,1,0,0,20.0,0,0);
insert into game_revisions (game_id, seq, source_key, wasm_key, go_version, prompt, created_at) values
  ('kg1',1,'s','w','1.23',null,0), ('kg1',2,'s','w','1.23','fix',0), ('kg1',3,'s','w','1.23','fix2',0);
" >/dev/null 2>&1 || { echo "  FAIL KPI 用の既知の行を入れられません" >&2; failed=1; }

KPI_JSON="$(bash scripts/kpi-report.sh --persist-to "$KPI_SANDBOX" --format json 2>/dev/null)"
if [[ -z "$KPI_JSON" ]]; then
  echo "  FAIL kpi-report.sh が JSON を返しません" >&2
  failed=1
else
  expect_eq "フォーク率 0.5"                "0.5" "$(jq -r '.forkRate.rate' <<<"$KPI_JSON")"
  expect_eq "3 世代以上の系統 1 本"          "1"   "$(jq -r '.deepLineages.count' <<<"$KPI_JSON")"
  expect_eq "最大 3 世代"                    "3"   "$(jq -r '.deepLineages.maxDepth' <<<"$KPI_JSON")"
  expect_eq "招待者あたりの生成数 2"         "2"   "$(jq -r '.generationsPerUser.perUser' <<<"$KPI_JSON")"
  expect_eq "改造 CTA からの登録 1 件"       "1"   "$(jq -r '.forkCtaWaitlist.registrations' <<<"$KPI_JSON")"
  expect_eq "1 生成あたり 15 円"             "15"  "$(jq -r '.costPerGeneration.perCall' <<<"$KPI_JSON")"
  expect_eq "1 作品あたりの推敲 0.5 回"      "0.5" "$(jq -r '.revisionsPerWork.perWork' <<<"$KPI_JSON")"

  # **出せない 2 件は、0 ではなく null で出ること。** 0 を返すと「測って 0 だった」と
  # 読まれる。`docs/handoff.md` 2 章の「測っていない と 測って余裕がある は別」と
  # 同じ線であり、いちばん気づけない壊れ方をここで塞ぐ。
  expect_eq "改造 CTA の登録率は null"       "null" "$(jq -r '.forkCtaWaitlist.conversionRate' <<<"$KPI_JSON")"
  expect_eq "初回コンパイル成功率は null"    "null" "$(jq -r '.firstCompileSuccess.rate' <<<"$KPI_JSON")"
fi

# **この検査が空振りしないことを、変異で独立に確かめる。** 系統の SQL を
# `status = 'published'` で絞ると、上の 3 世代（真ん中が removed）は 0 本になる。
# **0 にならないなら、この検査は「status で数える実装」を通してしまう。**
KPI_MUTANT="$(kpi_d1 --json --command "
with recursive lineage(id, root, depth) as (
    select id, id, 1 from games where parent_id is null and status = 'published'
  union all
    select g.id, lineage.root, lineage.depth + 1
      from games g join lineage on g.parent_id = lineage.id where g.status = 'published'
)
select (select count(*) from (select root from lineage group by root having max(depth) >= 3)) as n
" 2>/dev/null | sed -n '/^\[/,$p' | jq -r '.[0].results[0].n' 2>/dev/null)"
expect_eq "変異（status で絞る）が 0 本になる" "0" "$KPI_MUTANT"

# **本番を叩く場所は 1 か所だけであること**（effort-ab-report.sh と同じ規律）。
kpi_calls="$(grep -cF 'args+=(--remote --env production)' scripts/kpi-report.sh || true)"
expect_eq "本番を叩く場所は 1 か所だけ" "1" "$kpi_calls"
if grep -Fq 'select / with で始まらない文は送りません' scripts/kpi-report.sh; then
  echo "  ok   読み取りのみの guard がある"
else
  echo "  FAIL 読み取りのみの guard がありません" >&2
  failed=1
fi

if (( failed )); then
  echo "REPORT_SELFTEST_FAIL"
  exit 1
fi
echo "REPORT_SELFTEST_PASS"
