#!/usr/bin/env bash
# update-check.sh — devcontainer-bootstrap（DCB）と ai-playbook の新しい安定版を知らせ、
# 対話のシェルで yes と答えたときだけ、bootstrap.sh --upgrade で追従する。
#
# サブコマンド:
#   notify   on-attach.sh が呼ぶ。1 日 1 回だけ最新の安定版を問い合わせ（認証なし）、新しい版が
#            あれば通知を 1 行だけ出す。聞かない。失敗は黙って通す。
#   prompt   対話のシェルの rc が呼ぶ。端末が付いているときだけ、キャッシュを読んで
#            「追従しますか？ [y/N]」と聞く。ネットワークには出ない。
#   upgrade  最新を問い合わせ、新しい版があれば追従する（prompt の y と同じ処理）。
#
# 追従の処理: 新しい bootstrap.sh と SHA256SUMS を取得して照合し、既定ブランチの上なら作業用の
# ブランチを切ってから、ORIGIN を引き継ぐ --upgrade を流す。差分を作業ツリーに残して止め、
# 変わったファイルと次の手順を出す。コミット・push・PR はしない。
#
# 何もしない条件（黙って 0 で終わる）:
#   - 環境変数 UPDATE_CHECK が off（0 / false / no / disabled も同じ）
#   - ORIGIN（.devcontainer/ORIGIN）が無い、または input:update-check=off が記録されている
#   - ORIGIN の version= が vX.Y.Z の形でない（リリースから取得した版ではない）
#   - 端末が付いていない（prompt のみ。notify は標準出力へ 1 行出すだけで、聞かない）
#
# 問い合わせは 1 日 1 回。**取得をすべて終えた日だけ**その日の印（checked）を書く。どの部品の取得が
# どんな理由（通信ができない・HTTP のエラー・形の不一致・CHANGELOG.md の取得の失敗）で失敗した日も、
# 印を書かず、次の接続で取り直す。失敗した部品の前の日のキャッシュは消す。オフラインのマシンでは
# 接続のたびに問い合わせる（最大 2 秒）。
#
# キャッシュ: ${XDG_CACHE_HOME:-~/.cache}/dcb-update-check/<プロジェクトごとの鍵>/ 。コミットしない。
# 試験用の上書き: UPDATE_CHECK_CACHE_DIR（キャッシュ）/ UPDATE_CHECK_TODAY（今日の日付）/
# UPDATE_CHECK_ASSUME_TTY=1（端末が付いている扱い。標準入力から答えを読む）。
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
ORIGIN="$ROOT/.devcontainer/ORIGIN"
HELPER="$HERE/load-project-env.sh"

# 配布元のリポジトリ。ai-playbook は、ORIGIN に記録した取得元の URL に owner があればそれを使う。
DCB_SLUG="ojos/devcontainer-bootstrap"
PB_DEFAULT_SLUG="ojos/ai-playbook"
LOG_PREFIX="[update-check]"

# .env を読み込む（ローダーは source 専用・冪等。無ければ何もしない）。HTTPS_PROXY や GIT_IDENTITY_* など、
# curl や子の bootstrap.sh --upgrade が使う値を届けるため、UPDATE_CHECK の有無によらず常に読む。
# ローダーは UPDATE_CHECK を常に読み飛ばすので、読み込みは UPDATE_CHECK の優先順位を変えない。
if [[ -f "$HELPER" ]]; then
  # shellcheck source=/dev/null
  . "$HELPER" 2>/dev/null || true
fi
# UPDATE_CHECK の優先順位: UPDATE_CHECK に値（空でない）があればそれを採る（環境の値、またはコマンドで
# 明示した値）。無いときだけ、ローダーの値取得の関数で .env の UPDATE_CHECK を読む（読み方はローダーと
# 同じ。変数は変えない）。値の比較による推測はしない。
if [[ -z "${UPDATE_CHECK-}" ]] && declare -F __load_project_env_value >/dev/null 2>&1; then
  ENV_UPDATE_CHECK="$(__load_project_env_value UPDATE_CHECK 2>/dev/null)" || ENV_UPDATE_CHECK=""
  if [[ -n "$ENV_UPDATE_CHECK" ]]; then
    UPDATE_CHECK="$ENV_UPDATE_CHECK"
  fi
fi

# UPDATE_CHECK が止める値なら 0 を返す（止めない値なら 1）。
disabled_by_env() {
  case "$(printf '%s' "${UPDATE_CHECK:-}" | tr '[:upper:]' '[:lower:]')" in
    off|0|false|no|disabled) return 0 ;;
  esac
  return 1
}

# ORIGIN の値を 1 つ出す（無ければ 1）。値の符号化は、このスクリプトが読む範囲では不要。
origin_get() {
  [[ -f "$ORIGIN" ]] || return 1
  awk -v k="$1=" 'index($0, k) == 1 { print substr($0, length(k) + 1); found = 1; exit } END { exit !found }' "$ORIGIN"
}

# vX.Y.Z の形かを判定する。
is_semver() {
  [[ "$1" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]]
}

