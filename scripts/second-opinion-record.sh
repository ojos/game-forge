#!/usr/bin/env bash
# second-opinion-record.sh — 第二意見の生の出力を記録し、PR へ投稿する
#
# ## なぜ要るのか
#
# ローカル事前ゲート（loop-gate.sh）の各段のうち、**第二意見だけが「回したかどうかを
# 誰も確かめていない」段になりやすい。** 受け入れ検証は CI が再実行して確かめられるが、
# 第二意見はローカルでしか走らないため、同じ手は使えない。
#
# `.git/hooks/` を配線していないプロジェクトでは、`loop-gate.sh` を回さずに push できる。
# この記録と、対になる確認側（second-opinion-gate.yml）が、その「回し忘れても何も
# 起きない」状態を塞ぐ（規範: `.ai-playbook/review-workflow.md`「要求されたことを
# 別の契機で確認する」）。
#
# ## 何が買えて、何が買えないのか
#
# リモートのレビューが持つ性質のうち、買えるのは「記録が無いことを検出できる」こと
# だけである。
#
# | 性質 | この仕組みで |
# |---|---|
# | 著者の操作なしに記録が作られる | ❌ 投稿するのは著者側 |
# | 記録を著者が消せない | △ 部分的（「書かない」から「消す」へ変わる。削除は意図的な行為として見える） |
# | 記録が無いことを検出できる | ✅（確認側が head SHA と照合する） |
# | 内容が著者を通らない | ❌ ローカル実行では原理的に無理 |
#
# **偽造はできる。** レビューを回さずに `save` で作った記録を投稿すれば通る。検出できる
# のは失念であって、迂回ではない（規範「この仕組みが保証すること／しないこと」）。
#
# ## 記録の置き場所
#
# `git rev-parse --git-path` が返す**worktree ごとに分かれるパス**へ置く。
#
# - レーンごとに分かれる。並列で作業する複数の worktree が互いの記録を踏まない
# - 追跡されない。`.gitignore` へ足す必要がなく、コミットへ混ざる経路が無い
# - 規約を発明しない。git が既に持っている per-worktree の場所を使う
#
# ## SHA の紐づけ（この仕組みの勘所）
#
# **レビューは push の前に走り、SHA は push の後に確定する。** そのため記録は「何を
# レビューしたか」を SHA ではない形で持ち、投稿の時点で HEAD と突き合わせる。
#
# | レビューの対象 | 記録するもの | 投稿時の照合 |
# |---|---|---|
# | ステージ済み差分 | `git write-tree` の結果（索引のツリー） | `HEAD^{tree}` と一致すること |
# | コミット済みの範囲 | 範囲の終端の SHA | `HEAD` と一致すること |
#
# **一致しなければ投稿しない。** レビューの後に中身が変わったということなので、記録を
# 貼ると「レビューしていないものをレビュー済みとして記録する」ことになる。これは偽造の
# 防止ではなく、取り違えの防止である（悪意ではなく手順の事故を止める）。
#
# `git write-tree` は索引をツリーとして書くだけで、ref を動かさない（読み取りと同じ
# 副作用の無さ）。
#
# ## 使い方
#
#   bash scripts/second-opinion-record.sh save --engine <名前> --verdict <pass|findings> \
#        --scope <staged|range:A..B> --runs <N> < 出力
#   bash scripts/second-opinion-record.sh show      # 記録を表示する
#   bash scripts/second-opinion-record.sh verify     # 記録が HEAD に紐づくかを確かめる
#   bash scripts/second-opinion-record.sh post       # PR へ投稿する（verify を通してから）
#
#   ふだんの流れ: save は loop-gate.sh が第二意見の直後に自動で呼ぶ。利用者が叩くのは、
#   push して PR ができた後の post だけである（bash scripts/loop-gate.sh → git push →
#   PR を作る → bash scripts/second-opinion-record.sh post）。PR が無いうちの post は
#   失敗する。修正を push し直したら post もし直す。
#   記録は head SHA に紐づくので、古い head への投稿では確認側を通らない。
#
# 終了コード: 0 = 成功 / 1 = 失敗（理由を標準エラーへ）
#
# **GNU 拡張を使わない。** 利用側プロジェクトの端末実装は macOS / bash 3.2 相当を含み
# うる（`scripts/check-shell-portability.sh` と同じ前提）。
set -euo pipefail

