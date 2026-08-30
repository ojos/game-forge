#!/usr/bin/env bash
# check-shell-portability.sh — シェルスクリプトに「この開発環境では動くが BSD 系
# （macOS）では落ちる」書き方が入っていないかを、実行せずに確かめる。
#
# ## なぜ要るのか
#
# **同じ事故を 3 度繰り返した。** 第 1 波で GNU 拡張のオプション、第 2 波で
# `date +%s%N` と `sha256sum`、そして今回 `mktemp`（テンプレート無し）である。
# **いずれも devcontainer（Linux / GNU coreutils）では通り、利用者の端末（macOS）で
# 落ちる。** しかも落ちる場所は、**利用者が自分で叩く手順の中**——配備や検証の入口で、
# いちばん失敗の代償が大きいところに集まっている。
#
# **道具の差は、実行しなくても綴りで分かる。** 分かるものは機械で見る
# （shared-ai-rules 12 章）。shellcheck は既に回っているが、この種類（GNU 拡張への
# 依存）は指摘しない。
#
# ## この検査が約束しないこと
#
# **可搬性の保証ではない。表に載っている綴りが無いことしか言わない。**
#
# - **踏んだ事故を表に足していく形である。** 網羅ではないので、**緑でも macOS で
#   落ちうる。** 新しく踏んだら、直すのと同じコミットで表へ 1 行足すこと。
# - **bash の版は見ない。** macOS の `/bin/bash` は 3.2 で、`mapfile` も連想配列も
#   無い。このリポジトリは既に `mapfile` を前提にしており（`scripts/acceptance-remote.sh`）、
#   利用者は新しい bash を使っている。**方針として受け入れているものを、後から
#   検査で赤くしない。**
# - **外部コマンドの存在も見ない**（jq / terraform / aws など）。各スクリプトが
#   `command -v` で確かめる責務である。
#
# ## 逃げ道
#
# **代替を用意した上で GNU の綴りを使う場合は、その行に `# bsd-ok: 理由` を書く。**
# 実際にこのリポジトリには 2 か所ある（`sha256sum` と `stat -c`。どちらも
# BSD 系への分岐を持っている）。**逃げ道を用意するのは、検査を無効化させないためである**
# ——逃げ道が無い検査は、そのうち丸ごと外される。印は差分に残るので、レビューで見える。
#
# 使い方:
#   bash scripts/check-shell-portability.sh
#
# 終了コード: 0 = SHELL_PORTABILITY_PASS / 1 = GNU 依存の綴りを検出
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$(dirname "$HERE")"

SELF="scripts/check-shell-portability.sh"

# 検査対象。追跡している *.sh を見る（追跡外の手元スクリプトは対象にしない）。
targets=()
if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  while IFS= read -r file; do
    [[ "$file" == "$SELF" ]] && continue
    targets+=("$file")
  done < <(git ls-files '*.sh')
else
  while IFS= read -r file; do
    [[ "$file" == "$SELF" ]] && continue
    targets+=("$file")
  done < <(find scripts -maxdepth 1 -name '*.sh' | sort)
fi

if [[ "${#targets[@]}" -eq 0 ]]; then
  echo "[portability] 検査対象の *.sh がありません。検査が成立しません。" >&2
  exit 1
fi

# 規則表。1 行 = `正規表現<TAB>説明（何が起きるか / 代わりに何を書くか）`。
#
# **踏んだ事故を書き足す場所はここである。** 表を増やすときは、必ず「代わりに何を
# 書くか」まで書くこと。指摘だけの検査は、直し方を探す時間を利用者へ押し付ける。
# ## 規則の広さについて（#183 のレビュー指摘への回答）
#
# **`IGNORECASE[[:space:]]*=` は、道具名（`awk`）で絞らずに広く取ってある。** 「将来
# bash 側の変数代入まで誤検出しうるので `awk ... IGNORECASE = ...` に絞れ」という指摘を
# 受けたが、**絞らない判断をした。** 根拠を残す。
#
#   1. **絞ると、このリポジトリに実在する書き方を見逃す。** awk のプログラムが複数行に
#      分かれる書き方（`awk '` の次の行から本体が始まる形）が実際に 2 か所ある
#      （`scripts/check-sandbox-cors.sh` / `scripts/check-go-version-copies.sh`）。
#      規則は 1 行ずつ当てるので、`awk` と同じ行に無い `IGNORECASE` は拾えない。
#      **実測で確認した**（複数行の形に対し、絞った規則は見逃し、広い規則は検出した）。
#   2. **偽陰性のほうが明確に悪い。** この検査は冒頭のとおり網羅ではなく、「緑でも
#      macOS で落ちうる」ことを前提に置いている。**弱点は最初から偽陰性の側にあり、
#      そこへ足すのは向きが逆である。**
#   3. **コメント行は既に見ていない**（下の走査）。だから「説明文で綴りに触れたら
#      誤検出する」という経路は最初から無い。**残る偽陽性は「実行される bash に
#      `IGNORECASE=` という名の変数代入がある」場合だけで、現に 1 件も無い。**
#   4. **逃げ道がある。** 万一そうなっても、その行へ `# bsd-ok: 理由` を書けば恒久的に
#      黙る。**印は差分に残るのでレビューで見える。** 誤検出を黙らせる手段が用意されて
#      いる以上、広めに取るコストは低い。
#
# **同じ判断を他の規則へ機械的に広げないこと。** ここは「gawk 拡張の変数名」という、
# 名前そのものが十分に珍しい綴りだから成立する。

