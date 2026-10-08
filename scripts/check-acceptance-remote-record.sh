#!/usr/bin/env bash
# check-acceptance-remote-record.sh — 外部層の記録（定期実行 #844・PR #845）の、要約・判定・起動前の確認を表で確かめる
#
# launchd と定期ジョブは PR の上では動かない（launchd は利用者の Mac、schedule は既定ブランチの
# ワークフローだけ）。**判定を壊しても手元でも CI でも気づけない**ので、ここで押さえる。
# scripts/acceptance.sh から回る。ネットワークも認証も要らない（git のリモートは手元の bare）。
#
# **仕込みの出力は、acceptance-remote.sh の run 関数そのものに作らせる。** 本物の run を
# 取り出して偽の検査を回すので、ラベルが stdout・FAIL と字下げの文面が stderr という形は
# 本物と同じになる。手で書いた「それらしい出力」は、本物がしないことを仕込みにさせうる。
#
#   A. 要約（acceptance-remote-summary.sh）  分類・件数・**値が 1 つも載らないこと**
#   B. 判定（acceptance-record-judge.sh）    記録なし・古い・乖離・系統の 3 日不成立・**持ち主以外を数えない**
#   C. 起動前の確認（acceptance-remote-scheduled.sh）  main 以外・遅れ・汚れで検査を回さない
#   D. 取得（acceptance-record-freshness.sh）  読めなかったことを「記録なし」と混ぜない
#   E. ワークフローと launchd の雛形の形  required check にならない・PR では動かない
#   F. PR 向けの要約と判定（#845）           head の一致・乖離・前提の不成立・持ち主と PR の番号
#   G. PR の判定と status（acceptance-pr-record.sh）  terraform/ を触る PR だけ・読めなければ書かない
#   H. 記録を作る入口（acceptance-remote-scheduled.sh --pr）  HEAD が PR の head でなければ回さない
#   I. PR のワークフローの形                  terraform/ に絞る・記録が付いたら判定し直す・required にしない
#
# 終了コード: 0 = すべて期待どおり / 1 = 1 件でも外れた
#
# 単一引用符の中の $ は jq の変数と、偽物のスクリプトの本文である（ここでは展開しない）。
# shellcheck disable=SC2016
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
REMOTE="$ROOT/scripts/acceptance-remote.sh"
SUMMARY="$ROOT/scripts/acceptance-remote-summary.sh"
JUDGE="$ROOT/scripts/acceptance-record-judge.sh"
SCHEDULED="$ROOT/scripts/acceptance-remote-scheduled.sh"
FRESHNESS="$ROOT/scripts/acceptance-record-freshness.sh"
WORKFLOW="$ROOT/.github/workflows/acceptance-remote-freshness.yml"
PLIST="$ROOT/scripts/launchd/jp.ojos.game-forge.acceptance-remote.plist"
LAUNCHER="$ROOT/scripts/acceptance-remote-launchd.sh"

command -v jq >/dev/null || { echo "[acceptance-remote-record] jq がありません" >&2; exit 1; }

WORK="$(mktemp -d "${TMPDIR:-/tmp}/acceptance-record-check.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

# **件数と失敗はファイルへ数える。** B の表はパイプの右（サブシェル）で判定するので、変数へ
# 書くと親へ伝わらず、赤を出しながら終了コード 0 で抜ける（変異で実際に踏んだ）。
: > "$WORK/count"
: > "$WORK/failed"
tick() { echo . >> "$WORK/count"; }
ng() { echo "[acceptance-remote-record] FAIL: $*" >&2; echo . >> "$WORK/failed"; }
ok_or_ng() { tick; if [ "$1" != "$2" ]; then ng "$3（want=[$2] got=[$1]）"; fi; }

HEAD_SHA=0123456789abcdef0123456789abcdef01234567
T0=2026-10-10T03:00:00Z

# ── 仕込みの出力を作る（本物の run 関数で）──────────────────────────────────────
run_def="$(sed -n '/^run() {$/,/^}$/p' "$REMOTE")"
if ! grep -q 'FAIL: %s' <<<"$run_def"; then
  echo "[acceptance-remote-record] acceptance-remote.sh から run 関数を取り出せませんでした" >&2
  exit 1
fi
sed -n 's/^run "\([^"]*\)" .*/\1/p' "$REMOTE" > "$WORK/labels"
LABEL_COUNT="$(wc -l < "$WORK/labels" | tr -d ' ')"

# 検査の出力に混ざりうる値の形（公開の要約へ 1 つも出てはならない）。
VALUES=(
  "arn:aws:lambda:ap-northeast-1:123456789012:function:game-forge-build"
  "3f9c2b7a1d4e5f60718293a4b5c6d7e8"
  "6f1e2d3c-4b5a-6978-8a9b-0c1d2e3f4a5b"
  "v=spf1 include:_spf.mx.cloudflare.net ~all"
  "google-site-verification=Zx9Qk2LmN4pR7sT1uV3wY5aB8cD0eF6gH"
  "AKIAIOSFODNN7EXAMPLE"
)
export VALUES_JOINED
VALUES_JOINED="$(printf '%s\n' "${VALUES[@]}")"

# gen <失敗させるラベルの正規表現（空なら全部 PASS）> <何件目で止めるか（0 = 最後まで）>
# 本物の acceptance-remote.sh と同じ順・同じ見出しで、stdout と stderr を 1 本にして出す。
gen() {
  local fail_re="$1" stop_at="${2:-0}"
  (
    set +e +u
    eval "$run_def"
    # 下の 4 つは eval した run が読む・呼ぶ（shellcheck からは見えない）。
    # shellcheck disable=SC2034
    LOG="$(mktemp "$WORK/log.XXXXXX")"
    # shellcheck disable=SC2034
    ran_any=0 failed=0
    # shellcheck disable=SC2034  # #850 の --only。定期実行は付けないので、本物の引数なしの状態と同じく空
    ONLY_LABELS="" ONLY_SEEN=""
    # shellcheck disable=SC2329
    fake_ok() { printf '%s\n' "$VALUES_JOINED"; return 0; }
    # shellcheck disable=SC2329
    fake_ng() { echo "期待と一致しません:"; printf '  %s\n' "$VALUES_JOINED"; return 1; }
    echo "[acceptance-remote] external state checks"
    i=0
    while IFS= read -r label; do
      i=$((i + 1))
      if [ -n "$fail_re" ] && [[ "$label" =~ $fail_re ]]; then
        run "$label" fake_ng
      else
        run "$label" fake_ok
      fi
      if [ "$stop_at" -gt 0 ] && [ "$i" -ge "$stop_at" ]; then
        echo "scripts/acceptance-remote.sh: line 999: 予期しない終了" >&2
        exit 1
      fi
    done < "$WORK/labels"
    if [ "$failed" -gt 0 ]; then
      echo "[acceptance-remote] $failed 件の検査が失敗しました。" >&2
      echo "[acceptance-remote] 対象サービスへ認証済みか、ネットワークへ到達できるかを先に確認すること。" >&2
      exit 1
    fi
    echo "[acceptance-remote] OK"
  ) 2>&1
}

summarize() { # summarize <終了コード> < 出力
  bash "$SUMMARY" --labels-from "$REMOTE" --exit "$1" --head "$HEAD_SHA" --time "$T0"
}
field() { sed -n "s/^$1: //p" "$2"; }

# ══════════════════════════════════════════════════════════════════════════════
# A. 要約
# ══════════════════════════════════════════════════════════════════════════════

gen "" > "$WORK/out-ok"
summarize 0 < "$WORK/out-ok" > "$WORK/s-ok"
ok_or_ng "$(field result "$WORK/s-ok")" ok "A1 全件 PASS・終了コード 0 は ok"
ok_or_ng "$(field passed "$WORK/s-ok")/$(field expected "$WORK/s-ok")" "$LABEL_COUNT/$LABEL_COUNT" "A1 件数はラベルの数と一致する"
ok_or_ng "$(head -n 1 "$WORK/s-ok")" '<!-- acceptance-remote-record v1 -->' "A1 1 行目は記録の印"
ok_or_ng "$(grep -c '^PASS ' "$WORK/s-ok")" "$LABEL_COUNT" "A1 ラベルごとに 1 行"

# 前提は通り、1 件だけ乖離。
gen '^dns zone matches$' > "$WORK/out-drift" || true
summarize 1 < "$WORK/out-drift" > "$WORK/s-drift"
ok_or_ng "$(field result "$WORK/s-drift")" drift "A2 前提が通って検査が落ちたら drift"
ok_or_ng "$(grep -c '^DRIFT dns zone matches$' "$WORK/s-drift")|$(field drift "$WORK/s-drift")" "1|1" "A2 落ちたラベルが DRIFT の行に出る"
ok_or_ng "$(field prereq.aws "$WORK/s-drift")" pass "A2 前提は pass のまま"

# 認証を落とした回（#808 の実測の形: aws の前提が落ち、aws を読む検査が軒並み落ちる）。
gen '^prerequisite: aws authenticated$|^terraform plan|bedrock|build function|orchestrator|cost guard' > "$WORK/out-noauth" || true
summarize 1 < "$WORK/out-noauth" > "$WORK/s-noauth"
ok_or_ng "$(field result "$WORK/s-noauth")" precondition "A3 認証を落とした回は乖離ではなく前提の不成立"
ok_or_ng "$(field reason "$WORK/s-noauth")" prerequisite-failed "A3 理由は prerequisite-failed"
ok_or_ng "$(field prereq.aws "$WORK/s-noauth")|$(field prereq.gh "$WORK/s-noauth")" "fail|pass" "A3 系統ごとの前提が読める"
ok_or_ng "$(field drift "$WORK/s-noauth")|$(grep -c '^FAIL[-]PRECONDITION ' "$WORK/s-noauth")|$(grep -c '^FAIL[-]PRECONDITION edge no longer holds bedrock credentials$' "$WORK/s-noauth")" \
  "0|$(grep -c '^\[acceptance-remote\] FAIL: ' "$WORK/out-noauth")|1" "A3 aws に依存する FAIL（cloudflare+aws の検査も）はすべて FAIL-PRECONDITION"

