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
#    1. 数え方の定義が 1 か所であること（2 つの集計が別々の数え方をしないための担保）
#    2. 日の境界が src/quota.ts / src/cost-ledger.ts と同じであること
#    3. 既知の行に対して、期待どおりの集計が出ること
#    4. モデル別に割っても、合計が変わらないこと（#25 が同じ台帳へ乗れる形）
#    5. ビルド時間の閾値が、天井の宣言から導かれていること（#166 / #164 が動かす値）
#    6. 天井を動かした直後に、過去の完走が「打ち切り」に化けないこと（#211）
#    7. A/B の読み出しが、既知の行に対して期待どおりに出ること（#238）
#    8. KPI の集計が、既知の行に対して期待どおりに出ること（#42）
#       8b. 開始の時刻で絞ることと、生成に失敗した行を外すこと（#456）
#    9. マイグレーションの関門が、未適用を実際に見つけること（#275）
#   10. 撤退条件の判定手順が、実際に使える形であること（#44）
#   11. 審査キューの読み出しが、既知の行に対して正しいこと（#40 / #366 / #394）
#   12. 削除依頼の読み出しと、手順書の整合（#41）
#   13. 参加者の人数と未使用の招待コードの読み出し（#397）
#   14. 配備が、main の HEAD でなくなったコミットで走らないこと（#427）
#   15. R2 のライフサイクルの判定が、宣言の外の削除規則を落とすこと（#380）
#
# **この一覧は下の節見出しの写しである。** 節を足したらここへも足すこと——足し忘れると、
# 冒頭だけを読んだ人が「検査されていない」と思って同じ検査をもう一度書く
# （7 節以降が長らくこの一覧から落ちていた）。
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
#
# **予告どおり 1 件抜けた。** #238 で effort-ab-report.sh が増えたときここへ足されず、
# 検査の網から外れたまま緑で通っていた（#316）。
echo "[selftest] 数え方の定義が 1 か所であること"

CONSUMERS=(scripts/usage-report.sh scripts/build-time-report.sh scripts/effort-ab-report.sh)

for consumer in "${CONSUMERS[@]}"; do
  if [[ ! -f "$consumer" ]]; then
    echo "  FAIL ${consumer} がありません（一覧が実体と食い違っています）" >&2
    failed=1
    continue
  fi
  # **「読んでいる」は source の行で見る。**「ファイルのどこかに report-window.sh と
  # いう字がある」では足りない。消費側 3 本はいずれも冒頭の説明コメントに
  # 「期間の指定・日の境界・日付の綴りは scripts/report-window.sh が持つ」と書いており、
  # **`. "$HERE/report-window.sh"` を丸ごと外しても、その説明文に当たって緑のまま
  # 通っていた**（#324）。保証の記述だけがあって実体が無い状態である。
  #
  # 印は **「行頭（先頭の空白を除く）が `.` または `source` で、その行が
  # report-window.sh を指していること」**。これで足りる理由:
  #   - **コメント行は `#` で始まるので、この錨に当たらない。** 説明文を落とすために
  #     ファイル名や行番号の除外リストを持たずに済む（check-go-version-copies.sh が
  #     除外リストを避けたのと同じ理由——除外リスト自体が写しになって古くなる）。
  #   - 行内コメントで騙せないよう、`#` の手前までで見る。
  #   - 文字列の中の `. "…/report-window.sh"`（`echo` の引数など）は行頭が `echo` に
  #     なるので当たらない。
  #
  # **変数越しの source（`. "$lib"`）は当たらない。これは意図した狭さである。**
  # 3 本とも `. "$HERE/report-window.sh"` と直に書いており、読み手が 1 行で
  # 「定義を共有している」と分かる形を、この検査はあわせて要求する。ここを緩めて
  # 「source という語があること」まで戻すと、またコメントに当たって空振りへ帰る。
  if grep -qE '^[[:space:]]*(\.|source)[[:space:]]+[^#]*report-window\.sh' "$consumer"; then
    echo "  ok   ${consumer} が report-window.sh を source している"
  else
    echo "  FAIL ${consumer} が report-window.sh を source していません" >&2
    echo '       （説明コメントでの言及は数えません。. "$HERE/report-window.sh" の行が要ります）' >&2
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

# **同じ一覧の写しが、利用者に見せるヘルプ本文にもある。** report-window.sh を直接
# 実行すると出る DEFN ブロックの「この定義を使う集計:」がそれで、#316 で CONSUMERS の
# 側だけを直したため effort-ab-report.sh が抜けたまま残り、**機械照合が無いので緑で
# 通っていた**（#324）。shared-ai-rules 12 章「一覧の複製は機械照合で担保する」の適用。
#
# **照合するのはパスの集合だけにする（書式ごと生成はしない）。** ヘルプ本文には
# 説明文が併記されている（「生成回数・成功率・費用（D1 の generations）」等）が、
# あれは利用者向けの散文で、CONSUMERS 側に対応する正本を持たない。書式ごと生成する形に
# すると、その散文を CONSUMERS の隣か この検査へ書き写すことになり、**写しを 1 つ
# 減らすために別の写しを 1 つ作る。** 古くなって困るのは「どれが載っているか」であって、
# 説明文の言い回しではない（言い回しのずれはレビューで足りる）。
#
# **見るのはソースの字面ではなく、実行した出力である。** 利用者が読むのはヘルプの
# 出力なので、そちらを突き合わせる。見出しの綴りが変われば sed が何も拾わず、
# 空の一覧として落ちる——**照合が成立しない状態を緑にしない。**
defn_consumers="$(bash "$HERE/report-window.sh" \
  | sed -n '/この定義を使う集計:/,$p' \
  | grep -oE 'scripts/[A-Za-z0-9._-]+\.sh' | LC_ALL=C sort | tr '\n' ' ')"
expect_eq "report-window.sh のヘルプ本文の一覧が CONSUMERS と一致すること" \
  "$(printf '%s\n' "${CONSUMERS[@]}" | LC_ALL=C sort | tr '\n' ' ')" \
  "$defn_consumers"

# ── 2. 日の境界が src/quota.ts / src/cost-ledger.ts と同じであること ────────
#
# **確定25 は日の境界を JST の 0 時と定めており、日次枠の判定はそこで切っている。**
# 集計だけが UTC で切ると、「枠を使い切った日」と「表に出る日」が 9 時間ずれる。
#
# TypeScript 側の定数は式（9 * 60 * 60）なので、シェルから実行時に引けない。
# **式を読んで計算し、写しと突き合わせる。**
#
# **同じ値の写しは 3 つある**（report-window.sh の値と、TypeScript 側の 2 つ）。
# 片方だけを見ていると、見ていないほうがずれても静かに通る（#315）。
# 実装側の一覧はここが持つ。**同名の定数を増やしたらここへ足す。**
echo "[selftest] 日の境界が src/quota.ts / src/cost-ledger.ts の JST_OFFSET_SECONDS と同じであること"

JST_OFFSET_SOURCES=(src/quota.ts src/cost-ledger.ts)

for source_file in "${JST_OFFSET_SOURCES[@]}"; do
  offset_expr="$(sed -n 's/^const JST_OFFSET_SECONDS = \(.*\);$/\1/p' "$source_file" | head -1)"
  if [[ -z "$offset_expr" ]]; then
    echo "  FAIL ${source_file} から JST_OFFSET_SECONDS を読めません（綴りが変わった可能性）" >&2
    failed=1
    continue
  fi
  offset_seconds=$(( offset_expr ))
  expect_eq "JST オフセット（${source_file} = ${offset_expr}）" \
    "$offset_seconds" "$REPORT_WINDOW_JST_OFFSET_SECONDS"
done

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

# ── 8b. 開始の時刻で絞ることと、生成に失敗した行を外すこと（#456）─────────────
#
# **撤退判定（10.3）は開始の時刻より後に作られた作品で数える。** 開始前の開発・試用の
# 作品が勘定に入ると、「サンプルが無い期間のフォーク率を撤退の根拠に含めない」が崩れる。
# **生成に失敗した行**（`generation_state = 'failed'`）は 10.1 の「作品を生まない試行」
# なので、期間の指定の有無によらず数えない。
#
# **境界はここだけの架空の時刻にする。** 実際の開始の時刻の正本は
# docs/retreat-review.md 1 章の表の 1 か所だけであり、ここへ書き写すと 2 か所になる
# （表の値で実際に回せることは節 10 が見る）。**秒が 0 でない・JST の 0 時でもない**
# 時刻を選んでいるのは、境界を日に丸める変異を赤くするためである。
#
# 仕込み（E = 境界の UNIX 秒。**「より後」は E を含まない**）:
#
#   系統 A  sa1(E-100) → sa2(E-50, removed) → sa3(E+100)   … 根が開始前・3 世代目が開始後 → 数える
#   系統 B  sb1(E-300) → sb2(E-200) → sb3(E-100)            … 3 世代目まで開始前 → 期間を指定すると数えない
#   系統 C  sc1(E-300) → sc2(E+10) → sc3(E+20, failed)      … 3 世代目が failed → 数えない
#   境界    sd1(E ちょうど・新規)、sg1(E ちょうど・sb1 のフォーク) … 数えない
#   開始後  sd2(E+1・新規)、sh1(E+50・新規) → sk1(E+60・フォーク)
#   開始前  sm1(E-400・新規)
#   失敗    se1(E+30・新規・failed)、sf1(E+40・sa1 のフォーク・failed) … 数えない
#
# 期待（期間あり）: 作品 5（フォーク sa3 / sc2 / sk1、新規 sd2 / sh1）→ 0.6。
#                  系統 1 本（A）、根 4（sa1 / sc1 / sd2 / sh1）、最大 3 世代。
# 期待（期間なし）: failed でない 14 作品（フォーク 7 / 新規 7）→ 0.5。
#                  系統 2 本（A / B。C は 3 世代目が failed）、根 7、最大 3 世代。
echo "[selftest] KPI を開始の時刻で絞り、生成に失敗した行を外すこと（#456）"

