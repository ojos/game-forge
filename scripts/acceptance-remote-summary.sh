#!/usr/bin/env bash
# acceptance-remote-summary.sh — 外部層（scripts/acceptance-remote.sh）の出力から、
# 公開してよい要約だけを作る（#844）
#
# ══════════════════════════════════════════════════════════════════════════════
# 何を載せ、何を載せないか
# ══════════════════════════════════════════════════════════════════════════════
#
# **リポジトリは public で、要約は固定の issue のコメントとして誰でも読める。**
# 載せるのはラベル・合否・件数・時刻・HEAD・結果の分類だけである。検査の出力と plan の
# 出力（ゾーン ID・ARN・トンネル ID・TXT の値など）は、実行した Mac のログにだけ残す。
#
# **それを「値を消す」ではなく「知っている綴りしか出さない」で担保する。**
#
#   - 読む行は `[acceptance-remote] <ラベル>` と `[acceptance-remote] FAIL: <ラベル>` の 2 種類
#     だけで、**失敗の文面（字下げされた行）は 1 行も読まない**（#843 / #850 が文面を変える）。
#   - ラベルは出力からではなく、**acceptance-remote.sh の `run "<ラベル>"` の行から取る。**
#     出力にしか現れない綴りは、要約へ出る経路が無い。知らない FAIL 行は件数だけ数える。
#   - 時刻・HEAD・理由は形を検査してから載せる（40 桁の 16 進・ISO 8601 の UTC・列挙）。
#
# ══════════════════════════════════════════════════════════════════════════════
# 結果の分類（result）
# ══════════════════════════════════════════════════════════════════════════════
#
#   ok            全ラベルが PASS し、終了コードが 0
#   drift         **依存する系統の前提がすべて通った検査**が 1 つ以上 FAIL（＝宣言と実状態の乖離の疑い）。
#                 ほかの系統の前提が落ちていても drift にする
#   precondition  乖離は無く、前提の不成立がある。reason が理由:
#                   prerequisite-failed   前提の検査（gh / aws / cloudflare / gcp）のどれかが FAIL
#                   invocation-error      acceptance-remote.sh が終了コード 2（引数の誤り。#850）
#                   primary-not-on-main 等 起動側（acceptance-remote-scheduled.sh）が検査を回す前に
#                                          止めた（--precondition で渡る）
#   incomplete    乖離も前提の FAIL も無いが、回っていない検査がある・終了コードが合わない
#                 （途中で落ちた等）。**合格にも乖離にも数えない。**
#
# ラベルごとの行は 4 種類: PASS / DRIFT（乖離）/ FAIL-PRECONDITION（依存する系統の前提が
# 落ちていた。前提の検査そのものの FAIL もここ）/ NOT-RUN。
#
# **FAIL と未実行が混ざった回は drift にする**（incomplete より先に見る）。前提が通ったうえで
# 落ちた検査は、残りが回ったかに関わらず乖離の証拠である。incomplete にすると、その回に
# 見つかった乖離の名前が分類から消える。未実行の件数は `not-run:` に残り、CI はどちらでも赤にする。
#
# **FAIL を系統ごとに読み分ける**（scripts/lib/acceptance-remote-deps.tsv）。認証が切れると、
# その系統の検査は軒並み落ちる（#808 の実測: 認証なしで 40 件中 4 件しか通らない）。それを
# 乖離と呼ばないために、ある FAIL が依存する系統の前提のどれかが落ちていれば FAIL-PRECONDITION
# とする。逆に、前提が 1 つ落ちた回をまるごと乖離でないと読むと、GCP の ADC（24 時間で切れる）が
# 切れた日は Cloudflare や AWS の本物の乖離が見えなくなる（利用者の決定。PR #853）。
# 前提の通っていない系統は、系統ごとの鮮度（scripts/acceptance-record-judge.sh）が 3 日で赤にする。
#
# **対応表と acceptance-remote.sh の run は 1 対 1 でなければ要約を作らない**（終了コード 2）。
# 検査を足した日に、黙って「依存なし」＝ FAIL がいつも乖離、にならないようにする。
#
# ══════════════════════════════════════════════════════════════════════════════
# 使い方
# ══════════════════════════════════════════════════════════════════════════════
#
#   bash scripts/acceptance-remote.sh > out.log 2>&1; rc=$?
#   bash scripts/acceptance-remote-summary.sh --labels-from scripts/acceptance-remote.sh \
#     --exit "$rc" --head "$(git rev-parse HEAD)" --time "$(date -u +%Y-%m-%dT%H:%M:%SZ)" < out.log
#
#   # 検査を回さずに前提の不成立として記録する（標準入力は読まない）
#   bash scripts/acceptance-remote-summary.sh --labels-from scripts/acceptance-remote.sh \
#     --precondition primary-not-on-main --head "$sha" --time "$t"
#
# **stdout と stderr を 1 本にまとめて渡すこと。** acceptance-remote.sh はラベルを stdout へ、
# FAIL の行を stderr へ出す。片方だけでは合否が決まらない。
#
#   # terraform/ を触る PR の head で回した記録（#845。scripts/acceptance-remote-scheduled.sh --pr）
#   bash scripts/acceptance-remote-summary.sh ... --pr <PR 番号> < out.log
#
# **`--pr` を付けた要約は `pr: <番号>` の行を持つ。** 確認側は、PR では `pr:` が PR の番号と一致する
# 記録だけを、固定の issue では `pr:` の無い記録だけを数える（scripts/acceptance-record-judge.sh）。
# 形と分類は同じで、違うのは見出しとこの 1 行だけである（同じことを 2 か所に書かない）。
#
# 出力: 標準出力へコメントの本文（Markdown）。1 行目は scripts/lib/acceptance-record.sh の印。
# 終了コード: 0 = 要約を作れた（結果の良し悪しとは無関係）/ 2 = 引数・ラベル一覧が不正で作れない
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)" || exit 2
# shellcheck source=scripts/lib/acceptance-record.sh
. "$HERE/lib/acceptance-record.sh" || exit 2

