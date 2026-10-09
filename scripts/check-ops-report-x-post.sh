#!/usr/bin/env bash
# check-ops-report-x-post.sh — 月次の運営報告の X での告知文の下書きを、機械で検査する（#964）
#
# 使い方:
#   bash scripts/check-ops-report-x-post.sh <告知文.md> <材料.json>
#
#   材料.json は scripts/ops-report-collect.sh の出力。呼ぶのは scripts/ops-report-draft.sh の
#   告知文の段。自己試験は scripts/check-ops-report-selftest.sh の 5 節（scripts/acceptance.sh から回る）。
#
# 終了コード:
#   0 = OPS_REPORT_X_POST_CHECK_PASS（違反なし）
#   1 = OPS_REPORT_X_POST_CHECK_FAIL <種類=件数 …>（違反あり。理由を 1 件 1 行で標準エラーへ出す）
#   2 = 検査が成立しない（引数の誤り・ファイルが無い・材料が JSON でない・告知文が空）
#
#   標準出力には、判定の行の前に OPS_REPORT_X_POST_LENGTH=<重みつきの長さ> を出す（検査が成立したときだけ）。
#
# ══════════════════════════════════════════════════════════════════════════════
# 何を落とすか
# ══════════════════════════════════════════════════════════════════════════════
#
#   length    X の重みつきの長さが 280 を超える（数え方は下）
#   fill-in   【人が埋める：note の記事の URL】がちょうど 1 つでない。ほかの【人が埋める：…】・【画像を貼る：…】がある
#   hashtag   ハッシュタグが 2〜3 個でない。#GameForge が無い
#   number / handle / secret / url
#             下書きの検査（scripts/check-ops-report.sh）と同じ決まり。**判定はそちらに任せる**（同じ決まりを
#             2 か所に書き写さない）。数字は材料にあるものだけ・@ ハンドルは @gameforgejp だけ・許可外の URL が無い
#
# ══════════════════════════════════════════════════════════════════════════════
# X の重みつきの長さ（twitter-text v3 の数え方）
# ══════════════════════════════════════════════════════════════════════════════
#
#   - 1 と数える文字: U+0000–U+10FF（ASCII・ラテン文字など）、U+2000–U+200D、U+2010–U+201F、U+2032–U+2037
#   - それ以外（日本語・全角の記号・絵文字など）は 2
#   - URL は長さによらず 23。スキームのあるもの（https://…）と、スキームの無いドメイン（note.com/… など。
#     .com / .jp / .net / .org / .io / .dev / .app / .co で終わるホスト）を URL として数える
#   - 【人が埋める：note の記事の URL】は、人が note の URL を入れた後の長さで数える（23）
#   - 上限は 280
#
# **多めに数える側へ倒している所**: 絵文字の ZWJ の並びは 1 つの絵文字として 2 と数えるのが X の数え方だが、
# ここでは符号点ごとに 2 と数える（多めに出る）。NFC への正規化はしない。
#
# 2026-09 の告知文（#964 のコメント。利用者が X に投稿したもの）は、この数え方で 262 になる（X の画面と同じ）。
set -uo pipefail

PREFIX="[ops-report-x-post-check]"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)" || exit 2
LIMIT=280
FILL_IN='【人が埋める：note の記事の URL】'

if [[ $# -ne 2 ]]; then
  sed -n '2,16p' "${BASH_SOURCE[0]}" >&2
  echo "OPS_REPORT_X_POST_CHECK_ERROR"
  exit 2
fi
POST="$1"
MATERIAL="$2"

if ! command -v jq >/dev/null 2>&1; then
  echo "$PREFIX jq がありません。検査が成立しません。" >&2
  echo "OPS_REPORT_X_POST_CHECK_ERROR"
  exit 2
fi
if [[ ! -f "$POST" ]] || [[ ! -s "$POST" ]] || ! grep -q '[^[:space:]]' "$POST"; then
  echo "$PREFIX 告知文が無いか空です: $POST" >&2
  echo "OPS_REPORT_X_POST_CHECK_ERROR"
  exit 2
fi

# ── 1. 下書きと同じ決まり（number / handle / secret / url） ──────────────────────
base_out="$(bash "$HERE/check-ops-report.sh" "$POST" "$MATERIAL" 2>&1)"
base_rc=$?
case "$base_rc" in
  0|1) ;;
  *)
    printf '%s\n' "$base_out" | sed 's/^/  /' >&2
    echo "$PREFIX 下書きと同じ決まりの検査が成立しませんでした（終了コード ${base_rc}）。" >&2
    echo "OPS_REPORT_X_POST_CHECK_ERROR"
    exit 2
    ;;
esac

