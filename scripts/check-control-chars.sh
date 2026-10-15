#!/usr/bin/env bash
# check-control-chars.sh — 追跡ファイルへの「表示されない制御文字」混入の検知ゲート
#
# 位置づけ:
#   判定はこのスクリプトが持ち、scripts/acceptance.sh は呼ぶだけ。生成時の雛形の
#   acceptance.sh はこれを呼ぶ。既存の出力先は acceptance.sh がプロジェクトの
#   所有物なので、プロジェクト側で配線する（doctor.sh が未配線を WARN で知らせる）。
#   scripts/check-no-secrets.sh / scripts/verify-commit-identity.sh と同じ形にそろえる。
#
#   verify.sh から直接呼ばず acceptance.sh へ置く理由: verify.sh が直接呼ぶのは
#   機密混入という別格の関心事だけである（あちらは一度入ると削除コミットでは漏洩が
#   解消せず、資格情報の失効・再発行まで要る）。制御文字の混入は直せば終わるので、
#   通常の受け入れ条件でよい。
#
# なぜ機構で押さえるか:
#   ある利用プロジェクトでは、追跡ファイルに生の NUL バイトが混入したままレビュー
#   まで進んだ。配列比較の区切りとして書かれたもので**振る舞いは正しく**、問題は
#   表示上ただの空白に見えるため読んでも気づけないことだった。該当行を出して
#   目視しても分からず、リモートのレビューが拾って初めて判明している。
#
#   **見えない文字は「見て探す」方法では見つからない。** 人のレビューは構造的にすり
#   抜けるため、`.ai-playbook/shared-ai-rules.md` 12 章「機構化の判断基準」に照らして
#   機構へ移す。ここで検査するのは「気をつけたか」ではなく「入っているか」なので、
#   儀式では通過できない。
#
# 何を禁じるか（バイト単位で判定する）:
#   C0 制御文字 0x00-0x1F のうち TAB(0x09) / LF(0x0A) / CR(0x0D) を除く全部と、DEL(0x7F)。
#   すなわち 0x00-0x08, 0x0B, 0x0C, 0x0E-0x1F, 0x7F。
#
#   - TAB / LF は字下げと行の区切りであり、テキストファイルの構造そのものなので許す。
#   - CR も許す。CRLF という**改行の流儀**の一部であり、行末の統一は整形の関心事
#     （.gitattributes や整形ツールの領分）でこの検査の関心事ではない。
#   - 残りを禁じる根拠は「表示すると幅を持たないか別の文字に化ける」ことに加えて、
#     **ソースへ生のバイトとして書く必要が原理的に無い**ことである。値として必要なら
#     どの言語にもエスケープがある（'\0' / "\x1b" / "\u001B"）。したがって除外規定は
#     設けない。
#
# 何を見ないか（意図的に範囲外。この検査が見ていると誤解しないために明記する）:
#   - Unicode の不可視文字（BOM U+FEFF、ZWSP U+200B、双方向制御 U+202A-U+202E 等）。
#     同じ「見えない」問題だが、判定に符号化の解釈が要り、誤検出の方針も別に決める
#     必要がある（多バイト文字を日常的に含む文書もある）。要るなら別の検査として足す。
#   - UTF-8 妥当性そのもの。下記のとおり**バイナリ判定の材料としてだけ**使い、
#     妥当でないことを不合格にはしない。
#   - 行末の流儀（CRLF / 末尾改行）と、既存ファイルの一括修正。
#
# 検査対象の決め方:
#   git ls-files -z を起点にし、作業ツリー上の実体と、索引（ステージ済み）の blob の両方を読む。
#   - 追跡対象だけを見る。制御文字が問題になるのは、それが共有される状態に入ってからである。
#   - 作業ツリーの内容を読むため、追跡ファイルを編集して混入させた時点でも落ちる。
#   - 索引の内容も読む。禁止バイトを含む内容を git add したあとに作業ツリーだけを直すと、
#     作業ツリーは綺麗でも次のコミットには禁止バイトが入る。これを見逃さないため、
#     索引と作業ツリーで内容が違うファイル（git diff --name-only -z。作業ツリーで消したものを
#     含む）は、索引の blob を取り出して同じ規則で検査する。報告には「<パス> (staged)」と
#     示すので、作業ツリー側の検出と区別できる。
#   - assume-unchanged / skip-worktree の印が付いたファイルは、git diff が作業ツリーの変更を
#     列挙しない。git ls-files -v で印を列挙し、差分の一覧に加えて索引の blob を必ず読む。
#   - 索引側で読むのは通常のファイル（モード 100644 / 100755）の blob だけ。サブモジュール
#     （160000）とシンボリックリンク（120000）は読まない。リンクの blob はリンク先のパス
#     文字列で、作業ツリー側でリンクを走査しないのと同じ理由で対象外とする。
#   - 索引の blob もバイナリ判定は作業ツリーと同じ（下記の 2 段）。git の NUL 判定は使わない。
#   - 限界: git の clean フィルター（git add のときに内容を変換する設定）が、作業ツリーに無い
#     禁止バイトを索引へ書き込む場合は見逃す。git diff はフィルターを通した後の内容を比べて
#     「差分なし」と判断するため、その索引の blob を読まない。確実に塞ぐには追跡している
#     全ファイルの索引も読む必要があり、検査の量がおよそ倍になる。禁止バイトを足すフィルターを
#     自分で設定する場面はほぼ無いので、この形を採らない。
#   - 実体が無いもの（削除済み・サブモジュール）とシンボリックリンクは走査しない。
#     リンクを開くと git が持つ内容（リンク先のパス文字列）ではなくリンク先の実体を
#     読んでしまい、判定が別物になるため。リンク先パスに制御文字が入る事態は考えにくい。
#
# バイナリをどう除くか（この検査の一番の勘所）:
#   **git 自身のバイナリ判定は使えない。** git は「先頭 8000 バイトに NUL があればバイナリ」と
#   みなす（git grep -I、diff の "Binary files differ" がこれ）。その判定を使うと、まさに
#   捕まえたい「NUL の混ざったテキストファイル」が真っ先に対象外へ落ちる。
#
#   代わりに 2 段で見る。
#     1 段目: 追跡ファイルを 1 本ずつ grep で走査し、禁止バイトを含むファイルだけを拾う。
#     2 段目: 1 段目に引っかかったものだけを、テキストかバイナリかで判定する。
#
#   2 段目の判定材料は **UTF-8 として解釈できるか**である。NUL も ESC も UTF-8 として妥当な
#   バイト列なので、「NUL の混ざったテキスト」はテキストのまま残る。一方、画像やフォントは
#   実際上どこかに不正なバイト列を含む（PNG の先頭 0x89、JPEG の 0xFF、gzip の 0x8B は
#   いずれもその時点で不正）ため、バイナリとして落ちる。**妥当でないものを不合格にするので
#   はなく、走査から外すだけ**である点で、UTF-8 妥当性の検査とは向きが逆である。
#
#   限界（承知の上で受け入れる）: UTF-8 として妥当なバイナリ形式を追跡すると、それは
#   テキストとして扱われる。逆に UTF-8 でないテキスト（Shift_JIS など）は走査されない。
#   どちらも起きたら、その時点で拡張子による短絡を足すのが素直である。
#
# 速度:
#   1 段目は追跡ファイル 1 本につき grep を 1 回起こす（GNU 専用の -Z を避けて移植性を
#   優先した結果で、1 回の一括走査より遅い）。2 段目はバイナリを大量に追跡すると
#   呼び出し回数がその件数に比例するので、目に見えて遅くなったら拡張子による短絡を
#   1 段目の手前へ足すこと。
#
# 禁止バイトの渡し方:
#   パターンはファイルへ書いて grep -f で読ませる。**NUL は引数として渡せない**（argv は
#   NUL 終端なので、文字列の途中に NUL を置けない）ためで、これが唯一の理由である。
#   PCRE（grep -P）なら \x00 と書けるが、PCRE 付きの grep があることを前提にしたくない。
#   角括弧の範囲指定はロケールの照合順に依存するため LC_ALL=C で固定する
#   （scripts/check-no-secrets.sh が sort/comm で固定しているのと同じ理由）。
#
# 検査が成立していないことを合格にしない:
#   git 管理外での実行、git コマンドの失敗、追跡ファイル 0 件、grep 自体の失敗は、いずれも
#   「制御文字が無い」ことを意味しない。空の出力を「該当なし」と読むと、検査していないのに
#   合格になる。すべて失敗として扱う。
#   加えて、**起動時に検査機構そのものを自己診断する**（NUL を混ぜた入力で必ず当たること、
#   通常の文字で当たらないこと）。パターンの書き損じや grep の仕様差で「何も当たらない
#   検査」になっていた場合、それは常に緑を返すため、赤にならない限り誰も気づけない。
#
# 終了コード:
#   0 = CONTROL_CHARS_PASS
#   1 = CONTROL_CHARS_FAIL（制御文字の混入、または検査が成立しなかった）
set -euo pipefail

