#!/usr/bin/env bash
# deploy-chat.sh — 相談の Lambda へコードを載せる（#695 / 仕様 5.16）
#
# **器（関数・ロール・許可）は terraform/chat-function.tf が持つ。** このスクリプトが持つのは
# コードの配備だけである（宣言側はコードを ignore_changes に入れており、配備のたびに plan へ差分が
# 出ない。scripts/deploy-orchestrator.sh と同じ形）。
#
# ## 何を載せるか
#
# `scripts/bundle-chat.sh` が esbuild で束ねた 1 ファイルの zip である（依存は aws4fetch だけで、
# ネイティブのライブラリを含まない——アイコン変換（sharp）と違い、手元の環境と関数の環境の差が無い）。
#
# ## オーケストレータとは独立している
#
# **相談を直しても、オーケストレータの配り直しは要らない**（逆も同じ）。これが #695 で関数を
# 分けた理由そのものである（仕様 5.16）。
#
# ## 誰が叩くか
#
# **利用者が自分の端末で叩く。** AI エージェントの実行環境は本番への書き込みを拒否する。
#
# 前提:
#   - AWS へ認証済みであること（aws sso login --profile game-forge-prod --use-device-code）
#   - AWS_PROFILE が本番アカウントを指していること
#   - **terraform apply で関数が既に存在すること**（プライマリの作業ツリーから。docs/handoff.md 3 章）
#
# 使い方:
#   export AWS_PROFILE=game-forge-prod
#   bash scripts/deploy-chat.sh
#   bash scripts/deploy-chat.sh --build-only   # zip を作るだけ（AWS に触れない）
#
# 終了コード: 0 = 成功（DEPLOY_PASS）/ 非0 = 失敗
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$(dirname "$HERE")"

export AWS_PAGER=""

FUNCTION_NAME="${CHAT_FUNCTION_NAME:-game-forge-chat}"
ZIP="dist/chat.zip"

command -v openssl >/dev/null 2>&1 || {
  echo "[deploy-chat] openssl がありません（CodeSha256 の計算に要ります）。" >&2
  exit 1
}

# **毎回束ね直す**（scripts/deploy-orchestrator.sh と同じ理由。手元の dist/ が古いまま載ると、
# 直したはずの不具合が本番に残る）。
bash scripts/bundle-chat.sh

if [[ "${1:-}" == "--build-only" ]]; then
  echo "[deploy-chat] --build-only のため、AWS へは触れません。"
  exit 0
fi

command -v aws >/dev/null 2>&1 || {
  echo "[deploy-chat] aws CLI がありません。" >&2
  exit 1
}
if ! bash scripts/deploy-orchestrator.sh --check-prerequisites >/dev/null; then
  # **前提の検査はオーケストレータの配備と同じものを使う**（profile と環境の資格情報の食い違い・region）。
  bash scripts/deploy-orchestrator.sh --check-prerequisites || true
  echo "[deploy-chat] **AWS へは 1 度も触れていません。** 前提が欠けています。" >&2
  exit 2
fi

SHA_LOCAL="$(openssl dgst -sha256 -binary "$ZIP" | base64)"

ERR="$(mktemp "${TMPDIR:-/tmp}/deploy-chat-err.XXXXXX")" || {
  echo "[deploy-chat] 一時ファイルを作成できませんでした。" >&2
  exit 1
}
trap 'rm -f "$ERR"' EXIT

if ! SHA_REMOTE="$(aws lambda get-function-configuration \
  --function-name "$FUNCTION_NAME" \
  --query 'CodeSha256' --output text 2>"$ERR")"; then
  echo "[deploy-chat] 関数の情報を読めませんでした: $FUNCTION_NAME" >&2
  cat "$ERR" >&2
  echo "[deploy-chat] 認証と、器の作成（プライマリの作業ツリーからの terraform apply）が済んでいるか確認してください。" >&2
  exit 1
fi

if [[ "$SHA_REMOTE" == "$SHA_LOCAL" ]]; then
  # **束ねた zip は決定的である**（時刻を固定している。scripts/bundle-chat.sh）ので、
  # 同じコードなら載せ替えない——オーケストレータの配備と同じ判定である。
  echo "[deploy-chat] 既に同じコードが載っています（CodeSha256: $SHA_REMOTE）。"
  echo "DEPLOY_PASS"
  exit 0
fi

echo "[deploy-chat] 載せ替えます: ${SHA_REMOTE:-none} -> $SHA_LOCAL"

# apply の直後は Pending のことがある（scripts/deploy-orchestrator.sh と同じ）。
aws lambda wait function-active-v2 --function-name "$FUNCTION_NAME"

# **`--no-publish`**（宣言が publish を持たない。綴りは scripts/check-aws-cli-usage.sh が照合する）。
aws lambda update-function-code \
  --function-name "$FUNCTION_NAME" \
  --zip-file "fileb://${ZIP}" \
  --no-publish \
  --output text --query 'LastUpdateStatus'

aws lambda wait function-updated-v2 --function-name "$FUNCTION_NAME"

SHA_AFTER="$(aws lambda get-function-configuration \
  --function-name "$FUNCTION_NAME" --query 'CodeSha256' --output text)"
if [[ "$SHA_AFTER" != "$SHA_LOCAL" ]]; then
  echo "[deploy-chat] 載ったコードが手元と一致しません: $SHA_AFTER != $SHA_LOCAL" >&2
  exit 1
fi

echo "[deploy-chat] 完了（CodeSha256: $SHA_AFTER）"
echo "DEPLOY_PASS"
