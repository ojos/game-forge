#!/usr/bin/env bash
# verify-commit-identity.sh — コミット identity の検証ゲート
#
# コミットの author / committer / Co-Authored-By に、許可外の identity が
# 混入していないことを検証する。GitHub の Contributors は既定ブランチの
# コミット author（email）で集計されるため、email で判定する。
#
# 背景:
#   git identity の適用漏れにより、別アカウントの identity のコミットが
#   main に直接入り、Contributors に意図しないアカウントが現れる事故が起きる。
#   setup-git-identity.sh が適用漏れ（穴）を塞ぎ、このスクリプトが検知層になる。
#
# 名前ではなく email のみで判定する:
#   同じアカウントでも表記が揺れる（ローカル profile と GitHub の squash merge で
#   name が異なる）。名前で判定すると表記揺れで落ちるだけで、アカウントの
#   取り違えは防げない。
#
# 許可 email の与え方:
#   author の許可 email は次の順で解決する。固有 email はスクリプトに焼き込まない。
#     1. 環境変数 ALLOWED_AUTHOR_EMAILS（カンマ/空白区切り）。
#        CI はリポジトリ変数（vars.ALLOWED_AUTHOR_EMAILS）を env 経由で渡す。
#     2. 未設定なら .env の GIT_IDENTITY_EMAIL（コンテナ内の唯一の供給元）。
#   どちらでも解決できなければ「検査対象が無いので通過」にせず、fail-closed で落とす。
#   committer には常に noreply@github.com を、Co-Authored-By には加えて
#   noreply@anthropic.com を許可する（GitHub 上の squash merge / web UI コミットの
#   committer、および AI コーディング規約の trailer に対応）。
#
# 使い方:
#   bash scripts/verify-commit-identity.sh                # origin/main..HEAD
#   bash scripts/verify-commit-identity.sh <range>        # 任意の範囲
#   bash scripts/verify-commit-identity.sh --full         # HEAD の全履歴
#
# --full は HEAD の全履歴であって git rev-list --all ではない。--all は
# refs/original/（filter-branch のバックアップ）や全 remote-tracking ブランチ
# まで拾い、検査対象がチェックアウト環境ごとにぶれる。
#
# 終了コード:
#   0 = IDENTITY_PASS（許可外の identity なし）
#   1 = IDENTITY_FAIL（許可外の identity を検出、または範囲/許可 email が解決できない）
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$(dirname "$HERE")"

ALLOWED_AUTHOR_EMAILS_ARR=()
ALLOWED_COMMITTER_EMAILS_ARR=()
ALLOWED_COAUTHOR_EMAILS_ARR=()

# author の許可 email を解決する。env ALLOWED_AUTHOR_EMAILS を最優先し、
# 無ければ .env の GIT_IDENTITY_EMAIL を使う（CI では .env が無いため前者だけが効く）。
resolve_allowed_author_emails() {
  local raw="${ALLOWED_AUTHOR_EMAILS:-}"
  if [[ -z "$raw" ]]; then
    # 環境に値があっても必ずローダーを通す。load-project-env.sh は .env を後勝ちで
    # 上書きする契約であり、「.env が唯一の供給元」を保つには常に通す必要がある。
    # 未設定のときだけ読むと、シェルへ手で export した古い値が .env に勝つ。
    if [[ -f "$HERE/load-project-env.sh" ]]; then
      # shellcheck source=/dev/null
      . "$HERE/load-project-env.sh"
    fi
    raw="${GIT_IDENTITY_EMAIL:-}"
  fi
  # カンマ区切りも空白区切りも受ける。
  printf '%s' "${raw//,/ }"
}