# 角括弧の範囲指定（[\000-\010] など）の解釈をバイト順に固定する。
export LC_ALL=C

# 検査はプロジェクトルート基準で行う。scripts/ の 1 階層上がルート。
# 任意の作業ディレクトリから起動しても結果が不変になるよう、起動時 CWD に依存しない。
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$(dirname "$HERE")"

fail() {
  printf '[control-chars] %s\n' "$1" >&2
  echo "CONTROL_CHARS_FAIL"
  exit 1
}

WORK="$(mktemp -d "${TMPDIR:-/tmp}/control-chars.XXXXXX")" || { echo "[control-chars] 一時ディレクトリを作成できません。" >&2; echo "CONTROL_CHARS_FAIL"; exit 1; }
trap 'rm -rf "$WORK"' EXIT

PATTERN="$WORK/forbidden.pattern"
TRACKED="$WORK/tracked.z"
TARGETS="$WORK/targets.z"
STAGED_DIR="$WORK/staged"
DIFF_NAMES="$WORK/diff-names.z"
FLAGGED="$WORK/flagged.z"
SUSPECTS="$WORK/suspects.z"
GREP_ERR="$WORK/grep.err"

# ── 禁止バイトのパターン ─────────────────────────────────────────────────────
#
# 8 進で 0x00-0x08 / 0x0B / 0x0C / 0x0E-0x1F / 0x7F。TAB(011) / LF(012) / CR(015) が
# 範囲から外れていることが読み取れるよう、範囲を分けて書く。
printf '[\000-\010\013\014\016-\037\177]\n' > "$PATTERN"

