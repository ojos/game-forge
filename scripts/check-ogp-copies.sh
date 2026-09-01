#!/usr/bin/env bash
# check-ogp-copies.sh — OGP 撮影の「写し」を機械で突き合わせる（#26 / shared-ai-rules 12 章）
#
# ## なぜ要るのか
#
# OGP の撮影は 4 つの場所にまたがる。
#
#   宣言   terraform/ogp-function.tf    関数名・撮る大きさ・待ち時間
#   エッジ src/ogp.ts / wrangler.toml   メタタグに書く大きさ・呼ぶ相手・コールバックの綴り
#   撮影   docker/ogp-shot/index.mjs    コールバックの綴り・ローダーの合図
#          docker/ogp-shot/config.mjs   **要求する環境変数の名前**
#   配信   src/sandbox-loader.ts        その合図を出す側
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
# - **宣言（environment）から環境変数が落ちる: 関数が起動の時点で落ちる**
#
# ## 撮影関数は値の写しを持たない（#26 のレビューで直した）
#
# 当初 docker/ogp-shot は撮る大きさと待ち時間に既定値（`?? '1200'` など）を持っており、
# **この検査はそれを見ていなかった。** 宣言が落ちても関数は自前の値で走り続け、
# 検査は緑のまま——**確かめていない検査は、確かめた証拠として読まれるぶん赤より悪い**
# （docs/handoff.md 4 章）。
#
# **既定値を消したので、残った結合は「名前」だけである。** 下の 7 番が、撮影関数が
# 要求する名前（config.mjs の REQUIRED_ENV）と terraform の environment を
# **両方向に**突き合わせる。実行時に落ちる前に、宣言のテキストで捕まえる。
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
SHOT_CONFIG="docker/ogp-shot/config.mjs"
WRANGLER="wrangler.toml"

for file in "$TF" "$OGP_TS" "$LOADER_TS" "$SHOT" "$SHOT_CONFIG" "$WRANGLER"; do
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

# 7. **撮影関数が要求する環境変数の名前**と、terraform の environment の宣言。
#    **両方向に見る。** 片方向だと、
#      - 宣言から落ちる  → 関数が本番で起動に失敗する（config.mjs には既定値が無い）
#      - REQUIRED_ENV から落ちる → 既定値を戻した誰かが、宣言なしで走らせられる
#    のどちらかを見逃す。
tf_env_names="$(awk '/^  environment {/,/^  }$/' "$TF" |
  sed -n 's/^[[:space:]]*\([A-Z][A-Z0-9_]*\)[[:space:]]*=.*/\1/p' | sort)"
shot_env_names="$(awk '/^export const REQUIRED_ENV = \[/,/^\];/' "$SHOT_CONFIG" |
  sed -n "s/^[[:space:]]*'\([A-Z][A-Z0-9_]*\)',.*/\1/p" | sort)"
if require "terraform の environment の宣言" "$tf_env_names" &&
  require "docker/ogp-shot/config.mjs の REQUIRED_ENV" "$shot_env_names"; then
  if [[ "$tf_env_names" != "$shot_env_names" ]]; then
    echo "[ogp-copies] 撮影関数が要求する環境変数と、terraform の宣言が食い違っています:" >&2
    echo "  terraform（宣言）:" >&2
    echo "$tf_env_names" | sed 's/^/    - /' >&2
    echo "  config.mjs（要求）:" >&2
    echo "$shot_env_names" | sed 's/^/    - /' >&2
    echo "[ogp-copies] 宣言から落ちると、関数は起動の時点で落ちます（既定値を持たないため）。" >&2
    fail=1
  fi
fi

