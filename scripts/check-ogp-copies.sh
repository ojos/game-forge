#!/usr/bin/env bash
# check-ogp-copies.sh — OGP 撮影の「写し」を機械で突き合わせる（#26 / shared-ai-rules 12 章）
#
# ## なぜ要るのか
#
# OGP の撮影は 4 つの場所にまたがる。
#
#   宣言   terraform/ogp-function.tf   関数名・撮る大きさ・待ち時間
#   エッジ src/ogp.ts / wrangler.toml  メタタグに書く大きさ・呼ぶ相手・コールバックの綴り
#   撮影   docker/ogp-shot/index.mjs   コールバックの綴り・ローダーの合図
#   配信   src/sandbox-loader.ts       その合図を出す側
#
# **どれも「同じ値を 2 か所に書く」形になっている。** 環境変数で全部を渡す形にすれば
# 写しは消えるが、そのぶん宣言を書き忘れた状態で動く余地が増える（撮影関数の
# `readConfig` が既定値を持たないのはそのためである）。**写しを残すなら、機械で照合する。**
#
# ## ずれると何が起きるか（どれも「黙って壊れる」）
#
# - 関数名がずれる: 公開はできるが撮影が呼べない（ResourceNotFound）
# - コールバックの綴りがずれる: 撮れた画像が届かず、ogp_state が capturing のまま残る
# - **ローダーの合図の id がずれる: 撮影が必ず時間切れになる**（合図が永遠に来ない）
# - 大きさがずれる: メタタグの og:image:width と実物が食い違う
# - 関数の中で諦める時間 >= Lambda のタイムアウト: 失敗のコールバックを送る前に切られる
#
# 使い方:
#   bash scripts/check-ogp-copies.sh
#
# 終了コード: 0 = 合格（標準出力 OGP_COPIES_PASS）/ 非0 = 不合格
#
# **GNU 拡張を使わない**（利用者の端末は macOS / bash 3.2。docs/handoff.md 3 章）。
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$(dirname "$HERE")"

TF="terraform/ogp-function.tf"
OGP_TS="src/ogp.ts"
LOADER_TS="src/sandbox-loader.ts"
SHOT="docker/ogp-shot/index.mjs"
WRANGLER="wrangler.toml"

for file in "$TF" "$OGP_TS" "$LOADER_TS" "$SHOT" "$WRANGLER"; do
  if [[ ! -f "$file" ]]; then
    echo "[ogp-copies] 照合の対象がありません: $file" >&2
    echo "[ogp-copies] 検査が成立しないため失敗させます（見ていないことを合格にしない）。" >&2
    exit 1
  fi
done

fail=0

# 値が空のまま比較へ進むと、空どうしが一致して緑になる（#160 の事故）。
# **取り出せなかった時点で落とす。**
require() {
  # $1 = 説明, $2 = 取り出した値
  if [[ -z "$2" ]]; then
    echo "[ogp-copies] 値を取り出せませんでした: $1" >&2
    echo "[ogp-copies] **空のまま比較すると、空どうしが一致して緑になります。**" >&2
    fail=1
    return 1
  fi
  return 0
}

compare() {
  # $1 = 説明, $2 = 期待（正本）, $3 = 実際（写し）
  if [[ "$2" != "$3" ]]; then
    echo "[ogp-copies] $1 がずれています: 正本=$2 写し=$3" >&2
    fail=1
  fi
}

# 1. 関数名。正本は terraform、写しは wrangler.toml（3 つの環境すべて）。
tf_function_name="$(sed -n 's/^[[:space:]]*ogp_function_name[[:space:]]*=[[:space:]]*"\([^"]*\)".*/\1/p' "$TF" | head -1)"
if require "terraform の ogp_function_name" "$tf_function_name"; then
  wrangler_names="$(sed -n 's/^[[:space:]]*OGP_FUNCTION_NAME[[:space:]]*=[[:space:]]*"\([^"]*\)".*/\1/p' "$WRANGLER")"
  if require "wrangler.toml の OGP_FUNCTION_NAME" "$wrangler_names"; then
    count=0
    while IFS= read -r name; do
      [[ -n "$name" ]] || continue
      count=$((count + 1))
      compare "関数名（wrangler.toml の $count 件目）" "$tf_function_name" "$name"
    done <<EOF
$wrangler_names
EOF
    # ローカル・production・preview の 3 つ。**1 つでも欠けると、その環境だけ
    # 呼び先を持たない**（wrangler の vars は環境へ引き継がれない）。
    if [[ "$count" -ne 3 ]]; then
      echo "[ogp-copies] wrangler.toml の OGP_FUNCTION_NAME が 3 件ではありません（${count} 件）。" >&2
      echo "[ogp-copies] vars は名前付き環境へ引き継がれません（トップレベル / production / preview）。" >&2
      fail=1
    fi
  fi
fi

# 2. 撮る大きさ。正本は terraform、写しは src/ogp.ts（メタタグに書く値）。
tf_width="$(sed -n 's/^[[:space:]]*ogp_viewport_width[[:space:]]*=[[:space:]]*\([0-9][0-9]*\).*/\1/p' "$TF" | head -1)"
tf_height="$(sed -n 's/^[[:space:]]*ogp_viewport_height[[:space:]]*=[[:space:]]*\([0-9][0-9]*\).*/\1/p' "$TF" | head -1)"
ts_width="$(sed -n 's/^export const OGP_IMAGE_WIDTH[[:space:]]*=[[:space:]]*\([0-9][0-9]*\);.*/\1/p' "$OGP_TS" | head -1)"
ts_height="$(sed -n 's/^export const OGP_IMAGE_HEIGHT[[:space:]]*=[[:space:]]*\([0-9][0-9]*\);.*/\1/p' "$OGP_TS" | head -1)"
if require "terraform の ogp_viewport_width" "$tf_width" &&
  require "src/ogp.ts の OGP_IMAGE_WIDTH" "$ts_width"; then
  compare "撮る幅" "$tf_width" "$ts_width"
fi
if require "terraform の ogp_viewport_height" "$tf_height" &&
  require "src/ogp.ts の OGP_IMAGE_HEIGHT" "$ts_height"; then
  compare "撮る高さ" "$tf_height" "$ts_height"
fi

# 3. コールバックの綴り。正本は src/ogp.ts、写しは撮影関数。
ts_callback="$(sed -n "s/^export const OGP_CALLBACK_PATH[[:space:]]*=[[:space:]]*'\([^']*\)';.*/\1/p" "$OGP_TS" | head -1)"
shot_callback="$(sed -n "s/^const CALLBACK_PATH[[:space:]]*=[[:space:]]*'\([^']*\)';.*/\1/p" "$SHOT" | head -1)"
if require "src/ogp.ts の OGP_CALLBACK_PATH" "$ts_callback" &&
  require "docker/ogp-shot の CALLBACK_PATH" "$shot_callback"; then
  compare "コールバックのパス" "$ts_callback" "$shot_callback"
