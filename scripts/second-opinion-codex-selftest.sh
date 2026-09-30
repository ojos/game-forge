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

# **file / line が欠けた回答も落とすこと**（Copilot の指摘。実在）。スキーマは必須に
# しているが、**強制できないエンジンでは欠けた回答が来る。** 通すと、場所の無い指摘を
# そのまま報告することになり、`print_findings` が壊れた表示を出す。
#
# **落ちた理由まで見る。** 終了コードだけを見ると、検証が外れていても
# `print_findings` が壊れて落ちるので通ってしまう（**偶然の落ち方で合格にしない**。
# 変異を当てて実際にそうなることを確かめた）。
rc=0
FAKE_CODEX_ANSWER='{"findings":[{"category":"bug","what":"x","why":"y"}]}' run_review || rc=$?
if [[ "$rc" -eq 0 ]]; then
  fail "file / line の無い回答で通過しました"
elif ! grep -q 'JSON として読めませんでした' "$work/err"; then
  fail "file / line の無い回答が、検証ではない別の理由で落ちています（検証が効いていません）"
fi

# line が数でない回答も落とすこと。
rc=0
FAKE_CODEX_ANSWER='{"findings":[{"category":"bug","file":"a.ts","line":"3 行目","what":"x","why":"y"}]}' \
  run_review || rc=$?
if [[ "$rc" -eq 0 ]]; then
  fail "line が数でない回答で通過しました"
elif ! grep -q 'JSON として読めませんでした' "$work/err"; then
  fail "line が数でない回答が、検証ではない別の理由で落ちています（検証が効いていません）"
fi

# ---- 2d. 旗で強制できないエンジンには、形をプロンプトへ載せること ----
# **gemini には `--json-schema` に当たる旗が無い**（実測）。載せないと、モデルは
# `what` / `why` などの必要な項目を知らないまま答え、**指摘の中身に関係なく後段の検証で
# 落ちる**（第二意見の指摘。実在）。ここは仕込みの `gemini` で見る。
cat > "$fake_bin/gemini" <<'FAKEG'
#!/usr/bin/env bash
set -euo pipefail
: > "$FAKE_CODEX_RECORD/gemini-argv"
for a in "$@"; do
  printf '%s\n' "$a" >> "$FAKE_CODEX_RECORD/gemini-argv"
done
printf '%s' "${FAKE_CODEX_ANSWER:-{\"findings\":[]\}}"
FAKEG
chmod +x "$fake_bin/gemini"

# **空の `.env` を指す。** プロジェクトの `.env` は `GEMINI_API_KEY=`（空）を持ち、
# `load-project-env.sh` は**ホストの環境変数より .env を優先する**ので、検査から鍵を
# 渡しても空で上書きされる（#805 でモデルの既定を検査したときと同じ形）。
# `PROJECT_ENV_FILE` で差し替えれば、この上書きを避けられる。
: > "$work/empty.env"

rm -f "$record/gemini-argv"
rc=0
(
  cd "$repo"
  PATH="$fake_bin:$PATH" \
  FAKE_CODEX_RECORD="$record" \
  PROJECT_ENV_FILE="$work/empty.env" \
  GEMINI_API_KEY=dummy-for-selftest \
    bash "$REVIEW" --engine gemini --range 'HEAD~1..HEAD' > "$work/out" 2> "$work/err"
) || rc=$?
if [[ "$rc" -ne 0 ]]; then
  fail "gemini の経路が通りませんでした（終了コード $rc）"
  tail -3 "$work/err" >&2
fi
if [[ ! -f "$record/gemini-argv" ]]; then
  fail "gemini が呼ばれていません"
elif ! grep -q '"what"' "$record/gemini-argv"; then
  fail "gemini のプロンプトに回答の形（スキーマ）が載っていません（強制できないエンジンには載せる必要があります）"
fi

