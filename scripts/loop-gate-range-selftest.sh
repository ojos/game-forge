#!/usr/bin/env bash
# loop-gate-range-selftest.sh — 第二意見のレビュー範囲（resolve_review_range）を確かめる（#878）
#
# ## なぜ要るのか
#
# **上流が既定ブランチの追跡枝（`origin/main`）のブランチで、ゲートの最中に既定ブランチが
# 進むと、範囲 `origin/main..HEAD` に「他の PR を取り消す差分」が混ざる。** 第二意見は
# `git diff <範囲>` で差分を取り、これは両端のツリーの差である。既定ブランチへ新しく入った
# 変更は HEAD のツリーに無いので、逆向きの差分として入り、このブランチが触っていない
# ファイルへの指摘でゲートが落ちる（上流 ojos/ai-packages-dev の #382 / PR #383 で実測）。
#
# `range_includes_base_commits` は範囲の**コミット**を `git log` の意味で数えるので、
# この混入（端点の**ツリー**の差）を検出できない。ここではその状態を一時リポジトリに作り、
# 範囲の差分に既定ブランチ側だけの変更が入らないことを確かめる。
#
# 対照として、上流が自分のブランチの追跡枝である通常の場合と、上流が進んでいない場合は
# 今までどおり `<upstream>..HEAD` になることも確かめる（表記を変えると記録の scope が変わる）。
#
# ## 対照の検査を外さない
#
# 「上流の先端を起点にすると混ざる」ことを同じ状態で確かめる。ここが混ざらないなら、
# 再現の状態が作れておらず、修正後の検査は**たまたま**通っている。
#
# 使い方:
#   bash scripts/loop-gate-range-selftest.sh
#
# 終了コード: 0 = LOOP_GATE_RANGE_SELFTEST_PASS / 1 = 範囲の解決が壊れている
#
# **GNU 拡張を使わない**（利用者の端末は macOS / bash 3.2。`docs/handoff.md` 3 章）。
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
GATE="$HERE/loop-gate.sh"

if [[ ! -f "$GATE" ]]; then
  echo "[range-selftest] error: $GATE が無いため検査が成立しません" >&2
  exit 1
fi

work="$(mktemp -d "${TMPDIR:-/tmp}/loop-gate-range-selftest.XXXXXX")"
trap 'rm -rf "$work"' EXIT

# 利用者の git 設定（フック・署名・identity）を一時リポジトリへ持ち込まない。
# 共有の .git/config にも触れない（一時リポジトリは worktree の外に作る）。
export GIT_CONFIG_NOSYSTEM=1
export GIT_CONFIG_GLOBAL="$work/gitconfig"
cat > "$GIT_CONFIG_GLOBAL" <<'EOF'
[user]
	name = range-selftest
	email = range-selftest@example.invalid
[init]
	defaultBranch = main
[commit]
	gpgsign = false
EOF

failures=0
pass() { echo "[range-selftest] ok: $1"; }
fail() { echo "[range-selftest] NG: $1" >&2; failures=$((failures + 1)); }

# 一時リポジトリで resolve_review_range を呼び、結果を 3 行で返す。
# サブシェルで source するので、loop-gate.sh の `set -euo pipefail` や cd は外へ漏れない。
run_resolve() {
  (
    cd "$1"
    # shellcheck source=/dev/null
    source "$GATE"
    resolve_review_range
    printf 'RANGE=%s\n' "$REVIEW_RANGE"
    printf 'REASON=%s\n' "$REVIEW_RANGE_REASON"
    printf 'NO_TARGET=%s\n' "$REVIEW_NO_TARGET"
  )
}

field() { printf '%s\n' "$1" | sed -n "s/^$2=//p"; }

# bare の origin と、作業用の clone と、別の PR を入れる側の clone を作る。
origin="$work/origin.git"
repo="$work/repo"
other="$work/other"
git init -q --bare "$origin"
git clone -q "$origin" "$repo" 2>/dev/null
(
  cd "$repo"
  printf 'base\n' > base.txt
  git add base.txt
  git commit -q -m base
  git push -q origin main
  # clone 時点では origin が空だったので origin/HEAD が無い。本物の clone と同じにする。
  git remote set-head origin main >/dev/null
)
git clone -q "$origin" "$other"

