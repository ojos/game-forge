#!/usr/bin/env bash
# loop-gate.sh — ローカル事前ゲート（ループコーディングの収束点）
#
# push / PR 作成の前に、コミット identity の検証（verify-commit-identity.sh）、
# 機械判定の受け入れ検証（verify.sh）、任意の第二意見レビューを直列で通す単一入口。
# 全段が通ったときだけ通過する。
#
# 段の順序（安く・早く落ちる検査を先に置く）:
#   1. commit identity（verify-commit-identity.sh） — 判定は数 ms で終わる。許可外の
#      identity が混じったコミットは、他の段の結果を待たずにここで検知する。許可
#      email（ALLOWED_AUTHOR_EMAILS / .env の GIT_IDENTITY_EMAIL）を解決できない
#      場合もここで fail-closed に落ちる。判定ロジックはこのスクリプトへ書き写さず
#      verify-commit-identity.sh 側に置く（判定を二重管理しない）。
#   2. verify（受け入れ検証。手前で機密混入検査も走る）
#   3. 第二意見レビュー（存在すれば）
#
# このスクリプトは単体で動作する。第二意見レビューは存在すれば直列化し、
# 無ければ優雅にスキップする（外部パッケージの導入を前提にしない）。
#
# 第二意見レビュー:
#   既定で scripts/second-opinion-review.sh があれば実行する。
#   LOOP_GATE_REVIEW_CMD で任意のコマンドへ差し替え可能。空文字でスキップする。
#   差し替えたコマンドへは、解決した範囲を環境変数 LOOP_GATE_REVIEW_RANGE で渡す
#   （ステージ済みがあるとき・対象が無いときは空）。
#
#   **既定の対象は PR 全体にする。** 第二意見のエンジンは差分をプロンプトへ埋め込み、
#   差分の外を読まない形を基本にする。修正を重ねた後の小さな差分（ステージ済みだけ、
#   上流からだけ）を渡すと、差分に現れない既存のコードについて誤った前提を立てて落ちる。
#   そこで起点を、既定ブランチ（origin/HEAD → origin/main → origin/master の順）と
#   HEAD の分岐点にする。
#     - ステージ済み差分があるとき: --base <起点> で、起点から索引までを渡す
#       （コミット済みの分とステージ済みの分の両方が入る）。
#     - ステージ済みが空のとき: --range <起点>..HEAD を渡す。上流があっても、
#       上流からではなく起点から。
#   起点に分岐点（merge-base）を使うのは、既定ブランチ側に進んだコミットを
#   「打ち消し」として差分へ混ぜないため。既定ブランチを取り込んでいれば分岐点が
#   取り込み地点まで進むので、取り込んだ他ブランチの成果は範囲から外れる。
#   既定ブランチの追跡枝は fetch しない（手元の追跡枝が古ければ古い起点になる）。
#
#   既定ブランチを解決できないときだけ、従来の決め方に戻る。ステージ済みがあれば
#   reviewer の既定（ステージ済み差分）に委ね、空なら「上流 → HEAD」、上流も無ければ
#   空ツリーからのリポジトリ全体を対象にする。
#
#   範囲が空（起点と HEAD に差分が無い）のときは、レビュー対象が無いことを明示した
#   うえで通過する（空を一律 FAIL にすると、差分の無い状態でのゲート実行が落ちるため）。
#   ステージ済みが空のまま reviewer の既定へ流すと、空の差分を見て「対象なし」で
#   通る偽の緑になるので、commit 済み範囲を必ず明示して渡す。
#
# 第二意見の記録:
#   第二意見は手元でしか走らず、受け入れ検証のように CI が再実行して確かめられない。
#   回したことを記録に残し、確認側（second-opinion-gate.yml）が push 後の別の契機で
#   「回し忘れ」を検出する（規範: review-workflow.md「要求されたことを別の契機で
#   確認する」）。scripts/second-opinion-record.sh が存在するときだけ記録し、
#   無ければ記録せず静かに進む（第二意見そのものと同じ「外部パッケージの導入を
#   前提にしない」方針）。
#
# 終了コード:
#   0 = GATE_PASS（全段通過。push 可）
#   1 = GATE_FAIL（いずれかの段が未通過、または実行不能）
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# 既定の reviewer へ渡す引数を決める。
#
# 既定ブランチとの分岐点が解決できれば、それを起点にする（冒頭「既定の対象は PR 全体」）。
# ステージ済みがあれば REVIEW_BASE（--base の値）、空なら REVIEW_RANGE（--range の値）。
# 既定ブランチを解決できないときだけ従来の決め方に戻り、ステージ済みがあれば何も
# 渡さず（reviewer 側の既定に委ねる）、空なら上流 → 空ツリーの順に範囲を決める。
# git リポジトリでない場合や範囲を解決できない場合は、従来どおり引数なしで呼ぶ。
# 範囲を解決できないことは reviewer を呼べない理由にならないため、ここでは落とさない。
#
# なお、git 管理外ではこの関数へ到達する前に、先行する段で必ず落ちる。commit
# identity 検査（step 1）は git log を、verify.sh が呼ぶ機密混入検査（step 2 の中、
# check-no-secrets.sh）は git の作業ツリーを前提にしており、検査が成立しない状態を
# 合格にしないため。この関数が git 外の経路を持つのは、範囲解決を単体で使える
# ようにしておくためである。
REVIEW_RANGE=""
# ステージ済み差分があるときの起点（reviewer の --base へ渡す）。REVIEW_RANGE とは
# 排他で、どちらか一方だけが入る。
REVIEW_BASE=""
# 範囲は解決できたが差分が空だった（= レビューできる対象が無い）状態を表す。
# REVIEW_RANGE="" とは区別する。この状態を reviewer の既定へ流すと、空の
# ステージ済み差分を見せることになり、塞いだはずの素通りへ戻るため。
REVIEW_NO_TARGET=0
# 起点をどう決めたかの説明。黙って範囲を変えると、なぜその差分がレビュー対象なのかを
# 読み手が追えないため、採用時に 1 行出力する。
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
# 追跡枝は fetch しない。手元の追跡枝が古ければ、起点も古くなる。
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

