#!/usr/bin/env bash
# fix-mount-owner.sh — 永続 named volume のマウント先を remoteUser 所有へ戻す。
#
# 空の named volume を初回マウントすると、マウントポイントは Docker デーモン
# （root）により root:root 所有で作られる。remoteUser が書き込めず、
# `gh auth login` や AI CLI のログインが Permission denied で落ちる。
#
# 対象は AI ツールに限らない。gh / aws / gcloud の認証ディレクトリも永続化する。
# ネストしたマウント先（~/.config/gh、~/.config/gcloud）は親 ~/.config が
# 先に root:root で作られる経路があるため、親も対象に含める。
#
# 終了コードは常に 0。ここで落ちると postCreate が止まり、CLI 導入まで到達しない。
# 「認証はできないが環境は立ち上がる」ほうが、原因の切り分けができるぶん実害が小さい。
# 失敗は WARN として標準エラーへ出す（握りつぶさない）。
set -uo pipefail

log()  { echo "[fix-mount-owner] $*"; }
warn() { echo "[fix-mount-owner] WARN: $*" >&2; }

# sudo は -n（非対話）で使う。パスワードを要求する環境で -n を落とすと、
# postCreate が入力待ちのまま固まり、原因が見えない形で rebuild が終わらなくなる。
sudo_chown() {
  local recursive="$1" target="$2"
  if ! command -v sudo >/dev/null 2>&1; then
    warn "sudo not available; cannot fix owner of $target"
    return 1
  fi
  if [[ "$recursive" == "recursive" ]]; then
    sudo -n chown -R "$(id -un):$(id -gn)" "$target" 2>/dev/null
  else
    sudo -n chown "$(id -un):$(id -gn)" "$target" 2>/dev/null
  fi
}

owned_by_me() {
  local owner
  owner="$(stat -c %U "$1" 2>/dev/null || stat -f %Su "$1" 2>/dev/null || echo '')" # bsd-ok: GNU の -c と BSD の -f を両方試している
  [[ "$owner" == "$(id -un)" ]]
}

# 親ディレクトリは非再帰で直す。~/.config 配下には他ツールの設定も入るため、
# 再帰 chown で無関係なファイルの所有権まで書き換えない。
fix_parent() {
  local parent="$1"
  [[ -d "$parent" ]] || return 0
  # $HOME 自身と / は対象外。ここを再帰的に遡ると影響範囲が読めなくなる。
  [[ "$parent" != "$HOME" && "$parent" != "/" ]] || return 0
  owned_by_me "$parent" && return 0
  if sudo_chown shallow "$parent"; then
    log "fixed owner of $parent (non-recursive)"
  else
    warn "failed to fix owner of $parent"
  fi
}

fix_mount() {
  local dir="$1"
  # マウントされていないディレクトリは触らない。
  if [[ ! -d "$dir" ]]; then
    log "$dir does not exist, skipping"
    return 0
  fi
  fix_parent "$(dirname "$dir")"
  # 既に現ユーザー所有なら再帰 chown を避ける（冪等・不要な再帰 I/O 回避）。
  if owned_by_me "$dir"; then
    log "$dir already owned by $(id -un), skipping"
    return 0
  fi
  if sudo_chown recursive "$dir"; then
    log "fixed owner of $dir -> $(id -un):$(id -gn)"
  else
    warn "failed to fix owner of $dir"
  fi
}

fix_mount "/home/vscode/.config/gh"
fix_mount "/home/vscode/.aws"
fix_mount "/home/vscode/.config/gcloud"
fix_mount "/home/vscode/.claude"
fix_mount "/home/vscode/.gemini"
log "done"
exit 0