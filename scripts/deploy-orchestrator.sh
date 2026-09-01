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

##
# 前提を、AWS を叩く前に名指しで検査する（#243）。
#
# **以前は region の未設定が「認証と器の作成を確認してください」として出ていた。**
# 2026-09-01、本番の生成が止まっている最中にこれを踏んだ（#241 の復旧作業）。
# 認証も器の作成も済んでおり、**当たっていない原因を指していた。**
#
#   aws: [ERROR]: An error occurred (NoRegion): You must specify a region.
#   [deploy-orchestrator] 認証（aws sso login --sso-session ojos）と、
#   [deploy-orchestrator] 器の作成（terraform apply）が済んでいるか確認してください。
#
# **原因が読み取りにくい赤は、いちばん時間を取られたくない場面で出る**
# （docs/handoff.md 4 章）。前提が欠けているなら、**欠けている前提を言う。**
#
# # region の値をここへ書き写さない
#
# **正本は terraform 側である。** ここが持つのは「解決できているか」だけで、
# 値そのものは持たない。書き写すと、宣言を動かした日にずれる（確定24 と同じ理由）。
#
# @return 0 = 揃っている / 2 = 欠けている（何が欠けているかを標準エラーへ）
##
check_prerequisites() {
  local missing=0

  # **profile か、環境の資格情報か。どちらか片方に揃える。**
  #
  # 実際に踏んだ入口は「どちらも無い」だった（AWS_PROFILE を export し忘れると、既定の
  # プロファイルには region が無く、NoRegion になる）。**残り 2 つの形も塞ぐ。**
  #
  # - **環境の資格情報は 2 つで 1 組である。** AWS_ACCESS_KEY_ID だけでは動かない
  # - **両方あると環境側が勝つ**（AWS CLI の優先順位）。AWS_PROFILE を書いた本人は
  #   そのプロファイルで配るつもりでいるのに、**古い環境変数が残っていれば別の
  #   アカウントへ配る。** 本番へ書く道具でこれを黙って通さない
  if [[ -n "${AWS_PROFILE:-}" && -n "${AWS_ACCESS_KEY_ID:-}" ]]; then
    echo "[deploy-orchestrator] AWS_PROFILE と AWS_ACCESS_KEY_ID の両方があります。" >&2
    echo "[deploy-orchestrator] **環境変数のほうが勝つ**ので、AWS_PROFILE は使われません。" >&2
    echo "[deploy-orchestrator] 対処: どちらか片方に揃える（unset AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY）" >&2
    missing=1
  elif [[ -n "${AWS_ACCESS_KEY_ID:-}" && -z "${AWS_SECRET_ACCESS_KEY:-}" ]]; then
    echo "[deploy-orchestrator] AWS_ACCESS_KEY_ID はありますが AWS_SECRET_ACCESS_KEY がありません。" >&2
    echo "[deploy-orchestrator] **環境の資格情報は 2 つで 1 組です。**" >&2
    missing=1
  elif [[ -z "${AWS_PROFILE:-}" && -z "${AWS_ACCESS_KEY_ID:-}" ]]; then
    echo "[deploy-orchestrator] AWS_PROFILE も環境の資格情報もありません。" >&2
    echo "[deploy-orchestrator] 対処: export AWS_PROFILE=game-forge-prod" >&2
    missing=1
  fi

  # **region は環境か、プロファイルの設定から解決する。** aws configure get は
  # AWS_PROFILE を見るので、ここで解決できなければ aws 本体でも解決できない。
  local region="${AWS_REGION:-${AWS_DEFAULT_REGION:-}}"
  if [[ -z "$region" ]]; then
    region="$(aws configure get region 2>/dev/null || true)"
  fi
  if [[ -z "$region" ]]; then
    echo "[deploy-orchestrator] region を解決できません（NoRegion になります）。" >&2
    echo "[deploy-orchestrator] 対処: export AWS_REGION=<リージョン>、または" >&2
    echo "[deploy-orchestrator]       ~/.aws/config のプロファイルへ region を書く" >&2
    missing=1
  fi

  if (( missing )); then
    echo "[deploy-orchestrator] **AWS へは 1 度も触れていません。** 前提が欠けています。" >&2
    return 2
  fi
  echo "[deploy-orchestrator] 前提 OK（profile=${AWS_PROFILE:-（環境の資格情報）} / region=${region}）"
  return 0
}

# **前提だけを見て終わる口**（--check-prerequisites）。
# AWS へも本番へも触れないので、手元でも CI でも安全に踏める。
if [[ "${1:-}" == "--check-prerequisites" ]]; then
  check_prerequisites
  exit $?
fi

check_prerequisites || exit 2

# **毎回束ね直す。** 手元の dist/ が古いまま載ると、直したはずの不具合が本番に
# 残る。束ね直しは 20 ms 程度で、省く理由が無い。
bash scripts/bundle-orchestrator.sh

SHA_LOCAL="$(openssl dgst -sha256 -binary "$ZIP" | base64)"

echo "[deploy-orchestrator] 現在載っているコードを確認します"
# **失敗を握りつぶさない。** 以前はここを `2>/dev/null || echo ''` で流していたため、
# 認証切れも関数の不在も「まだ何も載っていない」と同じ見た目になり、次の
# update-function-code が出す生のエラーだけが残った。**何を直せばよいかを言う。**
# **テンプレートを明示する。** BSD 系（macOS）の mktemp はテンプレート無しでは
# 失敗する。**この手順は利用者が自分の端末で叩く**（冒頭「誰が叩くか」）ので、
# 開発環境（Linux）でしか動かない書き方をここへ置かない。
# `$$` 由来の予測可能な名前も使わない（同名を先に置かれると書き込み先を乗っ取られる。
# scripts/acceptance-remote.sh と同じ規約）。
ERR="$(mktemp "${TMPDIR:-/tmp}/deploy-orchestrator.XXXXXX")" || {
  echo "[deploy-orchestrator] 一時ファイルを作成できませんでした。" >&2
  exit 1
}
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
