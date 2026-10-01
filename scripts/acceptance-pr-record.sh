#!/usr/bin/env bash
# acceptance-pr-record.sh — terraform/ を触る PR に、その head で回した外部層の記録があるかを判定する（#845）
#
# .github/workflows/acceptance-remote-pr.yml が呼ぶ。手元からも同じように回せる（--report を外せば
# status を書かずに判定だけを出す）。
#
#   REPO=ojos/game-forge bash scripts/acceptance-pr-record.sh --pr <N> [--head <40 桁>] [--report]
#   REPO=ojos/game-forge bash scripts/acceptance-pr-record.sh --sweep [--report]
#
# ══════════════════════════════════════════════════════════════════════════════
# 何を見るか
# ══════════════════════════════════════════════════════════════════════════════
#
# apply は**マージの前に、プライマリを PR の head へ --detach で置いて**当てる（docs/handoff.md 3 章）。
# その後に同じツリーから `bash scripts/acceptance-remote-scheduled.sh --pr <N>` で外部層を回すと、
# 要約が PR のコメントとして載る。**ここはその記録を読むだけで、回さない**（CI に state は無い。#808）。
#
# 判定そのものは scripts/acceptance-record-judge.sh の --pr-head が持つ（**定期実行と同じ jq で記録を
# 解釈する。** 持ち主の記録だけを数えることも同じ）。ここは次の 3 つだけを持つ。
#
#   1. terraform/ を触る PR か（変更ファイルと改名の元。触らなければ何も求めず、status も書かない）
#   2. PR のコメントを取って判定へ渡す
#   3. 判定を PR の head SHA へ commit status（context: acceptance-remote-pr）として書く
#
# ══════════════════════════════════════════════════════════════════════════════
# status と終了コード
# ══════════════════════════════════════════════════════════════════════════════
#
#   success  その head の最新の記録が全件 PASS
#   failure  記録が無い・head がずれた・乖離・検査を回せていない（前提の不成立）・途中で止まった
#   （無し） terraform/ を触らない PR・fork の PR・閉じた PR・**読めなかったとき**
#
# **読めなかったとき（GitHub API の失敗）は status を書かない。** 「記録が無い」と混ぜると、GitHub の
# 一時的な不調で赤が出る。緑にすると確かめていないものを通す（second-opinion-gate と同じ）。判定は
# 次の契機（コメントの投稿・30 分ごとの掃き寄せ）へ持ち越す。
#
# **判定の間にコメントが変わったら書かない。** 掃き寄せ（30 分ごと）と PR ごとの契機は別の concurrency
# group で並行して走る。掃き寄せが古いコメントで判定し、記録の投稿で起きた判定より後に書くと、
# 誤った判定が次の掃き寄せまで残る（#845 の第二意見の指摘）。書く直前にコメントを読み直し、
# 変わっていれば譲る——変えたコメントの契機（issue_comment）か次の掃き寄せが、新しい一覧で判定する。
# 読み直しから書くまでは 1 秒も無く、コメントの契機はランナーの起動を挟むので、その後に始まる。
#
# **同じ判定が既に付いていれば書き直さない。** 掃き寄せは 30 分ごとに全件を見るので、毎回書くと
# 1 つの commit に status が積もる（GitHub は 1 つの SHA と context に 1000 件まで）。
#
# 終了コード: 0 = すべて success か対象外 / 1 = failure の判定がある / 2 = 読めない・status を書けない
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)" || exit 2

# status の名前。**変えると過去の PR に付いた status と別物になる。**
CONTEXT="acceptance-remote-pr"

die() { echo "[acceptance-pr-record] $*" >&2; exit 2; }

mode="" pr="" head="" report=0
while [ $# -gt 0 ]; do
  case "$1" in
    --pr) mode="pr"; pr="${2:-}"; shift 2 ;;
    --head) head="${2:-}"; shift 2 ;;
    --sweep) mode="sweep"; shift ;;
    --report) report=1; shift ;;
    *) die "知らない引数です: $1" ;;
  esac
