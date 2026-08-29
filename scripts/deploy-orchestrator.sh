#!/usr/bin/env bash
# deploy-orchestrator.sh — オーケストレータ Lambda へコードを載せる（#160）
#
# **器（関数・ロール・非同期呼び出しの構成）は terraform/orchestrator.tf が持つ。**
# このスクリプトが持つのはコードの配備だけである。宣言側はコードを
# ignore_changes に入れており、**配備のたびに terraform plan へ差分が出ない**
# （terraform/build-function.tf の image_uri と同じ形）。
#
# ## 誰が叩くか
#
# **利用者が自分の端末で叩く。** AI エージェントの実行環境は本番への書き込みを
# 拒否する。手順の正本は docs/orchestrator.md にある。
#
# 前提:
#   - AWS へ認証済みであること（aws sso login --sso-session ojos）
#   - AWS_PROFILE が本番アカウントを指していること
#   - terraform apply で関数が既に存在すること
#
# 使い方:
#   export AWS_PROFILE=game-forge-prod
#   bash scripts/deploy-orchestrator.sh
#
# 終了コード: 0 = 成功 / 非0 = 失敗
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$(dirname "$HERE")"

# **ページャを外す。** AWS CLI v2 は端末へ出すとき既定でページャを噛ませる。
# 利用者は自分の端末でこれを叩くので（上記「誰が叩くか」）、環境の PAGER 次第では
# 配備の途中で入力待ちになる。
export AWS_PAGER=""

FUNCTION_NAME="${ORCHESTRATOR_FUNCTION_NAME:-game-forge-orchestrator}"
ZIP="dist/orchestrator.zip"

command -v aws >/dev/null 2>&1 || {
  echo "[deploy-orchestrator] aws CLI がありません。" >&2
  exit 1
}

command -v openssl >/dev/null 2>&1 || {
  echo "[deploy-orchestrator] openssl がありません（CodeSha256 の計算に要ります）。" >&2
  exit 1
}

# **毎回束ね直す。** 手元の dist/ が古いまま載ると、直したはずの不具合が本番に
# 残る。束ね直しは 20 ms 程度で、省く理由が無い。
bash scripts/bundle-orchestrator.sh

SHA_LOCAL="$(openssl dgst -sha256 -binary "$ZIP" | base64)"

echo "[deploy-orchestrator] 現在載っているコードを確認します"
# **失敗を握りつぶさない。** 以前はここを `2>/dev/null || echo ''` で流していたため、
# 認証切れも関数の不在も「まだ何も載っていない」と同じ見た目になり、次の
# update-function-code が出す生のエラーだけが残った。**何を直せばよいかを言う。**
ERR="$(mktemp)"
trap 'rm -f "$ERR"' EXIT
if ! SHA_REMOTE="$(aws lambda get-function-configuration \
  --function-name "$FUNCTION_NAME" \
  --query 'CodeSha256' --output text 2>"$ERR")"; then
  echo "[deploy-orchestrator] 関数の情報を読めませんでした: $FUNCTION_NAME" >&2
  cat "$ERR" >&2
  echo "[deploy-orchestrator] 認証（aws sso login --sso-session ojos）と、" >&2
  echo "[deploy-orchestrator] 器の作成（terraform apply）が済んでいるか確認してください。" >&2
  exit 1
fi

if [[ "$SHA_REMOTE" == "$SHA_LOCAL" ]]; then
  echo "[deploy-orchestrator] 既に同じコードが載っています（CodeSha256: $SHA_LOCAL）"
  echo "DEPLOY_PASS"
  exit 0
fi

echo "[deploy-orchestrator] 載せ替えます: ${SHA_REMOTE:-none} -> $SHA_LOCAL"

# **更新の前にも待つ。** terraform apply の直後は関数が Pending のことがあり、その間の
# 更新は ResourceConflictException で断られる（「An update is in progress」）。
# **このスクリプトが呼ばれるのはまさに apply の直後である。**
aws lambda wait function-active-v2 --function-name "$FUNCTION_NAME"

# **`--publish false` と書いてはいけない**（PR で本番が止まった原因）。
# AWS CLI の真偽値フラグは値を取らず、`--publish` か `--no-publish` のどちらかである。
# 値を渡すと `Unknown options: false` で落ちる。宣言側（terraform/orchestrator.tf）が
# `publish` を宣言しておらず、Terraform の既定は false である。**宣言に合わせて版を
# 発行しない `--no-publish` が正しい形**である（`--publish` にすると、宣言していない
# 版が配備のたびに増える）。
# この綴りは scripts/check-aws-cli-usage.sh が機械照合する。
aws lambda update-function-code \
  --function-name "$FUNCTION_NAME" \
  --zip-file "fileb://${ZIP}" \
  --no-publish \
  --output text --query 'LastUpdateStatus'

# **更新が終わるまで待つ。** 直後は LastUpdateStatus=InProgress で、そのまま
# 呼ぶと更新前のコードが動く。待たないと「配備したのに直っていない」に見える。
aws lambda wait function-updated-v2 --function-name "$FUNCTION_NAME"

SHA_AFTER="$(aws lambda get-function-configuration \
  --function-name "$FUNCTION_NAME" --query 'CodeSha256' --output text)"
if [[ "$SHA_AFTER" != "$SHA_LOCAL" ]]; then
  echo "[deploy-orchestrator] 載ったコードが手元と一致しません: $SHA_AFTER != $SHA_LOCAL" >&2
  exit 1
fi

echo "[deploy-orchestrator] 完了（CodeSha256: $SHA_AFTER）"
echo "DEPLOY_PASS"
