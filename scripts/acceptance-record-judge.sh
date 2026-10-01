#!/usr/bin/env bash
# acceptance-record-judge.sh — 外部層の定期実行の記録が新しいか、乖離が無いかを判定する（#844）
#
# 記録は利用者の Mac の launchd が毎日 12:00 JST に固定の issue へ投稿する
# （scripts/acceptance-remote-scheduled.sh）。ここはそのコメントを読んで判定するだけで、
# 取得は scripts/acceptance-record-freshness.sh、定期の起動は
# .github/workflows/acceptance-remote-freshness.yml が持つ。**判定を YAML へ書き写さない**
# （writeback-serial と同じ。手元と CI で同じコードが判定する）。
#
# ══════════════════════════════════════════════════════════════════════════════
# 誰の記録を数えるか
# ══════════════════════════════════════════════════════════════════════════════
#
# **リポジトリの持ち主が書いたコメントだけを数える。** 固定の issue は public で、誰でも
# コメントできる（ロックしていても、ロックの前や協力者のコメントは残る）。印（マーカー）で
# 探すだけだと、**他人が「全件 PASS」の記録を貼れば、止まった定期実行を緑に見せられる。**
# 条件は `user.login` が持ち主で、かつ `author_association` が `OWNER` であること。
# second-opinion-gate（#806）は著者を見ていないが、あちらは PR のコメントで、記録を
# 作る側と回す側が同じ人である。こちらは公開の issue なので前例にしない。
#
# ══════════════════════════════════════════════════════════════════════════════
# 何で落とすか（どれか 1 つで fail）
# ══════════════════════════════════════════════════════════════════════════════
#
#   no-record            持ち主の記録が 1 件も無い
#   stale                最新の記録が MAX_AGE より古い（＝定期実行が止まっている）
#   drift                **ラベルごとに、判定できた最新の回**（PASS か DRIFT だった回）が DRIFT
#   incomplete           検査を回した最新の回（ran > 0）が incomplete（途中で止まった等）
#   system-stale <系統>  gh / aws / cloudflare / gcp のそれぞれで、前提が PASS した最後の
#                        記録が無いか MAX_AGE より古い（＝その系統の認証が 3 日切れている）
#
# **乖離はラベルごとに「判定できた最新の回」で見る**（PR #853 で系統ごとの読み分けに合わせた）。
# 要約は、依存する系統の前提が落ちていた FAIL を FAIL-PRECONDITION と書く。その回はそのラベルを
# 判定していないので、乖離が直ったとも続いているとも数えない。例えば AWS の検査で乖離が出た
# 翌日に AWS の認証が切れても、乖離は隠れない。直ったと分かるのは、そのラベルが PASS した回だけ。
# 判定できないまま 3 日経った系統は system-stale が拾う。
#
# 記録の時刻は、記録に書いた `time` とコメントの `created_at`（GitHub が付ける）の
# **早いほう**を使う。記録の側の時刻を未来へずらしても、鮮度は延びない。
#
# ══════════════════════════════════════════════════════════════════════════════
# 入出力
# ══════════════════════════════════════════════════════════════════════════════
#
# 入力: 標準入力。issue のコメントを 1 行 1 件の JSON で（`gh api --paginate
#       repos/{owner}/{repo}/issues/N/comments --jq '.[]'` の出力そのまま）。
#
#   bash scripts/acceptance-record-judge.sh --owner ojos [--now <epoch>] [--max-age <秒>]
#
# 出力: 判定の経過を 1 行ずつ。落とす理由は `FAIL <理由>` の行。最後の行は
#       `verdict: ok` か `verdict: fail`。
# 終了コード: 0 = ok / 1 = fail / 2 = 入力を読めない・引数の誤り（**「記録が無い」と混ぜない**）
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)" || exit 2
# shellcheck source=scripts/lib/acceptance-record.sh
. "$HERE/lib/acceptance-record.sh" || exit 2

die() { echo "[acceptance-record-judge] $*" >&2; exit 2; }

owner="" now="" max_age="$ACCEPTANCE_RECORD_MAX_AGE_SEC"
while [ $# -gt 0 ]; do
  case "$1" in
    --owner) owner="${2:-}"; shift 2 ;;
    --now) now="${2:-}"; shift 2 ;;
    --max-age) max_age="${2:-}"; shift 2 ;;
    *) die "知らない引数です: $1" ;;
  esac
