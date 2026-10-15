#!/usr/bin/env bash
# claude-session-wrapper.sh — Claude Code のセッションの宛先名へ、場所と作業ツリーを自動で含める起動ラッパー。
#
# VS Code 拡張の設定 claudeCode.claudeProcessWrapper に指定する（--with-claude の構成では
# .devcontainer/devcontainer.json が配線する）。拡張はこのラッパーを
#   <ラッパー> <Claude Code 本体のパス> <引数…>
# の形で呼ぶ。セッション以外の内部の操作にも使われる。起動のたびに通る経路なので、
# bash の組み込みだけで動かし、ラベルが無いときは外部コマンドを 1 つも起動せずに exec する。
#
# やること:
#   .env の SESSION_HOST_LABEL（無ければ環境変数）があれば、環境変数
#   CLAUDE_CODE_SESSION_NAME を <ラベル>-<作業ツリー名>-<PID の 16 進> にして exec する。
#   この値が SendMessage の宛先名になり、ListAgents にも出る。PID の 16 進は起動ごとに変わる
#   （同じ作業ツリーで複数のセッションを動かしても、同時に起動しても宛先名が重ならないようにするため）。
#   ただし起動の引数に --resume=<会話の識別子> / --resume <会話の識別子>（UUID の形）があれば、
#   末尾を PID ではなくその識別子の先頭 8 桁（最初のハイフンの前）にする。会話を再開しても宛先名が変わらず、
#   ほかのセッションが一度覚えた宛先名へ再起動の後も送れる。識別子の形に合わないときは PID を使う。
#
# 何も変えずに exec "$@" するとき（起動を妨げないことが最優先）:
#   - ラベルが無い
#   - CLAUDE_CODE_SESSION_NAME が設定済み（利用者の指定を上書きしない）
#   - 名前の計算に失敗した
#   どんな失敗でも、最後は必ず exec "$@" まで進む。
#
# 場所のラベルは固有の値なので .env にだけ置く（既定は空）。起動したあとの名前の変更は
# 利用者の /rename だけで、このラッパーは扱わない。
#
# bash 3.2 互換。set -e は使わない（途中の失敗で止めない）。
set -u

SCRIPT_DIR="${BASH_SOURCE[0]%/*}"
[ "$SCRIPT_DIR" != "${BASH_SOURCE[0]}" ] || SCRIPT_DIR="."

# read_host_label の本体は scripts/session-peers.sh と同一でなければならない
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

# 引数から会話の識別子（UUID の形）を取り出し、先頭 8 桁（最初のハイフンの前）を変数 SESSION_ID へ入れる。
# 見つからなければ空にする。bash の組み込みだけで動き、失敗しても止まらない。
#   --resume=<id> と --resume <id>（空白区切り）を読む。--resume の直後が UUID の形でなければ無視する。
extract_session_id() { # 起動の引数…
  local re='^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$'
  local prev="" a id lower c i
  SESSION_ID=""
  for a in "$@"; do
    id=""
    case "$a" in
      --resume=*) id="${a#--resume=}" ;;
      *) [ "$prev" = "--resume" ] && id="$a" ;;
    esac
    prev="$a"
    if [ -n "$id" ] && [[ "$id" =~ $re ]]; then
      # 大文字小文字で名前が変わらないよう、先頭 8 桁を小文字にそろえる。
      # 変数名に ,, を付ける小文字化は bash 4 以降の書き方なので使わない（bash 3.2 で止まらないよう case で 1 文字ずつ置き換える）。
      id="${id:0:8}"
      lower=""
      i=0
      while [ "$i" -lt 8 ]; do
        c="${id:$i:1}"
        case "$c" in
          A) c=a ;; B) c=b ;; C) c=c ;; D) c=d ;; E) c=e ;; F) c=f ;;
        esac
        lower="$lower$c"
        i=$((i + 1))
      done
      SESSION_ID="$lower"
      return 0
    fi
  done
  return 0
}

# 宛先名を変数 SESSION_NAME へ計算する。失敗したら 1 を返す。git 以外の外部コマンドは使わない。
# 末尾は、このラッパー自身の PID（$$）の 16 進にする。ラッパーは最後に exec するので、$$ は
# そのまま Claude Code の PID になる。同時に生きているセッションどうしで PID は重ならないため、
# 2 つを同時に起動しても宛先名は重ならない（乱数だと、json が書かれる前の同時起動で重なりうる）。
# 会話の識別子が取れていれば（SESSION_ID）、PID の代わりに識別子の先頭 8 桁（最初のハイフンの前）を使う。
compute_name() {
  local top wt hex
  SESSION_NAME=""
  [ -n "$HOST_LABEL" ] || return 1

  top="$(git rev-parse --show-toplevel 2>/dev/null)" || top=""
  [ -n "$top" ] || top="$PWD"
  wt="${top##*/}"
  [ -n "$wt" ] || return 1

  if [ -n "${SESSION_ID:-}" ]; then
    hex="$SESSION_ID"
  else
    printf -v hex '%x' "$$" || return 1
  fi
  [ -n "$hex" ] || return 1

  # 宛先名として安全な文字（英数字と ._-）だけにする。
  SESSION_NAME="${HOST_LABEL//[!A-Za-z0-9._-]/_}-${wt//[!A-Za-z0-9._-]/_}-$hex"
}

if [ -z "${CLAUDE_CODE_SESSION_NAME:-}" ]; then
  read_host_label "$SCRIPT_DIR"
  SESSION_ID=""
  [ -z "$HOST_LABEL" ] || extract_session_id "$@"
  if [ -n "$HOST_LABEL" ] && compute_name && [ -n "$SESSION_NAME" ]; then
    export CLAUDE_CODE_SESSION_NAME="$SESSION_NAME"
  fi
fi

[ "$#" -gt 0 ] || exit 0
exec "$@"