# 8. 撮影関数が値の既定を持っていないこと。
#
#    **7 番は名前しか見ない。** 既定値が戻ると、名前が宣言から落ちても関数は走り続け、
#    7 番も（名前が両方から消えていれば）緑になる。**値の写しが無いことを直接見る。**
#
#    **この 8 番自身が一度空振りした**（#26 のレビュー中）。最初は
#    `process.env[...] ??` を探していたが、config.mjs が読むのは引数の `source` で
#    あって `process.env` ではないため、既定値を戻す変異が緑のまま通った。
#    **綴りを絞った検査は、対象が別の綴りになった瞬間に何も見なくなる。**
#    いまは 2 つの単純な規則で見る。
#
#      (1) 設定を読む config.mjs に `??` を 1 つも書かない（既定値はこの形でしか書けない）
#      (2) index.mjs は process.env を直接読まない（読み口を 1 か所に保つ）
if grep -n '??' "$SHOT_CONFIG" >/dev/null 2>&1; then
  echo "[ogp-copies] $SHOT_CONFIG に ?? があります（環境変数の既定値の形）。" >&2
  grep -n '??' "$SHOT_CONFIG" | sed 's/^/    /' >&2
  echo "[ogp-copies] 既定値は terraform の宣言の写しです。落ちても走り続けるため、ずれが検査に映りません。" >&2
  fail=1
fi
if grep -n 'process\.env' "$SHOT" >/dev/null 2>&1; then
  echo "[ogp-copies] $SHOT が process.env を直接読んでいます。" >&2
  grep -n 'process\.env' "$SHOT" | sed 's/^/    /' >&2
  echo "[ogp-copies] 環境変数の読み口は $SHOT_CONFIG の readConfig 1 か所に保つこと（7 番の照合が効かなくなります）。" >&2
  fail=1
fi

# 9. 中断した撮影の検出（#235）が読む定数を、実際に取り出せること。
#
#    `scripts/ogp-stale-report.sh` は期限切れの定義（何秒で・どの時刻を起点に）を
#    **src/ogp.ts から sed で取り出す。** 書き写さないためだが、**取り出す側は綴りに
#    依存する**——定数を改名すると、あのスクリプトは実行時まで気づけない。
#
#    **改名した日にここが赤くなる形にしておく。** 見るのは「取り出せるか」だけで、
#    値そのものは見ない（値の正本は src/ogp.ts であって、ここに期待値は無い）。
#
#    **同じ sed を使う。** 別の綴りで確かめると、この検査が緑でもあちらが空を掴む。
STALE_REPORT="scripts/ogp-stale-report.sh"
if [[ -f "$STALE_REPORT" ]]; then
  stale_after="$(sed -n 's/^export const OGP_STALE_AFTER_SECONDS = \([0-9][0-9]*\);.*/\1/p' "$OGP_TS" | head -1)"
  since_sql="$(sed -n "s/^export const OGP_CAPTURE_SINCE_SQL = '\(.*\)';.*/\1/p" "$OGP_TS" | head -1)"
  if require "OGP_STALE_AFTER_SECONDS（$OGP_TS）" "$stale_after" \
    && require "OGP_CAPTURE_SINCE_SQL（$OGP_TS）" "$since_sql"; then
    :
  else
    echo "[ogp-copies] $STALE_REPORT はこの 2 つを sed で取り出します（書き写していません）。" >&2
    echo "[ogp-copies] 改名したなら、あちらの sed も同じコミットで直してください。" >&2
  fi
  # 取り出した綴りが、実際にあのスクリプトの中の sed と同じであること。
  # **別々の綴りで確かめると、この検査だけが緑になる。**
  for needle in 'OGP_STALE_AFTER_SECONDS' 'OGP_CAPTURE_SINCE_SQL'; do
    if ! grep -qF "$needle" "$STALE_REPORT"; then
      echo "[ogp-copies] $STALE_REPORT が $needle を参照していません。" >&2
      echo "[ogp-copies] 定数を読まずに数字を書き写した形になっていないか確かめてください。" >&2
      fail=1
    fi
  done
fi

if [[ "$fail" -ne 0 ]]; then
  exit 1
fi

echo "[ogp-copies] 関数名・撮る大きさ・コールバックの綴り・ローダーの合図・待ち時間・環境変数の名前の 6 組が一致しています"
echo "[ogp-copies] 中断した撮影の検出が読む定数（OGP_STALE_AFTER_SECONDS / OGP_CAPTURE_SINCE_SQL）も取り出せます"
echo "OGP_COPIES_PASS"
