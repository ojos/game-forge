#!/usr/bin/env bash
# install-uv.sh — devcontainer へ uv を、版とチェックサムを固定して入れる（#956）
#
# 使い方: bash scripts/install-uv.sh
#   devcontainer の postCreateCommand から呼ぶ。手で打ってもよい（固定した版が既にあれば何もしない）。
#
# **なぜ要るのか。** 月次の運営報告の推敲の段（scripts/ops-report-draft.sh）が、
# .claude/skills/natural-japanese/ の scripts/lint.py などを `uv run` で動かすため。
#
# **版を固定する理由。** 配布元のインストーラ（curl … | sh）は最新版を入れるので、
# 作り直すたびに違う版が入り、公開から日の浅い版も入りうる。ここでは**公開から 2 週間以上たった版**を選び、
# アーキテクチャごとのチェックサムを書いておき、合わなければ置かない（#956 の constraints）。
#   0.12.17: 2026-09-18 公開。チェックサムは GitHub のリリースの .sha256・リリースの API の digest・
#            取得した実物の sha256sum の 3 つが一致することを 2026-10-09 に確かめた。
#
# 版を上げるときは、UV_VERSION と 2 つの SHA256 を同じコミットで直し、scripts/post-rebuild-check.sh の
# 期待する版も合わせる（post-rebuild-check は UV_VERSION をこのファイルから読む）。
#
# 置き場所は ~/.local/bin（PATH に入っている）。~/.local は volume ではないので、作り直すと消え、
# postCreateCommand がまた入れる。
#
# 終了コード: 0 = 入った（または既に固定した版がある）/ 1 = 入れられない（未対応のアーキテクチャ・
#             取得の失敗・チェックサムの不一致）
set -euo pipefail

readonly UV_VERSION="0.12.17"
readonly UV_SHA256_X86_64="fa82fd8dde8e8eefdecada6aa0889666556cfceb690d06e0c3bca49eb3070a63"
readonly UV_SHA256_AARCH64="d636d1b678e9e7f367ecb22b46bd1cabbed234d6bc3b4d96365d2b507f72f86c"
readonly PREFIX="[install-uv]"
readonly DEST="${HOME}/.local/bin"

# 置いてある uv の版を返す（無ければ空）。
#
# @return 標準出力に版（例: 0.12.17）
installed_version() {
  if [[ -x "$DEST/uv" ]]; then
    "$DEST/uv" --version 2>/dev/null | awk '{ print $2 }'
  fi
}

if [[ "$(installed_version)" == "$UV_VERSION" ]]; then
  echo "$PREFIX uv ${UV_VERSION} is already installed, skipping"
  exit 0
fi

case "$(uname -m)" in
  x86_64|amd64)  arch="x86_64";  want="$UV_SHA256_X86_64" ;;
  aarch64|arm64) arch="aarch64"; want="$UV_SHA256_AARCH64" ;;
  *)
    echo "$PREFIX error: 未対応のアーキテクチャです: $(uname -m)" >&2
    exit 1
    ;;
esac

name="uv-${arch}-unknown-linux-gnu"
url="https://github.com/astral-sh/uv/releases/download/${UV_VERSION}/${name}.tar.gz"
work="$(mktemp -d "${TMPDIR:-/tmp}/install-uv.XXXXXX")"
trap 'rm -rf -- "$work"' EXIT

echo "$PREFIX installing uv ${UV_VERSION} (${arch}) ..."
if ! curl -fsSL --retry 3 -o "$work/uv.tar.gz" "$url"; then
  echo "$PREFIX error: 取得できません: ${url}" >&2
  exit 1
fi
got="$(openssl dgst -sha256 -r "$work/uv.tar.gz" | awk '{ print $1 }')"
if [[ "$got" != "$want" ]]; then
  echo "$PREFIX error: チェックサムが合いません（期待 ${want} / 実際 ${got}）。置きません" >&2
  exit 1
fi
tar -xzf "$work/uv.tar.gz" -C "$work"
mkdir -p "$DEST"
install -m 0755 "$work/$name/uv" "$DEST/uv"
install -m 0755 "$work/$name/uvx" "$DEST/uvx"

if [[ "$(installed_version)" != "$UV_VERSION" ]]; then
  echo "$PREFIX error: 置いた uv が ${UV_VERSION} を返しません" >&2
  exit 1
fi
echo "$PREFIX uv installed: $DEST/uv ($UV_VERSION)"
