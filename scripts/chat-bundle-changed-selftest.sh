#!/usr/bin/env bash
# chat-bundle-changed-selftest.sh — チャットの束の判定（scripts/chat-bundle-changed.sh）を確かめる（#903）
#
# ## なぜ要るのか
#
# **判定が壊れても、関門は緑のまま黙って外れる。** 「変わっていない」と言い続ける判定は、
# deploy ジョブを 1 度も止めない——2026-09-21 の #740（チャットの束を変えたのに配り直されなかった）
# を、機構を入れたあとに同じ形で作り直すことになる。だから判定そのものを、既知の差分で確かめる。
#
# ## 何を見るか
#
#   (a) チャットの入口（src/chat/handler.ts）から届くファイル（src/chat-prompt.ts）を変えると CHANGED
#   (b) 届かないファイル（オーケストレータの入口 src/orchestrator/handler.ts）を変えても UNCHANGED
#   (c) 比較元を明示すると、その範囲で判定する（届く変更をまたげば CHANGED）
#   (d) 比較元にだけあるファイルは、判定の後に残らない（作業ツリーを元へ戻す）
#   (e) 判定できないとき（作業ツリーが汚れている・比較元を解決できない・束を作れない）は
#       非 0 で終わり、**合図を出さない**（「変わっていない」に倒さない）
#   (f) どの場合も、判定の後の作業ツリーは HEAD のまま（利用者の変更を失わない）
#   (g) 依存（package-lock.json）だけが変わった差分は CHANGED（比較元もいまの node_modules で
#       束ねるので、束の作り比べでは依存の更新が見えない）
#   (h) 比較元を本番の Pages に居るコミットにする呼び方（deploy ジョブの呼び方）。そのコミットとの
#       間に届く変更があれば CHANGED、届かない変更だけなら UNCHANGED。**直前のコミットとしか比べない
#       と見落とす順序**（束を変えたコミットの配備が譲った・落ちたまま次がマージされた）を作って見る。
#       記録が欠けている・汚れている・取得できないときは CHANGED、応答を読めないときは非 0
#   (i) 比較元にだけある旧パスが改名で消えた場合も、判定の後に残らない（`git diff` の改名検出）
#
# ## どこで回すか
#
# **使い捨てのリポジトリで回す。** 判定は作業ツリーを比較元へ一時的に戻すので、この repo の
# 作業ツリーで回すと汚れていれば断られ、きれいでも途中で落ちたときに巻き込む。使い捨ての側へ
# `src/` と束ねるスクリプトを写し、`node_modules` は symlink で借りる——**同じツリーの中の 2 点比較
# なので、symlink でも判定は変わらない**（本番の `CodeSha256` との比較には使えない値になるが、
# ここでは比べない。`docs/handoff.md` 3 章の束のハッシュの項）。
#
# 使い方:
#   bash scripts/chat-bundle-changed-selftest.sh
#
# 終了コード: 0 = CHAT_BUNDLE_CHANGED_SELFTEST_PASS / 1 = 判定が壊れている
#
# **GNU 拡張を使わない**（利用者の端末は macOS / bash 3.2。`docs/handoff.md` 3 章）。
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(dirname "$HERE")"
JUDGE="$HERE/chat-bundle-changed.sh"
BUNDLER="$HERE/bundle-chat.sh"

for f in "$JUDGE" "$BUNDLER"; do
  if [[ ! -f "$f" ]]; then
    echo "[chat-bundle-selftest] error: $f が無いため検査が成立しません" >&2
    exit 1
  fi
done
command -v jq >/dev/null 2>&1 || {
  echo "[chat-bundle-selftest] error: jq がありません（Pages の応答を仕込むのに要ります）" >&2
  exit 1
}
if [[ ! -x "$ROOT/node_modules/.bin/esbuild" ]]; then
  echo "[chat-bundle-selftest] error: esbuild がありません（npm ci を実行してください）" >&2
  exit 1
