#!/usr/bin/env bash
# check-devhost.sh — 開発機のホストに置く道具（tools/devhost/）を、非対話で確かめる（#849）。
#
# 見るのは 2 つ。
#
#   1. **tools/devhost/ にこのプロジェクト固有の名前が無いこと。** 道具とユニットは、
#      2 つ目のプロジェクトを載せた時点で別のリポジトリへ複写で移す（#849 の決定）。
#      名前・パス・ホスト名は開発機の設定ファイル（雛形は projects.example）に置き、
#      道具には書かない。ファイルの中身とファイル名の両方を、大小を問わずに見る。
#      **禁止の綴りの表はこちら（scripts/）に置く。** 表を tools/devhost/ の中に置くと、
#      表そのものが固有の名前を持ち込むため。
#   2. **道具の自己試験（tools/devhost/selftest.sh）が通ること。** 偽の devcontainer /
#      docker / tmux / aws / systemctl を PATH に置き、ls / up / attach / auth / supervise が
#      設定ファイルのプロジェクトに対して正しいコマンドを組み立てること、未登録の名前を
#      拒むこと、設定ファイルが無い・壊れているときに止まることを見る（偽物の作りは
#      selftest.sh の冒頭）。
#
# **確かめないこと。** 開発機の実機での導入（devcontainer CLI・ユニット・linger）、再起動の後に
# コンテナが戻ること、docker kill の後にユニットが戻すこと、Termux からの通しは、実機と
# 利用者の端末が要るのでここでは見ない（#849 の acceptance で利用者が確かめる。手順は
# docs/local-dev.md の 7.9）。
#
# 終了コード: 0 = DEVHOST_PASS / 1 = 固有の名前が入った・自己試験が落ちた
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(dirname "$HERE")"
DIR="$ROOT/tools/devhost"

[[ -d "$DIR" ]] || { echo "[devhost] $DIR がありません。検査が成立しません。" >&2; exit 1; }

# このプロジェクト固有の綴り（拡張正規表現。大小を問わない）。ホストの名前・組織の名前・
# リポジトリの名前。利用者のホームのパス（/home/<名前>/）はリポジトリの名前を含むので
# 1 つ目で捕まる。
FORBIDDEN='game[-_ ]?forge|ojos|dev01'

fail=0
files=0
while IFS= read -r f; do
  files=$((files + 1))
  rel="${f#"$ROOT"/}"
  if printf '%s\n' "$rel" | grep -iqE "$FORBIDDEN"; then
    echo "[devhost] FAIL: ファイル名に固有の名前があります: $rel" >&2
    fail=1
  fi
  while IFS= read -r hit; do
    echo "[devhost] FAIL: $rel:$hit" >&2
    fail=1
  done < <(grep -inE "$FORBIDDEN" "$f" || true)
done < <(find "$DIR" -type f | sort)

if [[ "$files" -eq 0 ]]; then
  echo "[devhost] $DIR にファイルがありません。検査が成立しません。" >&2
  exit 1
fi
if [[ "$fail" -ne 0 ]]; then
  echo "[devhost] tools/devhost/ にこのプロジェクト固有の名前があります。名前・パス・ホスト名は開発機の設定ファイルへ置き、道具には書かないこと。" >&2
  exit 1
fi
echo "[devhost] tools/devhost/ の $files ファイルに固有の名前はありません"

bash "$DIR/selftest.sh"
echo "DEVHOST_PASS"