# ── 2. 告知文に固有の決まり（length / fill-in / hashtag） ──────────────────────
# 1 行目に長さ、2 行目から違反（TSV: 種類 / 該当 / 説明）を出す。
own="$(jq -r -R -s --arg fill "$FILL_IN" --argjson limit "$LIMIT" '
  # X が 1 と数える範囲（twitter-text v3 の ranges）。
  def light: (. >= 0 and . <= 4351) or (. >= 8192 and . <= 8205)
             or (. >= 8208 and . <= 8223) or (. >= 8242 and . <= 8247);
  def urlre: "[A-Za-z][A-Za-z0-9+.-]*://[^\\s<>()\\[\\]{}「」『』（）【】\"'"'"'、。，]+";
  def bare_domain: "(?<![A-Za-z0-9.@/-])(?:[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\\.)+(?:com|jp|net|org|io|dev|app|co)(?![A-Za-z0-9-])(?:/[^\\s<>()\\[\\]{}「」『』（）【】\"'"'"'、。，]*)?";
  # URL と欄を 23 文字の ASCII に置き換えてから、符号点ごとに重みを足す。
  def weighted:
    gsub($fill; "U" * 23)
    | gsub(urlre; "U" * 23)
    | gsub(bare_domain; "U" * 23)
    | explode | map(if light then 1 else 2 end) | add // 0;
  # ハッシュタグ: 行頭か空白の後の # / ＃ から、空白と句読点の手前まで。
  def tagre: "(?:(?<=^)|(?<=[\\s\\x{3000}]))[#＃][^\\s\\x{3000}#＃、。，．！？!?,.()（）「」【】]+";

  # 末尾の改行は X の本文に入らないので数えない。
  sub("\\n+$"; "") as $t
  | ($t | weighted) as $w
  | ([$t | scan(tagre)]) as $tags
  | ([$t | scan("【人が埋める[^】]*】")]) as $fills
  | "\($w)",
    (if $w > $limit then ["length", "\($w)", "重みつきの長さが \($limit) を超えています"] | @tsv else empty end),
    (if ($fills | map(select(. == $fill)) | length) != 1
       then ["fill-in", "\($fills | map(select(. == $fill)) | length)", "【人が埋める：note の記事の URL】がちょうど 1 つではありません"] | @tsv
       else empty end),
    (if ($fills | map(select(. != $fill)) | length) > 0
       then ["fill-in", "\($fills | map(select(. != $fill)) | length)", "note の URL の欄のほかに【人が埋める：…】があります"] | @tsv
       else empty end),
    (if ($t | test("【画像を貼る")) then ["fill-in", "1", "【画像を貼る：…】の印が残っています"] | @tsv else empty end),
    (if ($tags | length) < 2 or ($tags | length) > 3
       then ["hashtag", "\($tags | length)", "ハッシュタグが 2〜3 個ではありません"] | @tsv else empty end),
    (if ($tags | map(select(. == "#GameForge")) | length) == 0
       then ["hashtag", "0", "#GameForge がありません"] | @tsv else empty end)
' "$POST")"
jq_rc=$?
if [[ $jq_rc -ne 0 || -z "$own" ]]; then
  echo "$PREFIX 告知文に固有の検査そのものが失敗しました（jq の終了コード ${jq_rc}）。" >&2
  echo "OPS_REPORT_X_POST_CHECK_ERROR"
  exit 2
fi

LENGTH="$(printf '%s\n' "$own" | head -n 1)"
OWN_VIOLATIONS="$(printf '%s\n' "$own" | tail -n +2)"
echo "OPS_REPORT_X_POST_LENGTH=${LENGTH}"

kinds=""
if [[ $base_rc -eq 1 ]]; then
  # 下書きの検査の報告は、伏せた形のまま写す（該当の全文を出さない決まりはそちらが持つ）。
  printf '%s\n' "$base_out" | grep '^\[ops-report-check\] NG ' \
    | sed "s/^\[ops-report-check\]/${PREFIX}/" >&2
  kinds="$(printf '%s\n' "$base_out" | sed -n 's/^OPS_REPORT_CHECK_FAIL //p' | head -n 1)"
fi
if [[ -n "$OWN_VIOLATIONS" ]]; then
  while IFS="$(printf '\t')" read -r kind token reason; do
    [[ -n "$kind" ]] || continue
    printf '%s NG %s %s（%s）\n' "$PREFIX" "$kind" "$token" "$reason" >&2
  done <<<"$OWN_VIOLATIONS"
  own_summary="$(printf '%s\n' "$OWN_VIOLATIONS" | cut -f1 | sort | uniq -c | awk '{printf "%s%s=%s", (NR>1?" ":""), $2, $1}')"
  kinds="${kinds:+${kinds} }${own_summary}"
fi

if [[ -z "$kinds" ]]; then
  echo "OPS_REPORT_X_POST_CHECK_PASS"
  exit 0
fi
echo "$PREFIX 違反あり（${kinds}。重みつきの長さ ${LENGTH} / ${LIMIT}）" >&2
echo "OPS_REPORT_X_POST_CHECK_FAIL ${kinds}"
exit 1