done
[ -n "$owner" ] || die "--owner にリポジトリの持ち主のログイン名を渡してください"
[ -n "$now" ] || now="$(date -u +%s)"
[[ "$now" =~ ^[0-9]+$ ]] || die "--now は UNIX 時刻（秒）にしてください"
[[ "$max_age" =~ ^[0-9]+$ ]] || die "--max-age は秒数にしてください"
command -v jq >/dev/null || die "jq がありません"

out="$(jq -s -r --arg owner "$owner" --arg marker "$ACCEPTANCE_RECORD_MARKER" \
  --argjson now "$now" --argjson max "$max_age" '
  def iso: test("^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$");
  def short: if test("^[0-9a-f]{40}$") then .[0:7] else "-" end;
  def days: . / 86400 | . * 10 | floor | . / 10;
  ["gh", "aws", "cloudflare", "gcp"] as $sys
  | def mine: (.user.login // null) == $owner and (.author_association // null) == "OWNER";
    def marked: (.body // "") | gsub("\r"; "") | split("\n") | .[0] == $marker;
    def parse:
      ((.body // "") | gsub("\r"; "") | split("\n")) as $l
      | ([ $l[] | capture("^(?<key>[a-z][a-z.-]*): (?<value>[^ ].*)$") ] | from_entries) as $kv
      | (try (.created_at | fromdateiso8601) catch null) as $c
      | if $kv.record == "v1"
          and (($kv.time // "") | iso)
          and $c != null
          and (["ok", "drift", "precondition", "incomplete"] | index([$kv.result])) != null
          and all($sys[]; . as $s | (["pass", "fail", "not-run"] | index([$kv["prereq." + $s]])) != null)
        then {at: ([($kv.time | fromdateiso8601), $c] | min), result: $kv.result,
              head: (($kv.head // "") | short),
              ran: (($kv.ran // "0") | tonumber? // 0),
              rows: [ $l[] | capture("^(?<st>PASS|DRIFT|FAIL-PRECONDITION|NOT-RUN) (?<label>.+)$") ],
              prereq: (reduce $sys[] as $s ({}; .[$s] = $kv["prereq." + $s]))}
        else {malformed: true} end;
    def when: todateiso8601;

    [ .[] | select(type == "object") | select(marked) ] as $marked
  | [ $marked[] | select(mine | not) ] as $foreign
  | [ $marked[] | select(mine) | parse ] as $parsed
  | ([ $parsed[] | select(.malformed != true) ] | sort_by(.at)) as $recs
  | "records: \($recs | length)（持ち主の記録。形の崩れ \([ $parsed[] | select(.malformed == true) ] | length) 件と、持ち主以外の \($foreign | length) 件は数えない）",
    ( if ($recs | length) == 0 then
        "FAIL no-record 持ち主（\($owner)）の記録が 1 件もありません"
      else
        ($recs[-1]) as $last
        | "latest: \($last.at | when) result=\($last.result) head=\($last.head)",
          ( if ($now - $last.at) > $max then
              "FAIL stale 最新の記録が \(($now - $last.at) | days) 日前です（定期実行が止まっています）"
            else empty end ),
          ( [ $recs[] | select(.ran > 0) ] as $r
            | if ($r | length) > 0 and $r[-1].result == "incomplete" then
                "FAIL incomplete 検査を回した最新の回（\($r[-1].at | when) head=\($r[-1].head)）が途中で止まっています"
              else empty end ),
          ( [ $recs[] | . as $rec | .rows[] | select(.st == "PASS" or .st == "DRIFT")
              | {label, st, at: $rec.at, head: $rec.head} ]
            | group_by(.label) | map(max_by(.at)) | map(select(.st == "DRIFT")) as $d
            | if ($d | length) > 0 then
                "FAIL drift \($d | length) 件の検査が、判定できた最新の回で乖離しています: \([ $d[] | "\(.label)（\(.at | when) head=\(.head)）" ] | join(" / "))"
              else
                "drift: ラベルごとに判定できた最新の回に乖離はありません"
              end ),
          ( $sys[] as $s
            | ([ $recs[] | select(.prereq[$s] == "pass") ] | last) as $p
            | if $p == null then
                "FAIL system-stale \($s) 前提が通った記録がありません"
              elif ($now - $p.at) > $max then
                "FAIL system-stale \($s) 前提が \(($now - $p.at) | days) 日通っていません"
              else
                "system \($s): 前提が通った最後の記録 \($p.at | when)"
              end )
      end )
')" || die "入力を JSON として読めませんでした（記録が無いのではなく、判定できません）"

printf '%s\n' "$out"
if printf '%s\n' "$out" | grep -q '^FAIL '; then
  echo "verdict: fail"
  exit 1
fi
echo "verdict: ok"
exit 0