KPI_SINCE_AT="2031-03-15T21:07:53+09:00"
KPI_SINCE_EPOCH="$(date -u -d "$KPI_SINCE_AT" +%s 2>/dev/null)"
# **wrangler は使い捨ての置き場所ごとに D1 を作る。** 節 8 の仕込みと混ぜないよう、
# KPI_SANDBOX の下に別の置き場所を切る（後始末は KPI_SANDBOX ごと消える）。
KPI_SINCE_SANDBOX="$KPI_SANDBOX/since"
if [[ ! "$KPI_SINCE_EPOCH" =~ ^[0-9]+$ ]]; then
  echo "  FAIL 検査用の境界を UNIX 秒へ写せません: ${KPI_SINCE_AT}" >&2
  failed=1
elif ! mkdir -p "$KPI_SINCE_SANDBOX" || ! CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV=false \
     npx wrangler d1 migrations apply DB --local --persist-to "$KPI_SINCE_SANDBOX" >/dev/null 2>&1; then
  echo "  FAIL #456 用の使い捨て D1 へマイグレーションを適用できません" >&2
  failed=1
else
  E="$KPI_SINCE_EPOCH"
  if ! CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV=false \
       npx wrangler d1 execute DB --local --persist-to "$KPI_SINCE_SANDBOX" --command "
insert into users (id, google_sub, email, display_name, created_at) values
  ('s1','ss1','s1@example.invalid','S1',0);
insert into games (id, author_id, parent_id, status, title, go_version, fork_count, created_at, generation_state) values
  ('sa1','s1',null,'published','a1','1.23',1,$((E-100)),'ready'),
  ('sa2','s1','sa1','removed','a2','1.23',1,$((E-50)),'ready'),
  ('sa3','s1','sa2','published','a3','1.23',0,$((E+100)),'ready'),
  ('sb1','s1',null,'published','b1','1.23',1,$((E-300)),'ready'),
  ('sb2','s1','sb1','published','b2','1.23',1,$((E-200)),'ready'),
  ('sb3','s1','sb2','published','b3','1.23',0,$((E-100)),'ready'),
  ('sc1','s1',null,'published','c1','1.23',1,$((E-300)),'ready'),
  ('sc2','s1','sc1','published','c2','1.23',1,$((E+10)),'ready'),
  ('sc3','s1','sc2','draft','c3','1.23',0,$((E+20)),'failed'),
  ('sd1','s1',null,'published','d1','1.23',0,${E},'ready'),
  ('sg1','s1','sb1','published','g1','1.23',0,${E},'ready'),
  ('sd2','s1',null,'published','d2','1.23',0,$((E+1)),'ready'),
  ('sh1','s1',null,'published','h1','1.23',1,$((E+50)),'ready'),
  ('sk1','s1','sh1','published','k1','1.23',0,$((E+60)),'ready'),
  ('sm1','s1',null,'published','m1','1.23',0,$((E-400)),'ready'),
  ('se1','s1',null,'draft','e1','1.23',0,$((E+30)),'failed'),
  ('sf1','s1','sa1','draft','f1','1.23',0,$((E+40)),'failed');
" >/dev/null 2>&1; then
    echo "  FAIL #456 用の既知の行を入れられません" >&2
    failed=1
  fi

  SINCE_JSON="$(bash scripts/kpi-report.sh --persist-to "$KPI_SINCE_SANDBOX" --since "$KPI_SINCE_AT" --format json 2>/dev/null)"
  ALL_JSON="$(bash scripts/kpi-report.sh --persist-to "$KPI_SINCE_SANDBOX" --format json 2>/dev/null)"
  if [[ -z "$SINCE_JSON" || -z "$ALL_JSON" ]]; then
    echo "  FAIL kpi-report.sh が JSON を返しません（#456 の仕込み）" >&2
    failed=1
  else
    # **4 つの数を 1 行に束ねて比べる。** 率だけを見ると、分子と分母が同じ比で崩れた
    # ときに緑のまま通る（期間なしの 0.5 は、失敗の行を数えても境界を外しても作れる）。
    kpi_fork_row() { jq -r '[.forkRate.forkGames, .forkRate.newGames, .forkRate.totalGames, .forkRate.rate] | map(tostring) | join(" ")' <<<"$1"; }
    kpi_lineage_row() { jq -r '[.deepLineages.count, .deepLineages.roots, .deepLineages.maxDepth] | map(tostring) | join(" ")' <<<"$1"; }

    expect_eq "期間あり: フォーク率は開始より後の failed でない作品だけ（フォーク 新規 全 率）" \
      "3 2 5 0.6" "$(kpi_fork_row "$SINCE_JSON")"
    expect_eq "期間あり: 系統は根が開始前でも数え、3 世代目まで開始前・3 世代目が failed は数えない（本数 根 最大）" \
      "1 4 3" "$(kpi_lineage_row "$SINCE_JSON")"
    expect_eq "期間あり: 出力に境界の UNIX 秒が載る（date で独立に写した値と一致）" \
      "$KPI_SINCE_EPOCH" "$(jq -r '.since.epoch' <<<"$SINCE_JSON")"

    expect_eq "期間なし: failed を外したことを除き全期間（フォーク 新規 全 率）" \
      "7 7 14 0.5" "$(kpi_fork_row "$ALL_JSON")"
    expect_eq "期間なし: 系統は全期間で、3 世代目が failed の系統だけを数えない（本数 根 最大）" \
      "2 7 3" "$(kpi_lineage_row "$ALL_JSON")"
    expect_eq "期間なし: 出力の since は null" "null" "$(jq -r '.since' <<<"$ALL_JSON")"

    # **期間なしは「failed を外したこと以外は変わらない」こと。** 変える前の SQL
    # （#42 のまま。全行を数え、根は parent_id が NULL の全行）を、**failed の行を除いた
    # 同じ台帳の写し**に当てて、kpi-report.sh の期間なしの出力と突き合わせる。
    # 写しは節 8 の置き場所とも分けて、元の仕込みを壊さない。
    KPI_SINCE_COPY="$KPI_SANDBOX/since-copy"
    if cp -R "$KPI_SINCE_SANDBOX" "$KPI_SINCE_COPY" 2>/dev/null \
       && CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV=false \
          npx wrangler d1 execute DB --local --persist-to "$KPI_SINCE_COPY" \
          --command "delete from games where generation_state = 'failed'" >/dev/null 2>&1; then
      kpi_legacy() {
        CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV=false \
          npx wrangler d1 execute DB --local --persist-to "$KPI_SINCE_COPY" --json --command "$1" 2>/dev/null \
          | sed -n '/^\[/,$p' | jq -r '.[0].results[0] | map(tostring) | join(" ")' 2>/dev/null
      }
      legacy_fork="$(kpi_legacy "select sum(case when parent_id is not null then 1 else 0 end) as f,
        sum(case when parent_id is null then 1 else 0 end) as n, count(*) as t from games")"
      legacy_lineage="$(kpi_legacy "with recursive lineage(id, root, depth) as (
          select id, id, 1 from games where parent_id is null
        union all
          select g.id, lineage.root, lineage.depth + 1 from games g join lineage on g.parent_id = lineage.id
      )
      select (select count(*) from (select root from lineage group by root having max(depth) >= 3)) as d,
        (select count(distinct root) from lineage) as r, (select max(depth) from lineage) as m")"
      expect_eq "期間なし: 変える前の SQL を failed を除いた台帳へ当てた数と一致する（フォーク率）" \
        "$legacy_fork" "$(jq -r '[.forkRate.forkGames, .forkRate.newGames, .forkRate.totalGames] | map(tostring) | join(" ")' <<<"$ALL_JSON")"
      expect_eq "期間なし: 変える前の SQL を failed を除いた台帳へ当てた数と一致する（系統）" \
        "$legacy_lineage" "$(kpi_lineage_row "$ALL_JSON")"
    else
      echo "  FAIL 変える前の SQL と突き合わせる写しを作れません" >&2
      failed=1
    fi
  fi
fi

# **仕込みが空振りしないこと。** 失敗の行を外さず、期間でも絞らない数え方（#42 の
# まま）では、同じ台帳から別の数が出ることを独立に確かめる。**同じ数が出るなら、上の
# 検査は「何も変えていない実装」を通してしまう。**
if [[ -d "$KPI_SINCE_SANDBOX" ]]; then
  KPI_SINCE_MUTANT="$(CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV=false \
    npx wrangler d1 execute DB --local --persist-to "$KPI_SINCE_SANDBOX" --json \
    --command "select sum(case when parent_id is not null then 1 else 0 end) as f, count(*) as t from games" 2>/dev/null \
    | sed -n '/^\[/,$p' | jq -r '.[0].results[0] | "\(.f) \(.t)"' 2>/dev/null)"
  expect_eq "変異（failed も全期間も数える）ではフォーク 9 / 全 17 になる" "9 17" "$KPI_SINCE_MUTANT"