# 既定ブランチを解決できないときの決め方（従来の決め方）。ステージ済みが空のときだけ呼ぶ。
#
# 上流が設定されていればそこからの差分。未 push のコミットがそのまま対象になる。
# push 済みで上流 == HEAD だと差分が空になる。remote があるのに既定ブランチの追跡枝が
# 無いなら、空ツリー（= リポジトリ全体）へは広げずレビュー対象なしとして扱う。
resolve_review_range_without_base() {
  local upstream upstream_empty=0
  upstream="$(git rev-parse --abbrev-ref --symbolic-full-name '@{upstream}' 2>/dev/null || true)"
  if [[ -n "$upstream" ]]; then
    # **起点は上流の先端ではなく、上流と HEAD の分岐点にする。** 範囲は両端のツリーの
    # 差になるので、上流が分岐点より先へ進んでいると、上流側だけの変更を取り消す差分が
    # 混ざる。
    local upstream_mb
    upstream_mb="$(git merge-base "$upstream" HEAD 2>/dev/null || true)"
    [[ -n "$upstream_mb" ]] || upstream_mb="$upstream"
    if range_has_diff "$upstream_mb..HEAD"; then
      REVIEW_RANGE="$upstream_mb..HEAD"
      REVIEW_RANGE_REASON="no default branch tracking ref was found; reviewing from the merge-base ${upstream_mb:0:12} with the upstream $upstream"
      return 0
    fi
    # 上流との差分が空（push 済み）。ここで対象なしとして通すと、第二意見が一度も
    # 差分を見ないまま通る偽の緑になる。以前と同じく、下の空ツリーからの全体へ戻る。
    upstream_empty=1
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
    if [[ "$upstream_empty" -eq 1 ]]; then
      REVIEW_RANGE_REASON="no default branch tracking ref was found and the upstream range has no diff (branch already pushed); reviewing the whole history"
    else
      REVIEW_RANGE_REASON="no default branch tracking ref and no upstream; reviewing the whole history"
    fi
    return 0
  fi

  # 空ツリーとの差分すら無い（実質空のリポジトリ）。
  REVIEW_NO_TARGET=1
}

