#!/usr/bin/env bash
# check-tf-output-refs.sh — 検査スクリプトが読む terraform output が、宣言側に
# 実在することを確かめる（#160 / shared-ai-rules 12 章）。
#
# ## なぜ要るのか
#
# **外部層の検査は、期待値を terraform output から取る。** 書き写さないための規約で、
# それ自体は正しい。ただし**参照している名前そのものが複製**である——宣言側で output を
# 改名・削除しても、検査側は古い名前を読み続ける。
#
# **そして読み損ねは、必ずしも赤にならない。**
#
# - 値が空のまま比較へ進むと、**空と空が一致して緑になる**（空振り）。
#   実際に #160 で起きた: 停止対象が IAM ユーザーからロールへ移ったとき、層 2 の検査は
#   `bedrock_invoker_user_name`（消えた output）と `TARGET_USER_NAME`（消えた環境変数）を
#   突き合わせており、**どちらも空なので緑のまま**、何も確かめていなかった。
# - 別の検査は識別子の存在検査で落ちたが、**落ちた理由は「取得できない」であって、
#   実状態の不一致ではない。** 直すべき場所が一目では分からない。
#
# **どちらも「参照している名前が実在するか」を先に見れば、その場で分かる。**
# ネットワークも AWS の認証も要らない検査である（宣言のテキストどうしの照合）。
#
# ## 何を見ないか
#
# **値は見ない。** output が実在するかだけを見る。値が正しいか・実状態と一致するかは
# 外部層（scripts/acceptance-remote.sh）が AWS に対して確かめる。
#
# 使い方:
#   bash scripts/check-tf-output-refs.sh
#
# 終了コード: 0 = TF_OUTPUT_REFS_PASS / 1 = 実在しない output を参照している
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$(dirname "$HERE")"

TF_DIR="terraform"

if [[ ! -d "$TF_DIR" ]]; then
  echo "[tf-output-refs] skip: $TF_DIR がありません"
  echo "TF_OUTPUT_REFS_PASS"
  exit 0
fi

# 宣言側: `output "name" {` の name を集める。
declared="$(grep -hoE '^output[[:space:]]+"[a-z0-9_]+"' "$TF_DIR"/*.tf 2>/dev/null \
  | grep -oE '"[a-z0-9_]+"' | tr -d '"' | sort -u || true)"

if [[ -z "$declared" ]]; then
  echo "[tf-output-refs] $TF_DIR に output の宣言が 1 つもありません。検査が成立しません。" >&2
  exit 1
fi

# 参照側: 2 つの綴りを拾う。
#   1. tf_output <name>            … 検査スクリプトのヘルパ
#   2. terraform ... output -json <name> … 生の呼び出し
referenced="$(
  {
    grep -rhoE '\btf_output[[:space:]]+[a-z0-9_]+' scripts/*.sh 2>/dev/null \
      | awk '{print $2}'
    grep -rhoE 'output[[:space:]]+(-json[[:space:]]+|-raw[[:space:]]+)?[a-z0-9_]+' scripts/*.sh 2>/dev/null \
      | grep -E '\-(json|raw)[[:space:]]' \
      | awk '{print $NF}'
  } | sort -u || true
)"

if [[ -z "$referenced" ]]; then
  echo "[tf-output-refs] scripts/ から terraform output の参照が 1 つも見つかりません。検査が成立しません。" >&2
  exit 1
fi

missing=""
while IFS= read -r name; do
  [[ -n "$name" ]] || continue
  if ! grep -qxF -- "$name" <<<"$declared"; then
    missing+="$name"$'\n'
  fi
done <<<"$referenced"

if [[ -n "$missing" ]]; then
  echo "[tf-output-refs] 宣言に無い terraform output を参照しています:" >&2
  while IFS= read -r name; do
    [[ -n "$name" ]] || continue
    echo "  - $name" >&2
    # **参照の綴りだけを出す。** 名前をただ含む行（この検査自身の説明文など）まで
    # 出すと、直す場所が埋もれる。
    grep -rnE "(tf_output|output[[:space:]]+-(json|raw))[[:space:]]+$name\b" scripts/*.sh \
      | sed 's/^/      /' >&2
  done <<<"$missing"
  echo "[tf-output-refs] 宣言側で改名・削除された可能性があります（terraform/outputs.tf）。" >&2
  echo "[tf-output-refs] **空のまま比較へ進むと、空どうしが一致して緑になります。**" >&2
  exit 1
fi

echo "[tf-output-refs] $(wc -l <<<"$referenced") 件の参照が、$(wc -l <<<"$declared") 件の宣言に含まれています"
echo "TF_OUTPUT_REFS_PASS"