# 版 $1 が版 $2 より古ければ 0。どちらかが vX.Y.Z でなければ 1（比べられないので新しいとは言わない）。
ver_lt() {
  local a="$1" b="$2" i
  is_semver "$a" && is_semver "$b" || return 1
  a="${a#v}"; b="${b#v}"
  local -a pa pb
  IFS=. read -r -a pa <<< "$a"
  IFS=. read -r -a pb <<< "$b"
  for i in 0 1 2; do
    if (( 10#${pa[$i]} < 10#${pb[$i]} )); then return 0; fi
    if (( 10#${pa[$i]} > 10#${pb[$i]} )); then return 1; fi
  done
  return 1
}

CUR_DCB="" CUR_PB="" PB_SLUG="$PB_DEFAULT_SLUG"
# PB_KIND: 規範の取得元の種類（tag / url）。PB_REPRO: 取得した bootstrap.sh で生成を再現できるか（ok / no）。
PB_KIND="" PB_REPRO="ok"

# ORIGIN から、今の版を読む。DCB の版が読めなければ 1（何もしない）。
load_origin() {
  local v src ref
  [[ -f "$ORIGIN" ]] || return 1
  v="$(origin_get version)" || return 1
  is_semver "$v" || return 1
  CUR_DCB="$v"
  CUR_PB="" PB_SLUG="$PB_DEFAULT_SLUG" PB_KIND="" PB_REPRO="ok"
  if [[ "$(origin_get input:playbook 2>/dev/null)" == "installed" ]]; then
    src="$(origin_get input:playbook-source 2>/dev/null)" || src=""
    ref="$(origin_get input:playbook-ref 2>/dev/null)" || ref=""
    case "$src" in
      tag)
        if is_semver "$ref"; then CUR_PB="$ref"; PB_KIND="tag"; fi
        ;;
      url)
        # リリースのタグの tarball の URL だけを、リリースから取得した版として扱う。
        if [[ "$ref" =~ ^https://github\.com/([A-Za-z0-9_.-]+)/ai-playbook/archive/refs/tags/(v[0-9]+\.[0-9]+\.[0-9]+)\.tar\.gz$ ]]; then
          PB_SLUG="${BASH_REMATCH[1]}/ai-playbook"
          CUR_PB="${BASH_REMATCH[2]}"
          PB_KIND="url"
        elif [[ -z "$ref" ]]; then
          PB_REPRO="no"
        fi
        ;;
      adjacent|local)
        PB_REPRO="no"
        ;;
    esac
  fi
  return 0
}

# ORIGIN が無効化を記録していれば 0。
disabled_by_origin() {
  local v
  v="$(origin_get input:update-check 2>/dev/null)" || return 1
  [[ "$v" == "off" ]]
}

comp_cur()   { case "$1" in dcb) printf '%s' "$CUR_DCB" ;; playbook) printf '%s' "$CUR_PB" ;; esac; }
comp_repo()  { case "$1" in dcb) printf 'devcontainer-bootstrap' ;; playbook) printf 'ai-playbook' ;; esac; }
comp_slug()  { case "$1" in dcb) printf '%s' "$DCB_SLUG" ;; playbook) printf '%s' "$PB_SLUG" ;; esac; }

# キャッシュの置き場所。プロジェクトごとに分ける（1 つのコンテナに複数のプロジェクトがありうる）。
cache_dir() {
  local key
  if [[ -n "${UPDATE_CHECK_CACHE_DIR:-}" ]]; then
    printf '%s' "$UPDATE_CHECK_CACHE_DIR"
    return 0
  fi
  key="$(printf '%s' "$ROOT" | cksum | awk '{ print $1 }')"
  printf '%s/dcb-update-check/%s' "${XDG_CACHE_HOME:-$HOME/.cache}" "$key"
}

# URL を取得して $2 へ書く。認証なし・短いタイムアウト。$3 は全体の秒数（既定 3）。
# https だけを許し、リダイレクト先も https に限る。失敗は curl の終了コード（curl が無ければ 127）。
fetch() {
  local url="$1" out="$2" max="${3:-3}"
  command -v curl >/dev/null 2>&1 || return 127
  curl -fsSL --proto '=https' --proto-redir '=https' --connect-timeout 2 --max-time "$max" \
    -H 'Accept: application/vnd.github+json' -H 'User-Agent: dcb-update-check' \
    "$url" -o "$out" 2>/dev/null
}