fi

# 4. コールバックのヘッダ名。
ts_game_header="$(sed -n "s/^export const OGP_GAME_ID_HEADER[[:space:]]*=[[:space:]]*'\([^']*\)';.*/\1/p" "$OGP_TS" | head -1)"
ts_token_header="$(sed -n "s/^export const OGP_TOKEN_HEADER[[:space:]]*=[[:space:]]*'\([^']*\)';.*/\1/p" "$OGP_TS" | head -1)"
shot_game_header="$(sed -n "s/^const GAME_ID_HEADER[[:space:]]*=[[:space:]]*'\([^']*\)';.*/\1/p" "$SHOT" | head -1)"
shot_token_header="$(sed -n "s/^const TOKEN_HEADER[[:space:]]*=[[:space:]]*'\([^']*\)';.*/\1/p" "$SHOT" | head -1)"
if require "src/ogp.ts の OGP_GAME_ID_HEADER" "$ts_game_header" &&
  require "docker/ogp-shot の GAME_ID_HEADER" "$shot_game_header"; then
  compare "作品 id のヘッダ名" "$ts_game_header" "$shot_game_header"
fi
if require "src/ogp.ts の OGP_TOKEN_HEADER" "$ts_token_header" &&
  require "docker/ogp-shot の TOKEN_HEADER" "$shot_token_header"; then
  compare "トークンのヘッダ名" "$ts_token_header" "$shot_token_header"
fi

# 5. **ローダーの合図。** ここがずれると撮影は必ず時間切れになる。
#    正本は src/sandbox-loader.ts（合図を出す側）。
loader_id="$(sed -n 's/.*id="\(gf-[a-z-]*\)".*/\1/p' "$LOADER_TS" | head -1)"
shot_id="$(sed -n "s/^const LOADER_STATUS_ID[[:space:]]*=[[:space:]]*'\([^']*\)';.*/\1/p" "$SHOT" | head -1)"
if require "src/sandbox-loader.ts の合図の id" "$loader_id" &&
  require "docker/ogp-shot の LOADER_STATUS_ID" "$shot_id"; then
  compare "ローダーの合図の id" "$loader_id" "$shot_id"
fi
# 合図そのもの（hidden にする側）が残っていることまで見る。**id だけを見ると、
# ローダーが「隠す」のをやめた日に気づけない。**
if ! grep -q 'hidden = true' "$LOADER_TS"; then
  echo "[ogp-copies] $LOADER_TS が起動時に合図（hidden = true）を出さなくなっています。" >&2
  echo "[ogp-copies] 撮影は合図を待つので、これが無いと必ず時間切れになります。" >&2
  fail=1
fi

# 6. 関数の中で諦める時間 < Lambda のタイムアウト。
tf_capture_ms="$(sed -n 's/^[[:space:]]*ogp_capture_timeout_ms[[:space:]]*=[[:space:]]*\([0-9][0-9]*\).*/\1/p' "$TF" | head -1)"
tf_timeout_s="$(sed -n 's/^[[:space:]]*ogp_function_timeout_seconds[[:space:]]*=[[:space:]]*\([0-9][0-9]*\).*/\1/p' "$TF" | head -1)"
if require "terraform の ogp_capture_timeout_ms" "$tf_capture_ms" &&
  require "terraform の ogp_function_timeout_seconds" "$tf_timeout_s"; then
  if [[ "$tf_capture_ms" -ge $((tf_timeout_s * 1000)) ]]; then
    echo "[ogp-copies] 関数の中で諦める時間（${tf_capture_ms} ms）が Lambda のタイムアウト（${tf_timeout_s} s）以上です。" >&2
    echo "[ogp-copies] 失敗のコールバックを送る前に切られ、ogp_state が capturing のまま残ります。" >&2
    fail=1
  fi
fi

if [[ "$fail" -ne 0 ]]; then
  exit 1
fi

echo "[ogp-copies] 関数名・撮る大きさ・コールバックの綴り・ローダーの合図・待ち時間の 5 組が一致しています"
echo "OGP_COPIES_PASS"
