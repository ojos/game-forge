#!/usr/bin/env bash
# deploy-avatar.sh — アイコンの再エンコード関数（Lambda）へコードを載せる（#380）
#
# **器（関数・ロール・許可）は terraform/avatar-function.tf が持つ。** このスクリプトが持つのは
# コードの配備だけである（宣言側はコードを ignore_changes に入れており、配備のたびに plan へ差分が
# 出ない。scripts/deploy-orchestrator.sh と同じ形）。
#
# ## 何を載せるか
#
# `lambda/avatar-encode/` の 3 ファイル（index.mjs / config.mjs / encode.mjs）と、**Lambda の実行環境
# （Linux・x86_64・glibc）向けの sharp** を入れた zip である。**手元の node_modules を使わない**
# ——開発環境は arm64 で、sharp はネイティブのライブラリなので、そのまま載せると関数が起動しない。
# `npm ci --os=linux --cpu=x64 --libc=glibc` で、関数の package-lock.json が指す版を入れ直す。
#
# ## 誰が叩くか
#
# **利用者が自分の端末で叩く。** AI エージェントの実行環境は本番への書き込みを拒否する。
#
# 前提:
#   - AWS へ認証済みであること（aws sso login --profile game-forge-prod --use-device-code）
#   - AWS_PROFILE が本番アカウントを指していること
#   - **terraform apply で関数が既に存在すること**（プライマリの作業ツリーから。docs/handoff.md 3 章）
#   - npm と zip があること（npm registry から sharp の Linux 版を取る）
#
# 使い方:
#   export AWS_PROFILE=game-forge-prod
#   bash scripts/deploy-avatar.sh
#   bash scripts/deploy-avatar.sh --build-only   # zip を作るだけ（AWS に触れない）
#
# 終了コード: 0 = 成功（DEPLOY_PASS）/ 非0 = 失敗
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$(dirname "$HERE")"

export AWS_PAGER=""

FUNCTION_NAME="${AVATAR_FUNCTION_NAME:-game-forge-avatar}"
SOURCE_DIR="lambda/avatar-encode"
ZIP="dist/avatar-encode.zip"

for tool in npm zip openssl; do
  command -v "$tool" >/dev/null 2>&1 || {
    echo "[deploy-avatar] ${tool} がありません。" >&2
    exit 1
  }
done

##
# zip を作る（AWS に触れない）。
#
# **作業用の複製で `npm ci` する。** 関数のディレクトリに node_modules を作ると、ルートの
# vitest や型検査の探索に紛れ込み、手元の検査が別の sharp を掴む。
##
WORK=""
ERR=""
trap 'rm -rf "$WORK" "$ERR"' EXIT

build_zip() {
  local work
  WORK="$(mktemp -d "${TMPDIR:-/tmp}/deploy-avatar.XXXXXX")" || {
    echo "[deploy-avatar] 一時ディレクトリを作成できませんでした。" >&2
    return 1
  }
  work="$WORK"
  cp "$SOURCE_DIR/index.mjs" "$SOURCE_DIR/config.mjs" "$SOURCE_DIR/encode.mjs" \
    "$SOURCE_DIR/package.json" "$SOURCE_DIR/package-lock.json" "$work/"
  # **`--ignore-scripts`**: sharp は同梱の実行ファイル（@img/sharp-linux-x64）を使い、導入時の
  # スクリプトを要らない。走らせないことで、手元の OS 向けに作り直されるのを防ぐ。
  (cd "$work" && npm ci --omit=dev --os=linux --cpu=x64 --libc=glibc --ignore-scripts --no-audit --no-fund)
  # **本体と libvips の両方を見る。** libvips は glibc 向けの別パッケージで、npm が `--libc` を解さない版だと
  # 手元（macOS）の判定で黙って落とされる。落ちた zip は関数の起動の時点で「sharp を読めない」で落ちる。
  local package
  for package in sharp-linux-x64 sharp-libvips-linux-x64; do
    if [[ ! -d "$work/node_modules/@img/${package}" ]]; then
      echo "[deploy-avatar] Linux x64（glibc）向けの @img/${package} が入っていません。" >&2
      echo "[deploy-avatar] npm の --os / --cpu / --libc が効いていない可能性があります（npm --version を確かめること）。" >&2
      return 1
    fi
  done
  mkdir -p "$(dirname "$ZIP")"
  rm -f "$ZIP"
  local zip_path
  zip_path="$(pwd)/$ZIP"
  (cd "$work" && zip -qr -X "$zip_path" index.mjs config.mjs encode.mjs package.json node_modules)
  echo "[deploy-avatar] zip を作りました: $ZIP（$(wc -c <"$ZIP" | tr -d ' ') バイト）"
}

build_zip

if [[ "${1:-}" == "--build-only" ]]; then
  echo "BUILD_PASS"
  exit 0
fi

command -v aws >/dev/null 2>&1 || {
  echo "[deploy-avatar] aws CLI がありません。" >&2
  exit 1
}
if ! bash scripts/deploy-orchestrator.sh --check-prerequisites >/dev/null; then
  # **前提の検査はオーケストレータの配備と同じものを使う**（profile と環境の資格情報の食い違い・region）。
  bash scripts/deploy-orchestrator.sh --check-prerequisites || true
  echo "[deploy-avatar] **AWS へは 1 度も触れていません。** 前提が欠けています。" >&2
  exit 2
fi

SHA_LOCAL="$(openssl dgst -sha256 -binary "$ZIP" | base64)"

ERR="$(mktemp "${TMPDIR:-/tmp}/deploy-avatar-err.XXXXXX")" || {
  echo "[deploy-avatar] 一時ファイルを作成できませんでした。" >&2
  exit 1
}
if ! SHA_REMOTE="$(aws lambda get-function-configuration \
  --function-name "$FUNCTION_NAME" \
  --query 'CodeSha256' --output text 2>"$ERR")"; then
  echo "[deploy-avatar] 関数の情報を読めませんでした: $FUNCTION_NAME" >&2
  cat "$ERR" >&2
  echo "[deploy-avatar] 認証と、器の作成（プライマリの作業ツリーからの terraform apply）が済んでいるか確認してください。" >&2
  exit 1
fi

# **zip は作るたびにハッシュが変わる**（npm の展開の時刻が入る）ので、「同じコードなら載せない」の
# 判定はしない。載せたあとに、載ったものが手元の zip と一致することだけを見る。
echo "[deploy-avatar] 載せ替えます: ${SHA_REMOTE:-none} -> $SHA_LOCAL"

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
  echo "[deploy-avatar] 載ったコードが手元と一致しません: $SHA_AFTER != $SHA_LOCAL" >&2
  exit 1
fi

echo "[deploy-avatar] 完了（CodeSha256: $SHA_AFTER）"
echo "DEPLOY_PASS"
