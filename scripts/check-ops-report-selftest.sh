#!/usr/bin/env bash
# check-ops-report-selftest.sh — 運営報告の下書きの検査と、Docs へ置く段の自己試験（#936）
#
# 使い方: bash scripts/check-ops-report-selftest.sh
# 終了コード: 0 = OPS_REPORT_SELFTEST_PASS / 1 = どれかが期待と違う
#
# scripts/acceptance.sh から回る（ローカル層）。**ネットワークも認証も本物の claude も使わない。**
#
# 1 節  scripts/check-ops-report.sh
#   - きれいな下書きが 0（日付・見出しの番号・人が埋める欄・桁区切り・全角の数字・
#     @gameforgejp・許可した URL・題名の中の数字を含めて、偽陽性が出ないこと）
#   - 仕込んだ違反 4 種（材料に無い数字・他人のハンドル・ARN・許可外の URL）が、
#     **それぞれ単独で** 1 になり、その種類だけが報告されること
#   - 境界: 許可した URL の前方一致が名前の途中で通らない / notes の中の数字を出どころにしない /
#     トークンの該当と許可外の URL のパス・クエリを全文で出さない
#   - 検査が成立しないとき（材料が無い・下書きが空）は 2（0 にも 1 にもしない）
#
# 2 節  scripts/ops-report-draft.sh（OPS_REPORT_CLAUDE で偽の claude に差し替える）
#   - Docs に置けた → 0・URL を結果の行と docs-url.txt に出す・道具の許し方が決めたとおり
#   - もう一度回すと作り直さない（1 か月 1 本）。--force で作り直して失敗したら前の URL を残さない
#   - Docs の応答に URL が無い / claude が失敗した → 3・控えのパスを出す・docs-url.txt を作らない
#   - 検査で落ちた → 1・**Docs を呼ばない**
#   - 控えの場所が git の作業ツリーの中 → 2
#
# **本物の claude -p を呼ばない。** 文章の生成はループの検証の外に置く（#936 の constraints）。
# 2 節は OPS_REPORT_CLAUDE を必ず偽のコマンドへ向けてから draft を呼ぶ。
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)" || exit 1
CHECK="$HERE/check-ops-report.sh"
DRAFT_SH="$HERE/ops-report-draft.sh"

TMP="$(mktemp -d "${TMPDIR:-/tmp}/ops-report-selftest.XXXXXX")" || exit 1
cleanup() { rm -rf -- "$TMP"; }
trap cleanup EXIT

FAILS=0
ok()  { printf '[ops-report-selftest] ok   %s\n' "$1"; }
ng()  { printf '[ops-report-selftest] NG   %s\n' "$1" >&2; FAILS=$((FAILS + 1)); }

# ── 材料（小さな仕込み） ──────────────────────────────────────────────────────
MATERIAL="$TMP/material.json"
cat > "$MATERIAL" <<'EOF'
{
  "kind": "ops-report-material",
  "version": 1,
  "month": "2026-09",
  "figures": {
    "month": { "generations": 1234, "llmSucceededPercent": 66.7, "llmCostJpy": 27650,
               "llmCostPerGenerationJpy": 22.4, "closedIssues": 243, "mergedPulls": 373 },
    "cumulative": { "totalGames": 512, "forkRatePercent": 45.2 }
  },
  "github": {
    "mergedPulls": [ { "number": 934, "title": "fix: ソースの上限を 64KB にし、v1.35 の書き方へ寄せる", "kind": "fixed" } ]
  },
  "notes": [ "buildTime は CloudWatch の保持（14 日）の内側だけ。" ]
}
EOF

# ══════════════════════════════════════════════════════════════════════════════
# 1 節  検査
# ══════════════════════════════════════════════════════════════════════════════

CLEAN="$TMP/clean.md"
cat > "$CLEAN" <<'EOF'
# Game Forge 運営報告（2026 年 9 月）

## 1. 今月の数字

- 2026-09 の生成は 1,234 回でした（2026/9/30 まで。9 月 30 日の分を含みます）。
- AI が使えるソースを返した割合は 66.7% です。
- これまでの作品は ５１２ 本、フォーク率は 45.2% です。
- 閉じた課題は 243 件、入れた変更は 373 件です。

## 入れたもの

1. ソースの上限を 64KB にしました。
2) v1.35 の書き方へ寄せました。

## お金

- 生成にかかった AI の費用: 27,650 円（1 回あたり 22.4 円）
- そのほかの費用（サーバーなど）: 【人が埋める：そのほかの費用の実額】
- いただいた投げ銭: 【人が埋める：今月の投げ銭の額 例 3000 円】

## 来月やること

10 月も続けます。お知らせは @gameforgejp と @GameForgeJP、
https://note.com/gameforgejp 、 https://app.game-forge.ojos.jp/works?sort=new 、
https://github.com/ojos/game-forge/issues で。
EOF

