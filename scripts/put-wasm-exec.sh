#!/usr/bin/env bash
# put-wasm-exec.sh — wasm_exec.js をビルドイメージから取り出して R2 へ置く（3.5 手順 5 / #139）
#
# **3.5 の更新手順のうち、機械が見ていなかった 1 段がここである**（#101 の申し送り）。
# 手順書に「イメージからこのファイルを取り出して配信側へ配置する」と書いてあるだけの
# 状態では、Go を上げたときに**この段だけが抜ける。** 抜けると、過去の作品ではなく
# **新しい作品が黙って 500 になる**（src/sandbox-delivery.ts は置かれていない版へ
# 別の版を配らない）。
#
# 使い方:
#   bash scripts/put-wasm-exec.sh                    # ローカル R2 へ、要る版すべて
#   bash scripts/put-wasm-exec.sh go1.26.7           # ローカル R2 へ、版を指定して
#   bash scripts/put-wasm-exec.sh --remote           # **本番 R2 へ**、要る版すべて
#
# 引数を省いたときの対象は scripts/wasm-exec-versions.sh が導出する（版の一覧を
# ここへ書き写さない）。
#
# 既定は --local である。**本番へ書くときだけ --remote を明示する。** 逆にすると、
# 手元の試行が本番の共有資材を上書きする経路が既定になる。
#
# 終了コード: 0 = 全件を置けた / 1 = 1 件でも失敗した
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(dirname "$HERE")"
cd "$ROOT"

readonly VERSION_PATTERN='^go[0-9]+\.[0-9]+(\.[0-9]+)?$'
# src/sandbox-delivery.ts の wasmExecKey() が組み立てるキーと同じ形。
readonly KEY_PREFIX="runtime"
readonly KEY_FILE="wasm_exec.js"
# 配信側（src/sandbox-loader.ts）が `typeof Go !== 'function'` で見る記号。取り出した
# ファイルがこれを持たなければ、置いても起動しない。
readonly REQUIRED_SYMBOL="globalThis.Go"

SCOPE="--local"
BUCKET=""
IMAGE_OVERRIDE=""
VERSIONS=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --local)  SCOPE="--local";  shift ;;
    --remote) SCOPE="--remote"; shift ;;
    --bucket) BUCKET="${2:-}";  shift 2 ;;
    --image)  IMAGE_OVERRIDE="${2:-}"; shift 2 ;;
    -h|--help)
      sed -n '2,25p' "${BASH_SOURCE[0]}" >&2
      exit 0 ;;
    -*)
      echo "[put-wasm-exec] 不明な引数です: $1" >&2
      exit 1 ;;
    *)
      VERSIONS+=("$1"); shift ;;
  esac
done