# リリースの JSON から tag_name を 1 つ出す。
json_tag_name() {
  awk '
    match($0, /"tag_name"[ ]*:[ ]*"[^"]*"/) {
      s = substr($0, RSTART, RLENGTH)
      sub(/^"tag_name"[ ]*:[ ]*"/, "", s)
      sub(/"$/, "", s)
      print s
      exit
    }
  ' "$1"
}

# タグの一覧の JSON から、"name" の値をすべて出す（1 行に並んでいても読める）。
json_tag_names() {
  awk '
    {
      s = $0
      while (match(s, /"name"[ ]*:[ ]*"[^"]*"/)) {
        m = substr(s, RSTART, RLENGTH)
        s = substr(s, RSTART + RLENGTH)
        sub(/^"name"[ ]*:[ ]*"/, "", m)
        sub(/"$/, "", m)
        print m
      }
    }
  ' "$1"
}

# タグの一覧の JSON から、vX.Y.Z の形（プレリリースの形を除く）のうち最大の版を出す。無ければ何も出さない。
max_semver_tag() {
  local t best=""
  while IFS= read -r t; do
    is_semver "$t" || continue
    if [[ -z "$best" ]] || ver_lt "$best" "$t"; then best="$t"; fi
  done < <(json_tag_names "$1")
  printf '%s' "$best"
}

# ai-playbook の最新の版を、タグの一覧から取り、$LATEST_TAG へ入れる。
# GitHub の並びが semver の順である保証は無いので、100 件より多いときはページをたどる
# （100 件未満のページが来るまで。上限 10 ページ）。1 ページでも取得に失敗したら、その失敗を返す。
LATEST_TAG=""
fetch_latest_tag_from_tags() { # <slug> <作業ファイル>
  local slug="$1" out="$2" page=1 url cand best="" n rc
  LATEST_TAG=""
  while [[ $page -le 10 ]]; do
    url="https://api.github.com/repos/$slug/tags?per_page=100"
    [[ $page -eq 1 ]] || url="$url&page=$page"
    fetch "$url" "$out" 3
    rc=$?
    [[ $rc -eq 0 ]] || return "$rc"
    cand="$(max_semver_tag "$out")"
    if [[ -n "$cand" ]] && { [[ -z "$best" ]] || ver_lt "$best" "$cand"; }; then best="$cand"; fi
    n="$(json_tag_names "$out" | wc -l | tr -d ' ')"
    [[ "$n" -ge 100 ]] || break
    page=$((page + 1))
  done
  LATEST_TAG="$best"
  return 0
}

# 配布先の CHANGELOG.md から、「### 移行」の節を持つ版（「## vX.Y.Z」の節）を出す。
# リリースの本文は「Release vX.Y.Z」の 1 行でリリースノートを含まないため、CHANGELOG.md を読む。
changelog_migration_tags() {
  awk '
    /^## / { tag = ""; if ($2 ~ /^v[0-9]+\.[0-9]+\.[0-9]+/) { tag = $2; sub(/\r$/, "", tag) } }
    /^### 移行/ { if (tag != "") print tag }
  ' "$1"
}

# 通信ができない（名前を引けない・つながらない・時間切れ・curl が無い）ことを表す curl の終了コードか。
# このとき、残りの問い合わせは試さない（遅らせない）。HTTP の失敗などは、部品ごとの失敗として扱う。
is_offline_rc() {
  case "$1" in 6|7|28|127) return 0 ;; esac
  return 1
}

# 最新の安定版を問い合わせ、キャッシュへ書く。部品ごとの失敗は、もう片方の確認を止めない。
# 通信ができないと分かったときだけ、残りを試さない。
# 取得の結果は、いったん作業用のディレクトリへ集め、最後に rename で差し替える。
# 取得のあいだ、prompt は古い（または新しい）キャッシュを一貫して読める（先に消さない）。
# 今日の取得に失敗した部品・記録が無くなった部品の、前の日のキャッシュは使わない（最後に消す）。
# 「今日の印」(checked) は、取得をすべて終えたときだけ最後に書く。理由によらず、どれかの取得
# （最新の版・タグ・CHANGELOG.md）が失敗したときは書かず（次の notify で取り直す）、
# 取得できなかった部品の前の日のキャッシュを消す。
# 呼び出し側は排他（acquire_lock）を取ってから呼ぶ（並行する更新が、成功した側のキャッシュを消さないため）。
# $REFRESHED には、今回の呼び出しで最新の版を取得できた部品を入れる（"dcb playbook" の空白区切り）。
# 取得できなかった部品は、前の日・同じ日のキャッシュがあっても使わない（upgrade はこれで判断する）。
# 戻り値: 0 = 通信は通った / 1 = 通信ができずに抜けた、または作業用の場所を作れなかった。
# 最新の版の取得先は部品で分ける。DCB は Release の最新（releases/latest）、
# ai-playbook はタグだけを打って Release を作らないため、タグの一覧から vX.Y.Z の最大を取る。
# latest-<部品> は版だけの 1 行。migrations-<部品> は「<版>=<移行の節がある版の空白区切り>」で、
# 読む側は latest の版と一致するときだけ使う（rename は別々でも、組み合わせを読み違えない）。
# 第 1 引数が preserve なら、失敗しても既存のキャッシュと今日の印を消さない（upgrade は今回取得できた部品
# だけを使うので、古いキャッシュを使う心配が無い。直前に notify が取得した内容を消さないため）。
REFRESHED=""
refresh_cache() {
  local dir c cur slug tag t list rc offline="" failed="" today
  local keep="" drop="" preserve="${1-}"
  REFRESHED=""
  dir="$(cache_dir)"
  mkdir -p "$dir" 2>/dev/null || return 1
  # 中断で残った作業用のファイルのうち、1 日より古いものを片づける（動いている別の取得のものは残す）。
  find "$dir" -maxdepth 1 \( -name '.fetch.*' -o -name '.stage.*' \) -mmin +1440 -exec rm -rf {} + 2>/dev/null || true
  RC_TMP="$(mktemp "$dir/.fetch.XXXXXX" 2>/dev/null)" || { RC_TMP=""; return 1; }
  RC_STAGE="$(mktemp -d "$dir/.stage.XXXXXX" 2>/dev/null)" || { RC_STAGE=""; rm -f "$RC_TMP"; RC_TMP=""; return 1; }
  for c in dcb playbook; do
    cur="$(comp_cur "$c")"
    if [[ -z "$cur" || -n "$offline" ]]; then drop="$drop $c"; continue; fi
    slug="$(comp_slug "$c")"
    case "$c" in
      playbook) fetch_latest_tag_from_tags "$slug" "$RC_TMP"; rc=$? ;;
      *)        fetch "https://api.github.com/repos/$slug/releases/latest" "$RC_TMP" 3; rc=$? ;;
    esac
    if [[ $rc -ne 0 ]]; then
      if is_offline_rc "$rc"; then offline="yes"; fi
      failed="yes"
      drop="$drop $c"
      continue
    fi
    case "$c" in
      playbook) tag="$LATEST_TAG" ;;
      *)        tag="$(json_tag_name "$RC_TMP")" ;;
    esac
    # プレリリース・draft は latest に出ないはずだが、形の合わない値も取り込まない。
    if ! is_semver "$tag"; then failed="yes"; drop="$drop $c"; continue; fi
    if ! printf '%s\n' "$tag" > "$RC_STAGE/latest-$c" 2>/dev/null; then failed="yes"; drop="$drop $c"; continue; fi
    keep="$keep $c"
    # 新しいときだけ、飛び越える版のうち「移行」の節がある版を、最新のタグの CHANGELOG.md から調べる
    # （読めなければ印を消し、案内に留める）。
    if ver_lt "$cur" "$tag"; then
      fetch "https://raw.githubusercontent.com/$slug/$tag/CHANGELOG.md" "$RC_TMP" 5
      rc=$?
      if [[ $rc -eq 0 ]]; then
        list=""
        while IFS= read -r t; do
          [[ -n "$t" ]] || continue
          if ver_lt "$cur" "$t" && ! ver_lt "$tag" "$t"; then list="$list $t"; fi
        done < <(changelog_migration_tags "$RC_TMP")
        printf '%s=%s\n' "$tag" "${list# }" > "$RC_STAGE/migrations-$c" 2>/dev/null || rm -f "$RC_STAGE/migrations-$c"
      else
        # 取得の失敗として扱う（checked を書かない）。移行の印は作らず、案内に留める。
        failed="yes"
        if is_offline_rc "$rc"; then offline="yes"; fi
      fi
    fi
  done
  today="${UPDATE_CHECK_TODAY:-$(date +%Y-%m-%d)}"
  REFRESHED="${keep# }"
  # 差し替え。取得できた部品は rename で置き換え、消すべき部品だけを最後に消す。
  for c in $keep; do
    if [[ -f "$RC_STAGE/migrations-$c" ]]; then
      mv -f "$RC_STAGE/migrations-$c" "$dir/migrations-$c" 2>/dev/null || rm -f "$dir/migrations-$c"
    else
      rm -f "$dir/migrations-$c"
    fi
    mv -f "$RC_STAGE/latest-$c" "$dir/latest-$c" 2>/dev/null || rm -f "$dir/latest-$c"
  done
  for c in $drop; do
    [[ "$preserve" == preserve ]] || rm -f "$dir/latest-$c" "$dir/migrations-$c" 2>/dev/null
  done
  rm -rf "$RC_TMP" "$RC_STAGE"
  RC_TMP="" RC_STAGE=""
  # 失敗があった日は印を書かず、すでにある今日の印も消す（次の接続で取り直す）。同じ日に先に
  # 成功した notify の印が残ると、失敗で消した部品を、その日のうちに取り直さないため。
  # 前の日の印は、どのみち今日の取り直しを止めないので、そのままにする。
  if [[ -n "$offline" || -n "$failed" ]]; then
    if [[ "$preserve" != preserve && "$(cat "$dir/checked" 2>/dev/null)" == "$today" ]]; then rm -f "$dir/checked" 2>/dev/null; fi
    [[ -z "$offline" ]] || return 1
    return 0
  fi
  # 今日の印は、取得をすべて終えたあとに最後に書く。
  printf '%s\n' "$today" > "$dir/checked" 2>/dev/null || true
  return 0
}