# GCP の ADC だけが切れた日（24 時間で切れる）。plan は 4 系統に依存するので判定しないが、
# 同じ日の Cloudflare の乖離は乖離として出す（利用者の決定。PR #853）。
gen '^prerequisite: gcp adc is active$|^terraform plan' > "$WORK/out-nogcp" || true
summarize 1 < "$WORK/out-nogcp" > "$WORK/s-nogcp"
ok_or_ng "$(field result "$WORK/s-nogcp")|$(field drift "$WORK/s-nogcp")|$(grep -c '^FAIL[-]PRECONDITION terraform plan: no drift$' "$WORK/s-nogcp")" \
  "precondition|0|1" "A3b gcp だけ切れた日の plan の FAIL は前提の不成立"
gen '^prerequisite: gcp adc is active$|^terraform plan|^dns zone matches$' > "$WORK/out-nogcp-drift" || true
summarize 1 < "$WORK/out-nogcp-drift" > "$WORK/s-nogcp-drift"
ok_or_ng "$(field result "$WORK/s-nogcp-drift")|$(field drift "$WORK/s-nogcp-drift")|$(grep -c '^DRIFT dns zone matches$' "$WORK/s-nogcp-drift")|$(field prereq.gcp "$WORK/s-nogcp-drift")" \
  "drift|1|1|fail" "A3b gcp が切れた日でも Cloudflare の乖離は drift"
# 依存の無い検査（dig だけ）の FAIL は、前提がどれだけ落ちていても乖離。
gen '^prerequisite: |^dns delegation' > "$WORK/out-noprereq-dig" || true
summarize 1 < "$WORK/out-noprereq-dig" > "$WORK/s-noprereq-dig"
ok_or_ng "$(field result "$WORK/s-noprereq-dig")|$(grep -c '^DRIFT dns delegation from jp registry is in place$' "$WORK/s-noprereq-dig")" \
  "drift|1" "A3c 依存の無い検査の FAIL は前提に関わらず drift"

# 値が 1 つも載らないこと（仕込みの出力には全部が何度も出ている）。
for v in "${VALUES[@]}"; do
  tick
  grep -qF -- "$v" "$WORK/out-drift" || ng "A4 仕込みの出力に値が出ていない（試験の前提が崩れている）: $v"
  for s in s-ok s-drift s-noauth s-nogcp-drift; do
    if grep -qF -- "$v" "$WORK/$s"; then ng "A4 要約（$s）に値が出ています: $v"; fi
  done
done

# 知らない綴りの行は、ラベルとしても FAIL としても載せない（件数だけ）。
{ cat "$WORK/out-ok"; echo "[acceptance-remote] FAIL: ${VALUES[0]}"; echo "[acceptance-remote] ${VALUES[3]}"; } > "$WORK/out-unknown"
summarize 1 < "$WORK/out-unknown" > "$WORK/s-unknown"
ok_or_ng "$(field result "$WORK/s-unknown")|$(field unexpected-fail "$WORK/s-unknown")" "drift|1" "A5 知らない FAIL 行は ok にせず件数だけ数える"
tick; if grep -qF -- "${VALUES[0]}" "$WORK/s-unknown" || grep -qF -- "${VALUES[3]}" "$WORK/s-unknown"; then ng "A5 知らない行の綴りが要約に出ています"; fi

# 途中で落ちた回は、PASS が並んでいても ok にも drift にもしない。
gen "" 10 > "$WORK/out-crash" || true
summarize 1 < "$WORK/out-crash" > "$WORK/s-crash"
ok_or_ng "$(field result "$WORK/s-crash")|$(field not-run "$WORK/s-crash")" "incomplete|$((LABEL_COUNT - 10))" "A6 途中で止まった回は incomplete"

# 落ちた検査があってから止まった回は、未実行があっても drift（乖離の証拠を分類から消さない）。
gen '^dns zone matches$' 25 > "$WORK/out-drift-crash" || true
summarize 1 < "$WORK/out-drift-crash" > "$WORK/s-drift-crash"
ok_or_ng "$(field result "$WORK/s-drift-crash")|$(field not-run "$WORK/s-drift-crash")" "drift|$((LABEL_COUNT - 25))" "A6 FAIL の後に止まった回は drift で、未実行の件数も残る"

# 全件 PASS でも終了コードが 0 でなければ ok にしない。
summarize 1 < "$WORK/out-ok" > "$WORK/s-rc"
ok_or_ng "$(field result "$WORK/s-rc")" incomplete "A7 終了コードが 0 でなければ ok にしない"

# #850: 知らない引数は終了コード 2。呼び方の誤りで、乖離ではない。
echo "acceptance-remote.sh: 知らない引数です: --bogus" > "$WORK/out-argerr"
summarize 2 < "$WORK/out-argerr" > "$WORK/s-argerr"
ok_or_ng "$(field result "$WORK/s-argerr")|$(field reason "$WORK/s-argerr")" "precondition|invocation-error" "A8 終了コード 2 は前提の不成立（invocation-error）"

# 検査を回さない記録。
bash "$SUMMARY" --labels-from "$REMOTE" --precondition primary-not-on-main --head "$HEAD_SHA" --time "$T0" < /dev/null > "$WORK/s-pre"
ok_or_ng "$(field result "$WORK/s-pre")|$(field reason "$WORK/s-pre")|$(field ran "$WORK/s-pre")|$(field prereq.gh "$WORK/s-pre")" \
  "precondition|primary-not-on-main|0|not-run" "A9 起動前の不成立は検査 0 件の precondition"

# 形の崩れた引数・自由な文字列は受け付けない（公開の要約へ流す経路を作らない）。
rc_of() { local rc=0; "$@" < /dev/null > /dev/null 2>&1 || rc=$?; echo "$rc"; }
ok_or_ng "$(rc_of bash "$SUMMARY" --labels-from "$REMOTE" --exit 0 --head "${VALUES[1]}" --time "$T0")" 2 "A10 HEAD は 40 桁の 16 進だけ"
ok_or_ng "$(rc_of bash "$SUMMARY" --labels-from "$REMOTE" --exit 0 --head "$HEAD_SHA" --time "2026-10-10 03:00")" 2 "A10 時刻は UTC の ISO 8601 だけ"
ok_or_ng "$(rc_of bash "$SUMMARY" --labels-from "$REMOTE" --precondition "${VALUES[3]}" --head "$HEAD_SHA" --time "$T0")" 2 "A10 理由は列挙だけ"
printf 'run "prerequisite: gh authenticated" x\nrun "prerequisite: aws authenticated" x\nrun "prerequisite: cloudflare api token is active" x\nrun "prerequisite: gcp adc is active" x\nrun "zone ${zone_id} matches" x\n' > "$WORK/labels-dyn.sh"
ok_or_ng "$(rc_of bash "$SUMMARY" --labels-from "$WORK/labels-dyn.sh" --exit 0 --head "$HEAD_SHA" --time "$T0")" 2 "A10 展開を含むラベルは受け付けない"
printf 'run "terraform init" x\n' > "$WORK/labels-noprereq.sh"
ok_or_ng "$(rc_of bash "$SUMMARY" --labels-from "$WORK/labels-noprereq.sh" --exit 0 --head "$HEAD_SHA" --time "$T0")" 2 "A10 前提の 4 ラベルが無ければ作らない"

# 系統の対応表（scripts/lib/acceptance-remote-deps.tsv）と run の 1 対 1。
DEPS="$ROOT/scripts/lib/acceptance-remote-deps.tsv"
deps_rc() { rc_of bash "$SUMMARY" --labels-from "$REMOTE" --deps-from "$1" --exit 0 --head "$HEAD_SHA" --time "$T0"; }
ok_or_ng "$(deps_rc "$DEPS")" 0 "A11 本物の acceptance-remote.sh の run と本物の対応表が 1 対 1"
grep -v $'\tdns zone matches$' "$DEPS" > "$WORK/deps-missing.tsv"
ok_or_ng "$(deps_rc "$WORK/deps-missing.tsv")" 2 "A11 run にあって対応表に無いラベルがあれば作らない（黙って依存なしにしない）"
{ cat "$DEPS"; printf 'aws\tsome check that was removed\n'; } > "$WORK/deps-extra.tsv"
ok_or_ng "$(deps_rc "$WORK/deps-extra.tsv")" 2 "A11 対応表にあって run に無いラベルがあれば作らない"
sed $'s/^cloudflare\tdns zone matches$/azure\tdns zone matches/' "$DEPS" > "$WORK/deps-badsys.tsv"
ok_or_ng "$(deps_rc "$WORK/deps-badsys.tsv")" 2 "A11 知らない系統は受け付けない"
sed $'s/^aws\tprerequisite: aws authenticated$/-\tprerequisite: aws authenticated/' "$DEPS" > "$WORK/deps-prereq.tsv"
ok_or_ng "$(deps_rc "$WORK/deps-prereq.tsv")" 2 "A11 前提のラベルは自分の系統に依存させる"
{ cat "$DEPS"; grep $'\tdns zone matches$' "$DEPS"; } > "$WORK/deps-dup.tsv"
ok_or_ng "$(deps_rc "$WORK/deps-dup.tsv")" 2 "A11 重複した行は受け付けない"
# #808 の実測の件数（gh 6・Cloudflare 11・AWS 13・認証不要 3。wasm_exec / plan / init / 前提は別）。
deps_count() { awk -F'\t' -v d="$1" '$0 !~ /^#/ && NF == 2 && $1 == d && $2 !~ /^prerequisite: / && $2 !~ /^terraform / && $2 !~ /^wasm_exec /' "$DEPS" | wc -l | tr -d ' '; }
ok_or_ng "gh=$(deps_count gh) cf=$(( $(deps_count cloudflare) + $(deps_count gh,cloudflare) )) aws=$(( $(deps_count aws) + $(deps_count cloudflare,aws) )) none=$(deps_count -)" \
  "gh=6 cf=11 aws=13 none=3" "A11 対応表の件数が #808 の実測の表と一致する"

