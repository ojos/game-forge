#!/usr/bin/env bash
# check-doc-links.sh — 追跡している Markdown の相対リンクが、追跡対象として実在
# することを機械で検査する
#
# 位置づけ:
#   判定はこのスクリプトが持ち、scripts/acceptance.sh は呼ぶだけ。
#   scripts/check-control-chars.sh / scripts/check-table-breaks.sh と同じ形にそろえる。
#
# なぜ機構で押さえるか:
#   リンク切れは**読んでも気づけない**。文書は正しく見え、リンクを押した人だけが
#   404 に当たる。該当行を出して目視しても気づけないことが多く、判定は完全に
#   決定的なので、`.ai-playbook/shared-ai-rules.md` 12 章「呼びかけで担保しない」に
#   照らして機構へ移せる。
#
# 何を見るか:
#   追跡された `*.md` の中の **相対リンク** が、**追跡対象として実在する**こと。
#   対象の形は `](...)` で、画像（`![alt](path)`）も同じ綴りなので一緒に見る。
#
#   「追跡対象として実在する」の判定に、作業ツリーの有無（test -e）を使わない。
#   **配布されるのは追跡ファイルだけ**なので、ローカルにだけある生成物や無視
#   されたファイルへのリンクは、手元では開けても配布された文書では 404 になる。
#   判定は `git ls-files` から作った集合への所属で行う（ディレクトリは、追跡
#   ファイルの祖先として集合へ入れる。`[src/](src/)` のような形も実在しうる）。
#
#   パスは正規化してから突き合わせる（`.` と `..` を畳む）。畳んだ結果が
#   **リポジトリの外へ出るリンクは不合格**とする。手元の絶対パスの都合で通って
#   しまい、配布側では必ず壊れる。
#
# 何を見ないか（この検査が見ていると誤解しないために明記する）:
#   - **スキーム付きリンクの到達性と妥当性**。**種類を列挙せず、スキームの綴りで
#     一律に外す**（英字で始まり、英数と + . - が続き、コロンで終わる形。
#     CommonMark の定義）。http / https / mailto だけを挙げると、tel: / ftp: /
#     data: のようなスキームが相対パスとして扱われ、書いてもいないパスについて
#     「存在しない」と誤って報告する。到達性を見たいならネットワークが要るので、
#     外部層の検査として別に足す。
#   - **プロトコル相対**（`//host/path`）も外す。
#   - **アンカーの実在**（`#見出し` / `#L160`）。`#` 以降は落としてからパスを見る。
#     見出しの照合には Markdown の見出し→アンカー変換の再実装が要り、日本語
#     見出しでは規則が処理系に依存する。行番号アンカー（`#L160`）は対象ファイルの
#     行数に依存し、追随しない写しを増やす。
#   - **インラインコード（`` ` `` で囲まれた範囲）の除外**。**意図的に剥がさない。**
#     剥がす実装は「2 つのコードスパンの間にある実在のリンク」を取り落とす。
#     **偽の緑（実在するリンクを検査対象から外す）より、偽の赤（コード例の中の
#     リンク表記を拾う）のほうが害が小さい。**
#   - **参照形式リンク**（`[text][ref]` と `[ref]: path`）。
#   - **角括弧で囲む形**（`](<path with space>)`）と **URL エンコード**（`%20`）。
#
#   **ルート絶対のリンク（`](/docs/x.md)`）は、見ないのではなく不合格にする。**
#   解決規則が処理系で揺れる（レンダラと手元のエディタで一致しないことがある）ため、
#   使わないことにして綴りを直す側へ倒す。**素通しにはできない**——文書のディレクトリと
#   連結してから畳むと `docs//docs/x.md` → `docs/docs/x.md` のように、書いてもいない
#   パスについて「存在しない」と誤って報告する。
#
# コードフェンスの扱い:
#   フェンスの内側は見ない。コード例に書かれたリンク表記を拾うと、直しようのない
#   赤が出る。
#
#   **2 種類の印を両方見る**（``` と `~~~`）。片方だけだと、見ていない側の印の中の
#   リンクを実在のリンクとして拾ってしまう。
#
#   **切り替えは行の先頭の空白を許して見る**——字下げされたフェンスがありうる
#   （箇条の中のコード）ので、行頭固定だと切り替えを取りこぼす。
#
#   **開いたときの印と同じ種類でだけ閉じる。数の偶奇では見ない。** 一方の印の中に
#   もう一方の印を書く形（フェンスそのものの説明）があると、偶奇では状態が反転する。
#
#   **終端でまだ開いているファイルは不合格にする。** 開いたまま閉じていないと、
#   そこからファイル末尾までが「コードの中」として検査から外れる。**それは
#   偽の緑である。** Markdown としても壊れているので、直すべき側も明確である。
#
# 除外の渡し方:
#   利用側がリンクを検査したくない文書（取り込んだ外部文書など）を持つ場合、
#   環境変数 `DOC_LINKS_EXCLUDE` へリポジトリルートからの相対パスのプレフィックスを
#   コロン区切りで渡す（既定は空＝何も除外しない）。一致した追跡 md はスキャン
#   そのものを行わない（その md が持つリンクは検査対象にならない）。
#
#     DOC_LINKS_EXCLUDE="vendor/docs:third_party/readme.md" bash scripts/check-doc-links.sh
#
#   除外は「スキャンする側（リンク元の文書）」にだけ効く。**リンクの行き先が
#   除外パスの中にあっても、行き先としての実在判定（追跡ファイルの集合）には
#   影響しない。** 除外していない文書からそこへのリンクは、従来どおり実在を要求する。
#
#   個人所有・組織所有、macOS・Linux のいずれでも、環境変数という setting-free な
#   経路だけで上書きできるため、追加の設定ファイルや OS 判定を要らない。
#
# 検査が成立していないことを合格にしない:
#   git 管理外での実行、git コマンドの失敗、追跡ファイル 0 件、awk の失敗は
#   いずれも「リンクが壊れていない」ことを意味しない。すべて失敗として扱う。
#
#   一方、**追跡している Markdown が 1 件も無い場合（除外設定で全件を除いた
#   場合を含む）は、失敗させない。** 配布直後のプロジェクト（`--with-playbook`
#   を選ばない既定構成は Markdown を 1 本も生成しない）はこの状態に日常的に
#   なる。「検査対象が無い」ことと「リンクが壊れていない」ことは両立するので、
#   ここでダミーの文書を足す以外に直しようが無い検査にはしない。
#
#   判定の要であるフェンス追跡・抽出器が壊れるリグレッションは、プロジェクトの
#   実体に Markdown が実在するかどうかとは別に、**起動時の自己診断**（壊れた
#   リンクを必ず当てること、正しいリンクを誤検出しないこと、フェンスの内側を
#   拾わないこと、閉じていないフェンスを検出すること、スキーム付きリンクを
#   相対パスとして扱わないこと）が独立に検出する。書き損じで「何も当たらない
#   検査」になっていた場合、それは常に緑を返すため、赤にならない限り誰も
#   気づけない。
#
# 使い方:
#   bash scripts/check-doc-links.sh
#   DOC_LINKS_EXCLUDE="vendor/docs" bash scripts/check-doc-links.sh
#
# 終了コード:
#   0 = DOC_LINKS_PASS
#   1 = DOC_LINKS_FAIL（リンク切れ、または検査が成立しなかった）
#
# **GNU 拡張を使わない**（macOS / bash 3.2 でも動かす。scripts/check-shell-portability.sh
# の対象）。awk は POSIX の範囲に収める（gensub 等を使わない）。
set -euo pipefail

