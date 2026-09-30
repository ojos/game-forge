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
# 回すのは pull_request の経路だけである。掃き寄せも同じ judge を呼ぶ。
#
# 終了コード: 0 = すべて期待どおり / 1 = 1 件でも外れた
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
WORKFLOW="$ROOT/.github/workflows/second-opinion-gate.yml"

command -v jq >/dev/null || { echo "[second-opinion-gate-workflow] jq がありません" >&2; exit 1; }

WORK="$(mktemp -d)"
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
commit() { printf '{"author":{"login":"%s"},"committer":{"login":"%s"},"commit":{"verification":{"verified":%s}}}' "$1" "$2" "$3"; }

# case <名前> <期待する status（無しは none）> <PR の著者> <記録があるか yes/no> <コミットの JSON...>
case_() {
  local name="$1" want="$2" author="$3" recorded="$4"; shift 4
  local fx="$WORK/fx" got
  rm -rf "$fx"; mkdir -p "$fx"
  printf '{"user":{"login":"%s"},"draft":false,"head":{"sha":"%s"}}' "$author" "$SHA" > "$fx/pr.json"
  local IFS=,; printf '[%s]' "$*" > "$fx/commits.json"; unset IFS
  if [ "$recorded" = yes ]; then
    printf '[{"body":"<!-- second-opinion sha=%s -->\\nLGTM"}]' "$SHA" > "$fx/comments.json"
  else
    printf '[{"body":"関係ないコメント"}]' > "$fx/comments.json"
  fi
  ( cd "$ROOT" && PATH="$WORK/bin:$PATH" FIXTURES="$fx" GH_TOKEN=x REPO=o/r EVENT=pull_request \
      PR_NUMBER=1 TRIGGER_SHA="$SHA" RUN_URL=u bash "$WORK/run.sh" ) >/dev/null 2>&1 || true
  got="$(cat "$fx/statuses" 2>/dev/null || echo none)"
  if [ "$got" != "$want" ]; then
    echo "[second-opinion-gate-workflow] FAIL: $name（want=$want got=$(echo "$got" | tr '\n' ' ')）" >&2
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

if [ "$fail" -ne 0 ]; then
  echo "[second-opinion-gate-workflow] 判定が期待と食い違いました（上記）" >&2
  exit 1
fi
echo "SECOND_OPINION_GATE_WORKFLOW_PASS"