# ── 自己診断 ─────────────────────────────────────────────────────────────────
#
# 両方向を見る。当たること（偽陰性＝常に緑になる壊れ方）と、当たらないこと（偽陽性）。
# grep が早期終了して書き込み側が SIGPIPE で落ちても影響しないよう、標準入力ではなく
# プロセス置換のファイルとして渡す。
if ! grep -q -a -f "$PATTERN" <(printf 'a\000b\n'); then
  fail "自己診断に失敗しました: NUL を含む入力を検出できません。検査が成立していないため失敗させます。"
fi
if grep -q -a -f "$PATTERN" <(printf 'tab\there\tand newline\r\n'); then
  fail "自己診断に失敗しました: TAB / CR / LF だけの入力を誤検出します。検査が成立していないため失敗させます。"
fi

# ── 検査対象の列挙 ───────────────────────────────────────────────────────────

git rev-parse --is-inside-work-tree >/dev/null 2>&1 \
  || fail "git の作業ツリーではありません。追跡ファイルを列挙できないため失敗させます。"

# 列挙は NUL 区切り。パス名に改行を含むファイルでも 1 レコードのまま崩れずに読める
# （scripts/check-no-secrets.sh と同じ扱い）。
git ls-files -z > "$TRACKED" || fail "git ls-files に失敗しました。追跡ファイルを列挙できません。"

tracked_count=0
target_count=0
skipped_count=0

# 走査できる実体だけを残す。判定は bash の組み込みだけで行うのでプロセスを起こさない。
while IFS= read -r -d '' path; do
  tracked_count=$((tracked_count + 1))
  # シンボリックリンクは走査しない（理由は冒頭「検査対象の決め方」）。
  if [[ -L "$path" ]]; then
    skipped_count=$((skipped_count + 1))
    continue
  fi
  # 通常ファイルでないもの（削除済み・サブモジュールのディレクトリ）は走査対象が無い。
  if [[ ! -f "$path" ]]; then
    skipped_count=$((skipped_count + 1))
    continue
  fi
  target_count=$((target_count + 1))
  printf '%s\0' "$path"
done < "$TRACKED" > "$TARGETS"

# ── 索引側の blob の取り出し ─────────────────────────────────────────────────
#
# 索引と作業ツリーで内容が違うファイルだけを対象にする（同じなら作業ツリーの走査で足りる）。
# 取り出した blob は $STAGED_DIR/<連番> に置き、元のパスは <連番>.label に持つ
# （パス名に改行があっても崩れないよう、ファイルで持つ）。走査は他の対象と同じ経路に流す。
# --literal-pathspecs は、パス名の * や : を git にパターンとして解釈させないため。
staged_count=0
mkdir -p "$STAGED_DIR"