RULES="$(
  cat <<'RULES'
mktemp( +-[a-z]+)* *(\)|;|&|\||$)	テンプレート無しの mktemp は BSD 系で失敗する。mktemp "${TMPDIR:-/tmp}/name.XXXXXX" と書く
date [^|;&]*%N	BSD の date に %N（ナノ秒）は無い。秒で足りるなら %s、要るなら別の手段を選ぶ
(^|[^-[:alnum:]_])(sha256sum|md5sum)	BSD 系には無い。openssl dgst -sha256 か、shasum -a 256 への分岐を書く
sed [^|;&]*\\x[0-9A-Fa-f]	\\xNN は GNU sed の拡張。BSD sed は文字 x として扱う。ESC="$(printf '\033')" のように作って渡す
sed +-i( +-[a-zA-Z]+)* +[^'"]	sed -i の引数の扱いが GNU と BSD で違う。一時ファイルへ書いて mv する
grep [^|;&]*(-P|--perl-regexp)	BSD の grep に -P は無い。-E で書き直す
readlink +-f	BSD の readlink に -f は無い。cd と pwd で解決する
base64 [^|;&]*-w	BSD の base64 に -w は無い。折り返しが要るなら fold へ渡す
stat +-c	BSD の stat は -f である。両方へ分岐するか、別の手段を選ぶ
find [^|;&]*-printf	BSD の find に -printf は無い。-exec か -print と組み合わせる
xargs [^|;&]*-r	BSD の xargs に -r は無い（空入力でも実行しない挙動が既定）
(head|tail) +-n +-[0-9]	負の行数は GNU 拡張。BSD には無い
(^|[^-[:alnum:]_/])tac( |$)	BSD 系には tac が無い。tail -r か awk で代用する
IGNORECASE[[:space:]]*=	IGNORECASE は gawk の拡張。mawk（Debian 既定の awk）と BSD awk は**黙って無視する**ので、大小の違う入力に一致しなくなる。tolower($0) ~ /.../ と書く
RULES
)"

failed=0
checked_lines=0
skipped=0

while IFS=$'\t' read -r pattern message; do
  [[ -n "$pattern" ]] || continue
  for file in "${targets[@]}"; do
    [[ -f "$file" ]] || continue
    while IFS= read -r hit; do
      [[ -n "$hit" ]] || continue
      # `grep -n` の出力は `行番号:本文`（対象は 1 ファイルなのでファイル名は付かない）。
      local_line_no="${hit%%:*}"
      line="${hit#*:}"
      # コメント行は見ない（説明の中で綴りに触れられないと、経緯を書けない）。
      [[ "$line" =~ ^[[:space:]]*# ]] && continue
      # 明示的な逃げ道。**存在確認の除外より先に見る**（印を付けた意図が数に残る）。
      if [[ "$line" == *"# bsd-ok:"* ]]; then
        skipped=$((skipped + 1))
        continue
      fi
      # **存在確認は逃げ道そのものである。** `command -v foo` は「foo があるか」を
      # 見る書き方で、可搬性のための分岐を書く唯一の手段である。呼び出しではない。
      [[ "$line" == *"command -v"* ]] && continue
      echo "[portability] ${file}:${local_line_no}: $message" >&2
      echo "[portability]   ${line}" >&2
      failed=1
    done < <(grep -nE "$pattern" "$file" 2>/dev/null || true)
  done
done <<<"$RULES"

for file in "${targets[@]}"; do
  [[ -f "$file" ]] || continue
  checked_lines=$((checked_lines + $(wc -l <"$file")))
done

if [[ "$failed" -ne 0 ]]; then
  echo "[portability] BSD 系（macOS）で落ちる綴りがあります。" >&2
  echo "[portability] 代替を用意した上での意図的な使用なら、その行へ '# bsd-ok: 理由' を付けること。" >&2
  exit 1
fi

echo "[portability] ${#targets[@]} ファイル / ${checked_lines} 行を照合しました（逃げ道の印 ${skipped} 件）"
echo "SHELL_PORTABILITY_PASS"