# 追従の候補（今より新しく、N と答えていない版。引数があれば N の版も含める）を、
# "<部品>=<版>" の空白区切り（部品は dcb / playbook）で出す。読んだ版を一緒に返すので、
# 呼び出し側は latest-* を読み直さない（読み直すと、そのあいだに消える・替わることがある）。
pending_components() {
  local ignore_declined="${1:-}" dir c cur latest declined out=""
  dir="$(cache_dir)"
  for c in dcb playbook; do
    cur="$(comp_cur "$c")"
    [[ -n "$cur" && -f "$dir/latest-$c" ]] || continue
    latest="$(cat "$dir/latest-$c" 2>/dev/null)" || continue
    ver_lt "$cur" "$latest" || continue
    if [[ -z "$ignore_declined" ]]; then
      declined="$(cat "$dir/declined-$c" 2>/dev/null || true)"
      [[ "$declined" != "$latest" ]] || continue
    fi
    out="$out $c=$latest"
  done
  printf '%s' "${out# }"
}

# pending_components の出力から、部品の名前だけを "dcb playbook" の空白区切りで出す。
pend_names() {
  local t out=""
  for t in $1; do out="$out ${t%%=*}"; done
  printf '%s' "${out# }"
}

# 今日まだ問い合わせていなければ問い合わせ、追従の候補があれば通知を 1 行だけ出す（聞かない）。
cmd_notify() {
  local dir pend t c line="" cur latest today
  dir="$(cache_dir)"
  # 今日の日付は 1 度だけ求め、外側の確認とロックの後の読み直しで同じ値を使う（日付をまたいで食い違わないように）。
  today="${UPDATE_CHECK_TODAY:-$(date +%Y-%m-%d)}"
  if [[ "$(cat "$dir/checked" 2>/dev/null || true)" != "$today" ]]; then
    # 更新は更新用の排他（refresh-lock）を取って行う（待たずに試し、取れなければ飛ばす。checked を書かないので、
    # 次の接続で取り直す）。聞く側のロック（lock）は取らないので、prompt が問いかけ中でも更新でき、更新中でも
    # prompt は問いかけられる。飛ばすのは更新だけで、通知は出す（キャッシュを読んで知らせるだけで、
    # 更新は rename 差し替えなので、ほかの端末が更新・問いかけの最中でも一貫した状態を読める）。
    # ロックを取ったあとで checked を読み直す。ほかの notify が、こちらの確認とロックのあいだに更新を
    # 終えていれば、同じ日に取り直さない（取り直して失敗すると、相手が取得したキャッシュと今日の印を消すため）。
    if acquire_lock refresh-lock 8 \
      && [[ "$(cat "$dir/checked" 2>/dev/null || true)" != "$today" ]]; then
      refresh_cache || true
    fi
  fi
  pend="$(pending_components)"
  [[ -n "$pend" ]] || return 0
  for t in $pend; do
    c="${t%%=*}" latest="${t#*=}"
    cur="$(comp_cur "$c")"
    line="${line:+$line, }$(comp_repo "$c") $cur -> $latest"
  done
  echo "$LOG_PREFIX 新しい版があります: $line。対話のシェルで追従できます（bash scripts/update-check.sh upgrade でも追従できます）。止めるには UPDATE_CHECK=off（環境の値。無ければ .env の値）"
  return 0
}

# 端末が付いているか。
tty_ok() {
  [[ -n "${UPDATE_CHECK_ASSUME_TTY:-}" ]] && return 0
  [[ -t 0 && -t 1 ]]
}

