#!/usr/bin/env bash
# loop-gate.sh — ローカル事前ゲート（ループコーディングの収束点）
#
# push / PR 作成の前に、機械判定の受け入れ検証（verify.sh）と、任意の第二意見
# レビューを直列で通す単一入口。verify が通り、第二意見があればそれも通ったときだけ
# 通過する。
#
# このスクリプトは単体で動作する。第二意見レビューは存在すれば直列化し、
# 無ければ優雅にスキップする（外部パッケージの導入を前提にしない）。
#
# 第二意見レビュー:
#   既定で scripts/second-opinion-review.sh があれば実行する。
#   LOOP_GATE_REVIEW_CMD で任意のコマンドへ差し替え可能。空文字でスキップする。
#
#   second-opinion-review.sh の既定対象はステージ済み差分で、空なら「レビュー対象なし」
#   として 0 を返す。commit 後（ステージが空）にこのゲートを回すと、第二意見が
#   実質スキップされたまま GATE_PASS が出ることになる。push 前ゲートとしては
#   偽の緑なので、ステージが空のときは commit 済み範囲を対象に切り替える。
#
#   切り替えた先が空になる経路も塞ぐ。push 済みのブランチでは上流と HEAD が
#   同じコミットを指すため @{upstream}..HEAD の差分が空になり、同じ偽の緑が
#   復活する。範囲は「解決できたか」ではなく「実際に差分があるか」で選び、
#   無ければ既定ブランチとの分岐点まで戻してブランチ全体を対象にする。
#   それでも差分が無いときは、レビュー対象が無いことを明示したうえで通過する
#   （空を一律 FAIL にすると、差分の無い状態でのゲート実行が落ちるため）。
#
#   上流との差分が空でなくても、その範囲が他ブランチの成果を巻き込むことがある。
#   @{upstream}..HEAD は 2 点間の比較なので、既定ブランチを取り込んだ直後は
#   取り込んだ側のコミットがまるごと差分に入る。それは既にレビューを通った他
#   ブランチの成果であって、このブランチが加えた変更ではない。範囲が既定ブランチ
#   へ到達可能なコミットを含むときは分岐点まで戻し、なぜ範囲を変えたかを出力する。
#
#   上流が分岐点より先へ進んでいるとき（上流が既定ブランチの追跡枝で、別の PR が
#   入った等）も、起点を分岐点の SHA にする。2 点間の比較のままだと、上流側だけの
#   変更を取り消す差分が混ざる（#878）。回帰試験は scripts/loop-gate-range-selftest.sh。
#
# 終了コード:
#   0 = GATE_PASS（全段通過。push 可）
#   1 = GATE_FAIL（いずれかの段が未通過、または実行不能）
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# 既定の reviewer へ渡す引数を決める。
#
# ステージ済み差分があるときは何も渡さない（reviewer 側の既定に委ねる）。
# 空のときだけ commit 済み範囲へ切り替える。git リポジトリでない場合や範囲を
# 解決できない場合は、従来どおり引数なしで呼ぶ。範囲を解決できないことは
# reviewer を呼べない理由にならないため、ここでは落とさない。
#
# なお、git 管理外ではこの関数へ到達する前に step 1（verify.sh）が落ちる。
# verify.sh が呼ぶ機密混入検査（check-no-secrets.sh）が git の作業ツリーを前提に
# しており、検査が成立しない状態を合格にしないため。この関数が git 外の経路を
# 持つのは、範囲解決を単体で使えるようにしておくためである。
REVIEW_RANGE=""
# 範囲は解決できたが差分が空だった（= レビューできる対象が無い）状態を表す。
# REVIEW_RANGE="" とは区別する。この状態を reviewer の既定へ流すと、空の
# ステージ済み差分を見せることになり、塞いだはずの素通りへ戻るため。
REVIEW_NO_TARGET=0
# 上流以外を起点に採ったときの理由。黙って範囲を変えると、なぜその差分が
# レビュー対象なのかを読み手が追えないため、採用時に 1 行出力する。
REVIEW_RANGE_REASON=""