die() { echo "[acceptance-remote-summary] $*" >&2; exit 2; }

labels_from="" deps_from="$HERE/lib/acceptance-remote-deps.tsv" rc="" head="" when="" precondition="" pr=""
while [ $# -gt 0 ]; do
  case "$1" in
    --labels-from) labels_from="${2:-}"; shift 2 ;;
    # 対応表の差し替えは自己試験のため。
    --deps-from) deps_from="${2:-}"; shift 2 ;;
    --exit) rc="${2:-}"; shift 2 ;;
    --head) head="${2:-}"; shift 2 ;;
    --time) when="${2:-}"; shift 2 ;;
    --precondition) precondition="${2:-}"; shift 2 ;;
    --pr) pr="${2:-}"; shift 2 ;;
    *) die "知らない引数です: $1" ;;
  esac
done

[ -f "$labels_from" ] || die "--labels-from に acceptance-remote.sh のパスを渡してください"
[[ "$head" =~ ^[0-9a-f]{40}$ ]] || die "--head は 40 桁の 16 進にしてください"
[[ "$when" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$ ]] || die "--time は YYYY-MM-DDTHH:MM:SSZ（UTC）にしてください"
# PR の番号も形を検査してから載せる（自由な文字列を公開の要約へ流す経路を作らない）。
if [ -n "$pr" ]; then
  [[ "$pr" =~ ^[1-9][0-9]*$ ]] || die "--pr は PR の番号（正の整数）にしてください"
fi
if [ -n "$precondition" ]; then
  # 起動側の理由は列挙に限る（自由な文字列を公開の要約へ流す経路を作らない）。
  case "$precondition" in
    primary-not-on-main | primary-not-at-origin-main | primary-ff-failed | npm-ci-failed | primary-dirty | state-missing | fetch-failed | not-a-git-tree) ;;
    *) die "--precondition の理由が列挙にありません: $precondition" ;;
  esac
  [ -z "$rc" ] || die "--precondition と --exit は同時に渡せません（検査を回していない）"
else
  [[ "$rc" =~ ^[0-9]+$ ]] || die "--exit に acceptance-remote.sh の終了コードを渡してください"
fi