resolve_review_range() {
  command -v git >/dev/null 2>&1 || return 0
  git rev-parse --git-dir >/dev/null 2>&1 || return 0
  local staged=0
  git diff --cached --quiet || staged=1
  # コミットが 1 件も無ければ比較の起点を作れない。
  git rev-parse --verify --quiet HEAD >/dev/null || return 0

  # 既定ブランチとの分岐点を起点にして、PR 全体を対象にする。
  local base mb
  base="$(resolve_integration_base || true)"
  if [[ -n "$base" ]]; then
    mb="$(git merge-base "$base" HEAD 2>/dev/null || true)"
    if [[ -n "$mb" ]]; then
      REVIEW_RANGE_REASON="reviewing the whole PR from the merge-base ${mb:0:12} with $base"
      if [[ "$staged" -eq 1 ]]; then
        if git diff --cached --quiet "$mb" -- 2>/dev/null; then
          # 起点から索引までの差が空（コミットした変更を索引で取り消した等）。
          # reviewer を呼ぶと「対象なし」を返し、対象が実在すると見なして落ちる。
          REVIEW_RANGE_REASON=""
          REVIEW_NO_TARGET=1
        else
          REVIEW_BASE="$mb"
        fi
      elif range_has_diff "$mb..HEAD"; then
        REVIEW_RANGE="$mb..HEAD"
      else
        # 既定ブランチの追跡枝が見つかった時点で起点は確定する。そこと差分が無いのは
        # 「レビュー対象が無い」であって、空ツリーまで戻してリポジトリ全体を対象に
        # すべき状況ではない。
        REVIEW_RANGE_REASON=""
        REVIEW_NO_TARGET=1
      fi
      return 0
    fi
  fi

  # 既定ブランチを解決できない（または履歴が繋がっていない）。従来の決め方に戻る。
  # ステージ済みがあれば reviewer の既定（ステージ済み差分）に委ねる。
  [[ "$staged" -eq 0 ]] || return 0
  resolve_review_range_without_base
}