init_allowlists() {
  local resolved
  resolved="$(resolve_allowed_author_emails)"
  # 単語分割だけを行い、パス名展開は行わせない。クォートなしの配列代入
  # （ARR=($resolved)）は分割と同時に glob 展開もするため、許可 email に
  # '*' や '?' が含まれると、許可リストが「検査対象リポジトリにどのファイルが
  # 存在するか」で変わる。検知層の判定が検査対象の中身に左右されるのは、
  # fail-closed 設計の意味を失わせる。here-string は末尾に改行を付けるので
  # set -e 下でも read は 0 を返し、空文字なら空配列になって下の検査に落ちる。
  read -r -a ALLOWED_AUTHOR_EMAILS_ARR <<<"$resolved"

  if [[ "${#ALLOWED_AUTHOR_EMAILS_ARR[@]}" -eq 0 ]]; then
    echo "[identity] 許可 author email が解決できません。" >&2
    echo "[identity] CI はリポジトリ変数 ALLOWED_AUTHOR_EMAILS を、コンテナは .env の GIT_IDENTITY_EMAIL を設定してください。" >&2
    echo "IDENTITY_FAIL"
    exit 1
  fi

  # committer は squash merge / web UI の noreply@github.com を許可。
  ALLOWED_COMMITTER_EMAILS_ARR=("${ALLOWED_AUTHOR_EMAILS_ARR[@]}" "noreply@github.com")
  # Co-Authored-By は加えて AI コーディング規約の trailer を許可。
  ALLOWED_COAUTHOR_EMAILS_ARR=("${ALLOWED_AUTHOR_EMAILS_ARR[@]}" "noreply@github.com" "noreply@anthropic.com")
}

# 許可エントリは既定で完全一致。加えて "@example.com" / "*@example.com" の形だけを
# ドメイン一括許可として解釈する。
#
# ドメイン形に限定するのは、任意の glob を許すと設定ミスの '*' 1 文字で全 email が
# 通り、検知層が黙って無効化されるため。形を限定しておけば、書き間違えても影響範囲は
# そのドメインに閉じる。'*' 単体はどちらの形にも当たらず、何も許可しない。
#
# 大文字小文字は区別する（既存の完全一致と同じ扱い）。git の email は通常小文字で、
# ここだけ緩めると判定基準が 2 種類になる。
is_allowed() {
  local needle="$1"
  shift
  local candidate domain
  for candidate in "$@"; do
    [[ "$needle" == "$candidate" ]] && return 0

    case "$candidate" in
      '*@'*) domain="${candidate#\*}" ;;
      '@'*)  domain="$candidate" ;;
      *)     continue ;;
    esac
    # ローカル部が 1 文字以上あることを要求する。"@example.com" という email
    # そのものを許可しないため。
    #
    # あわせてローカル部に @ が無いことを要求する。末尾一致だけで見ると
    # "attacker@untrusted.com@example.com" のような @ を 2 つ持つ email が
    # 通る。git は author email を検証しないため、この形は実際に作れる。
    [[ "$needle" == ?*"$domain" && "${needle%"$domain"}" != *@* ]] && return 0
  done
  return 1
}

# GitHub 上の操作（PR のマージ、web UI での編集）で作られたコミットかを判定する。
#
# GitHub 側で「メールアドレスを非公開にする」を有効にしていると、これらのコミットの
# author は <login>@users.noreply.github.com（または <id>+<login>@...）になる。
# committer は常に noreply@github.com。ローカルの identity 適用漏れとは発生経路が
# 別で、許可リストに個別の email を足して回っても、メンバーが増えるたびに同じ穴が開く。
#
# 許可は「committer が noreply@github.com であること」に縛る。GitHub 自身が作成した
# コミットに限定され、ローカルで作ったコミットには適用されない。
#
# トレードオフ: リポジトリへの書き込み権限を持つアカウントであれば、その GitHub
# アカウントが Contributors に現れることを許容する。この検知層が塞ぐのはローカルの
# identity 適用漏れ（別アカウントの個人 email の混入）であり、誰に書き込み権限を
# 与えるかはリポジトリ側の責務として切り分ける。
is_github_authored() {
  local author="$1" committer="$2"
  [[ "$committer" == "noreply@github.com" ]] || return 1
  # ローカル部が 1 文字以上あり、かつ @ を含まないことを要求する（ドメイン許可と
  # 同じ判定。末尾一致だけだと x@evil.com@users.noreply.github.com が通る）。
  [[ "$author" == ?*"@users.noreply.github.com" ]] || return 1
  [[ "${author%"@users.noreply.github.com"}" != *@* ]] || return 1
  return 0
}

resolve_range() {
  local arg="${1-}"

  if [[ "$arg" == "--full" ]]; then
    printf '%s' "HEAD"
    return 0
  fi

  if [[ -n "$arg" ]]; then
    printf '%s' "$arg"
    return 0
  fi

  # 既定は origin/main からの差分。取得できない場合のみ全履歴へ落とす。
  # 「範囲が解決できないので何も検査しない」を通過扱いにしない。
  if git rev-parse --verify --quiet origin/main >/dev/null; then
    printf '%s' "origin/main..HEAD"
    return 0
  fi

  printf '%s' "HEAD"
}