# ══════════════════════════════════════════════════════════════════════════════
# B. 判定
# ══════════════════════════════════════════════════════════════════════════════
#
# 記録は A の要約スクリプトに作らせ、GitHub の issue コメントの JSON（gh api の --jq '.[]' の
# 1 行 1 件）で包む。
NOW_ISO=2026-10-10T06:00:00Z
NOW="$(jq -n --arg t "$NOW_ISO" '$t | fromdateiso8601')"

# rec <出力ファイル> <何日前（小数可）> <summary の追加引数...>
# 記録の time と created_at は同じ時刻（created_at は 20 秒後）。
rec_body() { # rec_body <日前> <追加引数...>
  local ago="$1"; shift
  local t; t="$(jq -n -r --argjson now "$NOW" --argjson ago "$ago" '($now - ($ago * 86400) | floor) | todateiso8601')"
  bash "$SUMMARY" --labels-from "$REMOTE" --head "$HEAD_SHA" --time "$t" "$@"
}
comment() { # comment <login> <association> <created_at の日前> < 本文
  jq -c -R -s --arg login "$1" --arg assoc "$2" --argjson now "$NOW" --argjson ago "$3" '
    {id: 1, user: {login: $login, type: "User"}, author_association: $assoc,
     created_at: (($now - ($ago * 86400) + 20) | floor | todateiso8601),
     updated_at: (($now - ($ago * 86400) + 20) | floor | todateiso8601), body: .}'
}
# owner_rec <日前> <出力の仕込み> <終了コード>  … 持ち主の記録を 1 件
owner_rec() { rec_body "$1" --exit "$3" < "$WORK/$2" | comment ojos OWNER "$1"; }
owner_pre() { rec_body "$1" --precondition "$2" < /dev/null | comment ojos OWNER "$1"; }

# judge_case <名前> <期待する FAIL の理由（空白区切り・順不同。空なら ok）> < コメントの行
judge_case() {
  local name="$1" want="$2" got rc=0 out
  tick
  out="$(bash "$JUDGE" --owner ojos --now "$NOW")" || rc=$?
  got="$(printf '%s\n' "$out" | sed -E -n 's/^FAIL (system-stale [a-z]+|[a-z-]+).*/\1/p' | sort | paste -sd, -)"
  want="$(printf '%s' "$want" | tr ';' '\n' | sed '/^$/d' | sort | paste -sd, -)"
  local want_rc=0; [ -z "$want" ] || want_rc=1
  if [ "$got" != "$want" ] || [ "$rc" != "$want_rc" ]; then
    ng "B $name（want rc=$want_rc [$want] got rc=$rc [$got]）"
    printf '%s\n' "$out" | sed 's/^/    /' >&2
  fi
}
ALL_SYS="system-stale gh;system-stale aws;system-stale cloudflare;system-stale gcp"

judge_case "記録が無ければ落とす" "no-record" < /dev/null
owner_rec 0.1 out-ok 0 | judge_case "新しい全件 PASS は通す" ""
# 持ち主以外が貼った「全件 PASS」は数えない（公開の issue なので誰でも書ける）。
rec_body 0.1 --exit 0 < "$WORK/out-ok" | comment someone-else NONE 0.1 | judge_case "持ち主以外の記録は数えない" "no-record"
rec_body 0.1 --exit 0 < "$WORK/out-ok" | comment ojos CONTRIBUTOR 0.1 | judge_case "持ち主の名でも association が OWNER でなければ数えない" "no-record"
{ owner_rec 4 out-ok 0; rec_body 0.1 --exit 0 < "$WORK/out-ok" | comment someone-else NONE 0.1; } |
  judge_case "古い持ち主の記録を、他人の新しい記録で救わない" "stale;$ALL_SYS"
owner_rec 3 out-ok 0 | judge_case "ちょうど 3 日前は通す（境界）" ""
owner_rec 3.01 out-ok 0 | judge_case "3 日を過ぎたら落とす" "stale;$ALL_SYS"
owner_rec 0.1 out-drift 1 | judge_case "最新に乖離があれば落とす" "drift"
{ owner_rec 1 out-ok 0; owner_rec 0.1 out-noauth 1; } | judge_case "前提の不成立は乖離に数えない（前日が ok）" ""
# aws の検査の乖離の翌日に aws の認証が切れても、そのラベルは判定されていないので乖離のまま。
gen '^orchestrator configuration matches$' > "$WORK/out-drift-aws" || true
{ owner_rec 1 out-drift-aws 1; owner_rec 0.1 out-noauth 1; } | judge_case "乖離の翌日に同じ系統の認証が切れても乖離を隠さない" "drift"
# 別の系統の乖離は、翌日にその系統の検査が PASS すれば直ったと数える。
{ owner_rec 1 out-drift 1; owner_rec 0.1 out-noauth 1; } | judge_case "乖離したラベルが翌日 PASS すれば通す" ""
{ owner_rec 1 out-ok 0; owner_rec 0.1 out-nogcp-drift 1; } | judge_case "gcp が切れた日の Cloudflare の乖離で落とす" "drift"
{ owner_rec 1 out-ok 0; owner_rec 0.1 out-nogcp 1; } | judge_case "gcp が切れただけの日は通す" ""
{ owner_rec 4 out-ok 0; owner_rec 3 out-noauth 1; owner_rec 2 out-noauth 1; owner_rec 1 out-noauth 1; owner_rec 0.1 out-noauth 1; } |
  judge_case "aws の前提が 3 日を超えて通らなければ落とす" "system-stale aws"
{ owner_rec 2 out-ok 0; owner_rec 1 out-noauth 1; owner_rec 0.1 out-noauth 1; } | judge_case "aws の前提が 2 日通らないだけなら通す" ""
owner_rec 0.1 out-crash 1 | judge_case "途中で止まった回は落とす" "incomplete"
: > "$WORK/out-empty"
{ owner_rec 1 out-ok 0; owner_rec 0.1 out-empty 1; } | judge_case "1 件も回らずに止まった回も落とす（ran 0）" "incomplete"
{ owner_rec 1 out-ok 0; owner_rec 0.1 out-unknown 1; } | judge_case "綴りの分からない FAIL がある回は落とす" "drift"
{ owner_rec 2 out-ok 0; owner_rec 1 out-unknown 1; owner_rec 0.1 out-noauth 1; } | judge_case "綴りの分からない FAIL は翌日に認証が切れても消えない" "drift"
{ owner_rec 2 out-unknown 1; owner_rec 0.1 out-ok 0; } | judge_case "綴りの分からない FAIL は前提がそろった回で直ったと数える" ""
{ owner_rec 4 out-ok 0; owner_pre 2 primary-not-on-main; owner_pre 0.1 primary-not-at-origin-main; } |
  judge_case "プライマリのずれが続けば全系統が落ちる" "$ALL_SYS"
# 記録の time を未来へずらしても、created_at（GitHub が付ける）より新しくは数えない。
rec_body 0 --exit 0 < "$WORK/out-ok" | comment ojos OWNER 4 | judge_case "記録の時刻で鮮度を延ばせない" "stale;$ALL_SYS"
sed 's/^result: ok$/result: great/' "$WORK/s-ok" | comment ojos OWNER 0.1 | judge_case "形の崩れた記録は数えない" "no-record"
sed 's/$/\r/' "$WORK/s-ok" | comment ojos OWNER 0.1 | judge_case "CRLF の本文でも読む" ""
{ sed 's/^/> /' "$WORK/s-ok"; } | comment ojos OWNER 0.1 | judge_case "引用した記録は数えない（印は 1 行目だけ）" "no-record"
tick
rc=0; echo '{"user": ' | bash "$JUDGE" --owner ojos --now "$NOW" > /dev/null 2>&1 || rc=$?
[ "$rc" = 2 ] || ng "B 壊れた JSON は「記録なし」(1) ではなく 2（got $rc）"

