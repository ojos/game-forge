#!/bin/bash
# ops-report-launchd.sh — launchd から呼ばれ、devcontainer を起こして運営報告の下書きを作り、Mac で通知する（#936）
#
# **これだけは利用者の Mac のホストで動く**（launchd の子）。devcontainer の中ではない。
# 作りは scripts/acceptance-remote-launchd.sh（#844）と同じで、違いは 2 つだけ:
#
#   - docker exec で回すのは scripts/ops-report-draft.sh（引数なし = 先月の分）
#   - 終わったら、draft が出した結果の行（OPS_REPORT_*=）を読み、**Mac の通知**を出す。
#     控え（Markdown）は docker cp でこの Mac へ写し、通知にはその場所を載せる
#
#   - **macOS の /bin/bash 3.2 で動くこと。** mapfile・連想配列・${var,,} を使わない。
#   - **認証はホストに無い。** gh・claude.ai のログイン・AWS・wrangler の資格情報は devcontainer の
#     中（Docker のボリュームと .env）にしか無い。下書きはコンテナの中で作り、ここは起こして渡すだけ。
#
# 流れ:
#   1. Docker が動いていなければ Docker Desktop を起こして待つ
#   2. このリポジトリの devcontainer を探す（devcontainer.local_folder のラベル）
#   3. 止まっていれば起こす。**起こした場合は、終わったら止め直す**
#   4. docker exec でプライマリから scripts/ops-report-draft.sh を回す
#   5. 結果の行を読み、控えを Mac へ写し、通知する
#
# 通知（osascript の display notification）:
#   ok           「運営報告 YYYY-MM の下書き」 / doc の URL
#   それ以外     「運営報告 YYYY-MM の下書き: 要対応」 / 理由と控えの場所
#   結果の行が無い（docker exec の前で止まった・draft が途中で落ちた）ときも、ログの場所を通知する。
#   **黙って終わらない**（#936 の constraints「Docs に置けなかったときは、手元の控えの場所と理由を通知して止める」）。
#
# 置き場所（この Mac の上）:
#   ログ   ~/Library/Logs/game-forge/ops-report/<UTC の時刻>.log（400 日で消す。毎月 1 本）
#   控え   ~/Library/Application Support/game-forge/ops-report/<YYYY-MM>/draft.md と result.txt
#
# 使い方（手で 1 回回す）: bash scripts/ops-report-launchd.sh
#   OPS_REPORT_ARGS に draft への引数を空白区切りで渡せる（例: OPS_REPORT_ARGS="2026-09 --force"）。
# 導入: docs/ops-report.md
#
# 終了コード: draft の終了コード（0 = Docs に置けた / 1 = 検査で落ちた / 2 = 前提の不成立 /
#             3 = Docs に置けなかった）。docker exec まで届かなければ 1。
#             Docs には置けたが控えを Mac へ写せなければ 4。
set -u

HERE="$(cd "$(dirname "$0")" && pwd)" || exit 1
REPO_HOST_DIR="$(dirname "$HERE")"
# devcontainer.json の workspaceFolder と同じ綴り（コンテナの中のプライマリ）。
CONTAINER_WORKSPACE=/workspaces/game-forge

LOG_DIR="${HOME}/Library/Logs/game-forge/ops-report"
COPY_BASE="${HOME}/Library/Application Support/game-forge/ops-report"
mkdir -p "$LOG_DIR" || exit 1
LOG="${LOG_DIR}/$(date -u +%Y%m%dT%H%M%SZ).log"
find "$LOG_DIR" -name '*.log' -type f -mtime +400 -delete 2>/dev/null

