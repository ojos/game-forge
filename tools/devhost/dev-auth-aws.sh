#!/usr/bin/env bash
# dev-auth-aws — 開発機のホストから、devcontainer の中で AWS の SSO にデバイスコードで入る。
#
# 上流の devhost（devcontainer-bootstrap のリリースに同梱。導入は README.md）は「特定のクラウドへの
# 認証を組み込まない」方針で、`dev auth aws` を持たない。これはその 1 つだけを足す薄い追加で、
# ホストへは `~/.local/bin/dev-auth-aws` として置く。スマホ（Termux）からは
# `ssh -t <ホスト> .local/bin/dev-auth-aws <名前>` の 1 行をショートカットにして叩く。
#
# **上流の dev にも、その設定ファイル（~/.config/dev/projects）にも依存しない。** 上流の dev は
# 知らないキーで止まるので、セッション名をあちらの設定に書けない。こちらは自前の設定ファイルを読む。
#
# ## 使い方
#
#   dev-auth-aws <名前>                                    設定ファイルの行で入る
#   dev-auth-aws <名前> --sso-session <s>                  セッション名だけを上書きする
#   dev-auth-aws --workspace <絶対パス> --sso-session <s>  設定ファイルを読まずに入る
#
# ## 設定ファイル
#
# 既定は `${XDG_CONFIG_HOME:-$HOME/.config}/dev/aws-sso`（`DEV_AUTH_AWS_FILE` で差し替えられる）。
# 1 行 1 プロジェクトで、空白区切りの `名前 絶対パス セッション名`。# から行末はコメント。
# 名前・パス・セッション名はこの道具に書かない。
#
# ## すること
#
# コンテナが動いていることを確かめてから、
# `devcontainer exec --workspace-folder <パス> aws sso login --sso-session <s> --no-browser --use-device-code`
# を打つ。**コンテナは起こさない**（起こすのは上流の `dev up` とユニットの役目。起こし直している
# 最中に 2 本目の up を重ねないため）。トークンはコンテナのボリュームに残り、この道具は何も持たない。
#
# 終了コード: 0 = 成功 / 1 = 実行の失敗（コンテナが動いていない・下の道具が失敗した）/
#             2 = 使い方か設定ファイルの誤り（未登録の名前を含む）
set -euo pipefail

PROG="dev-auth-aws"

# ssh の非対話のコマンドは ~/.profile を読まないので、devcontainer CLI の既定の置き場所
# （公式の install.sh は ~/.devcontainers/bin）と ~/.local/bin を**末尾へ**足す（上流の dev と同じ）。
PATH="$PATH:$HOME/.devcontainers/bin:$HOME/.local/bin"

die() { echo "[$PROG] $*" >&2; exit 1; }
usage_error() { echo "[$PROG] $*" >&2; exit 2; }

usage() {
  cat <<'EOF'
使い方:
  dev-auth-aws <名前> [--sso-session <セッション名>]
  dev-auth-aws --workspace <絶対パス> --sso-session <セッション名>

設定ファイルは ${DEV_AUTH_AWS_FILE:-${XDG_CONFIG_HOME:-$HOME/.config}/dev/aws-sso}
（1 行 1 つ。「名前 絶対パス セッション名」）。
EOF
}

config_file() {
  if [[ -n "${DEV_AUTH_AWS_FILE:-}" ]]; then
    printf '%s\n' "$DEV_AUTH_AWS_FILE"
  else
    printf '%s\n' "${XDG_CONFIG_HOME:-$HOME/.config}/dev/aws-sso"
  fi
}

# 末尾の / を外す。devcontainer のラベル（devcontainer.local_folder）は末尾に / が無いので、
# 残すと動いているコンテナを見つけられない。
strip_slash() {
  local p="$1"
  while [[ "$p" == */ && "$p" != / ]]; do p="${p%/}"; done
  printf '%s\n' "$p"
}

