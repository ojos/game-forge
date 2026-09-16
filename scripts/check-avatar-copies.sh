#!/usr/bin/env bash
# check-avatar-copies.sh — アイコン画像の「写し」を機械で突き合わせる（#380 / shared-ai-rules 12 章）
#
# ## なぜ要るのか
#
# アイコンの受け取りと配信は 5 つの場所にまたがり、**同じ値を 2 か所に書く形**が残る
# （`scripts/check-ogp-copies.sh` と同じ事情。環境変数で全部を渡すと、宣言を書き忘れた状態で動く余地が増える）。
#
#   宣言     terraform/avatar-function.tf   関数名・出力の一辺・入力の上限・環境変数
#            terraform/r2-lifecycle.tf      差し替え前の画像の接頭辞と保存日数
#   エッジ   wrangler.toml                  呼ぶ相手（3 環境）
#            src/avatar-paths.ts            出力の一辺・履歴の接頭辞
#            src/avatar-image.ts            入力の上限（容量・寸法）
#            src/avatar.ts                  保存日数（/privacy の文言もここから作る）
#            src/avatar-client.ts           関数が断る理由の綴り
#   関数     lambda/avatar-encode/          要求する環境変数の名前・断る理由の綴り・sharp の版
#   依存     package.json                   テストで使う sharp の版
#
# ## ずれると何が起きるか（どれも「黙って壊れる」か「約束が嘘になる」）
#
# - 関数名がずれる: 設定がすべて「保存できませんでした」になる（ResourceNotFound）
# - 出力の一辺がずれる: Worker が変換結果を「配ってよい形ではない」と捨て、すべて失敗する
# - 入力の上限がずれる: Worker が通した画像を関数が断る（または逆に、Worker だけが緩む）
# - **履歴の接頭辞がずれる: 差し替え前の画像が 30 日で消えない（`/privacy` が嘘になる）か、別の画像を消す**
# - **保存日数がずれる: `/privacy` と画面に書いた日数と、実際に消える日数が食い違う**
# - 断る理由の綴りがずれる: 関数が断った理由を Worker が「読めない応答」として扱う
# - 環境変数が宣言から落ちる: 関数が起動の時点で落ちる（config.mjs は既定値を持たない）
# - sharp の版がずれる: テストで確かめた版と、本番に載る版が違う
#
# 使い方:
#   bash scripts/check-avatar-copies.sh
#
# 終了コード: 0 = 合格（標準出力 AVATAR_COPIES_PASS）/ 非0 = 不合格
#
# **GNU 拡張を使わない**（利用者の端末は macOS / bash 3.2。docs/handoff.md 3 章）。
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$(dirname "$HERE")"

TF="terraform/avatar-function.tf"
LIFECYCLE_TF="terraform/r2-lifecycle.tf"
WRANGLER="wrangler.toml"
PATHS_TS="src/avatar-paths.ts"
IMAGE_TS="src/avatar-image.ts"
AVATAR_TS="src/avatar.ts"
CLIENT_TS="src/avatar-client.ts"
CONFIG_MJS="lambda/avatar-encode/config.mjs"
ENCODE_MJS="lambda/avatar-encode/encode.mjs"
LAMBDA_PACKAGE="lambda/avatar-encode/package.json"
ROOT_PACKAGE="package.json"

for file in "$TF" "$LIFECYCLE_TF" "$WRANGLER" "$PATHS_TS" "$IMAGE_TS" "$AVATAR_TS" "$CLIENT_TS" \
  "$CONFIG_MJS" "$ENCODE_MJS" "$LAMBDA_PACKAGE" "$ROOT_PACKAGE"; do
  if [[ ! -f "$file" ]]; then
    echo "[avatar-copies] 照合の対象がありません: $file" >&2
    echo "[avatar-copies] 検査が成立しないため失敗させます（見ていないことを合格にしない）。" >&2
    exit 1
  fi
done

fail=0

# 値が空のまま比較へ進むと、空どうしが一致して緑になる（#160 の事故）。取り出せなかった時点で落とす。
require() {
  # $1 = 説明, $2 = 取り出した値
  if [[ -z "$2" ]]; then
    echo "[avatar-copies] 値を取り出せませんでした: $1" >&2
    echo "[avatar-copies] **空のまま比較すると、空どうしが一致して緑になります。**" >&2
    fail=1
    return 1
  fi
  return 0
}

compare() {
  # $1 = 説明, $2 = 期待（正本）, $3 = 実際（写し）
  if [[ "$2" != "$3" ]]; then
    echo "[avatar-copies] $1 がずれています: 正本=$2 写し=$3" >&2
    fail=1
  else
    echo "[avatar-copies] ok $1 = $2"
  fi
}

