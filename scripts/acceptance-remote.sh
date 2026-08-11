#!/usr/bin/env bash
# acceptance-remote.sh — 外部層の受け入れ条件（プロジェクトが所有・編集する）
#
# 受け入れ条件はローカル層と外部層に分かれる。
#
#   ローカル層（scripts/acceptance.sh）  ネットワークも外部認証も要さない検査。
#                                        ループの接地信号。これが緑なら実装は前へ
#                                        進んでよい。
#   外部層（このファイル）               宣言（IaC 等）と実際の外部状態が一致して
#                                        いるかの検査。外部認証とネットワークを要する。
#
# 起動方法:
#   VERIFY_ACCEPTANCE=scripts/acceptance-remote.sh bash scripts/verify.sh
#
# scripts/loop-gate.sh へは含めない:
#   あちらは push / PR 前の単一入口だが、外部層をそこへ入れると、認証の失効や
#   オフラインでゲート全体が止まる。実装が正しいのにループが止まる状態を作らない。
#   単一入口の目的は「複数の検査を別々に思い出す運用は破綻する」ことを機構で塞ぐ
#   ことであって、外部の可用性をゲートの前提条件に持ち込むことではない。
#
# 通す契機:
#   外部状態の宣言を変更したとき。反復のたびに回す層ではない。
#
# 前提:
#   対象サービスへ認証済みであること。このスクリプトは認証を行わない（資格情報を
#   スクリプトへ書き写す経路を作らないため）。未認証やオフラインで回すと個々の検査が
#   失敗するが、それは「宣言と外部状態が食い違っている」ことを意味しない。前提の
#   不成立と実際の乖離を読み分けられるよう、前提の確認（ログイン状態の検査など）を
#   最初の検査として置くとよい。
#
# 終了コード: 0 = 合格 / 非0 = 不合格・未定義
#
# set -e は使わない。1 件目の失敗で止めず、全件を見てから落とすため。
set -uo pipefail

# 検証はプロジェクトルート基準で行う。scripts/ の 1 階層上がルート。
# 任意の作業ディレクトリから起動しても結果が不変になるよう、起動時 CWD に依存しない。
#
# set -e を使わないため、失敗しうる代入には個別にガードを置く。HERE の解決に失敗
# しても止めないと、空の HERE に対して dirname が "." を返し、続く cd が「成功」して
# ガードを素通りする（実測: dirname "" = "." で cd は 0）。ルートへ移れていないのに
# 検査を始めると、相対パスが別の場所を指したまま合否を出すことになる。
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)" || exit 1
cd "$(dirname "$HERE")" || exit 1

echo "[acceptance-remote] external state checks"

# 実際に検査を 1 つでも実行したか。1 つも実行できなければ「合格」ではなく失敗にする。
# 検証していないことを合格として報告するのが最悪であるため。
ran_any=0
# 失敗件数。外部状態の乖離は複数箇所へ同時に出ることが多く、1 件ずつ往復すると
# 回数だけ増える。
failed=0

# 各検査の出力を退避する一時ログ。mktemp のテンプレートで作り、$$ 由来の予測可能な
# 名前は使わない（同名を先に置かれると書き込み先を乗っ取られる）。
#
# ここも代入ガードを置く（set -e が無いため）。作成に失敗したまま進むと LOG が空になり、
# run の中の >"$LOG" が必ず失敗して、実行できていない検査が「失敗した検査」として
# 報告される（実測: 空の対象へのリダイレクトは rc=1）。原因の異なる赤を同じ形で
# 出さないよう、ここで落とす。
LOG="$(mktemp "${TMPDIR:-/tmp}/acceptance-remote.XXXXXX")" || exit 1
trap 'rm -f "$LOG"' EXIT

# ラベル付きで 1 件実行する。成功時は出力を捨て、失敗したときだけ出力を見せる。
# 正常な実行の出力で画面が埋まると、失敗の位置が読めなくなる。
#
#   run "<ラベル>" <コマンド> [引数...]
#
# サブシェル（パイプの構成要素・コマンド置換・( ) の中）から呼ばないこと。
# ran_any と failed の更新が親へ伝わらず、実行したのに「未定義」、失敗したのに
# 合格という報告になる。
run() {
  local label="$1"
  shift
  ran_any=1
  printf '[acceptance-remote] %s\n' "$label"
  if "$@" >"$LOG" 2>&1; then
    return 0
  fi
  failed=$((failed + 1))
  printf '[acceptance-remote] FAIL: %s\n' "$label" >&2
  sed 's/^/    /' "$LOG" >&2
  return 1
}

# ── 外部状態の検査 ──────────────────────────────────────────────────────────
#
# 対象は GitHub 上のリポジトリ状態で、宣言は terraform/ にある。
#
# 検査対象の識別子（owner/repo、既定ブランチ名、必須チェック名、可視性）は、すべて
# terraform の output から取る。ここへ書き写すと、宣言を変えたときに検査だけが古い
# 対象・古い期待値を見続ける（shared-ai-rules.md 12 章「一覧の複製は機械照合で担保する」）。

TF_DIR="terraform"

# 前提の確認を最初に置く。未認証やオフラインでの失敗は「宣言と外部状態の乖離」では
# ないため、乖離の検査より前に、前提の不成立として先に見えるようにする。
run "prerequisite: gh authenticated" gh auth status

# terraform 自身も外部（プロバイダレジストリ）へ出る。init 済みでなければ plan は
# 実行できないため、ここで冪等に通す。
run "terraform init" terraform -chdir="$TF_DIR" init -input=false -upgrade=false

