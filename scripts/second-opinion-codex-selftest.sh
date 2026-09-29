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

# 呼び出し回数を数える（--runs 2 以上の検査で使う）。
calls=1
if [[ -f "$FAKE_CODEX_RECORD/calls" ]]; then
  calls=$(( $(cat "$FAKE_CODEX_RECORD/calls") + 1 ))
fi
printf '%s\n' "$calls" > "$FAKE_CODEX_RECORD/calls"

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

if [[ "${FAKE_CODEX_WRITE_ANSWER:-1}" == "0" ]]; then
  # 0 で終わりながら回答を書かない経路（被検査側が気づくべき形）。
  exit 0
fi

if [[ "${FAKE_CODEX_WRITE_ANSWER:-1}" == "first" && "$calls" -gt 1 ]]; then
  # 1 回目だけ回答を書く。2 回目以降は 0 で終わりながら書かない
  # （--runs 2 で、前の回の回答が残っていると通ってしまう形）。
  exit 0
fi

if [[ -z "$answer" ]]; then
  echo "fake codex: -o が渡されていません" >&2
  exit 1
fi

printf '%s\n' "${FAKE_CODEX_ANSWER:-{\"findings\":[]\}}" > "$answer"

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
  # 追加の引数はそのまま被検査側へ渡す（--runs 2 の検査で使う）。
  rm -f "$record/calls"
  (
    cd "$repo"
    PATH="$fake_bin:$PATH" \
    FAKE_CODEX_RECORD="$record" \
      bash "$REVIEW" --engine codex --range 'HEAD~1..HEAD' "$@" \
        > "$work/out" 2> "$work/err"
  )
}

# ---- 1. 差分を渡さず、取り方を指示していること（#804 のツール解禁） ----
rm -f "$record/stdin" "$record/argv"
rc=0
run_review || rc=$?
if [[ "$rc" -ne 0 ]]; then
  fail "指摘なしの回答で終了コードが $rc になりました（0 を期待）"
  cat "$work/err" >&2
fi

if [[ ! -f "$record/stdin" ]]; then
  fail "codex が標準入力を受け取っていません（プロンプトの渡し方が壊れています）"
else
  # **差分そのものを渡していないこと。** 渡してしまうと、ツールを解禁した意味が薄れ、
  # 大きい差分で引数や入力の上限に当たる形へ逆戻りする。
  if grep -q '^diff --git' "$record/stdin"; then
    fail "プロンプトに差分が載っています（#804 ではモデル自身に取らせます）"
  fi
  # **取り方を指示していること。** 指示が無ければ、モデルは何をレビューするか分からない。
  if ! grep -q 'git diff HEAD~1..HEAD' "$record/stdin"; then
    fail "プロンプトに差分の取り方（git diff <範囲>）がありません"
  fi
  # **落とす category の規則が載っていること。**
  if ! grep -q 'edge-case' "$record/stdin"; then
    fail "プロンプトに報告の規則（category）がありません"
  fi
fi

# ---- 2. 引数の形（読み取り専用・スキーマ・回答の口・モデル） ----
if [[ ! -f "$record/argv" ]]; then
  fail "引数が記録されていません"
else
  argv="$(cat "$record/argv")"
  for needed in exec - --sandbox read-only --color never --ephemeral --output-schema -o; do
    if ! printf '%s\n' "$argv" | grep -qx -- "$needed"; then
      fail "引数に $needed がありません"
    fi
  done

  # **スキーマのファイルが実在すること。** 渡した先が無ければ、強制は効かない。
  schema_path="$(awk '$0 == "--output-schema" { getline; print; exit }' "$record/argv")"
  if [[ -z "$schema_path" || ! -f "$schema_path" ]]; then
    fail "--output-schema の指す先が実在しません: ${schema_path:-（無し）}"
  fi

  # モデルは必ず明示され、綴りまで一致する（#805）。
  if [[ -n "${SECOND_OPINION_MODEL:-}" ]]; then
    fail "SECOND_OPINION_MODEL が設定されているため、既定のモデルを検査できません"
  else
    effective_model="$(
      # shellcheck source=scripts/load-project-env.sh
      . "$ROOT/scripts/load-project-env.sh" >/dev/null 2>&1 || true
      printf '%s' "${SECOND_OPINION_MODEL:-}"
    )"
    if [[ -n "$effective_model" ]]; then
      fail "SECOND_OPINION_MODEL が設定されている（値: $effective_model）ため、既定のモデルを検査できません"
    else
      model_value="$(awk '$0 == "--model" { getline; print; exit }' "$record/argv")"
      if [[ "$model_value" != "gpt-6-sol" ]]; then
        fail "既定のモデルが gpt-6-sol ではありません（実際: ${model_value:-（無し）}）"
      fi
    fi
  fi
fi