# ---- 2e. 強制できないエンジンで、前置きやフェンスが付いても読めること ----
# **ナレーションが 1 行付くだけで落ちる**形だと、acceptance が消したかった「ナレーションに
# よる誤分類」がこの経路にだけ残る（第二意見の指摘。実在）。
for shape in narration fence; do
  case "$shape" in
    narration) answer='これから確認します。
{"findings":[]}' ;;
    fence) answer='```json
{"findings":[]}
```' ;;
  esac
  rm -f "$record/gemini-argv"
  rc=0
  (
    cd "$repo"
    PATH="$fake_bin:$PATH" \
    FAKE_CODEX_RECORD="$record" \
    PROJECT_ENV_FILE="$work/empty.env" \
    GEMINI_API_KEY=dummy-for-selftest \
    FAKE_CODEX_ANSWER="$answer" \
      bash "$REVIEW" --engine gemini --range 'HEAD~1..HEAD' > "$work/out" 2> "$work/err"
  ) || rc=$?
  if [[ "$rc" -ne 0 ]]; then
    fail "回答に $shape が付いた形で落ちました（指摘は 0 件なので通すべきです）"
    tail -2 "$work/err" >&2
  fi
done

# ---- 2f. issue の scope と acceptance をプロンプトへ載せること ----
# **枝の名前から番号を取って `gh` で引く経路は、ここでしか検査できない**（Copilot の指摘）。
# 使い捨てのリポジトリの枝には番号が無く、仕込みの `gh` も無かったので、**この PR の中心の
# 挙動が黙って壊れても気づけない状態**だった。
cat > "$fake_bin/gh" <<'FAKEGH'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> "$FAKE_CODEX_RECORD/gh-calls"
if [[ "${1-}" == "issue" && "${2-}" == "view" ]]; then
  printf '%s\n' "${FAKE_GH_ISSUE_BODY-}"
  exit 0
fi
# 本物の `gh api repos/{owner}/{repo}/issues/<n>` は issue も PR も返し、無ければ
# 404 で非 0 に終わる。用意した JSON があれば返し、無ければ本物と同じく失敗する。
if [[ "${1-}" == "api" && "${2-}" =~ ^repos/\{owner\}/\{repo\}/issues/([0-9]+)$ ]]; then
  f="${FAKE_GH_DIR-}/${BASH_REMATCH[1]}.json"
  if [[ -n "${FAKE_GH_DIR-}" && -f "$f" ]]; then
    cat "$f"
    exit 0
  fi
  echo "gh: Not Found (HTTP 404)" >&2
  exit 1
fi
exit 1
FAKEGH
chmod +x "$fake_bin/gh"

git -C "$repo" checkout -q -b feat/9999-selftest-context
rm -f "$record/stdin"
rc=0
(
  cd "$repo"
  PATH="$fake_bin:$PATH" \
  FAKE_CODEX_RECORD="$record" \
  FAKE_GH_ISSUE_BODY='# issue #9999 仕込みの票
scope.in:
  - 仕込みの目印 SELFTEST-ISSUE-MARKER' \
    bash "$REVIEW" --engine codex --range 'HEAD~1..HEAD' > "$work/out" 2> "$work/err"
) || rc=$?
if [[ "$rc" -ne 0 ]]; then
  fail "issue の文脈を載せる経路で落ちました（終了コード $rc）"
  tail -3 "$work/err" >&2
fi
if [[ ! -f "$record/stdin" ]]; then
  fail "issue の文脈の検査で codex が呼ばれていません"
elif ! grep -q 'SELFTEST-ISSUE-MARKER' "$record/stdin"; then
  fail "issue の本文がプロンプトに載っていません（枝の名前 → 番号 → gh の経路が壊れています）"
fi
if ! grep -q 'issue #9999' "$work/out"; then
  fail "issue を載せたことが出力に出ていません（載せた / 載せなかったを読めない）"
fi
git -C "$repo" checkout -q -

# ---- 2g. antigravity の経路（旗と包みの取り出し） ----
# **agy は枠が小さい**（Google AI Plus）。**仕込みで確かめる**——本物を確認のために
# 回さない。旗の綴り違いや `.structured_output` の取り違えは、本番のゲートでしか
# 落ちない形になる（Copilot の指摘）。
cat > "$fake_bin/agy" <<'FAKEA'
#!/usr/bin/env bash
set -euo pipefail
: > "$FAKE_CODEX_RECORD/agy-argv"
for a in "$@"; do
  printf '%s\n' "$a" >> "$FAKE_CODEX_RECORD/agy-argv"
done
# 本物は包みで返し、回答は .structured_output に入る（2026-09-29 に実測）。
printf '{"conversation_id":"x","status":"SUCCESS","response":"...","structured_output":%s}\n' \
  "${FAKE_CODEX_ANSWER:-{\"findings\":[]\}}"
FAKEA
chmod +x "$fake_bin/agy"

for shape in empty blocking; do
  case "$shape" in
    empty)    answer='{"findings":[]}'; expect=0 ;;
    blocking) answer='{"findings":[{"category":"bug","file":"a.ts","line":1,"what":"x","why":"y"}]}'; expect=1 ;;
  esac
  rm -f "$record/agy-argv"
  rc=0
  (
    cd "$repo"
    PATH="$fake_bin:$PATH" \
    FAKE_CODEX_RECORD="$record" \
    FAKE_CODEX_ANSWER="$answer" \
      bash "$REVIEW" --engine antigravity --range 'HEAD~1..HEAD' > "$work/out" 2> "$work/err"
  ) || rc=$?
  if [[ "$rc" -ne "$expect" ]]; then
    fail "antigravity の $shape な回答で終了コードが $rc になりました（$expect を期待）"
    tail -2 "$work/err" >&2
  fi
  if [[ ! -f "$record/agy-argv" ]]; then
    fail "antigravity が呼ばれていません"
  else
    for needed in --output-format json --json-schema; do
      if ! grep -qx -- "$needed" "$record/agy-argv"; then
        fail "antigravity の引数に $needed がありません（--json-schema は --output-format json を要求します）"
      fi
    done
  fi
done

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

# ---- 7. 参照された issue / PR の文脈（#828） ----
# 差分の追加行とコミットメッセージの `#N` だけを、持ち主が作ったものに限り、上限つきで載せる。
# 仕込みの JSON は本物の issues API の形（`repository_url` / `user.login` /
# `pull_request.merged_at` / `state_reason`）だけを持たせる。
gh_dir="$work/gh"
mkdir -p "$gh_dir"
owner_url='https://api.github.com/repos/owner1/repo1'
cat > "$gh_dir/11.json" <<EOF
{"repository_url":"$owner_url","user":{"login":"owner1"},"state":"open","state_reason":null,"title":"コミットで名指しした票",
 "body":"## intake\n\n\`\`\`yaml\ngoal: g\nacceptance:\n  - REF-ACCEPTANCE-MARKER\npriority: 中\n\`\`\`\nREF-OUTSIDE-ACCEPTANCE-MARKER"}