export LC_ALL=C

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$(dirname "$HERE")"

# 投稿するコメントの機械可読な印。**確認側がこの綴りで探す。**
# 変えると、過去の PR に付いたコメントが確認側から見えなくなる。
readonly MARKER_PREFIX='<!-- second-opinion sha='

# 生の出力に割り当てるバイト数の上限。
#
# **GitHub のコメントは 65,536 字が上限である。** 表・注記・フェンス・中略の断り書きに
# 使う分を引いて、余裕を持って 50,000 バイトに置く。**超えたら中央を省き、省いたことを
# 本文に書く**（`cmd_post`）。字数ではなくバイト数で見るのは、`wc -c` が移植性のある
# 数え方であることと、上限を下回る側へ倒れるためである（日本語は 1 文字 3 バイト）。
readonly OUTPUT_BUDGET=50000

# 投稿の本文を書く一時ファイル。**関数ローカルにしない。**
#
# `local` な変数は関数を抜けた時点で消えるため、スクリプト終了時に走る EXIT trap からは
# 空に見える。単一引用符の trap は展開を実行時まで遅らせるので、ローカル変数と組み合わせると
# `rm -f ""` になり、一時ファイルが残る。二重引用符の trap にもしない——パスがシェルの
# コードとして埋め込まれ、`TMPDIR` にアポストロフィがあると壊れる。両方を満たすには、
# trap から見えるスコープに置くしかない。
COMMENT_BODY=""
# **空のときは `rm` を呼ばない。** `post` 以外のサブコマンド（`save` / `verify` / `show`）では
# `COMMENT_BODY` が空のまま EXIT trap が走る。GNU の `rm -f ""` は 0 を返すが、BSD 系の
# `rm` は未確認であるため、前提を確かめられない側へ倒す。
trap '[ -n "$COMMENT_BODY" ] && rm -f "$COMMENT_BODY"' EXIT

fail() {
  printf '[second-opinion-record] %s\n' "$1" >&2
  exit 1
}

record_dir() {
  git rev-parse --git-path second-opinion 2>/dev/null \
    || fail "git の作業ツリーではありません。記録の置き場所を決められません。"
}