fi

work="$(mktemp -d "${TMPDIR:-/tmp}/chat-bundle-selftest.XXXXXX")"
trap 'rm -rf "$work"' EXIT

# 利用者の git 設定（フック・署名・identity）を使い捨てのリポジトリへ持ち込まない。
export GIT_CONFIG_NOSYSTEM=1
export GIT_CONFIG_GLOBAL="$work/gitconfig"
cat > "$GIT_CONFIG_GLOBAL" <<'EOF'
[user]
	name = chat-bundle-selftest
	email = chat-bundle-selftest@example.invalid
[init]
	defaultBranch = main
[commit]
	gpgsign = false
EOF

failures=0
pass() { echo "[chat-bundle-selftest] ok: $1"; }
fail() { echo "[chat-bundle-selftest] NG: $1" >&2; failures=$((failures + 1)); }

repo="$work/repo"
mkdir -p "$repo/scripts"

# **束に効くものだけを写す。** src/ と、esbuild が読む tsconfig.json。束ねるスクリプトと判定は
# **作業ツリーの版**を写す（コミット前の変更を検査するため）。
git -C "$ROOT" archive HEAD src tsconfig.json package.json package-lock.json | tar -x -C "$repo"
cp "$JUDGE" "$repo/scripts/chat-bundle-changed.sh"
cp "$BUNDLER" "$repo/scripts/bundle-chat.sh"
ln -s "$ROOT/node_modules" "$repo/node_modules"

git -C "$repo" init -q
# `.gitignore` の `node_modules/` は symlink に当たらない（末尾の / はディレクトリだけ）。
printf 'node_modules\ndist\n' > "$repo/.git/info/exclude"
git -C "$repo" add -A
git -C "$repo" commit -q -m base

commit_all() {
  git -C "$repo" add -A
  git -C "$repo" commit -q -m "$1"
  git -C "$repo" rev-parse HEAD
}

# 判定を回し、終了コードと出力を受ける。**set -e に頼らず明示的に受ける。**
run_judge() {
  local rc=0
  out="$(cd "$repo" && bash scripts/chat-bundle-changed.sh "$@" 2>"$work/stderr")" || rc=$?
  judge_rc="$rc"
  signal="$(printf '%s\n' "$out" | grep -E '^CHAT_BUNDLE_' || true)"
}

expect_signal() {
  local label="$1" want="$2"
  if [[ "$judge_rc" == "0" && "$signal" == "$want" ]]; then
    pass "$label → $want"
  else
    fail "$label: 期待 rc=0 / $want、実際 rc=$judge_rc / '${signal}'"
    sed 's/^/    /' "$work/stderr" >&2 || true
  fi
}

expect_undecided() {
  local label="$1"
  if [[ "$judge_rc" != "0" && -z "$signal" ]]; then
    pass "$label → 非 0（rc=$judge_rc）で合図なし"
  else
    fail "$label: 判定できないのに rc=$judge_rc / '${signal}' を返した（判定できないことを合図へ倒している）"
  fi
}

# (f) 判定の後、作業ツリーが HEAD のまま（汚れていない）こと。
expect_clean() {
  local label="$1" status
  status="$(git -C "$repo" status --porcelain)"
  if [[ -z "$status" ]]; then
    pass "$label の後、作業ツリーは HEAD のまま"
  else
    fail "$label の後、作業ツリーが元に戻っていない: $status"
  fi
}

# 届くことを機械で確かめた目印。**未使用の export は esbuild が落とす**ので、副作用のある文にする。
MARK='globalThis.__chatBundleSelftest = 1;'

# ── (a) 届くファイル ────────────────────────────────────────────────
base_sha="$(git -C "$repo" rev-parse HEAD)"
printf '\n%s\n' "$MARK" >> "$repo/src/chat-prompt.ts"
reach_sha="$(commit_all reach)"
run_judge
expect_signal "(a) src/chat-prompt.ts（入口から届く）を変えた" CHAT_BUNDLE_CHANGED
expect_clean "(a)"

