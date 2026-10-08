#!/usr/bin/env bash
# check-shell-portability.sh — 「この環境では通るが BSD 系（macOS）では落ちる」綴りを、
#   実行せずに検出する。
#
# 位置づけ:
#   判定はこのスクリプトが持ち、scripts/acceptance.sh は呼ぶだけ。
#   scripts/check-control-chars.sh / scripts/check-table-breaks.sh と同じ形にそろえる。
#
# なぜ機構で押さえるか:
#   CI は Linux（GNU coreutils）でしか走らない。一方、配布されたスクリプトと README の
#   導入手順は**利用者のホスト（macOS）で実行される**。この差は原理的にすり抜ける——
#   テストを書いても緑になり、レビューでも「動いている」ようにしか見えない。
#
#   実際に同じ形を繰り返し踏んでいる。素の mktemp が 19 箇所まで積み上がった例、
#   pipefail 下の SIGPIPE で版の表示が必ず失敗していた例、GNU 専用の grep -Z で
#   走査そのものが落ちていた例。**いずれも外部のレビューが拾うまで気づけなかった。**
#
#   道具の差は、実行しなくても綴りで分かる。分かるものは機械で見る。
#
# この検査が約束しないこと:
#   **移植性の保証ではない。規則表に載っている綴りが無いことしか言わない。**
#   踏んだ事故を表へ足していく形なので、**緑でも macOS で落ちうる。** 新しく踏んだら、
#   直すのと同じコミットで表へ 1 行足すこと。
#
#   - **bash の版は見ない。** macOS の /bin/bash は 3.2 で mapfile も連想配列も無いが、
#     新しい bash を使う前提を受け入れているなら、それを後から検査で赤くしない。
#   - **外部コマンドの存在も見ない**（jq / terraform など）。各スクリプトが command -v で
#     確かめる責務である。
#   - **`# bsd-ok:` を付けた行の妥当性は検査しない。** 印があるかどうかだけを見る。
#     妥当性はレビューの責務である。
#
# 逃げ道:
#   **代替を用意した上で意図的に使う場合は、その行へ `# bsd-ok: 理由` を書く。**
#   理由は必須で、空の印は逃げ道として認めない。
#
#   **逃げ道を用意するのは、検査を無効化させないためである。** 逃げ道の無い検査は、
#   そのうち丸ごと外される。印は差分に残るのでレビューで見える。
#
#   **この検査自身とテストも対象に含める。** 検出対象の綴りをリテラルで持つ層を
#   除外すると、そこに残った本物を見逃す（実際に見逃した）。除外ではなく印で通す。
#
# 検査対象:
#   追跡している *.sh と *.md。*.md は**フェンスで囲まれたコード部分だけ**を見る。
#   - *.md を含めるのは、README の導入手順が利用者のホストでそのまま実行されるため。
#   - 地の文を見ないのは、リリースノート等が綴りを説明として書くため。全文へ当てると
#     検査が文章の書き方に依存する。
#   - コメント行は見ない。同じ理由で、「なぜ直したか」を書けなくなるため。
#
# ── 検出するもの ──────────────────────────────────────────────────────────────
#
# SED_BRACKET_TAB: ブラケット式の中の `\t`
#
#   BSD 系（macOS）の sed は、**ブラケット式の中では** `\t` をタブとして解釈しない。
#   `[ \t]` は「空白・バックスラッシュ・t」の集合になり、タブ字下げの行を取りこぼす。
#   POSIX の規定どおり（ブラケット式の中でバックスラッシュは特殊な意味を失う）。
#
#   実測（macOS 26.5.2 / /usr/bin/sed / /usr/bin/awk version 20200816）:
#
#     ブラケット内の \t   sed 's/[ \t]/X/'   a<TAB>b -> 一致しない / atb -> aXb
#                          => タブとして効かない。**検出するのはこれだけ**
#
#   次の 2 つは検出対象にしていたが、測定で否定されたので外した。対象プラット
#   フォーム（macOS の BWK awk / Linux の mawk）のどちらでも動く。
#   **実測に合っていない検査は、動くコードの書き換えを迫るぶん、検査が無いより悪い。**
#
#     ブラケット外の \t   sed 's/\t/TAB/'    -> aTABb（タブとして効く）
#     置換側の \n         sed 's/x/a\nb/'    -> 2 行（改行になる）
#
#   パターン側の `\n`（`/^$/N;/^\n$/D` の形）も効くことを確認済み。
#
#   **3 つ目として awk の間隔指定も外していたが、その判断は誤りだった。** 根拠にした
#   見本は「`xx` に一致するから間隔指定として機能する」だったが、**その入力では
#   区別が付かない。** 間隔指定が機能していても、下限の 2 回だけに解釈されていても
#   `xx` には一致する。**区別できる入力は 3 回以上の繰り返しである。** AWK_INTERVAL
#   として検出へ戻した（下記）。
#
# AWK_INTERVAL: awk の正規表現の間隔指定（下限 2 以上）
#
#   **mawk は下限が 2 以上の間隔指定で、下限を超える繰り返しに一致しない。** 書いた
#   意図より狭い集合を指すが、下限ちょうどの入力には一致するため、緑のまま通る。
#
#   実測（Linux / mawk 1.3.4 20240123。比較は GNU grep 3.11）:
#
#     awk '/^x{2,3}$/'   xx   -> 一致      grep -E '^x{2,3}$'   xx   -> 一致
#     awk '/^x{2,3}$/'   xxx  -> **不一致** grep -E '^x{2,3}$'   xxx  -> 一致
#     awk '/^x{2,4}$/'   xxxx -> **不一致** grep -E '^x{2,4}$'   xxxx -> 一致
#     awk '/^x{2,}$/'    xxx  -> **不一致** grep -E '^x{2,}$'    xxx  -> 一致
#
#   **下限が 1 の形は一致する**（`{1,3}` は 1〜3 回に正しく一致し、4 回には一致しない）。
#   したがって検出は**下限 2 以上に限る。** 「{n,m} を {n} と解釈する」という一般化は
#   実測に反するので書かない。
#
#   **macOS の BWK awk（version 20200816）での挙動は未測である。** 上の 3 行を実機で
#   測ったら、この表へ足すこと。mawk だけでも規則の理由は足りる（devcontainer の awk は
#   mawk であり、対象プラットフォームに含まれる）。
#
#   検出は awk の引数のうち、**正規表現として解釈される部分だけ**を見る。
#
#     - `/…/` のリテラル（`gsub(/ {2,}/, …)` や `match($0, /b{4,}/)` を含む）
#     - `~` / `!~` の右辺の文字列リテラル
#     - `-v name=` の右辺
#
#   同じ行に `grep -E 'x{2,3}'` があっても、そちらは grep の引数なので数えない
#   （grep は POSIX どおりに解釈する）。
#
#   **限界 1: 別ファイルの awk スクリプト（`awk -f scan.awk`）は拾えない。** パターンが
#   行に現れないためで、この検査自身がその形である。
#
#   **限界 2: 文字列を変数へ入れてから `~` で使う形は拾えない**
#   （`awk 'BEGIN { p = "a{2,5}" } $0 ~ p'`）。その文字列が正規表現として使われるかを
#   構文だけでは決められない。プログラム本文へ素当てすると `awk 'BEGIN { print
#   "{2,3}" }'` まで報告する（実測）。**正常なコードへ書き換えを迫るより、偽陰性の側へ
#   倒す**（規則表の方針と同じ向き）。
#
#   網羅はしていない。
#
# BRACKET_BACKSLASH_N: ブラケット式の中の `\n`
#
#   ブラケット式の中でバックスラッシュは特殊な意味を失う（POSIX）。**`[^\n]` は
#   「改行以外」ではなく「バックスラッシュと n 以外」であり、`n` という文字を含む行を
#   黙って落とす。** 「同じ行の中で A と B」を表現したつもりの式が、意図と違う集合を指す。
#
#   実測（GNU grep 3.11。locale は C / C.UTF-8 / en_US.UTF-8 で差が無い）:
#
#     grep -E 'A[^\n]*B'   AxB    -> 一致
#     grep -E 'A[^\n]*B'   A\nB   -> **不一致**（\ と n が集合から外れている）
#     grep -E '[\n]'       n      -> **一致**（改行の集合ではない）
#
#   SED_BRACKET_TAB と同じ類型だが、あちらは sed の引数だけを見る。こちらは sed /
#   awk / grep の引数を見る（`[^\n]` は grep の式として書かれた実例がある）。
#
#   **awk 側は AWK_INTERVAL と同じく正規表現の文脈だけを見る**（`awk 'BEGIN { print
#   "[^\n]" }'` は報告しない）。**`grep -F` / `--fixed-strings` は対象外にする。**
#   固定文字列検索ではブラケットが正規表現として解釈されないため、`[^\n]` を書いても
#   意図どおりの可搬な呼び出しである（実測。Copilot の指摘）。
#
#   **sed 側はパターンだけを見る。**`s/pat/repl/flags` の
#   置換側と `y` コマンドは対象外である。**そこにブラケット式は存在せず、`[` と `]` は
#   リテラルの文字**なので、「ブラケット式の中の `\t` / `\n`」という判定が成り立たない。
#   これは移植性の実測ではなく構造上の理由で、SED_BRACKET_TAB も同じ扱いにそろえた。
#
#   取り出すのは次の 2 つ。実測で確かめた形は下記のとおり。
#
#     アドレス           sed -n '/^[ \t]*x/p'        -> 検出する
#     s のパターン側     sed -n 's/^[ \t]*x//p'      -> 検出する
#     別の区切り         sed 's|^[^\n]*x||'          -> 検出する
#     複数の -e          sed -e 's/a/b/' -e 's/^[^\n]//' -> 検出する
#     アドレス付きの s   sed '1,$s/x/[\n]/'          -> 検出しない（置換側）
#     s の置換側         sed 's/x/[\n]/'             -> 検出しない
#     y コマンド         sed 'y/ab/[\n]/'            -> 検出しない
#
#   **限界: 区切り文字がブラケット式の中に現れる形（`sed 's/[/]/x/'`）は取りこぼす。**
#   区切りを数える側がブラケットを見ないため、パターンが途中で切れる。正しい sed だが
#   検出できない。偽陰性の側へ倒している。
#
#   **`\t` を sed 以外でも見るかは、この検査では扱わない**（sed 以外での実測をしていない）。
#
# GREP_DASH_Z_FLAG: `grep -Z` は GNU 拡張
#
#   `grep -Z`（該当ファイル名を NUL 区切りで返す）は GNU grep の拡張で、BSD の grep に
#   は無い。**開発環境の grep によっては通ってしまうため、CI・手元のどちらも気づけない。**
#   macOS ではオプションエラーになり、対象ファイルがある正常なプロジェクトでも走査
#   そのものが失敗する。
#
#   検出は「同じ行に grep という単語があり、かつ Z を含む短縮オプションの塊
#   （`-Z` / `-lZa` 等）がある」ことで判定する。`--` で始まる長いオプション名は対象に
#   ならない。全体を通した厳密な引数解析はしていない。
#
# PIPEFAIL_SIGPIPE: `pipefail` 下で早期終了する消費側へのパイプ
#
#   `grep -q` や `head -n 1` は目的を果たした時点で終了し、パイプを閉じる。まだ書き
#   込み中の生産側は SIGPIPE で死に、終了コード 141 を返す。`pipefail` があると
#   **パイプライン全体が非 0** になる。消費側が成功していても、である。
#
#     $ set -o pipefail
#     $ find <多数の .md がある木> -type f -name '*.md' | grep -q .
#     rc=141  PIPESTATUS=141 0        <- 右は 0（一致している）
#
#   **GNU find は EPIPE を握って 0 で終わる。BSD find（macOS）は SIGPIPE で死ぬ。**
#   Linux コンテナで実行して再現する検査を書いても緑になる。だから静的に見る。
#
#   直し方:
#     find … | grep -q .    -> find … -print -quit の出力が空かで判定（パイプを無くす）
#     find … | head -n 1    -> find … -print -quit
#     cmd  … | grep -q X    -> cmd … | grep X >/dev/null（-q を外せば EOF まで読む）
#     cmd  … | head -n 1    -> cmd … | sed -n 1p（EOF まで読む）
#
#   `|| true` を足すだけの対処は勧めない。生産側が**本当に失敗した**場合まで握り潰し、
#   検査が成立していないことを合格にしてしまう。ただし既存の `|| true` は意図的な
#   ガードなので、検出の対象からは外す。
#
#   **報告するのは「終了コードが読まれる形」だけである。**
#     - パイプがコマンド置換の外にある   -> 報告する（その文の終了コードそのものになる）
#     - コマンド置換の中にある           -> **それを囲む文が条件文脈のときだけ**報告する
#
#   後者を外すのは、`v="$(cmd | head -1)"` のように**終了コードを誰も読まない**形では
#   判定が反転しようがないためである。除外しないと、実害の無い代入が大量に赤くなり、
#   検査が読まれなくなる（実測: この除外が無いと 1 リポジトリで 50 行が該当した）。
#   **代償は偽陰性で、後から `set -e` を足したときに壊れる経路を見逃す。** この検査の
#   弱点は最初から偽陰性の側にあるので、向きは揃っている。
#
#   生産側が単一の printf / echo の場合も外す。出力がパイプバッファに収まりきって
#   生産側が先に終わるため実害が無い。**生産側の判定は「パイプの直前のコマンド」で
#   行う。** 行頭だけを見ると `elif ! printf … | grep -q …` の形を取りこぼす
#   （実測: 行頭だけを見る実装は 1 リポジトリで 143 行の偽陽性を出した）。
#
# RULE: 規則表（1 行 = 正規表現と対処）
#
#   **踏んだ事故を書き足す場所である。** 表を増やすときは、必ず「代わりに何を書くか」
#   まで書くこと。指摘だけの検査は、直し方を探す時間を利用者へ押し付ける。
#
#   **1 つの規則へ複数の綴りをまとめるのは、対処が同じときに限る。** `sha256sum` と
#   `md5sum` を 1 行にまとめると、対処として書ける代替はどちらか一方になり、もう
#   一方の利用者は**指摘どおりに直すとハッシュ方式が変わる。** 検査が壊れた助言を
#   与えるのは、検査が無いより悪い（レビューの指摘で実際に踏んだ）。
#
#   規則は 1 行ずつ当てるだけで、引用の内外は区別しない。たとえば sed -i の規則は
#   `sed 's/ -i / X /' f` のように**プログラムの中に ` -i ` を含む形**も拾う。
#   引用を解析すれば避けられるが、規則表は綴りを 1 行足すだけで増やせることに価値が
#   あるので、構造解析は持ち込まない。誤検出はその行の `# bsd-ok: 理由` で黙らせる。
#
# ── 検査が成立していないことを合格にしない ──────────────────────────────────
#
#   git 管理外での実行、git コマンドの失敗、対象 0 件、awk 自体の失敗は、いずれも
#   「移植性を欠く綴りが無い」ことを意味しない。すべて失敗として扱う。
#   加えて、**起動時に検査機構そのものを自己診断する**（検出されるべき入力で必ず
#   当たること、されないべき入力で当たらないこと）。パターンの書き損じで「何も当たら
#   ない検査」になっていた場合、それは常に緑を返すため、赤にならない限り誰も気づけない。
#
# 使い方:
#   bash scripts/check-shell-portability.sh
#
# 終了コード:
#   0 = SHELL_PORTABILITY_PASS
#   1 = SHELL_PORTABILITY_FAIL（綴りの検出、または検査が成立しなかった）
set -euo pipefail