# ══════════════════════════════════════════════════════════════════════════════
# C. 起動前の確認（プライマリのずれで検査を回さない）
# ══════════════════════════════════════════════════════════════════════════════
#
# 手元の bare をリモートにした作業ツリーを作り、scripts/acceptance-remote.sh には本物の run で
# 前提 4 つと検査 2 つを回す偽物を置く。偽物は呼ばれたら引数の数を $WORK/called へ、
# ACCEPTANCE_TF_DIR を $WORK/tfdir へ書く（起動側には差し替えを渡した状態で呼ぶ）。
G() { git -c user.name=selftest -c user.email=selftest@example.invalid -c init.defaultBranch=main "$@"; }
G init -q --bare "$WORK/origin.git"
G clone -q "$WORK/origin.git" "$WORK/primary" 2>/dev/null
mkdir -p "$WORK/primary/scripts"
{
  echo '#!/usr/bin/env bash'
  echo 'set -uo pipefail'
  echo "echo \"\$#\" > '$WORK/called'"
  echo "echo \"\${ACCEPTANCE_TF_DIR:-unset}\" > '$WORK/tfdir'"
  echo "echo \"\${AWS_PROFILE:-unset}\" > '$WORK/awsprofile'"
  printf '%s\n' "$run_def"
  # run が読む変数（#850 の --only）。本物と同じく、引数なしでは空。
  echo 'ONLY_LABELS=""; ONLY_SEEN=""'
  echo 'LOG="$(mktemp "${TMPDIR:-/tmp}/fake-remote.XXXXXX")"; ran_any=0; failed=0'
  echo 'echo "[acceptance-remote] external state checks"'
  echo 'run "prerequisite: gh authenticated" true'
  echo 'run "prerequisite: aws authenticated" true'
  echo 'run "prerequisite: cloudflare api token is active" true'
  echo 'run "prerequisite: gcp adc is active" true'
  echo 'run "terraform plan: no drift" true'
  echo 'run "dns zone matches" true'
  echo 'if [ "$failed" -gt 0 ]; then exit 1; fi'
  echo 'echo "[acceptance-remote] OK"'
} > "$WORK/primary/scripts/acceptance-remote.sh"
mkdir -p "$WORK/primary/scripts/lib"
printf 'gh\tprerequisite: gh authenticated\naws\tprerequisite: aws authenticated\ncloudflare\tprerequisite: cloudflare api token is active\ngcp\tprerequisite: gcp adc is active\ngh,aws,cloudflare,gcp\tterraform plan: no drift\ncloudflare\tdns zone matches\n' \
  > "$WORK/primary/scripts/lib/acceptance-remote-deps.tsv"
mkdir -p "$WORK/primary/terraform"
# state は追跡外（本物は .gitignore）。期待値の出どころとして在ることだけを見る。
echo '{"version": 4}' > "$WORK/primary/terraform/terraform.tfstate"
printf 'terraform/terraform.tfstate\n' > "$WORK/primary/.gitignore"
echo "tracked" > "$WORK/primary/README"
echo '{"lockfileVersion": 3}' > "$WORK/primary/package-lock.json"
G -C "$WORK/primary" add -A >/dev/null
G -C "$WORK/primary" commit -q -m init
G -C "$WORK/primary" push -q origin main 2>/dev/null

# npm の偽物（#870）。呼ばれたら引数と場所を $WORK/npm へ書き、NPM_RC で終わる。本物の npm ci は
# 自己試験で決して打たない（node_modules を消して入れ直す）ので、C のどの回もこれを先に置く。
mkdir -p "$WORK/npmbin"
cat > "$WORK/npmbin/npm" <<STUB
#!/usr/bin/env bash
echo "\$* @ \$(pwd)" >> '$WORK/npm'
exit "\${NPM_RC:-0}"
STUB
chmod +x "$WORK/npmbin/npm"
NPM_RC=0

# sched_case <名前> <期待する result|reason> <検査が呼ばれるか yes/no>（出力は last_out に残す）
last_out=""
sched_case() {
  local name="$1" want="$2" want_called="$3" out rc=0 called=no
  tick
  rm -f "$WORK/called" "$WORK/npm"
  out="$(env -u AWS_PROFILE PATH="$WORK/npmbin:$PATH" NPM_RC="$NPM_RC" ACCEPTANCE_TF_DIR="$WORK/elsewhere" \
    bash "$SCHEDULED" --print --repo-dir "$WORK/primary" 2>&1)" || rc=$?
  last_out="$out"
  [ -f "$WORK/called" ] && called=yes
  local got
  got="$(printf '%s\n' "$out" | sed -n 's/^result: //p')|$(printf '%s\n' "$out" | sed -n 's/^reason: //p')"
  if [ "$got" != "$want" ] || [ "$called" != "$want_called" ]; then
    ng "C $name（want [$want] called=$want_called got [$got] called=$called rc=$rc）"
    printf '%s\n' "$out" | tail -n 20 | sed 's/^/    /' >&2
  fi
}

sched_case "main が origin/main と一致し汚れていなければ回す" "ok|-" yes
tick; [ "$(cat "$WORK/tfdir" 2>/dev/null)" = unset ] || ng "C 宣言の場所の差し替え（ACCEPTANCE_TF_DIR）を外してから回す"
tick; [ "$(cat "$WORK/called" 2>/dev/null)" = 0 ] || ng "C acceptance-remote.sh へ引数を渡していない（#850 の exit 2 を踏まない）"
# AWS_PROFILE: 空なら本番のプロファイルを入れ、設定済みなら上書きしない（2026-10-01 の 1 回目で aws の前提が落ちた）。
tick; [ "$(cat "$WORK/awsprofile" 2>/dev/null)" = game-forge-prod ] || ng "C AWS_PROFILE が空なら本番のプロファイルを入れて回す（got $(cat "$WORK/awsprofile" 2>/dev/null)）"
tick
rm -f "$WORK/awsprofile"
AWS_PROFILE=chosen-by-hand ACCEPTANCE_TF_DIR="$WORK/elsewhere" bash "$SCHEDULED" --print --repo-dir "$WORK/primary" >/dev/null 2>&1 || true
[ "$(cat "$WORK/awsprofile" 2>/dev/null)" = chosen-by-hand ] || ng "C 設定済みの AWS_PROFILE は上書きしない（got $(cat "$WORK/awsprofile" 2>/dev/null)）"

G -C "$WORK/primary" checkout -q -b feat/x
sched_case "main 以外のブランチでは回さない" "precondition|primary-not-on-main" no
G -C "$WORK/primary" checkout -q --detach main
sched_case "detach では回さない（main と同じ commit でも）" "precondition|primary-not-on-main" no
G -C "$WORK/primary" checkout -q main

# origin の main だけを進める（プライマリが遅れている）。
G clone -q "$WORK/origin.git" "$WORK/other" 2>/dev/null
echo "newer" >> "$WORK/other/README"
G -C "$WORK/other" commit -q -am newer
G -C "$WORK/other" push -q origin main 2>/dev/null
# 遅れていても、汚れていれば ff もしない（手元の作業を動かさない）。
echo "local edit" >> "$WORK/primary/README"
sched_case "遅れていて汚れていれば ff せず回さない" "precondition|primary-dirty" no
G -C "$WORK/primary" checkout -q -- README
tick; [ "$(G -C "$WORK/primary" rev-parse HEAD)" != "$(G -C "$WORK/other" rev-parse HEAD)" ] || ng "C 汚れていたのに ff した"
# 遅れているだけなら fast-forward してから回す（利用者の決定。PR #853）。
sched_case "origin/main より遅れていれば ff して回す" "ok|-" yes
tick; [ "$(G -C "$WORK/primary" rev-parse HEAD)" = "$(G -C "$WORK/other" rev-parse HEAD)" ] || ng "C ff の後のプライマリが origin/main と一致しない"
tick; printf '%s\n' "$last_out" | grep -q 'fast-forward しました' || ng "C ff したことをログ（要約の外）に残す"
tick; if sed -n '/^<!-- acceptance-remote-record/,$p' <<<"$last_out" | grep 'fast-forward' >/dev/null; then ng "C ff のことを要約へ載せない"; fi
tick; [ ! -f "$WORK/npm" ] || ng "C lock が変わらない ff では npm ci を打たない（got $(cat "$WORK/npm")）"

# 分岐している（手元の main にだけコミットがある）なら回さない。
echo "local commit" >> "$WORK/primary/README"
G -C "$WORK/primary" commit -q -am local
echo "remote commit" >> "$WORK/other/README"
G -C "$WORK/other" commit -q -am remote
G -C "$WORK/other" push -q origin main 2>/dev/null
sched_case "origin/main から分岐していれば回さない" "precondition|primary-not-at-origin-main" no
tick; [ "$(G -C "$WORK/primary" log -1 --format=%s)" = local ] || ng "C 分岐を勝手に解消した"
G -C "$WORK/primary" reset -q --hard origin/main

# ff が失敗する（追跡外のファイルが上書きされる）なら回さない。
echo "new" > "$WORK/other/NEWFILE"
G -C "$WORK/other" add NEWFILE
G -C "$WORK/other" commit -q -m newfile
G -C "$WORK/other" push -q origin main 2>/dev/null
echo "untracked local" > "$WORK/primary/NEWFILE"
sched_case "ff に失敗したら回さない" "precondition|primary-ff-failed" no
rm "$WORK/primary/NEWFILE"
sched_case "妨げが無くなれば ff して回す" "ok|-" yes

# lock が動いた ff だけ npm ci を打ってから回す（#870）。失敗したら回さず、前提の不成立にする。
lock_bump() { echo "{\"lockfileVersion\": 3, \"n\": $1}" > "$WORK/other/package-lock.json"; G -C "$WORK/other" commit -q -am "lock $1"; G -C "$WORK/other" push -q origin main 2>/dev/null; }
lock_bump 1
sched_case "lock が変わる ff では npm ci を打ってから回す" "ok|-" yes
ok_or_ng "$(cat "$WORK/npm" 2>/dev/null)" "ci @ $WORK/primary" "C npm ci をプライマリで 1 回だけ打つ"
tick; printf '%s\n' "$last_out" | grep -q 'npm ci を打ちました' || ng "C npm ci を打ったことをログ（要約の外）に残す"
tick; if sed -n '/^<!-- acceptance-remote-record/,$p' <<<"$last_out" | grep 'npm' >/dev/null; then ng "C npm ci のことを要約へ載せない"; fi
sched_case "遅れていなければ npm ci を打たない" "ok|-" yes
tick; [ ! -f "$WORK/npm" ] || ng "C 遅れていない回で npm ci を打った"
lock_bump 2
NPM_RC=1
sched_case "npm ci が失敗したら回さない（乖離にしない）" "precondition|npm-ci-failed" no
NPM_RC=0
tick; [ "$(G -C "$WORK/primary" rev-parse HEAD)" = "$(G -C "$WORK/other" rev-parse HEAD)" ] || ng "C npm ci の失敗でも ff は戻さない"