fi

# **--since は時差つきの秒までの時刻だけを受け付けること。** 日付だけを受け付けると
# 日に丸めることになり、時差の無い時刻は UTC か JST かが読み手で変わる。存在しない
# 日時を翌月へ繰り越すと、打ち間違えた境界で数えたことに気づけない。**D1 に触る前に
# 2 で落ちる**ので、仕込みの有無によらず見られる。
# **同じ瞬間を別の時差で綴っても、同じ境界になること。** `Z` と負の時差の分岐は、
# 撤退判定の +09:00 だけでは通らない。**UTC では前の年の大晦日になる瞬間**を選び、
# 月と年の繰り下がり（1 月を前年の 13 月として数える箇所）も通す。期待値は
# `date -u -d` で独立に求める。
KPI_SPELL_REF="2031-01-01T02:07:53+09:00"
KPI_SPELL_EPOCH="$(date -u -d "$KPI_SPELL_REF" +%s 2>/dev/null)"
for spelled in "$KPI_SPELL_REF" 2030-12-31T17:07:53Z 2030-12-31T12:07:53-05:00 2030-12-31T22:37:53+05:30; do
  expect_eq "--since ${spelled} の綴りを date で写すと基準と同じ瞬間（仕込みの検算）" \
    "$KPI_SPELL_EPOCH" "$(date -u -d "$spelled" +%s 2>/dev/null)"
  expect_eq "--since ${spelled} の境界の UNIX 秒が date で求めた値と一致する" "$KPI_SPELL_EPOCH" \
    "$(bash scripts/kpi-report.sh --persist-to "$KPI_SANDBOX" --since "$spelled" --format json 2>/dev/null | jq -r '.since.epoch' 2>/dev/null)"
done

for bad_since in "" 2031-03-15 2031-03-15T21:07:53 "2031-03-15 21:07:53+09:00" 2031-02-29T00:00:00+09:00 2031-03-15T24:00:00+09:00; do
  bash scripts/kpi-report.sh --persist-to "$KPI_SANDBOX" --since "$bad_since" --format json >/dev/null 2>&1
  bad_code=$?
  expect_eq "--since ${bad_since:-（空の値）} は 2 で落ちる" "2" "$bad_code"
done

# **値の無いオプションで止まらないこと（3 本すべて）。**
#
# `shift 2` は残りが 1 個のとき**シフトせずに失敗する**。`set -e` を使っていないので
# そのまま次の周回へ進み、`while [[ $# -gt 0 ]]` が同じ引数を読み続けて無限ループになる。
# **この壊れ方は「赤くならずに止まる」ので、ふつうの検査では見えない。** 見張りを立てて
# 打ち切る（`timeout` は GNU 拡張なので使わない。macOS の bash 3.2 に無い）。
run_bounded() {
  local seconds="$1"; shift
  "$@" >/dev/null 2>&1 &
  local pid=$!
  ( sleep "$seconds"; kill -9 "$pid" 2>/dev/null ) >/dev/null 2>&1 &
  local watchdog=$!
  wait "$pid" 2>/dev/null
  local code=$?
  kill "$watchdog" 2>/dev/null
  wait "$watchdog" 2>/dev/null
  return "$code"
}

##
# 値の無いオプションで、止まらずに 2 で落ちることを見る。
#
# @param $1 スクリプトのパス
# @param $2 引数の綴り
##
expect_missing_value_exits() {
  run_bounded 10 bash "$1" "$2"
  local code=$?
  local label="$(basename "$1") $2"
  if [[ "$code" -eq 2 ]]; then
    echo "  ok   ${label} に値が無ければ 2 で落ちる"
  elif [[ "$code" -eq 137 ]]; then
    echo "  FAIL ${label} に値が無いと止まりません（無限ループ）" >&2
    failed=1
  else
    echo "  FAIL ${label} に値が無いときの終了コードが 2 ではありません: ${code}" >&2
    failed=1
  fi
}

# **3 本まとめて見る。** 同じ形の不具合が 3 本にあった（kpi-report.sh は #42 の PR で
# Copilot が見つけ、残る 2 本はそれを受けて確かめたら同じだった）。**1 本だけ直すと、
# 次に同じ形を書いた日にまた入る。**
for missing in --format --persist-to --since; do
  expect_missing_value_exits scripts/kpi-report.sh "$missing"
done
for missing in --format --rows-file; do
  expect_missing_value_exits scripts/ogp-stale-report.sh "$missing"
done
for missing in --format --rows-file --days --from --to; do
  expect_missing_value_exits scripts/effort-ab-report.sh "$missing"
done

# **本番を叩く場所は 1 か所だけであること**（effort-ab-report.sh と同じ規律）。
kpi_calls="$(grep -cF 'args+=(--remote --env production)' scripts/kpi-report.sh || true)"
expect_eq "本番を叩く場所は 1 か所だけ" "1" "$kpi_calls"
if grep -Fq 'select / with で始まらない文は送りません' scripts/kpi-report.sh; then
  echo "  ok   読み取りのみの guard がある"
else
  echo "  FAIL 読み取りのみの guard がありません" >&2
  failed=1
fi

# ── 9. マイグレーションの関門が、未適用を実際に見つけること（#275）──────────
#
# **2026-09-03 に、これが無くて本番を約 10 分壊した。** 関門そのものが空振りしていたら
# 意味が無いので、**未適用が有る D1 と無い D1 の両方**に当てて、合図が分かれることを見る。
echo "[selftest] マイグレーションの関門（#275）"

MIG_SANDBOX="$(mktemp -d "${TMPDIR:-/tmp}/mig-selftest.XXXXXX")" || exit 1
trap 'rm -rf "$SANDBOX" "$KPI_SANDBOX" "$MIG_SANDBOX"' EXIT

# 空の D1（＝全件が未適用）。
mig_out="$(bash scripts/check-migrations-applied.sh --persist-to "$MIG_SANDBOX" 2>&1)"
mig_code=$?
if [[ "$mig_code" -eq 1 ]] && printf '%s\n' "$mig_out" | grep -q '^MIGRATIONS_PENDING$'; then
  echo "  ok   未適用が有れば 1 で落ちる"
else
  echo "  FAIL 未適用が有るのに止まりません（code=${mig_code}）" >&2
  failed=1
fi
# **名前が出力に載ること。** 「有る」とだけ言われても、何を当てるのかが分からない。
if printf '%s\n' "$mig_out" | grep -q '0001_init\.sql'; then
  echo "  ok   未適用の名前が出力に載る"
else
  echo "  FAIL 未適用の名前が出力に載りません" >&2
  failed=1
fi
# **実行すべきコマンドが載ること。**
if printf '%s\n' "$mig_out" | grep -q 'migrations apply DB --remote'; then
  echo "  ok   実行すべきコマンドが出力に載る"
else
  echo "  FAIL 実行すべきコマンドが出力に載りません" >&2
  failed=1
fi

# 適用してから、同じ D1 に当て直す。
if ! CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV=false \
     npx wrangler d1 migrations apply DB --local --persist-to "$MIG_SANDBOX" >/dev/null 2>&1; then
  echo "  FAIL 関門用の使い捨て D1 へマイグレーションを適用できません" >&2
  failed=1
else
  mig_out="$(bash scripts/check-migrations-applied.sh --persist-to "$MIG_SANDBOX" 2>&1)"
  mig_code=$?
  if [[ "$mig_code" -eq 0 ]] && printf '%s\n' "$mig_out" | grep -q '^MIGRATIONS_APPLIED$'; then
    echo "  ok   未適用が無ければ 0 で通る"
  else
    echo "  FAIL 未適用が無いのに通りません（code=${mig_code}）" >&2
    failed=1
  fi
fi

# **「判定できなかった」を「無い」に倒さないこと。** 合図の綴りを両方とも探している
# ことを、本文で機械照合する（#263 の関門と同じ規律）。
for mark in 'No migrations to apply' 'Migrations to be applied'; do
  if grep -qF "$mark" scripts/check-migrations-applied.sh; then
    echo "  ok   合図「${mark}」を明示的に探している"
  else
    echo "  FAIL 合図「${mark}」を探していません" >&2
    failed=1
  fi
done

# **配備の前に置かれていること。** 後ろにあると、壊れた Worker が出てから止まる。
gate_line="$(grep -n '未適用のマイグレーションが無いこと' .github/workflows/verify.yml | head -1 | cut -d: -f1)"
deploy_line="$(grep -n 'name: Deploy to Cloudflare Pages' .github/workflows/verify.yml | head -1 | cut -d: -f1)"
if [[ -n "$gate_line" && -n "$deploy_line" && "$gate_line" -lt "$deploy_line" ]]; then
  echo "  ok   関門が Pages 配備より前にある"
else
  echo "  FAIL 関門が Pages 配備より前にありません（gate=${gate_line} deploy=${deploy_line}）" >&2
  failed=1