# ---- 2b. 落とすのは 4 点だけ（#804） ----
# **報告は広げ、落とす判定は据え置く**という決まりが、実際にそう効くかを見る。
rc=0
FAKE_CODEX_ANSWER='{"findings":[{"category":"promise-mismatch","file":"a.ts","line":1,"what":"x","why":"y"},{"category":"other","file":"a.ts","line":2,"what":"x","why":"y"}]}' \
  run_review || rc=$?
if [[ "$rc" -ne 0 ]]; then
  fail "落とさない category（promise-mismatch / other）だけで落ちました（通すべきです）"
fi
if ! grep -q 'promise-mismatch' "$work/out"; then
  fail "落とさない指摘が出力に出ていません（通すだけで見せないのは、報告を広げた意味がありません）"
fi

for category in bug vulnerability type-error edge-case; do
  rc=0
  FAKE_CODEX_ANSWER="{\"findings\":[{\"category\":\"$category\",\"file\":\"a.ts\",\"line\":1,\"what\":\"x\",\"why\":\"y\"}]}" \
    run_review || rc=$?
  if [[ "$rc" -eq 0 ]]; then
    fail "category=$category で通過しました（この 4 つは落とすべきです）"
  fi
done

# ---- 2c. JSON として読めない回答は落とすこと ----
rc=0
FAKE_CODEX_ANSWER='これは JSON ではありません' run_review || rc=$?
if [[ "$rc" -eq 0 ]]; then
  fail "JSON として読めない回答で通過しました（読めなかったを指摘なしに倒しています）"
elif ! grep -q 'JSON として読めませんでした' "$work/err"; then
  fail "JSON を読めなかった理由が出力されていません"
fi

# 形は満たすが findings が配列でない回答も落とすこと。
rc=0
FAKE_CODEX_ANSWER='{"findings":"たくさん"}' run_review || rc=$?
if [[ "$rc" -eq 0 ]]; then
  fail "findings が配列でない回答で通過しました"
fi

# **知らない category は落とすこと**（第二意見の指摘。実在）。
# スキーマを強制できないエンジンでは綴り違いが来うる。配列であることしか見ていないと、
# `bugs` は「落とす 4 つ」に一致せず、**指摘があるのにゲートが緑になる。**
rc=0
FAKE_CODEX_ANSWER='{"findings":[{"category":"bugs","file":"a.ts","line":1,"what":"x","why":"y"}]}' \
  run_review || rc=$?
if [[ "$rc" -eq 0 ]]; then
  fail "知らない category（bugs）で通過しました（重さが分からないものを指摘なしに倒しています）"
fi

# what / why が欠けた回答も落とすこと（人が読めない報告は、報告になっていない）。
rc=0
FAKE_CODEX_ANSWER='{"findings":[{"category":"bug","file":"a.ts","line":1}]}' run_review || rc=$?
if [[ "$rc" -eq 0 ]]; then
  fail "what / why の無い回答で通過しました"
fi

# ---- 3. 判定は -o のファイルから取ること（stdout では判定しない） ----
# 回答は指摘なし、stdout には落とす指摘を書かせる。stdout で判定していれば赤になる。
rc=0
FAKE_CODEX_ANSWER='{"findings":[]}' \
FAKE_CODEX_STDOUT='{"findings":[{"category":"bug","file":"a.ts","line":1,"what":"x","why":"y"}]}' \
  run_review || rc=$?
if [[ "$rc" -ne 0 ]]; then
  fail "stdout の指摘に引きずられました（判定が -o のファイルを見ていません）"
fi

# 逆向き。回答は落とす指摘、stdout は指摘なし。stdout で判定していれば緑になる。
rc=0
FAKE_CODEX_ANSWER='{"findings":[{"category":"bug","file":"a.ts","line":1,"what":"x","why":"y"}]}' \
FAKE_CODEX_STDOUT='{"findings":[]}' \
  run_review || rc=$?
if [[ "$rc" -eq 0 ]]; then
  fail "-o の指摘を見落として通過しました（stdout で判定しています）"
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

# ---- 6. --runs 2 で、前の回の回答が使い回されないこと ----
# 1 回目は回答を書き、2 回目は 0 で終わりながら書かない。回答のファイルを呼び出しごとに
# 消していなければ、2 回目は 1 回目の LGTM を読んで**通ってしまう**（Copilot の指摘）。
rc=0
FAKE_CODEX_WRITE_ANSWER=first FAKE_CODEX_ANSWER='{"findings":[]}' run_review --runs 2 || rc=$?
if [[ "$rc" -eq 0 ]]; then
  fail "--runs 2 の 2 回目が回答を書かなかったのに通過しました（前の回の回答を読んでいます）"
fi

if [[ "$failed" -ne 0 ]]; then
  echo "[codex-selftest] codex エンジンの配線が壊れています" >&2
  exit 1
fi

echo "[codex-selftest] 9 件の配線を確かめました（差分を渡さない / 引数とスキーマとモデル / 落とすのは 4 点だけ / 読めない JSON と知らない category / -o からの判定 / 未ログイン / 回答なし / --runs 2 の使い回し）"
echo "CODEX_ENGINE_SELFTEST_PASS"