# 角括弧の範囲指定と sort/comm の照合順をバイト順に固定する
# （scripts/check-control-chars.sh が sort/comm で固定しているのと同じ理由）。
export LC_ALL=C

# 検査はプロジェクトルート基準で行う。scripts/ の 1 階層上がルート。
# 任意の作業ディレクトリから起動しても結果が不変になるよう、起動時 CWD に依存しない。
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$(dirname "$HERE")"

fail() {
  printf '[doc-links] %s\n' "$1" >&2
  echo "DOC_LINKS_FAIL"
  exit 1
}

WORK="$(mktemp -d "${TMPDIR:-/tmp}/doc-links.XXXXXX")" \
  || { echo "[doc-links] 一時ディレクトリを作成できません。" >&2; echo "DOC_LINKS_FAIL"; exit 1; }
trap 'rm -rf "$WORK"' EXIT

EXTRACT="$WORK/extract.awk"
ALLOWED="$WORK/allowed"
TRACKED="$WORK/tracked.z"
MD_LIST="$WORK/md.z"
TARGETS="$WORK/targets"
WANTED="$WORK/wanted"
MISSING="$WORK/missing"

# ── 抽出器 ───────────────────────────────────────────────────────────────────
#
# 1 ファイルを読み、検査対象の相対リンクを「種別<TAB>...」の形で出す。
# フェンスの内側は読み飛ばし、フェンス行の不均衡（閉じ忘れ）も報告する。
#
#   L<TAB>正規化パス<TAB>ファイル:行<TAB>元の綴り   … 検査すべきリンク
#   E<TAB>ファイル:行<TAB>元の綴り                  … リポジトリの外へ出るリンク
#   A<TAB>ファイル:行<TAB>元の綴り                  … ルート絶対のリンク
#   U<TAB>ファイル<TAB>フェンス行数                 … フェンスが不均衡
cat > "$EXTRACT" <<'AWK'
function normalize(p,   parts, n, out, m, i, s) {
  n = split(p, parts, "/")
  m = 0
  for (i = 1; i <= n; i++) {
    if (parts[i] == "" || parts[i] == ".") continue
    if (parts[i] == "..") {
      if (m > 0) { m-- } else { return "\001ESCAPE" }
      continue
    }
    m++
    out[m] = parts[i]
  }
  s = ""
  for (i = 1; i <= m; i++) s = (s == "") ? out[i] : s "/" out[i]
  return s
}
BEGIN { infence = 0; fmark = ""; flen = 0; fline = 0 }
# フェンスはマーカーの種類（``` / ~~~）まで見て、開いたときと同じ種類でだけ閉じる
# （数の偶奇では見ない。一方の中にもう一方を書く形があると偶奇では状態が反転する）。
# 閉じるのは CommonMark どおり、**開きと同じ文字で、開き以上の長さを持ち、後ろに
# 空白しか無い**行だけである（#439）。種類だけで見ると、4 連のフェンスの中に書いた
# ``` や ```sh の例でフェンスが早く閉じ、続くコードの中のリンクを検査してしまう。
/^[[:space:]]*(```|~~~)/ {
  fl = $0
  sub(/^[[:space:]]*/, "", fl)
  mk = substr(fl, 1, 1)
  match(fl, (mk == "`") ? "^`+" : "^~+")
  ml = RLENGTH
  if (!infence) { infence = 1; fmark = mk; flen = ml; fline = FNR; next }
  if (mk == fmark && ml >= flen && substr(fl, ml + 1) ~ /^[[:space:]]*$/) {
    infence = 0; fmark = ""; flen = 0; next
  }
  next
}
infence { next }
{
  line = $0
  while (match(line, /\]\(/)) {
    # `](` の後ろから括弧の深さを数え、対応する `)` までを 1 つのリンク先とする
    # （`[a](docs/foo(bar).md)` を `docs/foo(bar` で切らない）。対応する `)` が
    # 行内に無ければ、従来どおり最初の `)` で切る（括弧の数え方で、変更前より
    # 検査を漏らさないため）。タイトル（空白の後の "..." / '...'）と `<...>` の
    # 中の括弧、およびバックスラッシュでエスケープした文字は数えない
    # （`[a](x.md "T (")` や `[a](x.md "T \" (")` を検査から漏らさない）。
    # リンク先は空白を含まないので、空白の後に続いてよいのは空白・タイトル・
    # 閉じ括弧だけとする。それ以外が来たら正しいリンクではないとみなし、従来
    # どおりに切る（`[a](x(y) [b](gone.md) )` の後ろのリンクを漏らさない）。
    rest = substr(line, RSTART + 2)
    depth = 1
    endpos = 0
    quote = ""
    prev = ""
    spaced = 0
    rlen = length(rest)
    for (ci = 1; ci <= rlen; ci++) {
      ch = substr(rest, ci, 1)
      if (ch == "\\") { ci++; prev = ""; continue }
      if (quote != "") { if (ch == quote) quote = "" }
      else if (ch == " " || ch == "\t") { if (depth > 1) break; spaced = 1 }
      else if (depth == 1 && (ch == "\"" || ch == "'") && spaced) quote = ch
      else if (ch == "<" && depth == 1 && prev == "") quote = ">"
      else if (ch == ")") { depth--; if (depth == 0) { endpos = ci; break } }
      else if (spaced) break
      else if (ch == "(") depth++
      prev = ch
    }
    if (endpos == 0) {
      endpos = index(rest, ")")
      if (endpos == 0) { line = rest; continue }
    }
    raw = substr(rest, 1, endpos - 1)
    line = substr(rest, endpos + 1)
    t = raw
    # リンク先とタイトルを分ける（`[a](path "title")` / `[a](path 'title')`）。
    # CommonMark では、リンク先は空白を含まないか `<...>` で囲む。囲みがあれば
    # その中身を、無ければ最初の空白の手前までをリンク先とする。
    sub(/^[ \t]+/, "", t)
    if (substr(t, 1, 1) == "<") {
      if (match(t, />/)) { t = substr(t, 2, RSTART - 2) }
    } else if (match(t, /[ \t]/)) {
      t = substr(t, 1, RSTART - 1)
    }
    # スキーム付きは種類を列挙せずに弾く（CommonMark のスキームの綴り: 英字で
    # 始まり、英数と + . - が続き、コロンで終わる）。ファイルへの相対リンクでは
    # ないため、相対パスとして誤って扱わない。
    if (t ~ /^[A-Za-z][A-Za-z0-9+.-]*:/) continue
    if (t ~ /^\/\//) continue
    # ルート絶対（`/docs/x.md`）は、畳む前に弾く。DIR と連結してから畳むと
    # `docs//docs/x.md` → `docs/docs/x.md` になり、書いてもいないパスについて
    # 「存在しない」と報告してしまう。素通しにはできない。
    if (t ~ /^\//) {
      printf "A\t%s:%d\t%s\n", FILE, FNR, raw
      continue
    }
    if (t ~ /^#/) continue
    sub(/#.*$/, "", t)
    if (t == "") continue
    joined = (DIR == ".") ? t : DIR "/" t
    norm = normalize(joined)
    if (norm == "\001ESCAPE") {
      printf "E\t%s:%d\t%s\n", FILE, FNR, raw
      continue
    }
    # 畳んだ結果が空になるのは「リポジトリのルートそのもの」を指す場合だけ
    # （ルート直下の md に `](.)` と書いた形）。ルートは常に在るので、外へ
    # 出たのとは区別して素通しする。
    if (norm == "") continue
    printf "L\t%s\t%s:%d\t%s\n", norm, FILE, FNR, raw
  }
}
END {
  # 偶奇ではなく「終端でまだ開いているか」で見る。開いた行番号を出して、
  # 直す場所を名指しする。
  if (infence) printf "U\t%s\t%d\t%s\n", FILE, fline, fmark
}
AWK