# 排他を取る。複数の端末が同時に開いても、聞く・追従するのは 1 つだけにする。取れなければ 1。
# $1 はロックの名前（既定 lock。聞く・追従する側）、$2 は flock の fd。キャッシュの更新（refresh_cache）は
# 別の名前（refresh-lock）で排他する。更新のあいだに prompt が問いかけられなくなるのを避けるため
# （prompt は更新の rename 差し替えのおかげで、更新中でも一貫したキャッシュを読める）。
# flock があれば flock -n（プロセスの終了で解放される）。無ければロックのディレクトリで簡易に
# 排他する（持ち主の pid が消えていれば奪う）。UPDATE_CHECK_NO_FLOCK=1 は試験用。
LOCK_DIRS=()
# refresh_cache の作業用のファイル。中断（Ctrl-C・接続の打ち切り）でも片づける。
RC_TMP="" RC_STAGE=""
cleanup_exit() {
  local d
  for d in ${LOCK_DIRS[@]+"${LOCK_DIRS[@]}"}; do rm -rf "$d" 2>/dev/null; done
  [[ -z "$RC_TMP" ]] || rm -rf "$RC_TMP" 2>/dev/null
  [[ -z "$RC_STAGE" ]] || rm -rf "$RC_STAGE" 2>/dev/null
  return 0
}
trap cleanup_exit EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
acquire_lock() {
  local name="${1:-lock}" fd="${2:-9}" dir pid
  dir="$(cache_dir)"
  mkdir -p "$dir" 2>/dev/null || return 1
  if [[ -z "${UPDATE_CHECK_NO_FLOCK:-}" ]] && command -v flock >/dev/null 2>&1; then
    # fd は 9（lock）か 8（refresh-lock）。
    case "$fd" in
      8) exec 8>"$dir/$name" ;;
      *) exec 9>"$dir/$name" ;;
    esac
    flock -n "$fd"
    return $?
  fi
  if ! mkdir "$dir/$name.d" 2>/dev/null; then
    pid="$(cat "$dir/$name.d/pid" 2>/dev/null || true)"
    if [[ -n "$pid" ]]; then
      # pid があって、そのプロセスが無いときだけ奪う。
      if kill -0 "$pid" 2>/dev/null; then
        return 1
      fi
    elif [[ -z "$(find "$dir/$name.d" -maxdepth 0 -mmin +1 2>/dev/null)" ]]; then
      # pid がまだ無い（作った直後で、書くまでのあいだ）。十分古くなるまでは持ち主ありとみなす。
      return 1
    fi
    # 奪うのは名前の変更で 1 つだけを成功させる（rm してから作り直すと、同時に奪いに来た端末が、
    # 先に奪った側の新しいロックまで消せるため）。変えた先の pid が、古いと判断したものと違えば
    # （判断のあとに別の端末が奪って作り直した）、そのロックは生きているので戻して諦める。
    mv "$dir/$name.d" "$dir/$name.d.stale.$$" 2>/dev/null || return 1
    if [[ "$(cat "$dir/$name.d.stale.$$/pid" 2>/dev/null || true)" != "$pid" ]]; then
      mv "$dir/$name.d.stale.$$" "$dir/$name.d" 2>/dev/null || rm -rf "$dir/$name.d.stale.$$"
      return 1
    fi
    rm -rf "$dir/$name.d.stale.$$"
    mkdir "$dir/$name.d" 2>/dev/null || return 1
  fi
  echo $$ > "$dir/$name.d/pid"
  LOCK_DIRS+=("$dir/$name.d")
  return 0
}

# 作業用のブランチの名前の元（追従する版から決める）。$1 = DCB の版（上げないなら空）、$2 = ai-playbook の版（同）。
# 問いかけ・手で呼ぶ upgrade の案内・prepare_branch が同じ名前を使うよう、決め方はここにだけ置く。
follow_branch_name() {
  local ver_dcb="$1" ver_pb="$2" bname
  if [[ -n "$ver_dcb" ]]; then
    bname="chore/update-dcb-$ver_dcb"
    [[ -z "$ver_pb" ]] || bname="$bname-playbook-$ver_pb"
  else
    bname="chore/update-playbook-$ver_pb"
  fi
  printf '%s' "$bname"
}

# 追従で作業用のブランチを切るかを決める（git は変えない）。結果:
#   BRANCH_PLAN     = make（切る）/ stay（今のブランチの上で追従する）/ none（git のブランチの上ではない）
#   BRANCH_PLAN_CUR = 今のブランチ
#   BRANCH_PLAN_WHY = 切る理由（make のとき）
# 既定ブランチの判断（origin/HEAD が無いときの扱い。#634）は、prepare_branch と問いかけで共有する。
BRANCH_PLAN="" BRANCH_PLAN_CUR="" BRANCH_PLAN_WHY=""
plan_branch() {
  local cur def
  BRANCH_PLAN="none" BRANCH_PLAN_CUR="" BRANCH_PLAN_WHY=""
  git -C "$ROOT" rev-parse --is-inside-work-tree >/dev/null 2>&1 || return 0
  cur="$(git -C "$ROOT" symbolic-ref --quiet --short HEAD 2>/dev/null)" || return 0
  BRANCH_PLAN_CUR="$cur"
  def="$(git -C "$ROOT" symbolic-ref --quiet --short refs/remotes/origin/HEAD 2>/dev/null)" || def=""
  def="${def#origin/}"
  # origin/HEAD が無ければ、既定ブランチを推定しない（main と master が両方あると取り違えるため。
  # リモートへ問い合わせて通信を増やすこともしない）。main / master のどちらかの上にいれば、
  # 作業用のブランチを切る。どちらも手元に無いときも、念のため切る
  # （切って困ることは無く、切らずに既定ブランチの作業ツリーへ差分を置くほうが困るため）。
  if [[ -z "$def" ]]; then
    local b has_default=""
    for b in main master; do
      if git -C "$ROOT" show-ref --verify --quiet "refs/heads/$b"; then has_default="yes"; fi
    done
    if [[ -n "$has_default" && "$cur" != main && "$cur" != master ]]; then BRANCH_PLAN="stay"; return 0; fi
    BRANCH_PLAN="make"
    if [[ -n "$has_default" ]]; then
      BRANCH_PLAN_WHY="origin/HEAD が無いため、main / master の上を既定ブランチの上とみなして"
    else
      BRANCH_PLAN_WHY="既定ブランチを判断できなかった（origin/HEAD も main / master も無い）ため、念のため"
    fi
  elif [[ "$cur" != "$def" ]]; then
    BRANCH_PLAN="stay"
  else
    BRANCH_PLAN="make"
    BRANCH_PLAN_WHY="既定ブランチ（$def）の上だったので"
  fi
  return 0
}