# 終了コードと、報告された種類の集合を返す（標準出力に「rc 種類,種類」）。
run_check() {
  local out rc kinds
  out="$(bash "$CHECK" "$1" "$2" 2>&1)"
  rc=$?
  kinds="$(printf '%s\n' "$out" | sed -n 's/^\[ops-report-check\] NG \([a-z]*\) .*/\1/p' | sort -u | tr '\n' ',' | sed 's/,$//')"
  printf '%s %s\n' "$rc" "$kinds"
  printf '%s\n' "$out" > "$TMP/last-check.txt"
}

got="$(run_check "$CLEAN" "$MATERIAL")"
if [[ "$got" == "0 " ]]; then
  ok "きれいな下書き（日付・見出しの番号・人が埋める欄・桁区切り・全角・題名の数字・許可した URL）が 0"
else
  ng "きれいな下書きが 0 になりません（${got}）"
  sed 's/^/    /' "$TMP/last-check.txt" >&2
fi

# 違反 1 つだけを足した下書きを作り、その種類だけで 1 になることを見る。
#
# @param $1 名前 / $2 足す行 / $3 期待する種類
BAD_SEQ=0
expect_violation() {
  local name="$1" line="$2" kind="$3" file got
  BAD_SEQ=$((BAD_SEQ + 1))
  file="$TMP/bad-${BAD_SEQ}-${kind}.md"
  { cat "$CLEAN"; printf '%s\n' "$line"; } > "$file"
  got="$(run_check "$file" "$MATERIAL")"
  if [[ "$got" == "1 ${kind}" ]]; then
    ok "${name} が 1（${kind} だけ）"
  else
    ng "${name} が期待と違います（期待「1 ${kind}」/ 実際「${got}」）"
    sed 's/^/    /' "$TMP/last-check.txt" >&2
  fi
}

expect_violation "材料の JSON に無い数字"   "- 今月の利用者は 87 人でした。"                         number
expect_violation "他人の @ハンドル"         "- いつも @someone_else さんに助けられています。"         handle
expect_violation "ARN"                      "- 権限は arn:aws:iam::123456789012:role/game-forge-build です。" secret
expect_violation "許可外の URL"             "- 詳しくは https://admin.game-forge.ojos.jp/reports へ。" url

# 境界 1: 許可した URL の前方一致が、名前の途中で通らない。
expect_violation "許可した URL に似た別の名前" "- https://note.com/gameforgejpx も見てください。" url
# 境界 2: notes の中の数字（14）を、本文の数字の出どころにしない。
expect_violation "notes にだけある数字"      "- 保持は 14 日です。"                                  number
# 境界 3: 月の付かない「N 日」は日付として外さない。
expect_violation "月の付かない日数"          "- 3 日で直しました。"                                  number
# 境界 4: 丸めをこしらえた値（材料は 45.2）は通さない。
expect_violation "生成が丸めた値"            "- フォーク率はおよそ 45% です。"                        number

# トークンの該当を全文で出さない（ログと通知へ流れるため）。綴りは実行時に組み立てる
# （このファイル自体に、トークンの形の文字列を置かない）。
fake_token="gh""p_$(printf 'a1B2c3D4e5%.0s' 1 2 3 4)"
expect_violation "GitHub のトークンの形"    "- ${fake_token}" secret
if grep -qF "$fake_token" "$TMP/last-check.txt"; then
  ng "トークンの形の該当が、出力に全文で出ています"
else
  ok "トークンの形の該当は伏せて出す"
fi

# 許可外の URL の報告も、パスとクエリを出さない（クエリにトークンが入っていても漏らさない）。
expect_violation "許可外の URL（クエリ付き）" "- https://example.com/cb?state=SeCrEtPaRt" url
if grep -qF "SeCrEtPaRt" "$TMP/last-check.txt"; then
  ng "許可外の URL の報告に、パスかクエリが全文で出ています"
else
  ok "許可外の URL はスキームとホストだけを出す"
fi

# 検査が成立しないとき。
got="$(run_check "$CLEAN" "$TMP/no-such.json")"
[[ "${got%% *}" == "2" ]] && ok "材料が無ければ 2" || ng "材料が無いときに 2 になりません（${got}）"
: > "$TMP/empty.md"
got="$(run_check "$TMP/empty.md" "$MATERIAL")"
[[ "${got%% *}" == "2" ]] && ok "下書きが空なら 2" || ng "下書きが空のときに 2 になりません（${got}）"
got="$(bash "$CHECK" 2>/dev/null; echo "rc=$?")"
[[ "$got" == *"rc=2" ]] && ok "引数が無ければ 2" || ng "引数が無いときに 2 になりません"

