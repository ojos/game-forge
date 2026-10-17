#!/usr/bin/env bash
# load-project-env.sh — プロジェクト固有の .env を「ホスト由来の環境変数より優先」で読み込む。
#
# 目的: devcontainer の remoteEnv がホスト OS の環境変数（GEMINI_API_KEY 等）を
#       コンテナへ注入する構造は維持したまま、本プロジェクトのみ .env の値を上書き優先する。
#
# 使い方: 実行ではなく source して使う。
#   . scripts/load-project-env.sh
#
# 設計:
#   - 対象 .env はスクリプト自身の位置から解決する（CWD 非依存・パス非ハードコード）。
#     scripts/ の 1 階層上をルートとみなす。別ディレクトリ名でクローンしても追随し、
#     別リポジトリへ cd 済みのシェルから source しても誤検出しない（rc 側は絶対パスを注入）。
#     PROJECT_ENV_FILE で明示的に差し替え可能。
#   - .env は source せず安全にパースする（KEY=VALUE のみ export、任意コードは実行しない）。
#     これにより、壊れた .env が対話シェルの初期化ごと落とす事故を防ぐ。
#   - CRLF・=前後や値前後の空白など、実務的な .env の揺れを吸収する。
#   - UPDATE_CHECK だけは .env の値で上書きしない（環境の値・コマンドで明示した値を優先する）。
#     読み飛ばすのは常にで、合図の変数は無い。.env の UPDATE_CHECK を知りたい update-check.sh は、
#     __load_project_env_value UPDATE_CHECK で値だけを標準出力へ受け取る（変数は変えない）。
#   - __load_project_env_value KEY: .env の KEY の値（後勝ち）を標準出力へ返す。見つかれば 0、
#     無ければ 1。解釈は読み込み本体と同じ処理を共有する（引数に KEY を渡した __load_project_env）。
#
# 冪等: 複数回 source しても安全。.env が無ければ何もしない。

__load_project_env() {
  local project_root env_file line key val src
  # 引数があれば値の取得モード: その KEY の値を標準出力へ返すだけで、何も export しない。
  local want_key="${1-}" result="" found=1
  # ソース中ファイルのパスを bash / zsh 双方で解決する。zsh には BASH_SOURCE が無いため
  # ${BASH_SOURCE[0]} は空になり CWD 依存へ化ける。実行シェルを判定して回避する。
  if [ -n "${BASH_VERSION:-}" ]; then
    src="${BASH_SOURCE[0]}"
  elif [ -n "${ZSH_VERSION:-}" ]; then
    # zsh: 現在ソース中ファイルの絶対/相対パス。
    # この展開は zsh 固有で bash には無い。shellcheck は bash として解析するため
    # 構文エラー（SC2296）に見えるが、この行へ到達するのは ZSH_VERSION が立つ
    # zsh のときだけで、bash では評価されない。注記が無いと、scripts/ を静的解析に
    # 掛ける受け入れ条件を持つプロジェクトが、配布物のせいで赤になる。
    # shellcheck disable=SC2296
    src="${(%):-%x}"
  else
    src="$0"
  fi
  # スクリプト位置から解決（scripts/ の 1 階層上がルート）。CWD にもパスにも依存しない。
  project_root="$(cd "$(dirname "$src")/.." && pwd)"
  env_file="${PROJECT_ENV_FILE:-$project_root/.env}"

  # git worktree から実行された場合はメインの作業コピーの .env へ回り込む。
  # worktree は追跡ファイルしか持たず、.gitignore された .env は複製されない。
  # プロジェクト規約は並列実装に worktree 分離を機構で要求するため、ここで .env を
  # 引けないと worktree 側でローカルゲート（identity 検査を含む）が使えなくなる。
  # --git-common-dir はメインリポジトリの .git を指すので、その親がメインの作業コピー。
  # PROJECT_ENV_FILE で明示された場合は回り込まない（明示指定を上書きしないため）。
  if [[ -z "${PROJECT_ENV_FILE:-}" && ! -f "$env_file" ]] && command -v git >/dev/null 2>&1; then
    local common_dir main_root
    if common_dir="$(git -C "$project_root" rev-parse --git-common-dir 2>/dev/null)" && [[ -n "$common_dir" ]]; then
      case "$common_dir" in
        /*) ;;
        *) common_dir="$project_root/$common_dir" ;;
      esac
      if main_root="$(cd "$common_dir/.." 2>/dev/null && pwd)" && [[ -f "$main_root/.env" ]]; then
        env_file="$main_root/.env"
      fi
    fi
  fi

  if [[ ! -f "$env_file" ]]; then
    [[ -z "$want_key" ]] || return 1
    return 0
  fi

  while IFS= read -r line || [[ -n "$line" ]]; do
    # CRLF 対策: Windows ホストでクローンされた .env の CR を除去。
    line="${line//$'\r'/}"
    # 行の前後の空白を除去し、空行・コメント行はスキップ。
    line="${line#"${line%%[![:space:]]*}"}"
    line="${line%"${line##*[![:space:]]}"}"
    [[ -z "$line" || "$line" == \#* ]] && continue
    # 先頭の `export` 記法を許容。区切りがスペース以外（タブ等）でも剥がせるよう、
    # まず `export` 文字列だけを落としてから先頭空白をトリムする。
    if [[ "$line" == export[[:space:]]* ]]; then
      line="${line#export}"
      line="${line#"${line%%[![:space:]]*}"}"
    fi
    # KEY=VALUE 形式でなければスキップ。
    [[ "$line" == *=* ]] || continue
    key="${line%%=*}"
    val="${line#*=}"
    # キー前後の空白を除去し、正当な識別子だけを対象にする（KEY = VALUE を許容）。
    key="${key//[[:space:]]/}"
    [[ "$key" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || continue
    # 値の前後の空白を除去（KEY= VALUE / KEY =VALUE 等）。クォート内の空白は後段で保持。
    val="${val#"${val%%[![:space:]]*}"}"
    val="${val%"${val##*[![:space:]]}"}"
    # 値を囲む対のクォートがあれば外す（dotenv 慣習）。
    if [[ ${#val} -ge 2 && "$val" == \"*\" ]]; then
      val="${val:1:${#val}-2}"
    elif [[ ${#val} -ge 2 && "$val" == \'*\' ]]; then
      val="${val:1:${#val}-2}"
    fi
    # 値の取得モード: 変数は変えず、後勝ちで値だけを控える。
    if [[ -n "$want_key" ]]; then
      if [[ "$key" == "$want_key" ]]; then result="$val"; found=0; fi
      continue
    fi
    # UPDATE_CHECK は上書きしない（シェルの値は、環境の値か、コマンドで明示した値のまま）。
    # 「明示した値」と「.env が上書きした値」を後から推測しなくて済むようにするため。
    [[ "$key" != UPDATE_CHECK ]] || continue
    # 後勝ちで既存の環境変数（remoteEnv 由来のホスト値）を上書きする。
    export "$key=$val"
  done < "$env_file"
  if [[ -n "$want_key" ]]; then
    printf '%s' "$result"
    return "$found"
  fi
  return 0
}

# .env の KEY の値だけを標準出力へ返す（変数は変えない。見つかれば 0、無ければ 1）。
__load_project_env_value() {
  __load_project_env "$1"
}

__load_project_env
