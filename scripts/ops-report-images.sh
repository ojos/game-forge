#!/usr/bin/env bash
# ops-report-images.sh — 月次の運営報告に添える画像を 2 枚作る（#957）
#
# 使い方（devcontainer の中で。scripts/ops-report-draft.sh が呼ぶ）:
#   bash scripts/ops-report-images.sh <下書き.md> <材料.json> <出力先のディレクトリ>
#
# 作るもの（出力先に）:
#   trend.png   数字の推移の図（月ごとの生成回数。scripts/ops-report-trend.mjs が材料の値だけから描く）
#   shot.png    入れた機能の画面（scripts/ops-report-shot.mjs が対応表 scripts/ops-report-pages.json から選び、
#               手元の dev サーバで撮る。scripts/lib/dev-fixture.sh。**本番には接続しない**）。
#               中身は撮影の見せ方（scripts/lib/showcase-fixture.sh。#962）で、幅の検査の仕込みではない
#   trend.svg / trend-labels.md / trend-check.txt / shot-pick.json / shot-text.txt / shot.log
#               途中のもの（調べるとき用。shot-text.txt は撮った画面の本文）
#
# 結果の行（標準出力の最後。scripts/ops-report-draft.sh が読む）:
#   OPS_REPORT_IMAGE_TREND=<ok|failed>
#   OPS_REPORT_IMAGE_SHOT=<ok|failed>
#   OPS_REPORT_IMAGE_SHOT_PAGE=<対応表の key。選べなければ空>
#   OPS_REPORT_IMAGE_NOTE=<1 行の理由。どちらも ok なら空>
#
# 終了コード: 0 = 2 枚とも作れた / 1 = 1 枚以上作れなかった（作れたほうは残す） / 2 = 引数の誤り
#
# **1 枚が落ちても、もう 1 枚は作る。** 呼ぶ側は、どちらが落ちても下書きを止めない（#957 の constraints）。
#
# ══════════════════════════════════════════════════════════════════════════════
# 図の検査
# ══════════════════════════════════════════════════════════════════════════════
#
# 図に描いた文字（trend-labels.md）を、下書きと同じ scripts/check-ops-report.sh に通す。落ちたら trend.png を
# 消す（材料に無い数を描いた図を、貼れる場所に残さない）。ops-report-trend.mjs も描いた直後に同じことを
# 数値の照合で確かめている。2 重にするのは、日付の扱いや全角の数字の読み方まで下書きと同じ検査に揃えるため。
#
# ══════════════════════════════════════════════════════════════════════════════
# 画面の前提
# ══════════════════════════════════════════════════════════════════════════════
#
# Chromium の実行ファイルと日本語のフォントが要る（docs/ops-report.md「画像の段の前提」）。無ければ shot は
# failed になり、理由に出る。**本番の画面・ほかの利用者の作品や名前は写らない**（写るのは仕込みの作品と利用者）。
#
# ══════════════════════════════════════════════════════════════════════════════
# 画面の中身（#962）
# ══════════════════════════════════════════════════════════════════════════════
#
# 幅の検査の仕込み（長い発言・20 通を超える履歴・長い題名）は読者に見せる中身ではないので、撮るときは
# scripts/lib/showcase-fixture.sh の見せ方へ切り替える。**撮った画面の本文（innerText と題名）に検査の文言
# （SHOWCASE_FORBIDDEN_WORDS）が 1 つでもあれば、shot は failed にして画像を残さない**（検査の文言が写った
# 画像を、貼れる場所に残さない）。
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)" || exit 2
ROOT="$(dirname "$HERE")"
PREFIX="[ops-report-images]"

