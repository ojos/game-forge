#!/usr/bin/env bash
# acceptance-record-judge.sh — 外部層の記録を判定する（定期実行 #844 / terraform/ を触る PR #845）
#
# 2 つの読み方を持つ。**記録の形（印・持ち主・要約の解釈）は 1 か所（下の jq の mine / marked /
# parse）で共有し、違うのは何を求めるかだけである。**
#
#   既定        固定の issue の記録。新しいか・乖離が無いか・系統ごとの前提が通っているか（下の表）
#   --pr-head   PR のコメントの記録。**その PR の head SHA で回した最新の記録が全件 PASS か**
#               （下の「PR の記録の判定」）
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
#   incomplete           acceptance-remote.sh を起動した最新の回（exit が - でない回。1 件も回らずに
#                        終わった回を含む）が incomplete（途中で止まった等）
#   drift（綴り不明）    ラベルの一覧に無い綴りの FAIL（unexpected-fail）がある回の後に、前提が 4 つとも
#                        通った回が無い（要約は綴りを載せないので、ラベルごとの見方では拾えない）
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
# **`pr:` の行を持つ記録（PR 向けの記録。#845）は、ここでは数えない。** PR の head は main ではないので、
# 固定の issue の列に混ざると、main の宣言の乖離を PR の宣言で上書きしうる。
#
# ══════════════════════════════════════════════════════════════════════════════
# PR の記録の判定（--pr-head <40 桁> --pr <番号>。#845）
# ══════════════════════════════════════════════════════════════════════════════
#
# 入力は PR のコメント（形は上と同じ）。数えるのは**持ち主の記録で、`pr:` が --pr と一致するもの**
# だけである（定期実行の形の記録・別の PR の記録は数えない）。そのうち `head` が --pr-head と完全に
# 一致する記録の**最新の 1 件**で決める。
#
#   ok             最新の記録が result: ok で、ラベルの行がすべて PASS
#   no-record      この PR の記録が 1 件も無い（apply の後に外部層を回していない）
#   head-mismatch  記録はあるが、どれもいまの head のものではない（記録の後に push した）
#   drift          最新の記録が drift（乖離した検査の名前を出す）
#   precondition   最新の記録が precondition。**検査を回せていないので、確かめていない＝失敗に数える**
#                  （理由の綴りを出す。認証の切れなら再ログインして回し直す）
#   incomplete     最新の記録が incomplete、または ok なのに PASS 以外の行がある
#
# 最新の 1 件で決めるのは、同じ head で回し直した結果（認証を直して再実行・乖離を直して再実行）を
# 反映するためである。**「最新」は投稿の順（GitHub の created_at と id）で決め、記録の time は使わない**
# （端末の時計がずれると、後から載せた乖離の記録が前の全件 PASS より古く並ぶ）。**鮮度は見ない。** apply の後に回したことを head で結んでおり、その後の外部状態の
# 変化は定期実行（既定の読み方）が拾う。
#
# ══════════════════════════════════════════════════════════════════════════════
# 入出力
# ══════════════════════════════════════════════════════════════════════════════
#
# 入力: 標準入力。issue のコメントを 1 行 1 件の JSON で（`gh api --paginate
#       repos/{owner}/{repo}/issues/N/comments --jq '.[]'` の出力そのまま）。
#
#   bash scripts/acceptance-record-judge.sh --owner ojos [--now <epoch>] [--max-age <秒>]
#   bash scripts/acceptance-record-judge.sh --owner ojos --pr-head <40 桁> --pr <番号>
#
# 出力: 判定の経過を 1 行ずつ。落とす理由は `FAIL <理由>` の行。最後の行は
#       `verdict: ok` か `verdict: fail`。
# 終了コード: 0 = ok / 1 = fail / 2 = 入力を読めない・引数の誤り（**「記録が無い」と混ぜない**）
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)" || exit 2
# shellcheck source=scripts/lib/acceptance-record.sh
. "$HERE/lib/acceptance-record.sh" || exit 2

die() { echo "[acceptance-record-judge] $*" >&2; exit 2; }

owner="" now="" max_age="$ACCEPTANCE_RECORD_MAX_AGE_SEC" pr_head="" pr=""
while [ $# -gt 0 ]; do
  case "$1" in
    --owner) owner="${2:-}"; shift 2 ;;
    --now) now="${2:-}"; shift 2 ;;
    --max-age) max_age="${2:-}"; shift 2 ;;
    --pr-head) pr_head="${2:-}"; shift 2 ;;
    --pr) pr="${2:-}"; shift 2 ;;
    *) die "知らない引数です: $1" ;;
  esac
done
[ -n "$owner" ] || die "--owner にリポジトリの持ち主のログイン名を渡してください"
if [ -n "$pr_head" ] || [ -n "$pr" ]; then
  [[ "$pr_head" =~ ^[0-9a-f]{40}$ ]] || die "--pr-head は PR の head の 40 桁の 16 進にしてください"
  [[ "$pr" =~ ^[1-9][0-9]*$ ]] || die "--pr-head と一緒に --pr へ PR の番号を渡してください"
fi
[ -n "$now" ] || now="$(date -u +%s)"
[[ "$now" =~ ^[0-9]+$ ]] || die "--now は UNIX 時刻（秒）にしてください"
[[ "$max_age" =~ ^[0-9]+$ ]] || die "--max-age は秒数にしてください"
command -v jq >/dev/null || die "jq がありません"

