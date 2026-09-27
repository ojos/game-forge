#!/usr/bin/env bash
# check-doc-links.sh — 追跡 Markdown の相対リンクが、実在する追跡対象を指していることの検知ゲート（#803）
#
# 位置づけ:
#   判定はこのスクリプトが持ち、scripts/acceptance.sh は呼ぶだけ。
#   scripts/check-control-chars.sh / scripts/check-logo-copies.sh と同じ形にそろえる。
#
# なぜ機構で押さえるか:
#   **Copilot code review が繰り返し出していた指摘のうち、最頻出がこれである**（#794 の
#   「存在しない相対リンクを再度参照している」）。直近の指摘 7 件を分類すると 5 件（71%）が
#   機械検査に落とせる種類で、リンクの実在はその中でも判定が完全に決定的な 1 件だった。
#
#   **機械検査へ落とすと、記録の性質が無料で付いてくる。** `verify.yml` の verify ジョブが
#   `verify.sh` を再実行するため、「著者の操作なしに記録が作られる / 消せない / 内容が著者を
#   通らない」が自動的に満たされる。リモートのレビューをローカルへ寄せても失われない層は
#   ここだけである（#807）。
#
#   リンク切れは**読んでも気づけない**類でもある。文書は正しく見え、押した人だけが 404 に
#   当たる。shared-ai-rules.md 12 章「呼びかけで担保しない」に照らして機構へ移す。
#
# 何を見るか:
#   追跡された `*.md` の中の **相対リンク** が、**追跡対象として実在する**こと。
#   対象の形は `](...)` で、画像（`![alt](path)`）も同じ綴りなので一緒に見る。
#
#   「追跡対象として実在する」の判定に、作業ツリーの有無（test -e）を使わない。
#   **GitHub が配るのは追跡ファイルだけ**なので、ローカルにだけある生成物や無視された
#   ファイルへのリンクは、手元では開けても公開された文書では 404 になる。判定は
#   git ls-files から作った集合への所属で行う（ディレクトリは、追跡ファイルの祖先として
#   集合へ入れる。`[src/](src/)` のようなリンクが 12 本実在する）。
#
#   パスは正規化してから突き合わせる（`.` と `..` を畳む）。畳んだ結果が**リポジトリの外へ
#   出るリンクは不合格**とする。手元の絶対パスの都合で通ってしまい、公開側では必ず壊れる。
#
# 何を見ないか（この検査が見ていると誤解しないために明記する）:
#   - **外部 URL の到達性**（`http://` / `https://` / `//`）。ネットワークを要するので
#     ローカル層に置けない（loop-workflow.md「受け入れ条件の二層」）。到達性を見たいなら
#     外部層の検査として別に足す。
#   - **アンカーの実在**（`#見出し` / `#L160`）。`#` 以降は落としてからパスを見る。見出しの
#     照合には Markdown の見出し→アンカー変換の再実装が要り、日本語見出しでは規則が
#     処理系に依存する。行番号アンカー（`#L160`）は対象ファイルの行数に依存し、追随しない
#     写しを増やす。**#803 の scope.out。**
#   - **`mailto:`**（宛先の実在は機械で確かめられない）。
#   - **インラインコード（`` ` `` で囲まれた範囲）の除外**。**意図的に剥がさない。**
#     剥がす実装は「2 つのコードスパンの間にある実在のリンク」を取り落とす（実測: 同じ行に
#     `` ` `` が複数あり、そのあいだに本物のリンクが書かれている箇所が 4 件ある）。
#     **偽の緑（実在するリンクを検査対象から外す）より、偽の赤（コード例の中のリンク表記を
#     拾う）のほうが害が小さい。** 現時点で後者に当たる箇所は 0 件である。
#   - **参照形式リンク**（`[text][ref]` と `[ref]: path`）。追跡 md に 0 件（実測）。
#     使い始めたら、ここへ足す。
#   - **角括弧で囲む形**（`](<path with space>)`）と **URL エンコード**（`%20`）。どちらも 0 件（実測）。
#
# コードフェンスの扱い:
#   フェンス（``` の行）の内側は見ない。コード例に書かれたリンク表記を拾うと、直しようのない
#   赤が出る。**切り替えは行の先頭の空白を許して見る**——字下げされたフェンスが実在する
#   （箇条の中のコード）ので、`^```  だけを見ると切り替えを取りこぼす。
#
#   **フェンス行が奇数のファイルは不合格にする。** 開いたまま閉じていないと、そこから
#   ファイル末尾までが「コードの中」として検査から外れる。**それは偽の緑である。**
#   奇数であることは Markdown としても壊れているので、直すべき側も明確である。
#
# 速度:
#   実測 **57 ms**（追跡 709 件 / 追跡 md 51 件 / 相対リンク 146 本。同じ環境で
#   check-table-breaks.sh が 46 ms、check-control-chars.sh が 103 ms）。同じ層に置ける桁である。
#
#   **最初の実装は 590 ms だった。** 祖先ディレクトリの列挙で `dirname` を呼んでいたため、
#   追跡 709 件 × 階層ぶんのプロセスが起きていた。シェルの文字列操作（`${dir%/*}`）へ
#   置き換えて 1 桁縮めた。**プロセスを起こす数が費用を決める**ので、ここへ追加の判定を
#   足すときは、1 件ごとに外部コマンドを呼ぶ形にしないこと。
#
# 検査が成立していないことを合格にしない:
#   git 管理外での実行、git コマンドの失敗、追跡ファイル 0 件、追跡 md が 0 件、awk の失敗は
#   いずれも「リンクが壊れていない」ことを意味しない。すべて失敗として扱う。
#   加えて**起動時に検査機構そのものを自己診断する**（壊れたリンクを必ず当てること、
#   正しいリンクを誤検出しないこと、フェンスの内側を拾わないこと）。書き損じで「何も当たらない
#   検査」になっていた場合、それは常に緑を返すため、赤にならない限り誰も気づけない。
#
# 使い方:
#   bash scripts/check-doc-links.sh
#
# 終了コード:
#   0 = DOC_LINKS_PASS
#   1 = DOC_LINKS_FAIL（リンク切れ、または検査が成立しなかった）
#
# **GNU 拡張を使わない**（利用者の端末は macOS / bash 3.2。docs/handoff.md 3 章）。
# awk は POSIX の範囲に収める（gensub 等を使わない）。
set -euo pipefail