main() {
  init_allowlists

  local range
  range="$(resolve_range "${1-}")"

  # 全コミットを git log 1 回で取り出す。コミットごとにプロセスを起動すると、
  # main への全履歴検査が履歴の長さに比例して遅くなり、いずれ CI が
  # タイムアウトする。
  #
  # レコード区切りは制御文字を使う。コミットメッセージの subject や
  # co-author 名に現れないため、区切り文字の衝突を考えなくてよい。
  #   \x1d = レコード終端 / \x1f = フィールド区切り / \x1e = co-author 区切り
  local fmt='%H%x1f%ae%x1f%ce%x1f%s%x1f%(trailers:key=Co-Authored-By,valueonly,separator=%x1e)%x1d'

  local records
  if ! records="$(git log --format="$fmt" "$range" 2>/dev/null)"; then
    echo "[identity] 範囲を解決できません: $range" >&2
    echo "IDENTITY_FAIL"
    exit 1
  fi

  if [[ -z "$records" ]]; then
    echo "[identity] 検査対象のコミットがありません（範囲: $range）"
    echo "IDENTITY_PASS"
    exit 0
  fi

  local checked=0
  local violations=0
  local record sha author_email committer_email subject coauthors
  local coauthor coauthor_email

  while IFS= read -r -d $'\x1d' record; do
    # git log はコミットごとに改行を挟むため、レコード先頭の改行を落とす。
    record="${record#$'\n'}"
    [[ -n "$record" ]] || continue
    checked=$((checked + 1))

    IFS=$'\x1f' read -r sha author_email committer_email subject coauthors <<<"$record"

    if ! is_allowed "$author_email" "${ALLOWED_AUTHOR_EMAILS_ARR[@]}" \
      && ! is_github_authored "$author_email" "$committer_email"; then
      echo "[identity] NG ${sha:0:8} author=<${author_email}> — ${subject}" >&2
      violations=$((violations + 1))
    fi

    if ! is_allowed "$committer_email" "${ALLOWED_COMMITTER_EMAILS_ARR[@]}"; then
      echo "[identity] NG ${sha:0:8} committer=<${committer_email}> — ${subject}" >&2
      violations=$((violations + 1))
    fi

    # co-author が無いコミットが大半なので、空なら走査自体を飛ばす。
    # ヒアストリングは末尾に改行を足すため、素通しすると空文字が
    # 「不正形式の co-author 行」として誤検出される。
    [[ -n "${coauthors//[[:space:]]/}" ]] || continue

    while IFS= read -r -d $'\x1e' coauthor || [[ -n "$coauthor" ]]; do
      # 前後の空白（ヒアストリング由来の改行を含む）を落とす。
      coauthor="${coauthor#"${coauthor%%[![:space:]]*}"}"
      coauthor="${coauthor%"${coauthor##*[![:space:]]}"}"
      [[ -n "$coauthor" ]] || continue
      # "Name <email>" から email を取り出す。<> が無い行は不正形式として弾く。
      if [[ "$coauthor" != *"<"*">"* ]]; then
        echo "[identity] NG ${sha:0:8} co-author 行が不正形式です: ${coauthor}" >&2
        violations=$((violations + 1))
        continue
      fi
      coauthor_email="${coauthor##*<}"
      coauthor_email="${coauthor_email%>*}"
      if ! is_allowed "$coauthor_email" "${ALLOWED_COAUTHOR_EMAILS_ARR[@]}"; then
        echo "[identity] NG ${sha:0:8} co-author=<${coauthor_email}> — ${subject}" >&2
        violations=$((violations + 1))
      fi
    done <<<"$coauthors"
  done <<<"$records"

  echo "[identity] 検査したコミット: ${checked}（範囲: ${range}）"

  if [[ "$violations" -gt 0 ]]; then
    echo "[identity] 許可外の identity を ${violations} 件検出しました。" >&2
    echo "[identity] 対処: bash scripts/setup-git-identity.sh で local identity を適用し、" >&2
    echo "[identity] 該当コミットを git rebase で author ごと作り直してください。" >&2
    echo "IDENTITY_FAIL"
    exit 1
  fi

  echo "IDENTITY_PASS"
  exit 0
}

main "$@"