# ── save ─────────────────────────────────────────────────────────────────────
cmd_save() {
  local engine="" verdict="" scope="" runs=""
  while [[ "$#" -gt 0 ]]; do
    case "$1" in
      --engine)  engine="${2-}";  shift 2 ;;
      --verdict) verdict="${2-}"; shift 2 ;;
      --scope)   scope="${2-}";   shift 2 ;;
      --runs)    runs="${2-}";    shift 2 ;;
      *) fail "save の未知の引数です: $1" ;;
    esac
  done
  [[ -n "$engine" ]]  || fail "save には --engine が要ります。"
  [[ -n "$verdict" ]] || fail "save には --verdict が要ります（pass | findings）。"
  [[ -n "$scope" ]]   || fail "save には --scope が要ります（staged | range:A..B）。"
  [[ "$verdict" == "pass" || "$verdict" == "findings" ]] \
    || fail "--verdict は pass か findings です: $verdict"

  local dir
  dir="$(record_dir)"
  mkdir -p "$dir"

  # 紐づけの材料を、レビューの対象に応じて採る（冒頭「SHA の紐づけ」）。
  local bind_kind bind_value
  case "$scope" in
    staged)
      bind_kind="tree"
      # 索引をツリーとして書く。ref は動かない。
      bind_value="$(git write-tree)" || fail "索引のツリーを書けません（git write-tree）。"
      ;;
    range:*)
      bind_kind="commit"
      # 範囲 A..B の終端 B を解決する。
      local range end
      range="${scope#range:}"
      end="${range##*..}"
      [[ -n "$end" ]] || fail "範囲の終端を読み取れません: $scope"
      bind_value="$(git rev-parse --verify "$end" 2>/dev/null)" \
        || fail "範囲の終端を解決できません: $end"
      ;;
    *) fail "--scope は staged か range:A..B です: $scope" ;;
  esac

  # **一時ファイルへ書いて確かめてから置き換える。** 既存の記録へ直接書くと、入力が空の
  # ときや書き込みに失敗したときに、古い meta と空（または途中まで）の output の組が残る。
  # 古い紐づけがまだ HEAD と一致していれば、`post` がその壊れた記録を投稿してしまう。
  local tmp_output="$dir/output.tmp" tmp_meta="$dir/meta.tmp"
  rm -f "$tmp_output" "$tmp_meta"
  if ! cat > "$tmp_output"; then
    rm -f "$tmp_output"
    fail "第二意見の出力を書けません（$tmp_output）。既存の記録は変えていません。"
  fi
  if [[ ! -s "$tmp_output" ]]; then
    rm -f "$tmp_output"
    fail "第二意見の出力が空です。記録しても意味が無いため失敗させます。既存の記録は変えていません。"
  fi

  # メタは KEY=VALUE の 1 行 1 項目。値に改行を含めない。
  if ! {
    printf 'engine=%s\n' "$engine"
    printf 'verdict=%s\n' "$verdict"
    printf 'scope=%s\n' "$scope"
    printf 'runs=%s\n' "${runs:-1}"
    printf 'bind_kind=%s\n' "$bind_kind"
    printf 'bind_value=%s\n' "$bind_value"
    printf 'saved_at=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  } > "$tmp_meta"; then
    rm -f "$tmp_output" "$tmp_meta"
    fail "記録のメタを書けません（$tmp_meta）。既存の記録は変えていません。"
  fi

  # 置き換えは meta を先に消してから行う。途中で止まっても「meta が無い」側に倒れ、
  # load_meta が「記録がありません」として扱う（古い meta と新しい output の組を作らない）。
  rm -f "$dir/meta"
  mv -f "$tmp_output" "$dir/output" || fail "記録を置き換えられません（output）。"
  mv -f "$tmp_meta" "$dir/meta" || fail "記録を置き換えられません（meta）。"

  printf '[second-opinion-record] 記録しました: %s（%s=%s）\n' "$scope" "$bind_kind" "${bind_value:0:12}"
}

# ── 記録を読む ───────────────────────────────────────────────────────────────
load_meta() {
  local dir
  dir="$(record_dir)"
  [[ -f "$dir/meta" && -f "$dir/output" ]] \
    || fail "記録がありません（$dir）。先に bash scripts/loop-gate.sh を通してください。"
  # KEY=VALUE を読む。**source しない**（任意のコードを実行しない。
  # `scripts/load-project-env.sh` が .env に対して同じ扱いをしている）。
  META_ENGINE="$(sed -n 's/^engine=//p'     "$dir/meta")"
  META_VERDICT="$(sed -n 's/^verdict=//p'    "$dir/meta")"
  META_SCOPE="$(sed -n 's/^scope=//p'       "$dir/meta")"
  META_RUNS="$(sed -n 's/^runs=//p'         "$dir/meta")"
  META_BIND_KIND="$(sed -n 's/^bind_kind=//p'  "$dir/meta")"
  META_BIND_VALUE="$(sed -n 's/^bind_value=//p' "$dir/meta")"
  META_SAVED_AT="$(sed -n 's/^saved_at=//p'  "$dir/meta")"
  RECORD_DIR="$dir"
}

cmd_show() {
  load_meta
  printf 'engine=%s\nverdict=%s\nscope=%s\nruns=%s\n%s=%s\nsaved_at=%s\n' \
    "$META_ENGINE" "$META_VERDICT" "$META_SCOPE" "$META_RUNS" \
    "$META_BIND_KIND" "$META_BIND_VALUE" "$META_SAVED_AT"
  printf -- '--- output ---\n'
  cat "$RECORD_DIR/output"
}