# 範囲が実際に差分を持つか。git diff --quiet は差分ありで 1 を返す。
# 128（範囲を解決できない等）を「差分あり」と誤認しないよう、1 だけを真とする。
# 末尾の -- は、範囲と同名のパスが存在するときの曖昧さを排除する。
range_has_diff() {
  local rc=0
  git diff --quiet "$1" -- >/dev/null 2>&1 || rc=$?
  [[ "$rc" -eq 1 ]]
}

# 既定ブランチの追跡枝を解決し、名前を標準出力へ返す。見つからなければ 1 を返す。
# 既定ブランチ名は決め打ちせず origin/HEAD → origin/main → origin/master の順で探す。
#
# 解決を 1 箇所へ集約するのは、範囲の汚染判定と分岐点の算出とで**同じ枝**を見る
# 必要があるため。別々に決めると、「汚染ありと判定した枝」と「分岐点を取った枝」が
# 別物になりうる。
resolve_integration_base() {
  local base
  for base in origin/HEAD origin/main origin/master; do
    if git rev-parse --verify --quiet "$base" >/dev/null; then
      printf '%s' "$base"
      return 0
    fi
  done
  return 1
}

# 範囲 <from>..HEAD が、既に既定ブランチ <base> へ到達可能なコミットを含むか。
#
#   all = <from>..HEAD の総数
#   own = そのうち <base> から到達できないもの（= このブランチが加えた分）
#   all != own なら、他ブランチの成果を巻き込んでいる
#
# 「マージコミットを含むか」では判定しない。取り込み方によって現れる形が違い、
# 形ごとに書き分けるほど取りこぼす。到達可能性で見れば取り込み方に依らない。
#
# <base> が空（既定ブランチの追跡枝が無い）なら判定できない。ここで真を返すと
# 分岐点も取れないまま範囲を失うため、偽を返して従来どおり上流を使わせる。
range_includes_base_commits() {
  local from="$1" base="$2" all own
  [[ -n "$base" ]] || return 1
  all="$(git rev-list --count "$from..HEAD" 2>/dev/null || true)"
  own="$(git rev-list --count "$from..HEAD" "^$base" 2>/dev/null || true)"
  # どちらかが数えられなければ判定不能。汚染なし扱いにして上流を使わせる。
  [[ -n "$all" && -n "$own" ]] || return 1
  [[ "$all" != "$own" ]]
}