fi

# ── 10. 撤退条件の判定手順が、実際に使える形であること（#44）────────────────
#
# **10.3 は「決めていない状態のみが危険」と書いている。** 手順書があっても、指す先が
# 変わっていれば判定日に使えない。**指している場所が実在することを機械で見る。**
echo "[selftest] 撤退条件の判定手順（#44）"

RETREAT_DOC="docs/retreat-review.md"
if [[ -f "$RETREAT_DOC" ]]; then
  echo "  ok   ${RETREAT_DOC} がある"
else
  echo "  FAIL ${RETREAT_DOC} がありません" >&2
  failed=1
fi

# **手順が指す jq のパスが、集計の出力に実在すること。**
# 手順書が `.forkRate.rate` を読めと言っているのに、集計がその名前を出さなくなったら、
# **判定日に初めて気づく。** 手順書と集計の両方から取り出して突き合わせる。
for path in '.forkRate.rate' '.deepLineages.count'; do
  if ! grep -qF "$path" "$RETREAT_DOC" 2>/dev/null; then
    echo "  FAIL 手順書が ${path} を指していません" >&2
    failed=1
    continue
  fi
  # 集計側の出力に同じ鍵があるか（`--persist-to` の空 D1 では引けないので、
  # 既知の行を入れた KPI 用の使い捨て D1 を借りる）。
  #
  # **`jq -e` の終了コードで見る。出力の中身で見ない。** 鍵が無いとき `jq` は
  # **文字列 `null` を出力する**ので、`[[ -n "$out" ]]` は真になる——**鍵を消しても
  # 緑のままだった**（この検査を書いた直後に変異で踏んだ）。`-e` は最後の値が
  # `null` / `false` なら 1 を返すので、そちらを見る。
  #
  # **`0` は偽にならない**（`jq -e` が 1 を返すのは `null` と `false` だけ）ので、
  # 3 世代の本数が 0 本でもこの検査は通る。
  if bash scripts/kpi-report.sh --persist-to "$KPI_SANDBOX" --format json 2>/dev/null \
     | jq -e "${path}" >/dev/null 2>&1; then
    echo "  ok   集計の出力に ${path} がある"
  else
    echo "  FAIL 集計の出力に ${path} がありません（手順書が指す先が消えています）" >&2
    failed=1
  fi
done

# **判定日の欄が空のまま埋もれないこと。** 空欄そのものは正しい状態（M7 未完了）だが、
# **「未確定」と書いてあることが、埋めるべき場所だという合図になる。**
if grep -q '未確定' "$RETREAT_DOC" 2>/dev/null; then
  echo "  ok   判定日が未確定であることが明示されている"
else
  echo "  ok   判定日が記入済み（未確定の表記が消えている）"
fi

# **閾値の数値が手順書に 1 度しか現れないこと。**
#
# 2 か所に置くと、10.3 が基準を緩めた日に片方が古くなる。**緩めるのは 10.3 が明示的に
# 許している操作**なので、起こる前提で置き場を 1 つにする。
#
# **判定コマンドの中には現れてよい**——そこは実行するものであり、値が無いと動かない。
# 散文は 10.3 を指すだけにする。
#
# **この検査は、最初に書いたとき見つけても `failed` を立てていなかった**（Copilot の
# 指摘で気づいた）。**説明と逆のことをする検査は、無いより悪い**——「複製していない
# ことを見ている」と読まれたまま、複製が通る。
threshold_hits="$(grep -cE '0\.40|40 ?%' "$RETREAT_DOC" 2>/dev/null || true)"
if [[ "$threshold_hits" -eq 1 ]]; then
  echo "  ok   閾値の数値は 1 度だけ現れる（判定コマンドの中）"
else
  echo "  FAIL 閾値の数値が ${threshold_hits} 回現れます（判定コマンドの 1 度だけにしてください）" >&2
  grep -nE '0\.40|40 ?%' "$RETREAT_DOC" >&2
  failed=1
fi
# **その 1 度が判定コマンドの中であること。** 散文に 1 度だけ書いても上は通る。
if grep -E '0\.40|40 ?%' "$RETREAT_DOC" 2>/dev/null | grep -q 'forkRate'; then
  echo "  ok   その 1 度は判定コマンドの中にある"
else
  echo "  FAIL 閾値の数値が判定コマンドの外にあります" >&2
  failed=1
fi

# **開始の時刻が 1 か所にだけあり、2.1 のコマンドがそれを渡していること（#456）。**
#
# 2 か所に置くと、片方だけを直した日に判定が古い境界で数えられる。**値そのものは
# ここへ書き写さない**——表の行から取り出し、その値がリポジトリの追跡ファイルの
# どこに現れるかを数える。
#
# **手順書の行を実行しない**（PR #468 の Copilot の指摘）。追跡している Markdown の
# 1 行を eval すると、文書が CI の中で実行元になる。代わりに、2.1 の `since=` の行が
# **下に置いた期待のコマンドの文面と 1 字違わず一致すること**を見て、値はここの
# 正規表現で表から取り出す。**期待の文面はコマンドであって値ではない**ので、ここに
# 置いても開始の時刻の写しにはならない。
if grep -q '未解決' "$RETREAT_DOC" 2>/dev/null; then
  echo "  FAIL 手順書に「未解決」の注記が残っています（#456 で解消したはずです）" >&2
  grep -n '未解決' "$RETREAT_DOC" >&2
  failed=1
else
  echo "  ok   手順書に「未解決」の注記が残っていない"
fi

since_lines="$(grep -cE '^since=' "$RETREAT_DOC" 2>/dev/null || true)"
expect_eq "2.1 に開始の時刻を表から読む行が 1 行だけある" "1" "$since_lines"

# 表から時差つきの時刻を取り出す正規表現。2.1 の期待の文面もこれを使う。
SINCE_VALUE_RE='[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[+-][0-9]{2}:[0-9]{2}'
SINCE_ROW_RE='^\| 開始（M7 完了の時刻'
IFS= read -r SINCE_CMD_EXPECTED <<'SINCE_CMD'
since="$(grep -E '^\| 開始（M7 完了の時刻' docs/retreat-review.md | grep -oE '[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[+-][0-9]{2}:[0-9]{2}')"
SINCE_CMD
since_cmd_hits="$(grep -cxF -- "$SINCE_CMD_EXPECTED" "$RETREAT_DOC" 2>/dev/null || true)"
expect_eq "2.1 の since= の行が期待のコマンドの文面と完全に一致する" "1" "$since_cmd_hits"
if grep -F 'bash scripts/kpi-report.sh --remote' "$RETREAT_DOC" 2>/dev/null | grep -qF -- '--since "$since"'; then
  echo "  ok   2.1 の kpi-report.sh が --since で開始の時刻を渡している"
else
  echo "  FAIL 2.1 の kpi-report.sh が --since で開始の時刻を渡していません" >&2
  failed=1
fi

# 値は表の行からここで取り出す（手順書の行は実行しない）。**行が 1 つ・値が 1 つ**で
# なければ空にして下で落とす（複数の値を黙って 1 つ目で済ませない）。
doc_since=""
since_rows="$(grep -cE "$SINCE_ROW_RE" "$RETREAT_DOC" 2>/dev/null || true)"
if [[ "$since_rows" -eq 1 ]]; then
  doc_since_values="$(grep -E "$SINCE_ROW_RE" "$RETREAT_DOC" | grep -oE "$SINCE_VALUE_RE")"
  if [[ "$(printf '%s\n' "$doc_since_values" | grep -c .)" -eq 1 ]]; then
    doc_since="$doc_since_values"
  fi
fi
doc_since_epoch="$(date -u -d "$doc_since" +%s 2>/dev/null || true)"
if [[ "$doc_since" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[+-][0-9]{2}:[0-9]{2}$ \
      && "$doc_since_epoch" =~ ^[0-9]+$ ]]; then
  echo "  ok   表の開始の行から時差つきの時刻を 1 つ取り出せる"

  # **追跡ファイルのどこに現れるか**を、綴りを変えて 3 通りで数える。時刻の部分
  # （HH:MM:SS）で数えるのは、「YYYY-MM-DD HH:MM:SS JST」のように散文へ別の綴りで
  # 書き写したものも拾うためである。UNIX 秒は、スクリプトへ写したものを拾う。
  for needle in "$doc_since" "${doc_since:11:8}" "$doc_since_epoch"; do
    hits="$(git grep -lF -- "$needle" 2>/dev/null | tr '\n' ' ' | sed 's/ $//')"
    if [[ "$needle" == "$doc_since_epoch" ]]; then
      expect_eq "開始の時刻の UNIX 秒はどの追跡ファイルにも無い" "" "$hits"
    else
      expect_eq "開始の時刻（${#needle} 文字の綴り）は ${RETREAT_DOC} にだけある" "$RETREAT_DOC" "$hits"
      count="$(grep -cF -- "$needle" "$RETREAT_DOC" 2>/dev/null || true)"
      expect_eq "開始の時刻（${#needle} 文字の綴り）は ${RETREAT_DOC} の 1 行にだけある" "1" "$count"
    fi
  done

  # **表の値で実際に回せること。** 形は合っても kpi-report.sh が受け付けない値だと、
  # 判定日に初めて 2 で落ちる。境界の UNIX 秒は date で独立に写した値と突き合わせる。
  expect_eq "表の値を kpi-report.sh へ渡すと、境界が date で写した値と一致する" "$doc_since_epoch" \
    "$(bash scripts/kpi-report.sh --persist-to "$KPI_SANDBOX" --since "$doc_since" --format json 2>/dev/null | jq -r '.since.epoch' 2>/dev/null)"