# terraform の `name = 数` を読む。
tf_number() {
  # $1 = ファイル, $2 = local の名前
  sed -n "s/^[[:space:]]*$2[[:space:]]*=[[:space:]]*\([0-9][0-9]*\)[[:space:]]*\$/\1/p" "$1" | head -1
}

# terraform の `name = "文字列"` を読む。
tf_string() {
  # $1 = ファイル, $2 = local の名前
  sed -n "s/^[[:space:]]*$2[[:space:]]*=[[:space:]]*\"\([^\"]*\)\".*/\1/p" "$1" | head -1
}

# TypeScript の `export const NAME = 式;` の式を読む（数と `*` と空白だけの式を計算する）。
ts_number() {
  # $1 = ファイル, $2 = 定数名
  local expr
  expr="$(sed -n "s/^export const $2[[:space:]]*=[[:space:]]*\([0-9][0-9 *]*\);.*/\1/p" "$1" | head -1)"
  [[ -n "$expr" ]] || return 0
  echo $((expr))
}

# TypeScript の `export const NAME = '文字列';` を読む。
ts_string() {
  # $1 = ファイル, $2 = 定数名
  sed -n "s/^export const $2[[:space:]]*=[[:space:]]*'\([^']*\)';.*/\1/p" "$1" | head -1
}

# ── 1. 関数名（正本は terraform、写しは wrangler.toml の 3 環境）──────────────
tf_function_name="$(tf_string "$TF" avatar_function_name)"
if require "terraform の avatar_function_name" "$tf_function_name"; then
  wrangler_names="$(sed -n 's/^[[:space:]]*AVATAR_FUNCTION_NAME[[:space:]]*=[[:space:]]*"\([^"]*\)".*/\1/p' "$WRANGLER")"
  if require "wrangler.toml の AVATAR_FUNCTION_NAME" "$wrangler_names"; then
    count=0
    while IFS= read -r name; do
      [[ -n "$name" ]] || continue
      count=$((count + 1))
      compare "関数名（wrangler.toml の $count 件目）" "$tf_function_name" "$name"
    done <<EOF
$wrangler_names
EOF
    # ローカル・production・preview の 3 つ。**vars は名前付き環境へ引き継がれない。**
    if [[ "$count" -ne 3 ]]; then
      echo "[avatar-copies] wrangler.toml の AVATAR_FUNCTION_NAME が 3 件ではありません（${count} 件）。" >&2
      fail=1
    fi
  fi
fi

# ── 2. 出力の一辺（正本は terraform、写しは src/avatar-paths.ts）──────────────
tf_size="$(tf_number "$TF" avatar_output_size)"
ts_size="$(ts_number "$PATHS_TS" AVATAR_OUTPUT_SIZE)"
if require "terraform の avatar_output_size" "$tf_size" && require "src/avatar-paths.ts の AVATAR_OUTPUT_SIZE" "$ts_size"; then
  compare "出力の一辺" "$tf_size" "$ts_size"
fi

# ── 3. 入力の上限（正本は terraform、写しは src/avatar-image.ts）──────────────
tf_bytes="$(tf_number "$TF" avatar_max_input_bytes)"
ts_bytes="$(ts_number "$IMAGE_TS" AVATAR_MAX_BYTES)"
if require "terraform の avatar_max_input_bytes" "$tf_bytes" && require "src/avatar-image.ts の AVATAR_MAX_BYTES" "$ts_bytes"; then
  compare "入力の容量の上限" "$tf_bytes" "$ts_bytes"
fi
tf_dimension="$(tf_number "$TF" avatar_max_input_dimension)"
ts_dimension="$(ts_number "$IMAGE_TS" AVATAR_MAX_DIMENSION)"
if require "terraform の avatar_max_input_dimension" "$tf_dimension" && require "src/avatar-image.ts の AVATAR_MAX_DIMENSION" "$ts_dimension"; then
  compare "入力の寸法の上限" "$tf_dimension" "$ts_dimension"
fi
# **容量の上限は、Lambda の同期呼び出しの要求の上限（6 MB）に base64 で収まること。**
if [[ -n "$tf_bytes" ]] && (( (tf_bytes + 2) / 3 * 4 + 64 > 6 * 1024 * 1024 )); then
  echo "[avatar-copies] 入力の上限（${tf_bytes} バイト）を base64 にすると、同期呼び出しの要求の上限（6 MB）を超えます。" >&2
  fail=1
fi

# ── 4. 差し替え前の画像の接頭辞と保存日数（正本は r2-lifecycle.tf）────────────
tf_prefix="$(tf_string "$LIFECYCLE_TF" avatar_history_prefix)"
ts_prefix="$(ts_string "$PATHS_TS" AVATAR_HISTORY_PREFIX)"
if require "terraform の avatar_history_prefix" "$tf_prefix" && require "src/avatar-paths.ts の AVATAR_HISTORY_PREFIX" "$ts_prefix"; then
  compare "履歴の接頭辞" "$tf_prefix" "$ts_prefix"
  # **末尾の `/` を落とさない**（`avatars/history` は `avatars/historyX` にも当たる）。
  case "$tf_prefix" in
    */) ;;
    *)
      echo "[avatar-copies] 履歴の接頭辞が / で終わっていません: ${tf_prefix}" >&2
      fail=1
      ;;
  esac
  # **現行の画像の接頭辞を覆わない**（`avatars/` にすると、現行のアイコンまで 30 日で消える）。
  ts_current_prefix="$(ts_string "$PATHS_TS" AVATAR_OBJECT_PREFIX)"
  if require "src/avatar-paths.ts の AVATAR_OBJECT_PREFIX" "$ts_current_prefix" && [[ "$tf_prefix" == "$ts_current_prefix" ]]; then
    echo "[avatar-copies] 履歴の接頭辞が、現行の画像の接頭辞と同じです（現行のアイコンが年齢で消えます）。" >&2
    fail=1
  fi