log() { printf '[ops-report-launchd] %s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >> "$LOG"; }

# Mac の通知。文言は引数で渡す（AppleScript の文字列へ埋め込まない。引用符で壊れないように）。
notify() {
  local title="$1" message="$2"
  log "通知: ${title} / ${message}"
  osascript - "$title" "$message" >> "$LOG" 2>&1 <<'APPLESCRIPT'
on run argv
  display notification (item 2 of argv) with title (item 1 of argv)
end run
APPLESCRIPT
}

# docker exec の前で止まったとき。ログの場所を知らせて終わる。
give_up() {
  log "$1"
  notify "運営報告の下書き: 回せませんでした" "$1 ログ: ${LOG}"
  exit 1
}

log "開始（${REPO_HOST_DIR}）"

# ── 1. Docker ────────────────────────────────────────────────────────────────
if ! docker info >/dev/null 2>&1; then
  log "Docker が応答しません。Docker Desktop を起こします。"
  open -g -a Docker >> "$LOG" 2>&1
  waited=0
  until docker info >/dev/null 2>&1; do
    if [ "$waited" -ge 180 ]; then
      give_up "Docker が 180 秒で起きませんでした。"
    fi
    sleep 5
    waited=$((waited + 5))
  done
fi

# ── 2. devcontainer を探す ───────────────────────────────────────────────────
cid="$(docker ps -aq --filter "label=devcontainer.local_folder=${REPO_HOST_DIR}" | head -n 1)"
if [ -z "$cid" ]; then
  give_up "devcontainer が見つかりません（VS Code で一度開いて作ってください）。"
fi

# ── 3. 起こす ────────────────────────────────────────────────────────────────
started_here=0
if [ "$(docker inspect -f '{{.State.Running}}' "$cid" 2>/dev/null)" != "true" ]; then
  log "devcontainer（${cid}）が止まっているので起こします。"
  if ! docker start "$cid" >> "$LOG" 2>&1; then
    give_up "devcontainer を起こせませんでした。"
  fi
  started_here=1
fi

# ── 4. 回す ──────────────────────────────────────────────────────────────────
# ログインシェル（-l）にするのは、features が入れた道具（node・claude・gh）の PATH を
# 対話で開いたときと同じにするため。OPS_REPORT_ARGS は手で回すときだけ使う（空白で分ける）。
log "docker exec で scripts/ops-report-draft.sh を回します（引数: ${OPS_REPORT_ARGS:-なし}）。"
# shellcheck disable=SC2086
docker exec -u vscode -w "$CONTAINER_WORKSPACE" "$cid" \
  bash -l scripts/ops-report-draft.sh ${OPS_REPORT_ARGS:-} >> "$LOG" 2>&1
rc=$?
log "終了コード ${rc}（0 = Docs に置けた / 1 = 検査で落ちた / 2 = 前提の不成立 / 3 = Docs に置けなかった）"

# ── 5. 結果を読み、控えを写し、通知する ──────────────────────────────────────
# draft は最後に結果の行を出す。同じキーが複数あれば最後のものを使う。
result() { sed -n "s/^OPS_REPORT_$1=//p" "$LOG" | tail -n 1; }
status="$(result STATUS)"
month="$(result MONTH)"
url="$(result URL)"
copy="$(result COPY)"
reason="$(result REASON)"

host_copy=""
# 通知に載せる控えの場所。Mac へ写せなかったときは devcontainer の中のパスを、そうと分かる形で載せる
# （止め直しても消えない。VS Code で devcontainer を開けば読める。消えるのは作り直したときだけ）。
copy_label=""
if [ -n "$copy" ]; then
  copy_label="devcontainer の中の ${copy}（Mac へ写せませんでした。VS Code で開くと読めます）"
fi
if [ -n "$copy" ] && [ -n "$month" ]; then
  dest="${COPY_BASE}/${month}"
  mkdir -p "$dest"
  if docker cp "${cid}:${copy}" "${dest}/draft.md" >> "$LOG" 2>&1; then
    host_copy="${dest}/draft.md"
    copy_label="$host_copy"
    docker cp "${cid}:$(dirname "$copy")/result.txt" "${dest}/result.txt" >> "$LOG" 2>&1
    # 推敲の採点と「人が足すとよい箇所」（#956）。推敲できなかった回には無いので、写せなくても止めない。
    # 前の回の写しは先に消す（残すと、推敲できなかった回の下書きに前の回の採点が組になって残る）。
    rm -f "${dest}/refine-review.json"
    docker cp "${cid}:$(dirname "$copy")/refine-review.json" "${dest}/refine-review.json" >> "$LOG" 2>&1 || true
    log "控えを写しました: ${host_copy}"
  else
    log "控えを Mac へ写せませんでした（コンテナの中には残っています: ${copy}）。"
  fi
fi

if [ "$started_here" -eq 1 ]; then
  # 起こしたのがこの実行なら、元の状態（止まっている）へ戻す。docker cp の後に止める。
  log "起こした devcontainer を止め直します。"
  docker stop "$cid" >> "$LOG" 2>&1
fi

if [ -z "$status" ]; then
  notify "運営報告の下書き: 要対応" "結果を受け取れませんでした（終了コード ${rc}）。ログ: ${LOG}"
elif [ "$status" = "ok" ] && [ -n "$url" ] && [ -z "$host_copy" ]; then
  notify "運営報告 ${month} の下書き: 控えを写せませんでした" "${url} 控え: ${copy_label:-なし}"
  # Docs には置けたが、Mac に控えが無い。成功として終わらせない。
  rc=4
elif [ "$status" = "ok" ] && [ -n "$url" ]; then
  # 理由も載せる。推敲の結果（採点の要約・推敲前で続けたこと。#956）と、置き直したとき（--force）に
  # 前の doc を消すよう知らせる文が、理由に入っている。
  notify "運営報告 ${month} の下書き" "${url} ${reason}"
elif [ "$status" = "ok" ]; then
  notify "運営報告 ${month} の下書き" "${reason} 控え: ${copy_label:-なし}"
else
  notify "運営報告 ${month} の下書き: 要対応" "${reason} ${url:+doc: ${url} }控え: ${copy_label:-なし} ログ: ${LOG}"
fi

exit "$rc"
