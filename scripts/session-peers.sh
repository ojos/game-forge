#!/usr/bin/env bash
# session-peers.sh — 同じプロジェクトで動くほかの Claude Code セッションの一覧と、宛先の解決。
#
# 実行環境に依存しない台帳（session-ledger.sh）とは分けた、Claude Code に固有の部分。
# Claude Code が動いているセッションごとに書く ~/.claude/sessions/<PID>.json を読む。
# SendMessage の宛先名（json の name）を、番号・名前・#issue・作業ツリー名から引く。
# 規範は .ai-playbook/shared-ai-rules.md「セッション間の協調」。
#
# 使い方:
#   session-peers.sh list [--names] [--others]
#       同じプロジェクトのセッションを、番号 / 宛先名 / 作業ツリー / 台帳の issue / 状態 で表示する。
#       --names は宛先名だけを 1 行ずつ出す（一斉送信の宛先に使う）。--others は自分を除く。
#   session-peers.sh resolve <指定>
#       番号・名前（完全一致、前方一致）・#issue・作業ツリー名を、宛先名 1 件へ解決して出す。
#       0 件なら終了コード 1、複数件なら 3 で、候補を標準エラーへ出す。
#   session-peers.sh whoami
#       送り元の署名の行（宛先名・場所・作業ツリー・issue）を出す。
#
# 一覧に出す条件（すべて満たすもの）:
#   - json の pidDomain が自分と同じ（~/.claude は named volume で、前のコンテナの json が
#     残る。別のコンテナの PID は無関係なので、必須にする）
#   - その PID のプロセスが生きていて、開始時刻が json の procStart と一致する
#     （PID が再利用された別のプロセスを除く）
#   - json の cwd の git-common-dir が自分と同じ（別の作業ツリーでも同じリポジトリなら出る）
#   /proc を読めない環境（macOS など）では、pidDomain と開始時刻の照合を省き、
#   kill -0 による生存の確認だけにする。
#
# 台帳の issue は session-ledger.sh list（生きている登録）の pid= の列と、json の pid を突き合わせて引く。
#
# 制約と fail-open:
#   - ~/.claude/sessions/*.json は公開された仕様ではない（Claude Code 2.1.296 で実測）。
#     読めない・形が違うときは警告を出して、ListAgents を使うよう案内する。終了コードは 0。
#   - -p（非対話）のセッションは json に登録されないため出ない。
#
# 環境変数: SESSION_PEERS_SESSIONS_DIR（json の置き場所。既定 ~/.claude/sessions）/
#           SESSION_PEERS_PID_DOMAIN（自分の pidDomain。既定は /proc/self/ns/pid から）/
#           SESSION_PEERS_SELF_PID（自分のセッションの PID。既定は祖先をたどって特定）/
#           SESSION_PEERS_NO_PROC（空でなければ /proc を読めない扱いにする。試験用）/
#           SESSION_HOST_LABEL（署名に入れる場所。.env が先、無ければこの環境変数。値は固有なので
#           ここには書かない）
#
# bash 3.2 互換（連想配列・mapfile を使わない）。
set -u

TAB=$'\t'
NL=$'\n'
SEP=$'\001'
SCRIPT_DIR="${BASH_SOURCE[0]%/*}"
[ "$SCRIPT_DIR" != "${BASH_SOURCE[0]}" ] || SCRIPT_DIR="."
LEDGER="$SCRIPT_DIR/session-ledger.sh"
SESSIONS_DIR="${SESSION_PEERS_SESSIONS_DIR:-$HOME/.claude/sessions}"

warn() { echo "[session-peers] WARN: $*" >&2; }

usage() {
  cat >&2 <<'USAGE'
usage: session-peers.sh list [--names] [--others]
       session-peers.sh resolve <番号|名前|#issue|作業ツリー名>
       session-peers.sh whoami
USAGE
}