# ══════════════════════════════════════════════════════════════════════════════
# 2 節  下書き → 検査 → Docs（偽の claude）
# ══════════════════════════════════════════════════════════════════════════════

FAKE="$TMP/fake-claude"
FAKE_LOG="$TMP/fake-claude.log"
cat > "$FAKE" <<'EOF'
#!/usr/bin/env bash
# 偽の claude。--allowedTools があれば「置く」、無ければ「書く」として振る舞う。
mode=generate tools="(なし)" allowed="(なし)"
prev=""
for a in "$@"; do
  case "$prev" in
    --tools) tools="[$a]" ;;
    --allowedTools) mode=docs; allowed="$a" ;;
  esac
  prev="$a"
done
if [ "$mode" = generate ]; then
  cat >/dev/null
  printf 'generate tools=%s\n' "$tools" >> "$FAKE_LOG"
  # 前置きとコードブロックの囲みを付けて返す（draft がそれを落とすことも見る）。
  jq -n --rawfile r "$FAKE_DRAFT" '{type: "result", is_error: false, result: ("以下が下書きです。\n\n```markdown\n" + $r + "```\n")}'
  exit 0
fi
printf 'docs allowed=%s\n' "$allowed" >> "$FAKE_LOG"
case "$FAKE_DOCS" in
  ok)    jq -n '{type: "result", is_error: false, result: "doc を作りました。\nhttps://claude.ai/artifact/0f1e2d3c-aaaa-bbbb-cccc-000011112222"}' ;;
  nourl) jq -n '{type: "result", is_error: false, result: "doc を作れませんでした。"}' ;;
  error) jq -n '{type: "result", is_error: true, result: "MCP の呼び出しに失敗しました"}'; exit 1 ;;
esac
EOF
chmod +x "$FAKE"

# 下書きを 1 回回す。結果の行を $TMP/run.out に、終了コードを返す。
#
# @param $1 控えの場所 / $2 偽の生成が返す下書き / $3 偽の Docs の振る舞い / 残り: draft への引数
run_draft() {
  local dir="$1" draft="$2" docs="$3"
  shift 3
  OPS_REPORT_CLAUDE="$FAKE" OPS_REPORT_DIR="$dir" FAKE_LOG="$FAKE_LOG" \
    FAKE_DRAFT="$draft" FAKE_DOCS="$docs" \
    bash "$DRAFT_SH" 2026-09 --material "$MATERIAL" "$@" > "$TMP/run.out" 2> "$TMP/run.err"
}
result_of() { sed -n "s/^OPS_REPORT_$1=//p" "$TMP/run.out" | head -n 1; }

# 2-1 Docs に置けた。
: > "$FAKE_LOG"
D1="$TMP/out-ok"
run_draft "$D1" "$CLEAN" ok; rc=$?
if [[ $rc -eq 0 && "$(result_of STATUS)" == "ok" \
      && "$(result_of URL)" == "https://claude.ai/artifact/0f1e2d3c-aaaa-bbbb-cccc-000011112222" \
      && -s "$D1/2026-09/docs-url.txt" && "$(result_of COPY)" == "$D1/2026-09/draft.md" ]]; then
  ok "Docs に置けたら 0・URL と控えのパスを結果の行に出す"
else
  ng "Docs に置けたときの結果が期待と違います（rc=${rc}）"; sed 's/^/    /' "$TMP/run.out" "$TMP/run.err" >&2
fi
if [[ "$(head -n 1 "$D1/2026-09/draft.md" 2>/dev/null)" == "# Game Forge 運営報告（2026 年 9 月）" ]] \
   && ! grep -q '^```' "$D1/2026-09/draft.md"; then
  ok "生成の前置きとコードブロックの囲みを落として控えにする"
else
  ng "控えの先頭か末尾に、前置きか囲みが残っています"
fi
if grep -qx 'generate tools=\[\]' "$FAKE_LOG" \
   && grep -qx 'docs allowed=mcp__claude_ai_Claude_Docs__batch,mcp__claude_ai_Claude_Docs__guide' "$FAKE_LOG"; then
  ok "書く段は道具を許さず、置く段は Docs の 2 つだけを許す"
else
  ng "claude への道具の許し方が決めたとおりではありません"; sed 's/^/    /' "$FAKE_LOG" >&2
fi
if [[ -f "$D1/2026-09/result.txt" ]] && grep -q '^OPS_REPORT_STATUS=ok$' "$D1/2026-09/result.txt"; then
  ok "結果の行を result.txt にも書く"
else
  ng "result.txt に結果の行がありません"
fi

# 2-2 もう一度回すと作り直さない。
: > "$FAKE_LOG"
run_draft "$D1" "$CLEAN" ok; rc=$?
if [[ $rc -eq 0 && ! -s "$FAKE_LOG" && -n "$(result_of URL)" ]]; then
  ok "その月の doc があれば、claude を呼ばずに既存の URL を返す"
