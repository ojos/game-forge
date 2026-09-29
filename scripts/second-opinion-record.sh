#!/usr/bin/env bash
# second-opinion-record.sh — 第二意見の生の出力を記録し、PR へ投稿する（#806）
#
# ## なぜ要るのか
#
# **パイプライン全体で、第二意見だけが「走ったかどうか誰も見ていない」段である。**
#
# | 段 | 確認側 |
# |---|---|
# | ローカル層の受け入れ検証（`verify.sh`） | `verify.yml` の verify ジョブが**再実行**する |
# | **第二意見** | **無い** |
# | リモート最終ゲート（Copilot） | `review-gate.yml` が要求されたことを確かめる |
#
# `.git/hooks/` は空で `core.hooksPath` も未設定なので、**`loop-gate.sh` を回さずに push できる。**
# そして `.github/workflows/verify.yml` の冒頭が、その故障モードを自分の言葉で書いている
# ——「手元で走らせる前提の実行体で、**回し忘れても何も起きない**」「**守られている外観だけが残る**」。
#
# `.ai-playbook/review-workflow.md` の「要求されたことを別の契機で確認する」が Copilot には
# 適用されているのに、第二意見には適用されていない。**それを埋めるのがこの記録と、
# `.github/workflows/second-opinion-gate.yml` の確認側である。**
#
# ## 何が買えて、何が買えないのか
#
# リモートのレビューが持つ性質のうち、買えるのは (c) だけである。
#
# | | 性質 | この仕組みで |
# |---|---|---|
# | (a) | 著者の操作なしに記録が作られる | ❌ 投稿するのは著者側 |
# | (b) | 記録を著者が消せない | **△ 部分的**（「書かない」から「消す」へ変わる。削除は意図的な行為として見える） |
# | (c) | 記録が無いことを検出できる | **✅ 完全**（確認側が head SHA と照合する） |
# | (d) | 内容が著者を通らない | ❌ ローカル実行では原理的に無理 |
#
# **偽造はできる。** レビューを回さずに `save` で作った記録を投稿すれば通る。**検出できるのは
# 失念であって、迂回ではない**（#806 の scope.out）。それでよいのは、`verify.yml` が名指しした
# 実際の故障モードが失念だからである。
#
# ## いまより良くなる点
#
# **現在、第二意見の生の出力はどこにも残っていない。** 却下は PR 本文へ書く規律があるが
# （`docs/handoff.md` の #569 / #589 / #598）、**却下されなかった指摘も、そもそも何が出たのかも
# 記録されていない。** 生の出力を投稿すれば、却下が検証可能になる。
#
# ## 記録の置き場所
#
# `git rev-parse --git-path` が返す**worktree ごとに分かれるパス**へ置く（実測: lane-806 では
# `.git/worktrees/lane-806/second-opinion/`、プライマリでは `.git/second-opinion/`）。
#
# - **レーンごとに分かれる。** 並列レーンが互いの記録を踏まない（`docs/handoff.md` のレーン運用）
# - **追跡されない。** `.gitignore` へ足す必要がなく、コミットへ混ざる経路が無い
# - **規約を発明しない。** git が既に持っている per-worktree の場所を使う
#
# ## SHA の紐づけ（この仕組みの勘所）
#
# **レビューは push の前に走り、SHA は push の後に確定する。** そのため記録は「何をレビュー
# したか」を SHA ではない形で持ち、投稿の時点で HEAD と突き合わせる。
#
# | レビューの対象 | 記録するもの | 投稿時の照合 |
# |---|---|---|
# | ステージ済み差分 | `git write-tree` の結果（索引のツリー） | `HEAD^{tree}` と一致すること |
# | コミット済みの範囲 | 範囲の終端の SHA | `HEAD` と一致すること |
#
# **一致しなければ投稿しない。** レビューの後に中身が変わったということなので、記録を貼ると
# 「レビューしていないものをレビュー済みとして記録する」ことになる。**これは偽造の防止ではなく、
# 取り違えの防止である**（悪意ではなく手順の事故を止める）。
#
# `git write-tree` は索引をツリーとして書くだけで、ref を動かさない（読み取りと同じ副作用の無さ）。
#
# ## 使い方
#
#   bash scripts/second-opinion-record.sh save --engine <名前> --verdict <pass|findings> \
#        --scope <staged|range:A..B> --runs <N> < 出力
#   bash scripts/second-opinion-record.sh show      # 記録を表示する
#   bash scripts/second-opinion-record.sh verify     # 記録が HEAD に紐づくかを確かめる
#   bash scripts/second-opinion-record.sh post       # PR へ投稿する（verify を通してから）
#
# 終了コード: 0 = 成功 / 1 = 失敗（理由を標準エラーへ）
#
# **GNU 拡張を使わない**（利用者の端末は macOS / bash 3.2。`docs/handoff.md` 3 章）。
set -euo pipefail