# stage_index_blob <パス> — 索引のそのパスの blob を取り出して走査対象へ加える。
stage_index_blob() {
  local path="$1" entry_file="$WORK/entry.z" entry meta mode rest sha stage staged_file
  git --literal-pathspecs ls-files -s -z -- "$path" > "$entry_file" \
    || fail "git ls-files -s に失敗しました（$path）。索引のエントリを読めません。"
  # 出力は「<モード> <sha> <stage>TAB<パス>」。マージ中の衝突（stage 1-3）は複数行になりうる。
  while IFS= read -r -d '' entry; do
    meta="${entry%%$'\t'*}"
    mode="${meta%% *}"
    rest="${meta#* }"
    sha="${rest%% *}"
    stage="${rest#* }"
    # 通常のファイルの blob だけを読む（理由は冒頭「検査対象の決め方」）。
    [[ "$mode" == "100644" || "$mode" == "100755" ]] || continue
    [[ "$stage" == "0" ]] || continue
    staged_count=$((staged_count + 1))
    staged_file="$STAGED_DIR/$staged_count"
    git cat-file blob "$sha" > "$staged_file" \
      || fail "git cat-file に失敗しました（$path）。索引の blob を読めません。"
    printf '%s (staged)' "$path" > "$staged_file.label"
    printf '%s\0' "$staged_file" >> "$TARGETS"
  done < "$entry_file"
}

git diff --name-only -z > "$DIFF_NAMES" || fail "git diff に失敗しました。索引と作業ツリーの差分を列挙できません。"
while IFS= read -r -d '' path; do
  stage_index_blob "$path"
done < "$DIFF_NAMES"

# assume-unchanged / skip-worktree の印が付いたファイルは、git diff が作業ツリーの変更を
# 列挙しない。だが次のコミットに入る内容は索引の blob なので、差分の有無によらず必ず読む。
# git ls-files -v の先頭の印は、小文字 = assume-unchanged、S / s = skip-worktree。
git ls-files -v -z > "$FLAGGED" || fail "git ls-files -v に失敗しました。印の付いたファイルを列挙できません。"
while IFS= read -r -d '' rec; do
  tag="${rec%% *}"
  case "$tag" in
    [a-zS]) ;;
    *) continue ;;
  esac
  path="${rec#* }"
  # 差分の一覧に既にあるものは二重に読まない。
  already=0
  while IFS= read -r -d '' diffed; do
    if [[ "$diffed" == "$path" ]]; then already=1; break; fi
  done < "$DIFF_NAMES"
  [[ "$already" -eq 0 ]] || continue
  stage_index_blob "$path"
done < "$FLAGGED"

# 報告に出す名前。索引から取り出した一時ファイルは、元のパスに「(staged)」を添えて示す。
display_name() {
  if [[ "$1" == "$STAGED_DIR/"* && -f "$1.label" ]]; then
    cat "$1.label"
  else
    printf '%s' "$1"
  fi
}

[[ "$tracked_count" -gt 0 ]] \
  || fail "追跡ファイルが 1 件もありません。検査していないことと、制御文字が無いことは別なので失敗させます。"
[[ $((target_count + staged_count)) -gt 0 ]] \
  || fail "走査できる追跡ファイルが 1 件もありません（全件が実体なし、またはリンク。索引側の blob も 0 件）。検査が成立していないため失敗させます。"