# ── (b) 届かないファイル ──────────────────────────────────────────────
printf '\n%s\n' "$MARK" >> "$repo/src/orchestrator/handler.ts"
commit_all unreach >/dev/null
run_judge
expect_signal "(b) src/orchestrator/handler.ts（入口から届かない）を変えた" CHAT_BUNDLE_UNCHANGED
expect_clean "(b)"

# ── (c) 比較元の明示 ─────────────────────────────────────────────────
run_judge "$base_sha"
expect_signal "(c) 比較元を明示し、届く変更をまたいだ" CHAT_BUNDLE_CHANGED
run_judge "$reach_sha"
expect_signal "(c) 比較元を明示し、届かない変更だけをまたいだ" CHAT_BUNDLE_UNCHANGED

# ── (d) 比較元にだけあるファイル ───────────────────────────────────────
printf 'export const selftestExtra = 1;\n' > "$repo/src/chat-selftest-extra.ts"
commit_all add-extra >/dev/null
git -C "$repo" rm -q src/chat-selftest-extra.ts
commit_all remove-extra >/dev/null
run_judge
expect_signal "(d) 届かないファイルを消した" CHAT_BUNDLE_UNCHANGED
if [[ -e "$repo/src/chat-selftest-extra.ts" ]]; then
  fail "(d) 比較元にだけあるファイルが判定の後に残った"
else
  pass "(d) 比較元にだけあるファイルは判定の後に残らない"
fi
expect_clean "(d)"

# ── (h) 比較元を本番の Pages に居るコミットにする ──────────────────────────
# Cloudflare の Pages プロジェクトの応答の形（`scripts/acceptance-remote.sh` の
# check_pages_production_deployment が読むのと同じ場所）を仕込む。
pages_json() { # pages_json <commit_hash> [commit_dirty]
  jq -n --arg h "$1" --argjson d "${2:-false}" \
    '{success: true, result: {canonical_deployment: {deployment_trigger: {metadata: {commit_hash: $h, commit_dirty: $d}}}}}' \
    > "$work/pages.json"
}

# いまの HEAD（届かない変更 2 つ）の 1 つ前は、届く変更の後である。**直前のコミットと比べると
# UNCHANGED になる**ことを対照として先に見る（ここが CHANGED なら、穴の再現になっていない）。
run_judge
expect_signal "(h) 対照: 直前のコミットとだけ比べると、届く変更を見落とす" CHAT_BUNDLE_UNCHANGED
# 本番の Pages が届く変更の前（base）に居る = 届く変更のコミットの配備は譲ったか落ちた。
pages_json "$base_sha"
run_judge --base-from-pages "$work/pages.json"
expect_signal "(h) Pages が届く変更の前に居れば、直前のコミットが同じでも" CHAT_BUNDLE_CHANGED
expect_clean "(h)"
pages_json "$reach_sha"
run_judge --base-from-pages "$work/pages.json"
expect_signal "(h) Pages が届く変更の後に居れば" CHAT_BUNDLE_UNCHANGED
pages_json "$reach_sha" true
run_judge --base-from-pages "$work/pages.json"
expect_signal "(h) Pages が汚れたツリーから配られていれば" CHAT_BUNDLE_CHANGED
pages_json ""
run_judge --base-from-pages "$work/pages.json"
expect_signal "(h) Pages の配備にコミットが記録されていなければ" CHAT_BUNDLE_CHANGED
jq -n '{success: true, result: {canonical_deployment: null}}' > "$work/pages.json"
run_judge --base-from-pages "$work/pages.json"
expect_signal "(h) 本番の Pages に配備が無ければ" CHAT_BUNDLE_CHANGED
# 使い捨てのリポジトリに origin は無いので、取得は必ず失敗する。
pages_json "0123456789abcdef0123456789abcdef01234567"
run_judge --base-from-pages "$work/pages.json"
expect_signal "(h) Pages に居るコミットを取得できなければ" CHAT_BUNDLE_CHANGED
expect_clean "(h) 取得できない"
jq -n '{success: false, errors: [{code: 10000}]}' > "$work/pages.json"
run_judge --base-from-pages "$work/pages.json"
expect_undecided "(h) Pages の応答が失敗を示す"
printf 'not json' > "$work/pages.json"
run_judge --base-from-pages "$work/pages.json"
expect_undecided "(h) Pages の応答が JSON でない"
run_judge --base-from-pages "$work/no-such.json"
expect_undecided "(h) Pages の応答のファイルが無い"
run_judge --base-from-pages
expect_undecided "(h) Pages の応答のファイルを渡していない"

