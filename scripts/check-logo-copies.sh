#!/usr/bin/env bash
# check-logo-copies.sh — サイトが配るロゴの画像が、正本（brand/logo/）の写しであることを機械で見る（#440 / shared-ai-rules 12 章）
#
# ## なぜ要るのか
#
# **Pages が配るのは `public/` の下だけ**なので、ヘッダとフッタのロゴは `brand/logo/lockup-horizontal/`
# の PNG を `public/assets/logo/` へ写して使っている（`src/html.ts` の `LOGO_DIR`）。写しは 2 か所に
# 同じ画像を置く形であり、**ロゴを書き出し直して（`node tools/logobake/main.mjs`）写し忘れると、
# サイトだけが古いロゴのまま黙って残る。** `tools/logobake/main.mjs --check` が見るのは
# `brand/logo/` だけで、写しの側は見ない。
#
# ## 見るもの
#
#   1. `src/html.ts` の `LOGO_SCALES` の倍率 × 明暗（light / dark）の画像が、`public/assets/logo/` に
#      すべてあり、`brand/logo/lockup-horizontal/` の同名の画像と**バイト単位で一致する**
#      （写しは複製なので、画素ではなくバイトで比べてよい。`tools/logobake` が画素で照合するのは
#      zlib の版でバイト列が変わりうるからで、ここで比べるのは同じファイルの複製どうしである）
#   2. `public/assets/logo/` に、上の一覧に無い画像が残っていない（使わない画像を配らない）
#   3. 1 倍の画像の実寸が、`src/html.ts` の `LOGO_WIDTH` × `LOGO_HEIGHT` と一致する
#      （HTML の `width` / `height` がずれると、ドットが整数倍でなく引き伸ばされる。`docs/logo.md` 3 章）
#   4. トップの `og:image`（`src/html.ts` の `SOCIAL_OGP_PATH`）の写しが `brand/logo/social/` の
#      同名の画像とバイト単位で一致し、その実寸が `src/ogp.ts` の `OGP_IMAGE_WIDTH` ×
#      `OGP_IMAGE_HEIGHT` と一致する（#786）。**HTML は `og:image:width` / `og:image:height` に
#      その定数を出す**ので、ずれると「宣言した寸法と違う画像」を外へ配ることになる
#
# 使い方:
#   bash scripts/check-logo-copies.sh
#
# 終了コード: 0 = 合格（標準出力 LOGO_COPIES_PASS）/ 非0 = 不合格
#
# **GNU 拡張を使わない**（利用者の端末は macOS / bash 3.2。docs/handoff.md 3 章）。
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$(dirname "$HERE")"

HTML_TS="src/html.ts"
SOURCE_DIR="brand/logo/lockup-horizontal"

fail() {
  echo "[logo-copies] $1" >&2
  exit 1
}

[[ -f "$HTML_TS" ]] || fail "照合の対象がありません: $HTML_TS（見ていないことを合格にしない）"
[[ -d "$SOURCE_DIR" ]] || fail "正本がありません: $SOURCE_DIR"

# **写しの置き場は `src/html.ts` の `LOGO_DIR` から導く**（書き写さない。PR #442 の Copilot code review）。
# 固定の綴りにすると、`LOGO_DIR` を変えた日に、配っていないディレクトリを照合し続けて合格にする。
logo_dir="$(grep -E "^export const LOGO_DIR = '/[^']+';" "$HTML_TS" | sed -E "s/^[^']*'([^']+)'.*/\1/" || true)"
[[ -n "$logo_dir" ]] || fail "$HTML_TS に LOGO_DIR が見つかりません"
COPY_DIR="public${logo_dir}"
[[ -d "$COPY_DIR" ]] || fail "写しがありません: $COPY_DIR（LOGO_DIR = $logo_dir）"

# `export const LOGO_SCALES = [1, 2, 4] as const;` から倍率を取り出す。
scales_line="$(grep -E '^export const LOGO_SCALES = \[' "$HTML_TS" || true)"
[[ -n "$scales_line" ]] || fail "$HTML_TS に LOGO_SCALES が見つかりません"
scales="$(printf '%s\n' "$scales_line" | sed -E 's/.*\[([^]]*)\].*/\1/' | tr ',' ' ' | tr -s ' ' | sed -E 's/^ //; s/ $//')"
[[ -n "${scales// /}" ]] || fail "LOGO_SCALES の倍率を読み取れません: $scales_line"

width="$(grep -E '^export const LOGO_WIDTH = [0-9]+;' "$HTML_TS" | sed -E 's/[^0-9]*([0-9]+);/\1/' || true)"
height="$(grep -E '^export const LOGO_HEIGHT = [0-9]+;' "$HTML_TS" | sed -E 's/[^0-9]*([0-9]+);/\1/' || true)"
[[ -n "$width" && -n "$height" ]] || fail "$HTML_TS に LOGO_WIDTH / LOGO_HEIGHT が見つかりません"

