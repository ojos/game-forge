#!/usr/bin/env bash
set -euo pipefail
echo "[check] bootstrap checks"
for cmd in bash jq gh docker rg; do
  command -v "$cmd" >/dev/null 2>&1 && echo "[check] $cmd OK" || echo "[check] $cmd missing"
done

# 認証状態を保持するディレクトリが named volume として実際にマウントされているかを見る。
# 定義したのにマウントされていない状態（compose の編集ミス、devcontainer.json が別
# サービスを指している等）は、CLI が入っていて動くぶん気づきにくく、rebuild のたびに
# 静かにログインが消える形で表面化する。
#
# /proc/mounts を引くのは、mountpoint コマンドが無いベースイメージがあるため。
# 判定できない環境（/proc/mounts を読めない等）は「不明」として素通りさせる。
check_mounted() {
  local dir="$1" vol="$2"
  if [[ ! -r /proc/mounts ]]; then
    echo "[check] $vol unknown (cannot read /proc/mounts)"
    return 0
  fi
  if awk -v d="$dir" '$2 == d { found = 1 } END { exit found ? 0 : 1 }' /proc/mounts; then
    echo "[check] $vol mounted at $dir"
  else
    echo "[check] WARN: $vol not mounted at $dir (認証状態は rebuild で失われます)" >&2
  fi
}
check_mounted "/home/vscode/.config/gh" "gh-storage"
check_mounted "/home/vscode/.aws" "aws-storage"
check_mounted "/home/vscode/.config/gcloud" "gcloud-storage"
check_mounted "/home/vscode/.claude" "claude-storage"
check_mounted "/home/vscode/.gemini" "gemini-storage"
command -v node >/dev/null 2>&1 && echo "[check] node OK" || echo "[check] node missing"
command -v go >/dev/null 2>&1 && echo "[check] go OK" || echo "[check] go missing"
command -v aws >/dev/null 2>&1 && echo "[check] aws OK" || echo "[check] aws missing"
command -v gcloud >/dev/null 2>&1 && echo "[check] gcloud OK" || echo "[check] gcloud missing"
command -v terraform >/dev/null 2>&1 && echo "[check] terraform OK" || echo "[check] terraform missing"
command -v claude >/dev/null 2>&1 && echo "[check] claude OK" || echo "[check] claude missing"
command -v agy >/dev/null 2>&1 && echo "[check] agy OK" || echo "[check] agy missing"