# ── 自己診断 ─────────────────────────────────────────────────────────────────
#
# 3 方向を見る。当たること（偽陰性＝常に緑になる壊れ方）、当たらないこと
# （偽陽性）、フェンスの内側を拾わないこと（直しようのない赤）。
selftest="$WORK/selftest.md"
printf '%s\n' \
  '[ok](present.md)' \
  '```' \
  '[fenced-bt](nope-in-bt-fence.md)' \
  '```' \
  '~~~' \
  'これは ``` を含む説明' \
  '[fenced-tilde](nope-in-tilde-fence.md)' \
  '~~~' \
  '[scheme](tel:+810000000000)' \
  '[gone](absent.md)' \
  > "$selftest"
diag="$(awk -v DIR="." -v FILE="selftest.md" -f "$EXTRACT" "$selftest")" \
  || fail "自己診断で抽出器が異常終了しました。検査が成立していないため失敗させます。"

printf '%s\n' "$diag" | grep "^L	absent.md	" >/dev/null \
  || fail "自己診断に失敗しました: 壊れたリンクを抽出できません。検査が成立していないため失敗させます。"
printf '%s\n' "$diag" | grep "^L	present.md	" >/dev/null \
  || fail "自己診断に失敗しました: 正常なリンクを抽出できません。検査が成立していないため失敗させます。"