mkdir -p "$WORK/primary/terraform/.terraform/modules/m"
echo 'resource "x" "y" {}' > "$WORK/primary/terraform/.terraform/modules/m/main.tf"
sched_case "terraform/.terraform の中のモジュールは汚れに数えない" "ok|-" yes
echo 'terraform {}' > "$WORK/primary/terraform/override.tf"
sched_case "terraform/ に追跡外の override.tf があれば回さない" "precondition|primary-dirty" no
rm "$WORK/primary/terraform/override.tf"

echo "local edit" >> "$WORK/primary/README"
sched_case "追跡ファイルに手元の変更があれば回さない" "precondition|primary-dirty" no
G -C "$WORK/primary" checkout -q -- README
sched_case "戻せばまた回す" "ok|-" yes

mv "$WORK/primary/terraform/terraform.tfstate" "$WORK/state.bak"
sched_case "state が無ければ回さない（output から期待値を取れず、乖離に見えるため）" "precondition|state-missing" no
mv "$WORK/state.bak" "$WORK/primary/terraform/terraform.tfstate"

G -C "$WORK/primary" remote set-url origin "$WORK/missing.git"
sched_case "origin を取れなければ回さない" "precondition|fetch-failed" no

# ══════════════════════════════════════════════════════════════════════════════
# D. 取得（gh を差し替える）
# ══════════════════════════════════════════════════════════════════════════════
mkdir -p "$WORK/d/scripts/lib" "$WORK/d/bin"
cp "$FRESHNESS" "$JUDGE" "$WORK/d/scripts/"
sed 's/^ACCEPTANCE_RECORD_ISSUE=.*/ACCEPTANCE_RECORD_ISSUE="4242"/' "$ROOT/scripts/lib/acceptance-record.sh" > "$WORK/d/scripts/lib/acceptance-record.sh"
cat > "$WORK/d/bin/gh" <<'STUB'
#!/usr/bin/env bash
# 偽の gh。issue は locked=true、コメントは $GH_COMMENTS の行をそのまま返す。$GH_FAIL=1 なら失敗。
[ "${GH_FAIL:-0}" = 1 ] && exit 1
for a in "$@"; do
  case "$a" in
    */issues/4242/comments) cat "$GH_COMMENTS"; exit 0 ;;
    */issues/4242) echo true; exit 0 ;;
  esac
done
echo "gh stub: 知らない呼び出し: $*" >&2
exit 1
STUB
chmod +x "$WORK/d/bin/gh"
fresh_rc() { # fresh_rc <GH_FAIL> <コメントのファイル> [設定を差し替えた freshness]
  local rc=0
  PATH="$WORK/d/bin:$PATH" REPO=ojos/game-forge GH_FAIL="$1" GH_COMMENTS="$2" \
    bash "${3:-$WORK/d/scripts/acceptance-record-freshness.sh}" > "$WORK/d/out" 2>&1 || rc=$?
  echo "$rc"
}
# 取得の側は実時刻で判定する。新しい記録は「いま」で作り直す。
bash "$SUMMARY" --labels-from "$REMOTE" --exit 0 --head "$HEAD_SHA" --time "$(date -u +%Y-%m-%dT%H:%M:%SZ)" < "$WORK/out-ok" |
  jq -c -R -s '{user: {login: "ojos"}, author_association: "OWNER", created_at: (now | floor | todateiso8601), body: .}' > "$WORK/d/fresh.ndjson"
bash "$SUMMARY" --labels-from "$REMOTE" --exit 0 --head "$HEAD_SHA" --time "$(jq -n -r '(now - 5 * 86400) | floor | todateiso8601')" < "$WORK/out-ok" |
  jq -c -R -s '{user: {login: "ojos"}, author_association: "OWNER", created_at: ((now - 5 * 86400) | floor | todateiso8601), body: .}' > "$WORK/d/stale.ndjson"
ok_or_ng "$(fresh_rc 0 "$WORK/d/fresh.ndjson")" 0 "D1 新しい記録なら 0"
ok_or_ng "$(fresh_rc 0 "$WORK/d/stale.ndjson")" 1 "D2 古い記録なら 1"
ok_or_ng "$(fresh_rc 1 "$WORK/d/fresh.ndjson")" 2 "D3 GitHub から読めなければ 2（記録なしの 1 と混ぜない）"
tick; grep -q '確かめられませんでした' "$WORK/d/out" || ng "D3 読めなかったことを注記で言う"
: > "$WORK/d/empty.ndjson"
ok_or_ng "$(fresh_rc 0 "$WORK/d/empty.ndjson")" 1 "D4 コメントが無ければ 1（記録なし）"
mkdir -p "$WORK/d2/scripts/lib"
cp "$FRESHNESS" "$JUDGE" "$WORK/d2/scripts/"
sed 's/^ACCEPTANCE_RECORD_ISSUE=.*/ACCEPTANCE_RECORD_ISSUE=""/' "$ROOT/scripts/lib/acceptance-record.sh" > "$WORK/d2/scripts/lib/acceptance-record.sh"
ok_or_ng "$(fresh_rc 0 "$WORK/d/fresh.ndjson" "$WORK/d2/scripts/acceptance-record-freshness.sh")" 2 "D5 記録先が未設定なら 2"

# ══════════════════════════════════════════════════════════════════════════════
# E. ワークフローと launchd の雛形の形
# ══════════════════════════════════════════════════════════════════════════════
on_block="$(awk '/^on:/{f=1;next} f && /^[^ #]/{exit} f' "$WORKFLOW")"
tick; grep -q '^  schedule:' <<<"$on_block" || ng "E1 schedule で起動する"
tick; if grep -qE '^  (pull_request|pull_request_target|push|merge_group):' <<<"$on_block"; then ng "E2 PR / push では動かさない（required check にしない）"; fi
job="$(awk '/^jobs:/{f=1;next} f && /^  [a-z][a-z0-9_-]*:/{sub(/:.*/,""); gsub(/ /,""); print; exit}' "$WORKFLOW")"
tick
req="$(awk '/^variable "required_status_checks"/{f=1} f && /default/{print; exit}' "$ROOT/terraform/variables.tf")"
if [ -z "$job" ] || grep -qF "\"$job\"" <<<"$req"; then ng "E3 ジョブ（$job）を required_status_checks に入れない"; fi
tick; grep -q 'run: bash scripts/acceptance-record-freshness.sh$' "$WORKFLOW" || ng "E4 判定は scripts/ を呼ぶだけ（YAML へ書き写さない）"

if command -v python3 >/dev/null; then
  tick
  python3 - "$PLIST" <<'PY' || ng "E5 launchd の雛形が plist として読めない・毎日 12:00 でない"
import plistlib, sys
p = plistlib.load(open(sys.argv[1], "rb"))
assert p["StartCalendarInterval"] == {"Hour": 12, "Minute": 0}, p["StartCalendarInterval"]
assert p["ProgramArguments"][-1] == "__REPO__/scripts/acceptance-remote-launchd.sh"
assert p["StandardOutPath"].startswith("__HOME__/Library/Logs/game-forge/acceptance-remote/")
PY
else
  ng "E5 python3 が無いので plist を確かめられません"
fi
tick; [ -f "$LAUNCHER" ] || ng "E6 雛形が指す起動スクリプトがある"
# ホストの /bin/bash 3.2 に無いもの（docs/handoff.md 3 章）。
tick; if grep -nE '^[^#]*(mapfile|readarray|declare -A|local -A|,,\}|\^\^\})' "$LAUNCHER" >&2; then ng "E7 起動スクリプトに bash 4 以降の綴りがある"; fi
tick; bash -n "$LAUNCHER" || ng "E8 起動スクリプトの構文"

# ══════════════════════════════════════════════════════════════════════════════
# F. PR 向けの要約と判定（#845。acceptance-record-judge.sh --pr-head）
# ══════════════════════════════════════════════════════════════════════════════
#
# 記録は A の要約スクリプトに --pr を付けて作らせ、B と同じく PR のコメントの JSON で包む。
PR_NUM=845
NEW_HEAD=fedcba9876543210fedcba9876543210fedcba98
pr_body() { # pr_body <日前> <head> <PR 番号> <追加引数...>
  local ago="$1" h="$2" n="$3"; shift 3
  local t; t="$(jq -n -r --argjson now "$NOW" --argjson ago "$ago" '($now - ($ago * 86400) | floor) | todateiso8601')"
  bash "$SUMMARY" --labels-from "$REMOTE" --head "$h" --time "$t" --pr "$n" "$@"
}
# pr_rec <日前> <出力の仕込み> <終了コード> [head] [PR 番号] … 持ち主の PR 向けの記録を 1 件
pr_rec() { pr_body "$1" "${4:-$HEAD_SHA}" "${5:-$PR_NUM}" --exit "$3" < "$WORK/$2" | comment ojos OWNER "$1"; }
pr_pre() { pr_body "$1" "$HEAD_SHA" "$PR_NUM" --precondition "$2" < /dev/null | comment ojos OWNER "$1"; }