resolve_review_range() {
  command -v git >/dev/null 2>&1 || return 0
  git rev-parse --git-dir >/dev/null 2>&1 || return 0
  # ステージ済みがあるなら reviewer の既定に委ねる。
  git diff --cached --quiet || return 0
  # コミットが 1 件も無ければ比較の起点を作れない。
  git rev-parse --verify --quiet HEAD >/dev/null || return 0

  # 汚染判定と分岐点の算出は、ここで解決した 1 つの枝だけを見る。
  local base=""
  base="$(resolve_integration_base || true)"

  # 上流を起点にできない理由。分岐点を採ったときにそのまま出力する。
  local fallback_reason=""

  # 上流が設定されていればそこからの差分。未 push のコミットがそのまま対象になる。
  # ただし採用条件は 2 つある。
  #   1. 差分が空でないこと。push 済みだと上流 == HEAD で空になり、第二意見が
  #      一度も差分を見ないまま通過する（偽の緑）。
  #   2. 範囲が既定ブランチへ到達可能なコミットを含まないこと。含むなら、その
  #      分は他ブランチが加えた既レビュー済みの成果であって、このブランチの
  #      変更ではない。
  local upstream
  upstream="$(git rev-parse --abbrev-ref --symbolic-full-name '@{upstream}' 2>/dev/null || true)"
  if [[ -n "$upstream" ]]; then
    if ! range_has_diff "$upstream..HEAD"; then
      fallback_reason="upstream range $upstream..HEAD has no diff (branch already pushed)"
    elif range_includes_base_commits "$upstream" "$base"; then
      fallback_reason="upstream range $upstream..HEAD also contains commits already reachable from $base (default branch integrated into this branch)"
    else
      # **起点は上流の先端ではなく、上流と HEAD の分岐点にする**（#878。上流
      # ojos/ai-packages-dev の PR #383 と同じ作り）。第二意見は `git diff <範囲>` で
      # 差分を取り、これは両端のツリーの差である。上流が分岐点より先へ進んでいると
      # （`origin/main` を上流にして切ったブランチで、ゲートの最中に別の PR が既定
      # ブランチへ入って fetch された等）、進んだ分が逆向きに差分へ入り、このブランチが
      # 触っていないファイルへの指摘でゲートが落ちる。上の 2 の判定は `git log` の意味
      # （上流に無いコミット）で見るため、この混入を検出できない。three-dot（A...B）は
      # diff では分岐点基準になるが、第二意見が `git log` にも同じ範囲を渡すと対称差に
      # なるので使わない。
      #
      # 上流が進んでいなければ分岐点は上流の先端と同じなので、従来どおり上流の名前で
      # 範囲を書く（出力と記録の scope の表記を変えない）。
      local upstream_mb upstream_tip
      upstream_mb="$(git merge-base "$upstream" HEAD 2>/dev/null || true)"
      upstream_tip="$(git rev-parse --verify --quiet "$upstream" 2>/dev/null || true)"
      if [[ -n "$upstream_mb" && -n "$upstream_tip" && "$upstream_mb" != "$upstream_tip" ]]; then
        REVIEW_RANGE="$upstream_mb..HEAD"
        REVIEW_RANGE_REASON="$upstream has advanced beyond the merge-base; reviewing from the merge-base ${upstream_mb:0:12} so that changes only on $upstream are not reverted into the diff"
      else
        REVIEW_RANGE="$upstream..HEAD"
      fi
      return 0
    fi
  else
    fallback_reason="no upstream is configured for this branch"
  fi

  # 既定ブランチの追跡枝との分岐点を起点にし、ブランチ全体をレビュー対象にする。
  #
  # 分岐点（merge-base）を使うのは、base..HEAD が 2 点間の比較であり、base 側に
  # 進んだコミットを「打ち消し」として差分へ混ぜるため。ブランチが加えた変更
  # だけを対象にする。既定ブランチを取り込んでいる場合は分岐点が取り込み地点まで
  # 進むので、取り込んだ成果は範囲から外れる。
  if [[ -n "$base" ]]; then
    local mb
    mb="$(git merge-base "$base" HEAD 2>/dev/null || true)"
    # 履歴が繋がっていない（分岐点が無い）場合の受け皿。
    [[ -n "$mb" ]] || mb="$base"
    if range_has_diff "$mb..HEAD"; then
      REVIEW_RANGE="$mb..HEAD"
      REVIEW_RANGE_REASON="$fallback_reason; reviewing from the merge-base with $base instead"
      return 0
    fi
    # 既定ブランチの追跡枝が見つかった時点で起点は確定する。そこと差分が無いのは
    # 「レビュー対象が無い」であって、空ツリーまで戻してリポジトリ全体を対象に
    # すべき状況ではない。
    REVIEW_NO_TARGET=1
    return 0
  fi

  # 上流はあるが既定ブランチの追跡枝が無い場合。remote は存在するので、下の
  # 空ツリー（= リポジトリ全体）へは広げずレビュー対象なしとして扱う。
  if [[ -n "$upstream" ]]; then
    REVIEW_NO_TARGET=1
    return 0
  fi

  # remote が無いプロジェクト。起点が無いので空ツリーからの全体を対象にする。
  #
  # ここを "HEAD" にしてはならない。reviewer は範囲を git diff に渡すため、
  # git diff HEAD は「作業ツリー vs HEAD」になる。commit 直後は作業ツリーが
  # クリーンで差分が空になり、塞いだはずの素通りがそのまま復活する。
  # （git log HEAD が全履歴を指すのとは意味が違う。verify-commit-identity.sh の
  #   resolve_range が HEAD へ落とすのは git log に渡すためで、こことは別。）
  #
  # 空ツリーのハッシュはオブジェクト形式（sha1 / sha256）で異なるため、
  # 定数を焼き込まず git に計算させる。
  local empty_tree
  empty_tree="$(git hash-object -t tree /dev/null 2>/dev/null || true)"
  if [[ -n "$empty_tree" ]] && range_has_diff "$empty_tree..HEAD"; then
    REVIEW_RANGE="$empty_tree..HEAD"
    REVIEW_RANGE_REASON="$fallback_reason; no default branch tracking ref either, reviewing the whole history"
    return 0
  fi

  # 空ツリーとの差分すら無い（実質空のリポジトリ）。
  REVIEW_NO_TARGET=1
}