else
  echo "  FAIL 表の開始の行から時差つきの時刻を 1 つに取り出せません（取り出した値: ${doc_since:-（空）}）" >&2
  failed=1
fi


# ── 11. 審査キューの読み出しが、既知の行に対して正しいこと（#40 / #366 / #394）
echo "[selftest] 審査キューの読み出し（#40 / #366 / #394）"

QUEUE_SANDBOX="$(mktemp -d "${TMPDIR:-/tmp}/queue-selftest.XXXXXX")" || exit 1
trap 'rm -rf "$SANDBOX" "$KPI_SANDBOX" "$MIG_SANDBOX" "$QUEUE_SANDBOX"' EXIT

if ! CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV=false \
     npx wrangler d1 migrations apply DB --local --persist-to "$QUEUE_SANDBOX" >/dev/null 2>&1; then
  echo "  FAIL キュー用の使い捨て D1 へマイグレーションを適用できません" >&2
  failed=1
else
  # 審査待ち 1 件（qg1）、通報なし（qg2）。
  #
  # **#394 で基準を「最後の改名」から「最後に `cleared` にした時刻」（`admin_actions` の
  # `review-cleared`）へ変えた。** 対になる行を置く。
  #
  #   qg3 … 通報（50）→ `cleared`（60）。**見終えた作品**（出ない。#394 の (a)）
  #   qg4 … `cleared`（250）→ 改名（200 は `cleared` より前）→ 通報（300）（出る。(b)）
  #   qg5 … 通報（10）→ 改名（400）→ `cleared`（450）。**改名のあとに見終えた**（出ない。
  #         #366 の条件でも出なかった形。改名の時刻が基準でなくなっても出ないこと）
  #   qg6 … `cleared` と通報が**同じ秒**（500）（出る。`>` で書くとここが落ちる）
  #   qg7 … **履歴の無い `cleared`**（#361 より前に端末で `cleared` にした作品）に通報（20）
  #         （出る。**黙って落とさない**。`src/reports.ts` の但し書き）
  #   qg8 … 通報（100）→ `cleared`（150）→ 改名（160）→ 通報（170）→ `cleared`（180）。
  #         **issue #394 の再現そのもの**（#366 の条件では出続けた。出ない）
  #   qg9 … **別の作品の `cleared` の時刻を借りない**こと。自分の履歴は無く、
  #         qg3 の `cleared`（60）より前の通報（40）を持つ（出る。qg7 と同じ扱い）
  CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV=false \
    npx wrangler d1 execute DB --local --persist-to "$QUEUE_SANDBOX" --command "
  insert into users (id, google_sub, email, display_name, created_at) values
    ('qa','sqa','a@example.invalid','A',0), ('qb','sqb','b@example.invalid','B',0),
    ('qc','sqc','c@example.invalid','C',0);
  insert into games (id, author_id, status, title, go_version, created_at, review_state) values
    ('qg1','qa','published','t1','1.23',0,'queued'),
    ('qg2','qa','published','t2','1.23',0,null),
    ('qg3','qa','published','t3','1.23',0,'cleared'),
    ('qg4','qa','published','t4','1.23',0,'cleared'),
    ('qg5','qa','published','t5','1.23',0,'cleared'),
    ('qg6','qa','published','t6','1.23',0,'cleared'),
    ('qg7','qa','published','t7','1.23',0,'cleared'),
    ('qg8','qa','published','t8','1.23',0,'cleared'),
    ('qg9','qa','published','t9','1.23',0,'cleared');
  insert into reports (id, game_id, reporter_id, reason, created_at) values
    ('r1','qg1','qb','ひどい',100), ('r2','qg3','qb','',50),
    ('r4','qg4','qb','cleared 後の通報',300), ('r5','qg5','qb','改名前の通報',10),
    ('r6','qg6','qb','同じ秒の通報',500), ('r7','qg7','qb','履歴の無い cleared',20),
    ('r8a','qg8','qb','最初の通報',100), ('r8b','qg8','qc','改名後の通報',170),
    ('r9','qg9','qb','別の作品の cleared より前',40);
  insert into title_changes (id, game_id, old_title, new_title, changed_at) values
    ('c4','qg4','t4-old','t4',200),
    ('c5','qg5','t5-old','t5',400),
    ('c8','qg8','t8-old','t8',160);
  insert into admin_actions (id, actor_id, created_at, action, target_kind, target_id, reason) values
    ('a3','qa',60,'review-cleared','game','qg3','見た'),
    ('a4','qa',250,'review-cleared','game','qg4','見た'),
    ('a5','qa',450,'review-cleared','game','qg5','見た'),
    ('a6','qa',500,'review-cleared','game','qg6','見た'),
    ('a8a','qa',150,'review-cleared','game','qg8','見た'),
    ('a8b','qa',175,'review-queued','game','qg8','改名後の通報'),
    ('a8c','qa',180,'review-cleared','game','qg8','改名後も問題なし');
  " >/dev/null 2>&1 || { echo "  FAIL キュー用の既知の行を入れられません" >&2; failed=1; }

  queue_json="$(bash scripts/report-queue.sh --persist-to "$QUEUE_SANDBOX" --format json 2>/dev/null)"
  queue_code=$?
  expect_eq "見るべき作品が有れば 1 で落ちる" "1" "$queue_code"
  # **集合で見る**（並びは最終通報の降順。qg6（500）→ qg4（300）→ qg1（100）→ qg9（40）→ qg7（20））。
  expect_eq "出るのは 5 件"                   "5" "$(jq -r '.count' <<<"$queue_json")"
  expect_eq "出る作品と並び" \
    "qg6 qg4 qg1 qg9 qg7" "$(jq -r '[.rows[].game_id] | join(" ")' <<<"$queue_json")"
  expect_eq "cleared と同じ秒の通報が出る" \
    "qg6" "$(jq -r '.rows[0].game_id' <<<"$queue_json")"
  expect_eq "cleared の後に通報が付いた作品が出る" \
    "qg4" "$(jq -r '.rows[1].game_id' <<<"$queue_json")"
  expect_eq "その行は cleared として出る" \
    "cleared" "$(jq -r '.rows[1].review_state' <<<"$queue_json")"
  expect_eq "最後の改名の時刻が出る"      "200" "$(jq -r '.rows[1].last_rename' <<<"$queue_json")"
  expect_eq "審査待ちも出る"              "qg1" "$(jq -r '.rows[2].game_id' <<<"$queue_json")"
  expect_eq "通報者の数が出る"            "1" "$(jq -r '.rows[2].reporters' <<<"$queue_json")"
  expect_eq "履歴の無い cleared は通報があれば出る（#361 より前）" \
    "qg7" "$(jq -r '.rows[] | select(.game_id == "qg7") | .game_id' <<<"$queue_json")"
  # **出てはいけないものを名指しで見る。** 件数だけでは、別の行が紛れても気づけない。
  expect_eq "見終えた cleared は出ない" \
    "" "$(jq -r '.rows[] | select(.game_id == "qg3") | .game_id' <<<"$queue_json")"
  expect_eq "改名のあとに見終えた cleared は出ない" \
    "" "$(jq -r '.rows[] | select(.game_id == "qg5") | .game_id' <<<"$queue_json")"
  expect_eq "改名後の通報を見て cleared にし直した作品は出ない（#394）" \
    "" "$(jq -r '.rows[] | select(.game_id == "qg8") | .game_id' <<<"$queue_json")"

  # **外枠は「出うる状態の一覧」である**（#366。単数の `reviewState` は意味が変わった
  # ので消した。PR #391 の Copilot レビュー）。
  expect_eq "外枠に出うる状態が 2 つ並ぶ" \
    "queued cleared" "$(jq -r '.reviewStates | join(" ")' <<<"$queue_json")"
  expect_eq "意味の変わった単数の鍵は残っていない" \
    "null" "$(jq -r '.reviewState // "null"' <<<"$queue_json")"

  # **旧題名も新題名も持ち出さないこと**（0027 のとおり UGC である）。
  if jq -e '.rows[0] | has("old_title") or has("new_title")' <<<"$queue_json" >/dev/null 2>&1; then
    echo "  FAIL 改名の題名が出力に載っています（UGC を持ち出さない）" >&2
    failed=1
  else
    echo "  ok   改名の題名は出力に載らない"
  fi

  # **題名も理由も持ち出さないこと**（8.2 / 8.3）。運用が最初に要るのは「どれを見るか」
  # だけで、中身は作品ページに権限の判定がある。
  if jq -e '.rows[0] | has("title") or has("reason")' <<<"$queue_json" >/dev/null 2>&1; then
    echo "  FAIL 題名か理由が出力に載っています（UGC を持ち出さない）" >&2
    failed=1
  else
    echo "  ok   題名も理由も出力に載らない"
  fi

  # 空にすると 0 で通る。**両方の理由を消す**（#366 で 2 種類になったので、片方を
  # 消しただけでは 0 にならない）。
  CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV=false \
    npx wrangler d1 execute DB --local --persist-to "$QUEUE_SANDBOX" \
    --command "update games set review_state = null where id in ('qg1','qg4','qg6','qg7','qg9')" >/dev/null 2>&1
  run_bounded 60 bash scripts/report-queue.sh --persist-to "$QUEUE_SANDBOX"
  expect_eq "見るべき作品が無ければ 0 で通る" "0" "$?"