fi
# ── 4.2 退会がアイコンを消すとき、接頭辞とキーを定数から取る（#518 / #586）────
#
# **退会は `avatars/history/<user_id>/` を一覧して全部消す**（`src/withdrawal.ts` の段2）。
# D1 の `avatar_changes.history_key` に頼らないのは、**記録の無い写し**（履歴の行を書く前に
# 落ちた操作）まで消すためである。そのぶん、**接頭辞の綴りを書き写すと、接頭辞を変えた日に
# 退会だけが古い場所を消しに行く**——消えない写しが残り、`/privacy` の約束が嘘になる。
# だから `src/avatar-paths.ts` から import していることを機械で見る。
WITHDRAWAL_TS="src/withdrawal.ts"
if [[ -f "$WITHDRAWAL_TS" ]]; then
  # **`\b` を使わない。** GNU の拡張で、BSD / macOS の grep では効かず、**検査が空振りする**
  # （利用者の端末は macOS。`scripts/check-shell-portability.sh` と同じ理由。PR #588 の Copilot の指摘）。
  # import の `{ … }` の中身を取り出し、空白を落として `,` で挟んで完全一致で引く。
  imported="$(sed -n "s/^import {\(.*\)} from '\.\/avatar-paths\.js';\$/\1/p" "$WITHDRAWAL_TS" | tr -d ' \t')"
  if [[ -z "$imported" ]]; then
    echo "[avatar-copies] ${WITHDRAWAL_TS} に src/avatar-paths.ts からの import がありません（1 行の形で書くこと）。" >&2
    fail=1
  fi
  for symbol in AVATAR_HISTORY_PREFIX avatarObjectKey; do
    case ",${imported}," in
      *",${symbol},"*) ;;
      *)
        echo "[avatar-copies] ${WITHDRAWAL_TS} が ${symbol} を src/avatar-paths.ts から import していません。" >&2
        echo "[avatar-copies] **接頭辞やキーの綴りを書き写すと、変えた日に退会だけが古い場所を消します。**" >&2
        fail=1
        ;;
    esac
  done
  # **文字列リテラルで接頭辞を書いていない**ことも見る（import したうえで別に書けてしまう）。
  if grep -q "'avatars/" "$WITHDRAWAL_TS"; then
    echo "[avatar-copies] ${WITHDRAWAL_TS} に 'avatars/…' のリテラルがあります（定数から組み立てること）。" >&2
    fail=1
  fi
  echo "[avatar-copies] ok ${WITHDRAWAL_TS} は接頭辞とキーを src/avatar-paths.ts から取っている"
fi

tf_days="$(tf_number "$LIFECYCLE_TF" avatar_history_retention_days)"
ts_days="$(ts_number "$AVATAR_TS" AVATAR_HISTORY_RETENTION_DAYS)"
if require "terraform の avatar_history_retention_days" "$tf_days" && require "src/avatar.ts の AVATAR_HISTORY_RETENTION_DAYS" "$ts_days"; then
  compare "差し替え前の画像の保存日数" "$tf_days" "$ts_days"