out="$(jq -s -r --arg owner "$owner" --arg marker "$ACCEPTANCE_RECORD_MARKER" \
  --argjson now "$now" --argjson max "$max_age" --arg pr_head "$pr_head" --arg pr "$pr" '
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
              full: (($kv.head // "") | if test("^[0-9a-f]{40}$") then . else null end),
              created: $c, id: (.id // 0),
              pr: ($kv.pr // null),
              reason: (($kv.reason // "-") | if test("^[a-z-]+$") then . else "-" end),
              drift: (($kv.drift // "0") | tonumber? // 0),
              ran: (($kv.ran // "0") | tonumber? // 0),
              invoked: (($kv.exit // "-") != "-"),
              unexpected: (($kv["unexpected-fail"] // "0") | tonumber? // 0),
              rows: [ $l[] | capture("^(?<st>PASS|DRIFT|FAIL-PRECONDITION|NOT-RUN) (?<label>.+)$") ],
              prereq: (reduce $sys[] as $s ({}; .[$s] = $kv["prereq." + $s]))}
        else {malformed: true} end;
    def when: todateiso8601;

    [ .[] | select(type == "object") | select(marked) ] as $marked
  | [ $marked[] | select(mine | not) ] as $foreign
  | [ $marked[] | select(mine) | parse ] as $parsed
  | ([ $parsed[] | select(.malformed != true) ] | sort_by(.at)) as $all
  | if $pr_head != "" then
      # ── PR の記録（#845）────────────────────────────────────────────────
      # **並べる順は GitHub が付けた投稿の順（created_at と id）にする。** 記録の time は端末の時計で、
      # 後から投稿した乖離の記録が、時計のずれで前の全件 PASS より古く並ぶと success を出す
      # （#845 の第二意見の指摘）。鮮度を見ないので、time を使う理由が無い。
      ([ $all[] | select(.pr == $pr) ] | sort_by([.created, .id])) as $mine_pr
      | [ $mine_pr[] | select(.full == $pr_head) ] as $at
      | "records: \($mine_pr | length)（PR #\($pr) の持ち主の記録。この head のもの \($at | length) 件。形の崩れ \([ $parsed[] | select(.malformed == true) ] | length) 件・持ち主以外の \($foreign | length) 件・ほかの PR や定期実行の形の \([ $all[] | select(.pr != $pr) ] | length) 件は数えない）",
        ( if ($at | length) == 0 then
            if ($mine_pr | length) > 0 then
              ($mine_pr[-1]) as $l
              | "FAIL head-mismatch この head（\($pr_head[0:7])）の記録がありません。最新の記録は head=\($l.head)（\($l.at | when)）で、その後に push されています"
            else
              "FAIL no-record PR #\($pr) に持ち主（\($owner)）の記録がありません（apply の後に外部層を回していない）"
            end
          else
            ($at[-1]) as $r
            | "latest: \($r.at | when) result=\($r.result) reason=\($r.reason) head=\($r.head)",
              ( if $r.result == "ok" and ($r.rows | length) > 0 and all($r.rows[]; .st == "PASS") then
                  "ok: この head の最新の記録は全 \($r.rows | length) 件 PASS です"
                elif $r.result == "drift" then
                  "FAIL drift この head の最新の記録に乖離があります（DRIFT \($r.drift) 件・綴り不明の FAIL \($r.unexpected) 件）: \([ $r.rows[] | select(.st == "DRIFT") | .label ] | join(" / "))"
                elif $r.result == "precondition" then
                  "FAIL precondition この head の最新の記録は検査を回せていません（\($r.reason)）。確かめていないので失敗に数えます"
                else
                  "FAIL incomplete この head の最新の記録が途中で止まっています（result=\($r.result) ran=\($r.ran)）"
                end )
          end )
    else
    # ── 定期実行の記録（#844）。PR 向けの記録（pr: の行がある）は数えない ────────────
    ([ $all[] | select(.pr == null) ]) as $recs
  | "records: \($recs | length)（持ち主の記録。形の崩れ \([ $parsed[] | select(.malformed == true) ] | length) 件と、持ち主以外の \($foreign | length) 件は数えない）",
    ( if ($recs | length) == 0 then
        "FAIL no-record 持ち主（\($owner)）の記録が 1 件もありません"
      else
        ($recs[-1]) as $last
        | "latest: \($last.at | when) result=\($last.result) head=\($last.head)",
          ( if ($now - $last.at) > $max then
              "FAIL stale 最新の記録が \(($now - $last.at) | days) 日前です（定期実行が止まっています）"
            else empty end ),
          ( [ $recs[] | select(.invoked) ] as $r
            | if ($r | length) > 0 and $r[-1].result == "incomplete" then
                "FAIL incomplete acceptance-remote.sh を起動した最新の回（\($r[-1].at | when) head=\($r[-1].head) ran=\($r[-1].ran)）が途中で止まっています"
              else empty end ),
          # 綴りの分からない FAIL は系統が分からないので、前提が 4 つとも通った回でしか「直った」と
          # 数えない（翌日に認証が切れた回で消えないように。PR #853 の第二意見の指摘）。
          ( ([ $recs[] | select(.invoked and (.unexpected > 0 or all(.prereq[]; . == "pass"))) ] | last) as $u
            | if $u != null and $u.unexpected > 0 then
                "FAIL drift 前提がそろって判定できた最新の回（\($u.at | when) head=\($u.head)）に、ラベルの一覧に無い綴りの FAIL が \($u.unexpected) 件あります"
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
    end
')" || die "入力を JSON として読めませんでした（記録が無いのではなく、判定できません）"

printf '%s\n' "$out"
if printf '%s\n' "$out" | grep -q '^FAIL '; then
  echo "verdict: fail"
  exit 1
fi
echo "verdict: ok"
exit 0
