#!/usr/bin/env bash
# wasm-exec-versions.sh — 配信に要る wasm_exec.js の版を列挙する（3.5 / #139）
#
# **この 1 本が「要る版」の正本である。** 配置（scripts/put-wasm-exec.sh）と検査
# （scripts/check-wasm-exec-objects.sh）の両方がここを呼ぶ。版の一覧を 2 か所へ書くと、
# 「置いた一覧」と「検査した一覧」が別々に古くなり、**検査が緑なのに配信が 500** という
# いちばん読めない状態を作れる（shared-ai-rules.md 12 章「一覧の複製は機械照合で担保する」）。
#
# 要る版は 2 つの出所の和である。**どちらも書き写さず、実物から導く。**
#
#   1. **これから作られる作品の版** = docker/isolated-build/Dockerfile の `ARG GO_VERSION`。
#      3.5 が「値の正本」と定めている場所そのもの。**手元の `go version` から導かない。**
#      手元のツールチェインはイメージと無関係に更新されるため、そこから導いた版で
#      キーを組み立てると、読み込みに成功して実行時に壊れる取り違えを自分で作る。
#   2. **すでにある作品の版** = D1 の `games.go_version`（`removed` 以外）。
#      src/sandbox-delivery.ts の `wasmExecKey()` はこの列からキーを組み立て、
#      **置かれていない版へ別の版を落とさず 500 にする。** すなわち「配信が要求しうる版」は
#      この列の相異なる値そのものである。
#
# 使い方:
#   bash scripts/wasm-exec-versions.sh [--local | --remote]
#
# 出力: 版を 1 行に 1 つ、標準出力へ（例: go1.26.5）。診断は標準エラーへ書く。
# 終了コード: 0 = 列挙できた / 1 = 導出に失敗した（**空の一覧を成功として返さない**）
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(dirname "$HERE")"
cd "$ROOT"

# src/sandbox-delivery.ts の GO_VERSION_PATTERN と同じ綴り。R2 のキーへ埋める値なので、
# ここでも綴りを閉じる（`../` を含む値でキーを組み立てられる経路を作らない）。
readonly VERSION_PATTERN='^go[0-9]+\.[0-9]+(\.[0-9]+)?$'
readonly DOCKERFILE="docker/isolated-build/Dockerfile"

SCOPE="--local"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --local)  SCOPE="--local";  shift ;;
    --remote) SCOPE="--remote"; shift ;;
    -h|--help)
      sed -n '2,30p' "${BASH_SOURCE[0]}" >&2
      exit 0 ;;
    *)
      echo "[wasm-exec-versions] 不明な引数です: $1" >&2
      exit 1 ;;
  esac
done

##
# docker/isolated-build/Dockerfile の `ARG GO_VERSION` からピン留めの版を読む。
#
# **既定値を持つ行だけを拾う。** Dockerfile は FROM をまたぐために `ARG GO_VERSION` を
# 宣言だけもう一度書いており（値は持たない）、そちらを拾うと空になる。
#
# 出力: `go1.26.7` の形
##
pinned_version() {
  local raw
  if [[ ! -f "$DOCKERFILE" ]]; then
    echo "[wasm-exec-versions] ${DOCKERFILE} がありません。版の正本を読めません。" >&2
    return 1
  fi
  raw="$(sed -n 's/^ARG GO_VERSION=\([0-9][0-9.]*\)[[:space:]]*$/\1/p' "$DOCKERFILE" | head -n 1)"
  if [[ -z "$raw" ]]; then
    echo "[wasm-exec-versions] ${DOCKERFILE} から ARG GO_VERSION を読めません。" >&2
    echo "[wasm-exec-versions] 3.5 はここを版の正本と定めています。綴りが変わったら本スクリプトを直すこと。" >&2
    return 1
  fi
  printf 'go%s\n' "$raw"
}

##
# D1 の games から、配信が要求しうる版を読む。
#
# `removed` を除くのは src/sandbox-delivery.ts の `resolveGame()` に合わせるためで、
# **`/p/` は removed 以外を返す**（公開した瞬間にプレビュー URL が壊れないようにする
# ための挙動）。すなわち removed 以外はすべて配信されうる。
#
# 出力: 版を 1 行に 1 つ（0 行もありうる。作品が 1 件も無い環境では正常）
##
db_versions() {
  local args=(d1 execute DB --command
    "select distinct go_version from games where status <> 'removed' order by go_version"
    --json)
  if [[ "$SCOPE" == "--remote" ]]; then
    # 本番の D1 は [env.production] 側にしか宣言が無い。--env を落とすと
    # トップレベルの `local-only-placeholder` を引きに行く。
    args+=(--remote --env production)
    # wrangler は CLOUDFLARE_API_TOKEN を自分で読むが、非対話シェルには .env が
    # 載っていない。acceptance-remote.sh と同じローダーで環境へ移すだけで、値は
    # このスクリプトへ持ち込まない。
    if [[ -z "${CLOUDFLARE_API_TOKEN:-}" && -f "$HERE/load-project-env.sh" ]]; then
      # shellcheck source=scripts/load-project-env.sh
      . "$HERE/load-project-env.sh"
    fi
  else
    args+=(--local)
  fi

  local out
  # CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV=false は本リポジトリの規約
  # （docs/local-dev.md「シークレットの置き場所」）。ここは Worker を起動しないが、
  # wrangler を呼ぶ経路で例外を作らない。
  if ! out="$(CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV=false npx wrangler "${args[@]}" 2>&1)"; then
    echo "[wasm-exec-versions] D1 を読めません（${SCOPE}）:" >&2
    printf '%s\n' "$out" >&2
    return 1
  fi
  # --json でも wrangler は前置きの行を混ぜることがある。最初の `[` から後ろを渡す。
  printf '%s' "$out" | sed -n '/^\[/,$p' | jq -r '.[0].results[]?.go_version // empty'
}

pinned="$(pinned_version)" || exit 1

if ! from_db="$(db_versions)"; then
  exit 1
fi

# 和を取り、綴りを検査してから出す。**綴りの不正を黙って捨てない。**
# 捨てると「置くべき版が一覧に出てこないのに検査は緑」という状態になり、
# その版の作品だけが本番で 500 になる。
all="$(printf '%s\n%s\n' "$pinned" "$from_db" | grep -v '^$' | sort -u)"

invalid="$(printf '%s\n' "$all" | grep -Ev "$VERSION_PATTERN" || true)"
if [[ -n "$invalid" ]]; then
  echo "[wasm-exec-versions] 綴りが不正な版があります（R2 のキーへ埋められません）:" >&2
  sed 's/^/  /' <<<"$invalid" >&2
  exit 1
fi

if [[ -z "$all" ]]; then
  echo "[wasm-exec-versions] 版を 1 つも導出できませんでした。" >&2
  exit 1
fi

printf '%s\n' "$all"