# 切るブランチの実際の名前（$1 = 名前の元。同名が既にあれば -2, -3 を付ける）。
unique_branch_name() {
  local want="$1" name n=1
  name="$want"
  while git -C "$ROOT" show-ref --verify --quiet "refs/heads/$name"; do
    n=$((n + 1)); name="$want-$n"
  done
  printf '%s' "$name"
}

# 追従で何が起きるかを 1 文で出す（作業ツリーのパスと、切るブランチ／追従するブランチ）。$1 = 名前の元。
branch_plan_text() {
  plan_branch
  case "$BRANCH_PLAN" in
    make) printf '作業ツリー %s で、作業用のブランチ %s を切って追従します' "$ROOT" "$(unique_branch_name "$1")" ;;
    stay) printf '作業ツリー %s で、今のブランチ %s の上で追従します' "$ROOT" "$BRANCH_PLAN_CUR" ;;
    *)    printf '作業ツリー %s で、ブランチは切らずに追従します（git のブランチの上ではありません）' "$ROOT" ;;
  esac
}

# 作業用のブランチを切る（既定ブランチの上にいるときだけ）。切ったら名前を $BRANCH_MADE へ、
# 元のブランチを $BRANCH_ORIG へ入れる。
BRANCH_MADE=""
BRANCH_ORIG=""
prepare_branch() {
  local want="$1" name
  plan_branch
  [[ "$BRANCH_PLAN" == make ]] || return 0
  name="$(unique_branch_name "$want")"
  if ! git -C "$ROOT" switch -c "$name" >/dev/null 2>&1; then
    echo "$LOG_PREFIX 作業用のブランチ $name を切れませんでした。何も変えずに止めます。" >&2
    return 1
  fi
  BRANCH_MADE="$name"
  BRANCH_ORIG="$BRANCH_PLAN_CUR"
  echo "$LOG_PREFIX ${BRANCH_PLAN_WHY}、作業用のブランチ $name を切りました。"
  return 0
}

# 切った作業用のブランチから元のブランチへ戻し、空のブランチを消す（失敗したときに残さない）。
restore_branch() {
  [[ -n "$BRANCH_MADE" ]] || return 0
  if git -C "$ROOT" switch -q "$BRANCH_ORIG" 2>/dev/null; then
    git -C "$ROOT" branch -D "$BRANCH_MADE" >/dev/null 2>&1 || true
    echo "$LOG_PREFIX 作業用のブランチ $BRANCH_MADE を消し、$BRANCH_ORIG へ戻しました。" >&2
  else
    echo "$LOG_PREFIX 元のブランチ $BRANCH_ORIG へ戻せませんでした。作業用のブランチ $BRANCH_MADE に居ます。" >&2
  fi
  BRANCH_MADE=""
}

# sha256 を計算する（GNU の sha256sum が無ければ shasum -a 256）。
sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{ print $1 }'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{ print $1 }'
  else
    return 1
  fi
}

# 取得した bootstrap.sh では追従できない構成なら、その理由を出す（追従できるなら何も出さない）。
# 規範の取得元が adjacent / local / 記録のない url のとき、取得した bootstrap.sh は一時ディレクトリから
# 動くため、規範の置き場所を見つけられず --upgrade が必ず失敗する。
follow_blocker() {
  if [[ "$PB_REPRO" == "no" ]]; then
    echo "規範（ai-playbook）の取得元がリリースの版を指していない（adjacent / local / 記録のない url）ため、取得した bootstrap.sh からは生成を再現できません。手元の bootstrap.sh（規範の置き場所が見える場所のもの）で --upgrade してください。"
  fi
}