# 第二意見の出力を記録へ残す（#806）。
#
# **実行失敗を「指摘あり」として記録しない。** `second-opinion-review.sh` は CLI の不在・
# 分割できない差分・API の失敗でも非 0 で終わるため、終了コードだけを見ると**レビューが
# 1 行も走っていないのに `verdict=findings` の記録が残る。** その記録は確認側を緑にするので、
# **レビューしていない head が「レビュー済み」として通る**（PR #814 の Copilot の指摘。
# 実測: あのスクリプトには `exit 1` の経路が 7 つあり、うち大半は実行失敗である）。
#
# **判定が出たことは、出力の中の完了の行で見る。** あのスクリプトは終わりに必ず
# `[second-opinion] LGTM (...)` か `[second-opinion] findings reported in ...` を出す。
# どちらも無ければ、途中で落ちたということなので記録しない。
#
# **完了の行を要求するのは既定の reviewer のときだけである。** 差し替えた reviewer
# （`LOOP_GATE_REVIEW_CMD`）は当然この綴りを出さないので、要求すると**正常に終わった
# レビューまで「判定に到達しなかった」として記録しなくなる**——確認側が必ず赤になり、
# 差し替えを使う人には「回したのに回していないと言われる」形になる（PR #814 の第二意見の
# 指摘。**私が足した 2 つの直しが互いに矛盾していた。** しかも最初の試験は、偽の reviewer に
# 既定の印を出力させていたので通ってしまった——**通るように作った試験は、何も確かめていない**）。
#
# **差し替え経路では、実行失敗と指摘を区別できない。** 規範は「重大な指摘がなければ通過を
# 示す一意な判定トークンを出力の最後の行に返すこと」としか定めておらず、その綴りは
# プロジェクト層が決める。loop-gate からは読めないので、終了コードだけで判定する。
# **記録の `engine` が `custom` になるので、後から見たときに区別できる。**
#
# 引数: 1=出力を捕まえたファイル / 2=scope / 3=終了コード（0 なら pass）
#       4=完了の行を要求するか（1=する / 0=しない）
# 戻り値: 常に 0（記録の失敗でゲートの判定を変えない）
record_second_opinion() {
  local capture="$1" scope="$2" rc="$3" require_marker="${4:-1}"
  [[ -n "$scope" ]] || return 0
  [[ -s "$capture" ]] || return 0
  [[ -f "$HERE/second-opinion-record.sh" ]] || return 0

  if [[ "$require_marker" -eq 1 ]] \
    && ! grep -q -e '\[second-opinion\] LGTM ' -e '\[second-opinion\] findings reported in ' "$capture"; then
    echo "[loop-gate] 第二意見は判定に到達しませんでした（実行失敗）。記録は残しません。" >&2
    echo "[loop-gate] 記録が無いので、push すると確認側が赤を出します。原因を直してから回し直してください。" >&2
    return 0
  fi

  local engine runs verdict
  # engine と回数は**出力から読む**（環境変数から読むと、上書きされた実際の値と
  # 食い違う。`docs/handoff.md` の「既定値から結論しない」）。
  engine="$(sed -n 's/.*(engine=\([^,)]*\).*/\1/p' "$capture" | head -1)"
  # 差し替え経路で出力から engine が読めないときは `custom` と記録する。**`unknown` に
  # しない**——「読めなかった」と「差し替えた reviewer だった」は別の事実である。
  [[ -n "$engine" || "$require_marker" -eq 1 ]] || engine=custom
  runs="$(sed -n 's/.*runs=\([0-9]*\).*/\1/p' "$capture" | head -1)"
  verdict=pass
  [[ "$rc" -eq 0 ]] || verdict=findings

  bash "$HERE/second-opinion-record.sh" save \
    --engine "${engine:-unknown}" \
    --verdict "$verdict" \
    --scope "$scope" \
    --runs "${runs:-1}" \
    < "$capture" \
    || echo "[loop-gate] WARN: 第二意見の記録を残せませんでした（ゲートの判定は変えません）" >&2
  return 0
}

