#!/usr/bin/env bash
# check-orchestrator-retry.sh — 基盤のリトライが 0 と宣言されていることの検査（#160）
#
# ## なぜ機械で見るのか
#
# **これは #160 でいちばん外してはいけない宣言である。**
#
# 5.2-7（src/build-retry.ts の MAX_GENERATION_ATTEMPTS）が既にビルド診断を織り込む
# 賢い再試行を最大 2 回持っている（#284 で 3 → 2）。Lambda の非同期呼び出しの
# maximum_retry_attempts は **既定が 2** で、放っておくと掛け算になる。1 回の送信から
# **最大 6 回・約 134 円・日次枠 6 個**が出る（3 配信 × 2 試行、実測 ¥22.41）。
#
# 呼びかけでは守らない（shared-ai-rules 12 章「機構が結果そのものを生む」）。
# **この検査は宣言（terraform/orchestrator.tf）を読む。** 実状態との一致は外部層
# （scripts/acceptance-remote.sh）が terraform output と AWS を突き合わせて見る。
# ここはネットワークも外部認証も要さないので、ローカル層の接地信号に入れられる。
#
# ## あわせて見るもの
#
# - 有効期限（maximum_event_age_in_seconds）が宣言されていること。既定は 6 時間で、
#   忘れられた生成が課金と日次枠を食う。
# - OnFailure destination が宣言されていること。リトライを 0 にした以上、1 回目の
#   失敗がそのまま終わりで、行き先が無ければ黙って消える。
# - 5.2-7 の試行回数（src/build-retry.ts）が 1 か所にあること。**掛け算の相手が
#   どこにあるかを、この検査の中から辿れるようにしておく。**
# - **実行時間の見積もりが、実際の経路と一致していること**（#174。下記）。
#
# ## 実行時間の見積もり（#174 で足した）
#
# timeout=600 は「3 試行 ×（生成 91 秒 ＋ ビルド最大 T × 2）」で決めていたが、
# **1 試行あたりのビルドは 1 ＋ MAX_MECHANICAL_FIX_PASSES 回**であり、そこへ #164 の
# 呼び直しが掛かる。**式の前提が実装とずれていても、宣言のコメントは緑のままだった。**
#
# そこでこの検査は、**式の入力をすべて実装から読み、合計を自分で計算して**宣言の
# timeout と突き合わせる。**どこにも合計を書き写さない**ので、定数を変えれば必ず
# ここが落ちる（shared-ai-rules 12 章「一覧の複製は機械照合で担保する」）。
#
#   最悪ケース = 試行回数 × 生成の秒数
#              + ( 試行回数 × ( 1 + 機械修正の巡回数 ) + 呼び直しの枠 ) × ビルド 1 回の待ち上限
#
# 見るのは 3 つの不等式である。
#
#   1. 最悪ケース ＋ 余裕 ≤ timeout（溢れると finish が届かず、作品行が running で残る）
#   2. timeout < STALE_AFTER_SECONDS（画面が「中断した可能性」と言う前に決着する）
#   3. timeout ≤ Lambda の実行時間の上限（900 秒）
#
# ## この検査が見られないもの（読む人が誤解しないために）
#
# - **生成の秒数（orchestrator_generation_seconds）は実測の申告である。** 甘い値を
#   書けば式は甘くなる。機械で確かめられるのは「1 か所にあること」までで、値の正しさは
#   CloudWatch の記録が持つ（仕様 1.2.38）。
# - **呼び直しの枠が 1 依頼あたりであること**は、ここでは「ジョブ単位で枠を作って
#   いるか」しか見ていない。**枠をビルドごとに作り直す後退はここでは緑になる。**
#   落とすのは test/orchestrator.test.ts の「時間切れの呼び直しは 1 依頼につき
#   1 回で打ち止め（#174）」である（実際に呼び出し回数を数えている）。
#
# 使い方:
#   bash scripts/check-orchestrator-retry.sh
#
# 終了コード: 0 = 合格（標準出力 ORCHESTRATOR_RETRY_PASS）/ 非0 = 不合格
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$(dirname "$HERE")"