# 角括弧の範囲指定と sort/comm の照合順をバイト順に固定する
# （check-no-secrets.sh が sort/comm で固定しているのと同じ理由）。
export LC_ALL=C

# 検査はプロジェクトルート基準で行う。scripts/ の 1 階層上がルート。
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
TARGETS="$WORK/targets"
WANTED="$WORK/wanted"
MISSING="$WORK/missing"

# ── 抽出器 ───────────────────────────────────────────────────────────────────
#
# 1 ファイルを読み、検査対象の相対リンクを「正規化したパス <TAB> ファイル:行」で出す。
# フェンスの内側は読み飛ばし、フェンス行の総数を数えて不均衡を報告する。
#
# 出力の種類を先頭の印で分ける。
#   L<TAB>正規化パス<TAB>ファイル:行<TAB>元の綴り   … 検査すべきリンク
#   E<TAB>ファイル:行<TAB>元の綴り                  … リポジトリの外へ出るリンク
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
BEGIN { infence = 0; fences = 0 }
/^[[:space:]]*```/ { fences++; infence = !infence; next }
infence { next }
{
  line = $0
  while (match(line, /\]\([^)]*\)/)) {
    raw = substr(line, RSTART + 2, RLENGTH - 3)
    line = substr(line, RSTART + RLENGTH)
    t = raw
    if (t ~ /^https?:\/\//) continue
    if (t ~ /^mailto:/) continue
    if (t ~ /^\/\//) continue
    if (t ~ /^#/) continue
    sub(/#.*$/, "", t)
    if (t == "") continue
    joined = (DIR == ".") ? t : DIR "/" t
    norm = normalize(joined)
    if (norm == "\001ESCAPE") {
      printf "E\t%s:%d\t%s\n", FILE, FNR, raw
      continue
    }
    # 畳んだ結果が空になるのは「リポジトリのルートそのもの」を指す場合だけである
    # （ルート直下の md に `](.)` と書いた形）。ルートは常に在るので、外へ出たのとは
    # 区別して素通しする。**一緒に扱うと、正しいリンクへ「外を指す」と誤った理由を出す。**
    if (norm == "") continue
    printf "L\t%s\t%s:%d\t%s\n", norm, FILE, FNR, raw
  }
}
END {
  if (fences % 2 != 0) printf "U\t%s\t%d\n", FILE, fences
}
AWK

# ── 自己診断 ─────────────────────────────────────────────────────────────────
#
# 3 方向を見る。当たること（偽陰性＝常に緑になる壊れ方）、当たらないこと（偽陽性）、
# フェンスの内側を拾わないこと（直しようのない赤）。
selftest="$WORK/selftest.md"
printf '%s\n' \
  '[ok](present.md)' \
  '```' \
  '[fenced](nope-in-fence.md)' \
  '```' \
  '[gone](absent.md)' \
  > "$selftest"
diag="$(awk -v DIR="." -v FILE="selftest.md" -f "$EXTRACT" "$selftest")" \
  || fail "自己診断で抽出器が異常終了しました。検査が成立していないため失敗させます。"

printf '%s\n' "$diag" | grep -q "^L	absent.md	" \
  || fail "自己診断に失敗しました: 壊れたリンクを抽出できません。検査が成立していないため失敗させます。"
printf '%s\n' "$diag" | grep -q "^L	present.md	" \
  || fail "自己診断に失敗しました: 正常なリンクを抽出できません。検査が成立していないため失敗させます。"
if printf '%s\n' "$diag" | grep -q "nope-in-fence.md"; then
  fail "自己診断に失敗しました: コードフェンスの内側を拾っています。検査が成立していないため失敗させます。"
fi

# ── 追跡対象の集合を作る ─────────────────────────────────────────────────────
#
# 追跡ファイルそのものと、その祖先ディレクトリ全部を入れる。ディレクトリは git の
# 追跡単位ではないので、祖先として足さないと `[src/](src/)` の形が落ちる（実在 12 本）。
git rev-parse --is-inside-work-tree >/dev/null 2>&1 \
  || fail "git の作業ツリーではありません。追跡ファイルを列挙できないため失敗させます。"

git ls-files -z > "$WORK/tracked.z" \
  || fail "git ls-files に失敗しました。追跡ファイルを列挙できません。"

# 件数はループの外で数える。**ループをパイプの左に置くとサブシェルになり、
# 中で数えた変数が残らない**（最初の実装がこれで、常に「追跡 0 件」で落ちた）。
# NUL は 1 レコード 1 個なので、その個数がそのまま件数になる（改行を含むパス名でも崩れない）。
tracked_count="$(tr -cd '\000' < "$WORK/tracked.z" | wc -c | tr -d ' ')"
tracked_count="${tracked_count:-0}"

# 祖先は**シェルの文字列操作だけで**削る。`dirname` を呼ぶと追跡 709 件 × 階層ぶんの
# プロセスが起き、それだけで 0.5 秒かかった（実測。隣の検査の 1 桁遅い側になる）。
while IFS= read -r -d '' path; do
  printf '%s\n' "$path"
  dir="$path"
  while [ "$dir" != "${dir%/*}" ]; do
    dir="${dir%/*}"
    [ -n "$dir" ] && printf '%s\n' "$dir"
  done
done < "$WORK/tracked.z" | sort -u > "$ALLOWED"

[ "$tracked_count" -gt 0 ] \
  || fail "追跡ファイルが 1 件もありません。検査していないことと、リンクが壊れていないことは別なので失敗させます。"

# ── 追跡 md から抽出する ─────────────────────────────────────────────────────
md_count=0
: > "$TARGETS"
while IFS= read -r -d '' md; do
  md_count=$((md_count + 1))
  case "$md" in
    */*) mdir="${md%/*}" ;;
    *)   mdir="." ;;
  esac
  awk -v DIR="$mdir" -v FILE="$md" -f "$EXTRACT" "$md" >> "$TARGETS" \
    || fail "抽出が異常終了しました: $md。検査が成立していないため失敗させます。"
done < <(git ls-files -z '*.md')

[ "$md_count" -gt 0 ] \
  || fail "追跡された Markdown が 1 件もありません。検査が成立していないため失敗させます。"

# ── フェンスの不均衡 ─────────────────────────────────────────────────────────
if grep -q '^U	' "$TARGETS"; then
  printf '[doc-links] コードフェンス（```）の本数が奇数のファイルがあります。\n' >&2
  grep '^U	' "$TARGETS" | while IFS="$(printf '\t')" read -r _ f n; do
    printf '[doc-links]   %s（フェンス行 %s 本）\n' "$f" "$n" >&2
  done
  printf '[doc-links] 閉じていないフェンスから先は「コードの中」として検査から外れます。\n' >&2
  printf '[doc-links] 偽の緑になるため失敗させます。対処: 閉じ忘れたフェンスを閉じる。\n' >&2
  echo "DOC_LINKS_FAIL"
  exit 1
fi

# ── リポジトリの外へ出るリンク ───────────────────────────────────────────────
if grep -q '^E	' "$TARGETS"; then
  printf '[doc-links] リポジトリの外を指す相対リンクがあります。\n' >&2
  grep '^E	' "$TARGETS" | while IFS="$(printf '\t')" read -r _ loc raw; do
    printf '[doc-links]   %s → %s\n' "$loc" "$raw" >&2
  done
  printf '[doc-links] 手元では開けても、公開された文書では必ず壊れます。\n' >&2
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

printf '[doc-links] 検査したパス: 追跡 md %s 件 / 相対リンク %s 本（ユニークな行き先 %s 件）\n' \
  "$md_count" "$link_count" "$unique_count"

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
  printf '[doc-links]       追跡されていない行き先は、手元では開けても公開側では 404 になります。\n' >&2
  echo "DOC_LINKS_FAIL"
  exit 1
fi

echo "DOC_LINKS_PASS"
exit 0