if printf '%s\n' "$diag" | grep "nope-in-bt-fence.md" >/dev/null; then
  fail "自己診断に失敗しました: 3 連バッククォートのフェンスの内側を拾っています。検査が成立していないため失敗させます。"
fi
if printf '%s\n' "$diag" | grep "nope-in-tilde-fence.md" >/dev/null; then
  fail "自己診断に失敗しました: ~~~ のフェンスの内側を拾っています。検査が成立していないため失敗させます。"
fi
if printf '%s\n' "$diag" | grep "tel:" >/dev/null; then
  fail "自己診断に失敗しました: スキーム付きのリンクを相対パスとして扱っています。検査が成立していないため失敗させます。"
fi
if printf '%s\n' "$diag" | grep "^U	" >/dev/null; then
  fail "自己診断に失敗しました: 閉じているフェンスを未閉と判定しています。検査が成立していないため失敗させます。"
fi

unclosed_test="$WORK/selftest-unclosed.md"
printf '%s\n' '```' '[in-open-fence](nope.md)' > "$unclosed_test"
diag_unclosed="$(awk -v DIR="." -v FILE="selftest-unclosed.md" -f "$EXTRACT" "$unclosed_test")" \
  || fail "自己診断で抽出器が異常終了しました。検査が成立していないため失敗させます。"
