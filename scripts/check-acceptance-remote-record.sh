#!/usr/bin/env bash
# check-acceptance-remote-record.sh — 外部層の定期実行（#844）の、要約・判定・起動前の確認を表で確かめる
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
G -C "$WORK/primary" add -A >/dev/null
G -C "$WORK/primary" commit -q -m init
G -C "$WORK/primary" push -q origin main 2>/dev/null

# sched_case <名前> <期待する result|reason> <検査が呼ばれるか yes/no>（出力は last_out に残す）
last_out=""
sched_case() {
  local name="$1" want="$2" want_called="$3" out rc=0 called=no
  tick
  rm -f "$WORK/called"
  out="$(ACCEPTANCE_TF_DIR="$WORK/elsewhere" bash "$SCHEDULED" --print --repo-dir "$WORK/primary" 2>&1)" || rc=$?
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
tick; if sed -n '/^<!-- acceptance-remote-record/,$p' <<<"$last_out" | grep -q 'fast-forward'; then ng "C ff のことを要約へ載せない"; fi

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

n="$(wc -l < "$WORK/count" | tr -d ' ')"
if [ -s "$WORK/failed" ]; then
  echo "[acceptance-remote-record] $n 件中 $(wc -l < "$WORK/failed" | tr -d ' ') 件が期待と食い違いました（上記）" >&2
  exit 1
fi
echo "[acceptance-remote-record] $n 件すべて期待どおり"
