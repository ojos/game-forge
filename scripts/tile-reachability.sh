#!/usr/bin/env bash
# tile-reachability.sh — タイル地図で面を組む作品について、スタート → カギ → ゴールに届くかを判定する（#675）
#
# 使い方:
#   bash scripts/tile-reachability.sh <ソースのパス> [...]           # 手元のファイルを判定する（オフライン）
#   bash scripts/tile-reachability.sh <作品 id> [...]                # 本番の作品のいまの版を判定する（読み取りのみ）
#   bash scripts/tile-reachability.sh --all-revisions <作品 id>      # 本番の作品の全部の版を判定する（読み取りのみ）
#   --json                                                           # 判定を JSON で出す
#
#   作品 id は /works/<id> の <id>（UUID）。先頭 8 文字以上の前方一致でもよい（1 件に決まらなければ止まる）。
#
# 終了コード:
#   0 = 全部の面で届く / 1 = 届かない面がある / 2 = 使い方の誤り・前提の不成立 / 3 = 判定しない（1 本でも）
#
# **利用者の決定（2026-09-18。仕様 6.1 の #675 注記）:** 判定は運営の手元のこのスクリプトで動かす。本番の
# パイプライン・オーケストレータの束・マイグレーション・source_quality_metrics には入れず、**生成の失敗としては
# 扱わない**（当面は人が見る。止めるかどうかは使ってみてから改めて決める）。読み方は docs/usage-report.md。
#
# **本番へは 1 行も書かない。** D1 は SELECT だけ、R2 は object get だけ。バケット名も source_key も実行時に読む
# （#380 の教訓。事前に埋めた値は古くなる）。資格情報は scripts/load-project-env.sh で環境へ移すだけで、値は
# スクリプトへ持ち込まない（scripts/source-quality-backfill.sh と同じ形）。
#
# **限界: 生成物のコードを手元で動かす。** 本体（scripts/tile-reachability/）は、作品の Go ソースから地図を組み立てる
# 関数と、それが参照する宣言だけを抜き出して go build し、地図と座標を JSON で吐かせる。ゲームループ・描画・main は
# 動かさない。抜き出した先の import が標準ライブラリの計算系（math / strings など）の外——ebiten・os・net・
# math/rand・time など——に届く作品は、動かさずに「判定しない」とする。無限ループには 10 秒の上限を掛けるが、
# メモリの上限は掛けない。取り出し方と「判定しない」条件は scripts/tile-reachability/extract.go の冒頭。
#
# **GNU 拡張を使わない**（利用者の端末は macOS / bash 3.2。docs/handoff.md 3 章）。
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)" || exit 2
ROOT="$(dirname "$HERE")"
TAG="[tile-reachability]"

usage() {
  sed -n '2,13p' "${BASH_SOURCE[0]}" >&2
}

all_revisions=0
json=""
targets=()
for arg in "$@"; do
  case "$arg" in
    -h|--help) usage; exit 0 ;;
    --all-revisions) all_revisions=1 ;;
    --json) json="--json" ;;
    -*) echo "$TAG 不明な引数です: $arg" >&2; exit 2 ;;
    *) targets+=("$arg") ;;
  esac
