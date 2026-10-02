#!/usr/bin/env bash
# check-second-opinion-gate-workflow.sh — second-opinion-gate.yml の判定を、gh を差し替えて回す（#838）
#
# check-second-opinion-gate-exempt.sh は判定スクリプトの exempt / judge しか見ない。**ゲートが
# それを success / failure の status へ結び付けるところは、ワークフローの run の中にある**
# （#838 の第二意見の指摘）。そこで run の本文を YAML からそのまま取り出し、次を差し替えて回す。
#
#   gh    … 用意した JSON に、呼ばれた --jq の式を本物の jq で当てて返す。**YAML に書いた jq の
#           式もそのまま確かめる。** status の投稿（POST statuses）は state を記録するだけ
#   sleep … 何もしない（猶予の 300 秒を待たない）
#
# pull_request の経路と、掃き寄せ（schedule）の経路の両方を回す。掃き寄せは push の時刻を
# check-run から採り、無ければ PR の更新時刻で代える（#888）。
#
# 同じ所で、ゲートと対になる 2 つも確かめる（#888。新しい検査スクリプトを増やさないため、
# 確認側の検査にまとめる）。
#
#   権限 … run が呼ぶ API の先（statuses / issues / pulls / check-runs）に対応する権限が、
#          ワークフローの permissions に宣言されているか
#   記録 … scripts/second-opinion-record.sh の save が、失敗したときに既存の記録を壊さないか
#          （ゲートは印の SHA しか見ないので、壊れた記録が投稿されると中身の無いまま緑になる）
#
# 終了コード: 0 = すべて期待どおり / 1 = 1 件でも外れた
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
WORKFLOW="$ROOT/.github/workflows/second-opinion-gate.yml"

command -v jq >/dev/null || { echo "[second-opinion-gate-workflow] jq がありません" >&2; exit 1; }

WORK="$(mktemp -d "${TMPDIR:-/tmp}/so-gate-wf.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

# run: | の本文を取り出す（ステップは 1 つだけで、本文は 10 桁の字下げ）。
awk '/^        run: \|/{f=1;next} f{ if ($0 ~ /^[^ ]/) exit; sub(/^          /,""); print }' \
  "$WORKFLOW" > "$WORK/run.sh"
if ! grep -q '^judge() {' "$WORK/run.sh" || ! grep -q '^is_exempt() {' "$WORK/run.sh"; then
  echo "[second-opinion-gate-workflow] run の本文を取り出せませんでした（judge / is_exempt が無い）" >&2
  exit 1
fi