# ── (i) 改名で消えた旧パス ──────────────────────────────────────────────
# 中身を十分に長くして、git が改名として検出する形にする（短いと別ファイルの追加と削除に見える）。
seq 1 200 | sed 's/^/export const selftestRenamed = /; s/$/;/' > "$repo/src/chat-selftest-old.ts"
commit_all add-old >/dev/null
git -C "$repo" mv src/chat-selftest-old.ts src/chat-selftest-new.ts
commit_all rename >/dev/null
if git -C "$repo" diff --name-status HEAD^ HEAD | grep '^R' >/dev/null; then
  pass "(i) 対照: git はこの差分を改名として検出する"
else
  fail "(i) 対照: 改名として検出されていない（この検査は何も確かめていない）"
fi
run_judge
expect_signal "(i) 届かないファイルを改名した" CHAT_BUNDLE_UNCHANGED
if [[ -e "$repo/src/chat-selftest-old.ts" ]]; then
  fail "(i) 改名の旧パスが判定の後に残った"
else
  pass "(i) 改名の旧パスは判定の後に残らない"
fi
expect_clean "(i)"

# ── (g) 依存だけが変わった ─────────────────────────────────────────────
# 中身は壊さず、末尾に改行を 1 つ足すだけにする（JSON として読めるまま。npm は読まない）。
printf '\n' >> "$repo/package-lock.json"
commit_all deps >/dev/null
run_judge
expect_signal "(g) package-lock.json だけを変えた" CHAT_BUNDLE_CHANGED
expect_clean "(g)"

# ── (e) 判定できない ────────────────────────────────────────────────
printf '\n// dirty\n' >> "$repo/src/chat-prompt.ts"
run_judge
expect_undecided "(e) 作業ツリーが汚れている"
if grep -q '^// dirty$' "$repo/src/chat-prompt.ts"; then
  pass "(e) 汚れた作業ツリーの変更を失わない"
else
  fail "(e) 汚れた作業ツリーの変更が消えた"
fi
git -C "$repo" checkout -q -- src/chat-prompt.ts

run_judge no-such-ref
expect_undecided "(e) 比較元を解決できない"

printf '\nexport const broken = ;\n' >> "$repo/src/chat-prompt.ts"
commit_all broken >/dev/null
run_judge
expect_undecided "(e) HEAD の束を作れない"
expect_clean "(e) HEAD の束を作れない"

# 比較元の側だけが壊れている（HEAD で直した）場合も、判定できないことに変わりはない。
git -C "$repo" checkout -q HEAD^ -- src/chat-prompt.ts
commit_all fixed >/dev/null
run_judge
expect_undecided "(e) 比較元の束を作れない"
expect_clean "(e) 比較元の束を作れない"

if [[ "$failures" -ne 0 ]]; then
  echo "[chat-bundle-selftest] ${failures} 件が期待と違います" >&2
  exit 1
fi
echo "CHAT_BUNDLE_CHANGED_SELFTEST_PASS"