# ── 0. source しただけではゲート本体が走らない ──────────────────────────────
sourced_out="$( (cd "$repo" && source "$GATE") 2>&1 || true)"
if printf '%s' "$sourced_out" | grep -q -e 'step 1' -e 'GATE_PASS' -e 'GATE_FAIL'; then
  fail "source しただけでゲート本体が走った: $sourced_out"
else
  pass "source しただけではゲート本体が走らない"
fi

# ── 1. 上流が既定ブランチで、まだ進んでいない ────────────────────────────────
(
  cd "$repo"
  git checkout -q -b feat --track origin/main
  printf 'own\n' > own.txt
  git add own.txt
  git commit -q -m own
)
out="$(run_resolve "$repo")"
if [[ "$(field "$out" RANGE)" == "origin/main..HEAD" && -z "$(field "$out" REASON)" ]]; then
  pass "上流（既定ブランチ）が進んでいなければ origin/main..HEAD のまま"
else
  fail "上流が進んでいないのに範囲が変わった: $out"
fi

# ── 2. ゲートの最中に、別の PR が既定ブランチへ入って fetch された ─────────────
(
  cd "$other"
  printf 'other\n' > main-new.txt
  git add main-new.txt
  git commit -q -m other
  git push -q origin main
)
(cd "$repo" && git fetch -q origin)

# 対照: 上流の先端を起点にすると、既定ブランチ側だけの変更を取り消す差分が混ざる。
control="$(cd "$repo" && git diff --name-only origin/main..HEAD | tr '\n' ',')"
if printf '%s' "$control" | grep -q 'main-new.txt'; then
  pass "対照: origin/main..HEAD には既定ブランチ側の main-new.txt を取り消す差分が混ざる"
else
  fail "対照が成立しない（再現の状態が作れていない）: $control"
fi

out="$(run_resolve "$repo")"
range="$(field "$out" RANGE)"
reason="$(field "$out" REASON)"
mb="$(cd "$repo" && git merge-base origin/main HEAD)"
echo "[range-selftest] 上流が進んだときの範囲: $range"
echo "[range-selftest] 理由: ${reason:-（なし）}"

if [[ -z "$range" ]]; then
  fail "範囲が空になった: $out"
else
  names="$(cd "$repo" && git diff --name-only "$range" | tr '\n' ',')"
  if printf '%s' "$names" | grep -q 'main-new.txt'; then
    fail "範囲 $range に、既定ブランチ側の変更を取り消す差分が混ざっている: $names"
  else
    pass "範囲に既定ブランチ側だけの変更（main-new.txt）が入らない"
  fi
  if printf '%s' "$names" | grep -q 'own.txt'; then
    pass "範囲にこのブランチ自身の変更（own.txt）が残る"
  else
    fail "このブランチ自身の変更が範囲から落ちている: $names"
  fi
fi

if [[ "$range" == "$mb..HEAD" ]]; then
  pass "範囲の起点が分岐点の SHA になる"
else
  fail "範囲の起点が分岐点（$mb）でない: $range"
fi

if printf '%s' "$reason" | grep -q 'has advanced beyond the merge-base'; then
  pass "起点を変えた理由を出力する"
else
  fail "起点を変えた理由が出ていない: ${reason:-（空）}"
fi

# ── 3. 上流が自分のブランチの追跡枝（通常の場合） ─────────────────────────────
(
  cd "$repo"
  git checkout -q -b own-branch origin/main
  printf 'mine\n' > mine.txt
  git add mine.txt
  git commit -q -m mine
  git push -q -u origin own-branch 2>/dev/null
  printf 'more\n' > more.txt
  git add more.txt
  git commit -q -m more
)
out="$(run_resolve "$repo")"
if [[ "$(field "$out" RANGE)" == "origin/own-branch..HEAD" && -z "$(field "$out" REASON)" ]]; then
  pass "上流が自分の追跡枝なら origin/own-branch..HEAD のまま"
else
  fail "上流が自分の追跡枝なのに範囲が変わった: $out"
fi

if [[ "$failures" -ne 0 ]]; then
  echo "[range-selftest] $failures 件の検査が落ちました" >&2
  echo "LOOP_GATE_RANGE_SELFTEST_FAIL"
  exit 1
fi
echo "LOOP_GATE_RANGE_SELFTEST_PASS"