if [[ $# -ne 3 ]]; then
  sed -n '2,5p' "${BASH_SOURCE[0]}" >&2
  exit 2
fi
DRAFT="$1"
MATERIAL="$2"
OUT="$3"
if [[ ! -f "$DRAFT" || ! -f "$MATERIAL" ]]; then
  echo "$PREFIX 下書きか材料がありません" >&2
  exit 2
fi
mkdir -p "$OUT" || exit 2
OUT="$(cd "$OUT" && pwd)"
rm -f "$OUT/trend.png" "$OUT/trend.svg" "$OUT/trend-labels.md" "$OUT/trend-check.txt" \
      "$OUT/shot.png" "$OUT/shot-pick.json" "$OUT/shot-text.txt" "$OUT/shot.log"

TREND=failed
SHOT=failed
SHOT_PAGE=""
NOTES=()

# 1 行の理由に入れる（改行・タブを空白へ。scripts/ops-report-draft.sh の結果の行に入る）。
note_add() { NOTES+=("$(printf '%s' "$1" | tr '\n\r\t' '   ')"); }

# ── 1. 推移の図 ──────────────────────────────────────────────────────────────
echo "$PREFIX 推移の図を描きます" >&2
if trend_err="$(node "$HERE/ops-report-trend.mjs" "$MATERIAL" "$OUT" 2>&1 >/dev/null)"; then
  if bash "$HERE/check-ops-report.sh" "$OUT/trend-labels.md" "$MATERIAL" > "$OUT/trend-check.txt" 2>&1; then
    TREND=ok
  else
    rm -f "$OUT/trend.png"
    note_add "推移の図が検査で落ちました（$(sed -n 's/^OPS_REPORT_CHECK_FAIL //p' "$OUT/trend-check.txt" | head -n 1)）"
  fi
else
  rm -f "$OUT/trend.png"
  note_add "推移の図を描けません（$(printf '%s' "$trend_err" | tail -n 1 | sed 's/^\[ops-report-trend\] //')）"
fi

# ── 2. 入れた機能の画面 ──────────────────────────────────────────────────────
# 対応表から選ぶ（下書きの「入れたもの」で語を数える）。
echo "$PREFIX 画面を選びます" >&2
if pick="$(node "$HERE/ops-report-shot.mjs" pick "$DRAFT" 2>&1)" && printf '%s\n' "$pick" > "$OUT/shot-pick.json" \
   && SHOT_PAGE="$(jq -er '.key' "$OUT/shot-pick.json" 2>/dev/null)"; then
  SHOT_PATH_TEMPLATE="$(jq -r '.path' "$OUT/shot-pick.json")"
  SHOT_WIDTH="$(jq -r '.width' "$OUT/shot-pick.json")"
  echo "$PREFIX 撮る画面: ${SHOT_PAGE}（${SHOT_PATH_TEMPLATE}。語の当たり $(jq -r '.hits' "$OUT/shot-pick.json") 回）" >&2

  # 仕込みと dev サーバは subshell の中で立てて畳む（dev-fixture.sh の fail は exit するので、
  # 図の結果を持つこのシェルを巻き込まない）。
  (
    set -euo pipefail
    cd "$ROOT"
    fail() { printf '%s %s\n' "$PREFIX" "$*" >&2; exit 1; }
    note() { printf '%s %s\n' "$PREFIX" "$*" >&2; }
    export GF_FIXTURE_LABEL="$PREFIX"
    export GF_FIXTURE_PORT="${OPS_REPORT_SHOT_PORT:-8797}"
    # shellcheck source=scripts/lib/dev-fixture.sh
    . "$ROOT/scripts/lib/dev-fixture.sh"
    # 撮影の見せ方へ切り替える（#962。dev-fixture.sh の後に読む）。
    # shellcheck source=scripts/lib/showcase-fixture.sh
    . "$ROOT/scripts/lib/showcase-fixture.sh"
    trap dev_fixture_down EXIT
    dev_fixture_up

    path="$SHOT_PATH_TEMPLATE"
    path="${path//\{GAME_ID\}/$GAME_ID}"
    path="${path//\{PUBLISHED_GAME_ID\}/$PUBLISHED_GAME_ID}"
    path="${path//\{HANDLE\}/$HANDLE}"
    # **dev サーバが画面として返す一覧に無い path は撮らない**（対応表が古くなった・埋め字を誤った）。
    # 一覧は変数に受けてから見る（pipefail の下で grep -q が先に抜けると、前段の SIGPIPE で「無い」に化ける）。
    pages="$(dev_fixture_paths)"
    if ! grep -qxF -- "$path" <<<"${pages//,/$'\n'}"; then
      fail "対応表の path（${SHOT_PATH_TEMPLATE}）が、dev サーバの画面の一覧にありません"
    fi
    node "$ROOT/scripts/shoot-pages.mjs" \
      --browser "$BROWSER_BIN" --base "$BASE" --out "$WORK/shots" --paths "$path" \
      --widths "$SHOT_WIDTH" --cookie "__Host-gf_session=$COOKIE_VALUE" \
      --timeout-ms 20000 --body-text 1 > "$WORK/shots.json" || fail "撮れませんでした"
    jq -e '.shots | length == 1 and (.[0].status == 200) and .[0].loaded' "$WORK/shots.json" >/dev/null \
      || fail "画面が 200 で読み込み終わりませんでした（$(jq -c '[.shots[0].status, .shots[0].loaded]' "$WORK/shots.json" 2>/dev/null)）"
    # 撮った画面の本文に、検査の文言が無いことを確かめる（#962）。本文が空なら確かめられないので落とす。
    jq -er '.shots[0] | (.title // "") + "\n" + (.bodyText // "")' "$WORK/shots.json" > "$OUT/shot-text.txt" \
      || fail "撮った画面の本文を読めませんでした"
    jq -e '.shots[0].bodyText | type == "string" and length > 0' "$WORK/shots.json" >/dev/null \
      || fail "撮った画面の本文が空です（検査の文言が無いことを確かめられません）"
    found=()
    for word in "${SHOWCASE_FORBIDDEN_WORDS[@]}"; do
      if grep -qF -- "$word" "$OUT/shot-text.txt"; then found+=("$word"); fi
    done
    if [[ ${#found[@]} -gt 0 ]]; then
      fail "撮った画面に検査の文言が写っています（${found[*]}。${OUT}/shot-text.txt）"
    fi
    node "$ROOT/scripts/ops-report-shot.mjs" crop "$(jq -r '.shots[0].file' "$WORK/shots.json")" "$OUT/shot.png" \
      || fail "撮った画像を切れませんでした"
  ) > "$OUT/shot.log" 2>&1
  if [[ $? -eq 0 && -s "$OUT/shot.png" ]]; then
    SHOT=ok
  else
    rm -f "$OUT/shot.png"
    note_add "画面を撮れません（$(grep -F "$PREFIX" "$OUT/shot.log" | tail -n 1 | sed "s/^\[ops-report-images\] //")。${OUT}/shot.log）"
  fi
else
  SHOT_PAGE=""
  note_add "撮る画面を選べません（$(printf '%s' "$pick" | tail -n 1 | sed 's/^\[ops-report-shot\] //')）"
fi

note_line=""
if [[ ${#NOTES[@]} -gt 0 ]]; then
  note_line="$(printf '%s。' "${NOTES[@]}")"
  note_line="${note_line%。}"
fi
printf 'OPS_REPORT_IMAGE_TREND=%s\nOPS_REPORT_IMAGE_SHOT=%s\nOPS_REPORT_IMAGE_SHOT_PAGE=%s\nOPS_REPORT_IMAGE_NOTE=%s\n' \
  "$TREND" "$SHOT" "$SHOT_PAGE" "$note_line"
[[ "$TREND" == ok && "$SHOT" == ok ]] && exit 0
exit 1