# ── ラベルの一覧（acceptance-remote.sh の run "<ラベル>" の行）─────────────────────
#
# 行頭の `run "` だけを見る（acceptance-remote.sh の run はすべて桁 0 にある）。
# **展開を含むラベルは受け付けない。** 出力の綴りと一致しなくなり、黙って「未実行」に
# 数えられるうえ、展開後の値が公開の要約へ出る経路になりうる。
labels=()
declare -A known=()
while IFS= read -r label; do
  # shellcheck disable=SC1003  # '\' は逆斜線 1 文字との一致（引用の閉じ忘れではない）
  case "$label" in
    *'$'* | *'`'* | *'\'*) die "展開を含むラベルは要約できません: run \"$label\"" ;;
  esac
  [ -z "${known[$label]:-}" ] || die "ラベルが重複しています: $label"
  known[$label]=1
  labels+=("$label")
done < <(sed -n 's/^run "\([^"]*\)" .*/\1/p' "$labels_from")
[ "${#labels[@]}" -gt 0 ] || die "$labels_from に run \"<ラベル>\" の行がありません"

# 前提の検査のラベルと系統。**綴りは acceptance-remote.sh の前提の 4 行と同じ。**
# 片方だけ変わったら、ここで落とす（系統の鮮度が黙って数えられなくなるため）。
systems=(gh aws cloudflare gcp)
declare -A prereq_label=(
  [gh]="prerequisite: gh authenticated"
  [aws]="prerequisite: aws authenticated"
  [cloudflare]="prerequisite: cloudflare api token is active"
  [gcp]="prerequisite: gcp adc is active"
)
for s in "${systems[@]}"; do
  [ -n "${known[${prereq_label[$s]}]:-}" ] || die "前提のラベルが acceptance-remote.sh にありません: ${prereq_label[$s]}"
done

# ── 系統の対応表（scripts/lib/acceptance-remote-deps.tsv）────────────────────────
[ -f "$deps_from" ] || die "系統の対応表がありません: $deps_from"
declare -A deps=()
while IFS= read -r row || [ -n "$row" ]; do
  row="${row%$'\r'}"
  case "$row" in '' | '#'*) continue ;; esac
  [[ "$row" == *$'\t'* ]] || die "対応表の行にタブがありません: $row"
  d="${row%%$'\t'*}"
  label="${row#*$'\t'}"
  [ -n "${known[$label]:-}" ] || die "対応表のラベルが acceptance-remote.sh の run にありません: $label"
  [ -z "${deps[$label]:-}" ] || die "対応表のラベルが重複しています: $label"
  if [ "$d" != "-" ]; then
    IFS=, read -r -a parts <<<"$d"
    for p in "${parts[@]}"; do
      case "$p" in gh | aws | cloudflare | gcp) ;; *) die "対応表の系統が gh / aws / cloudflare / gcp / - のどれでもありません: $d（$label）" ;; esac
    done
  fi
  deps[$label]="$d"
done < "$deps_from"
for label in "${labels[@]}"; do
  [ -n "${deps[$label]:-}" ] || die "acceptance-remote.sh の run のラベルが対応表にありません: $label（scripts/lib/acceptance-remote-deps.tsv へ足すこと）"
done
for s in "${systems[@]}"; do
  [ "${deps[${prereq_label[$s]}]}" = "$s" ] || die "前提のラベルは自分の系統だけに依存させること: ${prereq_label[$s]}"
done

# ── 出力を読む（2 種類の行だけ）───────────────────────────────────────────────
declare -A seen=() failed_label=()
unexpected=0
if [ -z "$precondition" ]; then
  prefix='[acceptance-remote] '
  fail_prefix='[acceptance-remote] FAIL: '
  while IFS= read -r line || [ -n "$line" ]; do
    line="${line%$'\r'}"
    if [[ "$line" == "$fail_prefix"* ]]; then
      name="${line#"$fail_prefix"}"
      if [ -n "${known[$name]:-}" ]; then
        failed_label[$name]=1
        seen[$name]=1
      else
        # 知らない綴りの FAIL。名前は載せず、数だけ数える（合格にはしない）。
        unexpected=$((unexpected + 1))
      fi
    elif [[ "$line" == "$prefix"* ]]; then
      name="${line#"$prefix"}"
      # 「external state checks」「OK」などの見出しはラベルに無いので読み捨てる。
      [ -z "${known[$name]:-}" ] || seen[$name]=1
    fi
  done
fi