# 追従する。$1 は追従する部品（"dcb" "playbook" の空白区切り。聞いて y と答えたもの）。
# 失敗は 1（何も実行していないか、止めた理由を出している）。
# DCB を上げないとき（N と答えた・すでに最新・最新より新しい）は、今の版の bootstrap.sh を使い、
# 生成物の DCB の版を動かさない。
# $2 / $3 は、利用者に見せた DCB / ai-playbook の版。$4 が "prompt" のとき（prompt から呼ぶとき）は、
# キャッシュへ戻らず、その版だけで追従する（追従する部品の版が空なら止める）。
# prompt 以外（手で呼ぶ upgrade）は、キャッシュの最新を読む。
do_upgrade() {
  local want="$1" shown_dcb="${2:-}" shown_pb="${3:-}" from_prompt="${4:-}" dir latest_dcb="" latest_pb="" want_dcb="" want_pb="" use_tag blocker
  local work base wantbranch expected actual rc branch_hint changed
  local -a pbargs
  pbargs=()
  dir="$(cache_dir)"
  load_origin || { echo "$LOG_PREFIX ORIGIN から今の版を読めないため、追従しません。" >&2; return 1; }
  case " $want " in *" dcb "*) want_dcb="yes" ;; esac
  case " $want " in *" playbook "*) want_pb="yes" ;; esac
  if [[ -z "$want_dcb" && -z "$want_pb" ]]; then
    echo "$LOG_PREFIX すでに最新です（devcontainer-bootstrap $CUR_DCB）。"
    return 0
  fi
  if [[ -n "$from_prompt" ]] && { [[ -n "$want_dcb" && -z "$shown_dcb" ]] || [[ -n "$want_pb" && -z "$shown_pb" ]]; }; then
    echo "$LOG_PREFIX 見せた版を特定できないため、追従しません。あとでもう一度試してください。" >&2
    return 1
  fi
  blocker="$(follow_blocker)"
  if [[ -n "$blocker" ]]; then
    echo "$LOG_PREFIX $blocker" >&2
    return 1
  fi
  use_tag="$CUR_DCB"
  if [[ -n "$want_dcb" ]]; then
    if [[ -n "$from_prompt" ]]; then latest_dcb="$shown_dcb"; else latest_dcb="$(cat "$dir/latest-dcb" 2>/dev/null)" || latest_dcb=""; fi
    is_semver "$latest_dcb" || { echo "$LOG_PREFIX 最新の版がまだ分かりません（問い合わせに失敗した）。あとでもう一度試してください。" >&2; return 1; }
    use_tag="$latest_dcb"
  fi
  if [[ -n "$want_pb" ]]; then
    if [[ -n "$from_prompt" ]]; then latest_pb="$shown_pb"; else latest_pb="$(cat "$dir/latest-playbook" 2>/dev/null)" || latest_pb=""; fi
    is_semver "$latest_pb" || { echo "$LOG_PREFIX ai-playbook の最新の版がまだ分かりません。あとでもう一度試してください。" >&2; return 1; }
    # 取得元の種類と、フォークの owner を保つ（--playbook-version は既定の配布元の URL に展開されるため）。
    case "$PB_KIND" in
      tag) pbargs=(--playbook-version "$latest_pb") ;;
      url) pbargs=(--playbook-from "https://github.com/$PB_SLUG/archive/refs/tags/$latest_pb.tar.gz") ;;
      *) echo "$LOG_PREFIX 規範の取得元を読めないため、追従しません。" >&2; return 1 ;;
    esac
  fi
  # 差分を読めるよう、作業ツリーが汚れているときは止める（追従の差分と混ざるため）。
  if git -C "$ROOT" rev-parse --is-inside-work-tree >/dev/null 2>&1 \
    && [[ -n "$(git -C "$ROOT" status --porcelain 2>/dev/null)" ]]; then
    echo "$LOG_PREFIX 作業ツリーに未コミットの変更があるため、追従しません（差分が混ざるため）。コミットか退避をしてからやり直してください。" >&2
    return 1
  fi

  work="$(mktemp -d "${TMPDIR:-/tmp}/dcb-update-upgrade.XXXXXX" 2>/dev/null)" || return 1
  base="https://github.com/$DCB_SLUG/releases/download/$use_tag"
  if ! fetch "$base/bootstrap.sh" "$work/bootstrap.sh" 60 || ! fetch "$base/SHA256SUMS" "$work/SHA256SUMS" 60; then
    echo "$LOG_PREFIX $use_tag の bootstrap.sh か SHA256SUMS を取得できませんでした。何も変えずに止めます。" >&2
    rm -rf "$work"
    return 1
  fi
  expected="$(awk '$2 == "bootstrap.sh" || $2 == "*bootstrap.sh" { print $1; exit }' "$work/SHA256SUMS")"
  actual="$(sha256_of "$work/bootstrap.sh")" || actual=""
  if [[ -z "$expected" || -z "$actual" || "$expected" != "$actual" ]]; then
    echo "$LOG_PREFIX bootstrap.sh のハッシュが SHA256SUMS と一致しません（または照合できません）。実行せずに止めます。" >&2
    rm -rf "$work"
    return 1
  fi
  echo "$LOG_PREFIX bootstrap.sh $use_tag を取得し、SHA256SUMS と照合しました。"

  # 名前には、追従する部品の版だけを入れる（追従しない部品の最新版を入れると、問いかけで示した名前と食い違う）。
  wantbranch="$(follow_branch_name "${want_dcb:+$latest_dcb}" "${want_pb:+$latest_pb}")"
  # 問いかけを経ない（手で呼ぶ upgrade）ときは、追従を始める前に何が起きるかを 1 行出す。
  [[ -n "$from_prompt" ]] || echo "$LOG_PREFIX $(branch_plan_text "$wantbranch")。"
  if ! prepare_branch "$wantbranch"; then
    rm -rf "$work"
    return 1
  fi

  echo "$LOG_PREFIX bootstrap.sh --upgrade を実行します。"
  bash "$work/bootstrap.sh" --upgrade --output-dir "$ROOT" ${pbargs[@]+"${pbargs[@]}"}
  rc=$?
  rm -rf "$work"
  if [[ $rc -ne 0 && $rc -ne 2 ]]; then
    echo "$LOG_PREFIX --upgrade が失敗しました（終了コード $rc）。出力を確かめてください。" >&2
    # 途中で書かれたファイルを自動では戻さない（作業ツリー全体を戻すと、追従のあいだに別の端末で編集したものまで消しうるため）。
    # 何も書かれていなければ、切った作業用のブランチを消して元のブランチへ戻す。書かれていれば、作業用のブランチに留まり
    # （既定ブランチの作業ツリーを汚さない）、戻し方を案内する。
    if git -C "$ROOT" rev-parse --is-inside-work-tree >/dev/null 2>&1 \
      && [[ -n "$(git -C "$ROOT" status --porcelain 2>/dev/null)" ]]; then
      if [[ -n "$BRANCH_MADE" ]]; then
        echo "$LOG_PREFIX 途中で書かれたファイルがあるため、作業用のブランチ $BRANCH_MADE に留まります（$BRANCH_ORIG には戻していません）。" >&2
      else
        echo "$LOG_PREFIX 途中で書かれたファイルが、今のブランチの作業ツリーに残っています。" >&2
      fi
      echo "$LOG_PREFIX 差分を読んで、要らなければ git restore . と git clean -fd（消す前に git clean -nd で確かめる）で戻してください。" >&2
      BRANCH_MADE=""
    else
      restore_branch
    fi
    return 1
  fi
  branch_hint=""
  [[ -z "$BRANCH_MADE" ]] || branch_hint="（作業用のブランチ $BRANCH_MADE に切り替え済みです）"
  if git -C "$ROOT" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    changed="$(git -C "$ROOT" status --short 2>/dev/null | sed -n '1,40p')"
    echo "$LOG_PREFIX 追従の差分を作業ツリーに残しました。コミット・push・PR はしていません$branch_hint。"
    echo "変わったファイル:"
    if [[ -n "$changed" ]]; then printf '%s\n' "$changed" | sed 's/^/  /'; else echo "  （変わったファイルはありません）"; fi
  else
    echo "$LOG_PREFIX 追従の差分を残しました（git の作業ツリーではないため、変わったファイルの一覧は出しません）。"
  fi
  if [[ $rc -eq 2 ]]; then
    echo "  手を入れたファイルの隣に .dcb-new が置かれました。差分を見て取り込んでください（--upgrade の出力を参照）。"
  fi
  echo "次の手順:"
  echo "  1) 差分を読む（git diff。リリースノートの「移行」も読む）"
  echo "  2) bash scripts/verify.sh"
  echo "  3) コミットする"
  echo "  4) PR を作る"
  return 0
}

