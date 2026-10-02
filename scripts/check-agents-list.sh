#!/usr/bin/env bash
# check-agents-list.sh — 委譲先の定義と、project-ai-rules.md「委譲先の一覧」の写しを照合する（#900）
#
# 委譲先は .claude/agents/*.md の frontmatter（name / model / tools）が正本で、
# .github/project-ai-rules.md「### 委譲先の一覧」の表はその写し（#889）。共通規範 12 章は
# 「一覧の複製は機械照合で担保する」を求めるので、食い違いをここで終了コードにする。
#
# 赤にするもの:
#   - 定義があるのに表に行が無い
#   - 表に行があるのに定義が無い（「定義の場所」のファイルが無い）
#   - 値が違う（役割と name、定義の場所とファイルのパス、model、tools）
#   - 表の同じ役割が 2 行ある / frontmatter に name・model・tools のどれかが無い
#
# 表の書式は今の Markdown の表をそのまま読む（検査に合わせて表を変えない）。
# 列は「役割 | 定義の場所 | model | tools | …」の順で、定義の場所と model はバッククォートで
# 囲まれている。比較の前にバッククォートと前後の空白を外し、tools は「, 」区切りの並びとして
# 空白を詰めてから比べる（並び順も写しの一部として比べる）。
#
# 使い方:
#   bash scripts/check-agents-list.sh [<リポジトリの根>]
#   （引数はスクラッチに写した木で変異を試すためのもの。省略時はこのスクリプトの親の親）
#
# 終了コード: 0 = AGENTS_LIST_PASS / 1 = 食い違い
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="${1:-$(dirname "$HERE")}"
RULES="$ROOT/.github/project-ai-rules.md"
AGENTS_DIR="$ROOT/.claude/agents"

fail=0
err() { echo "[agents-list] FAIL: $*" >&2; fail=1; }

[[ -f "$RULES" ]] || { err "$RULES がありません"; exit 1; }
[[ -d "$AGENTS_DIR" ]] || { err "$AGENTS_DIR がありません"; exit 1; }

# 値の正規化: バッククォートを外し、前後の空白を落とし、「, 」の前後の空白を詰める。
norm() {
  printf '%s' "$1" | tr -d '`' | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//' -e 's/[[:space:]]*,[[:space:]]*/,/g'
}

# 表の行を「役割<TAB>定義の場所<TAB>model<TAB>tools」で取り出す。
# 見出し「### 委譲先の一覧」の後、最初の表（| で始まる連続した行）だけを読む。
# 1 行目（列名）と 2 行目（|---|）は飛ばす。
rows="$(awk '
  /^### 委譲先の一覧[[:space:]]*$/ { sec=1; next }
  sec && /^#/ { exit }
  sec && /^\|/ { intable=1; n++; if (n <= 2) next;
    line=$0; sub(/^\|/, "", line); sub(/\|[[:space:]]*$/, "", line)
    k=split(line, c, "|")
    if (k < 4) { print "BAD\t" $0; next }
    print c[1] "\t" c[2] "\t" c[3] "\t" c[4]; next }
  sec && intable { exit }
' "$RULES")"

if [[ -z "$rows" ]]; then
  err "project-ai-rules.md に「### 委譲先の一覧」の表を見つけられませんでした（試験が成立していない）"
  exit 1
fi

# 表の行を正規化して並べ直す。
table="$(
  while IFS=$'\t' read -r role loc model tools; do
    if [[ "$role" == "BAD" ]]; then
      echo "BAD"
      continue
    fi
    printf '%s\t%s\t%s\t%s\n' "$(norm "$role")" "$(norm "$loc")" "$(norm "$model")" "$(norm "$tools")"
  done <<<"$rows"
)"
if grep -qx 'BAD' <<<"$table"; then
  err "表に列が 4 つ未満の行があります"
fi

# 同じ役割が 2 行あれば赤。
dups="$(cut -f1 <<<"$table" | sort | uniq -d)"
[[ -z "$dups" ]] || err "表に同じ役割の行が複数あります: $(tr '\n' ' ' <<<"$dups")"

# frontmatter の値を取り出す（最初の --- と次の --- の間の「key: value」）。
fm() {
  awk -v key="$2" '
    NR == 1 && /^---[[:space:]]*$/ { f=1; next }
    NR == 1 { exit }
    f && /^---[[:space:]]*$/ { exit }
    f { i=index($0, ":"); if (i > 0 && substr($0, 1, i-1) == key) { print substr($0, i+1); exit } }
  ' "$1"
}

n_def=0
seen_roles=""
for def in "$AGENTS_DIR"/*.md; do
  [[ -e "$def" ]] || continue
  n_def=$((n_def + 1))
  rel=".claude/agents/$(basename "$def")"
  name="$(norm "$(fm "$def" name)")"
  model="$(norm "$(fm "$def" model)")"
  tools="$(norm "$(fm "$def" tools)")"
  missing=""
  [[ -n "$name" ]] || missing="$missing name"
  [[ -n "$model" ]] || missing="$missing model"
  [[ -n "$tools" ]] || missing="$missing tools"
  if [[ -n "$missing" ]]; then
    err "$rel の frontmatter に${missing} がありません"
    continue
  fi
  seen_roles="$seen_roles $name "
  row="$(awk -F'\t' -v r="$name" '$1 == r' <<<"$table" | head -n 1)"
  if [[ -z "$row" ]]; then
    err "$rel（name=$name）の行が project-ai-rules.md「委譲先の一覧」にありません"
    continue
  fi
  t_loc="$(cut -f2 <<<"$row")"
  t_model="$(cut -f3 <<<"$row")"
  t_tools="$(cut -f4 <<<"$row")"
  [[ "$t_loc" == "$rel" ]] || err "$name の定義の場所: 表=$t_loc 定義=$rel"
  [[ "$t_model" == "$model" ]] || err "$name の model: 表=$t_model 定義=$model"
  [[ "$t_tools" == "$tools" ]] || err "$name の tools: 表=$t_tools 定義=$tools"
done

# 表にあるのに定義が無い行。
while IFS=$'\t' read -r role loc _model _tools; do
  [[ "$role" == "BAD" || -z "$role" ]] && continue
  if [[ ! -f "$ROOT/$loc" ]]; then
    err "表の $role の定義の場所 $loc がありません"
  elif [[ "$seen_roles" != *" $role "* ]]; then
    err "表の $role に対応する name の定義がありません（$loc の name を確かめる）"
  fi
done <<<"$table"

if [[ "$fail" -ne 0 ]]; then
  echo "[agents-list] 正本は .claude/agents/*.md の frontmatter。定義を変える PR で、表も同じ PR で直す" >&2
  exit 1
fi
echo "[agents-list] AGENTS_LIST_PASS（定義 ${n_def} 本と表の行が一致）"
