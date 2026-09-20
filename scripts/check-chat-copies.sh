#!/usr/bin/env bash
# check-chat-copies.sh — 相談の「写し」を機械で突き合わせる（#695 / shared-ai-rules 12 章）
#
# ## なぜ要るのか
#
# 相談の関数名は 2 か所にある。**同じ値を 2 か所に書く形**であり、片方だけが動いた日に
# 黙って壊れる（`scripts/check-avatar-copies.sh` と同じ事情）。
#
#   宣言   terraform/chat-function.tf   関数名（`local.chat_function_name`。**正本**）
#   エッジ wrangler.toml                呼ぶ相手（`CHAT_FUNCTION_NAME`。**3 環境ぶん**）
#
# ## ずれると何が起きるか
#
# - **関数名がずれる: 相談がすべて 500 になる**（`ResourceNotFoundException`）。利用者から見ると
#   「送信しても返ってこない」で、原因は本番のログを読むまで分からない
# - **環境ごとにずれる: 本番だけ・preview だけが壊れる。** 3 環境ぶんを同じ値として照合する
#
# ## 関数名以外を照合しない理由
#
# アイコン変換（#380）と違い、**関数とエッジで共有する値がほかに無い。** ペイロードの形は
# `src/chat-payload.ts` の 1 ファイルを両側が import しており（写しではない）、上限も版もそこにある。
# **Guardrail の id と版は宣言から関数へ渡すだけ**でエッジは知らない。
#
# 使い方:
#   bash scripts/check-chat-copies.sh
#
# 終了コード: 0 = 合格（標準出力 CHAT_COPIES_PASS）/ 非0 = 不合格
#
# **GNU 拡張を使わない**（利用者の端末は macOS / bash 3.2。docs/handoff.md 3 章）。
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$(dirname "$HERE")"

TF="terraform/chat-function.tf"
WRANGLER="wrangler.toml"

for file in "$TF" "$WRANGLER"; do
  if [[ ! -f "$file" ]]; then
    echo "[chat-copies] 照合の対象がありません: $file" >&2
    echo "[chat-copies] 検査が成立しないため失敗させます（見ていないことを合格にしない）。" >&2
    exit 1
  fi
done

# 正本（terraform の local）。`chat_function_name = "game-forge-chat"` の右辺を取る。
TF_NAME="$(sed -n 's/^[[:space:]]*chat_function_name[[:space:]]*=[[:space:]]*"\([^"]*\)".*$/\1/p' "$TF" | head -1)"
if [[ -z "$TF_NAME" ]]; then
  echo "[chat-copies] $TF から chat_function_name を読めませんでした。" >&2
  exit 1
fi

# 写し（wrangler.toml の 3 環境）。
WRANGLER_NAMES="$(sed -n 's/^[[:space:]]*CHAT_FUNCTION_NAME[[:space:]]*=[[:space:]]*"\([^"]*\)".*$/\1/p' "$WRANGLER")"
COUNT="$(printf '%s\n' "$WRANGLER_NAMES" | grep -c . || true)"
if [[ "$COUNT" -ne 3 ]]; then
  echo "[chat-copies] $WRANGLER の CHAT_FUNCTION_NAME が 3 つではありません（${COUNT} 個）。" >&2
  echo "[chat-copies] 3 環境（本番・preview・開発）ぶんを揃えてください。" >&2
  exit 1
fi

failed=0
while IFS= read -r name; do
  [[ -z "$name" ]] && continue
  if [[ "$name" != "$TF_NAME" ]]; then
    echo "[chat-copies] 関数名がずれています: wrangler.toml の \"$name\" != $TF の \"$TF_NAME\"" >&2
    failed=1
  fi
done <<EOF
$WRANGLER_NAMES
EOF

if [[ "$failed" -ne 0 ]]; then
  exit 1
fi

echo "[chat-copies] 関数名 \"$TF_NAME\" を 3 か所で照合しました"
echo "CHAT_COPIES_PASS"