fallback_hint() {
  warn "$1。ListAgents で動いているセッションを確かめてください。"
}

# read_host_label の本体は scripts/claude-session-wrapper.sh と同一でなければならない
# （ラッパーと /peers の署名が同じラベルを返すため。packages/devcontainer-bootstrap/tests/
# test-claude-session-wrapper.sh が、2 つの本体の一致を検査する）。
# SESSION_HOST_LABEL を変数 HOST_LABEL へ読む。外部コマンドを使わない。
#   順序: .env（スクリプトの 1 つ上。git worktree で .env が無ければ本体の作業コピー）→ 環境変数
#   .env は source しない。export 記法・前後の空白・全体を囲む引用符・CRLF を許し、最後の定義を採る。
read_host_label() { # スクリプトのあるディレクトリ
  local root="$1/.." env_file line value gitdir
  HOST_LABEL=""
  env_file="$root/.env"
  if [ ! -f "$env_file" ] && [ -f "$root/.git" ]; then
    IFS= read -r gitdir <"$root/.git" 2>/dev/null || gitdir=""
    gitdir="${gitdir%$'\r'}"
    case "$gitdir" in
      "gitdir: "*/.git/worktrees/*)
        gitdir="${gitdir#gitdir: }"
        env_file="${gitdir%/.git/worktrees/*}/.env"
        ;;
    esac
  fi
  if [ -r "$env_file" ]; then
    while IFS= read -r line || [ -n "$line" ]; do
      line="${line%$'\r'}"
      line="${line#"${line%%[![:space:]]*}"}"
      case "$line" in
        export[[:blank:]]*)
          line="${line#export}"
          line="${line#"${line%%[![:space:]]*}"}"
          ;;
      esac
      case "$line" in
        SESSION_HOST_LABEL=*) value="${line#SESSION_HOST_LABEL=}" ;;
        *) continue ;;
      esac
      value="${value%%#*}"
      value="${value#"${value%%[![:space:]]*}"}"
      value="${value%"${value##*[![:space:]]}"}"
      case "$value" in
        \"*\") value="${value#\"}"; value="${value%\"}" ;;
        \'*\') value="${value#\'}"; value="${value%\'}" ;;
      esac
      HOST_LABEL="$value"
    done <"$env_file"
  fi
  [ -n "$HOST_LABEL" ] || HOST_LABEL="${SESSION_HOST_LABEL:-}"
}

# /proc を読める環境か。
# SESSION_PEERS_NO_PROC が空でなければ読めない扱いにする（試験用）。
have_proc() { [ -z "${SESSION_PEERS_NO_PROC:-}" ] && [ -r "/proc/$$/stat" ]; }

# /proc/<PID>/stat の 3 列目以降を配列 PROC_F に読む（PROC_F[0] = 状態、[1] = 親の PID、
# [19] = 22 列目の開始時刻）。ps・cat・awk を使わない。読めなければ 1。
proc_fields() { # pid
  local stat
  PROC_F=()
  case "$1" in '' | *[!0-9]*) return 1 ;; esac
  IFS= read -r stat <"/proc/$1/stat" 2>/dev/null || return 1
  case "$stat" in
    *')'*) ;;
    *) return 1 ;;
  esac
  # shellcheck disable=SC2206
  PROC_F=(${stat##*\)})
  [ "${#PROC_F[@]}" -ge 20 ]
}

# /proc/<PID>/stat の 22 列目（起動からの経過のクロック数）を変数 PROC_START へ。取れなければ空で 1。
proc_start() { # pid
  PROC_START=""
  proc_fields "$1" || return 1
  PROC_START="${PROC_F[19]}"
}

# 自分の pidDomain。取れなければ空（その場合は pidDomain を検査しない）。
self_domain() {
  local link
  if [ -n "${SESSION_PEERS_PID_DOMAIN:-}" ]; then
    printf '%s' "$SESSION_PEERS_PID_DOMAIN"
    return 0
  fi
  link="$(readlink /proc/self/ns/pid 2>/dev/null)" || link=""
  [ -n "$link" ] && printf 'linux::%s' "$link"
  return 0
}

# ディレクトリの git-common-dir（実体のパス）と作業ツリーのルートを、git 1 回の呼び出しで
# 変数 G_COMMON / G_TOP へ読む。取れなければ空。
git_info() { # ディレクトリ
  local out c
  G_COMMON=""
  G_TOP=""
  [ -d "$1" ] || return 1
  out="$(git -C "$1" rev-parse --git-common-dir --show-toplevel 2>/dev/null)" || return 1
  c="${out%%$'\n'*}"
  G_TOP="${out#*$'\n'}"
  [ -n "$c" ] || return 1
  case "$c" in /*) ;; *) c="$1/$c" ;; esac
  G_COMMON="$(cd -P "$c" 2>/dev/null && pwd -P)" || G_COMMON=""
  [ -n "$G_COMMON" ]
}

# 作業ツリーの名前（ルートのディレクトリ名）を変数 WT_NAME へ。git でなければ引数の名前。
worktree_name_of() { # ディレクトリ（git_info の直後に G_TOP を使う）
  local top="${G_TOP:-}"
  [ -n "$top" ] || top="$1"
  WT_NAME="${top##*/}"
}