EOF
cat > "$gh_dir/12.json" <<EOF
{"repository_url":"$owner_url","user":{"login":"owner1"},"state":"closed","title":"追加行の PR",
 "pull_request":{"merged_at":"2026-09-29T00:00:00Z"},"body":"acceptance:\n  - PRBODY-MARKER"}
EOF
cat > "$gh_dir/13.json" <<EOF
{"repository_url":"$owner_url","user":{"login":"owner1"},"state":"open","title":"REF-REMOVED-MARKER","body":""}
EOF
cat > "$gh_dir/14.json" <<EOF
{"repository_url":"$owner_url","user":{"login":"stranger"},"state":"open","title":"REF-STRANGER-MARKER","body":"acceptance:\n  - REF-STRANGER-MARKER"}
EOF
cat > "$gh_dir/22.json" <<EOF
{"repository_url":"$owner_url","user":{"login":"owner1"},"state":"open","title":"REF-OVER-LIMIT-MARKER","body":""}
EOF
# #15〜#21 は JSON を置かない（引けない番号。止めずに続けることを見る）。

git -C "$repo" checkout -q -b refs-selftest
printf 'old ref #13\n' > "$repo/refs.txt"
git -C "$repo" add refs.txt
git -C "$repo" commit -q -m "base of refs"
# 追加行の順: #12 #14 #15 … #22。コミットメッセージの #11 が先頭に来るので、候補は 11 本で
# 上限 10 を 1 本超え、最後の #22 が落ちる。#13 は削除行にしか無い。
{
  printf 'new ref #12 and #14\n'
  for i in 15 16 17 18 19 20 21 22; do printf 'ref #%s\n' "$i"; done
  # 拾わない形: 色・実体参照・URL の断片・6 桁。
  printf 'color #000000 &#123; https://example.com/#99\n'
} > "$repo/refs.txt"
git -C "$repo" add refs.txt
git -C "$repo" commit -q -m "refs を差し替える（#11）"

