#!/usr/bin/env bash
# check-devhost.sh — 開発機のホストに置く game-forge 固有の差分（tools/devhost/）を、非対話で
# 確かめる（#849 で作り、#923 で上流の版へ寄せたのに合わせて縮めた）。
#
# devhost の本体（dev / dev-up@.service / 雛形）は、ojos/devcontainer-host のリリースの上流の版を使い
# （DCB v0.17.0 までは DCB のリリースに同梱されていた。#953）、このリポジトリには置かない。ここに残るのは、AWS SSO に入る薄い追加
# （dev-auth-aws.sh）と、その自己試験と、README だけである。
#
# 見るのは 3 つ。
#
#   1. **tools/devhost/ に決まった 3 つのファイルしか無いこと。** 上流の版を写すと二重管理になる
#      （#923 の constraints）。dev.sh などを写し戻したら、ここで赤にする。
#   2. **スクリプトにこのプロジェクト固有の名前が無いこと。** 名前・パス・セッション名は、ホストの
#      設定ファイル（~/.config/dev/aws-sso）から読み、道具には書かない。ファイルの中身とファイル名の
#      両方を、大小を問わずに見る。**README は見ない。** README は上流のリリースの URL（組織の名前を含む）と、
#      dev01 の移行手順（ホスト名・プロジェクトの名前）を書くための、このプロジェクト固有の文書だからである
#      （#849 の頃は、道具一式を別のリポジトリへ複写で移す前提で README も中立に保っていた。移す先は
#      上流の版として既にある）。**禁止の綴りの表はこちら（scripts/）に置く。** 表を tools/devhost/ の中に
#      置くと、表そのものが固有の名前を持ち込むため。
#   3. **薄い追加の自己試験（tools/devhost/dev-auth-aws.selftest.sh）が通ること。** 偽の devcontainer /
#      docker / aws を PATH に置き、コンテナの中で aws sso login を正しい引数で呼ぶこと、コンテナが
#      止まっていれば打たずに止まること、使い方と設定の誤りを拒むことを見る。
#
# **確かめないこと。** 上流の版そのもの（上流の自己試験が見る）と、dev01 の実機での導入・認証の通しは
# ここでは見ない（#923 の acceptance で利用者が確かめる。手順は tools/devhost/README.md）。
#
# 終了コード: 0 = DEVHOST_PASS / 1 = 決まった以外のファイルがある・固有の名前が入った・自己試験が落ちた
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(dirname "$HERE")"
DIR="$ROOT/tools/devhost"

[[ -d "$DIR" ]] || { echo "[devhost] $DIR がありません。検査が成立しません。" >&2; exit 1; }

# 置いてよいファイル（tools/devhost/ からの相対）。
ALLOWED="README.md
dev-auth-aws.sh
dev-auth-aws.selftest.sh"

# 固有の名前を見るファイル（README を除くスクリプト）。
SCRIPTS="dev-auth-aws.sh
dev-auth-aws.selftest.sh"

# このプロジェクト固有の綴り（拡張正規表現。大小を問わない）。ホストの名前・組織の名前・
# リポジトリの名前。利用者のホームのパス（/home/<名前>/）はリポジトリの名前を含むので
# 1 つ目で捕まる。SSO のセッション名（組織の名前と同じ綴り）も 2 つ目で捕まる。
FORBIDDEN='game[-_ ]?forge|ojos|dev01'

fail=0
files=0
while IFS= read -r f; do
  files=$((files + 1))
  rel="${f#"$DIR"/}"
  if ! printf '%s\n' "$ALLOWED" | grep -qxF -- "$rel"; then
    echo "[devhost] FAIL: 決まった以外のファイルがあります: tools/devhost/$rel（上流の版は写さない。#923）" >&2
    fail=1
  fi
done < <(find "$DIR" \( -type f -o -type l \) | sort)

if [[ "$files" -eq 0 ]]; then
  echo "[devhost] $DIR にファイルがありません。検査が成立しません。" >&2
  exit 1
fi

while IFS= read -r rel; do
  f="$DIR/$rel"
  if [[ ! -f "$f" ]]; then
    echo "[devhost] FAIL: あるはずのファイルがありません: tools/devhost/$rel" >&2
    fail=1
    continue
  fi
  if printf '%s\n' "$rel" | grep -iqE "$FORBIDDEN"; then
    echo "[devhost] FAIL: ファイル名に固有の名前があります: tools/devhost/$rel" >&2
    fail=1
  fi
  while IFS= read -r hit; do
    echo "[devhost] FAIL: tools/devhost/$rel:$hit" >&2
    fail=1
  done < <(grep -inE "$FORBIDDEN" "$f" || true)
done <<<"$SCRIPTS"

[[ -f "$DIR/README.md" ]] || { echo "[devhost] FAIL: あるはずのファイルがありません: tools/devhost/README.md" >&2; fail=1; }

if [[ "$fail" -ne 0 ]]; then
  echo "[devhost] tools/devhost/ の検査が落ちました。置いてよいのは README.md と dev-auth-aws.sh とその自己試験だけで、スクリプトには名前・パス・ホスト名を書かないこと（ホストの設定ファイルへ置く）。" >&2
  exit 1
fi
echo "[devhost] tools/devhost/ は決まった $files ファイルだけで、スクリプトに固有の名前はありません"

bash "$DIR/dev-auth-aws.selftest.sh"
echo "DEVHOST_PASS"