# 角括弧の範囲指定と正規表現の解釈をバイト順に固定する。
export LC_ALL=C

# 検査はプロジェクトルート基準で行う。scripts/ の 1 階層上がルート。
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$(dirname "$HERE")"

fail() {
  printf '[portability] %s\n' "$1" >&2
  echo "SHELL_PORTABILITY_FAIL"
  exit 1
}

WORK="$(mktemp -d "${TMPDIR:-/tmp}/shell-portability.XXXXXX")" \
  || { echo "[portability] 一時ディレクトリを作成できません。" >&2; echo "SHELL_PORTABILITY_FAIL"; exit 1; }
trap 'rm -rf "$WORK"' EXIT

RULES="$WORK/rules.tsv"
SCAN="$WORK/scan.awk"
TRACKED="$WORK/tracked.z"
REPORT="$WORK/report.tsv"
AWK_ERR="$WORK/awk.err"

# ── 規則表 ───────────────────────────────────────────────────────────────────
#
# 1 行 = `正規表現<TAB>対処<TAB>分岐とみなす綴り<TAB>この行自身の逃げ道`。
#
# **3 列目は「近くに BSD 側の綴りがあれば、分岐が完成しているとみなす」印である。**
# `stat -c %U "$1" 2>/dev/null || stat -f %Su "$1"` のように 1 行で両系統を書く形は、
# 可搬性のための正しい書き方であって、報告すると**動くコードの書き換えを迫る。**
#
# **見るのは前後 1 行までを含む。** 分岐は同じ行に収まるとは限らない。`for mode in \`
# の並びや `if command -v … ; then` の枝は**隣の行**に BSD 側が来るうえ、行継続の
# 途中には行コメントを書けないので、逃げ道の印で黙らせることもできない（実測で踏んだ）。
#
# 代償は偽陰性で、素の呼び出しの隣にたまたま BSD 側の綴りがあると見逃す。この検査の
# 弱点は最初から偽陰性の側にあるので、向きは揃っている。空なら判定しない。
#
# **3 列目の `# bsd-ok:` は飾りではない。** この表は検出したい綴りをリテラルで持つ
# ため、この検査が自分自身を走査したときに当たる。除外リストではなく逃げ道の印で
# 通すのが、この検査の方針である（冒頭「逃げ道」参照）。
cat > "$RULES" <<'RULES_EOF'
(^|[^[:alnum:]_.-])mktemp([[:space:]]+-[a-zA-Z-]+)*[[:space:]]*([)|;&`<>#]|$)	テンプレート引数の無い mktemp は BSD 系で usage エラーになる。mktemp -d "${TMPDIR:-/tmp}/name.XXXXXX" と書く		# bsd-ok: 規則表の綴りそのもの
date [^|;&]*%N	BSD の date に %N（ナノ秒）は無い。秒で足りるなら %s、要るなら別の手段を選ぶ		# bsd-ok: 規則表の綴りそのもの
sed [^|;&]*\\x[0-9A-Fa-f]	\xNN は GNU sed の拡張。BSD sed は文字 x として扱う。ESC="$(printf '\033')" のように作って渡す		# bsd-ok: 規則表の綴りそのもの
(^|[^[:alnum:]_.-])sed[[:space:]]+([^|;&]*[[:space:]])?-i([[:space:]]|\.|$)	sed -i の引数の扱いが GNU と BSD で違う（BSD は直後の引数をバックアップ拡張子と解釈する）。一時ファイルへ書いて mv する		# bsd-ok: 規則表の綴りそのもの
(^|[^[:alnum:]_.-])grep [^|;&]*(-P|--perl-regexp)	BSD の grep に -P は無い。-E で書き直す		# bsd-ok: 規則表の綴りそのもの
readlink +-f	BSD の readlink に -f は無い。cd と pwd で解決する		# bsd-ok: 規則表の綴りそのもの
base64 [^|;&]*-w	BSD の base64 に -w は無い。折り返しが要るなら fold へ渡す		# bsd-ok: 規則表の綴りそのもの
find [^|;&]*-printf	BSD の find に -printf は無い。-exec か -print と組み合わせる		# bsd-ok: 規則表の綴りそのもの
xargs [^|;&]*-r	BSD の xargs に -r は無い（空入力でも実行しない挙動が既定）		# bsd-ok: 規則表の綴りそのもの
(head|tail) +-n +-[0-9]	負の行数は GNU 拡張。BSD には無い		# bsd-ok: 規則表の綴りそのもの
(^|[^-[:alnum:]_/])tac( |$)	BSD 系には tac が無い。tail -r か awk で代用する		# bsd-ok: 規則表の綴りそのもの
(^|[^-[:alnum:]_])sha256sum	BSD 系に sha256sum は無い。shasum -a 256 か openssl dgst -sha256 への分岐を書く	shasum|openssl[[:space:]]+dgst	# bsd-ok: 規則表の綴りそのもの
(^|[^-[:alnum:]_])md5sum	BSD 系に md5sum は無い（macOS は md5）。md5 か openssl dgst -md5 への分岐を書く。**sha256 系へ置き換えないこと。ハッシュ方式が変わる**	(^|[^-[:alnum:]_])md5([^-[:alnum:]_]|$)|openssl[[:space:]]+dgst[^|;&]*-md5	# bsd-ok: 規則表の綴りそのもの
stat[[:space:]]+-c	BSD の stat は -f である。両方へ分岐するか、別の手段を選ぶ	stat[[:space:]]+-f	# bsd-ok: 規則表の綴りそのもの
IGNORECASE[[:space:]]*=	IGNORECASE は gawk の拡張。mawk と BSD awk は黙って無視するので、大小の違う入力に一致しなくなる。tolower($0) ~ /.../ と書く		# bsd-ok: 規則表の綴りそのもの
RULES_EOF

# 規則表に `grep -P` の規則がある以上、この表自身も `stat -c` や `sha256sum` と同じく
# 「当たるが分岐がある」場合がありうる。そのときは該当行へ `# bsd-ok: 理由` を書く。

cat > "$SCAN" <<'SCAN_EOF'
# scan.awk — 1 ファイルを 2 度読み、移植性の欠陥を報告する。
#
# 1 度目（NR == FNR）: set -e / pipefail の宣言を拾う。2 度目: 本走査。
# 同じファイルを 2 引数で渡して実現する（1 行ずつ読む awk で「ファイル全体の性質」を
# 先に知るための定石。ファイルごとに grep を起こすより安い）。
#
# -v で受ける変数:
#   rulesfile  … 規則表（正規表現 <TAB> 対処）
#   mode       … sh / md
#
# 出力:
#   欠陥     パス <TAB> KIND <TAB> 行番号 <TAB> 対処 <TAB> 該当行
#   統計     #STATS <TAB> 逃げ道の印の件数 <TAB> 走査した行数
#
# パスは環境変数 PORTABILITY_PATH で受ける。**-v で渡すとエスケープが解釈され、
# `\t` を含むパスが壊れる。** 呼び出し側で sed の置換文字列へ埋めるのも不可で、
# `|` や `&` を含むパスで sed 自体がエラーになり、検査が判定を出さずに落ちる
# （実測で踏んだ）。

function is_comment(s) { return s ~ /^[[:space:]]*#/ }

# 逃げ道の印。理由が空のものは認めない（印だけ付けて黙らせる形を残さない）。
function has_bsd_ok(s) { return s ~ /#[[:space:]]*bsd-ok:[[:space:]]*[^[:space:]]/ }

# フェンスの印（バッククォートかチルダ）。CommonMark はどちらも認め、**互いに閉じ
# 合わない。** チルダを見ないと、`~~~bash` で囲んだコードが丸ごと走査から外れる
# （配布先で起きる偽陰性）。
function fence_char(s,   t, c) {
  t = s
  sub(/^[[:space:]]*/, "", t)
  c = substr(t, 1, 1)
  return (c == "`" || c == "~") ? c : ""
}

function fence_len(s, ch,   n) {
  sub(/^[[:space:]]*/, "", s)
  n = 0
  while (substr(s, n + 1, 1) == ch) n++
  return n
}

# 閉じのフェンスは、印の連なりだけで言語指定を持たない行に限る。
function fence_only(s, ch,   t) {
  t = s
  sub(/^[[:space:]]*/, "", t)
  while (substr(t, 1, 1) == ch) t = substr(t, 2)
  return t ~ /^[[:space:]]*$/
}

# prefix に cmd のトークンがあるか。名前の一部（gawk の awk など）を拾わないよう
# 左境界を必須にする。
function has_cmd(prefix, cmd) {
  return prefix ~ ("(^|[^[:alnum:]_.-])" cmd "([[:space:]]|$)")
}

# prefix のうち、最後のコマンド区切りより後ろだけを返す。
#
# prefix 全体を見ると、同一行で連結した別コマンドまで持ち主を引き継ぐ。
# `sed 's/a/b/' | grep 'x\ty'` の grep の引数が sed のプログラムとして誤検知され、
# `awk 'x' | sed 'y'` の sed は awk と誤判定される。区切りの後ろだけを見れば、
# いま開いた引用がどのコマンドのものかが決まる。
#
# 区切りが引用の中にある場合は切り出しがずれるが、ずれた結果は持ち主が空になる
# 方向なので、誤検知ではなく検出漏れになる。
function last_segment(prefix,   i, c, cut) {
  cut = 0
  for (i = 1; i <= length(prefix); i++) {
    c = substr(prefix, i, 1)
    if (c == "|" || c == ";" || c == "&" || c == "(" || c == "`" || c == "{") cut = i
  }
  return substr(prefix, cut + 1)
}

# sed のプログラム text の中に、ブラケット式の中の `\t` があるか。
#
# 文字クラス（[:space:] など）はブラケット式の中に [ と ] を持つ。素朴に数えると
# 閉じを取り違え、`[[:space:]\t]` の `\t` を外側と誤認して見落とす。`[:` を見つけたら
# `:]` まで飛ばす。
#
# 制限: 置換側の `[` も開きとして数える。`s/x/[\t]/` のような形は誤検知になる。
# s/// の構造まで解析していない。この形が出たときに構造解析を足す方が安い。
# t の start 位置から、エスケープされていない区切り文字 d の位置を返す。無ければ 0。
function sed_delim(t, start, d,   n, i) {
  n = length(t)
  i = start
  while (i <= n) {
    if (substr(t, i, 1) == "\\") { i += 2; continue }
    if (substr(t, i, 1) == d) return i
    i++
  }
  return 0
}

# sed のプログラムから、**ブラケット式として解釈される部分だけ**を取り出す。
#
#   - アドレスの正規表現（`/re/`）
#   - `s` コマンドのパターン側（`s/pat/repl/flags` の pat）
#
# **置換側（repl）と `y` コマンドは含めない。そこにブラケット式は存在しない。**
# `[` と `]` はリテラルの文字であり、「ブラケット式の中の `\t` / `\n`」という判定が
# そもそも成り立たない。プログラム全体へ当てると `sed 's/x/[\n]/' f` を報告する
# （実測。レビューで指摘された）。
#
# **これは移植性の実測ではなく、構造上の理由である。** 置換側の `\n` が両プラット
# フォームで改行になることは別途記録済みだが、仮にそうでなくても、置換側に
# ブラケット式は無い。
#
# **限界: 区切り文字がブラケット式の中に現れる形（`s/[/]/x/`）は取りこぼす。**
# 区切りを数える側がブラケットを見ないため、パターンが途中で切れる。POSIX は
# ブラケット式の中の区切り文字をリテラルとして扱うので、この形は正しい sed である。
# 取りこぼす（偽陰性）側に倒しており、正しいコードを赤くはしない。
function sed_regex_parts(t,   n, i, c, out, d, j, k) {
  n = length(t)
  i = 1
  out = ""
  while (i <= n) {
    c = substr(t, i, 1)
    if (c == "\\") { i += 2; continue }
    if (c == "/") {
      j = sed_delim(t, i + 1, "/")
      if (j > 0) {
        out = out substr(t, i + 1, j - i - 1) "\n"
        i = j + 1
        continue
      }
      i++
      continue
    }
    if (c == "s" || c == "y") {
      d = substr(t, i + 1, 1)
      # **区切りにはバックスラッシュと改行以外のどの文字も使える**（POSIX）。英数字や
      # 空白も有効で、`sed 's1^[^\n]*1x1'` は正しい sed である（実測: GNU sed で通る）。
      # 当初これを弾いていたため、その形のパターン側を取りこぼしていた（レビューの指摘）。
      #
      # **改行はここへ現れないので判定しない。** `sed_text` は scan() の冒頭で作り直され、
      # scan() は物理行ごとに呼ばれる。複数行にまたがる sed スクリプトでも、1 行ずつ
      # 別々に走査されるため、区切り位置に改行が来ることがない。
      #
      # **バックスラッシュを弾く分岐に、当たる見本は無い。** `s` の直後が `\\` になる
      # 正しい sed が存在しない（`s\\...` は unterminated で落ちる）ため、この条件を
      # 外す変異は自己診断で赤にならない。POSIX の規定に合わせた保険として残す。
      if (d != "" && d != "\\") {
        j = sed_delim(t, i + 2, d)
        if (j > 0) {
          # y は文字の対応表で、正規表現ではない。取り出さない。
          if (c == "s") out = out substr(t, i + 2, j - i - 2) "\n"
          k = sed_delim(t, j + 1, d)
          i = (k > 0) ? k + 1 : j + 1
          continue
        }
      }
      i++
      continue
    }
    i++
  }
  return out
}

# ブラケット式の中に `\<ch>` があるか。ch は "t"（タブ）/ "n"（改行）のように、
# 書き手が特殊文字を意図して書いたのに、ブラケットの中では失われるエスケープの 1 文字。
function bracket_escape(t, ch,   n, i, c, inb, j) {
  n = length(t)
  i = 1
  inb = 0
  while (i <= n) {
    c = substr(t, i, 1)
    if (!inb) {
      if (c == "\\") { i += 2; continue }
      if (c == "[") {
        inb = 1
        i++
        # `[^` の ^ と、その直後の ] はリテラルで、閉じではない。
        if (substr(t, i, 1) == "^") i++
        if (substr(t, i, 1) == "]") i++
        continue
      }
      i++
      continue
    }
    # ブラケットの中。ここでは \ はリテラルなので、次の 1 文字を飛ばさない。
    if (c == "[" && substr(t, i + 1, 1) == ":") {
      j = index(substr(t, i), ":]")
      if (j > 0) { i = i + j + 1; continue }
    }
    if (c == "]") { inb = 0; i++; continue }
    if (c == "\\" && substr(t, i + 1, 1) == ch) return 1
    i++
  }
  return 0
}

# awk のプログラム本文から、**正規表現として解釈される部分だけ**を取り出す。
#
#   - `/…/` のリテラル
#   - `~` / `!~` の右辺の文字列リテラル
#
# プログラム全体へ当てると、正規表現でない文字列まで報告する（実測: `awk 'BEGIN
# { print "{2,3}" }'` が AWK_INTERVAL になった。Copilot の指摘）。**正常なコードへ
# 逃げ道の印や書き換えを強いる検査は、検査が無いより悪い。**
#
# **取り出せない形は対象外にする。** 文字列を変数へ入れてから `~` で使う形
# （`BEGIN { p = "a{2,5}" } $0 ~ p`）は、文字列が正規表現として使われるかを構文だけ
# では決められない。**この検査の弱点は偽陰性の側に置く**（規則表の方針と同じ向き）。
function awk_regex_parts(t,   n, i, c, out, j, k, q) {
  n = length(t)
  i = 1
  out = ""
  while (i <= n) {
    c = substr(t, i, 1)
    if (c == "\\") { i += 2; continue }
    if (c == "/") {
      j = i + 1
      while (j <= n) {
        if (substr(t, j, 1) == "\\") { j += 2; continue }
        if (substr(t, j, 1) == "/") break
        j++
      }
      if (j <= n) {
        out = out substr(t, i + 1, j - i - 1) "\n"
        i = j + 1
        continue
      }
      i++
      continue
    }
    if (c == "~") {
      j = i + 1
      while (j <= n && substr(t, j, 1) == " ") j++
      q = substr(t, j, 1)
      if (q == "\"") {
        k = j + 1
        while (k <= n) {
          if (substr(t, k, 1) == "\\") { k += 2; continue }
          if (substr(t, k, 1) == "\"") break
          k++
        }
        if (k <= n) {
          out = out substr(t, j + 1, k - j - 1) "\n"
          i = k + 1
          continue
        }
      }
      i++
      continue
    }
    i++
  }
  return out
}

# awk の引数の中に、下限 2 以上の間隔指定があるか。
#
# **この判定に間隔指定を使わない。** 検出したい綴りそのものであり、mawk の下で書けば
# 静かに狭くなる。`+` と `*` だけで書き、下限は数値として取り出して比べる。
#
# awk の動作ブロック `{ print }` は数字とカンマを持たないため当たらない。
function awk_interval(t,   rest, spec, lo) {
  rest = t
  while (match(rest, /\{[0-9]+,[0-9]*\}/)) {
    spec = substr(rest, RSTART + 1, RLENGTH - 2)
    lo = spec
    sub(/,.*$/, "", lo)
    if (lo + 0 >= 2) return 1
    rest = substr(rest, RSTART + RLENGTH)
  }
  return 0
}

# 固定文字列検索の grep か。`-F` / `--fixed-strings` ではブラケットが正規表現として
# 解釈されないため、`[^\\n]` を書いても意図どおりの可搬な呼び出しである（Copilot の指摘）。
function grep_fixed(prefix) {
  if (prefix ~ /--fixed-strings/) return 1
  return prefix ~ /(^|[[:space:]])-[A-Za-z]*F[A-Za-z]*([[:space:]]|$)/
}

function grep_z_flag(s) {
  if (s !~ /(^|[^[:alnum:]_.-])grep([[:space:]]|$)/) return 0
  return s ~ /(^|[[:space:]])-[A-Za-z]*Z[A-Za-z]*([[:space:]]|$)/
}

# 先頭の制御構文キーワード・否定・変数代入を取り除く。
# `elif ! printf …` の printf を生産側として見つけるために要る。
function strip_keywords(seg) {
  sub(/^[[:space:]]+/, "", seg)
  while (1) {
    if (seg ~ /^(if|elif|while|until|then|do|else)[[:space:]]+/) {
      sub(/^[A-Za-z]+[[:space:]]+/, "", seg)
      continue
    }
    if (seg ~ /^[!{][[:space:]]*/ && seg ~ /^[!{]/) {
      sub(/^[!{][[:space:]]*/, "", seg)
      continue
    }
    if (seg ~ /^[A-Za-z_][A-Za-z0-9_]*=[^[:space:]]*[[:space:]]+/) {
      sub(/^[A-Za-z_][A-Za-z0-9_]*=[^[:space:]]*[[:space:]]+/, "", seg)
      continue
    }
    break
  }
  return seg
}

function first_word(seg) {
  seg = strip_keywords(seg)
  if (match(seg, /^[^[:space:]]+/)) return substr(seg, 1, RLENGTH)
  return ""
}

# 生産側が単一行に収まると分かっている形か（冒頭 PIPEFAIL_SIGPIPE 参照）。
function safe_producer(seg,   w) {
  w = first_word(seg)
  return (w == "printf" || w == "echo")
}

# ctx が条件文脈で始まるか。終了コードが読まれるかの判定に使う。
function conditional_ctx(ctx) {
  sub(/^[[:space:]]+/, "", ctx)
  if (ctx ~ /^!/) return 1
  return ctx ~ /^(if|elif|while|until)[[:space:]]/
}

# s の位置 p から始まるパイプの消費側が、早期に終了する形か。
function early_consumer(s, p) {
  return substr(s, p) ~ /^\|[[:space:]]*(grep[[:space:]]+-[A-Za-z]*q[A-Za-z]*|head([[:space:]]|$))/
}

# 1 行を走査して、次のグローバルを埋める。
#   sed_text      … sed のプログラムとして渡された文字列
#   npipes        … パイプの数
#   pipe_pos[k]   … パイプの位置
#   pipe_cond[k]  … そのパイプを囲むコマンド置換が、条件文脈の中にあるか
#   pipe_seg[k]   … 生産側コマンドの開始位置
#
# 引用の中へは入らない（シェルの語彙で追う）。コマンド置換は二重引用の中でも開く
# ので、状態を退避して中を素の文脈として読む。
#
# carry が真なら、前の物理行から状態を引き継ぐ。**行末の `\` で続く論理行を 1 行ずつ
# 独立に読むと、前の行で開いたコマンド置換が見えない。** 続きの行のパイプが「置換の
# 外にある」と誤判定され、終了コードを誰も読まない代入が赤くなる（実測で 4 件踏んだ）。
#
# 条件文脈かどうかを位置ではなくフラグで覚えるのも同じ理由である。位置は行をまたぐと
# 意味を失う。
# 引用の中の 1 片を、いま追っているコマンドの引数へ足す。持ち主ごとに別の変数へ
# 溜めるのは、判定を持ち主で絞るためである（awk の間隔指定は awk の引数だけを見る）。
function accum(piece) {
  if (owner == "sed") sed_text = sed_text piece
  else if (owner == "awk") awk_text = awk_text piece
  else if (owner == "awkv") awk_v_text = awk_v_text piece
  else if (owner == "grep") grep_text = grep_text piece
}

function scan(s, carry,   n, i, c) {
  sed_text = ""
  awk_text = ""
  awk_v_text = ""
  grep_text = ""
  npipes = 0
  if (!carry) {
    state = "OUT"
    owner = ""
    depth = 0
    outer_cond = 0
  }
  stmt_start = 1
  n = length(s)
  i = 1
  while (i <= n) {
    c = substr(s, i, 1)

    if (state == "SQ") {
      # 単一引用の中にエスケープもコマンド置換も無い。次の ' が必ず閉じ。
      if (c == "'") { state = "OUT"; owner = ""; i++; continue }
      accum(c)
      i++
      continue
    }

    if (state == "DQ") {
      if (c == "\\") {
        accum(substr(s, i, 2))
        i += 2
        continue
      }
      if (c == "$" && substr(s, i + 1, 1) == "(") {
        depth++
        save_state[depth] = "DQ"
        save_owner[depth] = owner
        save_stmt[depth] = stmt_start
        if (depth == 1) outer_cond = conditional_ctx(substr(s, stmt_start))
        state = "OUT"
        owner = ""
        stmt_start = i + 2
        i += 2
        continue
      }
      if (c == "\"") { state = "OUT"; owner = ""; i++; continue }
      accum(c)
      i++
      continue
    }

    # state == "OUT"
    # 引用の外の # 以降は行末までシェルのコメント。引用状態の追跡へ入れない
    # （`# don't` のような行で領域が開いたことになり、以降がずれ続ける）。
    if (c == "#" && (i == 1 || substr(s, i - 1, 1) ~ /[[:space:]]/)) break
    if (c == "\\") { i += 2; continue }
    if (c == "$" && substr(s, i + 1, 1) == "(") {
      depth++
      save_state[depth] = "OUT"
      save_owner[depth] = owner
      save_stmt[depth] = stmt_start
      if (depth == 1) outer_cond = conditional_ctx(substr(s, stmt_start))
      stmt_start = i + 2
      i += 2
      continue
    }
    # 素の `(` も深さとして数える。プロセス置換 `<( … )` と部分シェルの閉じ括弧が
    # 外側のコマンド置換を閉じたことにすると、`$(diff <(…) <(…) | head -10)` の
    # パイプが「コマンド置換の外」と誤判定される（実測で踏んだ）。
    if (c == "(") {
      depth++
      save_state[depth] = "OUT"
      save_owner[depth] = owner
      save_stmt[depth] = stmt_start
      if (depth == 1) outer_cond = conditional_ctx(substr(s, stmt_start))
      stmt_start = i + 1
      i++
      continue
    }
    if (c == ")") {
      if (depth > 0) {
        state = save_state[depth]
        owner = save_owner[depth]
        stmt_start = save_stmt[depth]
        depth--
      }
      i++
      continue
    }
    if (c == ";") { stmt_start = i + 1; i++; continue }
    if (c == "&" && substr(s, i + 1, 1) == "&") { stmt_start = i + 2; i += 2; continue }
    if (c == "|" && substr(s, i + 1, 1) == "|") { stmt_start = i + 2; i += 2; continue }
    if (c == "|") {
      npipes++
      pipe_pos[npipes] = i
      pipe_cond[npipes] = (depth == 0) ? 1 : outer_cond
      pipe_seg[npipes] = stmt_start
      stmt_start = i + 1
      i++
      continue
    }
    if (c == "'" || c == "\"") {
      prefix = last_segment(substr(s, 1, i - 1))
      # awk のプログラムは検査対象が無いが、持ち主として区別しておく。空にすると
      # sed の直後に awk が続く行で領域を sed とみなしうる。
      if (has_cmd(prefix, "awk")) {
        # `-v name=` の右辺は、それ自体が正規表現として使われうる。プログラム本文とは
        # 別に溜める（本文は /…/ と ~ の右辺だけを見るため、同じ扱いにできない）。
        owner = (prefix ~ /-v[[:space:]]*[A-Za-z_][A-Za-z0-9_]*=[[:space:]]*$/) ? "awkv" : "awk"
      }
      else if (has_cmd(prefix, "sed")) owner = "sed"
      else if (has_cmd(prefix, "grep")) owner = grep_fixed(prefix) ? "" : "grep"
      else owner = ""
      state = (c == "'") ? "SQ" : "DQ"
    }
    i++
  }
}

# 行末が（エスケープされていない）バックスラッシュで終わるか。奇数個なら継続。
function continues(s,   i, n) {
  n = 0
  i = length(s)
  while (i >= 1 && substr(s, i, 1) == "\\") { n++; i-- }
  return (n % 2) == 1
}

function report(kind, lineno, message, line) {
  printf "%s\t%s\t%d\t%s\t%s\n", ENVIRON["PORTABILITY_PATH"], kind, lineno, message, line
}

BEGIN {
  nrules = 0
  while ((getline ln < rulesfile) > 0) {
    if (ln ~ /^[[:space:]]*$/) continue
    tab = index(ln, "\t")
    if (tab == 0) continue
    rule_re[++nrules] = substr(ln, 1, tab - 1)
    rest = substr(ln, tab + 1)
    tab2 = index(rest, "\t")
    rule_msg[nrules] = (tab2 > 0) ? substr(rest, 1, tab2 - 1) : rest
    rule_branch[nrules] = ""
    if (tab2 > 0) {
      rest = substr(rest, tab2 + 1)
      tab3 = index(rest, "\t")
      rule_branch[nrules] = (tab3 > 0) ? substr(rest, 1, tab3 - 1) : rest
    }
  }
  close(rulesfile)
  skipped = 0
  scanned = 0
  inside = 0
  cont = 0
}

# ── 1 度目: ファイル全体の性質を拾う ────────────────────────────────────────
NR == FNR {
  src[FNR] = $0
  sub(/\r$/, "", src[FNR])
  nsrc = FNR
  if ($0 ~ /^[[:space:]]*set[[:space:]]/ && $0 ~ /pipefail/) has_pipefail = 1
  next
}

# 前後 1 行までのどこかに、分岐とみなす綴りがあるか。
function branch_near(re, n) {
  if (src[n] ~ re) return 1
  if (n > 1 && src[n - 1] ~ re) return 1
  if (n < nsrc && src[n + 1] ~ re) return 1
  return 0
}

# ── 2 度目: 本走査 ──────────────────────────────────────────────────────────
{
  line = $0
  sub(/\r$/, "", line)

  if (mode == "md") {
    # フェンスの開閉は単純な反転で判定しない。文書では「コードブロックの書き方」を
    # 示すためにフェンスを入れ子にすることがあり（外側を 4 個以上で囲む）、反転だと
    # 内側の開始で外へ出たことになる。以降の内外がずれ続け、コード内の綴りを見落とし、
    # 地の文を誤検出する。開いたときの長さを覚え、それ以上の長さで、かつ言語指定を
    # 持たない行だけを閉じとして扱う（CommonMark のフェンス規則）。
    fc = fence_char(line)
    fl = (fc == "") ? 0 : fence_len(line, fc)
    if (fl >= 3) {
      if (!inside) { inside = 1; open_len = fl; open_char = fc; next }
      if (fc == open_char && fl >= open_len && fence_only(line, fc)) { inside = 0; next }
      next
    }
    if (!inside) next
  }

  scanned++

  # 継続の判定は、行を読み飛ばす前に済ませる。飛ばした行でも論理行は続いている。
  carry = cont
  cont = continues(line)

  if (is_comment(line)) next
  if (has_bsd_ok(line)) { skipped++; next }

  # **存在確認は逃げ道そのものである。** `command -v foo` は「foo があるか」を見る
  # 書き方で、可搬性のための分岐を書く唯一の手段である。呼び出しではない。
  # 規則表に依らない一般の除外なので、ここで落とす。
  if (line ~ /(^|[^[:alnum:]_.-])command[[:space:]]+-v([[:space:]]|$)/) next

  scan(line, carry)

  if (bracket_escape(sed_regex_parts(sed_text), "t"))
    report("SED_BRACKET_TAB", FNR, "ブラケット式の中の \\t は BSD 系の sed でタブにならない。[[:space:]] を使うか、タブを変数へ作って渡す", line)

  if (bracket_escape(sed_regex_parts(sed_text), "n") || bracket_escape(awk_regex_parts(awk_text), "n") || bracket_escape(awk_v_text, "n") || bracket_escape(grep_text, "n"))
    report("BRACKET_BACKSLASH_N", FNR, "ブラケット式の中の \\n は改行にならない（バックスラッシュと n の集合になり、n を含む行を落とす）。行を絞ってから固定文字列で判定するか、意図する集合を明示する", line)

  if (awk_interval(awk_regex_parts(awk_text)) || awk_interval(awk_v_text))
    report("AWK_INTERVAL", FNR, "下限 2 以上の間隔指定は mawk が下限ちょうどにしか一致させない。回数を列挙するか、grep -E へ渡す。下限 1 の形は影響しない", line)

  if (grep_z_flag(line))
    report("GREP_DASH_Z_FLAG", FNR, "grep -Z は GNU 拡張で BSD 系には無い。1 ファイルずつ走査するか、別の手段で NUL 区切りを作る", line)  # bsd-ok: 報告文が検出対象の綴りそのものを持つ

  for (r = 1; r <= nrules; r++) {
    if (line !~ rule_re[r]) continue
    # 近く（前後 1 行まで）に BSD 側の綴りがあれば、分岐が完成しているとみなす。
    if (rule_branch[r] != "" && branch_near(rule_branch[r], FNR)) continue
    report("RULE", FNR, rule_msg[r], line)
  }

  if (has_pipefail) {
    for (k = 1; k <= npipes; k++) {
      if (!early_consumer(line, pipe_pos[k])) continue
      # 既存の `|| true` / `|| :` は意図的なガード。対象から外す。
      if (line ~ /\|\|[[:space:]]*(true|:)([[:space:]]|;|$)/) continue
      if (safe_producer(substr(line, pipe_seg[k], pipe_pos[k] - pipe_seg[k]))) continue
      # コマンド置換の中は、囲む文が条件文脈のときだけ報告する（冒頭参照）。
      if (!pipe_cond[k]) continue
      report("PIPEFAIL_SIGPIPE", FNR, "pipefail 下で早期終了する消費側へパイプしている。生産側が SIGPIPE で死ぬと判定が反転する。-print -quit や sed -n 1p のようにパイプを読み切る形へ直す", line)
    }
  }
}

END { printf "#STATS\t%d\t%d\n", skipped, scanned }
SCAN_EOF

# ── 自己診断 ─────────────────────────────────────────────────────────────────
#
# 両方向を見る。当たること（偽陰性＝常に緑になる壊れ方）と、当たらないこと（偽陽性）。
#
# **見本はこの行の外へ書けない。** 検出したい綴りそのものなので、ファイルへ書くと
# この検査が自分自身を拾う。見本は printf の引数として組み立て、**印はシェルの行
# コメントとして置く**（印が見本の中へ入ると、自己診断が逃げ道で素通りしてしまう）。
SELFTEST="$WORK/selftest"
mkdir -p "$SELFTEST"

# **`--` を渡さない。** BSD 系の awk が `--` を「オプションの終わり」として扱うか
# どうかを、この環境では確かめられない。扱わなければ `--` という名前のファイルを
# 開こうとして、配布先の macOS で自己診断が起動できずに落ちる。`--` の目的は
# オプションと紛れる名前を守ることなので、**絶対パスや `./` 前置で同じ目的を満たす。**
selftest_scan() {
  PORTABILITY_PATH="$2" awk -v rulesfile="$RULES" -v mode="$1" -f "$SCAN" "$2" "$2" 2>&1 \
    | sed '/^#STATS/d'
}

# 当たるべき見本（KIND<TAB>本文）。
# shellcheck disable=SC2016  # 見本の $ はリテラル。展開させると見本にならない
{
  printf 'SED_BRACKET_TAB\t%s\n' "sed -n 's/^[ \t]*x//p' f"                       # bsd-ok: 自己診断の見本
  printf 'SED_BRACKET_TAB\t%s\n' "sed -n 's/^[[:space:]\t]*x//p' f"               # bsd-ok: 自己診断の見本
  printf 'SED_BRACKET_TAB\t%s\n' "sed -n '/^[ \t]*x/p' f"                          # bsd-ok: 自己診断の見本
  printf 'BRACKET_BACKSLASH_N\t%s\n' "sed 's|^[^\\n]*x||' f"                       # bsd-ok: 自己診断の見本
  printf 'BRACKET_BACKSLASH_N\t%s\n' "sed 's1^[^\\n]*x1y1' f"                       # bsd-ok: 自己診断の見本
  printf 'SED_BRACKET_TAB\t%s\n' "sed 'sX^[ \t]*xXyX' f"                          # bsd-ok: 自己診断の見本
  printf 'GREP_DASH_Z_FLAG\t%s\n' 'xargs -0 grep -l -Z -a -f "$P" -- < "$T"'      # bsd-ok: 自己診断の見本
  printf 'GREP_DASH_Z_FLAG\t%s\n' 'grep -lZa -f pattern.txt -- "$path"'           # bsd-ok: 自己診断の見本
  printf 'RULE\t%s\n' 'd="$(mktemp -d)"'                                          # bsd-ok: 自己診断の見本
  printf 'RULE\t%s\n' 'readlink -f "$path"'                                       # bsd-ok: 自己診断の見本
  printf 'RULE\t%s\n' "sed -i 's/a/b/' f"                                        # bsd-ok: 自己診断の見本
  printf 'RULE\t%s\n' 'sed -i.bak s/a/b/ f'                                      # bsd-ok: 自己診断の見本
  printf 'RULE\t%s\n' 'stamp="$(date +%s%N)"'                                     # bsd-ok: 自己診断の見本
  printf 'AWK_INTERVAL\t%s\n' "awk '/^x{2,3}\$/ { print }' f"                       # bsd-ok: 自己診断の見本
  printf 'AWK_INTERVAL\t%s\n' "awk -v p=\"a{3,}\" '\$0 ~ p' f"                        # bsd-ok: 自己診断の見本
  printf 'AWK_INTERVAL\t%s\n' "awk '\$0 ~ \"a{3,}\"' f"                                 # bsd-ok: 自己診断の見本
  printf 'BRACKET_BACKSLASH_N\t%s\n' "grep -E 'A[^\\n]*B' f"                          # bsd-ok: 自己診断の見本
  printf 'BRACKET_BACKSLASH_N\t%s\n' "awk '/[^\\n]/ { print }' f"                      # bsd-ok: 自己診断の見本
  printf 'BRACKET_BACKSLASH_N\t%s\n' "sed -n 's/^[^\\n]*x//p' f"                       # bsd-ok: 自己診断の見本
  printf 'PIPEFAIL_SIGPIPE\t%s\n' 'if ! find . -name "*.md" | grep -q .; then :; fi'  # bsd-ok: 自己診断の見本
  printf 'PIPEFAIL_SIGPIPE\t%s\n' 'first="$(find . -type d | head -n 1)"; if ! v="$(find . | head -n 1)"; then :; fi'  # bsd-ok: 自己診断の見本
} > "$SELFTEST/must-hit.tsv"

# 当たってはいけない見本（本文のみ）。
# shellcheck disable=SC2016  # 見本の $ はリテラル。展開させると見本にならない
{
  printf '%s\n' "sed 's/\t/X/' f"                                                 # bsd-ok: 自己診断の見本
  printf '%s\n' "sed 's/x/a\nb/' f"                                               # bsd-ok: 自己診断の見本
  printf '%s\n' "sed 's/x/[\\n]/' f"                                              # bsd-ok: 自己診断の見本
  printf '%s\n' "sed 's/x/[\\t]/' f"                                              # bsd-ok: 自己診断の見本
  printf '%s\n' "sed 'y/ab/[\\n]/' f"                                             # bsd-ok: 自己診断の見本
  printf '%s\n' "sed 'y/[\\n]/xyz/' f"                                            # bsd-ok: 自己診断の見本
  printf '%s\n' "awk '/^x{1,3}\$/ { print }' f"                                   # bsd-ok: 自己診断の見本
  printf '%s\n' "grep -oE 'x{2,3}' f"                                             # bsd-ok: 自己診断の見本
  printf '%s\n' "grep -F '[^\\n]' f"                                               # bsd-ok: 自己診断の見本
  printf '%s\n' "grep --fixed-strings '[^\\n]' f"                                   # bsd-ok: 自己診断の見本
  printf '%s\n' "awk 'BEGIN { print \"{2,3}\" }' f"                                  # bsd-ok: 自己診断の見本
  printf '%s\n' "awk 'BEGIN { print \"[^\\n]\" }' f"                                 # bsd-ok: 自己診断の見本
  printf '%s\n' "awk '{ print \$1 }' f | grep -E 'x{2,3}'"                         # bsd-ok: 自己診断の見本
  printf '%s\n' "if [[ \"\${t:0:1}\" == \$'\\n' ]]; then :; fi"                      # bsd-ok: 自己診断の見本
  printf '%s\n' "printf '%s\\n' \"\$v\""                                            # bsd-ok: 自己診断の見本
  printf '%s\n' 'grep -z -f pattern.txt -- "$path"'                               # bsd-ok: 自己診断の見本
  printf '%s\n' 'sed -E "s/a/b/" f'                                              # bsd-ok: 自己診断の見本
  printf '%s\n' "sed -n 's/^- //p' f"                                            # bsd-ok: 自己診断の見本
  printf '%s\n' "sed 's/x1/y/' f"                                                # bsd-ok: 自己診断の見本
  printf '%s\n' 'grep --null -f pattern.txt -- "$path"'                           # bsd-ok: 自己診断の見本
  printf '%s\n' 'some-other-tool -Z "$path"'                                      # bsd-ok: 自己診断の見本
  printf '%s\n' 'd="$(mktemp -d "${TMPDIR:-/tmp}/x.XXXXXX")"'                      # bsd-ok: 自己診断の見本
  printf '%s\n' 'run_with_mktemp;'                                                # bsd-ok: 自己診断の見本
  printf '%s\n' 'if printf "%s" "$k" | grep -qi secret; then :; fi'               # bsd-ok: 自己診断の見本
  printf '%s\n' 'elif ! printf "%s" "$out" | grep -q PASS; then :'                # bsd-ok: 自己診断の見本
  printf '%s\n' 'if [ -n "$n" ] && ! printf "%s" "$o" | grep -qF "$n"; then :; fi' # bsd-ok: 自己診断の見本
  printf '%s\n' 'v="$(grep -n x f | head -n 1 | cut -d: -f1)"'                     # bsd-ok: 自己診断の見本
  printf '%s\n' 'if grep -q uv "$dc"; then fail "x: $(grep -n uv "$dc" | head -1)"; fi'  # bsd-ok: 自己診断の見本
  printf '%s\n' 'first="$(find . -type d | head -n 1 || true)"'                    # bsd-ok: 自己診断の見本
  printf '%s\n' 'if [ -z "$(find . -name "*.md" -print -quit)" ]; then :; fi'      # bsd-ok: 自己診断の見本
  printf '%s\n' 'if git ls-remote origin | grep refs/tags/v1 >/dev/null; then :; fi'  # bsd-ok: 自己診断の見本
} > "$SELFTEST/must-miss.txt"

# 当たるべき見本を 1 件ずつ走査する。KIND が一致しなければ検査が成立していない。
selftest_index=0
while IFS="$(printf '\t')" read -r want body; do
  [ -n "$want" ] || continue
  selftest_index=$((selftest_index + 1))
  sample="$SELFTEST/hit-$selftest_index.sh"
  printf 'set -euo pipefail\n%s\n' "$body" > "$sample"
  got="$(selftest_scan sh "$sample" | cut -f2 | sort -u | tr '\n' ' ')"
  case " $got " in
    *" $want "*) : ;;
    *) fail "自己診断に失敗しました: 「$body」から $want を検出できません（得た種別: ${got:-なし}）。検査が成立していないため失敗させます。" ;;
  esac
done < "$SELFTEST/must-hit.tsv"

while IFS= read -r body; do
  [ -n "$body" ] || continue
  selftest_index=$((selftest_index + 1))
  sample="$SELFTEST/miss-$selftest_index.sh"
  printf 'set -euo pipefail\n%s\n' "$body" > "$sample"
  got="$(selftest_scan sh "$sample")"
  if [ -n "$got" ]; then
    fail "自己診断に失敗しました: 「$body」を誤検出します（$got）。検査が成立していないため失敗させます。"
  fi
done < "$SELFTEST/must-miss.txt"

# 文書のフェンス判定も両方向で確かめる。地の文を拾うと、検査が文章の書き方に依存する。
# shellcheck disable=SC2016  # 見本の $ はリテラル。展開させると見本にならない
{
  printf '%s\n' '素の `mktemp` は macOS で落ちる。'                              # bsd-ok: 自己診断の見本
  printf '%s\n' '```bash'
  printf '%s\n' 'set -euo pipefail'
  printf '%s\n' 'd="$(mktemp -d)"'                                              # bsd-ok: 自己診断の見本
  printf '%s\n' '```'
  printf '%s\n' '`mktemp -d` を使う場合は注意する。'                              # bsd-ok: 自己診断の見本
} > "$SELFTEST/doc.md"
doc_hits="$(selftest_scan md "$SELFTEST/doc.md" | cut -f3 | tr '\n' ' ')"
if [ "$doc_hits" != "4 " ]; then
  fail "自己診断に失敗しました: 文書のフェンス内 4 行目だけを拾えません（得た行: ${doc_hits:-なし}）。検査が成立していないため失敗させます。"
fi

# 入れ子のフェンス。反転で判定すると内外がずれ続ける。
# shellcheck disable=SC2016  # 見本の $ はリテラル。展開させると見本にならない
{
  printf '%s\n' '````markdown'
  printf '%s\n' '```bash'
  printf '%s\n' 'set -euo pipefail'
  printf '%s\n' 'd="$(mktemp -d)"'                                              # bsd-ok: 自己診断の見本
  printf '%s\n' '```'
  printf '%s\n' '````'
  printf '%s\n' '素の `mktemp` は macOS で落ちる。'                              # bsd-ok: 自己診断の見本
} > "$SELFTEST/nested.md"
nested_hits="$(selftest_scan md "$SELFTEST/nested.md" | cut -f3 | tr '\n' ' ')"
if [ "$nested_hits" != "4 " ]; then
  fail "自己診断に失敗しました: 入れ子フェンスの 4 行目だけを拾えません（得た行: ${nested_hits:-なし}）。検査が成立していないため失敗させます。"
fi

# 逃げ道の印。理由付きは黙り、理由の無い印は黙らない。
# shellcheck disable=SC2016  # 見本の $ はリテラル。展開させると見本にならない
printf 'set -euo pipefail\nreadlink -f "$p" # bsd-ok: 代替を別経路で用意済み\n' > "$SELFTEST/marked.sh"
if [ -n "$(selftest_scan sh "$SELFTEST/marked.sh")" ]; then
  fail "自己診断に失敗しました: 理由付きの逃げ道の印が効いていません。検査が成立していないため失敗させます。"
fi
# shellcheck disable=SC2016  # 見本の $ はリテラル。展開させると見本にならない
printf 'set -euo pipefail\nreadlink -f "$p" # bsd-ok:\n' > "$SELFTEST/unmarked.sh"
if [ -z "$(selftest_scan sh "$SELFTEST/unmarked.sh")" ]; then
  fail "自己診断に失敗しました: 理由の無い逃げ道の印を認めてしまっています。検査が成立していないため失敗させます。"
fi

# ── 検査対象の列挙 ───────────────────────────────────────────────────────────

git rev-parse --is-inside-work-tree >/dev/null 2>&1 \
  || fail "git の作業ツリーではありません。追跡ファイルを列挙できないため失敗させます。"

# 列挙は NUL 区切り。パス名に改行を含むファイルでも 1 レコードのまま崩れずに読める。
# ただし**報告の書式は行区切り**なので、改行を含むパスは報告の見た目が崩れる
# （検出そのものは効く）。走査の可否と報告の見やすさを分けて考える。
git ls-files -z -- '*.sh' '*.md' > "$TRACKED" \
  || fail "git ls-files に失敗しました。追跡ファイルを列挙できません。"

tracked_count=0
target_count=0
skipped_paths=0
bsd_ok_marks=0
scanned_lines=0

: > "$REPORT"
: > "$AWK_ERR"

while IFS= read -r -d '' path; do
  tracked_count=$((tracked_count + 1))
  # シンボリックリンクと実体の無いものは走査対象が無い。
  if [ -L "$path" ] || [ ! -f "$path" ]; then
    skipped_paths=$((skipped_paths + 1))
    continue
  fi
  target_count=$((target_count + 1))
  case "$path" in
    *.md) scan_mode="md" ;;
    *)    scan_mode="sh" ;;
  esac
  # パスは環境変数で渡す（上記 scan.awk 冒頭の理由）。`./` を前置してオプションと
  # 紛れる名前を避け、`--` は渡さない（同）。
  out="$(PORTABILITY_PATH="$path" awk -v rulesfile="$RULES" -v mode="$scan_mode" -f "$SCAN" "./$path" "./$path" 2>>"$AWK_ERR")" \
    || fail "awk が異常終了しました（$path）。検査が成立していないため失敗させます。"
  # 統計行と欠陥行を分ける。パイプの読み手に早期終了するものを置かない
  # （この検査自身が禁じている形である）。
  stats="$(printf '%s\n' "$out" | sed -n 's/^#STATS\t//p')"
  bsd_ok_marks=$((bsd_ok_marks + $(printf '%s' "$stats" | cut -f1)))
  scanned_lines=$((scanned_lines + $(printf '%s' "$stats" | cut -f2)))
  printf '%s\n' "$out" | sed '/^#STATS/d' >> "$REPORT"
done < "$TRACKED"

if [ -s "$AWK_ERR" ]; then
  printf '[portability] 走査中にエラーが出ました。検査が成立していないため失敗させます:\n' >&2
  sed 's/^/[portability]     /' "$AWK_ERR" >&2
  echo "SHELL_PORTABILITY_FAIL"
  exit 1
fi

[ "$tracked_count" -gt 0 ] \
  || fail "追跡している *.sh / *.md が 1 件もありません。検査していないことと、綴りが無いことは別なので失敗させます。"
[ "$target_count" -gt 0 ] \
  || fail "走査できる追跡ファイルが 1 件もありません（全件が実体なし、またはリンク）。検査が成立していないため失敗させます。"

# ── 結果 ─────────────────────────────────────────────────────────────────────

violations="$(sed -n '/./p' "$REPORT" | sed -n '$=')"
[ -n "$violations" ] || violations=0

printf '[portability] 照合したパス: 追跡 %s 件 / 走査 %s 件（実体なし・リンク %s 件）/ %s 行（逃げ道の印 %s 件）\n' \
  "$tracked_count" "$target_count" "$skipped_paths" "$scanned_lines" "$bsd_ok_marks"

if [ "$violations" -gt 0 ]; then
  while IFS="$(printf '\t')" read -r path kind lineno message line; do
    [ -n "$path" ] || continue
    printf '[portability] %s:%s: [%s] %s\n' "$path" "$lineno" "$kind" "$message" >&2
    printf '[portability]     %s\n' "$line" >&2
  done < "$REPORT"
  printf '[portability] BSD 系（macOS）で落ちる綴りを %s 件検出しました。\n' "$violations" >&2
  printf '[portability] 代替を用意した上での意図的な使用なら、その行へ「# bsd-ok: 理由」を付けること。\n' >&2
  echo "SHELL_PORTABILITY_FAIL"
  exit 1
fi

echo "SHELL_PORTABILITY_PASS"
exit 0
