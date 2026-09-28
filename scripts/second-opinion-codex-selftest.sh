#!/usr/bin/env bash
# second-opinion-codex-selftest.sh — codex エンジンの配線を、本物の CLI 無しで確かめる（#805）
#
# ## なぜ要るのか
#
# **`--engine codex` の配線は、失敗しても緑に見える形で壊れる。** 壊れ方は 2 通りある。
#
#   1. **差分がモデルへ届かない。** codex は `exec -` で指示文を標準入力から読む。
#      並びを間違えて「プロンプトが先・差分が後」にすると、プロンプト冒頭の
#      「上記は git の差分です」が指す先が無くなり、**モデルは差分を見ないまま
#      「差分が空だ」と答える。** これは LGTM として通る（agy で実際に踏んだ形）。
#   2. **判定が回答以外の文字列で行われる。** codex の回答は `-o` のファイルから取る。
#      stdout を読む実装へ戻ると、見出しや進捗が判定へ混ざる。
#
# **どちらも本物の CLI を呼ばずに確かめられる。** 仕込みの `codex` を PATH の先へ置き、
# 受け取った標準入力と引数を記録させる。
#
# ## 仕込みは「本物がしないこと」をしない
#
# **これが #806 で踏んだ失敗の再発防止である**（`docs/handoff.md`「通るように作った
# 試験は何も確かめていない」）。仕込みの `codex` は、実測した本物の挙動だけを真似る。
#
# | 本物（codex-cli 0.157.1 で実測） | 仕込み |
# |---|---|
# | `login status` は資格情報の有無を終了コードで返す（未ログインで 1） | 同じ |
# | 見出し・設定・受け取ったプロンプトの復唱を **stderr** へ出す | 同じ |
# | 回答は `-o <file>` へ書く | 同じ |
# | 失敗した回は `-o` のファイルを作らない | 同じ（該当の場合） |
#
# **回答を stdout へも書かせない。** 書かせると、`-o` を読まない実装でも通ってしまい、
# この検査が塞ぎたい壊れ方（2）をそのまま隠す。
#
# 使い方:
#   bash scripts/second-opinion-codex-selftest.sh
#
# 終了コード: 0 = CODEX_ENGINE_SELFTEST_PASS / 1 = 配線が壊れている
#
# **GNU 拡張を使わない**（利用者の端末は macOS / bash 3.2。`docs/handoff.md` 3 章）。
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(dirname "$HERE")"
REVIEW="$ROOT/scripts/second-opinion-review.sh"

if [[ ! -f "$REVIEW" ]]; then
  echo "[codex-selftest] error: $REVIEW が無いため検査が成立しません" >&2
  exit 1
fi

work="$(mktemp -d "${TMPDIR:-/tmp}/codex-selftest.XXXXXX")"
# 一時領域は必ず片付ける。スコープを上げて持つのは、EXIT trap から `local` な変数が
# 空に見えるためである（#806 で実測した形）。
trap 'rm -rf "$work"' EXIT

fake_bin="$work/bin"
record="$work/record"
mkdir -p "$fake_bin" "$record"

# 仕込みの codex。上の表のとおりに振る舞う。
#
# 振る舞いは環境変数で切り替える。**引数では切り替えない**——本物の codex に無い
# 引数を受け取る仕込みにすると、被検査側が渡す引数の形を検査できなくなる。
cat > "$fake_bin/codex" <<'FAKE'
#!/usr/bin/env bash
set -euo pipefail

if [[ "${1-}" == "login" && "${2-}" == "status" ]]; then
  if [[ "${FAKE_CODEX_LOGGED_IN:-1}" == "1" ]]; then
    echo "Logged in"
    exit 0
  fi
  echo "Not logged in"
  exit 1
fi

# 引数をそのまま記録する（1 行 1 引数。空白を含む引数でも壊れない）。
: > "$FAKE_CODEX_RECORD/argv"
for a in "$@"; do
  printf '%s\n' "$a" >> "$FAKE_CODEX_RECORD/argv"
done

# 受け取った標準入力を記録する。
cat > "$FAKE_CODEX_RECORD/stdin"

# 本物は見出しと受け取ったプロンプトの復唱を stderr へ出す。
echo "OpenAI Codex (fake) / model: ${FAKE_CODEX_MODEL_ECHO:-unknown}" >&2

# -o の位置を引数から拾う。
answer=""
prev=""
for a in "$@"; do
  if [[ "$prev" == "-o" ]]; then
    answer="$a"
  fi
  prev="$a"
done

if [[ "${FAKE_CODEX_WRITE_ANSWER:-1}" != "1" ]]; then
  # 0 で終わりながら回答を書かない経路（被検査側が気づくべき形）。
  exit 0
fi

if [[ -z "$answer" ]]; then
  echo "fake codex: -o が渡されていません" >&2
  exit 1
fi

printf '%s\n' "${FAKE_CODEX_ANSWER:-VERDICT: LGTM}" > "$answer"

# **stdout へは回答を書かない。** 書くと、-o を読まない実装でもこの検査が通る。
printf '%s\n' "${FAKE_CODEX_STDOUT:-}"
FAKE
chmod +x "$fake_bin/codex"

