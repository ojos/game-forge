#!/usr/bin/env bash
# acceptance-remote-scheduled.sh — 外部層の受け入れ検証を無人で 1 回回し、要約を固定の issue へ載せる（#844）
#
# **devcontainer の中で、プライマリ（/workspaces/game-forge）から回す。** 利用者の Mac の
# launchd が毎日 12:00 JST に scripts/acceptance-remote-launchd.sh を起こし、それが
# `docker exec` でこれを呼ぶ。手で 1 回回すこともできる（docs/acceptance-remote-schedule.md）。
#
#   bash scripts/acceptance-remote-scheduled.sh            # 回して投稿する
#   bash scripts/acceptance-remote-scheduled.sh --print    # 回して、投稿せずに要約を表示する
#   bash scripts/acceptance-remote-scheduled.sh --pr <N>   # terraform/ を触る PR の head で回し、その PR へ載せる（#845）
#
# ══════════════════════════════════════════════════════════════════════════════
# --pr <N>（terraform/ を触る PR の apply の後。#845）
# ══════════════════════════════════════════════════════════════════════════════
#
# apply は**マージの前に、プライマリを PR の head へ `--detach` で置いて**当てる（docs/handoff.md 3 章）。
# その同じツリーから外部層を回し、要約を PR へ載せる。.github/workflows/acceptance-remote-pr.yml が
# PR の head SHA と照らして判定する。手順は docs/acceptance-remote-schedule.md「terraform/ を触る PR」。
#
# 定期実行との違いは 3 つだけで、ほかの確認（汚れ・追跡外の宣言・state）と要約・検査は共有する。
#
#   - **プライマリの HEAD が PR の head と一致しなければ、回さず、投稿もしない**（終了コード 3）。
#     一致しない HEAD で回した記録は、PR のどの head も確かめていない。head は GitHub から読む。
#   - **プライマリを動かさない。** fetch も fast-forward もしない（定期実行と違う）。置くのは利用者で、
#     apply を当てたツリーそのものを確かめるのが目的である。
#   - 投稿先は固定の issue ではなく PR。要約に `pr: <N>` が付く。
#
# ══════════════════════════════════════════════════════════════════════════════
# 回す前に確かめること（ずれていれば検査を回さず「前提の不成立」として記録する）
# ══════════════════════════════════════════════════════════════════════════════
#
#   1. origin/main を取ってくる                                      → fetch-failed
#   2. プライマリが main にある（detach もブランチも不可）           → primary-not-on-main
#   3. 追跡ファイルに手元の変更が無く、terraform/ に追跡外の *.tf（override を含む）が無い
#                                                                       → primary-dirty
#   3b. terraform/terraform.tfstate がある（期待値の出どころ）            → state-missing
#   4. HEAD が origin/main と一致する。**遅れているだけなら fast-forward してから回す**
#      分岐している（ff できない）                                   → primary-not-at-origin-main
#      ff を試みて失敗した                                           → primary-ff-failed
#
# **古いツリーは、宣言を誤った期待値にする。** terraform も外部層の導出も、そのツリーの
# terraform/*.tf を正とする（docs/handoff.md 3 章「プライマリの作業ツリーは main に」。
# 実例 4 つ）。main から遅れたまま回すと、main で直した宣言を「乖離」と報告する。
#
# **fast-forward だけはする**（利用者の決定。PR #853）。main には毎日マージが入るので、
# 遅れを前提の不成立にすると、プライマリを毎日 pull しない限り定期実行が回らない。ff は
# 「main にいて・汚れておらず・追跡外の宣言も無く・HEAD が origin/main の祖先」のときだけで、
# 手元の作業を動かさない。ff したことはログ（要約の外）に残す。**checkout・reset・merge commit・
# 分岐の解消はしない。** プライマリは他のセッションも配備に使う場所で、無人の実行がそれ以上
# 動かすと、そちらの手順の前提が黙って変わる。
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
# #850（2026-10-01 にマージ。428a46a）から、知らない引数は終了コード 2 で止まる。定期実行は常に全体を回す。
#
# 終了コード: 0 = 記録した結果が ok / 1 = 記録した結果が ok 以外 / 3 = 要約を作れない・記録先が無い
#             （--pr では、PR を読めない・open でない・HEAD が PR の head と一致しない、も 3）/
#             4 = 投稿に失敗した（どちらも、CI の側では「記録が古い」「記録が無い」として見える）
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)" || exit 3
# shellcheck source=scripts/lib/acceptance-record.sh
. "$HERE/lib/acceptance-record.sh" || exit 3

print_only=0 pr=""
# 回す対象のツリー。既定はこのスクリプトのあるツリー（＝プライマリ）。差し替えは自己試験のため。
repo_dir="$(dirname "$HERE")"
while [ $# -gt 0 ]; do
  case "$1" in
    --print) print_only=1; shift ;;
    --repo-dir) repo_dir="${2:-}"; shift 2 ;;
    --pr) pr="${2:-}"; shift 2 ;;
    *) echo "[acceptance-remote-scheduled] 知らない引数です: $1" >&2; exit 3 ;;
  esac
done
if [ -n "$pr" ] && ! [[ "$pr" =~ ^[1-9][0-9]*$ ]]; then
  echo "[acceptance-remote-scheduled] --pr は PR の番号にしてください: $pr" >&2
  exit 3