# ── verify ───────────────────────────────────────────────────────────────────
cmd_verify() {
  load_meta
  local head actual
  head="$(git rev-parse --verify HEAD 2>/dev/null)" || fail "HEAD を解決できません。"

  case "$META_BIND_KIND" in
    tree)
      actual="$(git rev-parse --verify "HEAD^{tree}" 2>/dev/null)" \
        || fail "HEAD のツリーを解決できません。"
      if [[ "$actual" != "$META_BIND_VALUE" ]]; then
        printf '[second-opinion-record] 記録は HEAD の中身に紐づきません。\n' >&2
        printf '[second-opinion-record]   レビューした索引のツリー: %s\n' "$META_BIND_VALUE" >&2
        printf '[second-opinion-record]   HEAD のツリー:            %s\n' "$actual" >&2
        printf '[second-opinion-record] レビューの後に中身が変わっています。\n' >&2
        printf '[second-opinion-record] 対処: bash scripts/loop-gate.sh を回し直してから投稿すること。\n' >&2
        exit 1
      fi
      ;;
    commit)
      if [[ "$head" != "$META_BIND_VALUE" ]]; then
        printf '[second-opinion-record] 記録は HEAD に紐づきません。\n' >&2
        printf '[second-opinion-record]   レビューした終端: %s\n' "$META_BIND_VALUE" >&2
        printf '[second-opinion-record]   いまの HEAD:      %s\n' "$head" >&2
        printf '[second-opinion-record] 対処: bash scripts/loop-gate.sh を回し直してから投稿すること。\n' >&2
        exit 1
      fi
      ;;
    *) fail "記録の bind_kind が読めません: ${META_BIND_KIND:-(なし)}" ;;
  esac

  printf '[second-opinion-record] 記録は HEAD（%s）に紐づいています。\n' "${head:0:12}"
  VERIFIED_HEAD="$head"
}