bash "$SUMMARY" --labels-from "$REMOTE" --exit 0 --head "$HEAD_SHA" --time "$T0" --pr "$PR_NUM" < "$WORK/out-ok" > "$WORK/s-pr-ok"
ok_or_ng "$(field pr "$WORK/s-pr-ok")|$(field head "$WORK/s-pr-ok")|$(field result "$WORK/s-pr-ok")" "$PR_NUM|$HEAD_SHA|ok" "F1 --pr の要約は pr: と head: を持ち、分類は同じ"
tick; grep -q "^PR #${PR_NUM} の head で回した外部層の記録（#845）" "$WORK/s-pr-ok" || ng "F1 --pr の要約の見出しが PR 向けになっていない"
ok_or_ng "$(grep -c '^pr: ' "$WORK/s-ok")" 0 "F1 --pr を付けない要約に pr: の行は無い"
ok_or_ng "$(diff <(grep -v -e '^pr: ' -e '^PR #' -e '^外部層の定期実行の記録' "$WORK/s-pr-ok") <(grep -v -e '^外部層の定期実行の記録' "$WORK/s-ok") > /dev/null && echo same)" same "F1 見出しと pr: の行のほかは定期実行の要約と同じ（同じことを 2 か所に書かない）"
ok_or_ng "$(rc_of bash "$SUMMARY" --labels-from "$REMOTE" --exit 0 --head "$HEAD_SHA" --time "$T0" --pr "845; rm -rf /")" 2 "F1 --pr は番号だけ"
for v in "${VALUES[@]}"; do
  tick
  pr_body 0.1 "$HEAD_SHA" "$PR_NUM" --exit 1 < "$WORK/out-drift" | grep -F -- "$v" >/dev/null && ng "F1 PR 向けの要約に値が出ています: $v"
done

# 定期実行の判定は PR 向けの記録を数えない（main の宣言の乖離を PR の宣言で上書きしない）。
pr_rec 0.1 out-ok 0 | judge_case "PR 向けの記録は定期実行の記録に数えない" "no-record"
{ owner_rec 1 out-drift 1; pr_rec 0.1 out-ok 0; } | judge_case "PR 向けの全件 PASS で定期実行の乖離を消さない" "drift"

# pr_case <名前> <期待する FAIL の理由（空なら ok）> [judge する head] < コメントの行
# 判定の出力は $WORK/last へ残す（pr_case はパイプの右＝サブシェルで回るので、変数では親へ届かない）。
pr_case() {
  local name="$1" want="$2" h="${3:-$HEAD_SHA}" got rc=0 out
  tick
  out="$(bash "$JUDGE" --owner ojos --pr-head "$h" --pr "$PR_NUM")" || rc=$?
  got="$(printf '%s\n' "$out" | sed -E -n 's/^FAIL ([a-z-]+).*/\1/p' | sort | paste -sd, -)"
  local want_rc=0; [ -z "$want" ] || want_rc=1
  if [ "$got" != "$want" ] || [ "$rc" != "$want_rc" ]; then
    ng "F $name（want rc=$want_rc [$want] got rc=$rc [$got]）"
    printf '%s\n' "$out" | sed 's/^/    /' >&2
  fi
  printf '%s\n' "$out" > "$WORK/last"
}
pr_case "記録が無ければ落とす" "no-record" < /dev/null
pr_rec 0.1 out-ok 0 | pr_case "head に一致し全件 PASS の記録があれば通す" ""
# 古い記録でも通す（鮮度は見ない。apply の後に回したことを head で結ぶ）。
pr_rec 30 out-ok 0 | pr_case "head が一致すれば記録の古さは問わない" ""
pr_rec 0.1 out-ok 0 | pr_case "head を進めると失敗に戻る" "head-mismatch" "$NEW_HEAD"
tick; grep -q 'head=0123456' "$WORK/last" || ng "F head-mismatch は最新の記録の head を出す"
pr_rec 0.1 out-drift 1 | pr_case "乖離を含む記録では落とす" "drift"
tick; grep -q '^FAIL drift .*dns zone matches' "$WORK/last" || ng "F drift は乖離した検査の名前を出す"
pr_rec 0.1 out-nogcp-drift 1 | pr_case "gcp が切れた回の Cloudflare の乖離でも落とす" "drift"
pr_rec 0.1 out-unknown 1 | pr_case "綴りの分からない FAIL がある記録では落とす" "drift"
pr_rec 0.1 out-noauth 1 | pr_case "認証が切れて回せなかった記録は確かめていない（失敗に数える）" "precondition"
tick; grep -q '^FAIL precondition .*prerequisite-failed' "$WORK/last" || ng "F precondition は理由の綴りを出す"
pr_pre 0.1 state-missing | pr_case "state の無いツリーからの記録も確かめていない" "precondition"
tick; grep -q 'state-missing' "$WORK/last" || ng "F state-missing の理由が読める"
pr_rec 0.1 out-crash 1 | pr_case "途中で止まった記録では落とす" "incomplete"
pr_rec 0.1 out-ok 1 | pr_case "全件 PASS でも終了コードが 0 でなければ落とす" "incomplete"
# 同じ head で回し直した結果を反映する（最新の 1 件で決める）。
{ pr_rec 0.2 out-noauth 1; pr_rec 0.1 out-ok 0; } | pr_case "認証を直して回し直した全件 PASS で通す" ""
{ pr_rec 0.2 out-ok 0; pr_rec 0.1 out-drift 1; } | pr_case "全件 PASS の後の乖離で落とす" "drift"
# 「最新」は投稿の順で決める。端末の時計が遅れて、後から載せた記録の time が前の記録より古くても、
# 後から載せたほうを使う（第二意見の指摘）。
{ pr_body 0.2 "$HEAD_SHA" "$PR_NUM" --exit 0 < "$WORK/out-ok" | comment ojos OWNER 0.2; pr_body 0.5 "$HEAD_SHA" "$PR_NUM" --exit 1 < "$WORK/out-drift" | comment ojos OWNER 0.1; } |
  pr_case "時計が遅れた端末から後で載せた乖離を、前の全件 PASS で隠さない" "drift"
{ pr_body 0.2 "$HEAD_SHA" "$PR_NUM" --exit 1 < "$WORK/out-drift" | comment ojos OWNER 0.2; pr_body 0.5 "$HEAD_SHA" "$PR_NUM" --exit 0 < "$WORK/out-ok" | comment ojos OWNER 0.1; } |
  pr_case "時計が遅れた端末から後で載せた全件 PASS で、回し直しを反映する" ""
# 新しい head の記録があれば、古い head の記録は見ない。
{ pr_rec 0.2 out-drift 1; pr_rec 0.1 out-ok 0 "$NEW_HEAD"; } | pr_case "新しい head で回し直した全件 PASS で通す" "" "$NEW_HEAD"
# 誰の・どの PR の記録を数えるか。
pr_body 0.1 "$HEAD_SHA" "$PR_NUM" --exit 0 < "$WORK/out-ok" | comment someone-else NONE 0.1 | pr_case "持ち主以外の記録は数えない" "no-record"
pr_body 0.1 "$HEAD_SHA" "$PR_NUM" --exit 0 < "$WORK/out-ok" | comment ojos COLLABORATOR 0.1 | pr_case "持ち主の名でも association が OWNER でなければ数えない" "no-record"
{ pr_rec 0.2 out-drift 1; pr_body 0.1 "$HEAD_SHA" "$PR_NUM" --exit 0 < "$WORK/out-ok" | comment someone-else NONE 0.1; } |
  pr_case "持ち主の乖離を、他人の全件 PASS で上書きしない" "drift"
pr_rec 0.1 out-ok 0 "$HEAD_SHA" 846 | pr_case "別の PR の記録は数えない" "no-record"
owner_rec 0.1 out-ok 0 | pr_case "定期実行の形の記録（pr: が無い）は数えない" "no-record"
sed 's/^/> /' "$WORK/s-pr-ok" | comment ojos OWNER 0.1 | pr_case "引用した記録は数えない" "no-record"
sed 's/^PASS dns zone matches$/DRIFT dns zone matches/' "$WORK/s-pr-ok" | comment ojos OWNER 0.1 | pr_case "result: ok でも PASS 以外の行があれば通さない" "incomplete"
sed '/^PASS dns zone matches$/d' "$WORK/s-pr-ok" | comment ojos OWNER 0.1 | pr_case "result: ok でも行が欠けていれば通さない" "incomplete"
sed 's/^result: ok$/result: great/' "$WORK/s-pr-ok" | comment ojos OWNER 0.1 | pr_case "形の崩れた記録は数えない" "no-record"
sed 's/$/\r/' "$WORK/s-pr-ok" | comment ojos OWNER 0.1 | pr_case "CRLF の本文でも読む" ""
tick
rc=0; echo '{"user": ' | bash "$JUDGE" --owner ojos --pr-head "$HEAD_SHA" --pr "$PR_NUM" > /dev/null 2>&1 || rc=$?
[ "$rc" = 2 ] || ng "F 壊れた JSON は「記録なし」(1) ではなく 2（got $rc）"
ok_or_ng "$(rc_of bash "$JUDGE" --owner ojos --pr-head "$HEAD_SHA")" 2 "F --pr-head だけでは判定しない（PR の番号が要る）"
ok_or_ng "$(rc_of bash "$JUDGE" --owner ojos --pr-head "${HEAD_SHA:0:7}" --pr "$PR_NUM")" 2 "F --pr-head は 40 桁だけ"