main() {
  # verify・第二意見（git diff 等）はプロジェクトルート基準で実行する。
  # scripts/ の 1 階層上がルート。任意の作業ディレクトリから起動しても不変にする。
  #
  # cd を本体側へ置くのは、source した呼び出し元の作業ディレクトリを動かさない
  # ため。範囲解決の回帰テストは、使い捨ての git リポジトリへ cd してから
  # resolve_review_range を呼ぶ。
  cd "$(dirname "$HERE")"

  # step 1 を identity にするのは、**いちばん安く、いちばん遅く露見する**からである。
  # 判定は 5ms 程度で終わるのに対し、見逃すと CI の identity-guard まで分からず、
  # そこで落ちたときには既に PR が出ている。**混入したコミットは push 済みなので、
  # 直すには履歴の書き換えと force push が要る**（波 1 で実際に踏んだ。#210）。
  #
  # **並列作業で落ちやすい。** identity は `.git/config` で全 worktree が共有する
  # （`extensions.worktreeConfig` は無効）。**共有しているからこそ、どれか 1 つの
  # worktree で `git config user.email` を打つと全部が汚れる。** 波 1 では 3 レーンの
  # うち 1 つだけが許可外 identity でコミットしており、作業の途中で共有 config が
  # 書き換わったことになる。**ここまでは CI だけが見ていた**（verify.sh にも
  # acceptance.sh にも入っていない）。
  #
  # 許可 email の解決は verify-commit-identity.sh が持つ。**解決できなければ
  # 通過させず落ちる**（fail-closed）ので、ここで別途の分岐を足さない。
  # worktree から実行しても load-project-env.sh がメインの作業コピーの .env へ
  # 回り込むため、`.env` を worktree へ複製する必要はない。
  echo "[loop-gate] step 1: commit identity"
  if ! bash "$HERE/verify-commit-identity.sh"; then
    echo "[loop-gate] commit identity not passed" >&2
    echo "GATE_FAIL"
    exit 1
  fi

  echo "[loop-gate] step 2: verify (acceptance)"
  if ! bash "$HERE/verify.sh"; then
    echo "[loop-gate] verify not passed" >&2
    echo "GATE_FAIL"
    exit 1
  fi

  echo "[loop-gate] step 3: second opinion"
  if [[ "${LOOP_GATE_REVIEW_CMD-__UNSET__}" == "__UNSET__" ]]; then
    if [[ -f "$HERE/second-opinion-review.sh" ]]; then
      resolve_review_range
      local review_ok=0
      # 出力を捕まえる（#806）。**回し直しでは代われない**——第二意見は非決定的で、
      # 同じ差分でも実行のたびに結果が変わる（review-workflow.md の「第二意見の非決定性」。
      # 実測で同一コミットの 4 回が LGTM 2 回・指摘あり 2 回に分かれた）。記録に残すべきは
      # **push を通したその実行**なので、ここで捕まえるしかない。
      #
      # `tee` で通すので、利用者に見える出力は変わらない。`pipefail` が効いているため、
      # レビュー側の終了コードは `tee` に隠れない。
      local so_capture so_scope=""
      so_capture="$(mktemp "${TMPDIR:-/tmp}/loop-gate-second-opinion.XXXXXX")"
      if [[ -n "$REVIEW_RANGE" ]]; then
        # 上流以外を起点に採ったなら、その理由を先に出す。黙って範囲を変えると、
        # なぜその差分がレビュー対象なのかを読み手が追えない。
        if [[ -n "$REVIEW_RANGE_REASON" ]]; then
          echo "[loop-gate] $REVIEW_RANGE_REASON"
        fi
        echo "[loop-gate] staged diff is empty; reviewing $REVIEW_RANGE"
        bash "$HERE/second-opinion-review.sh" --range "$REVIEW_RANGE" 2>&1 \
          | tee "$so_capture" || review_ok=1
        so_scope="range:$REVIEW_RANGE"
      elif [[ "$REVIEW_NO_TARGET" -eq 1 ]]; then
        # レビューできる差分が 1 行も無い。第二意見を呼んでも対象が無いため、
        # その事実を明示したうえで通過させる（空を FAIL にすると、差分の無い
        # 状態でのゲート実行が落ちる）。黙って通すと偽の緑と区別が付かない。
        #
        # **記録も残さない。** レビューしていないものを「レビュー済み」として記録すると、
        # 確認側（second-opinion-gate.yml）が偽の緑を出す。記録が無ければ赤が出るので、
        # 気づける側へ倒す。
        echo "[loop-gate] no reviewable diff; second opinion has nothing to review"
      else
        bash "$HERE/second-opinion-review.sh" 2>&1 | tee "$so_capture" || review_ok=1
        so_scope="staged"
      fi

      # 記録は**判定の前に**残す。指摘が出た実行も記録に値する（何が出たのかが
      # 残らないと、直したのか黙って落としたのかを後から確かめられない）。
      record_second_opinion "$so_capture" "$so_scope" "$review_ok"
      rm -f "$so_capture"

      if [[ "$review_ok" -ne 0 ]]; then
        echo "[loop-gate] second opinion reported findings" >&2
        echo "GATE_FAIL"
        exit 1
      fi
    else
      echo "[loop-gate] SKIP (no reviewer present)"
    fi
  elif [[ -n "$LOOP_GATE_REVIEW_CMD" ]]; then
    # **差し替えた reviewer でも記録を残す**（#806 / PR #814 の Copilot の指摘）。
    # 残さないと、差し替えを使っている人はローカルのゲートを通しても**確認側が必ず赤に
    # なる**——回したのに回していないと言われる形で、機構への信頼を壊す。
    #
    # **scope は `staged` とみなす。** 差し替えた側が何をレビューしたかは、ここからは
    # 分からない。既定の reviewer の既定が `staged` で、規範も「差分を渡して非対話で実行する」
    # と定めているので、その前提に揃える。**別の範囲をレビューする reviewer を差し替えるなら、
    # 記録も自分で残すこと**（`scripts/second-opinion-record.sh save` を呼ぶ）。
    local cmd_capture cmd_ok=0
    cmd_capture="$(mktemp "${TMPDIR:-/tmp}/loop-gate-second-opinion.XXXXXX")"
    bash -c "$LOOP_GATE_REVIEW_CMD" 2>&1 | tee "$cmd_capture" || cmd_ok=1
    record_second_opinion "$cmd_capture" "staged" "$cmd_ok" 0
    rm -f "$cmd_capture"
    if [[ "$cmd_ok" -ne 0 ]]; then
      echo "[loop-gate] second opinion reported findings" >&2
      echo "GATE_FAIL"
      exit 1
    fi
  else
    # **記録を残さない。** レビューを明示的に止めた状態なので、記録が無いのが正しい。
    # push すれば確認側が赤を出す——**それは不具合ではなく、止めたことが見えている形である。**
    echo "[loop-gate] SKIP (disabled by LOOP_GATE_REVIEW_CMD='')"
    echo "[loop-gate] 第二意見を止めたので記録も残しません。push すると確認側が赤を出します。"
  fi

  echo "GATE_PASS"
  exit 0
}

# source ガード。読み込まれただけのときはゲート本体を実行せず、関数定義だけを
# 提供する。範囲解決の回帰テストが resolve_review_range を単体で呼べるようにする
# ため（ガードが無いと、テストが読み込んだだけでゲートが走り出す）。
#
# 逆に、実行されたのに main を呼び損ねると、何も検証しないまま終了コード 0 を
# 返す偽の緑になる。ゲートの出力（step 1 / GATE_PASS / GATE_FAIL）が実行時に必ず
# 現れることを、テスト側で併せて検査すること。
if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
fi