printf '%s\n' "$diag_unclosed" | grep "^U	" >/dev/null \
  || fail "自己診断に失敗しました: 閉じていないフェンスを検出できません。検査が成立していないため失敗させます。"

# ── 追跡対象の集合を作る ─────────────────────────────────────────────────────
#
# 追跡ファイルそのものと、その祖先ディレクトリ全部を入れる。ディレクトリは git の
# 追跡単位ではないので、祖先として足さないと `[src/](src/)` の形が落ちる。
git rev-parse --is-inside-work-tree >/dev/null 2>&1 \
  || fail "git の作業ツリーではありません。追跡ファイルを列挙できないため失敗させます。"

git ls-files -z > "$TRACKED" \
  || fail "git ls-files に失敗しました。追跡ファイルを列挙できません。"

# 件数はループの外で数える。NUL は 1 レコード 1 個なので、その個数がそのまま
# 件数になる（改行を含むパス名でも崩れない）。
tracked_count="$(tr -cd '\000' < "$TRACKED" | wc -c | tr -d ' ')"
tracked_count="${tracked_count:-0}"

[ "$tracked_count" -gt 0 ] \
  || fail "追跡ファイルが 1 件もありません。検査していないことと、リンクが壊れていないことは別なので失敗させます。"

# 祖先はシェルの文字列操作だけで削る（dirname を 1 件ごとに呼ぶとプロセスが
# 追跡件数 × 階層ぶん起きるため）。
while IFS= read -r -d '' path; do
  printf '%s\n' "$path"
  dir="$path"
  while [ "$dir" != "${dir%/*}" ]; do
    dir="${dir%/*}"
    [ -n "$dir" ] && printf '%s\n' "$dir"
  done