# ══════════════════════════════════════════════════════════════════════════════
# G. PR の判定と status（acceptance-pr-record.sh。gh を差し替える）
# ══════════════════════════════════════════════════════════════════════════════
#
# 偽の gh は、本物と同じく **--jq の式を API の形の JSON へ当てる。** スクリプトの jq（fork の除外・
# 改名の元・status の読み取り）も本物の応答の形で通る。POST は $GH_POSTS へ書く。
PRREC="$ROOT/scripts/acceptance-pr-record.sh"
mkdir -p "$WORK/g/bin" "$WORK/g/fx"
cat > "$WORK/g/bin/gh" <<'STUB'
#!/usr/bin/env bash
# 偽の gh。GET は $GH_FIXTURES/<パス（? より前）の / を __ に>.json を返す（無ければ 404 として失敗）。
# --jq があれば本物と同じくその式を当てる。$GH_FAIL の断片を含むパスは失敗する。
# POST は $GH_POSTS へ「POST <パス> <-f の値…>」を書く（$GH_FAIL_POST=1 なら失敗）。
set -u
sub="${1:-}"; shift || true
jqexpr="" method=GET path="" fields=() bodyfile=""
case "$sub" in
  api)
    while [ $# -gt 0 ]; do
      case "$1" in
        --jq) jqexpr="$2"; shift 2 ;;
        --paginate) shift ;;
        --method) method="$2"; shift 2 ;;
        -f) fields+=("$2"); shift 2 ;;
        -*) echo "gh stub: 知らないフラグ: $1" >&2; exit 1 ;;
        *) path="$1"; shift ;;
      esac
    done ;;
  pr)
    action="${1:-}"; num="${2:-}"; shift 2
    while [ $# -gt 0 ]; do
      case "$1" in
        --json) shift 2 ;;
        --jq) jqexpr="$2"; shift 2 ;;
        --body-file) bodyfile="$2"; shift 2 ;;
        *) echo "gh stub: 知らない引数: $1" >&2; exit 1 ;;
      esac
    done
    path="pr-${action}/${num}"
    if [ "$action" = comment ]; then
      { echo "COMMENT $num"; cat "$bodyfile"; } >> "$GH_POSTS"
      exit 0
    fi ;;
  *) echo "gh stub: 知らない呼び出し: $sub $*" >&2; exit 1 ;;
esac
if [ -n "${GH_FAIL:-}" ] && [[ "$path" == *"$GH_FAIL"* ]]; then echo "HTTP 502" >&2; exit 1; fi
if [ "$method" = POST ]; then
  [ "${GH_FAIL_POST:-0}" = 1 ] && { echo "HTTP 403" >&2; exit 1; }
  echo "POST $path ${fields[*]}" >> "$GH_POSTS"
  exit 0
fi
p="${path%%\?*}"
f="$GH_FIXTURES/${p//\//__}.json"
[ -f "$f" ] || { echo "HTTP 404: $p" >&2; exit 1; }
if [ -n "$jqexpr" ]; then jq -r -c "$jqexpr" < "$f"; else cat "$f"; fi
# <応答>.next があれば、次の呼び出しからはそちらを返す（判定の途中でコメントが付いた形）。
if [ -f "$f.next" ]; then mv "$f.next" "$f"; fi
STUB
chmod +x "$WORK/g/bin/gh"
FX="$WORK/g/fx"
R=ojos/game-forge
fx() { printf '%s' "$FX/$(printf '%s' "$1" | sed 's|/|__|g').json"; }
# pull <番号> <head> [fork の repo] … GET /repos/R/pulls/N の形
pull_fx() { jq -n --argjson n "$1" --arg sha "$2" --arg repo "${3:-$R}" \
  '{number: $n, state: "open", draft: false, head: {sha: $sha, ref: "feat/x", repo: {full_name: $repo}}, base: {ref: "main"}}' > "$(fx "repos/$R/pulls/$1")"; }
# files <番号> <ファイル名…>（"旧>新" で改名）… GET /pulls/N/files の形
files_fx() { local n="$1"; shift; printf '%s\n' "$@" | jq -R -s 'split("\n") | map(select(. != "")) | map(if test(">") then (split(">") as $p | {filename: $p[1], previous_filename: $p[0], status: "renamed"}) else {filename: ., status: "modified"} end)' > "$(fx "repos/$R/pulls/$n/files")"; }
# comments <番号> < コメントの行 … GET /issues/N/comments の形（配列）
comments_fx() { jq -s '.' > "$(fx "repos/$R/issues/$1/comments")"; }
statuses_fx() { printf '%s' "${2:-[]}" > "$(fx "repos/$R/commits/$1/statuses")"; }
GPOSTS="$WORK/g/posts"
prrec() { # prrec <期待する終了コード> <名前> <引数…>（出力は last_out、POST は $GPOSTS）
  local want="$1" name="$2" rc=0; shift 2
  tick
  : > "$GPOSTS"
  last_out="$(PATH="$WORK/g/bin:$PATH" REPO="$R" GH_FIXTURES="$FX" GH_POSTS="$GPOSTS" GH_FAIL="${GH_FAIL:-}" GH_FAIL_POST="${GH_FAIL_POST:-0}" RUN_URL="https://example.invalid/run/1" \
    bash "$PRREC" "$@" 2>&1)" || rc=$?
  if [ "$rc" != "$want" ]; then
    ng "G $name（want rc=$want got rc=$rc）"
    printf '%s\n' "$last_out" | tail -n 15 | sed 's/^/    /' >&2
  fi
}
posted() { grep -c "^POST repos/$R/statuses/$1 " "$GPOSTS" | tr -d ' '; }
posted_state() { sed -n "s|^POST repos/$R/statuses/$1 state=\([a-z]*\) context=acceptance-remote-pr description=\(.*\) target_url=.*|\1 \2|p" "$GPOSTS"; }

# 845: terraform/ を触る PR。head は HEAD_SHA。
pull_fx 845 "$HEAD_SHA"; files_fx 845 terraform/dns.tf docs/x.md; statuses_fx "$HEAD_SHA"
: | comments_fx 845
prrec 1 "記録が無ければ failure" --pr 845 --report
ok_or_ng "$(posted_state "$HEAD_SHA" | cut -d' ' -f1)" failure "G1 記録が無ければ status は failure"
tick; posted_state "$HEAD_SHA" | grep 'No external acceptance record' >/dev/null || ng "G1 説明が「記録が無い」になっていない: $(posted_state "$HEAD_SHA")"
pr_rec 0.1 out-ok 0 | comments_fx 845
prrec 0 "head に一致する全件 PASS は success" --pr 845 --report
ok_or_ng "$(posted_state "$HEAD_SHA" | cut -d' ' -f1)" success "G2 全件 PASS の記録で success"
# head を進める（記録は古い head のもの）。
pull_fx 845 "$NEW_HEAD"; statuses_fx "$NEW_HEAD"
prrec 1 "head を進めると failure" --pr 845 --report
ok_or_ng "$(posted_state "$NEW_HEAD")" "failure External acceptance record is for an older head; re-run after apply" "G3 進めた head には older head の failure"
# pull_request の契機の head（--head）を判定する。
prrec 0 "契機の head を判定する" --pr 845 --head "$HEAD_SHA" --report
ok_or_ng "$(posted "$HEAD_SHA")|$(posted "$NEW_HEAD")" "1|0" "G3 --head の commit へ書く"
pull_fx 845 "$HEAD_SHA"
pr_rec 0.1 out-drift 1 | comments_fx 845
prrec 1 "乖離は failure" --pr 845 --report
ok_or_ng "$(posted_state "$HEAD_SHA")" "failure External acceptance at this head found drift" "G4 乖離の説明"
pr_rec 0.1 out-noauth 1 | comments_fx 845
prrec 1 "前提の不成立は failure" --pr 845 --report
ok_or_ng "$(posted_state "$HEAD_SHA")" "failure External acceptance at this head did not run checks (prerequisite-failed)" "G5 前提の不成立は理由の綴りつきの failure"
# 読めなかったときは status を書かない（記録が無いと混ぜない）。
pr_rec 0.1 out-ok 0 | comments_fx 845
GH_FAIL="issues/845/comments" prrec 2 "コメントを読めなければ 2" --pr 845 --report
ok_or_ng "$(posted "$HEAD_SHA")" 0 "G6 コメントを読めなければ status を書かない"
GH_FAIL="pulls/845/files" prrec 2 "変更ファイルを読めなければ 2" --pr 845 --report
ok_or_ng "$(posted "$HEAD_SHA")" 0 "G6 変更ファイルを読めなければ status を書かない"
GH_FAIL_POST=1 prrec 2 "status を書けなければ 2" --pr 845 --report
# 同じ判定が既に付いていれば書き直さない（掃き寄せで積もらせない）。
statuses_fx "$HEAD_SHA" '[{"context": "acceptance-remote-pr", "state": "success", "description": "External acceptance passed at this head (all checks PASS)"}, {"context": "acceptance-remote-pr", "state": "failure", "description": "older"}]'
prrec 0 "同じ判定なら書き直さない" --pr 845 --report
ok_or_ng "$(posted "$HEAD_SHA")" 0 "G7 最新の status と同じなら POST しない"
statuses_fx "$HEAD_SHA" '[{"context": "acceptance-remote-pr", "state": "failure", "description": "External acceptance at this head found drift"}]'
prrec 0 "判定が変われば書く" --pr 845 --report
ok_or_ng "$(posted "$HEAD_SHA")" 1 "G7 最新の status と違えば POST する"
statuses_fx "$HEAD_SHA"
prrec 0 "--report が無ければ書かない" --pr 845
ok_or_ng "$(posted "$HEAD_SHA")" 0 "G8 --report が無ければ status を書かない"
# 判定の間にコメントが変わったら書かない（掃き寄せが古い一覧で、新しい記録の判定を上書きしない）。
pr_rec 0.1 out-ok 0 | comments_fx 845
{ pr_rec 0.1 out-ok 0; pr_rec 0.05 out-drift 1; } | jq -s '.' > "$(fx "repos/$R/issues/845/comments").next"
prrec 0 "判定の間にコメントが変われば書かない" --pr 845 --report
ok_or_ng "$(posted "$HEAD_SHA")" 0 "G7b 判定の間に記録が付いたら、古い一覧の判定を書かない"
rm -f "$(fx "repos/$R/issues/845/comments").next"
# terraform/ を触らない PR では何も求めない。
pull_fx 900 "$NEW_HEAD"; files_fx 900 docs/handoff.md src/app.ts; : | comments_fx 900
prrec 0 "terraform/ を触らない PR は対象外" --pr 900 --report
ok_or_ng "$(wc -l < "$GPOSTS" | tr -d ' ')" 0 "G9 terraform/ を触らない PR には status を書かない"
# 改名の元が terraform/ なら触っている。
pull_fx 901 "$NEW_HEAD"; files_fx 901 "terraform/old.tf>infra/old.tf"; : | comments_fx 901
prrec 1 "terraform/ から外へ動かす PR も対象" --pr 901 --report
ok_or_ng "$(posted "$NEW_HEAD")" 1 "G9 改名の元が terraform/ なら判定する"
# fork の PR は判定しない。
pull_fx 902 "$NEW_HEAD" someone/game-forge; files_fx 902 terraform/x.tf; : | comments_fx 902
prrec 0 "fork の PR は対象外" --pr 902 --report
ok_or_ng "$(wc -l < "$GPOSTS" | tr -d ' ')" 0 "G10 fork の PR には status を書かない"
# 掃き寄せ: 一覧の jq（fork と head.repo が null の除外）を本物の形で通す。
jq -n --arg r "$R" --arg a "$HEAD_SHA" --arg b "$NEW_HEAD" '[
  {number: 845, head: {sha: $a, repo: {full_name: $r}}},
  {number: 900, head: {sha: $b, repo: {full_name: $r}}},
  {number: 902, head: {sha: $b, repo: {full_name: "someone/game-forge"}}},
  {number: 903, head: {sha: $b, repo: null}}]' > "$(fx "repos/$R/pulls")"