fi
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
  # ラベルと系統の対応表は、回すツリー（ff した後のプライマリ）のものを読む。2 つは同じ commit で揃う。
  if ! bash "$HERE/acceptance-remote-summary.sh" --labels-from "scripts/acceptance-remote.sh" \
    --deps-from "scripts/lib/acceptance-remote-deps.tsv" --head "$head" --time "$when" ${pr:+--pr "$pr"} "$@" < "$WORK/output" > "$WORK/summary"; then
    say "要約を作れませんでした。記録していません。"
    return 3
  fi
  say "要約:"
  cat "$WORK/summary"
  if [ "$print_only" -eq 1 ]; then
    say "--print なので投稿しません。"
  elif [ -n "$pr" ]; then
    if ! gh pr comment "$pr" --body-file "$WORK/summary"; then
      say "PR #${pr} への投稿に失敗しました。"
      return 4
    fi
    say "PR #${pr} へ投稿しました。"
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
  if [ -n "$pr" ]; then
    # PR の head を確かめる前なので、PR へは何も載せない（どの head の記録とも言えない）。
    exit 3
  fi
  deliver --precondition not-a-git-tree; exit $?
fi
if [ -n "$pr" ]; then
  # **HEAD と PR の head の一致を、回す前に確かめる。** 一致しなければ回さず、載せない。
  # 載せた記録は確認側で head-mismatch になるだけだが、apply していないツリーの結果を
  # その PR の記録として残す理由が無い。
  if ! pr_info="$(gh pr view "$pr" --json state,headRefOid --jq '.state + " " + .headRefOid' 2>/dev/null)"; then
    say "PR #${pr} を読めません（gh の認証・番号を確かめてください）。検査を回しません。"
    exit 3
  fi
  pr_state="${pr_info%% *}" pr_head="${pr_info#* }"
  if [ "$pr_state" != OPEN ] || ! [[ "$pr_head" =~ ^[0-9a-f]{40}$ ]]; then
    say "PR #${pr} は open ではありません（${pr_state}）。検査を回しません。"
    exit 3
  fi
  if [ "$head" != "$pr_head" ]; then
    say "プライマリの HEAD（${head}）が PR #${pr} の head（${pr_head}）と一致しません。検査を回さず、投稿もしません。"
    say "プライマリで git fetch origin → git checkout --detach ${pr_head} → apply の後に回してください（docs/acceptance-remote-schedule.md）。"
    exit 3
  fi
  say "プライマリの HEAD は PR #${pr} の head と一致しています（${head}）。"
else
  if ! git fetch --quiet origin main; then
    say "origin の main を取得できません。検査を回しません。"
    deliver --precondition fetch-failed; exit $?
  fi
  branch="$(git symbolic-ref -q --short HEAD || true)"
  if [ "$branch" != "main" ]; then
    say "プライマリが main にありません（${branch:-detached}）。検査を回しません。"
    deliver --precondition primary-not-on-main; exit $?
  fi
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
# **state が無ければ回さない。** 外部層の検査の多くは期待値を terraform output（＝ state）から取り、
# state が無いと認証の前提が通っていても「output から取得できません」で落ちる（#808 の実測: state なし・
# 認証ありで 40 件中 6 件）。それを乖離（DRIFT）として記録しない（PR #853 の第二意見の指摘）。
# state は local backend の terraform/terraform.tfstate（terraform/versions.tf。追跡外でプライマリにだけある）。
if [ ! -s terraform/terraform.tfstate ]; then
  say "プライマリに terraform/terraform.tfstate がありません（空も含む）。検査を回しません。"
  deliver --precondition state-missing; exit $?
fi
# --pr では fast-forward しない（プライマリを動かさない。冒頭の「--pr <N>」）。
origin_main=""
[ -n "$pr" ] || origin_main="$(git rev-parse --verify -q refs/remotes/origin/main)"
if [ -z "$pr" ] && [ "$head" != "$origin_main" ]; then
  if ! git merge-base --is-ancestor "$head" "$origin_main"; then
    say "プライマリの main が origin/main から分岐しています（fast-forward できません）。検査を回しません。"
    deliver --precondition primary-not-at-origin-main; exit $?
  fi
  # git は更新したファイルを置き換える（新しい inode）。いま動いているこのスクリプトは
  # 古い中身のまま最後まで読まれ、ここから先で呼ぶ要約・検査は新しいツリーのものになる。
  say "プライマリの main が origin/main より遅れているので fast-forward します（${head} → ${origin_main}）。"
  if ! git merge --ff-only --quiet "$origin_main"; then
    say "fast-forward に失敗しました。検査を回しません。"
    deliver --precondition primary-ff-failed; exit $?
  fi
  head="$(git rev-parse --verify -q HEAD)"
  if [ "$head" != "$origin_main" ]; then
    say "fast-forward の後も origin/main と一致しません。検査を回しません。"
    deliver --precondition primary-ff-failed; exit $?
  fi
  say "fast-forward しました（HEAD ${head}）。"
fi

# ── 検査（全体。引数は渡さない）───────────────────────────────────────────────
#
# **宣言の場所の差し替え（ACCEPTANCE_TF_DIR。scripts/lib/tf-dir.sh）を外す。** .env や
# コンテナの環境に残っていると、上で確かめたプライマリの terraform/ ではなく、差し替え先の
# 宣言と state を正として記録する（PR の第二意見の指摘）。定期実行も --pr も、見るのはプライマリだけである。
if [ -n "${ACCEPTANCE_TF_DIR:-}" ]; then
  say "ACCEPTANCE_TF_DIR が設定されていました。定期実行ではプライマリの terraform/ を見るため外します。"
  unset ACCEPTANCE_TF_DIR
fi
say "bash scripts/acceptance-remote.sh を回します（HEAD ${head}）"
# stdout と stderr を 1 本にする。ラベルは stdout、FAIL の行は stderr に出るため。
bash scripts/acceptance-remote.sh 2>&1 | tee "$WORK/output"
rc="${PIPESTATUS[0]}"
say "acceptance-remote.sh の終了コード: ${rc}"

deliver --exit "$rc"
exit $?