done
[ -n "$mode" ] || die "--pr <N> か --sweep を渡してください"
if [ "$mode" = pr ]; then
  [[ "$pr" =~ ^[1-9][0-9]*$ ]] || die "--pr は PR の番号にしてください"
  [ -z "$head" ] || [[ "$head" =~ ^[0-9a-f]{40}$ ]] || die "--head は 40 桁の 16 進にしてください"
else
  [ -z "$head" ] || die "--head は --pr と一緒にだけ渡せます"
fi
command -v jq >/dev/null || die "jq がありません"

repo="${REPO:-}"
if [ -z "$repo" ]; then
  repo="$(gh repo view --json nameWithOwner --jq .nameWithOwner 2>/dev/null)" || die "リポジトリ名を取得できません（REPO を渡してください）"
fi
[[ "$repo" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || die "REPO の形が owner/name ではありません"
owner="${repo%%/*}"
# jq の env.REPO（fork の除外）が読む。
export REPO="$repo"

# status を書く。同じ state と説明が既に最新なら書かない。0 = 書いた・書く必要が無い / 1 = 書けなかった
report() {
  local sha="$1" state="$2" desc="$3" cur=""
  if [ "$report" -ne 1 ]; then
    echo "  （--report なし）status=${state} sha=${sha:0:7} (${desc})"
    return 0
  fi
  # 読めなければ書く側へ倒す（書かないまま古い判定を残すより、同じものが 2 件積もるほうが害が小さい）。
  cur="$(gh api "repos/${repo}/commits/${sha}/statuses?per_page=100" \
    --jq "[.[] | select(.context == \"${CONTEXT}\")] | .[0] // empty | .state + \"|\" + .description" 2>/dev/null)" || cur=""
  if [ "$cur" = "${state}|${desc}" ]; then
    echo "  status=${state} sha=${sha:0:7}（同じ判定が付いているので書き直しません）"
    return 0
  fi
  if ! gh api --method POST "repos/${repo}/statuses/${sha}" \
    -f "state=${state}" -f "context=${CONTEXT}" -f "description=${desc}" \
    ${RUN_URL:+-f "target_url=${RUN_URL}"} >/dev/null; then
    echo "::error::${sha:0:7} へ status を書けませんでした（判定は ${state}）。"
    return 1
  fi
  echo "  status=${state} sha=${sha:0:7} (${desc})"
}

# 1 本を判定する。0 = success / 1 = failure / 2 = 読めない・書けない / 3 = 対象外（status を書かない）
judge_one() {
  local n="$1" sha="$2" files comments again out rc=0 code reason desc
  # **改名の元のパスも見る**——terraform/ から外へ動かす PR も宣言を変える（writeback-serial と同じ）。
  if ! files="$(gh api --paginate "repos/${repo}/pulls/${n}/files?per_page=100" \
    --jq '.[] | .filename, (.previous_filename // empty)' 2>/dev/null)"; then
    echo "::error::PR #${n} の変更ファイルを読めませんでした。status は付けていません（次の契機で判定し直します）。"
    return 2
  fi
  if ! grep -q '^terraform/' <<<"$files"; then
    echo "PR #${n}: terraform/ を触っていないので、記録を求めません。"
    return 3
  fi
  # **--paginate を外さない。** 第二意見の記録などでコメントは増える。先頭のページだけでは見落とす。
  if ! comments="$(gh api --paginate "repos/${repo}/issues/${n}/comments?per_page=100" --jq '.[]' 2>/dev/null)"; then
    echo "::error::PR #${n} のコメントを読めませんでした。status は付けていません（次の契機で判定し直します）。"
    return 2
  fi
  out="$(printf '%s\n' "$comments" | bash "$HERE/acceptance-record-judge.sh" --owner "$owner" --pr-head "$sha" --pr "$n")" || rc=$?
  printf '%s\n' "$out" | sed "s/^/  PR #${n}: /"
  if [ "$report" -eq 1 ] && { [ "$rc" = 0 ] || [ "$rc" = 1 ]; }; then
    if ! again="$(gh api --paginate "repos/${repo}/issues/${n}/comments?per_page=100" --jq '.[]' 2>/dev/null)"; then
      echo "::error::PR #${n} のコメントを読み直せませんでした。status は付けていません（次の契機で判定し直します）。"
      return 2
    fi
    if [ "$again" != "$comments" ]; then
      echo "PR #${n}: 判定の間にコメントが変わったので書きません（新しいコメントの契機か、次の掃き寄せが判定します）。"
      return 3
    fi
  fi
  case "$rc" in
    0)
      report "$sha" success "External acceptance passed at this head (all checks PASS)" || return 2
      return 0
      ;;
    1)
      code="$(printf '%s\n' "$out" | sed -n -E 's/^FAIL ([a-z-]+).*/\1/p' | head -n 1)"
      reason="$(printf '%s\n' "$out" | sed -n -E 's/^latest: .* reason=([a-z-]+) .*/\1/p' | head -n 1)"
      case "$code" in
        no-record) desc="No external acceptance record for this PR; run it on the primary after apply" ;;
        head-mismatch) desc="External acceptance record is for an older head; re-run after apply" ;;
        drift) desc="External acceptance at this head found drift" ;;
        precondition) desc="External acceptance at this head did not run checks (${reason:-unknown})" ;;
        *) desc="External acceptance at this head is incomplete" ;;
      esac
      report "$sha" failure "$desc" || return 2
      return 1
      ;;
    *)
      echo "::error::PR #${n}: 判定スクリプトが入力を読めませんでした（終了コード ${rc}）。status は付けていません。"
      return 2
      ;;
  esac
}