DECL="terraform/orchestrator.tf"
RETRY_SRC="src/build-retry.ts"
FIX_SRC="src/mechanical-fix.ts"
BUILD_SRC="src/build-client.ts"
BUILD_DECL="terraform/build-function.tf"
PAGE_SRC="src/work-page.ts"
PIPELINE_SRC="src/orchestrator/pipeline.ts"

# Lambda の実行時間の上限（秒）。**AWS の制約であって、こちらが選べる値ではない。**
LAMBDA_MAX_TIMEOUT_SECONDS=900

if [[ ! -f "$DECL" ]]; then
  echo "[orchestrator-retry] 宣言が見つかりません: $DECL" >&2
  exit 1
fi

fail=0

# 1. local に 0 と書かれていること。
if ! grep -qE '^[[:space:]]*orchestrator_maximum_retry_attempts[[:space:]]*=[[:space:]]*0[[:space:]]*$' "$DECL"; then
  echo "[orchestrator-retry] $DECL の orchestrator_maximum_retry_attempts が 0 ではありません。" >&2
  echo "[orchestrator-retry] 既定（2）と 5.2-7 の 2 試行が掛け算になり、1 回の送信から" >&2
  echo "[orchestrator-retry] 最大 6 回・約 134 円・日次枠 6 個が出ます。" >&2
  fail=1
fi

# 2. その local が実際に event_invoke_config へ渡っていること。
#    **値だけを見ると、宣言はしたが使っていない状態を通してしまう。**
if ! grep -qE '^[[:space:]]*maximum_retry_attempts[[:space:]]*=[[:space:]]*local\.orchestrator_maximum_retry_attempts[[:space:]]*$' "$DECL"; then
  echo "[orchestrator-retry] maximum_retry_attempts が local から渡されていません。" >&2
  echo "[orchestrator-retry] 値を宣言しただけで使っていない状態は、既定（2）のままです。" >&2
  fail=1
fi

# 3. 有効期限。
if ! grep -qE '^[[:space:]]*maximum_event_age_in_seconds[[:space:]]*=[[:space:]]*local\.orchestrator_maximum_event_age_seconds[[:space:]]*$' "$DECL"; then
  echo "[orchestrator-retry] maximum_event_age_in_seconds が宣言されていません（既定は 6 時間）。" >&2
  fail=1
fi

# 4. OnFailure destination。
if ! grep -q 'on_failure {' "$DECL"; then
  echo "[orchestrator-retry] OnFailure destination が宣言されていません。" >&2
  echo "[orchestrator-retry] リトライ 0 で行き先が無いと、失敗したイベントは黙って消えます。" >&2
  fail=1
fi

# 5. 掛け算の相手（5.2-7）が 1 か所にあること。
#    **数を照合しない。** 3 を 4 にする判断は #20 の側にあり、この検査が持つのは
#    「相手がどこにあるか」だけである。**辿れなくなったら落とす。**
if [[ -f "$RETRY_SRC" ]]; then
  attempts="$(grep -cE '^export const MAX_GENERATION_ATTEMPTS' "$RETRY_SRC" || true)"
  if [[ "$attempts" != "1" ]]; then
    echo "[orchestrator-retry] $RETRY_SRC の MAX_GENERATION_ATTEMPTS が 1 か所ではありません（${attempts} 件）。" >&2
    echo "[orchestrator-retry] 基盤のリトライを 0 にする根拠は、アプリ側の試行回数が 1 か所にあることです。" >&2
    fail=1
  fi
else
  echo "[orchestrator-retry] $RETRY_SRC が見つかりません（5.2-7 の試行回数を辿れません）。" >&2
  fail=1
fi

# ── 6. 実行時間の見積もり（#174） ───────────────────────────────────────────
#
# **式の入力を実装から読み、合計はこの検査が計算する。** 合計をどこにも書き写さない
# ことが、宣言のコメントだけが古くなる状態（#174 が踏んだ）を防ぐ唯一の形である。

# terraform の local から数値を 1 つ読む。**無ければ空を返す**（呼び出し側が落とす）。
read_tf_local() {
  grep -E "^[[:space:]]*$2[[:space:]]*=[[:space:]]*[0-9]+[[:space:]]*$" "$1" 2>/dev/null |
    head -1 | sed -E 's/^.*=[[:space:]]*([0-9]+)[[:space:]]*$/\1/'
}