fi

# **綴りを書き写していないこと。** src/reports.ts から取り出しているか本文で見る。
if grep -q 'REVIEW_QUEUED' scripts/report-queue.sh; then
  echo "  ok   審査待ちの綴りを src/reports.ts から取り出している"
else
  echo "  FAIL 審査待ちの綴りを書き写しています" >&2
  failed=1
fi

# **問題なしのあとの通報の条件も書き写していないこと**（#366 / #394）。**admin 画面（#367）が
# 同じ定数を借りる**ので、片方だけが古くなる形をここで止める。
if grep -q 'REVIEW_REPORTED_AFTER_CLEAR_SQL' scripts/report-queue.sh; then
  echo "  ok   問題なしのあとの通報の条件を src/reports.ts から取り出している"
else
  echo "  FAIL 条件を書き写しています（src/reports.ts の REVIEW_REPORTED_AFTER_CLEAR_SQL を使ってください）" >&2
  failed=1
fi
# **取り出せることそのものを見る。** 定数の書き方（改行位置・引用符）が変わると、
# スクリプトは exit 2 で落ちるが、**その落ち方はこの節の外で起きうる。**
if [[ -n "$(awk '
  /^export const REVIEW_REPORTED_AFTER_CLEAR_SQL/ { found = 1 }
  found && /"/ { line = $0; sub(/^[^"]*"/, "", line); sub(/";?[[:space:]]*$/, "", line); print line; exit }
' src/reports.ts)" ]]; then
  echo "  ok   REVIEW_REPORTED_AFTER_CLEAR_SQL を 1 行の文字列として取り出せる"
else
  echo "  FAIL REVIEW_REPORTED_AFTER_CLEAR_SQL を取り出せません（1 行の二重引用符つき文字列にしてください）" >&2
  failed=1
fi

# **本番へは select しか送らないこと。**
if grep -Fq 'select で始まらない文は送りません' scripts/report-queue.sh; then
  echo "  ok   読み取りのみの guard がある"
else
  echo "  FAIL 読み取りのみの guard がありません" >&2
  failed=1
fi

for missing in --format --persist-to; do
  expect_missing_value_exits scripts/report-queue.sh "$missing"
done

# ── 12. 削除依頼の読み出しと、手順書の整合（#41）────────────────────────────
echo "[selftest] 削除依頼の読み出し（#41）"

TD_SANDBOX="$(mktemp -d "${TMPDIR:-/tmp}/td-selftest.XXXXXX")" || exit 1
trap 'rm -rf "$SANDBOX" "$KPI_SANDBOX" "$MIG_SANDBOX" "$QUEUE_SANDBOX" "$TD_SANDBOX"' EXIT

if ! CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV=false \
     npx wrangler d1 migrations apply DB --local --persist-to "$TD_SANDBOX" >/dev/null 2>&1; then
  echo "  FAIL 削除依頼用の使い捨て D1 へマイグレーションを適用できません" >&2
  failed=1
else
  CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV=false \
    npx wrangler d1 execute DB --local --persist-to "$TD_SANDBOX" --command "
  insert into takedown_requests
    (id, game_id, claimant_name, claimant_contact, body, received_at, handled_at, action, note)
  values
    ('t1','g-1','権利者A','a@example.invalid','削除を求めます。',100,null,null,null),
    ('t2','g-2','権利者B','b@example.invalid','対応済み',50,60,'rejected','根拠不明');
  " >/dev/null 2>&1 || { echo "  FAIL 削除依頼の既知の行を入れられません" >&2; failed=1; }

  td_json="$(bash scripts/takedown-queue.sh --persist-to "$TD_SANDBOX" --format json 2>/dev/null)"
  td_code=$?
  expect_eq "未対応が有れば 1 で落ちる" "1"  "$td_code"
  expect_eq "未対応は 1 件"            "1"  "$(jq -r '.count' <<<"$td_json")"
  # **対応済みを出さない。** 出すと、判断した依頼が何度もキューへ戻る。
  expect_eq "出るのは未対応だけ"       "t1" "$(jq -r '.rows[0].id' <<<"$td_json")"
  # **中身を出す。** report-queue.sh とは判断が違う——権利者の依頼は読まないと
  # 判断できない（docs/takedown.md）。
  expect_eq "依頼の本文が出る"         "削除を求めます。" "$(jq -r '.rows[0].body' <<<"$td_json")"

  CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV=false \
    npx wrangler d1 execute DB --local --persist-to "$TD_SANDBOX" \
    --command "update takedown_requests set handled_at = 1, action = 'removed' where id = 't1'" \
    >/dev/null 2>&1
  run_bounded 60 bash scripts/takedown-queue.sh --persist-to "$TD_SANDBOX"
  expect_eq "未対応が無ければ 0 で通る" "0" "$?"
fi

# **手順書が指す措置の綴りが、実装に実在すること。**
# 手順書が `restricted` と書いているのに実装が別の綴りを持っていたら、**判断した日に
# 記録できない。**
TAKEDOWN_DOC="docs/takedown.md"
if [[ -f "$TAKEDOWN_DOC" ]]; then
  echo "  ok   ${TAKEDOWN_DOC} がある"
  for action in removed restricted rejected; do
    in_doc=0; in_src=0
    grep -qF "\`${action}\`" "$TAKEDOWN_DOC" && in_doc=1
    grep -qF "'${action}'" src/takedown.ts && in_src=1
    if [[ "$in_doc" -eq 1 && "$in_src" -eq 1 ]]; then
      echo "  ok   措置「${action}」が手順書と実装の両方にある"
    else
      echo "  FAIL 措置「${action}」が片方にしかありません（doc=${in_doc} src=${in_src}）" >&2
      failed=1
    fi
  done
else
  echo "  FAIL ${TAKEDOWN_DOC} がありません" >&2
  failed=1
fi

# **本番へは select しか送らないこと。**
if grep -Fq 'select で始まらない文は送りません' scripts/takedown-queue.sh; then
  echo "  ok   読み取りのみの guard がある"
else
  echo "  FAIL 読み取りのみの guard がありません" >&2
  failed=1
fi

for missing in --format --persist-to; do
  expect_missing_value_exits scripts/takedown-queue.sh "$missing"
done

# ── 13. 参加者の人数と未使用の招待コードの読み出し（#397）───────────────────────
#
# **人数の上限（8.1）は発行を止めるだけの緩い締め切りで、未使用のコードの本数だけ参加者は
# 上限を超えうる。** その本数を運営が数える唯一の手段が scripts/invite-stock.sh である。
# SQL や wrangler の応答の形が変わってもアプリのテストは緑のまま通るので、ここで既知の行に
# 対して数と終了コードを見る（PR #422 の Copilot の指摘）。
#
# **スクリプトを実際に走らせることが、定数の取り出しの検査を兼ねる。** `src/participant-cap.ts`
# の宣言の書き方が変わって `sed` が取り出せなくなると、スクリプトは 2 で落ち、下の期待値が外れる。
echo "[selftest] 参加者の人数と未使用の招待コード（#397）"

STOCK_SANDBOX="$(mktemp -d "${TMPDIR:-/tmp}/stock-selftest.XXXXXX")" || exit 1
trap 'rm -rf "$SANDBOX" "$KPI_SANDBOX" "$MIG_SANDBOX" "$QUEUE_SANDBOX" "$TD_SANDBOX" "$STOCK_SANDBOX"' EXIT

if ! CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV=false \
     npx wrangler d1 migrations apply DB --local --persist-to "$STOCK_SANDBOX" >/dev/null 2>&1; then
  echo "  FAIL 招待の在庫用の使い捨て D1 へマイグレーションを適用できません" >&2
  failed=1