##
# wrangler.toml から R2 バケット名を読む。
#
# **書き写さない。** ローカルは `game-forge-local`、本番は `game-forge` で、綴りを
# ここへ持つと wrangler.toml を変えた日から静かにずれる。ずれた先が実在すれば
# 「置いたのに配信は 500」、実在しなければ「置けない」になる。
#
# 引数: $1 = セクション名（r2_buckets / env.production.r2_buckets）
##
bucket_from_wrangler() {
  local section="$1"
  awk -v hdr="[[${section}]]" '
    { line = $0; sub(/[[:space:]]+$/, "", line) }
    line ~ /^\[/ { in_section = (line == hdr); next }
    in_section && line ~ /^[[:space:]]*bucket_name[[:space:]]*=/ {
      sub(/^[^=]*=[[:space:]]*/, "", line)
      gsub(/"/, "", line)
      print line
      exit
    }
  ' wrangler.toml
}

if [[ -z "$BUCKET" ]]; then
  if [[ "$SCOPE" == "--remote" ]]; then
    BUCKET="$(bucket_from_wrangler "env.production.r2_buckets")"
  else
    BUCKET="$(bucket_from_wrangler "r2_buckets")"
  fi
fi
if [[ -z "$BUCKET" ]]; then
  echo "[put-wasm-exec] wrangler.toml から R2 バケット名を読めません（${SCOPE}）。" >&2
  exit 1
fi

if [[ ${#VERSIONS[@]} -eq 0 ]]; then
  # 引数が無いときは「配信が要求しうる版」すべて。導出は 1 か所に置いてある。
  mapfile -t VERSIONS < <(bash "$HERE/wasm-exec-versions.sh" "$SCOPE")
fi
if [[ ${#VERSIONS[@]} -eq 0 ]]; then
  echo "[put-wasm-exec] 対象の版がありません。" >&2
  exit 1
fi

command -v docker >/dev/null 2>&1 || {
  echo "[put-wasm-exec] docker がありません。取り出し元はビルドイメージです。" >&2
  exit 1
}

WORK="$(mktemp -d "${TMPDIR:-/tmp}/put-wasm-exec.XXXXXX")"
CONTAINER=""
cleanup() {
  [[ -n "$CONTAINER" ]] && docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT

##
# 1 つの版の wasm_exec.js をイメージから取り出す。
#
# # なぜ標準出力に載せないのか
#
# 3.5 手順 5 が「取り出しは `docker cp` で行い、`docker run ... cat` の標準出力に
# 載せない」と定めている。docker の attach 経由の出力は**まるごと失われることがあり、
# しかも終了コードは 0 のまま**である（scripts/check-isolated-build.sh 冒頭の実測）。
# ここではコンテナ内で /tmp へ複製し、**ファイルとして** docker cp で取り出す。
# 標準出力に載るものは 1 バイトも無い。
#
# # なぜ版をイメージ自身に申告させるのか
#
# タグを信じない。`go env GOVERSION` の結果をコンテナ内でファイルへ書き、それを
# 取り出して要求した版と照合する。**版の取り違えは 3.5 が防ごうとしている事故そのもの**で、
# 読み込みは成功して実行時に壊れるため、いちばん原因が読めない失敗になる。
#
# 引数: $1 = 版（go1.26.7）、$2 = 取り出し先ディレクトリ
##
extract_wasm_exec() {
  local version="$1" dest="$2" image

  # 取り出し元は docker/isolated-build/Dockerfile の `FROM golang:${GO_VERSION}` と
  # **同じイメージ**である。隔離ビルドイメージ（1.51 GB）を作らずに済むのは、
  # wasm_exec.js が Go の配布物そのもので、上に積んだ層が触らないためである。
  # --image で明示すれば隔離ビルドイメージからも取り出せる。
  image="${IMAGE_OVERRIDE:-golang:${version#go}}"

  CONTAINER="put-wasm-exec-$$-$(date +%s%N)"
  if ! docker run --name "$CONTAINER" --entrypoint /bin/sh "$image" -c '
      set -eu
      root="$(go env GOROOT)"
      src=""
      # Go 1.24 以降は lib/wasm、1.23 以前は misc/wasm（3.5）。
      for candidate in lib/wasm misc/wasm; do
        if [ -f "$root/$candidate/wasm_exec.js" ]; then
          src="$root/$candidate/wasm_exec.js"
          break
        fi
      done
      if [ -z "$src" ]; then
        echo "wasm_exec.js がイメージ内に見つかりません（GOROOT=$root）" >&2
        exit 1
      fi
      go env GOVERSION > /tmp/goversion
      cp "$src" /tmp/wasm_exec.js
    ' >/dev/null; then
    echo "[put-wasm-exec] ${image} から取り出せません。" >&2
    return 1
  fi

  docker cp "$CONTAINER:/tmp/goversion" "$dest/goversion" >/dev/null
  docker cp "$CONTAINER:/tmp/wasm_exec.js" "$dest/wasm_exec.js" >/dev/null
  docker rm -f "$CONTAINER" >/dev/null
  CONTAINER=""

  local reported
  reported="$(tr -d '[:space:]' < "$dest/goversion")"
  if [[ "$reported" != "$version" ]]; then
    echo "[put-wasm-exec] イメージが申告した版が要求と違います: 要求=${version} イメージ=${reported} (${image})" >&2
    echo "[put-wasm-exec] このまま置くと、読み込みは成功して実行時に壊れます（3.5）。" >&2
    return 1
  fi

  if [[ ! -s "$dest/wasm_exec.js" ]]; then
    echo "[put-wasm-exec] 取り出した wasm_exec.js が空です（${image}）。" >&2
    return 1
  fi
  if ! grep -q "$REQUIRED_SYMBOL" "$dest/wasm_exec.js"; then
    echo "[put-wasm-exec] 取り出した wasm_exec.js に ${REQUIRED_SYMBOL} がありません（${image}）。" >&2
    echo "[put-wasm-exec] src/sandbox-loader.ts はこれを typeof Go === 'function' で見ます。" >&2
    return 1
  fi
}

echo "[put-wasm-exec] bucket=${BUCKET} scope=${SCOPE} versions=${VERSIONS[*]}"
if [[ "$SCOPE" == "--remote" ]]; then
  echo "[put-wasm-exec] **本番の R2 へ書き込みます。**"
fi

failed=0
for version in "${VERSIONS[@]}"; do
  if [[ ! "$version" =~ $VERSION_PATTERN ]]; then
    echo "[put-wasm-exec] 版の綴りが不正です: ${version}" >&2
    failed=$((failed + 1))
    continue
  fi

  dest="$WORK/$version"
  mkdir -p "$dest"
  if ! extract_wasm_exec "$version" "$dest"; then
    failed=$((failed + 1))
    continue
  fi

  key="${KEY_PREFIX}/${version}/${KEY_FILE}"
  # Content-Type は配信側（src/sandbox-delivery.ts）が必ず上書きするので、ここの値は
  # 配信の正しさに効かない。それでも付けるのは、R2 を直接見た人が中身を取り違えないため。
  if ! CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV=false npx wrangler r2 object put \
      "${BUCKET}/${key}" \
      --file "$dest/wasm_exec.js" \
      --content-type "text/javascript; charset=utf-8" \
      "$SCOPE" >/dev/null 2>"$WORK/put.err"; then
    echo "[put-wasm-exec] 置けません: ${BUCKET}/${key}" >&2
    cat "$WORK/put.err" >&2
    failed=$((failed + 1))
    continue
  fi

  echo "[put-wasm-exec] OK ${BUCKET}/${key} ($(wc -c < "$dest/wasm_exec.js") bytes, sha256=$(sha256sum < "$dest/wasm_exec.js" | cut -c1-16)…)"
done

if [[ "$failed" -gt 0 ]]; then
  echo "[put-wasm-exec] ${failed} 件が失敗しました。" >&2
  exit 1
fi

echo "[put-wasm-exec] 置き終わりました。存在の検査は scripts/check-wasm-exec-objects.sh が行います。"