fi

# ── 4.5 排他の持ち時間は、関数のタイムアウトの 2 倍以上（PR #436）────────────
# **短いと、変換を待っている間に排他が切れ、同じ利用者のもう 1 本が R2 に書き始める**（src/avatar.ts）。
tf_timeout="$(tf_number "$TF" avatar_function_timeout_seconds)"
ts_lock="$(ts_number "$AVATAR_TS" AVATAR_LOCK_SECONDS)"
if require "terraform の avatar_function_timeout_seconds" "$tf_timeout" && require "src/avatar.ts の AVATAR_LOCK_SECONDS" "$ts_lock"; then
  if (( ts_lock < tf_timeout * 2 )); then
    echo "[avatar-copies] 排他の持ち時間（${ts_lock} 秒）が、関数のタイムアウト（${tf_timeout} 秒）の 2 倍より短いです。" >&2
    fail=1
  else
    echo "[avatar-copies] ok 排他の持ち時間 ${ts_lock} 秒 >= タイムアウト ${tf_timeout} 秒 × 2"
  fi
fi

# ── 5. 関数が要求する環境変数の名前と、terraform の environment（両方向）──────
tf_env_names="$(awk '/^  environment {/,/^  }$/' "$TF" |
  sed -n 's/^[[:space:]]*\([A-Z][A-Z0-9_]*\)[[:space:]]*=.*/\1/p' | LC_ALL=C sort)"
lambda_env_names="$(sed -n 's/^export const REQUIRED_ENV = \[\(.*\)\];.*/\1/p' "$CONFIG_MJS" |
  tr ',' '\n' | sed -n "s/^[[:space:]]*'\([A-Z][A-Z0-9_]*\)'[[:space:]]*$/\1/p" | LC_ALL=C sort)"
if require "terraform の environment の宣言" "$tf_env_names" && require "lambda/avatar-encode/config.mjs の REQUIRED_ENV" "$lambda_env_names"; then
  compare "関数の環境変数の名前" "$(echo "$tf_env_names" | tr '\n' ' ')" "$(echo "$lambda_env_names" | tr '\n' ' ')"
fi
# **関数は値の既定を持たない**（名前だけの照合は、既定値が戻った日に空振りする。check-ogp-copies.sh 8 番と同じ）。
if grep -F '??' "$CONFIG_MJS" >/dev/null; then
  echo "[avatar-copies] $CONFIG_MJS にヌル合体演算子があります（既定値を持たない約束です）。" >&2
  fail=1
fi

# ── 6. 関数が断る理由の綴り（正本は関数、写しは src/avatar-client.ts）──────────
lambda_rejections="$(sed -n 's/^export const REJECTIONS = \[\(.*\)\];.*/\1/p' "$ENCODE_MJS" | tr -d " '")"
ts_rejections="$(sed -n "s/^export const AVATAR_ENCODE_REJECTIONS = \[\(.*\)\] as const;.*/\1/p" "$CLIENT_TS" | tr -d " '")"
if require "lambda/avatar-encode/encode.mjs の REJECTIONS" "$lambda_rejections" && require "src/avatar-client.ts の AVATAR_ENCODE_REJECTIONS" "$ts_rejections"; then
  compare "関数が断る理由の綴り" "$lambda_rejections" "$ts_rejections"
fi

# ── 7. sharp の版（関数に載せる版と、テストで確かめる版）──────────────────────
lambda_sharp="$(sed -n 's/^[[:space:]]*"sharp":[[:space:]]*"\([^"]*\)".*/\1/p' "$LAMBDA_PACKAGE" | head -1)"
root_sharp="$(sed -n 's/^[[:space:]]*"sharp":[[:space:]]*"\([^"]*\)".*/\1/p' "$ROOT_PACKAGE" | head -1)"
if require "lambda/avatar-encode/package.json の sharp" "$lambda_sharp" && require "package.json の sharp" "$root_sharp"; then
  compare "sharp の版" "$lambda_sharp" "$root_sharp"
  # **版は固定する**（`^` / `~` を付けると、テストした版と載る版が静かに離れる）。
  case "$lambda_sharp" in
    [0-9]*) ;;
    *)
      echo "[avatar-copies] sharp の版が固定されていません: ${lambda_sharp}" >&2
      fail=1
      ;;
  esac
fi

if [[ "$fail" -ne 0 ]]; then
  echo "AVATAR_COPIES_FAIL"
  exit 1
fi
echo "AVATAR_COPIES_PASS"