# TypeScript の `export const NAME = 数値;` を 1 つ読む。**無ければ空を返す。**
read_ts_const() {
  grep -E "^export const $2 = [0-9]+;$" "$1" 2>/dev/null |
    head -1 | sed -E 's/^.*= ([0-9]+);$/\1/'
}

timeout_seconds="$(read_tf_local "$DECL" orchestrator_timeout_seconds)"
generation_seconds="$(read_tf_local "$DECL" orchestrator_generation_seconds)"
margin_seconds="$(read_tf_local "$DECL" orchestrator_budget_margin_seconds)"
attempts_value="$(read_ts_const "$RETRY_SRC" MAX_GENERATION_ATTEMPTS)"
passes_value="$(read_ts_const "$FIX_SRC" MAX_MECHANICAL_FIX_PASSES)"
invocations_value="$(read_ts_const "$BUILD_SRC" MAX_BUILD_INVOCATIONS_ON_TIMEOUT)"
build_timeout_src="$(read_ts_const "$BUILD_SRC" BUILD_FUNCTION_TIMEOUT_SECONDS)"
build_timeout_decl="$(read_tf_local "$BUILD_DECL" build_function_timeout_seconds)"
stale_seconds="$(read_ts_const "$PAGE_SRC" STALE_AFTER_SECONDS)"

# 呼び出し側が関数のタイムアウトへ上乗せする幅（秒）。**式から読む。**
# 形が変わったら読めなくなるので、そのときは落とす（黙って古い幅で計算しない）。
invoke_margin_seconds="$(
  grep -E '^export const BUILD_INVOKE_TIMEOUT_MS = \(BUILD_FUNCTION_TIMEOUT_SECONDS \+ [0-9]+\) \* 1000;$' \
    "$BUILD_SRC" 2>/dev/null | head -1 | sed -E 's/^.*\+ ([0-9]+)\).*$/\1/'
)"

budget_ok=1
for pair in \
  "$timeout_seconds:$DECL の orchestrator_timeout_seconds" \
  "$generation_seconds:$DECL の orchestrator_generation_seconds" \
  "$margin_seconds:$DECL の orchestrator_budget_margin_seconds" \
  "$attempts_value:$RETRY_SRC の MAX_GENERATION_ATTEMPTS" \
  "$passes_value:$FIX_SRC の MAX_MECHANICAL_FIX_PASSES" \
  "$invocations_value:$BUILD_SRC の MAX_BUILD_INVOCATIONS_ON_TIMEOUT" \
  "$build_timeout_src:$BUILD_SRC の BUILD_FUNCTION_TIMEOUT_SECONDS" \
  "$build_timeout_decl:$BUILD_DECL の build_function_timeout_seconds" \
  "$stale_seconds:$PAGE_SRC の STALE_AFTER_SECONDS" \
  "$invoke_margin_seconds:$BUILD_SRC の BUILD_INVOKE_TIMEOUT_MS の上乗せ幅"; do
  value="${pair%%:*}"
  where="${pair#*:}"
  if [[ -z "$value" ]]; then
    echo "[orchestrator-retry] 実行時間の見積もりの入力を読めません: ${where}。" >&2
    echo "[orchestrator-retry] 綴りが変わったなら、この検査を追随させてください（読めないまま緑にしない）。" >&2
    budget_ok=0
  fi
done

# ビルド関数のタイムアウトは宣言が正本で、src/build-client.ts に写しがある。
# **式はその写しを使う**ので、ここで一致を見る（写しが古いと見積もりも古くなる）。
if [[ "$budget_ok" -eq 1 && "$build_timeout_src" != "$build_timeout_decl" ]]; then
  echo "[orchestrator-retry] ビルド関数のタイムアウトが宣言と実装でずれています" >&2
  echo "[orchestrator-retry]   $BUILD_DECL: ${build_timeout_decl} 秒 / $BUILD_SRC: ${build_timeout_src} 秒" >&2
  echo "[orchestrator-retry] 正本は宣言側です（$BUILD_DECL）。" >&2
  budget_ok=0
fi

