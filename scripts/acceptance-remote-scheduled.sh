#!/usr/bin/env bash
# acceptance-remote-scheduled.sh — 外部層の受け入れ検証を無人で 1 回回し、要約を固定の issue へ載せる（#844）
#
# **devcontainer の中で、プライマリ（/workspaces/game-forge）から回す。** 利用者の Mac の
# launchd が毎日 12:00 JST に scripts/acceptance-remote-launchd.sh を起こし、それが
# `docker exec` でこれを呼ぶ。手で 1 回回すこともできる（docs/acceptance-remote-schedule.md）。
#
#   bash scripts/acceptance-remote-scheduled.sh            # 回して投稿する
#   bash scripts/acceptance-remote-scheduled.sh --print    # 回して、投稿せずに要約を表示する
#
# ══════════════════════════════════════════════════════════════════════════════
# 回す前に確かめること（ずれていれば検査を回さず「前提の不成立」として記録する）
# ══════════════════════════════════════════════════════════════════════════════
#
#   1. プライマリが main にある（detach もブランチも不可）       → primary-not-on-main
#   2. origin/main を取ってきて、HEAD がそれと一致する            → fetch-failed / primary-not-at-origin-main
#   3. 追跡ファイルに手元の変更が無く、terraform/ に追跡外の *.tf（override を含む）が無い
#                                                                   → primary-dirty
#
# **古いツリーは、宣言を誤った期待値にする。** terraform も外部層の導出も、そのツリーの
# terraform/*.tf を正とする（docs/handoff.md 3 章「プライマリの作業ツリーは main に」。
# 実例 4 つ）。main から遅れたまま回すと、main で直した宣言を「乖離」と報告する。
#
# **ここでは直さない（pull も checkout もしない）。** プライマリは他のセッションも配備に使う
# 場所で、無人の実行が動かすと、そちらの手順の前提が黙って変わる。判定と修復は混ぜない。
#
# ══════════════════════════════════════════════════════════════════════════════
# 何をどこへ出すか
# ══════════════════════════════════════════════════════════════════════════════
#
#   標準出力  acceptance-remote.sh の出力の全文・要約・投稿の結果。launchd の起動側が
#             Mac の ~/Library/Logs/game-forge/acceptance-remote/ へ書く。**値を含むのはここだけ。**
#   issue     scripts/acceptance-remote-summary.sh の要約だけ（ラベル・合否・件数・時刻・HEAD）
#
# **acceptance-remote.sh に引数を渡さない。** `--only` などの絞り込みは外部層の合格にならず、
# #850（2026-09-30 時点で未マージ）が入ると、知らない引数は終了コード 2 で止まる。定期実行は常に全体を回す。
#
# 終了コード: 0 = 記録した結果が ok / 1 = 記録した結果が ok 以外 / 3 = 要約を作れない・記録先が無い /
#             4 = 投稿に失敗した（どちらも、CI の側では「記録が古い」として見える）
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)" || exit 3
# shellcheck source=scripts/lib/acceptance-record.sh
. "$HERE/lib/acceptance-record.sh" || exit 3

print_only=0
# 回す対象のツリー。既定はこのスクリプトのあるツリー（＝プライマリ）。差し替えは自己試験のため。
repo_dir="$(dirname "$HERE")"
while [ $# -gt 0 ]; do
  case "$1" in
    --print) print_only=1; shift ;;
    --repo-dir) repo_dir="${2:-}"; shift 2 ;;
    *) echo "[acceptance-remote-scheduled] 知らない引数です: $1" >&2; exit 3 ;;
  esac
done
cd "$repo_dir" || { echo "[acceptance-remote-scheduled] $repo_dir へ移れません" >&2; exit 3; }

say() { printf '[acceptance-remote-scheduled] %s\n' "$*"; }

# .env を載せる（GH_TOKEN と CLOUDFLARE_API_TOKEN）。**確認より前に置く**——前提の不成立の
# 記録も gh で投稿するので、GH_TOKEN が要る（.github/project-ai-rules.md「GitHub 認証（gh）
# だけを例外にする理由」）。CLOUDFLARE_API_TOKEN は terraform が読む（docs/handoff.md 3 章）。
if [ -f scripts/load-project-env.sh ]; then
  set -a
  # shellcheck source=scripts/load-project-env.sh disable=SC1091
  . scripts/load-project-env.sh
  set +a