# 第二意見の出力を記録へ残す。
#
# **実行失敗を「指摘あり」として記録しない。** second-opinion-review.sh は CLI の不在・
# 分割できない差分・API の失敗でも非 0 で終わるため、終了コードだけを見ると**レビューが
# 1 行も走っていないのに「指摘あり」の記録が残る。** その記録は確認側を緑にするので、
# **レビューしていない head が「レビュー済み」として通る。**
#
# **判定が出たことは、出力の中の完了の行で見る。** second-opinion-review.sh は
# 終わりに必ず最終集計の行を 1 つ出す。形は次の 3 つで、チャンク分割の有無で変わる。
#   `[second-opinion] LGTM (...)`
#   `[second-opinion] findings reported by N/M runs ...`（分割なし）
#   `[second-opinion] N/M chunks reported findings ...`（分割あり）
# どれも無ければ、途中で落ちたということなので記録しない。
#
# **行頭に固定し、チャンクごとの集計行に一致させない。** 分割時は各チャンクの後に
# `[second-opinion] chunk i/N: findings reported by ...` が出る。これを完了とみなすと、
# 後続のチャンクで CLI が落ちた未完了のレビューでも記録が残り、確認側が緑になる。
#
# **完了の行を要求するのは既定の reviewer のときだけである。** 差し替えた reviewer
# （LOOP_GATE_REVIEW_CMD）は当然この綴りを出さないので、要求すると**正常に終わった
# レビューまで「判定に到達しなかった」として記録しなくなる**——確認側が必ず赤になり、
# 差し替えを使う人には「回したのに回していないと言われる」形になる。
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
    && ! grep -q -E \
      -e '^\[second-opinion\] LGTM \(' \
      -e '^\[second-opinion\] findings reported by ' \
      -e '^\[second-opinion\] [0-9]+/[0-9]+ chunks reported findings' \
      "$capture"; then
    echo "[loop-gate] 第二意見は判定に到達しませんでした（実行失敗）。記録は残しません。" >&2
    echo "[loop-gate] 記録が無いので、push すると確認側が赤を出します。原因を直してから回し直してください。" >&2
    return 0
  fi

  local engine runs verdict
  # engine と回数は**出力から読む**（環境変数から読むと、上書きされた実際の値と
  # 食い違う）。
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
      # 出力を捕まえる。**回し直しでは代われない**——第二意見は非決定的で、同じ差分
      # でも実行のたびに結果が変わる（review-workflow.md「第二意見の非決定性」）。
      # 記録に残すべきは**push を通したその実行**なので、ここで捕まえるしかない。
      #
      # `tee` で通すので、利用者に見える出力は変わらない。`pipefail` が効いているため、
      # レビュー側の終了コードは `tee` に隠れない。
      local so_capture so_scope=""
      so_capture="$(mktemp "${TMPDIR:-/tmp}/loop-gate-second-opinion.XXXXXX")"
      if [[ -n "$REVIEW_BASE" ]]; then
        # ステージ済みがあるときは、起点から索引までを渡す（コミット済みとステージ済みの両方）。
        if [[ -n "$REVIEW_RANGE_REASON" ]]; then
          echo "[loop-gate] $REVIEW_RANGE_REASON"
        fi
        echo "[loop-gate] staged diff exists; reviewing from $REVIEW_BASE to the index"
        bash "$HERE/second-opinion-review.sh" --base "$REVIEW_BASE" 2>&1 \
          | tee "$so_capture" || review_ok=1
        so_scope="base:$REVIEW_BASE+staged"
      elif [[ -n "$REVIEW_RANGE" ]]; then
        # どう起点を決めたかを先に出す。黙って範囲を変えると、
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
    # **差し替えた reviewer でも記録を残す。** 残さないと、差し替えを使っている人は
    # ローカルのゲートを通しても**確認側が必ず赤になる**——回したのに回していないと
    # 言われる形で、機構への信頼を壊す。
    #
    # **既定の reviewer と同じ範囲を解決し、環境変数 LOOP_GATE_REVIEW_RANGE で渡す。**
    # ステージ済みが空のときだけ commit 済み範囲（`<from>..HEAD`）が入る。ステージ済み
    # があるとき・対象が無いときは空。差し替えた側が範囲を使いたければ、例えば
    # `bash scripts/second-opinion-review.sh --engine X ${LOOP_GATE_REVIEW_RANGE:+--range "$LOOP_GATE_REVIEW_RANGE"}`
    # のように受ける。**受けなければ、commit 済みのブランチで空のステージ済み差分を
    # 見て「対象なし」で終わる**ので、その出力を見たときは記録しない（下記）。
    #
    # **限界: loop-gate が「レビューしていない」と判定できるのは、差し替えたコマンドが
    # `[second-opinion] no diff to review` を出力したときだけである。** 範囲を使わず、この
    # 文言も出さない任意のコマンド（例: `true`）は、何もレビューしていなくても GATE_PASS と
    # 記録が出る。差し替えるコマンドは、範囲を `LOOP_GATE_REVIEW_RANGE` で受け取るか、
    # 自分で範囲を決めて自分で記録を残すこと。
    #
    # **scope は、範囲が解決できたら `range:<範囲>`、そうでなければ `staged` とみなす。**
    # 差し替えた側が何をレビューしたかは、ここからは分からない。**別の範囲を
    # レビューする reviewer を差し替えるなら、記録も自分で残すこと**
    # （`scripts/second-opinion-record.sh save` を呼ぶ）。
    #
    # **レビューしていないものは、記録せず、通過もさせない。**
    #   - 解決の結果が「対象が本当に無い」: 既定の経路と同じく、記録なしで通過する。
    #   - 対象が実在する（範囲あり、またはステージ済みあり）のに、差し替えた側が
    #     「対象なし」と出力した（範囲を受けていない）: レビューされていないので
    #     GATE_FAIL にし、記録も作らない。通すと手元のゲートが偽の緑になる。
    resolve_review_range
    local cmd_capture cmd_ok=0 cmd_scope="staged" cmd_unreviewed=0 cmd_skip=0
    if [[ -n "$REVIEW_RANGE" ]]; then
      if [[ -n "$REVIEW_RANGE_REASON" ]]; then
        echo "[loop-gate] $REVIEW_RANGE_REASON"
      fi
      echo "[loop-gate] staged diff is empty; passing range $REVIEW_RANGE to the reviewer (LOOP_GATE_REVIEW_RANGE)"
      cmd_scope="range:$REVIEW_RANGE"
    elif [[ "$REVIEW_NO_TARGET" -eq 1 ]]; then
      # 対象が本当に無いときは、既定の経路と同じく差し替えたコマンドを実行しない。
      # 実行すると、対象が無いのにコマンドの終了コード次第で GATE_FAIL になる。
      echo "[loop-gate] no reviewable diff; second opinion has nothing to review"
      cmd_scope=""
      cmd_skip=1
    fi
    cmd_capture="$(mktemp "${TMPDIR:-/tmp}/loop-gate-second-opinion.XXXXXX")"
    if [[ "$cmd_skip" -eq 0 ]]; then
      LOOP_GATE_REVIEW_RANGE="$REVIEW_RANGE" bash -c "$LOOP_GATE_REVIEW_CMD" 2>&1 | tee "$cmd_capture" || cmd_ok=1
    fi
    if [[ -n "$cmd_scope" ]] && grep -q -E '^\[second-opinion\] no diff to review' "$cmd_capture"; then
      echo "[loop-gate] 差し替えた第二意見は「レビュー対象なし」と出力しましたが、レビュー対象は実在します。レビューされていないので失敗とし、記録も残しません。" >&2
      echo "[loop-gate] 範囲を LOOP_GATE_REVIEW_RANGE で受け取ってください（規則「レビューの起動方法」参照）。" >&2
      cmd_scope=""
      cmd_ok=1
      cmd_unreviewed=1
    fi
    record_second_opinion "$cmd_capture" "$cmd_scope" "$cmd_ok" 0
    rm -f "$cmd_capture"
    if [[ "$cmd_ok" -ne 0 ]]; then
      if [[ "$cmd_unreviewed" -eq 0 ]]; then
        echo "[loop-gate] second opinion reported findings" >&2
      fi
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