else
  # 参加者 2 人（BAN 済み 1 人は数えない）。招待は 5 本で、数えるのは「未使用で期限内」の 2 本だけ
  # ——使用済み・期限切れ・`expires_at` が 1（遠い過去）の行は数えない。
  CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV=false \
    npx wrangler d1 execute DB --local --persist-to "$STOCK_SANDBOX" --command "
  insert into users (id, google_sub, email, display_name, created_at, banned_at) values
    ('su1','ss1','su1@example.invalid','a',1,null),
    ('su2','ss2','su2@example.invalid','b',1,null),
    ('su3','ss3','su3@example.invalid','c',1,5);
  insert into invites (code, issued_by, used_by, used_at, expires_at) values
    ('STOCKUNUSED1','su1',null,null,null),
    ('STOCKFUTURE1','su1',null,null,4102444800),
    ('STOCKUSED001','su1','su2',10,null),
    ('STOCKEXPIRE1','su2',null,null,1),
    ('STOCKUSEDEXP','su2','su3',10,2);
  " >/dev/null 2>&1 || { echo "  FAIL 招待の在庫の既知の行を入れられません" >&2; failed=1; }

  stock_json="$(bash scripts/invite-stock.sh --persist-to "$STOCK_SANDBOX" --format json 2>/dev/null)"
  stock_code=$?
  expect_eq "上限未満なら 0 で通る"             "0"     "$stock_code"
  expect_eq "上限は src/participant-cap.ts の値" "50"    "$(jq -r '.cap' <<<"$stock_json")"
  expect_eq "BAN 済みを参加者に数えない"         "2"     "$(jq -r '.participants' <<<"$stock_json")"
  expect_eq "BAN 済みの人数"                     "1"     "$(jq -r '.banned' <<<"$stock_json")"
  expect_eq "未使用で期限内のコードだけを数える" "2"     "$(jq -r '.unused' <<<"$stock_json")"
  expect_eq "すべて使われたときの人数"           "4"     "$(jq -r '.worstCase' <<<"$stock_json")"
  expect_eq "上限に達していない"                 "false" "$(jq -r '.capReached' <<<"$stock_json")"
  # **コードそのものを出さない**（端末のログに使える招待を残さない）。
  if grep -q 'STOCK' <<<"$stock_json"; then
    echo "  FAIL 招待コードそのものが出力に含まれています" >&2
    failed=1
  else
    echo "  ok   招待コードそのものを出さない"
  fi

  # **50 人ちょうどで達したとみなす**（src/participant-cap.ts の participantCapReached と同じ境界）。
  CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV=false \
    npx wrangler d1 execute DB --local --persist-to "$STOCK_SANDBOX" --command "
  insert into users (id, google_sub, email, display_name, created_at)
    with recursive n(i) as (select 1 union all select i + 1 from n where i < 48)
    select 'sb' || i, 'sbs' || i, 'sb' || i || '@example.invalid', 'bulk', 1 from n;
  " >/dev/null 2>&1 || { echo "  FAIL 招待の在庫の利用者を 50 人にできません" >&2; failed=1; }
  run_bounded 60 bash scripts/invite-stock.sh --persist-to "$STOCK_SANDBOX"
  expect_eq "参加者 50 人なら 1 で落ちる" "1" "$?"
fi

# **条件を書き写していないこと。** 参加者の条件は src/participant-cap.ts から取り出す。
if grep -q 'PARTICIPANT_WHERE_SQL' scripts/invite-stock.sh && ! grep -q 'banned_at is null' scripts/invite-stock.sh; then
  echo "  ok   参加者の条件を src/participant-cap.ts から取り出している"
else
  echo "  FAIL 参加者の条件を書き写しています（src/participant-cap.ts の PARTICIPANT_WHERE_SQL を使ってください）" >&2
  failed=1
fi

# **本番へは select しか送らないこと。**
if grep -Fq 'select で始まらない文は送りません' scripts/invite-stock.sh; then
  echo "  ok   読み取りのみの guard がある"
else
  echo "  FAIL 読み取りのみの guard がありません" >&2
  failed=1
fi

for missing in --format --persist-to; do
  expect_missing_value_exits scripts/invite-stock.sh "$missing"
done

# ── 14. 配備が、main の HEAD でなくなったコミットで走らないこと（#427）──────────────
#
# **2026-09-13、古いコミットの配備が、先に配り終えた新しいコミットの本番を上書きしかけた**
# （scripts/deploy-is-head.sh の冒頭）。関門は 2 つの部品でできていて、どちらが欠けても外れる。
#
#   (a) 判定: scripts/deploy-is-head.sh が HEAD と一致 / 不一致 / 判定できない、を正しく返す
#   (b) 配線: verify.yml の deploy ジョブで、関門より後ろの**すべての段**が関門の出力を条件に持つ
#       ——Actions には「段からジョブを成功で終える」手段が無く、**条件を付け忘れた段は古い
#       コミットでも走る**（段を足した日に付け忘れる種類の依存である）
#
# **本物の GitHub には触れない。** 使い捨ての bare リポジトリを「リモート」として、git の
# ls-remote をそのまま通す。
echo "[selftest] 配備が main の HEAD でないコミットで走らないこと（#427）"

HEAD_SANDBOX="$(mktemp -d "${TMPDIR:-/tmp}/head-selftest.XXXXXX")" || exit 1
trap 'rm -rf "$SANDBOX" "$KPI_SANDBOX" "$MIG_SANDBOX" "$QUEUE_SANDBOX" "$TD_SANDBOX" "$STOCK_SANDBOX" "$HEAD_SANDBOX"' EXIT

##
# 使い捨てのリポジトリへ空のコミットを 1 つ積み、リモートの main へ push してハッシュを返す。
# **このリポジトリの identity を使わない**（コミットは使い捨てで、ここから外へ出ない）。
#
# @param $1 コミットの件名
##
head_selftest_commit() {
  git -C "$HEAD_SANDBOX/work" -c user.name=selftest -c user.email=selftest@example.invalid \
    commit --allow-empty -q -m "$1" >/dev/null 2>&1 || return 1
  git -C "$HEAD_SANDBOX/work" push -q origin HEAD:refs/heads/main >/dev/null 2>&1 || return 1
  git -C "$HEAD_SANDBOX/work" rev-parse HEAD
}

if ! git init -q --bare "$HEAD_SANDBOX/remote.git" >/dev/null 2>&1 \
   || ! git init -q "$HEAD_SANDBOX/work" >/dev/null 2>&1 \
   || ! git -C "$HEAD_SANDBOX/work" remote add origin "$HEAD_SANDBOX/remote.git" >/dev/null 2>&1; then
  echo "  FAIL HEAD の判定用の使い捨てリポジトリを作れません" >&2
  failed=1
else
  old_sha="$(head_selftest_commit first)" || old_sha=""
  if [[ -z "$old_sha" ]]; then
    echo "  FAIL HEAD の判定用のコミットを積めません" >&2
    failed=1
  else
    # **本番の段と同じ呼び方（`--sha` を渡さない）を先に見る。** verify.yml の関門は作業ツリーの
    # HEAD（`git rev-parse HEAD`）を比べる値にする。`--sha` を渡す検査だけだと、その既定の経路が
    # 壊れても緑のまま通る（PR #429 の Copilot の指摘）。
    head_out="$(cd "$HEAD_SANDBOX/work" && bash "$ROOT/scripts/deploy-is-head.sh" --remote "$HEAD_SANDBOX/remote.git" --branch main 2>/dev/null)"
    expect_eq "--sha なし（本番の呼び方）で HEAD なら 0"             "0"              "$?"
    expect_eq "--sha なし（本番の呼び方）で HEAD なら DEPLOY_IS_HEAD" "DEPLOY_IS_HEAD" "$(printf '%s\n' "$head_out" | tail -1)"

    head_out="$(bash scripts/deploy-is-head.sh --remote "$HEAD_SANDBOX/remote.git" --branch main --sha "$old_sha" 2>/dev/null)"
    expect_eq "HEAD と一致すれば 0"             "0"                "$?"
    expect_eq "HEAD と一致すれば DEPLOY_IS_HEAD" "DEPLOY_IS_HEAD"   "$(printf '%s\n' "$head_out" | tail -1)"

    new_sha="$(head_selftest_commit second)" || new_sha=""
    # 作業ツリーを古いコミットへ戻し、**`--sha` なしで**「もう HEAD ではない」を見る（本番で起きた形）。
    if git -C "$HEAD_SANDBOX/work" checkout -q --detach "$old_sha" >/dev/null 2>&1; then
      head_out="$(cd "$HEAD_SANDBOX/work" && bash "$ROOT/scripts/deploy-is-head.sh" --remote "$HEAD_SANDBOX/remote.git" --branch main 2>/dev/null)"
      expect_eq "--sha なしで古いコミットなら DEPLOY_SUPERSEDED" "DEPLOY_SUPERSEDED" "$(printf '%s\n' "$head_out" | tail -1)"
    else
      echo "  FAIL 使い捨ての作業ツリーを古いコミットへ戻せません" >&2
      failed=1
    fi
    head_out="$(bash scripts/deploy-is-head.sh --remote "$HEAD_SANDBOX/remote.git" --branch main --sha "$old_sha" 2>/dev/null)"
    expect_eq "HEAD が進んでいても 0（落とさない）"         "0"                 "$?"
    expect_eq "HEAD が進んでいれば DEPLOY_SUPERSEDED"       "DEPLOY_SUPERSEDED" "$(printf '%s\n' "$head_out" | tail -1)"
    head_out="$(bash scripts/deploy-is-head.sh --remote "$HEAD_SANDBOX/remote.git" --branch main --sha "$new_sha" 2>/dev/null)"
    expect_eq "新しい HEAD では DEPLOY_IS_HEAD"             "DEPLOY_IS_HEAD"    "$(printf '%s\n' "$head_out" | tail -1)"

    # **判定できないときは「配る」に倒さない。** 合図を出さずに 2 で落ちる。
    head_out="$(bash scripts/deploy-is-head.sh --remote "$HEAD_SANDBOX/no-such.git" --branch main --sha "$old_sha" 2>/dev/null)"
    expect_eq "リモートを読めなければ 2"       "2" "$?"
    expect_eq "リモートを読めなければ合図を出さない" "" "$(printf '%s\n' "$head_out" | grep -E '^DEPLOY_' || true)"
    bash scripts/deploy-is-head.sh --remote "$HEAD_SANDBOX/remote.git" --branch no-such --sha "$old_sha" >/dev/null 2>&1
    expect_eq "ブランチが無ければ 2"           "2" "$?"
    bash scripts/deploy-is-head.sh --remote "$HEAD_SANDBOX/remote.git" --branch main --sha "abc" >/dev/null 2>&1
    expect_eq "40 桁でないハッシュは 2"         "2" "$?"
  fi
