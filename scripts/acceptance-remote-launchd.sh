#!/bin/bash
# acceptance-remote-launchd.sh — launchd から呼ばれ、devcontainer を起こして外部層の定期実行を回す（#844）
#
# **これだけは利用者の Mac のホストで動く**（launchd の子）。devcontainer の中ではない。
#
#   - **macOS の /bin/bash 3.2 で動くこと。** mapfile・連想配列・${var,,} を使わない
#     （docs/handoff.md 3 章「mapfile（bash 4+）依存が残っています」）。検査の本体を
#     ホストで回さないのもそのためで、ここは起こして渡すだけにする。
#   - **認証はホストに無い。** ~/.aws・~/.config/gcloud・~/.config/gh は Docker のボリュームに
#     あり（.devcontainer/compose.yaml）、コンテナの中からしか見えない。
#
# 流れ:
#   1. Docker が動いていなければ Docker Desktop を起こして待つ
#   2. このリポジトリの devcontainer を探す（devcontainer.local_folder のラベル）
#   3. 止まっていれば起こす（devcontainer.json の shutdownAction が stopCompose なので、
#      VS Code を閉じていれば止まっている）。**起こした場合は、終わったら止め直す**
#   4. docker exec でプライマリから scripts/acceptance-remote-scheduled.sh を回す
#
# ログ: ~/Library/Logs/game-forge/acceptance-remote/<UTC の時刻>.log（30 日で消す）。
# **検査の出力（ID・ARN・TXT の値など）を含むのは、この Mac の上のログだけである。**
#
# ここで失敗しても、どこへも投稿しない（投稿に要る gh の認証もコンテナの中にある）。
# **記録が来ないことは、CI の定期ジョブが「記録が古い」として赤にする**（3 日で）。
#
# 使い方（手で 1 回回す）: bash scripts/acceptance-remote-launchd.sh
# 導入: docs/acceptance-remote-schedule.md
set -u

HERE="$(cd "$(dirname "$0")" && pwd)" || exit 1
REPO_HOST_DIR="$(dirname "$HERE")"
# devcontainer.json の workspaceFolder と同じ綴り（コンテナの中のプライマリ）。
CONTAINER_WORKSPACE=/workspaces/game-forge

LOG_DIR="${HOME}/Library/Logs/game-forge/acceptance-remote"
mkdir -p "$LOG_DIR" || exit 1
LOG="${LOG_DIR}/$(date -u +%Y%m%dT%H%M%SZ).log"
# 古いログを消す（BSD の find も -mtime / -delete を持つ）。
find "$LOG_DIR" -name '*.log' -type f -mtime +30 -delete 2>/dev/null

log() { printf '[acceptance-remote-launchd] %s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >> "$LOG"; }

log "開始（${REPO_HOST_DIR}）"

# ── 1. Docker ────────────────────────────────────────────────────────────────
if ! docker info >/dev/null 2>&1; then
  log "Docker が応答しません。Docker Desktop を起こします。"
  open -g -a Docker >> "$LOG" 2>&1
  waited=0
  until docker info >/dev/null 2>&1; do
    if [ "$waited" -ge 180 ]; then
      log "Docker が 180 秒で起きませんでした。回していません。"
      exit 1
    fi
    sleep 5
    waited=$((waited + 5))
  done
fi

# ── 2. devcontainer を探す ───────────────────────────────────────────────────
cid="$(docker ps -aq --filter "label=devcontainer.local_folder=${REPO_HOST_DIR}" | head -n 1)"
if [ -z "$cid" ]; then
  log "devcontainer が見つかりません（label devcontainer.local_folder=${REPO_HOST_DIR}）。VS Code で一度開いて作ってください。回していません。"
  exit 1
fi

# ── 3. 起こす ────────────────────────────────────────────────────────────────
started_here=0
if [ "$(docker inspect -f '{{.State.Running}}' "$cid" 2>/dev/null)" != "true" ]; then
  log "devcontainer（${cid}）が止まっているので起こします。"
  if ! docker start "$cid" >> "$LOG" 2>&1; then
    log "devcontainer を起こせませんでした。回していません。"
    exit 1
  fi
  started_here=1
fi

# ── 4. 回す ──────────────────────────────────────────────────────────────────
# ログインシェル（-l）にするのは、features が入れた道具（terraform・gcloud・node）の PATH を
# 対話で開いたときと同じにするため。
log "docker exec で scripts/acceptance-remote-scheduled.sh を回します。"
docker exec -u vscode -w "$CONTAINER_WORKSPACE" "$cid" \
  bash -l scripts/acceptance-remote-scheduled.sh >> "$LOG" 2>&1
rc=$?
log "終了コード ${rc}（0 = ok を記録 / 1 = ok 以外を記録 / 3・4 = 記録できていない）"

if [ "$started_here" -eq 1 ]; then
  # 起こしたのがこの実行なら、元の状態（止まっている）へ戻す。
  log "起こした devcontainer を止め直します。"
  docker stop "$cid" >> "$LOG" 2>&1
fi

exit "$rc"