# ── post ─────────────────────────────────────────────────────────────────────
cmd_post() {
  cmd_verify

  command -v gh >/dev/null 2>&1 || fail "gh がありません。PR へ投稿できません。"

  local pr author me
  pr="$(gh pr view --json number --jq .number 2>/dev/null || true)"
  [[ -n "$pr" ]] || fail "このブランチに対応する PR が見つかりません。先に PR を作ってください。"

  # **確認側が数える記録だけを作る。** 確認側（second-opinion-gate.yml）は、書き手が
  # PR の作者と一致するコメントしか数えない（#370 / #436）。作者以外が投稿しても、
  # 成功と表示されるだけで、確認側には使えない記録になる（#440）。読めなければ、
  # 確かめられないまま投稿せずに止める。
  author="$(gh pr view --json author --jq .author.login 2>/dev/null || true)"
  [[ -n "$author" ]] || fail "PR #$pr の作者を読めません。投稿していません。"
  me="$(gh api user --jq .login 2>/dev/null || true)"
  [[ -n "$me" ]] || fail "gh が認証しているアカウントを読めません。投稿していません。"
  if [[ "$me" != "$author" ]]; then
    fail "gh が認証しているアカウント（$me）が PR #$pr の作者（$author）ではありません。確認側は作者のコメントだけを記録として数えるため、投稿していません。作者のアカウントで post してください。"
  fi

  local marker="${MARKER_PREFIX}${VERIFIED_HEAD} -->"

  # **同じ SHA へ二重に投稿しない。** 冪等にしておかないと、確認側を回すたびに
  # 投稿したくなる形になり、PR が記録で埋まる。既に在るかは、確認側が数える
  # コメント（作者が書いたもの）だけで判定する。作者以外が書いた同じ印で
  # 「投稿済み」とすると、確認側は赤のままになる（#440）。
  local existing
  existing="$(gh api --paginate "repos/{owner}/{repo}/issues/$pr/comments" \
    --jq '.[] | select((.user.login // "") == "'"$author"'" and (.body | contains("'"$marker"'"))) | .id' 2>/dev/null | head -1 || true)"
  if [[ -n "$existing" ]]; then
    printf '[second-opinion-record] この SHA の記録は既に投稿されています（comment %s）。\n' "$existing"
    return 0
  fi

  COMMENT_BODY="$(mktemp "${TMPDIR:-/tmp}/second-opinion-comment.XXXXXX")" \
    || fail "一時ファイルを作れません。"

  {
    printf '%s\n' "$marker"
    printf '## 第二意見の記録\n\n'
    printf '| | |\n|---|---|\n'
    # バッククォートは Markdown のインラインコード記法で、コマンド置換ではない。
    # shellcheck disable=SC2016
    printf '| engine | `%s` |\n' "$META_ENGINE"
    printf '| 判定 | %s |\n' "$([ "$META_VERDICT" = pass ] && printf 'LGTM' || printf '指摘あり')"
    # shellcheck disable=SC2016
    printf '| 対象 | `%s` |\n' "$META_SCOPE"
    printf '| 実行回数 | %s |\n' "$META_RUNS"
    printf '| 記録した時刻 | %s |\n' "$META_SAVED_AT"
    # shellcheck disable=SC2016
    printf '| 紐づけ | `%s=%s` |\n' "$META_BIND_KIND" "$META_BIND_VALUE"
    printf '\n'
    printf '**指摘がゼロのときも投稿します。** 「指摘なし」と「回していない」を区別できなくすると、\n'
    printf 'この記録の目的（回し忘れの検出）が壊れます。\n\n'
    printf '<details><summary>生の出力</summary>\n\n'
    # **出力を 1 バイトも加工しない。** 記録なので、貼るものは実際に出たものでなければ
    # ならない。代わりに**外側のフェンスを出力より長くする**（CommonMark: フェンスは
    # 同じ種類のより長い印でだけ閉じられる）。
    #
    # バッククォートの最長の連続を割るとき、改行の代わりに不可視文字を挟む実装は、
    # その不可視文字自体が誤読を生む（`scripts/check-control-chars.sh` が同じ理由で
    # 見えない文字の混入を検査している）。ここでは改行で割り、GNU 拡張（sed の `\n`）に
    # 依存しない `tr -c` を使う。
    local fence longest
    longest="$(tr -c '`' '\n' < "$RECORD_DIR/output" | awk '{ if (length($0) > m) m = length($0) } END { print m + 0 }')"
    [[ "$longest" -ge 3 ]] || longest=2
    fence="$(printf '%*s' "$((longest + 1))" '' | tr ' ' '`')"
    printf '%s\n' "$fence"
    # **大きすぎる出力は切り詰める。** GitHub のコメントは 65,536 字が上限で、超えると
    # `gh pr comment` が落ちて **head に記録が付かないまま終わる**——この仕組みが検出したい
    # 状態そのものになる。
    #
    # **切り詰めたことを必ず書く。** 黙って削ると、出力を改変したのと区別が付かない。
    # **先頭と末尾を残す**——指摘は先頭に、判定は末尾にあるため、どちらも要る。
    if [ "$(wc -c < "$RECORD_DIR/output" | tr -d ' ')" -gt "$OUTPUT_BUDGET" ]; then
      head -c "$((OUTPUT_BUDGET / 2))" "$RECORD_DIR/output"
      printf '\n\n... 中略（全文は %s バイト。上限 %s バイトに収めるため中央を省いた）...\n\n' \
        "$(wc -c < "$RECORD_DIR/output" | tr -d ' ')" "$OUTPUT_BUDGET"
      tail -c "$((OUTPUT_BUDGET / 2))" "$RECORD_DIR/output"
    else
      cat "$RECORD_DIR/output"
    fi
    # **末尾に改行が無い出力を、そのまま閉じない。** 無いと閉じるフェンスが最後の行へ
    # 連結され（`last line```）、Markdown がブロックを閉じない。足りない改行を 1 つ足す
    # だけで、出力の中身は変えない。`tail -c 1` が改行なら `$(...)` が空になるので、
    # そのときは足さない。
    [ -z "$(tail -c 1 "$RECORD_DIR/output")" ] || printf '\n'
    printf '%s\n\n' "$fence"
    printf '</details>\n'
  } > "$COMMENT_BODY"

  gh pr comment "$pr" --body-file "$COMMENT_BODY" >/dev/null \
    || fail "PR #$pr へ投稿できませんでした。"
  printf '[second-opinion-record] PR #%s へ記録を投稿しました（%s）。\n' "$pr" "${VERIFIED_HEAD:0:12}"
}

case "${1-}" in
  save)   shift; cmd_save "$@" ;;
  show)   cmd_show ;;
  verify) cmd_verify ;;
  post)   cmd_post ;;
  *)
    printf 'usage: %s {save|show|verify|post} [...]\n' "$(basename "$0")" >&2
    exit 1
    ;;
esac