done < "$TRACKED" | sort -u > "$ALLOWED"

# ── 除外設定 ─────────────────────────────────────────────────────────────────
#
# DOC_LINKS_EXCLUDE はコロン区切りのパスプレフィックス（既定は空）。一致した
# 追跡 md はスキャン対象から外す（`$HERE` から読む .env 等の設定ファイルは
# 経由しない。環境変数という 1 経路に絞ることで、個人/組織・OS の違いに関わらず
# 同じ渡し方で上書きできる）。
is_excluded() {
  local md="$1" prefix
  [ -n "${DOC_LINKS_EXCLUDE:-}" ] || return 1
  local IFS=:
  for prefix in $DOC_LINKS_EXCLUDE; do
    # 末尾のスラッシュは畳む（`vendor/docs/` と書いても `vendor/docs` と同じに扱う）。
    # 畳まないと `vendor/docs//*` になり、どの追跡パスにも一致しない。
    prefix="${prefix%/}"
    [ -n "$prefix" ] || continue
    case "$md" in
      "$prefix"|"$prefix"/*) return 0 ;;
    esac
  done
  return 1
}

# ── 追跡 md から抽出する ─────────────────────────────────────────────────────
#
# 一時ファイルへ列挙してから読む。`done < <(git ls-files ...)` のようにプロセス
# 置換へ直接つなぐと、bash はプロセス置換内のコマンドの終了コードを呼び出し元へ
# 伝播しない（set -e でも捕まらない）。git ls-files が異常終了しても md_count が
# 0 のまま次段へ進み、「対象が無いので合格」という正当な経路と区別が付かなくなる。
git ls-files -z '*.md' > "$MD_LIST" \
  || fail "git ls-files に失敗しました。対象文書を列挙できません。"

md_count=0
excluded_count=0
: > "$TARGETS"
while IFS= read -r -d '' md; do
  if is_excluded "$md"; then
    excluded_count=$((excluded_count + 1))
    continue
  fi
  md_count=$((md_count + 1))
  case "$md" in
    */*) mdir="${md%/*}" ;;
    *)   mdir="." ;;
  esac
  awk -v DIR="$mdir" -v FILE="$md" -f "$EXTRACT" "$md" >> "$TARGETS" \
    || fail "抽出が異常終了しました: $md。検査が成立していないため失敗させます。"
done < "$MD_LIST"

# 追跡された Markdown が 1 件も無い（または設定ですべて除外した）場合は、
# 失敗させない。配布直後のプロジェクト（`--with-playbook` を選ばない既定構成は
# Markdown を 1 本も生成しない）に、文書が無いことを理由に赤を強いると、
# ダミーの文書を足す以外に直しようが無い検査になる。「対象が無い」ことと
# 「リンクが壊れていない」ことは両立する。
#
# 判定の要であるフェンス追跡や抽出器が壊れて全件を見落とす形のリグレッションは、
# プロジェクトの実体に Markdown が実在するかどうかとは別に、起動時の自己診断
# （合成した入力で壊れたリンクを必ず検出できることを毎回確かめる）が独立に検出する。
if [ "$md_count" -eq 0 ]; then
  printf '[doc-links] 検査対象の Markdown がありません（除外 %s 件）。検証対象が無いため合格として扱います。\n' \
    "$excluded_count"
  echo "DOC_LINKS_PASS"
  exit 0