export LC_ALL=C

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$(dirname "$HERE")"

# 投稿するコメントの機械可読な印。**確認側がこの綴りで探す。**
# 変えると、過去の PR に付いたコメントが確認側から見えなくなる（`review-gate.yml` の
# `CONTEXT` を変えると過去の status と別物になるのと同じ性質）。
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
# `local` な変数は関数を抜けた時点で消えるため、**スクリプト終了時に走る EXIT trap からは
# 空に見える**（実測: `trap から見た v: []`）。単一引用符の trap は展開を実行時まで遅らせる
# ので、ローカル変数と組み合わせると `rm -f ""` になり、一時ファイルが残る
# （PR #814 の第二意見の指摘）。**trap を二重引用符にするのも駄目**——パスがシェルの
# コードとして埋め込まれ、`TMPDIR` にアポストロフィがあると壊れる（Copilot の指摘）。
# **両方を満たすには、trap から見えるスコープに置くしかない。**
COMMENT_BODY=""
# **空のときは `rm` を呼ばない。** `post` 以外のサブコマンド（`save` / `verify` / `show`）では
# `COMMENT_BODY` が空のまま EXIT trap が走る。**GNU の `rm -f ""` は 0 を返す**（実測）ので
# この環境では害が無いが、**このスクリプトが対象とする macOS の BSD `rm` はここで試せない。**
# 空を弾くのは 1 行で、外れたときの損（正常なサブコマンドが終了コード 1 になる）が大きい。
# 前提を確かめられない側へ倒す（PR #814 の第二意見の指摘。**前提は GNU では誤りだが、
# 対処は採った**——`review-workflow.md` の「却下と採否は別に判断します」）。
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

  cat > "$dir/output"
  [[ -s "$dir/output" ]] || fail "第二意見の出力が空です。記録しても意味が無いため失敗させます。"

  # メタは KEY=VALUE の 1 行 1 項目。値に改行を含めない。
  {
    printf 'engine=%s\n' "$engine"
    printf 'verdict=%s\n' "$verdict"
    printf 'scope=%s\n' "$scope"
    printf 'runs=%s\n' "${runs:-1}"
    printf 'bind_kind=%s\n' "$bind_kind"
    printf 'bind_value=%s\n' "$bind_value"
    printf 'saved_at=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  } > "$dir/meta"

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

  local pr
  pr="$(gh pr view --json number --jq .number 2>/dev/null || true)"
  [[ -n "$pr" ]] || fail "このブランチに対応する PR が見つかりません。先に PR を作ってください。"

  local marker="${MARKER_PREFIX}${VERIFIED_HEAD} -->"

  # **同じ SHA へ二重に投稿しない。** 冪等にしておかないと、確認側を回すたびに
  # 投稿したくなる形になり、PR が記録で埋まる。
  local existing
  existing="$(gh api --paginate "repos/{owner}/{repo}/issues/$pr/comments" \
    --jq '.[] | select(.body | contains("'"$marker"'")) | .id' 2>/dev/null | head -1 || true)"
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
    printf '| engine | `%s` |\n' "$META_ENGINE"
    printf '| 判定 | %s |\n' "$([ "$META_VERDICT" = pass ] && printf 'LGTM' || printf '指摘あり')"
    printf '| 対象 | `%s` |\n' "$META_SCOPE"
    printf '| 実行回数 | %s |\n' "$META_RUNS"
    printf '| 記録した時刻 | %s |\n' "$META_SAVED_AT"
    printf '| 紐づけ | `%s=%s` |\n' "$META_BIND_KIND" "$META_BIND_VALUE"
    printf '\n'
    printf '**指摘がゼロのときも投稿します。** 「指摘なし」と「回していない」を区別できなくすると、\n'
    printf 'この記録の目的（回し忘れの検出）が壊れます。\n\n'
    printf '<details><summary>生の出力</summary>\n\n'
    # **出力を 1 バイトも加工しない。** 記録なので、貼るものは実際に出たものでなければ
    # ならない。代わりに**外側のフェンスを出力より長くする**（CommonMark: フェンスは
    # 同じ種類のより長い印でだけ閉じられる）。
    #
    # 最初の実装は ``` を不可視文字（U+00AD）で割っていた。**その不可視文字が実際に
    # 誤読を生んだ**——第二意見が「置換前後が同一で no-op だ」と報告した（PR #814 の指摘。
    # バイトを見れば `302 255` が入っており no-op ではなかったが、**見えない文字は
    # 見て探す方法では見つからない**。`scripts/check-control-chars.sh` の冒頭が同じことを
    # 書いている）。指摘の前提は誤りだったが、**対処の向きは正しかった**ので採った。
    local fence longest
    # 出力に現れるバッククォートの最長の連続を数え、それより 1 本長い印で囲む。
    # **`sed 's/[^`]/\n/g'` と書いてはいけない。** BSD sed（macOS）は置換側の `\n` を
    # 改行ではなく**文字 `n`** として扱うため、行が分かれず、awk が「最長のバッククォート
    # 連続」ではなく**最長の行の長さ**を返す。長い行が 1 本あるだけでフェンスが数百本になり、
    # GitHub のコメント上限（65,536 字）を超えて 422 で落ちる（PR #814 の第二意見の指摘。
    # **このスクリプトの冒頭が「GNU 拡張を使わない」と書いておきながら破っていた**）。
    # `tr -c` は POSIX で、どちらでも同じに動く。
    longest="$(tr -c '`' '\n' < "$RECORD_DIR/output" | awk '{ if (length($0) > m) m = length($0) } END { print m + 0 }')"
    [[ "$longest" -ge 3 ]] || longest=2
    fence="$(printf '%*s' "$((longest + 1))" '' | tr ' ' '`')"
    printf '%s\n' "$fence"
    # **大きすぎる出力は切り詰める。** GitHub のコメントは 65,536 字が上限で、超えると
    # `gh pr comment` が落ちて **head に記録が付かないまま終わる**——この仕組みが検出したい
    # 状態そのものになる（PR #814 の Copilot の指摘）。
    #
    # **切り詰めたことを必ず書く。** 黙って削ると、出力を改変したのと区別が付かない。
    # **先頭と末尾を残す**——指摘は先頭に、判定（VERDICT）は末尾にあるため、どちらも要る。
    if [ "$(wc -c < "$RECORD_DIR/output" | tr -d ' ')" -gt "$OUTPUT_BUDGET" ]; then
      head -c "$((OUTPUT_BUDGET / 2))" "$RECORD_DIR/output"
      printf '\n\n... 中略（全文は %s バイト。上限 %s バイトに収めるため中央を省いた）...\n\n' \
        "$(wc -c < "$RECORD_DIR/output" | tr -d ' ')" "$OUTPUT_BUDGET"
      tail -c "$((OUTPUT_BUDGET / 2))" "$RECORD_DIR/output"
    else
      cat "$RECORD_DIR/output"
    fi
    # **末尾に改行が無い出力を、そのまま閉じない。** 無いと閉じるフェンスが最後の行へ
    # 連結され（`last line```）、Markdown がブロックを閉じない（PR #814 の第二意見の指摘。
    # 実測で再現）。**足りない改行を 1 つ足すだけで、出力の中身は変えない。**
    # `tail -c 1` が改行なら `$(...)` が空になるので、そのときは足さない。
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