fi

for missing in --remote --branch --sha; do
  expect_missing_value_exits scripts/deploy-is-head.sh "$missing"
done

# (b) 配線。deploy ジョブの段を上から読み、段ごとに「関門の段か」「checkout か」「関門の出力を
# 条件に持つか」を 1 行で出す。**YAML の構文解析器は依存に無い**ので、段の始まり
# （6 字下げの `- `）と、その段の中の `id:` / `uses:` / `if:` だけを見る。
WORKFLOW=".github/workflows/verify.yml"
steps_table="$(awk -v cond="steps.head-gate.outputs.deploy == 'true'" '
  /^  deploy:[[:space:]]*$/ { in_job = 1; next }
  in_job && /^  [A-Za-z0-9_-]+:[[:space:]]*$/ { in_job = 0 }
  !in_job { next }
  /^    steps:[[:space:]]*$/ { in_steps = 1; next }
  !in_steps { next }
  /^      - / {
    if (n > 0) print n "\t" gate "\t" checkout "\t" gated "\t" name
    n++; gate = 0; checkout = 0; gated = 0; name = $0
  }
  /^      (- |  )id: head-gate[[:space:]]*$/ { gate = 1 }
  /^      (- |  )uses: actions\/checkout@/ { checkout = 1 }
  /^      (- |  )if: / && index($0, cond) > 0 { gated = 1 }
  END { if (n > 0) print n "\t" gate "\t" checkout "\t" gated "\t" name }
' "$WORKFLOW")"

if [[ -z "$steps_table" ]]; then
  echo "  FAIL ${WORKFLOW} の deploy ジョブの段を読めません" >&2
  failed=1
else
  gate_index="$(awk -F '\t' '$2 == 1 { print $1; exit }' <<<"$steps_table")"
  if [[ -z "$gate_index" ]]; then
    echo "  FAIL deploy ジョブに HEAD の関門（id: head-gate）がありません" >&2
    failed=1
  else
    echo "  ok   deploy ジョブに HEAD の関門がある（${gate_index} 段目）"
    # **関門より前に置いてよいのは checkout だけ**（判定に作業ツリーが要る）。
    early="$(awk -F '\t' -v g="$gate_index" '$1 < g && $3 != 1 { print $5 }' <<<"$steps_table")"
    if [[ -z "$early" ]]; then
      echo "  ok   関門より前にあるのは checkout だけ"
    else
      echo "  FAIL 関門より前に checkout 以外の段があります: ${early}" >&2
      failed=1
    fi
    ungated="$(awk -F '\t' -v g="$gate_index" '$1 > g && $4 != 1 { print $5 }' <<<"$steps_table")"
    later_count="$(awk -F '\t' -v g="$gate_index" '$1 > g' <<<"$steps_table" | wc -l | tr -d ' ')"
    if [[ "$later_count" -gt 0 && -z "$ungated" ]]; then
      echo "  ok   関門より後ろの ${later_count} 段すべてが関門の出力を条件に持つ"
    else
      echo "  FAIL 関門の出力を条件に持たない段があります（古いコミットでも走ります）: ${ungated:-（後ろの段がありません）}" >&2
      failed=1
    fi
  fi
fi

# ── 15. R2 のライフサイクルの判定が、宣言の外の削除規則を落とすこと（#380）──────────
#
# **scripts/check-r2-lifecycle.sh は外部層の検査で、Cloudflare の API と apply 済みの state が無いと
# 回らない。** #380 で判定が「削除規則が 1 つも無い」から「宣言した接頭辞に限った削除規則だけが在る」
# へ変わったので、**判定だけを scripts/lib/r2-lifecycle-judge.sh へ出し、ここで作った JSON を食わせる。**
# 本番の検査の側には、JSON を差し替える口を作っていない（あちらの冒頭）。
#
# 見るのは、**正しい宣言と実物が緑になること**と、**次の 6 つの壊し方がそれぞれ赤になること**である。
#
#   (a) 宣言の外の接頭辞（builds/）の削除規則を足した（ダッシュボードで足した形）
#   (b) 宣言した規則の接頭辞を広げた（avatars/ … 現行のアイコンまで消える）
#   (c) バケット全体（接頭辞が空）の削除規則を足した
#   (d) 秒数を縮めた（/privacy の 30 日が嘘になる）
#   (e) 宣言した削除規則が実物に無い（apply していない）
#   (f) 宣言そのものが全体の削除規則を持つ
echo "[selftest] R2 のライフサイクルの判定が、宣言の外の削除規則を落とすこと（#380）"

# shellcheck source=scripts/lib/r2-lifecycle-judge.sh
. "$HERE/lib/r2-lifecycle-judge.sh"

r2_expected='{"rule_ids":["abort-incomplete-multipart-uploads","delete-replaced-avatars"],"abort_rule_id":"abort-incomplete-multipart-uploads","abort_max_age":604800,"delete_rules":[{"id":"delete-replaced-avatars","prefix":"avatars/history/","max_age_seconds":2592000}]}'
r2_abort_rule='{"id":"abort-incomplete-multipart-uploads","enabled":true,"conditions":{"prefix":""},"abortMultipartUploadsTransition":{"condition":{"maxAge":604800,"type":"Age"}}}'
r2_delete_rule='{"id":"delete-replaced-avatars","enabled":true,"conditions":{"prefix":"avatars/history/"},"deleteObjectsTransition":{"condition":{"maxAge":2592000,"type":"Age"}}}'

##
# 規則の配列から API の応答を作る。
#
# 引数: $@ = 規則の JSON
##
r2_response() {
  local joined
  joined="$(IFS=,; printf '%s' "$*")"
  printf '{"success":true,"result":{"rules":[%s]}}' "$joined"
}

##
# 判定の終了コードを見る。
#
# 引数: $1 = 説明 / $2 = 期待する終了コード（0 か 1） / $3 = 期待値の JSON / $4 = 応答の JSON
##
expect_judge() {
  local rc=0
  r2_lifecycle_judge "$3" "$4" >/dev/null 2>&1 || rc=$?
  expect_eq "$1" "$2" "$rc"
}

expect_judge "正しい宣言と実物は緑" 0 "$r2_expected" "$(r2_response "$r2_abort_rule" "$r2_delete_rule")"
expect_judge "(a) 宣言の外の接頭辞（builds/）の削除規則は赤" 1 \
  "$(jq -c '.rule_ids += ["x"]' <<<"$r2_expected")" \
  "$(r2_response "$r2_abort_rule" "$r2_delete_rule" '{"id":"x","enabled":true,"conditions":{"prefix":"builds/"},"deleteObjectsTransition":{"condition":{"maxAge":2592000,"type":"Age"}}}')"
expect_judge "(b) 宣言した規則の接頭辞を広げた（avatars/）ら赤" 1 "$r2_expected" \
  "$(r2_response "$r2_abort_rule" "$(jq -c '.conditions.prefix = "avatars/"' <<<"$r2_delete_rule")")"
expect_judge "(c) 打ち切りの規則（接頭辞が空）に削除を足したら赤" 1 "$r2_expected" \
  "$(r2_response "$(jq -c '.deleteObjectsTransition = {"condition":{"maxAge":2592000,"type":"Age"}}' <<<"$r2_abort_rule")" "$r2_delete_rule")"
expect_judge "(d) 秒数を縮めたら赤" 1 "$r2_expected" \
  "$(r2_response "$r2_abort_rule" "$(jq -c '.deleteObjectsTransition.condition.maxAge = 86400' <<<"$r2_delete_rule")")"
expect_judge "(e) 宣言した削除規則が実物に無ければ赤" 1 "$r2_expected" "$(r2_response "$r2_abort_rule")"
expect_judge "(f) 宣言が全体の削除規則を持てば、実物と一致していても赤" 1 \
  "$(jq -c '.delete_rules[0].prefix = ""' <<<"$r2_expected")" \
  "$(r2_response "$r2_abort_rule" "$(jq -c '.conditions.prefix = ""' <<<"$r2_delete_rule")")"
# **id の集合は宣言と揃えておく**（id の不一致で赤になり、綴りの検査が空振りしても緑に見えないように）。
expect_judge "未知の綴りの削除（deleteMarkerTransition）は赤" 1 "$(jq -c '.rule_ids += ["y"]' <<<"$r2_expected")" \
  "$(r2_response "$r2_abort_rule" "$r2_delete_rule" '{"id":"y","enabled":true,"conditions":{"prefix":"ogp/"},"deleteMarkerTransition":{"condition":{"maxAge":1,"type":"Age"}}}')"


if (( failed )); then
  echo "REPORT_SELFTEST_FAIL"
  exit 1
fi
echo "REPORT_SELFTEST_PASS"