fi

when="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
say "開始 ${when}（$(pwd)）"

WORK="$(mktemp -d "${TMPDIR:-/tmp}/acceptance-scheduled.XXXXXX")" || exit 3
trap 'rm -rf "$WORK"' EXIT

# 要約を作って、投稿（または表示）する。引数は acceptance-remote-summary.sh へそのまま渡す。
deliver() {
  if ! bash "$HERE/acceptance-remote-summary.sh" --labels-from "scripts/acceptance-remote.sh" \
    --head "$head" --time "$when" "$@" < "$WORK/output" > "$WORK/summary"; then
    say "要約を作れませんでした。記録していません。"
    return 3
  fi
  say "要約:"
  cat "$WORK/summary"
  if [ "$print_only" -eq 1 ]; then
    say "--print なので投稿しません。"
  else
    if [ -z "$ACCEPTANCE_RECORD_ISSUE" ]; then
      say "記録先の issue が未設定です（scripts/lib/acceptance-record.sh の ACCEPTANCE_RECORD_ISSUE）。記録していません。"
      return 3
    fi
    if ! gh issue comment "$ACCEPTANCE_RECORD_ISSUE" --body-file "$WORK/summary"; then
      say "issue #${ACCEPTANCE_RECORD_ISSUE} への投稿に失敗しました。"
      return 4
    fi
    say "issue #${ACCEPTANCE_RECORD_ISSUE} へ投稿しました。"
  fi
  if grep -qx 'result: ok' "$WORK/summary"; then
    return 0
  fi
  return 1
}

: > "$WORK/output"
head=0000000000000000000000000000000000000000

# ── 回す前の確認 ─────────────────────────────────────────────────────────────
if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1 || ! head="$(git rev-parse --verify -q HEAD)"; then
  head=0000000000000000000000000000000000000000
  say "git の作業ツリーではありません。検査を回しません。"
  deliver --precondition not-a-git-tree; exit $?
fi
if ! git fetch --quiet origin main; then
  say "origin の main を取得できません。検査を回しません。"
  deliver --precondition fetch-failed; exit $?
fi
branch="$(git symbolic-ref -q --short HEAD || true)"
if [ "$branch" != "main" ]; then
  say "プライマリが main にありません（${branch:-detached}）。検査を回しません。"
  deliver --precondition primary-not-on-main; exit $?
fi
if [ "$head" != "$(git rev-parse --verify -q refs/remotes/origin/main)" ]; then
  say "プライマリの main が origin/main と一致しません（git pull --ff-only が要ります）。検査を回しません。"
  deliver --precondition primary-not-at-origin-main; exit $?
fi
if ! git diff --quiet HEAD --; then
  say "プライマリの追跡ファイルに手元の変更があります。検査を回しません。"
  deliver --precondition primary-dirty; exit $?
fi
# **追跡していない宣言も汚れに数える。** `git diff` は追跡外を見ないが、terraform は
# terraform/ 直下の *.tf と *.tf.json を全部読む。`.gitignore` は `override.tf` と
# `*_override.tf` を除外しているので、置いてあれば HEAD が origin/main と一致していても
# plan の中身が変わる（PR の第二意見の指摘）。terraform.tfvars と state は追跡外が正なので見ない。
# `:(glob)` にしているのは、`*` が `/` を越えて terraform/.terraform/ の中のモジュールまで拾わないため。
untracked_tf="$(git ls-files --others -- ':(glob)terraform/*.tf' ':(glob)terraform/*.tf.json')"
if [ -n "$untracked_tf" ]; then
  say "プライマリの terraform/ に追跡していない宣言があります（override を含む）。検査を回しません。"
  printf '%s\n' "$untracked_tf"
  deliver --precondition primary-dirty; exit $?
fi

# ── 検査（全体。引数は渡さない）───────────────────────────────────────────────
say "bash scripts/acceptance-remote.sh を回します（HEAD ${head}）"
# stdout と stderr を 1 本にする。ラベルは stdout、FAIL の行は stderr に出るため。
bash scripts/acceptance-remote.sh 2>&1 | tee "$WORK/output"
rc="${PIPESTATUS[0]}"
say "acceptance-remote.sh の終了コード: ${rc}"

deliver --exit "$rc"
exit $?