rm -f "$record/stdin" "$record/gh-calls"
rc=0
(
  cd "$repo"
  PATH="$fake_bin:$PATH" \
  FAKE_CODEX_RECORD="$record" \
  FAKE_GH_DIR="$gh_dir" \
    bash "$REVIEW" --engine codex --range 'HEAD~1..HEAD' > "$work/out" 2> "$work/err"
) || rc=$?
if [[ "$rc" -ne 0 ]]; then
  fail "参照の文脈を載せる経路で落ちました（終了コード $rc。引けない番号があっても止めないはずです）"
  tail -3 "$work/err" >&2
fi
if [[ ! -f "$record/stdin" ]]; then
  fail "参照の文脈の検査で codex が呼ばれていません"
else
  grep -q 'REF-ACCEPTANCE-MARKER' "$record/stdin" \
    || fail "コミットメッセージの #11 の acceptance がプロンプトに載っていません"
  grep -q 'REF-OUTSIDE-ACCEPTANCE-MARKER' "$record/stdin" \
    && fail "issue の本文の acceptance の外まで載っています（載せるのは acceptance の節だけ）"
  grep -q '#12（PR・merged）' "$record/stdin" \
    || fail "追加行の PR #12 が状態（merged）つきで載っていません"
  grep -q 'PRBODY-MARKER' "$record/stdin" \
    && fail "PR の本文が載っています（PR は状態とタイトルだけ）"
  grep -q 'REF-REMOVED-MARKER' "$record/stdin" \
    && fail "削除行にしか無い #13 が載っています"
  grep -q 'REF-STRANGER-MARKER' "$record/stdin" \
    && fail "持ち主以外が作った #14 が載っています"
  grep -q 'REF-OVER-LIMIT-MARKER' "$record/stdin" \
    && fail "上限を超えた #22 が載っています"
fi
if [[ -f "$record/gh-calls" ]]; then
  grep -q 'issues/13$' "$record/gh-calls" && fail "削除行にしか無い #13 を引きに行っています"
  grep -q 'issues/22$' "$record/gh-calls" && fail "上限を超えた #22 を引きに行っています"
  grep -qE 'issues/(0|99|123|000000)$' "$record/gh-calls" \
    && fail "番号ではない # の形（色・実体参照・URL の断片）を引きに行っています"
fi
grep -q '上限 10 本を超えたため載せません: #22' "$work/out" \
  || fail "上限を超えて捨てたことが出力に出ていません"
grep -q '持ち主でないため載せません: #14' "$work/out" \
  || fail "作成者で弾いたことが出力に出ていません"
grep -q '引けなかったため載せません: #15' "$work/err" \
  || fail "引けなかったことが出力に出ていません"
git -C "$repo" checkout -q -

if [[ "$failed" -ne 0 ]]; then
  echo "[codex-selftest] codex エンジンの配線が壊れています" >&2
  exit 1
fi

echo "[codex-selftest] 13 組の配線を確かめました（差分を渡さない / issue の文脈 / 参照された issue・PR の文脈 / antigravity の旗と包み / 引数とスキーマとモデル / 強制できないエンジンへの形の受け渡しと前置き・フェンスの吸収 / 落とすのは 4 点だけ / 読めない JSON と知らない category / -o からの判定 / 未ログイン / 回答なし / --runs 2 の使い回し）"
echo "CODEX_ENGINE_SELFTEST_PASS"