done
if [[ ${#targets[@]} -eq 0 ]]; then
  usage
  exit 2
fi

if ! command -v go >/dev/null 2>&1; then
  echo "$TAG go がありません（Go のツールチェインを入れてください）。" >&2
  exit 2
fi

WORK="$(mktemp -d "${TMPDIR:-/tmp}/tile-reachability.XXXXXX")" || exit 2
trap 'rm -rf "$WORK"' EXIT
BIN="$WORK/tile-reachability"
if ! (cd "$HERE/tile-reachability" && GOFLAGS='' GOTOOLCHAIN=local go build -o "$BIN" .); then
  echo "$TAG 判定の道具をビルドできません。" >&2
  exit 2
fi

# ── 本番から読む（作品 id を渡したときだけ） ──────────────────────────────────
remote_ready=0
BUCKET=""
prepare_remote() {
  if [[ $remote_ready -eq 1 ]]; then
    return 0
  fi
  if ! command -v node >/dev/null 2>&1; then
    echo "$TAG node がありません（wrangler に要ります）。" >&2
    exit 2
  fi
  if [[ -z "${CLOUDFLARE_API_TOKEN:-}" && -f "$HERE/load-project-env.sh" ]]; then
    # shellcheck source=scripts/load-project-env.sh
    . "$HERE/load-project-env.sh"
  fi
  # 本番の R2 のバケット名を wrangler.toml の [[env.production.r2_buckets]]（binding = "BUCKET"）から読む。
  BUCKET="$(awk '
    /^\[\[env\.production\.r2_buckets\]\]/ { inblock = 1; binding = ""; name = ""; next }
    /^\[/ { if (inblock && binding == "BUCKET" && name != "") { print name; exit } inblock = 0 }
    inblock && /^binding[ \t]*=/ { v = $0; sub(/^[^"]*"/, "", v); sub(/".*$/, "", v); binding = v }
    inblock && /^bucket_name[ \t]*=/ { v = $0; sub(/^[^"]*"/, "", v); sub(/".*$/, "", v); name = v }
    END { if (inblock && binding == "BUCKET" && name != "") print name }
  ' "$ROOT/wrangler.toml" | head -n 1)"
  if [[ -z "$BUCKET" ]]; then
    echo "$TAG wrangler.toml から本番の R2 のバケット名を読めません。" >&2
    exit 2
  fi
  remote_ready=1
}

# D1 へ SELECT を送り、結果の行を「列1<TAB>列2…」で標準出力へ出す。
d1_select() {
  local sql="$1"
  local out
  if ! out="$(cd "$ROOT" && CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV=false npx wrangler d1 execute DB --remote --env production --json --command "$sql" 2>&1)"; then
    echo "$TAG D1 を読めません:" >&2
    printf '%s\n' "$out" | head -n 20 >&2
    exit 2
  fi
  printf '%s' "$out" | node -e '
    let text = "";
    process.stdin.on("data", (c) => { text += c; });
    process.stdin.on("end", () => {
      const start = text.indexOf("[");
      let parsed;
      try { parsed = JSON.parse(text.slice(start)); } catch { console.error("wrangler の応答に JSON がありません"); process.exit(2); }
      if (!Array.isArray(parsed) || !Array.isArray(parsed[0]?.results)) { console.error("D1 の応答の形が想定と違います"); process.exit(2); }
      for (const row of parsed[0].results) {
        console.log(Object.values(row).map((v) => (v === null ? "" : String(v))).join("\t"));
      }
    });
  ' || exit 2
}

files=()
labels=()
fetch_work() {
  local ref="$1"
  prepare_remote
  local ids id count
  if [[ "$ref" =~ ^[0-9a-f-]{36}$ ]]; then
    ids="$(d1_select "SELECT id FROM games WHERE id = '$ref'")"
  else
    ids="$(d1_select "SELECT id FROM games WHERE id LIKE '$ref%' LIMIT 2")"
  fi
  count="$(printf '%s' "$ids" | grep -c . || true)"
  if [[ "$count" -ne 1 ]]; then
    echo "$TAG 作品 id「$ref」に当たる作品が 1 件に決まりません（$count 件）。" >&2
    exit 2
  fi
  id="$ids"

  local rows
  if [[ $all_revisions -eq 1 ]]; then
    rows="$(d1_select "SELECT seq, source_key FROM game_revisions WHERE game_id = '$id' ORDER BY seq")"
  else
    rows="$(d1_select "SELECT 'current', source_key FROM games WHERE id = '$id'")"
  fi
  if [[ -z "$rows" ]]; then
    echo "$TAG 作品 $id にソースのキーがありません。" >&2
    exit 2
  fi
  local seq key name
  while IFS="$(printf '\t')" read -r seq key; do
    if [[ ! "$key" =~ ^builds/[0-9a-f]{64}/source\.go$ ]]; then
      echo "$TAG 作品 $id の版 $seq のソースのキーが想定の形（builds/<sha256>/source.go）でありません。読みません。" >&2
      exit 2
    fi
    name="${id:0:8}-rev-${seq}-$(printf '%s' "$key" | cut -c8-15).go"
    if ! (cd "$ROOT" && CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV=false npx wrangler r2 object get "$BUCKET/$key" --remote --file "$WORK/$name" >/dev/null 2>&1) || [[ ! -s "$WORK/$name" ]]; then
      echo "$TAG R2 から読めません: $key" >&2
      exit 2
    fi
    files+=("$WORK/$name")
    labels+=("$name")
  done <<EOF
$rows
EOF
}

for t in "${targets[@]}"; do
  if [[ -f "$t" ]]; then
    files+=("$t")
    labels+=("$t")
  elif [[ "$t" =~ ^[0-9a-f][0-9a-f-]{7,35}$ ]]; then
    fetch_work "$t"
  else
    echo "$TAG ファイルでも作品 id でもありません: $t" >&2
    exit 2
  fi
done

# 手元のファイルは渡されたパスで、本番から読んだものは一時ディレクトリの名前で表示する。
code=0
for i in "${!files[@]}"; do
  f="${files[$i]}"
  run_dir="$PWD"
  arg="${labels[$i]}"
  if [[ "$f" == "$WORK/"* ]]; then
    run_dir="$WORK"
    arg="${labels[$i]}"
  fi
  if [[ -n "$json" ]]; then
    (cd "$run_dir" && "$BIN" --json "$arg")
  else
    (cd "$run_dir" && "$BIN" "$arg")
  fi
  rc=$?
  case "$rc" in
    0) ;;
    1) if [[ $code -eq 0 ]]; then code=1; fi ;;
    3) code=3 ;;
    *) exit "$rc" ;;
  esac
done
exit "$code"