# 時間切れの呼び直しの枠が **1 依頼あたり**であること（#174）。
# **数を照合しない。** 見るのは「ジョブ単位で枠を作っているか」だけで、作っていな
# ければ枠はビルドごとになり、式の呼び出し回数が最大 (1 + 巡回数) 倍に増える。
if [[ -f "$PIPELINE_SRC" ]]; then
  budget_calls="$(grep -cE 'createBuildTimeoutBudget\(\)' "$PIPELINE_SRC" || true)"
  if [[ "$budget_calls" != "1" ]]; then
    echo "[orchestrator-retry] $PIPELINE_SRC が createBuildTimeoutBudget() を 1 回だけ呼んでいません（${budget_calls} 件）。" >&2
    echo "[orchestrator-retry] 呼び直しの枠は 1 依頼につき 1 つです。ビルドごとに作ると、" >&2
    echo "[orchestrator-retry] 1 依頼のビルド呼び出しが最大 (1 + 機械修正の巡回数) 倍になり、見積もりが崩れます。" >&2
    budget_ok=0
  fi
else
  echo "[orchestrator-retry] $PIPELINE_SRC が見つかりません（呼び直しの枠の単位を辿れません）。" >&2
  budget_ok=0
fi

if [[ "$budget_ok" -eq 1 ]]; then
  # 1 回のビルド呼び出しで呼び出し側が待つ上限（秒）。
  invoke_seconds=$((build_timeout_src + invoke_margin_seconds))
  # 1 依頼で走りうるビルド関数の呼び出し回数。
  #   試行ごとに (1 + 機械修正の巡回数) 回 ＋ 依頼あたりの呼び直しの枠。
  invocations=$((attempts_value * (1 + passes_value) + invocations_value - 1))
  worst=$((attempts_value * generation_seconds + invocations * invoke_seconds))
  needed=$((worst + margin_seconds))

  echo "[orchestrator-retry] 見積もり: 生成 ${attempts_value}×${generation_seconds} 秒 ＋ ビルド ${invocations}×${invoke_seconds} 秒 = ${worst} 秒（＋余裕 ${margin_seconds} 秒 → ${needed} 秒 / timeout ${timeout_seconds} 秒）"

  # 1. 最悪ケース ＋ 余裕 ≤ timeout
  if [[ "$needed" -gt "$timeout_seconds" ]]; then
    echo "[orchestrator-retry] 最悪ケースが timeout に収まりません（${needed} 秒 > ${timeout_seconds} 秒）。" >&2
    echo "[orchestrator-retry] 溢れると関数が殺され、finish コールバックが届かず、作品行は running のまま残ります。" >&2
    echo "[orchestrator-retry] timeout を伸ばすか、上流（試行回数・機械修正の巡回数・呼び直しの枠）を絞ってください。" >&2
    fail=1
  fi

  # 2. timeout < STALE_AFTER_SECONDS
  if [[ "$timeout_seconds" -ge "$stale_seconds" ]]; then
    echo "[orchestrator-retry] timeout が STALE_AFTER_SECONDS 以上です（${timeout_seconds} 秒 >= ${stale_seconds} 秒）。" >&2
    echo "[orchestrator-retry] まだ走っている生成を、画面が「中断した可能性」と呼ぶことになります。" >&2
    fail=1
  fi

  # 3. timeout ≤ Lambda の実行時間の上限
  if [[ "$timeout_seconds" -gt "$LAMBDA_MAX_TIMEOUT_SECONDS" ]]; then
    echo "[orchestrator-retry] timeout が Lambda の上限を超えています（${timeout_seconds} 秒 > ${LAMBDA_MAX_TIMEOUT_SECONDS} 秒）。" >&2
    echo "[orchestrator-retry] この値では関数を作れません。上流を絞ってください。" >&2
    fail=1
  fi
else
  fail=1
fi

# 7. timeout の local が実際に関数へ渡っていること（2 と同じ理由）。
if ! grep -qE '^[[:space:]]*timeout[[:space:]]*=[[:space:]]*local\.orchestrator_timeout_seconds[[:space:]]*$' "$DECL"; then
  echo "[orchestrator-retry] timeout が local から渡されていません。" >&2
  echo "[orchestrator-retry] 見積もりを宣言しただけで使っていない状態は、既定（3 秒）のままです。" >&2
  fail=1
fi

if [[ "$fail" -ne 0 ]]; then
  exit 1
fi

echo "ORCHESTRATOR_RETRY_PASS"