# json の pidDomain / procStart が、このプロセスの環境と一致するか。/proc を読めない環境、
# または jq が無いときは確かめられないので一致とみなす。
json_matches_here() { # pid
  local raw dom pstart
  have_proc || return 0
  command -v jq >/dev/null 2>&1 || return 0
  raw="$(jq -r '[(.pidDomain // ""), (.procStart // "") | tostring] | join("\u0001")' "$SESSIONS_DIR/$1.json" 2>/dev/null)" || return 1
  dom="${raw%%"$SEP"*}"
  pstart="${raw#*"$SEP"}"
  [ -n "$pstart" ] || return 1
  proc_start "$1" && [ "$PROC_START" = "$pstart" ] || return 1
  [ -z "$SELF_DOMAIN" ] || [ "$dom" = "$SELF_DOMAIN" ]
}

# 自分のセッションの PID を変数 SELF_PID へ。祖先をたどり、<PID>.json があって、その json の
# pidDomain と procStart がこのプロセスの環境と一致する最初のものを採る。~/.claude は
# named volume で、前のコンテナの json が同じ PID の名前で残りうるため、名前だけでは採らない。
self_pid() {
  local p pp i
  SELF_PID=""
  if [ -n "${SESSION_PEERS_SELF_PID:-}" ]; then
    SELF_PID="$SESSION_PEERS_SELF_PID"
    return 0
  fi
  p=$$
  i=0
  while [ "$i" -lt 32 ]; do
    if have_proc; then
      proc_fields "$p" || return 0
      pp="${PROC_F[1]}"
    else
      pp="$(ps -o ppid= -p "$p" 2>/dev/null)"
      pp="${pp//[[:space:]]/}"
    fi
    case "$pp" in '' | *[!0-9]*) return 0 ;; esac
    [ "$pp" -gt 1 ] || return 0
    if [ -f "$SESSIONS_DIR/$pp.json" ] && json_matches_here "$pp"; then
      SELF_PID="$pp"
      return 0
    fi
    p="$pp"
    i=$((i + 1))
  done
  return 0
}