mkdir -p "$WORK/bin"
cat > "$WORK/bin/gh" <<'STUB'
#!/usr/bin/env bash
# 偽の gh。FIXTURES の JSON に --jq の式を当てて返す。
set -euo pipefail
path="" expr="" method="GET" state=""
while [ $# -gt 0 ]; do
  case "$1" in
    api|--paginate) ;;
    --jq) expr="$2"; shift ;;
    --method) method="$2"; shift ;;
    -f) case "$2" in state=*) state="${2#state=}" ;; esac; shift ;;
    repos/*) path="$1" ;;
  esac
  shift
done
if [ "$method" = "POST" ]; then
  echo "$state" >> "$FIXTURES/statuses"
  exit 0
fi
case "$path" in
  */pulls\?*) file=pulls.json ;;
  */commits/*/check-runs) file=check-runs.json ;;
  */pulls/*/commits) file=commits.json ;;
  */pulls/*) file=pr.json ;;
  */issues/*/comments) file=comments.json ;;
  *) echo "gh stub: 知らない path: $path" >&2; exit 1 ;;
esac
[ -f "$FIXTURES/$file" ] || exit 1
jq -r "$expr" "$FIXTURES/$file"
STUB
printf '#!/usr/bin/env bash\nexit 0\n' > "$WORK/bin/sleep"
chmod +x "$WORK/bin/gh" "$WORK/bin/sleep"

SHA=0123456789abcdef0123456789abcdef01234567
fail=0

# commit <author> <committer> <verified>
record_comment() { printf '{"user":{"login":"%s"},"author_association":"%s","body":"<!-- second-opinion sha=%s -->\\nLGTM"}' "$1" "$2" "$SHA"; }
commit() { printf '{"author":{"login":"%s"},"committer":{"login":"%s"},"commit":{"verification":{"verified":%s}}}' "$1" "$2" "$3"; }

# case <名前> <期待する status（無しは none）> <PR の著者> <記録があるか yes/no> <コミットの JSON...>
case_() {
  local name="$1" want="$2" author="$3" recorded="$4"; shift 4
  local fx="$WORK/fx" got
  rm -rf "$fx"; mkdir -p "$fx"
  printf '{"user":{"login":"%s"},"draft":false,"head":{"sha":"%s"}}' "$author" "$SHA" > "$fx/pr.json"
  local IFS=,; printf '[%s]' "$*" > "$fx/commits.json"; unset IFS
  # 記録のコメントは本物の API と同じく、著者（user.login）と author_association を持つ（#865）。
  # REPO=o/r なので持ち主は o。
  case "$recorded" in
    yes) printf '[%s]' "$(record_comment o OWNER)" > "$fx/comments.json" ;;
    stranger) printf '[%s]' "$(record_comment mallory NONE)" > "$fx/comments.json" ;;
    collaborator) printf '[%s]' "$(record_comment helper COLLABORATOR)" > "$fx/comments.json" ;;
    both) printf '[%s,%s]' "$(record_comment mallory NONE)" "$(record_comment o OWNER)" > "$fx/comments.json" ;;
    *) printf '[{"user":{"login":"o"},"author_association":"OWNER","body":"関係ないコメント"}]' > "$fx/comments.json" ;;
  esac
  # 掃き寄せの経路（SWEEP_* が設定されているとき）。本物の API と同じ形で、PR の一覧には
  # updated_at が、check-runs には total_count と check_runs が入る（check-run が無ければ空配列）。
  local event=pull_request
  if [ -n "${SWEEP_UPDATED_AT+x}" ]; then
    event=schedule
    printf '[{"number":1,"draft":false,"head":{"sha":"%s","repo":{"full_name":"o/r"}},"updated_at":"%s"}]' \
      "$SHA" "$SWEEP_UPDATED_AT" > "$fx/pulls.json"
    if [ -n "$SWEEP_CHECK_RUN_STARTED_AT" ]; then
      printf '{"total_count":1,"check_runs":[{"name":"verify","started_at":"%s"}]}' \
        "$SWEEP_CHECK_RUN_STARTED_AT" > "$fx/check-runs.json"
    else
      printf '{"total_count":0,"check_runs":[]}' > "$fx/check-runs.json"
    fi
  fi
  ( cd "$ROOT" && PATH="$WORK/bin:$PATH" FIXTURES="$fx" GH_TOKEN=x REPO=o/r EVENT="$event" \
      PR_NUMBER=1 TRIGGER_SHA="$SHA" RUN_URL=u bash "$WORK/run.sh" ) >"$fx/out" 2>&1 || true
  got="$(cat "$fx/statuses" 2>/dev/null || echo none)"
  if [ "$got" != "$want" ]; then
    echo "[second-opinion-gate-workflow] FAIL: $name（want=$want got=$(echo "$got" | tr '\n' ' ')）" >&2
    fail=1
  fi
  # 持ち主以外の印があったときだけ警告が出る（#865。数えないが黙って捨てない）。
  local want_warn=no got_warn=no
  case "$recorded" in stranger|collaborator|both) want_warn=yes ;; esac
  grep -q '持ち主（o）以外が書いたもの' "$fx/out" && got_warn=yes
  if [ "$got_warn" != "$want_warn" ]; then
    echo "[second-opinion-gate-workflow] FAIL: $name（持ち主以外の印の警告 want=$want_warn got=$got_warn）" >&2
    fail=1
  fi
}

DEP='dependabot[bot]'
case_ "Dependabot の PR は記録が無くても success" success "$DEP" no \
  "$(commit "$DEP" web-flow true)"
case_ "人の PR で記録が無ければ failure" failure ido-ojos no \
  "$(commit ido-ojos ido-ojos false)"
case_ "人の PR で記録があれば success" success ido-ojos yes \
  "$(commit ido-ojos ido-ojos false)"
case_ "Dependabot の PR に人のコミットが混ざり記録が無ければ failure" failure "$DEP" no \
  "$(commit "$DEP" web-flow true)" "$(commit ido-ojos ido-ojos false)"
# author は作る側が書ける。GitHub の署名が無ければ Dependabot 名義でも信じない。
case_ "Dependabot 名義でも署名が無ければ failure" failure "$DEP" no \
  "$(commit "$DEP" web-flow true)" "$(commit "$DEP" ido-ojos false)"
case_ "Dependabot 名義で committer が web-flow でも未検証なら failure" failure "$DEP" no \
  "$(commit "$DEP" web-flow false)"

# 記録の著者（#865）。public なので誰でも印つきのコメントを書ける。数えるのは持ち主だけ。
case_ "持ち主以外（知らない人）が書いた印だけなら failure" failure ido-ojos stranger \
  "$(commit ido-ojos ido-ojos false)"
case_ "協力者が書いた印だけでも failure（持ち主だけを数える）" failure ido-ojos collaborator \
  "$(commit ido-ojos ido-ojos false)"
case_ "持ち主の記録があれば、他人の印が混ざっていても success" success ido-ojos both \
  "$(commit ido-ojos ido-ojos false)"

# ── 掃き寄せ（schedule）の経路（#888）────────────────────────────────────────
# check-run が 1 つも無い PR は、pull_request の契機が届かなかった PR である（このリポジトリで
# PR の head に check-run を作るのは pull_request の契機のワークフローだけ）。掃き寄せが
# 拾うべきなのはまさにその PR なので、更新時刻で代えて判定する。猶予（300 秒）は守る。
OLD=2020-01-01T00:00:00Z
NOW="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
sweep() {
  local updated_at="$1" started_at="$2"; shift 2
  SWEEP_UPDATED_AT="$updated_at" SWEEP_CHECK_RUN_STARTED_AT="$started_at" case_ "$@"
}
sweep "$OLD" "" "掃き寄せ: check-run が無く、更新から猶予を過ぎ、記録が無ければ failure" failure ido-ojos no \
  "$(commit ido-ojos ido-ojos false)"
sweep "$OLD" "" "掃き寄せ: check-run が無く、更新から猶予を過ぎ、記録があれば success" success ido-ojos yes \
  "$(commit ido-ojos ido-ojos false)"
sweep "$NOW" "" "掃き寄せ: check-run が無く、更新が猶予の内なら判定しない" none ido-ojos no \
  "$(commit ido-ojos ido-ojos false)"
sweep "$OLD" "$OLD" "掃き寄せ: check-run の開始から猶予を過ぎ、記録が無ければ failure" failure ido-ojos no \
  "$(commit ido-ojos ido-ojos false)"
sweep "$OLD" "$NOW" "掃き寄せ: check-run があれば更新時刻より check-run の開始時刻を見る" none ido-ojos no \
  "$(commit ido-ojos ido-ojos false)"

# ── 権限（#888）──────────────────────────────────────────────────────────────
# **呼んでいる先の権限は宣言する**（ワークフローの permissions の注記）。permissions を書いた
# 時点で、書かなかった権限は none になる。public のいまは checks を宣言しなくても読めるので、
# 本物の GitHub の上では宣言漏れが表に出ない——だからここで静的に押さえる。
perms="$(awk '/^permissions:/{f=1;next} f{ if ($0 !~ /^ /) exit; print }' "$WORKFLOW" | grep -v '^ *#' || true)"
# need <run の中の呼び先（固定文字列）> <権限名> <要る水準 read|write>
need() {
  local callee="$1" perm="$2" level="$3" ok
  grep -qF "$callee" "$WORK/run.sh" || return 0
  case "$level" in
    read) ok='(read|write)' ;;
    write) ok='write' ;;
  esac
  if ! printf '%s\n' "$perms" | grep -Eq "^  ${perm}: ${ok}\$"; then
    echo "[second-opinion-gate-workflow] FAIL: run が ${callee} を呼ぶのに、permissions に ${perm}: ${level} がありません" >&2
    fail=1
  fi
}
need '/statuses/' statuses write
need '/issues/' issues read
need '/pulls' pull-requests read
need '/check-runs' checks read

# ── 記録（scripts/second-opinion-record.sh save。#888）───────────────────────────
# save が失敗しても、既存の記録（meta と output の組）を変えないこと。本物のスクリプトを、
# 使い捨ての git リポジトリの中で回す（スクリプトは自分の 1 つ上をリポジトリの根として cd する）。
REC="$WORK/rec"
mkdir -p "$REC/scripts"
cp "$ROOT/scripts/second-opinion-record.sh" "$REC/scripts/"
git -C "$REC" init -q
git -C "$REC" -c user.name=t -c user.email=t@example.invalid -c commit.gpgsign=false commit -q --allow-empty -m init
rec_dir="$REC/$(git -C "$REC" rev-parse --git-path second-opinion)"
save() { bash "$REC/scripts/second-opinion-record.sh" save --engine e --verdict pass --scope range:HEAD~0..HEAD "$@"; }

if ! printf '1 回目の出力\n' | save >/dev/null 2>&1; then
  echo "[second-opinion-gate-workflow] FAIL: 記録: 1 回目の save が失敗しました" >&2
  fail=1
else
  cp "$rec_dir/output" "$WORK/output.before"
  cp "$rec_dir/meta" "$WORK/meta.before"
  # 第二意見が何も出さなかった（エンジンが落ちた等）。save は失敗し、前の記録は残る。
  if : | save >/dev/null 2>&1; then
    echo "[second-opinion-gate-workflow] FAIL: 記録: 空の出力の save が成功しました" >&2
    fail=1
  fi
  if ! cmp -s "$rec_dir/output" "$WORK/output.before" || ! cmp -s "$rec_dir/meta" "$WORK/meta.before"; then
    echo "[second-opinion-gate-workflow] FAIL: 記録: 失敗した save が既存の記録を書き換えました（output: $(wc -c < "$rec_dir/output" | tr -d ' ') バイト）" >&2
    fail=1
  fi
  if [ "$(ls -A "$rec_dir" | tr '\n' ' ')" != "meta output " ]; then
    echo "[second-opinion-gate-workflow] FAIL: 記録: 失敗した save が一時ファイルを残しました" >&2
    fail=1
  fi
  # 成功した save は、output と meta を組で置き換える。
  if ! printf '2 回目の出力\n' | save --runs 2 >/dev/null 2>&1 \
    || [ "$(cat "$rec_dir/output")" != "2 回目の出力" ] \
    || ! grep -qx 'runs=2' "$rec_dir/meta"; then
    echo "[second-opinion-gate-workflow] FAIL: 記録: 2 回目の save が output と meta を置き換えませんでした" >&2
    fail=1
  fi
fi

if [ "$fail" -ne 0 ]; then
  echo "[second-opinion-gate-workflow] 判定が期待と食い違いました（上記）" >&2
  exit 1
fi
echo "SECOND_OPINION_GATE_WORKFLOW_PASS"