expected=""
for scale in $scales; do
  for bg in light dark; do
    name="lockup-horizontal-x${scale}-for-${bg}-bg.png"
    expected="$expected $name"
    [[ -f "$SOURCE_DIR/$name" ]] || fail "正本に無い倍率です: $SOURCE_DIR/$name（tools/logobake/variants.mjs の一覧を確かめてください）"
    [[ -f "$COPY_DIR/$name" ]] || fail "写しがありません: $COPY_DIR/$name（cp $SOURCE_DIR/$name $COPY_DIR/）"
    cmp -s "$SOURCE_DIR/$name" "$COPY_DIR/$name" \
      || fail "写しが正本と一致しません: $COPY_DIR/$name（書き出し直した正本を写し直してください: cp $SOURCE_DIR/$name $COPY_DIR/）"
  done
done

for path in "$COPY_DIR"/*; do
  [[ -e "$path" ]] || continue
  name="$(basename "$path")"
  case " $expected " in
    *" $name "*) ;;
    *) fail "一覧に無い画像が写しに残っています: $path（LOGO_SCALES に無い倍率か、使わない画像です）" ;;
  esac
done

# PNG の IHDR は 16 バイト目から幅、20 バイト目から高さ（どちらも 4 バイトのビッグエンディアン）。
png_uint32() {
  od -An -tu1 -j "$2" -N 4 "$1" | awk '{ print ($1 * 16777216) + ($2 * 65536) + ($3 * 256) + $4 }'
}
x1="$COPY_DIR/lockup-horizontal-x1-for-light-bg.png"
[[ -f "$x1" ]] || fail "1 倍の画像がありません: $x1（LOGO_SCALES に 1 が要ります）"
actual_width="$(png_uint32 "$x1" 16)"
actual_height="$(png_uint32 "$x1" 20)"
if [[ "$actual_width" != "$width" || "$actual_height" != "$height" ]]; then
  fail "1 倍の画像の実寸（${actual_width}×${actual_height}）が LOGO_WIDTH × LOGO_HEIGHT（${width}×${height}）と一致しません"
fi

echo "[logo-copies] 倍率 [${scales}] × 明暗の $(printf '%s\n' $expected | wc -l | tr -d ' ') 枚が正本と一致し、1 倍の実寸は ${width}×${height} です"

# --- トップの og:image（#786）------------------------------------------------
#
# **綴りは `src/html.ts` の `SOCIAL_OGP_PATH` から導く**（上の `LOGO_DIR` と同じ理由。
# 固定の綴りにすると、パスを変えた日に配っていないファイルを照合し続けて合格にする）。
# 正本の側は `/assets/` を `brand/logo/` へ読み替えるだけで出る——写しの綴りを正本と
# 同じにしてあるのは、この読み替えで照合できるようにするためである。
social_path="$(grep -E "^export const SOCIAL_OGP_PATH = '/assets/[^']+';" "$HTML_TS" | sed -E "s/^[^']*'([^']+)'.*/\1/" || true)"
[[ -n "$social_path" ]] || fail "$HTML_TS に SOCIAL_OGP_PATH（/assets/ 配下）が見つかりません"
social_copy="public${social_path}"
social_source="brand/logo/${social_path#/assets/}"
[[ -f "$social_source" ]] || fail "正本がありません: $social_source（tools/logobake/variants.mjs の一覧を確かめてください）"
[[ -f "$social_copy" ]] || fail "写しがありません: $social_copy（mkdir -p $(dirname "$social_copy") && cp $social_source $social_copy）"
cmp -s "$social_source" "$social_copy" \
  || fail "写しが正本と一致しません: $social_copy（書き出し直した正本を写し直してください: cp $social_source $social_copy）"

# HTML が `og:image:width` / `og:image:height` に出す定数（`src/ogp.ts`）と実寸を突き合わせる。
OGP_TS="src/ogp.ts"
[[ -f "$OGP_TS" ]] || fail "照合の対象がありません: $OGP_TS（見ていないことを合格にしない）"
ogp_width="$(grep -E '^export const OGP_IMAGE_WIDTH = [0-9]+;' "$OGP_TS" | sed -E 's/[^0-9]*([0-9]+);/\1/' || true)"
ogp_height="$(grep -E '^export const OGP_IMAGE_HEIGHT = [0-9]+;' "$OGP_TS" | sed -E 's/[^0-9]*([0-9]+);/\1/' || true)"
[[ -n "$ogp_width" && -n "$ogp_height" ]] || fail "$OGP_TS に OGP_IMAGE_WIDTH / OGP_IMAGE_HEIGHT が見つかりません"
social_actual_width="$(png_uint32 "$social_copy" 16)"
social_actual_height="$(png_uint32 "$social_copy" 20)"
if [[ "$social_actual_width" != "$ogp_width" || "$social_actual_height" != "$ogp_height" ]]; then
  fail "$social_copy の実寸（${social_actual_width}×${social_actual_height}）が OGP_IMAGE_WIDTH × OGP_IMAGE_HEIGHT（${ogp_width}×${ogp_height}）と一致しません"
fi

echo "[logo-copies] トップの og:image（${social_path}）が正本と一致し、実寸は ${social_actual_width}×${social_actual_height} です"
echo "LOGO_COPIES_PASS"