# 台帳（既定の list。生きている登録だけ）から、持ち主の PID（pid= の列）ごとの issue を、
# 変数 ISSUES へ読む。引数に PID を渡すと、その PID の分だけにする。
#   各行: <PID>\t#1,#2
ledger_issues() { # [PID]
  ISSUES=""
  [ -f "$LEDGER" ] || return 0
  ISSUES="$(bash "$LEDGER" list 2>/dev/null | awk -v only="${1:-}" '
    {
      pid = ""; kind = ""; tgt = ""
      for (i = 1; i <= NF; i++) {
        if ($i ~ /^pid=/) pid = substr($i, 5)
        else if ($i ~ /^kind=/) kind = substr($i, 6)
        else if ($i ~ /^target=/) tgt = substr($i, 8)
      }
      if (kind == "issue" && tgt != "" && pid ~ /^[0-9]+$/ && (only == "" || pid == only)) {
        if (acc[pid] == "") acc[pid] = "#" tgt
        else acc[pid] = acc[pid] ",#" tgt
      }
    }
    END { for (p in acc) printf "%s\t%s\n", p, acc[p] }
  ')"
}

# jq の出力 1 行ぶんの抽出式。ファイル名の先頭に付け、区切りは \u0001。
JQ_FIELDS='[input_filename, .pid, .procStart, .name, .cwd, (.status // "-"), (.startedAt // 0), (.pidDomain // "")] | map(tostring) | join("\u0001")'

# 事前に SELF_DOMAIN / MINE_COMMON / PROC_OK / SELF_PID / ISSUES を決めておく。
# jq の出力（JQ_FIELDS の行）を標準入力から読み、同じプロジェクトの生きているものを TSV で出す:
#   開始時刻 \t 宛先名 \t 作業ツリー名 \t issue \t 状態 \t PID \t 自分なら self、他は -
emit_rows() {
  local file pid pstart name cwd status started pdomain sid tmp self
  local ISSUES_NL="$NL$ISSUES$NL"
  while IFS="$SEP" read -r file pid pstart name cwd status started pdomain; do
    [ -n "$file" ] || continue
    case "$pid" in '' | *[!0-9]* | null) warn "pid が数字でない json を読み飛ばします: $file。ListAgents を使ってください。"; continue ;; esac
    case "$name" in '' | null) warn "name が無い json を読み飛ばします: $file。ListAgents を使ってください。"; continue ;; esac
    case "$cwd" in '' | null) warn "cwd が無い json を読み飛ばします: $file。ListAgents を使ってください。"; continue ;; esac
    case "$started" in '' | *[!0-9]*) started=0 ;; esac

    if [ "$PROC_OK" -eq 1 ]; then
      # 形が変わった json（項目が欠けた）は判定できない。黙って落とさず知らせる。
      if [ -z "$pdomain" ] || [ -z "$pstart" ] || [ "$pstart" = "null" ]; then
        warn "pidDomain または procStart が欠けた json を読み飛ばします（Claude Code の版で形が変わった可能性）: $file。ListAgents を使ってください。"
        continue
      fi
      # 別のコンテナの json は無関係。
      if [ -n "$SELF_DOMAIN" ] && [ "$pdomain" != "$SELF_DOMAIN" ]; then continue; fi
      # PID が生きていて、開始時刻が一致すること（再利用された PID を除く）。
      proc_start "$pid" && [ "$PROC_START" = "$pstart" ] || continue
    else
      kill -0 "$pid" 2>/dev/null || continue
    fi
    # 同じリポジトリ（git-common-dir が同じ）であること。
    git_info "$cwd" || true
    [ "$G_COMMON" = "$MINE_COMMON" ] || continue

    worktree_name_of "$cwd"
    sid="-"
    case "$ISSUES_NL" in
      *"$NL$pid$TAB"*)
        tmp="${ISSUES_NL#*"$NL$pid$TAB"}"
        sid="${tmp%%"$NL"*}"
        ;;
    esac
    self="-"
    if [ "$pid" = "$SELF_PID" ]; then self="self"; fi
    printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "$started" "$name" "$WT_NAME" "$sid" "$status" "$pid" "$self"
  done
}