worst=0
note() { # 終了コードを集計する（2 > 1 > 0。3 は対象外で 0 と同じ）
  case "$1" in
    2) worst=2 ;;
    1) [ "$worst" -eq 2 ] || worst=1 ;;
  esac
}

if [ "$mode" = pr ]; then
  # fork・閉じた PR は対象外（記録を付けられない・判定しても読む人がいない）。
  if ! info="$(gh api "repos/${repo}/pulls/${pr}" --jq '.state + " " + .head.sha + " " + (.head.repo.full_name // "-")' 2>/dev/null)"; then
    echo "::error::PR #${pr} を読めませんでした。status は付けていません。"
    exit 2
  fi
  read -r st cur_head head_repo <<<"$info"
  if [ "$head_repo" != "$repo" ]; then
    echo "PR #${pr}: fork からの PR なので判定しません（記録を付けられるのは持ち主だけ）。"
    exit 0
  fi
  if [ "$st" != open ]; then
    echo "PR #${pr}: open ではない（${st}）ので判定しません。"
    exit 0
  fi
  # 契機の head（pull_request の head.sha）を渡されたらそれを判定する。古い head へ書いた status は
  # PR の checks 欄に出ないだけで害は無く、新しい head はそれ自身の契機が判定する。
  rc=0
  judge_one "$pr" "${head:-$cur_head}" || rc=$?
  note "$rc"
  exit "$worst"
fi

# ── 掃き寄せ（記録が後から付いた PR と、契機が届かなかった PR を拾う）──────────────
# 同じリポジトリの open な PR だけ。fork と、fork 元が消えた PR（head.repo が null）は除く。
if ! prs="$(gh api --paginate "repos/${repo}/pulls?state=open&per_page=100" \
  --jq '.[] | select(.head.repo != null and .head.repo.full_name == env.REPO) | "\(.number) \(.head.sha)"' 2>/dev/null)"; then
  echo "::error::open な PR の一覧を読めませんでした。1 本も判定していません。"
  exit 2
fi
if [ -z "$prs" ]; then
  echo "open な PR はありません。"
  exit 0
fi
# while read はパイプの右に置かない（サブシェルで worst が残らない）。
while read -r n sha; do
  [ -n "${n:-}" ] || continue
  rc=0
  judge_one "$n" "$sha" || rc=$?
  note "$rc"
done <<<"$prs"
exit "$worst"
