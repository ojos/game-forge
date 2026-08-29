#!/usr/bin/env bash
# check-orchestrator-retry.sh — 基盤のリトライが 0 と宣言されていることの検査（#160）
#
# ## なぜ機械で見るのか
#
# **これは #160 でいちばん外してはいけない宣言である。**
#
# 5.2-7（src/build-retry.ts の MAX_GENERATION_ATTEMPTS）が既にビルド診断を織り込む
# 賢い再試行を最大 3 回持っている。Lambda の非同期呼び出しの maximum_retry_attempts は
# **既定が 2** で、放っておくと掛け算になる。1 回の送信から**最大 9 回・約 144 円・
# 日次枠 9 個**が出る。
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

if [[ ! -f "$DECL" ]]; then
  echo "[orchestrator-retry] 宣言が見つかりません: $DECL" >&2
  exit 1
fi

fail=0

# 1. local に 0 と書かれていること。
if ! grep -qE '^[[:space:]]*orchestrator_maximum_retry_attempts[[:space:]]*=[[:space:]]*0[[:space:]]*$' "$DECL"; then
  echo "[orchestrator-retry] $DECL の orchestrator_maximum_retry_attempts が 0 ではありません。" >&2
  echo "[orchestrator-retry] 既定（2）と 5.2-7 の 3 試行が掛け算になり、1 回の送信から" >&2
  echo "[orchestrator-retry] 最大 9 回・約 144 円・日次枠 9 個が出ます。" >&2
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

if [[ "$fail" -ne 0 ]]; then
  exit 1
fi

echo "ORCHESTRATOR_RETRY_PASS"
