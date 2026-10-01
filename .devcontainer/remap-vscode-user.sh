#!/usr/bin/env bash
# remap-vscode-user.sh — イメージの vscode ユーザーの UID/GID を、ビルド引数の値へ付け替える（#802）。
#
# `.devcontainer/Dockerfile` がイメージのビルド中に root で 1 回だけ呼ぶ。
#
# **なぜ要るのか。** ネイティブ Linux の Docker Engine（dev01）は、bind mount の所有者を
# **数値の UID のまま**コンテナへ通す。dev01 の利用者は uid=1001 で、ベースイメージの
# vscode は 1000 なので、そのままではワークスペースへ書き込めない。Docker Desktop for Mac は
# ファイル共有層が所有者を写すため、この問題が起きない（Mac は既定の 1000 のまま）。
#
# **なぜ devcontainer.json の `updateRemoteUserUID` に任せないのか。** あれは
# image / Dockerfile 方式の構成にしか効かず、この devcontainer は dockerComposeFile 方式である。
# そのため compose の build 引数で値を受け取り、ここで付け替える。
#
# **値が既に一致していれば何もしない。** 既定（1000/1000）のビルドは、この段を通っても
# ベースイメージと同じユーザーのままになる（Mac の既存挙動を変えない）。
#
# **他のユーザー・グループが既にその番号を使っていたら落とす。** 重複（`-o`）で通すと、
# 同じ番号に 2 つの名前が付き、ファイルの所有者の表示と実体が食い違って原因が見えなくなる。
#
# 使い方: remap-vscode-user.sh <UID> <GID>
# 終了コード: 0 = 付け替えた／付け替え不要 / 1 = 引数の誤り・番号の衝突
set -euo pipefail

readonly USER_NAME="vscode"

die() { echo "[remap-vscode-user] ERROR: $*" >&2; exit 1; }

want_uid="${1:-}"
want_gid="${2:-}"
[[ "$want_uid" =~ ^[0-9]+$ ]] || die "UID が数値ではありません: '${want_uid}'"
[[ "$want_gid" =~ ^[0-9]+$ ]] || die "GID が数値ではありません: '${want_gid}'"

cur_uid="$(id -u "$USER_NAME")"
cur_gid="$(id -g "$USER_NAME")"

if [[ "$cur_uid" == "$want_uid" && "$cur_gid" == "$want_gid" ]]; then
  echo "[remap-vscode-user] ${USER_NAME} は既に ${want_uid}:${want_gid} です。付け替えません"
  exit 0
fi

# 衝突は、何かを変える前に両方とも確かめる。
if [[ "$cur_gid" != "$want_gid" ]] && other="$(getent group "$want_gid")"; then
  die "GID ${want_gid} は既に別のグループが使っています: ${other%%:*}"
fi
if [[ "$cur_uid" != "$want_uid" ]] && other="$(getent passwd "$want_uid")"; then
  die "UID ${want_uid} は既に別のユーザーが使っています: ${other%%:*}"
fi

if [[ "$cur_gid" != "$want_gid" ]]; then
  groupmod --gid "$want_gid" "$USER_NAME"
fi
usermod --uid "$want_uid" --gid "$want_gid" "$USER_NAME"

# usermod はホームの中の所有者を付け替えるが、グループまで揃う保証は版に依るので明示する。
chown -R "${want_uid}:${want_gid}" "/home/${USER_NAME}"
echo "[remap-vscode-user] ${USER_NAME} を ${cur_uid}:${cur_gid} から ${want_uid}:${want_gid} へ付け替えました"