# 宣言と実状態の一致。-detailed-exitcode は差分なしで 0、差分ありで 2、エラーで 1 を返す。
# 差分ありを合格にしないため、非0 をそのまま失敗として扱う。
run "terraform plan: no drift" terraform -chdir="$TF_DIR" plan -detailed-exitcode -input=false

# 以降の検査は output を期待値として使う。plan が通っていない状態では output も
# 信頼できないため、取得できなければ個々の検査を失敗させる。
tf_output() {
  terraform -chdir="$TF_DIR" output -raw "$1" 2>/dev/null
}

##
# 宣言したリポジトリが実在し、可視性が宣言と一致することを確認する。
#
# 出力: 不一致・取得失敗の内容を標準出力へ書く（run が失敗時のみ表示する）
# 戻り値: 0 = 一致 / 1 = 不一致または取得失敗
##
check_repository() {
  local full_name expected_visibility actual_visibility
  full_name="$(tf_output repository_full_name)" || return 1
  expected_visibility="$(tf_output repository_visibility)" || return 1
  if [[ -z "$full_name" || -z "$expected_visibility" ]]; then
    echo "terraform output からリポジトリ識別子を取得できません。apply 済みか確認すること。"
    return 1
  fi

  actual_visibility="$(gh api "repos/${full_name}" --jq '.visibility')" || return 1
  if [[ "$actual_visibility" != "$expected_visibility" ]]; then
    echo "可視性が宣言と一致しません: expected=${expected_visibility} actual=${actual_visibility}"
    return 1
  fi
  echo "repository ${full_name} exists (visibility=${actual_visibility})"
}

##
# 既定ブランチが宣言どおりであることを確認する。
#
# 戻り値: 0 = 一致 / 1 = 不一致または取得失敗
##
check_default_branch() {
  local full_name expected actual
  full_name="$(tf_output repository_full_name)" || return 1
  expected="$(tf_output default_branch)" || return 1
  actual="$(gh api "repos/${full_name}" --jq '.default_branch')" || return 1
  if [[ "$actual" != "$expected" ]]; then
    echo "既定ブランチが宣言と一致しません: expected=${expected} actual=${actual}"
    return 1
  fi
  echo "default branch = ${actual}"
}

##
# 既定ブランチの保護が宣言どおりであることを確認する。
#
# 必須チェック名は集合として比較する（順序差で落とさない）。force push とブランチ削除の
# 禁止は、宣言側で緩めない前提の項目なので、実状態が有効になっていないことを失敗にする。
#
# 戻り値: 0 = 一致 / 1 = 不一致または取得失敗
##
check_branch_protection() {
  local full_name branch protection expected_contexts actual_contexts
  full_name="$(tf_output repository_full_name)" || return 1
  branch="$(tf_output default_branch)" || return 1

  protection="$(gh api "repos/${full_name}/branches/${branch}/protection")" || return 1

  expected_contexts="$(terraform -chdir="$TF_DIR" output -json required_status_checks | jq -S 'sort')" || return 1
  actual_contexts="$(jq -S '.required_status_checks.contexts | sort' <<<"$protection")" || return 1
  if [[ "$expected_contexts" != "$actual_contexts" ]]; then
    echo "必須ステータスチェックが宣言と一致しません: expected=${expected_contexts} actual=${actual_contexts}"
    return 1
  fi

  if [[ "$(jq -r '.allow_force_pushes.enabled' <<<"$protection")" != "false" ]]; then
    echo "force push が禁止されていません。"
    return 1
  fi
  if [[ "$(jq -r '.allow_deletions.enabled' <<<"$protection")" != "false" ]]; then
    echo "ブランチ削除が禁止されていません。"
    return 1
  fi
  if ! jq -e '.required_pull_request_reviews' <<<"$protection" >/dev/null; then
    echo "PR 必須の設定がありません。直接 push が通る状態です。"
    return 1
  fi
  echo "branch protection on ${branch} matches the declaration"
}

##
# Actions 変数 ALLOWED_AUTHOR_EMAILS が宣言どおりの値で存在することを確認する。
#
# この変数が欠けると identity-guard.yml の照合が全件不一致になるため、存在だけでなく
# 値まで突き合わせる。
#
# 戻り値: 0 = 一致 / 1 = 不一致または取得失敗
##
check_actions_variable() {
  local full_name expected actual
  full_name="$(tf_output repository_full_name)" || return 1
  expected="$(tf_output allowed_author_emails)" || return 1
  if [[ -z "$expected" ]]; then
    echo "宣言側から ALLOWED_AUTHOR_EMAILS の値を取得できません。"
    return 1
  fi

  actual="$(gh api "repos/${full_name}/actions/variables/ALLOWED_AUTHOR_EMAILS" --jq '.value')" || return 1
  if [[ "$actual" != "$expected" ]]; then
    echo "ALLOWED_AUTHOR_EMAILS が宣言と一致しません。"
    return 1
  fi
  echo "actions variable ALLOWED_AUTHOR_EMAILS matches the declaration"
}

run "repository exists and visibility matches" check_repository
run "default branch matches" check_default_branch
run "branch protection matches" check_branch_protection
run "actions variable matches" check_actions_variable

if [[ "$ran_any" -eq 0 ]]; then
  echo "[acceptance-remote] 外部層の受け入れ条件が未定義です。検査を 1 つも実行していません。" >&2
  echo "[acceptance-remote] 宣言と実際の外部状態を照合する検査を scripts/acceptance-remote.sh へ定義してください。" >&2
  exit 1
fi

if [[ "$failed" -gt 0 ]]; then
  echo "[acceptance-remote] $failed 件の検査が失敗しました。" >&2
  echo "[acceptance-remote] 対象サービスへ認証済みか、ネットワークへ到達できるかを先に確認すること。" >&2
  exit 1
fi

echo "[acceptance-remote] OK"