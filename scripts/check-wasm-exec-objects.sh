#!/usr/bin/env bash
# check-wasm-exec-objects.sh — 配信が要求する wasm_exec.js が R2 に在ることを検査する（3.5 / #139）
#
# **#139 の受け入れ条件そのものである**（「必要な版のオブジェクトが R2 に存在することを
# 非対話で検査でき、終了コードで合否が出る」）。
#
# # 何を見ているのか
#
# src/sandbox-delivery.ts は `games.go_version` から `runtime/<版>/wasm_exec.js` を組み立て、
# **無ければ別の版へ落とさず 500 を返す。** つまり「置き忘れ」は必ず配信の 500 として
# 現れ、しかも**その版の作品だけ**が壊れる。プレイして初めて分かる形になっていたのを、
# ここで終了コードにする。
#
# # 何を見ていないのか（隠さない）
#
# **中身が本当にその版のものかは検査できない。** wasm_exec.js には版を名乗る記号が無く、
# 実測でも go1.26.5 と go1.26.7 のファイルは**バイト単位で同一**だった（sha256
# 0c949f49…）。したがってここで見るのは「在ること」と「配信側が要求する記号を持つこと」
# までである。**版の取り違えを防ぐのは配置側**（scripts/put-wasm-exec.sh が、イメージ自身に
# `go env GOVERSION` を申告させて照合する）。
#
# 使い方:
#   bash scripts/check-wasm-exec-objects.sh            # ローカル R2
#   bash scripts/check-wasm-exec-objects.sh --remote   # 本番 R2（読み取りのみ）
#
# 終了コード: 0 = 全件在る（標準出力 WASM_EXEC_PASS）/ 1 = 1 件でも欠けている
#
# set -e は使わない。1 件目の欠落で止めると、2 件目以降の欠落に往復が要る。
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)" || exit 1
ROOT="$(dirname "$HERE")" || exit 1
cd "$ROOT" || exit 1

readonly KEY_PREFIX="runtime"
readonly KEY_FILE="wasm_exec.js"
readonly REQUIRED_SYMBOL="globalThis.Go"

SCOPE="--local"
BUCKET=""

# 道具の不在は前提の不成立であって、オブジェクトの欠落ではない。
# （jq は scripts/wasm-exec-versions.sh 側が自分で確認する。ここでは使っていない。）
command -v npx >/dev/null 2>&1 || {
  echo "[check-wasm-exec] npx がありません。検査が成立しないため失敗させます。" >&2
  echo "WASM_EXEC_FAIL"
  exit 1
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --local)  SCOPE="--local";  shift ;;
    --remote) SCOPE="--remote"; shift ;;
    --bucket)
      # 値が無いと shift 2 自体が失敗し、読めない赤になる（put-wasm-exec.sh と同じ）。
      [[ $# -ge 2 && -n "$2" ]] || { echo "[check-wasm-exec] --bucket には値が要ります。" >&2; exit 1; }
      BUCKET="$2"; shift 2 ;;
    -h|--help)
      sed -n '2,30p' "${BASH_SOURCE[0]}" >&2
      exit 0 ;;
    *)
      echo "[check-wasm-exec] 不明な引数です: $1" >&2
      exit 1 ;;
  esac
done

##
# wrangler.toml から R2 バケット名を読む（scripts/put-wasm-exec.sh と同じ理由で書き写さない）。
#
# 引数: $1 = セクション名
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
  echo "[check-wasm-exec] wrangler.toml から R2 バケット名を読めません（${SCOPE}）。" >&2
  exit 1
fi

# 要る版の導出。**失敗を合格にしない。** 導出できないのは「欠落が無い」ことではなく
# 「検査が成立していない」ことである。
if ! versions="$(bash "$HERE/wasm-exec-versions.sh" "$SCOPE")"; then
  echo "[check-wasm-exec] 要る版を導出できませんでした。検査が成立しないため失敗させます。" >&2
  echo "WASM_EXEC_FAIL"
  exit 1
fi

WORK="$(mktemp -d "${TMPDIR:-/tmp}/check-wasm-exec.XXXXXX")" || exit 1
trap 'rm -rf "$WORK"' EXIT

echo "[check-wasm-exec] bucket=${BUCKET} scope=${SCOPE}"

missing=0
checked=0
while IFS= read -r version; do
  [[ -z "$version" ]] && continue
  checked=$((checked + 1))
  key="${KEY_PREFIX}/${version}/${KEY_FILE}"
  out="$WORK/${version}.js"

  if ! CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV=false npx wrangler r2 object get \
      "${BUCKET}/${key}" --file "$out" "$SCOPE" >"$WORK/get.log" 2>&1; then
    echo "[check-wasm-exec] NG ${BUCKET}/${key} — ありません" >&2
    echo "[check-wasm-exec]    この版の作品は配信が 500 になります（src/sandbox-delivery.ts）。" >&2
    echo "[check-wasm-exec]    置き方: bash scripts/put-wasm-exec.sh ${SCOPE} ${version}" >&2
    missing=$((missing + 1))
    continue
  fi

  if [[ ! -s "$out" ]] || ! grep -q "$REQUIRED_SYMBOL" "$out"; then
    echo "[check-wasm-exec] NG ${BUCKET}/${key} — 在るが ${REQUIRED_SYMBOL} を持ちません" >&2
    echo "[check-wasm-exec]    src/sandbox-loader.ts が typeof Go === 'function' で落とします。" >&2
    missing=$((missing + 1))
    continue
  fi

  # `wc -c` は実装によって前後に空白を付ける（macOS は付ける）。表示に混ぜない。
  echo "[check-wasm-exec] OK ${BUCKET}/${key} ($(wc -c < "$out" | tr -d "[:space:]") bytes)"
done <<<"$versions"

if [[ "$checked" -eq 0 ]]; then
  echo "[check-wasm-exec] 検査対象が 0 件でした。検査が成立していないため合格にしません。" >&2
  echo "WASM_EXEC_FAIL"
  exit 1
fi

if [[ "$missing" -gt 0 ]]; then
  echo "[check-wasm-exec] ${missing} / ${checked} 件が欠けています。" >&2
  echo "WASM_EXEC_FAIL"
  exit 1
fi

echo "[check-wasm-exec] ${checked} 件すべて在ります。"
echo "WASM_EXEC_PASS"