# 環境の前提を確かめ、SELF_DOMAIN / MINE_COMMON / PROC_OK を決める。満たさなければ案内して 1。
prepare_env() {
  if ! command -v jq >/dev/null 2>&1; then
    fallback_hint "jq が無いため、セッションの json を読めません"
    return 1
  fi
  if [ ! -d "$SESSIONS_DIR" ]; then
    fallback_hint "セッションの json の置き場所が見つかりません（$SESSIONS_DIR）"
    return 1
  fi
  git_info "$PWD" || true
  MINE_COMMON="$G_COMMON"
  if [ -z "$MINE_COMMON" ]; then
    fallback_hint "git リポジトリの共通ディレクトリを解決できないため、同じプロジェクトを判定できません"
    return 1
  fi
  PROC_OK=0
  SELF_DOMAIN=""
  if have_proc; then
    PROC_OK=1
    SELF_DOMAIN="$(self_domain)"
  fi
  return 0
}

# 同じプロジェクトの生きているセッションを集めて TSV で出す（startedAt 昇順）:
#   宛先名 \t 作業ツリー名 \t issue \t 状態 \t PID \t 自分なら self、他は -
collect_rows() {
  local f base files=() raw out
  prepare_env || return 0
  self_pid
  ledger_issues

  # jq を呼ぶ前に、ファイル名の PID が生きていないものを外す。
  for f in "$SESSIONS_DIR"/*.json; do
    [ -e "$f" ] || continue
    base="${f##*/}"
    base="${base%.json}"
    case "$base" in '' | *[!0-9]*) continue ;; esac
    if [ "$PROC_OK" -eq 1 ]; then
      [ -d "/proc/$base" ] || continue
    else
      kill -0 "$base" 2>/dev/null || continue
    fi
    files[${#files[@]}]="$f"
  done
  [ "${#files[@]}" -gt 0 ] || return 0

  # まとめて 1 回。壊れた json があると全体が失敗するので、そのときだけ 1 件ずつ読み直して警告する。
  if out="$(jq -r "$JQ_FIELDS" "${files[@]}" 2>/dev/null)"; then
    raw="$out"
  else
    raw=""
    for f in "${files[@]}"; do
      if out="$(jq -r "$JQ_FIELDS" "$f" 2>/dev/null)" && [ -n "$out" ]; then
        raw="$raw$out$NL"
      else
        warn "読めない、または形が違う json を読み飛ばします: $f"
      fi
    done
  fi
  [ -n "$raw" ] || return 0

  emit_rows <<EOF | sort -t "$TAB" -k1,1n -k6,6n | cut -f2-
$raw
EOF
}

# 自分のセッションの 1 行だけを、同じ形式で出す。自分の json と、その 1 セッション分の
# git と台帳だけを読む（全件を走査しない）。
self_row() {
  local raw
  prepare_env || return 0
  self_pid
  [ -n "$SELF_PID" ] && [ -f "$SESSIONS_DIR/$SELF_PID.json" ] || return 0
  ledger_issues "$SELF_PID"
  raw="$(jq -r "$JQ_FIELDS" "$SESSIONS_DIR/$SELF_PID.json" 2>/dev/null)" || raw=""
  [ -n "$raw" ] || return 0
  emit_rows <<EOF | cut -f2-
$raw
EOF
}

cmd_list() {
  local names=0 others=0 a rows n=0 name wt iss st pid self
  for a in "$@"; do
    case "$a" in
      --names) names=1 ;;
      --others) others=1 ;;
      *) usage; return 2 ;;
    esac
  done
  rows="$(collect_rows)"
  if [ -z "$rows" ]; then
    [ "$names" -eq 1 ] || echo "(同じプロジェクトで動いているセッションは見つかりませんでした)"
    return 0
  fi
  [ "$names" -eq 1 ] || printf '番号\t宛先名\t作業ツリー\t台帳の issue\t状態\n'
  while IFS="$TAB" read -r name wt iss st pid self; do
    [ -n "$name" ] || continue
    n=$((n + 1))
    if [ "$others" -eq 1 ] && [ "$self" = "self" ]; then continue; fi
    if [ "$names" -eq 1 ]; then
      printf '%s\n' "$name"
    else
      if [ "$self" = "self" ]; then st="$st (自分)"; fi
      printf '%s\t%s\t%s\t%s\t%s\n' "$n" "$name" "$wt" "$iss" "$st"
    fi
  done <<EOF