declare -A prereq_state=()
prereq_failed=0 prereq_notrun=0
for s in "${systems[@]}"; do
  l="${prereq_label[$s]}"
  if [ -n "${failed_label[$l]:-}" ]; then
    prereq_state[$s]=fail; prereq_failed=1
  elif [ -n "${seen[$l]:-}" ]; then
    prereq_state[$s]=pass
  else
    prereq_state[$s]=not-run; prereq_notrun=1
  fi
done

# ある FAIL の依存する系統の前提が、すべて通っていたか（0 = 通っていた / 1 = どれかが落ちていた）。
deps_down() {
  local d="${deps[$1]}" p
  [ "$d" = "-" ] && return 1
  IFS=, read -r -a parts <<<"$d"
  for p in "${parts[@]}"; do
    [ "${prereq_state[$p]:-}" = pass ] || return 0
  done
  return 1
}

passed=0 drift=0 masked=0 notrun=0 ran=0
rows=()
for label in "${labels[@]}"; do
  if [ -n "${failed_label[$label]:-}" ]; then
    ran=$((ran + 1))
    if deps_down "$label"; then
      rows+=("FAIL-PRECONDITION $label"); masked=$((masked + 1))
    else
      rows+=("DRIFT $label"); drift=$((drift + 1))
    fi
  elif [ -n "${seen[$label]:-}" ]; then
    rows+=("PASS $label"); passed=$((passed + 1)); ran=$((ran + 1))
  else
    rows+=("NOT-RUN $label"); notrun=$((notrun + 1))
  fi
done

# ── 分類 ─────────────────────────────────────────────────────────────────────
if [ -n "$precondition" ]; then
  result=precondition reason="$precondition"
elif [ "$rc" = 2 ]; then
  # #850（2026-10-01 にマージ。428a46a）から、acceptance-remote.sh は知らない引数で 2 を返す。
  # 呼び方の誤りで、乖離ではない。
  result=precondition reason=invocation-error
elif [ "$drift" -gt 0 ] || [ "$unexpected" -gt 0 ]; then
  # 知らない綴りの FAIL は系統が分からないので、乖離の側へ倒す（合格にも前提の不成立にもしない）。
  result=drift reason=checks-failed
elif [ "$prereq_failed" -eq 1 ]; then
  result=precondition reason=prerequisite-failed
elif [ "$prereq_notrun" -eq 1 ]; then
  result=incomplete reason=not-all-checks-ran
elif [ "$notrun" -gt 0 ]; then
  result=incomplete reason=not-all-checks-ran
elif [ "$rc" != 0 ]; then
  result=incomplete reason=nonzero-exit
else
  result=ok reason=-
fi

case "$result" in
  ok) headline="全 ${#labels[@]} 件 PASS" ;;
  drift) headline="${drift} 件の検査が、依存する系統の前提が通ったうえで FAIL（宣言と実状態の乖離の疑い）" ;;
  precondition) headline="前提の不成立（${reason}）。乖離は見つかっていない（前提の落ちた系統の検査は判定していない）" ;;
  *) headline="未完了（${reason}）。合格にも乖離にも数えない" ;;
esac

printf '%s\n' "$ACCEPTANCE_RECORD_MARKER"
if [ -n "$pr" ]; then
  printf 'PR #%s の head で回した外部層の記録（#845）: **%s**\n\n' "$pr" "$headline"
else
  printf '外部層の定期実行の記録（#844）: **%s**\n\n' "$headline"
fi
printf '値は載せていません。検査の出力と plan の出力は、実行した端末のログにだけあります。\n\n'
printf '```text\n'
printf 'record: v1\n'
printf 'time: %s\n' "$when"
printf 'head: %s\n' "$head"
[ -z "$pr" ] || printf 'pr: %s\n' "$pr"
printf 'result: %s\n' "$result"
printf 'reason: %s\n' "$reason"
printf 'exit: %s\n' "${rc:--}"
printf 'expected: %s\n' "${#labels[@]}"
printf 'ran: %s\n' "$ran"
printf 'passed: %s\n' "$passed"
printf 'drift: %s\n' "$drift"
printf 'failed-precondition: %s\n' "$masked"
printf 'not-run: %s\n' "$notrun"
printf 'unexpected-fail: %s\n' "$unexpected"
for s in "${systems[@]}"; do
  printf 'prereq.%s: %s\n' "$s" "${prereq_state[$s]}"
done
printf '%s\n' "${rows[@]}"
printf '```\n'