# 設定ファイルから名前の行を引き、CONF_PATH と CONF_SESSION に置く。
# 未登録の名前は、登録済みの名前を添えて止まる。
CONF_PATH=""
CONF_SESSION=""
lookup() {
  local want="$1" file lineno=0 line names=""
  file="$(config_file)"
  if [[ ! -f "$file" ]]; then
    usage_error "設定ファイルがありません: $file
[$PROG] 「名前 絶対パス セッション名」を 1 行ずつ書くか、--workspace と --sso-session で渡してください。"
  fi
  while IFS= read -r line || [[ -n "$line" ]]; do
    lineno=$((lineno + 1))
    line="${line%$'\r'}"
    line="${line%%#*}"
    set -f
    # shellcheck disable=SC2086
    set -- $line
    set +f
    [[ $# -gt 0 ]] || continue
    [[ $# -eq 3 ]] || usage_error "$file:$lineno: 「名前 絶対パス セッション名」の 3 つで書きます: $line"
    [[ "$2" == /* ]] || usage_error "$file:$lineno: パスは絶対パスで書きます（~ や \$HOME は展開しません）: $2"
    names="$names $1"
    if [[ "$1" == "$want" ]]; then
      CONF_PATH="$2"
      CONF_SESSION="$3"
      return 0
    fi
  done <"$file"
  usage_error "登録されていないプロジェクトです: $want（登録済み:${names:- なし}。設定ファイル: $file）"
}

need() {
  command -v "$1" >/dev/null 2>&1 || die "$1 が見つかりません。$2"
}

# devcontainer が付けるラベル（devcontainer.local_folder = ホストのワークスペースの絶対パス）で
# コンテナを探し、動いているかを見る（上流の dev と同じ探し方。VS Code が作ったコンテナも同じラベルを持つ）。
# sed -n '1p' は最後まで読むので、出力が多くても docker を SIGPIPE で切らない。
is_running() {
  local row
  row="$(docker ps -a --filter "label=devcontainer.local_folder=$1" --format '{{.ID}} {{.State}}' | sed -n '1p')" || return 1
  [[ -n "$row" && "${row#* }" == "running" ]]
}

main() {
  local name="" workspace="" session=""
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --workspace | --sso-session)
        [[ $# -ge 2 && -n "$2" ]] || usage_error "$1 に値がありません"
        if [[ "$1" == "--workspace" ]]; then workspace="$2"; else session="$2"; fi
        shift 2
        ;;
      -h | --help)
        usage
        exit 0
        ;;
      -*) usage_error "知らない引数です: $1" ;;
      *)
        [[ -z "$name" ]] || usage_error "名前は 1 つだけです: $1"
        name="$1"
        shift
        ;;
    esac
  done
  if [[ -z "$name" && -z "$workspace" ]]; then
    usage >&2
    exit 2
  fi
  if [[ -n "$name" && -n "$workspace" ]]; then
    usage_error "名前と --workspace は同時に渡せません"
  fi
  if [[ -n "$name" ]]; then
    lookup "$name"
    workspace="$CONF_PATH"
    [[ -n "$session" ]] || session="$CONF_SESSION"
  fi
  [[ "$workspace" == /* ]] || usage_error "--workspace は絶対パスで渡します: $workspace"
  [[ -n "$session" ]] || usage_error "SSO のセッション名がありません。--sso-session で渡してください。"
  workspace="$(strip_slash "$workspace")"

  [[ -d "$workspace" ]] || die "ワークスペースのディレクトリがありません: $workspace"
  need docker "Docker Engine を入れてください。"
  need devcontainer "devcontainer CLI を入れてください（上流の devhost の README の「devcontainer CLI を入れる」）。"
  is_running "$workspace" ||
    die "コンテナが動いていません: $workspace。dev up <名前> で起こしてから認証してください（ユニットを有効にしていれば、30 秒ほどで戻ります）。"
  # devcontainer exec は最初の「オプションでない語」より後をそのままコマンドへ渡す
  # （CLI 0.89.0 の halt-at-non-option）。CLI のオプションは必ずコマンドの前に置く。
  # --no-browser: ホストにもコンテナにもブラウザは無い。URL とコードを出させ、スマホのブラウザで承認する。
  # --use-device-code: 既定の PKCE は localhost へ戻る形で、ssh 越しの端末からは戻り先へ届かない。
  devcontainer exec --workspace-folder "$workspace" aws sso login --sso-session "$session" --no-browser --use-device-code
}

main "$@"