else
  ng "2 回目の実行で作り直しています（rc=${rc}）"
fi

# 2-2b --force で作り直して Docs に失敗したら、前の doc の URL を残さない（次の実行が古い doc を
#      成功として返さない）。続く通常の実行は作り直して置く。
run_draft "$D1" "$CLEAN" nourl --force; rc=$?
if [[ $rc -eq 3 && ! -e "$D1/2026-09/docs-url.txt" ]]; then
  ok "--force で Docs に失敗したら、前の doc の URL を消す"
else
  ng "--force で Docs に失敗しても、前の doc の URL が残っています（rc=${rc}）"
fi
: > "$FAKE_LOG"
run_draft "$D1" "$CLEAN" ok; rc=$?
if [[ $rc -eq 0 ]] && grep -q '^docs ' "$FAKE_LOG"; then
  ok "その後の通常の実行は作り直して Docs に置く"
else
  ng "前の doc の URL を消した後の実行が Docs に置いていません（rc=${rc}）"
fi

# 2-3 Docs の応答に URL が無い。
D3="$TMP/out-nourl"
run_draft "$D3" "$CLEAN" nourl; rc=$?
if [[ $rc -eq 3 && "$(result_of STATUS)" == "docs-failed" && -z "$(result_of URL)" \
      && -s "$(result_of COPY)" && ! -e "$D3/2026-09/docs-url.txt" ]]; then
  ok "Docs の応答に URL が無ければ 3・控えのパスを出す"
else
  ng "URL が無いときの結果が期待と違います（rc=${rc}）"; sed 's/^/    /' "$TMP/run.out" >&2
fi

# 2-4 claude が失敗した。
D4="$TMP/out-error"
run_draft "$D4" "$CLEAN" error; rc=$?
if [[ $rc -eq 3 && "$(result_of STATUS)" == "docs-failed" && -s "$(result_of COPY)" ]]; then
  ok "Docs への書き込みで claude が失敗したら 3・控えのパスを出す"
else
  ng "claude が失敗したときの結果が期待と違います（rc=${rc}）"; sed 's/^/    /' "$TMP/run.out" >&2
fi

# 2-5 検査で落ちたら Docs を呼ばない。
: > "$FAKE_LOG"
D5="$TMP/out-checkfail"
run_draft "$D5" "$TMP/bad-1-number.md" ok; rc=$?
if [[ $rc -eq 1 && "$(result_of STATUS)" == "check-failed" && -s "$(result_of COPY)" ]] \
   && ! grep -q '^docs ' "$FAKE_LOG"; then
  ok "検査で落ちたら 1・Docs を呼ばない・控えは残す"
else
  ng "検査で落ちたときの結果が期待と違います（rc=${rc}）"; sed 's/^/    /' "$TMP/run.out" "$FAKE_LOG" >&2
fi
if [[ "$(result_of REASON)" == *"number=1"* && "$(result_of REASON)" != *"87"* ]]; then
  ok "通知の理由は種類ごとの件数だけ（該当の文字列を載せない）"
else
  ng "検査で落ちたときの理由が期待と違います（$(result_of REASON)）"
fi

# 2-6 控えの場所が git の作業ツリーの中。
mkdir -p "$TMP/repo" && git -C "$TMP/repo" init -q >/dev/null 2>&1
run_draft "$TMP/repo/drafts" "$CLEAN" ok; rc=$?
if [[ $rc -eq 2 && "$(result_of STATUS)" == "usage" ]]; then
  ok "控えの場所が git の作業ツリーの中なら 2"
else
  ng "控えの場所が作業ツリーの中でも止まりません（rc=${rc}）"
fi

# 2-7 値を取る引数の値が無ければ、読み続けずに 2 で止まる。
OPS_REPORT_CLAUDE="$FAKE" OPS_REPORT_DIR="$TMP/out-noval" \
  bash "$DRAFT_SH" 2026-09 --material > "$TMP/run.out" 2>&1 & pid=$!
waited=0
while kill -0 "$pid" 2>/dev/null && [[ $waited -lt 50 ]]; do sleep 0.1; waited=$((waited + 1)); done
if kill -0 "$pid" 2>/dev/null; then
  kill "$pid" 2>/dev/null
  ng "--material に値が無いと終わりません"
else
  wait "$pid"; rc=$?
  [[ $rc -eq 2 ]] && ok "--material に値が無ければ 2" || ng "--material に値が無いときに 2 になりません（rc=${rc}）"
fi

if [[ $FAILS -ne 0 ]]; then
  echo "[ops-report-selftest] ${FAILS} 件が期待と違います" >&2
  echo "OPS_REPORT_SELFTEST_FAIL"
  exit 1
fi
echo "OPS_REPORT_SELFTEST_PASS"
exit 0