fi

# ── フェンスの不均衡 ─────────────────────────────────────────────────────────
if grep -q '^U	' "$TARGETS"; then
  printf '[doc-links] 閉じていないコードフェンスがあります。\n' >&2
  grep '^U	' "$TARGETS" | while IFS="$(printf '\t')" read -r _ f ln mk; do
    printf '[doc-links]   %s:%s で開いたフェンス（%s）が閉じていません\n' "$f" "$ln" "$mk" >&2
  done
  printf '[doc-links] 閉じていないフェンスから先は「コードの中」として検査から外れます。\n' >&2
  printf '[doc-links] 偽の緑になるため失敗させます。対処: 上の行のフェンスを同じ種類の印で閉じる。\n' >&2
  echo "DOC_LINKS_FAIL"
  exit 1
fi

# ── ルート絶対のリンク ───────────────────────────────────────────────────────
if grep -q '^A	' "$TARGETS"; then
  printf '[doc-links] ルート絶対の相対リンクがあります（先頭が / のもの）。\n' >&2
  grep '^A	' "$TARGETS" | while IFS="$(printf '\t')" read -r _ loc raw; do
    printf '[doc-links]   %s → %s\n' "$loc" "$raw" >&2
  done
  printf '[doc-links] 解決規則が処理系で揺れるため使いません。\n' >&2
  printf '[doc-links] 対処: その文書からの相対パスで書き直す。\n' >&2
  echo "DOC_LINKS_FAIL"
  exit 1
fi

# ── リポジトリの外へ出るリンク ───────────────────────────────────────────────
if grep -q '^E	' "$TARGETS"; then
  printf '[doc-links] リポジトリの外を指す相対リンクがあります。\n' >&2
  grep '^E	' "$TARGETS" | while IFS="$(printf '\t')" read -r _ loc raw; do
    printf '[doc-links]   %s → %s\n' "$loc" "$raw" >&2
  done
  printf '[doc-links] 手元では開けても、配布された文書では必ず壊れます。\n' >&2
  echo "DOC_LINKS_FAIL"
  exit 1
fi

# ── 突き合わせ ───────────────────────────────────────────────────────────────
link_count="$(grep -c '^L	' "$TARGETS" || true)"
link_count="${link_count:-0}"

awk -F'\t' '$1 == "L" { print $2 }' "$TARGETS" | sort -u > "$WANTED"
comm -23 "$WANTED" "$ALLOWED" > "$MISSING"

unique_count="$(wc -l < "$WANTED" | tr -d ' ')"
missing_count="$(wc -l < "$MISSING" | tr -d ' ')"

printf '[doc-links] 検査したパス: 追跡 md %s 件（除外 %s 件）/ 相対リンク %s 本（ユニークな行き先 %s 件）\n' \
  "$md_count" "$excluded_count" "$link_count" "$unique_count"

if [ "${missing_count:-0}" -gt 0 ]; then
  printf '[doc-links] 追跡対象として実在しない行き先を %s 件検出しました。\n' "$missing_count" >&2
  while IFS= read -r miss; do
    if [ -e "$miss" ]; then
      printf '[doc-links]   %s（作業ツリーにはあるが追跡されていない）\n' "$miss" >&2
    else
      printf '[doc-links]   %s（存在しない）\n' "$miss" >&2
    fi
    awk -F'\t' -v M="$miss" '$1 == "L" && $2 == M { printf "[doc-links]     ← %s に %s\n", $3, $4 }' \
      "$TARGETS" >&2
  done < "$MISSING"
  printf '[doc-links] 対処: 綴りを直すか、行き先を追跡対象に入れる。\n' >&2
  printf '[doc-links]       追跡されていない行き先は、手元では開けても配布側では 404 になります。\n' >&2
  echo "DOC_LINKS_FAIL"
  exit 1
fi

echo "DOC_LINKS_PASS"
exit 0