# 表示した部品 $1 の版（cmd_prompt の shown_<部品>）を、declined へ書く。キャッシュは読み直さない。
decline_shown() {
  local v="shown_$1" dir
  dir="$(cache_dir)"
  printf '%s\n' "${!v}" > "$dir/declined-$1" 2>/dev/null || true
}

# 端末で聞く。聞くのは表示した部品だけで、y で上げるのも、その部品だけ。
cmd_prompt() {
  local dir pend names t c cur latest mig mig_line n ans blocker
  local shown_dcb="" shown_playbook=""
  tty_ok || return 0
  # ほかの端末が聞いている・追従しているあいだは、この端末では聞かない。
  acquire_lock || return 0
  dir="$(cache_dir)"
  pend="$(pending_components)"
  [[ -n "$pend" ]] || return 0
  echo "$LOG_PREFIX 新しい版があります。"
  names="$(pend_names "$pend")"
  for t in $pend; do
    c="${t%%=*}" latest="${t#*=}"
    cur="$(comp_cur "$c")"
    # 見せた版を持つ。以後の declined への記録と追従は、キャッシュを読み直さずこの版を使う
    # （待っているあいだに、別の接続の notify が latest を書き換えうるため）。
    printf -v "shown_$c" '%s' "$latest"
    echo "  $(comp_repo "$c"): $cur -> $latest"
    # 移行の節の一覧は、見せた版のものだけを使う（別の版のものなら、案内に留める）。
    mig_line="$(cat "$dir/migrations-$c" 2>/dev/null)" || mig_line=""
    if [[ "$mig_line" == "$latest="* ]]; then
      mig="${mig_line#*=}"
      n="$(printf '%s\n' "$mig" | wc -w | tr -d ' ')"
      if [[ "$n" -ge 2 ]]; then
        echo "  [注意] 「移行」の節がある版を $n 個飛び越えます（$mig）。リリースノート（CHANGELOG.md）の「移行」を読んでから追従してください。"
      elif [[ "$n" -eq 1 ]]; then
        echo "  「移行」の節がある版: $mig"
      fi
    else
      echo "  リリースノート（移行の節）を読んでください: https://github.com/$(comp_slug "$c")/releases"
    fi
  done
  blocker="$(follow_blocker)"
  if [[ -n "$blocker" ]]; then
    # 自動では追従できない。案内を 1 回出し、この版のあいだは聞かない。
    echo "  [自動では追従できません] $blocker"
    for c in $names; do
      decline_shown "$c"
    done
    return 0
  fi
  # 追従する作業ツリーと、切る（または乗る）ブランチを問いかけの文に含める。名前は prepare_branch と同じ関数で決める。
  printf '%s。追従しますか？ [y/N] ' "$(branch_plan_text "$(follow_branch_name "$shown_dcb" "$shown_playbook")")"
  ans=""
  read -r ans || ans=""
  case "$ans" in
    y|Y|yes|YES|Yes)
      do_upgrade "$names" "$shown_dcb" "$shown_playbook" prompt || true
      ;;
    *)
      # N の版は、その版のあいだ聞かない。
      for c in $names; do
        decline_shown "$c"
      done
      echo "$LOG_PREFIX 追従しません。この版のあいだは聞きません（あとで追従するときは bash scripts/update-check.sh upgrade）。"
      ;;
  esac
  return 0
}

# 手で追従する。N と答えた版も含め、今より新しいものすべてを対象にする。
cmd_upgrade() {
  load_origin || { echo "$LOG_PREFIX ORIGIN から今の版を読めないため、追従しません。" >&2; return 1; }
  if ! acquire_lock; then
    echo "$LOG_PREFIX ほかの端末が聞いている、または追従しているため、追従しません。" >&2
    return 1
  fi
  if ! acquire_lock refresh-lock 8; then
    echo "$LOG_PREFIX ほかの端末が最新の版を問い合わせているため、追従しません。時間をおいて、もう一度実行してください。" >&2
    return 1
  fi
  # 取得の結果は部品ごとに見る。今回取得できた部品だけを対象にする（取得できなかった部品は、
  # 前の日・同じ日のキャッシュがあっても使わない）。どちらも取得できなければ、「すでに最新」と言わずに失敗で終える。
  refresh_cache preserve || true
  if [[ -z "$REFRESHED" ]]; then
    echo "$LOG_PREFIX 最新の版を取得できなかったため、追従するか判断できません（オフライン・GitHub の不調・API の制限）。時間をおいて、もう一度実行してください。" >&2
    return 1
  fi
  local c names="" skipped=""
  for c in $(pend_names "$(pending_components all)"); do
    case " $REFRESHED " in *" $c "*) names="$names $c" ;; esac
  done
  for c in dcb playbook; do
    [[ -n "$(comp_cur "$c")" ]] || continue
    case " $REFRESHED " in *" $c "*) ;; *) skipped="$skipped $(comp_repo "$c")" ;; esac
  done
  if [[ -n "$skipped" ]]; then
    echo "$LOG_PREFIX 最新の版を取得できなかったため、追従しません:${skipped}（時間をおいて、もう一度実行してください）。" >&2
    [[ -n "$names" ]] || return 1
  fi
  do_upgrade "${names# }"
}

main() {
  local sub="${1:-}"
  case "$sub" in
    notify|prompt)
      # 何もしない条件。起動・対話シェルの開始を止めないよう、失敗は黙って 0 で終わる。
      disabled_by_env && return 0
      load_origin || return 0
      disabled_by_origin && return 0
      if [[ "$sub" == "notify" ]]; then cmd_notify; else cmd_prompt; fi
      return 0
      ;;
    upgrade)
      cmd_upgrade
      return $?
      ;;
    *)
      echo "usage: bash scripts/update-check.sh <notify|prompt|upgrade>" >&2
      return 2
      ;;
  esac
}

main "$@"