# ── 1 段目: 禁止バイトを含むファイルを 1 回の走査で拾う ──────────────────────
#
# ファイルごとに grep -q を 1 回ずつ呼ぶ（xargs -0 grep -l -Z の一括走査は使わない）。
#
# **-Z は GNU grep の拡張で、macOS / BSD の grep には無い。** 一括走査は「該当ファイル名を
# NUL 区切りで返させる」ために -Z が要ったが、それ自体は移植性のために採用したはずの
# 手段（#263 系）が GNU 依存を持ち込む本末転倒だった。ここでは $TARGETS が既に NUL 区切りの
# ファイル一覧を持っているため、-Z で教えてもらう必要が無い。1 ファイルずつ read で
# 取り出し、grep には対象を直接渡す（-a のみで足りる。-l / -Z は使わない）。
#
# 費用はファイル数に比例して grep の起動回数が増える（バッチ化していた旧実装より遅い）。
# 目に見えて遅くなったら、xargs -0 grep -l -a -f "$PATTERN" -- （-Z を使わない一括版）
# への切り替えを検討すること。ただし一括版は「suspects の一覧」しか返せず、NUL 区切りで
# 返す手段が -Z 以外に無いため、改行を含むパス名が suspects に混じると 1 レコードとして
# 復元できない。1 ファイルずつ処理する現行方式はこの制約が無い。
grep_error=0
while IFS= read -r -d '' path; do
  path_status=0
  grep -q -a -f "$PATTERN" -- "$path" 2>>"$GREP_ERR" || path_status=$?
  if [[ "$path_status" -eq 0 ]]; then
    printf '%s\0' "$path" >> "$SUSPECTS"
  elif [[ "$path_status" -ne 1 ]]; then
    # 0 = 該当あり（suspect）。1 = 該当なし（正常）。それ以外（2 等）は grep 自体の
    # エラーで、検査が成立していないため失敗させる。ここでは即座に落とさず、
    # 全件を回してから GREP_ERR の中身と合わせて判定する（1 ファイルの失敗で
    # 残りの走査を打ち切らないほうが、他にも壊れたファイルがあれば一度に分かる）。
    grep_error=1
  fi
done < "$TARGETS"

if [[ -s "$GREP_ERR" ]]; then
  printf '[control-chars] 走査中にエラーが出ました。検査が成立していないため失敗させます:\n' >&2
  sed 's/^/[control-chars]     /' "$GREP_ERR" >&2
  echo "CONTROL_CHARS_FAIL"
  exit 1
fi
if [[ "$grep_error" -ne 0 ]]; then
  fail "走査中に grep が異常終了したファイルがあります。検査が成立していないため失敗させます。"
fi

# ── 2 段目: 拾ったものをテキストとバイナリに分ける ───────────────────────────

binary_count=0
violations=0

if [[ -s "$SUSPECTS" ]]; then
  # iconv はここで初めて要る。1 段目が空なら「制御文字は無い」と言い切れるので、
  # 不在を理由に落とすのは実際に判定が必要になったときだけでよい。
  command -v iconv >/dev/null 2>&1 \
    || fail "iconv がありません。テキストとバイナリを判定できないため失敗させます（対処: libc の iconv を導入する）。"

  while IFS= read -r -d '' path; do
    # UTF-8 として解釈できなければバイナリとみなして走査から外す（冒頭の議論を参照）。
    if ! iconv -f UTF-8 -t UTF-8 < "$path" > /dev/null 2>&1; then
      binary_count=$((binary_count + 1))
      continue
    fi

    violations=$((violations + 1))
    hit_lines="$(grep -c -a -f "$PATTERN" -- "$path" || true)"
    printf '[control-chars]   %s（該当 %s 行）\n' "$(display_name "$path")" "$hit_lines" >&2
    # 該当行は cat -v で可視化してから出す。生のまま出すと、端末では**やはり見えない**。
    # 先頭 5 行に絞り、1 行 200 バイトで切る（長い行で対処が画面から流れないように）。
    grep -n -a -f "$PATTERN" -- "$path" 2>/dev/null \
      | head -5 | cat -v | cut -c1-200 | sed 's/^/[control-chars]     /' >&2 || true
  done < "$SUSPECTS"
fi

# ── 結果 ─────────────────────────────────────────────────────────────────────

printf '[control-chars] 検査したパス: 追跡 %s 件 / 走査 %s 件（実体なし・リンク %s 件、バイナリ %s 件）、索引側 %s 件\n' \
  "$tracked_count" "$target_count" "$skipped_count" "$binary_count" "$staged_count"

if [[ "$violations" -gt 0 ]]; then
  printf '[control-chars] 表示されない制御文字を含むファイルを %s 件検出しました。\n' "$violations" >&2
  printf '[control-chars] 上の表記は cat -v によるものです（^@ = NUL、^[ = ESC、^? = DEL）。\n' >&2
  printf '[control-chars] 対処: その文字が値として必要なら、生のバイトではなく言語のエスケープで書く\n' >&2
  printf "[control-chars]       （例: '\\\\0' / \"\\\\x1b\"）。不要な混入であれば取り除く。\n" >&2
  echo "CONTROL_CHARS_FAIL"
  exit 1
fi

echo "CONTROL_CHARS_PASS"
exit 0