$rows
EOF
  return 0
}

# 候補を標準エラーへ出す。
print_candidates() { # 行（宛先名\t作業ツリー\tissue\t…）
  local name wt iss _rest
  while IFS="$TAB" read -r name wt iss _rest; do
    [ -n "$name" ] || continue
    printf '  %s\t%s\t%s\n' "$name" "$wt" "$iss" >&2
  done <<EOF
$1
EOF
}

cmd_resolve() {
  local spec="${1:-}" rows matched="" count
  if [ -z "$spec" ]; then usage; return 2; fi
  rows="$(collect_rows)"
  if [ -z "$rows" ]; then
    echo "[session-peers] 同じプロジェクトで動いているセッションが見つかりません。" >&2
    return 1
  fi

  # 段ごとに絞り、最初に 1 件以上あった段で決める（複数件ならそこで曖昧として止める）。
  case "$spec" in
    \#*)
      matched="$(printf '%s\n' "$rows" | awk -F'\t' -v q="$spec" '
        { m = split($3, a, ","); for (i = 1; i <= m; i++) if (a[i] == q) { print; break } }')"
      ;;
    *[!0-9]*) ;;
    *) matched="$(printf '%s\n' "$rows" | awk -F'\t' -v n="$spec" 'NR == n + 0 { print }')" ;;
  esac
  [ -n "$matched" ] || matched="$(printf '%s\n' "$rows" | awk -F'\t' -v q="$spec" '$1 == q')"
  [ -n "$matched" ] || matched="$(printf '%s\n' "$rows" | awk -F'\t' -v q="$spec" '$2 == q')"
  [ -n "$matched" ] || matched="$(printf '%s\n' "$rows" | awk -F'\t' -v q="$spec" 'index($1, q) == 1')"

  if [ -z "$matched" ]; then
    echo "[session-peers] 「$spec」に該当するセッションがありません。候補:" >&2
    print_candidates "$rows"
    return 1
  fi
  count="$(printf '%s\n' "$matched" | wc -l | tr -d ' ')"
  if [ "$count" -gt 1 ]; then
    echo "[session-peers] 「$spec」に該当するセッションが $count 件あります。絞り込んでください。候補:" >&2
    print_candidates "$matched"
    return 3
  fi
  printf '%s\n' "${matched%%"$TAB"*}"
  return 0
}

cmd_whoami() {
  local row name="" wt="" iss="" label
  row="$(self_row)"
  if [ -n "$row" ]; then
    IFS="$TAB" read -r name wt iss _ <<<"$row"
  else
    warn "自分のセッションの json を特定できません（-p の非対話セッションは登録されません）。"
    name="(宛先名不明)"
    git_info "$PWD" || true
    worktree_name_of "$PWD"
    wt="$WT_NAME"
    iss="-"
  fi
  read_host_label "$SCRIPT_DIR"
  # 宛先名と同じ置き換えをかける（ラッパーが作る名前の場所の部分と同じ表記にする）。
  label="${HOST_LABEL//[!A-Za-z0-9._-]/_}"
  printf '[from: %s | 場所: %s | 作業ツリー: %s | issue: %s]\n' "$name" "${label:--}" "$wt" "$iss"
}

main() {
  local sub="${1:-}"
  [ "$#" -gt 0 ] && shift
  case "$sub" in
    list) cmd_list "$@" ;;
    resolve) cmd_resolve "$@" ;;
    whoami) cmd_whoami ;;
    *) usage; return 2 ;;
  esac
}

# source ガード。読み込まれただけのときは関数定義だけを提供する。
if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
  exit $?
fi