# 検査用の git リポジトリ。被検査側は `git diff <range>` を cwd で解くので、
# このリポジトリの履歴に依存しない使い捨てを作る。
repo="$work/repo"
mkdir -p "$repo"
git -C "$repo" init -q
# identity はこのリポジトリの許可 identity に依存させない（使い捨ての中だけの値）。
git -C "$repo" config user.email "selftest@example.invalid"
git -C "$repo" config user.name "selftest"
printf 'hello\n' > "$repo/sample.txt"
git -C "$repo" add sample.txt
git -C "$repo" commit -q -m "base"
# 差分の中に、渡し方を間違えると壊れる文字を入れる（@ 参照・配列展開・メールアドレス）。
printf 'hello\nnoreply@example.com ${ARR[@]}\n' > "$repo/sample.txt"
git -C "$repo" add sample.txt
git -C "$repo" commit -q -m "change"

failed=0

fail() {
  echo "[codex-selftest] FAIL: $1" >&2
  failed=1
}

run_review() {
  # 被検査側を、仕込みを先に見る PATH で走らせる。標準出力と標準エラーを分けて取る。
  (
    cd "$repo"
    PATH="$fake_bin:$PATH" \
    FAKE_CODEX_RECORD="$record" \
      bash "$REVIEW" --engine codex --range 'HEAD~1..HEAD' \
        > "$work/out" 2> "$work/err"
  )
}

# ---- 1. 差分が加工されずに、プロンプトより前へ届くこと ----
rm -f "$record/stdin" "$record/argv"
rc=0
FAKE_CODEX_ANSWER='VERDICT: LGTM' run_review || rc=$?
if [[ "$rc" -ne 0 ]]; then
  fail "LGTM の回答で終了コードが $rc になりました（0 を期待）"
  cat "$work/err" >&2
fi

if [[ ! -f "$record/stdin" ]]; then
  fail "codex が標準入力を受け取っていません（差分の渡し方が壊れています）"
else
  # 差分が先にあること。
  if ! head -n 1 "$record/stdin" | grep -q '^diff --git'; then
    fail "標準入力の先頭が差分ではありません（プロンプトが先に来ています）"
  fi
  # 差分の本文が逐語で届いていること。
  if ! grep -q 'noreply@example.com \${ARR\[@\]}' "$record/stdin"; then
    fail "差分の本文が加工されています（@ やブレース展開が化けました）"
  fi
  # プロンプトが後にあること。判定トークンの指示は最後の方にある。
  if ! grep -q 'VERDICT: LGTM' "$record/stdin"; then
    fail "プロンプト（判定トークンの指示）が標準入力に含まれていません"
  fi
  # 並びの確認は「差分の行番号 < プロンプトの行番号」で見る。
  diff_line="$(grep -n '^diff --git' "$record/stdin" | head -n 1 | cut -d: -f1)"
  prompt_line="$(grep -n '上記は git の差分です' "$record/stdin" | head -n 1 | cut -d: -f1)"
  if [[ -z "$prompt_line" ]]; then
    fail "プロンプト本文が標準入力に含まれていません"
  elif [[ "$diff_line" -ge "$prompt_line" ]]; then
    fail "並びが逆です（差分 $diff_line 行目 / プロンプト $prompt_line 行目）"
  fi
fi

# ---- 2. 引数の形（読み取り専用・色なし・回答の口） ----
if [[ ! -f "$record/argv" ]]; then
  fail "引数が記録されていません"
else
  argv="$(cat "$record/argv")"
  for needed in exec - --sandbox read-only --color never -o; do
    if ! printf '%s\n' "$argv" | grep -qx -- "$needed"; then
      fail "引数に $needed がありません"
    fi
  done
  # モデルは必ず明示される（CLI の既定 gpt-6-astra に落とさない。#805）。
  if ! printf '%s\n' "$argv" | grep -qx -- "--model"; then
    fail "引数に --model がありません（CLI の既定モデルに落ちています）"
  fi
fi

# ---- 3. 判定は -o のファイルから取ること（stdout では判定しない） ----
# 回答は LGTM、stdout には FINDINGS を書かせる。stdout で判定していれば赤になる。
rc=0
FAKE_CODEX_ANSWER='VERDICT: LGTM' FAKE_CODEX_STDOUT='VERDICT: FINDINGS' run_review || rc=$?
if [[ "$rc" -ne 0 ]]; then
  fail "stdout の FINDINGS に引きずられました（判定が -o のファイルを見ていません）"
fi

# 逆向き。回答は FINDINGS、stdout には LGTM。stdout で判定していれば緑になる。
rc=0
FAKE_CODEX_ANSWER='VERDICT: FINDINGS' FAKE_CODEX_STDOUT='VERDICT: LGTM' run_review || rc=$?
if [[ "$rc" -eq 0 ]]; then
  fail "-o の FINDINGS を見落として通過しました（stdout で判定しています）"
fi

# ---- 4. 未ログインは exec の前に止まること ----
rc=0
FAKE_CODEX_LOGGED_IN=0 run_review || rc=$?
if [[ "$rc" -eq 0 ]]; then
  fail "未ログインでも通過しました（事前検査が効いていません）"
elif ! grep -q 'ログインしていません' "$work/err"; then
  fail "未ログインの理由が出力されていません"
fi

# ---- 5. 0 で終わりながら回答を書かない回は、失敗として扱うこと ----
rc=0
FAKE_CODEX_WRITE_ANSWER=0 run_review || rc=$?
if [[ "$rc" -eq 0 ]]; then
  fail "回答が無いまま通過しました（判定の入力が無いのに緑になっています）"
fi

if [[ "$failed" -ne 0 ]]; then
  echo "[codex-selftest] codex エンジンの配線が壊れています" >&2
  exit 1
fi

echo "[codex-selftest] 5 件の配線を確かめました（差分の並び / 引数 / -o からの判定 / 未ログイン / 回答なし）"
echo "CODEX_ENGINE_SELFTEST_PASS"