pr_rec 0.1 out-ok 0 | comments_fx 845
prrec 0 "掃き寄せは terraform/ を触る同じリポジトリの PR だけを判定する" --sweep --report
ok_or_ng "$(posted "$HEAD_SHA")|$(wc -l < "$GPOSTS" | tr -d ' ')" "1|1" "G11 掃き寄せが書くのは 845 の 1 件だけ"
pr_rec 0.1 out-drift 1 | comments_fx 845
prrec 1 "掃き寄せでも failure を数える" --sweep --report
GH_FAIL="repos/$R/pulls" prrec 2 "一覧を読めなければ 2" --sweep --report
ok_or_ng "$(wc -l < "$GPOSTS" | tr -d ' ')" 0 "G12 一覧を読めなければ 1 本も書かない"

# ══════════════════════════════════════════════════════════════════════════════
# H. 記録を作る入口（acceptance-remote-scheduled.sh --pr）
# ══════════════════════════════════════════════════════════════════════════════
#
# C の作業ツリー（origin は取れない状態のまま）を使う。**--pr は fetch も ff もしない**ので、
# origin が取れなくても回り、HEAD は動かない。
G -C "$WORK/primary" checkout -q --detach HEAD~1 2>/dev/null || G -C "$WORK/primary" checkout -q --detach HEAD
PRIMARY_HEAD="$(G -C "$WORK/primary" rev-parse HEAD)"
pr_view_fx() { jq -n --arg s "$1" --arg h "$2" '{state: $s, headRefOid: $h}' > "$(fx "pr-view/$3")"; }
pr_view_fx OPEN "$PRIMARY_HEAD" 845
# sched_pr <名前> <期待する終了コード> <期待する result|reason（要約が無ければ |）> <検査が呼ばれるか> [--print]
sched_pr() {
  local name="$1" want_rc="$2" want="$3" want_called="$4" out rc=0 called=no got; shift 4
  tick
  rm -f "$WORK/called"; : > "$GPOSTS"
  out="$(PATH="$WORK/g/bin:$PATH" GH_FIXTURES="$FX" GH_POSTS="$GPOSTS" ACCEPTANCE_TF_DIR="$WORK/elsewhere" \
    bash "$SCHEDULED" --repo-dir "$WORK/primary" --pr 845 "$@" 2>&1)" || rc=$?
  last_out="$out"
  [ -f "$WORK/called" ] && called=yes
  got="$(printf '%s\n' "$out" | sed -n 's/^result: //p')|$(printf '%s\n' "$out" | sed -n 's/^reason: //p')"
  if [ "$rc" != "$want_rc" ] || [ "$got" != "$want" ] || [ "$called" != "$want_called" ]; then
    ng "H $name（want rc=$want_rc [$want] called=$want_called got rc=$rc [$got] called=$called）"
    printf '%s\n' "$out" | tail -n 20 | sed 's/^/    /' >&2
  fi
}
sched_pr "HEAD が PR の head と一致すれば回して PR へ載せる" 0 "ok|-" yes
tick; grep -q '^COMMENT 845$' "$GPOSTS" || ng "H 投稿先は固定の issue ではなく PR #845"
tick; { grep -qx "pr: 845" "$GPOSTS" && grep -qx "head: $PRIMARY_HEAD" "$GPOSTS"; } || ng "H 投稿した要約に pr: 845 と PR の head がある"
tick; [ "$(G -C "$WORK/primary" rev-parse HEAD)" = "$PRIMARY_HEAD" ] || ng "H --pr はプライマリを動かさない（fetch も ff もしない）"
tick; [ "$(cat "$WORK/tfdir" 2>/dev/null)" = unset ] || ng "H --pr でも宣言の場所の差し替えを外す"
sched_pr "--print なら投稿しない" 0 "ok|-" yes --print
ok_or_ng "$(wc -l < "$GPOSTS" | tr -d ' ')" 0 "H --print では投稿しない"
pr_view_fx OPEN "$NEW_HEAD" 845
sched_pr "HEAD が PR の head と一致しなければ回さず、載せない" 3 "|" no
ok_or_ng "$(wc -l < "$GPOSTS" | tr -d ' ')" 0 "H 一致しなければ投稿しない"
pr_view_fx MERGED "$PRIMARY_HEAD" 845
sched_pr "open でない PR には回さない" 3 "|" no
rm -f "$(fx pr-view/845)"
sched_pr "PR を読めなければ回さない" 3 "|" no
pr_view_fx OPEN "$PRIMARY_HEAD" 845
echo "local edit" >> "$WORK/primary/README"
sched_pr "PR の head でも汚れていれば回さず、前提の不成立として載せる" 1 "precondition|primary-dirty" no
tick; grep -qx "pr: 845" "$GPOSTS" || ng "H 前提の不成立も PR の記録として載せる（理由が PR で読める）"
G -C "$WORK/primary" checkout -q -- README
mv "$WORK/primary/terraform/terraform.tfstate" "$WORK/state.bak"
sched_pr "state の無いツリー（worktree）からは回さない" 1 "precondition|state-missing" no
mv "$WORK/state.bak" "$WORK/primary/terraform/terraform.tfstate"
tick; rc=0; bash "$SCHEDULED" --repo-dir "$WORK/primary" --pr "845x" --print > /dev/null 2>&1 || rc=$?; [ "$rc" = 3 ] || ng "H --pr は番号だけ（got $rc）"

# ══════════════════════════════════════════════════════════════════════════════
# I. PR のワークフローの形
# ══════════════════════════════════════════════════════════════════════════════
PR_WORKFLOW="$ROOT/.github/workflows/acceptance-remote-pr.yml"
pr_on="$(awk '/^on:/{f=1;next} f && /^[^ #]/{exit} f' "$PR_WORKFLOW")"
tick; grep -q '^  pull_request:' <<<"$pr_on" || ng "I1 pull_request で起動する"
tick; awk '/^  pull_request:/{f=1;next} f && /^  [a-z_]+:/{exit} f' <<<"$pr_on" | grep "^      - 'terraform/\*\*'$" >/dev/null || ng "I1 pull_request は terraform/** に絞る"
tick; { grep -q '^  issue_comment:' <<<"$pr_on" && grep -q '^  schedule:' <<<"$pr_on"; } || ng "I2 記録が後から付いたときの契機（issue_comment と schedule）がある"
tick; if grep -qE '^  (pull_request_target|push|merge_group):' <<<"$pr_on"; then ng "I3 pull_request_target / push / merge_group では動かさない"; fi
pr_job="$(awk '/^jobs:/{f=1;next} f && /^  [a-z][a-z0-9_-]*:/{sub(/:.*/,""); gsub(/ /,""); print; exit}' "$PR_WORKFLOW")"
tick; if [ -z "$pr_job" ] || grep -qF "\"$pr_job\"" <<<"$req" || grep -qF '"acceptance-remote-pr"' <<<"$req"; then ng "I4 ジョブ（$pr_job）も status の名前も required_status_checks に入れない"; fi
tick; grep -qF "startsWith(github.event.comment.body, '$(sed -n "s/^ACCEPTANCE_RECORD_MARKER='\(.*\)'$/\1/p" "$ROOT/scripts/lib/acceptance-record.sh")')" "$PR_WORKFLOW" || ng "I5 コメントの契機の印が scripts/lib/acceptance-record.sh の印と同じ綴り"
tick; { grep -q 'bash scripts/acceptance-pr-record.sh --report --pr ' "$PR_WORKFLOW" && grep -q 'bash scripts/acceptance-pr-record.sh --report --sweep' "$PR_WORKFLOW"; } || ng "I6 判定は scripts/ を呼ぶだけ（YAML へ書き写さない）"
tick; grep -q 'ref: \${{ github.event.repository.default_branch }}' "$PR_WORKFLOW" || ng "I7 判定は既定ブランチの側を取る"
tick; grep -q 'CONTEXT="acceptance-remote-pr"' "$PRREC" || ng "I8 status の名前は acceptance-remote-pr"

n="$(wc -l < "$WORK/count" | tr -d ' ')"
if [ -s "$WORK/failed" ]; then
  echo "[acceptance-remote-record] $n 件中 $(wc -l < "$WORK/failed" | tr -d ' ') 件が期待と食い違いました（上記）" >&2
  exit 1
fi
echo "[acceptance-remote-record] $n 件すべて期待どおり"
