#!/usr/bin/env bash
# check-ops-report.sh — 月次の運営報告の下書きを、Claude Docs に置く前に機械で検査する（#936）
#
# 使い方:
#   bash scripts/check-ops-report.sh <下書き.md> <材料.json>
#
#   材料.json は scripts/ops-report-collect.sh の出力。自己試験は
#   scripts/check-ops-report-selftest.sh（scripts/acceptance.sh から回る）。
#
# 終了コード:
#   0 = OPS_REPORT_CHECK_PASS（違反なし）
#   1 = OPS_REPORT_CHECK_FAIL（違反あり。理由を 1 件 1 行で標準エラーへ出す）
#   2 = 検査が成立しない（引数の誤り・ファイルが無い・材料が JSON でない・下書きが空）
#
# **2 を 1 と分ける。** 材料が読めないことは「下書きがきれい」でも「汚い」でもない。
# 呼ぶ側（scripts/ops-report-draft.sh）はどちらも Docs へ置かないが、通知の理由を変える。
#
# ══════════════════════════════════════════════════════════════════════════════
# 何を落とすか（4 種。issue #936 の scope.in）
# ══════════════════════════════════════════════════════════════════════════════
#
#   number   本文の数字が、材料の JSON に無い
#   handle   @ハンドルの形（@gameforgejp だけは許す。大文字小文字を問わない）
#   secret   ARN・ID・トークンの形（下の表）。メールアドレスもここで落とす
#   url      許可した一覧の外にある URL
#
# 下書きは公開の記事（note）の元になる。**生成した文章は、材料に無い数字を「それらしく」
# 足す。** 費用の実額を載せる（利用者の判断。2026-10-05）以上、数字の出どころが材料で
# あることを人の目だけに頼らない。
#
# ══════════════════════════════════════════════════════════════════════════════
# 数字の照合の決まり（偽陽性を避けるための扱い）
# ══════════════════════════════════════════════════════════════════════════════
#
# 照合は**数値として**行う（文字列ではない）。「1,234」と 1234、「16.0」と 16 は同じ。
# 全角の数字（０-９）・全角のカンマとピリオド・マイナス記号（−／－）は半角へ寄せてから読む。
# 符号（前に英数字が無い「-」）と指数表記（1e6）は数の一部として読む。
#
# 材料の側で「ある」とみなす数:
#   - JSON の数値の葉すべて（figures の丸めた値も、生の値も）
#   - **キーが title の文字列の中の数字**（issue / PR の題名を本文に引くと、題名の中の
#     「64KB」「v1.35」が数字として現れるため）。ほかの文字列（notes など）の中の数字は
#     数えない。注記の文の中の「14 日」を、本文の数字の出どころとして通さないため
#
# 本文の側で照合しない（落とさない）もの:
#   - **日付と月**: `2026-09`・`2026-09-30`・`2026/9/30`・`2026 年`・`2026年9月`・`9 月`・
#     `9月30日`。対象の月や来月を書くたびに落ちるため。**ありうる値のときだけ**（年は 20xx、
#     月は 1〜12、日は 1〜31）外す。`2026-87`・`13 月` は照合する。**「3 日」のように月の付かない
#     日だけの形は照合する**（「3 日で直した」は数量であり、材料に無ければ作り話である）
#   - **見出しと番号付きリストの先頭の番号**: `## 1. 今月の数字`・`1. ` / `2) `
#   - **「1 回あたり」の 1**: `1 回あたり`・`1 人あたり`・`1 本あたり`・`1 件あたり`・`1 作品あたり`。
#     単位を言うための 1 であって量ではない（型が「1 回あたり …円」と書かせる）。**1 以外は照合する**
#   - **人が埋める欄**: `【人が埋める：…】` という綴りそのもの。投げ銭の額は材料に無いので、型
#     （docs/ops-report-template.md）がこの書き方で空けておく。**欄の中に数字があれば、欄ごと照合へ回す**
#     （生成が「【人が埋める：投げ銭の額 3000 円】」のように額をこしらえても通さない）。欄の外の数字も照合する
#   - URL・@ハンドル・ID とトークンの形の中の数字（それぞれ別の検査で見る。二重に出さない）
#
# **「1 つ」「2 本」のような小さな数も照合する。** 除外を足すほど、作り話の数字が
# 通る口が増える。材料に無い数を言いたいときは、言葉で書く（型のプロンプトに書いた）。
#
# ══════════════════════════════════════════════════════════════════════════════
# 約束しないこと
# ══════════════════════════════════════════════════════════════════════════════
#
#   - 数字が**正しい文脈で**使われているか（材料にある 12 を、別の量として書いても通る）
#   - スキームの無い URL（`example.com/x`）と、漢数字（「三」）
#   - 人の名前・作品名（材料に入れていない。collect は作品の本文も利用者の文章も読まない）
#
# 判定は jq（oniguruma の正規表現）で行う。GNU 拡張の grep / sed を使わない（macOS でも動く）。
set -uo pipefail

PREFIX="[ops-report-check]"

usage() {
  sed -n '2,15p' "${BASH_SOURCE[0]}" >&2
}

if [[ $# -ne 2 ]]; then
  usage
  echo "OPS_REPORT_CHECK_ERROR"
  exit 2
fi

DRAFT="$1"
MATERIAL="$2"

if ! command -v jq >/dev/null 2>&1; then
  echo "$PREFIX jq がありません。検査が成立しません。" >&2
  echo "OPS_REPORT_CHECK_ERROR"
  exit 2
fi
if [[ ! -f "$DRAFT" ]]; then
  echo "$PREFIX 下書きが見つかりません: $DRAFT" >&2
  echo "OPS_REPORT_CHECK_ERROR"
  exit 2
fi
if [[ ! -s "$DRAFT" ]] || ! grep -q '[^[:space:]]' "$DRAFT"; then
  echo "$PREFIX 下書きが空です: $DRAFT" >&2
  echo "OPS_REPORT_CHECK_ERROR"
  exit 2
fi
if [[ ! -f "$MATERIAL" ]] || ! jq -e 'type == "object"' "$MATERIAL" >/dev/null 2>&1; then
  echo "$PREFIX 材料が JSON のオブジェクトとして読めません: $MATERIAL" >&2
  echo "OPS_REPORT_CHECK_ERROR"
  exit 2
fi

# 許可する URL の一覧。**前方一致だが、境界を見る**（`https://note.com/gameforgejp` は
# `https://note.com/gameforgejpX` を通さない。続く文字が / ? # か、そこで終わるときだけ通す）。
#
# 足すときは、公開の記事から誰が辿ってもよい先であることを確かめてから 1 行足す。
# 管理画面（admin.）・作品の実行面（sandbox.）は載せない。
ALLOWED_URLS='[
  "https://app.game-forge.ojos.jp",
  "https://note.com/gameforgejp",
  "https://x.com/gameforgejp",
  "https://github.com/ojos/game-forge"
]'

# 違反を 1 件 1 行（TSV: 種類 / 行番号 / 該当 / 説明）で出す。
#
# **数字以外の該当は伏せて出す**（secret と handle は先頭 6 文字、url はスキームとホストの先頭 6 文字）。
# 「@ghp_…」のようにトークンがハンドルや URL の形で現れても、どの報告からも全文が出ないように。この出力は Mac のログと通知の理由へ
# 流れる。トークンの形をしたものをそこへ全文で写さない。
VIOLATIONS="$(jq -r -R -s \
  --slurpfile material "$MATERIAL" \
  --argjson allowed "$ALLOWED_URLS" '
  # 全角の数字・カンマ・ピリオド・＠を半角へ寄せる。
  def norm:
    explode
    | map(if . >= 65296 and . <= 65305 then . - 65248
          elif . == 65292 then 44
          elif . == 65294 then 46
          elif . == 65312 then 64
          elif . == 8722 or . == 65293 then 45
          else . end)
    | implode;

  # 数字の綴り。桁区切りのカンマは 3 桁ずつのときだけ数の一部とみなす（「2,3」は 2 と 3）。
  # 前に英数字が無い「-」は符号として数に含め、指数表記（1e6）も 1 つの数として読む。分けて読むと、
  # -123 が 123 として、1e6 が 1 と 6 として照合され、材料に無い負数や大きな数が通る。
  # 材料の題名の中の数も同じ綴りで読むので、「M3-8」のような綴りは両側で同じに分かれる。
  def numre: "(?<![0-9A-Za-z])-?(?:[0-9]{1,3}(?:,[0-9]{3})+(?:\\.[0-9]+)?|[0-9]+(?:\\.[0-9]+)?)(?:[eE][+-]?[0-9]+)?|(?:[0-9]{1,3}(?:,[0-9]{3})+(?:\\.[0-9]+)?|[0-9]+(?:\\.[0-9]+)?)(?:[eE][+-]?[0-9]+)?";
  def tonum: gsub(","; "") | tonumber;

  # スキームは http / https に限らない（ftp:// や file:// も許可外として落とす）。大文字小文字も問わない。
  def urlre: "[A-Za-z][A-Za-z0-9+.-]*://[^\\s<>()\\[\\]{}「」『』（）【】\"'"'"'、。，]+";
  # 文末の句読点を URL に含めない。
  def trimurl: sub("[.,;:!?]+$"; "");
  # スキームとホストを小文字へ寄せる（照合の前に。HTTPS://APP.… を一覧と同じ綴りで比べる）。
  def lower_origin:
    (capture("^(?<o>[A-Za-z][A-Za-z0-9+.-]*://[^/?#]*)(?<r>.*)$") // {o: ., r: ""})
    | (.o | ascii_downcase) + .r;
  def allowed_url($raw):
    ($raw | lower_origin) as $u
    | any($allowed[]; . as $p
      | $u == $p
        or ($u | startswith($p + "/"))
        or ($u | startswith($p + "?"))
        or ($u | startswith($p + "#")));

  # ID・トークンの形。[名前, 正規表現]。
  def secret_patterns: [
    ["ARN",                 "arn:aws[a-z-]*:[A-Za-z0-9-]*:[^\\s]*"],
    ["AWS のアクセスキー",  "(?:AKIA|ASIA)[A-Z0-9]{16}"],
    ["GitHub のトークン",   "(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})"],
    ["API キー（sk-）",     "sk-[A-Za-z0-9_-]{20,}"],
    ["Slack のトークン",    "xox[abprs]-[A-Za-z0-9-]{10,}"],
    ["JWT",                 "eyJ[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{8,}(?:\\.[A-Za-z0-9_-]+)?"],
    ["UUID",                "[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}"],
    ["メールアドレス",      "[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}"],
    ["16 進の長い ID",      "(?<![0-9A-Za-z])[0-9A-Fa-f]{32,}(?![0-9A-Za-z])"],
    # 英字と数字が混ざった 32 文字以上の塊（上の形に当たらないトークン）。
    ["トークンらしき長い文字列", "(?<![A-Za-z0-9_-])(?=[A-Za-z0-9_-]*[0-9])(?=[A-Za-z0-9_-]*[A-Za-z])[A-Za-z0-9_-]{32,}(?![A-Za-z0-9_-])"]
  ];
  def mask: if length > 6 then .[0:6] + "…" else . end;
  # 許可外の URL は、スキームとホストだけを出す。パスやクエリにトークンが入っていても、
  # url の報告から全文がログへ流れないように（secret の報告で伏せても、ここで漏れては意味が無い）。
  # スキームと、ホストの先頭 6 文字だけを出す。ユーザー情報（https://user:pass@host）も、
  # ホスト名に紛れた文字列も、パスやクエリも全文では出さない。
  def url_mask: (capture("^(?<s>[A-Za-z][A-Za-z0-9+.-]*://)(?<a>[^/?#]*)")) as $c
    | ($c.a | if test("@") then "…@" + (split("@") | last) else . end | mask) as $host
    | $c.s + $host + (if length > (($c.s + $c.a) | length) then "/…" else "" end);

  # ハンドル: 直前が英数・. _ + - ではない @ に続く名前（メールアドレスの @ を拾わない）。
  def handlere: "(?<![A-Za-z0-9._+-])@[A-Za-z0-9_]+";

  # 照合しない数字の形（冒頭の決まり）。空白に置き換えてから数字を拾う。
  def strip_exempt:
    gsub("【人が埋める[：:][^】0-9]*】"; " ")
    # 日付として外すのは、ありうる値だけ（年は 20xx、月は 1〜12、日は 1〜31）。形だけで外すと、
    # 「2026-87」のように数を日付の形に入れて照合を逃れられる。前後が数字に続かないことも見る。
    | gsub("(?<![0-9])20[0-9]{2}[-/](?:1[0-2]|0?[1-9])(?:[-/](?:3[01]|[12][0-9]|0?[1-9]))?(?![0-9])"; " ")
    | gsub("(?<![0-9])20[0-9]{2} ?年(?: ?(?:1[0-2]|0?[1-9]) ?月(?: ?(?:3[01]|[12][0-9]|0?[1-9]) ?日)?)?"; " ")
    | gsub("(?<![0-9])(?:1[0-2]|0?[1-9]) ?月(?: ?(?:3[01]|[12][0-9]|0?[1-9]) ?日)?"; " ")
    | gsub("(?<![0-9.,])1 ?(?:回|人|本|件|作品)あたり"; " ")
    | sub("^#{1,6} +[0-9]+(?:\\.[0-9]+)*[.)]? +"; "## ")
    | sub("^ *[0-9]+[.)] +"; "- ");

  ($material[0]) as $m
  | ([$m | .. | numbers]
     + [$m | .. | objects | to_entries[] | select(.key == "title") | .value
        | strings | norm | [scan(numre)][] | tonum]) as $known
  | split("\n") | to_entries[]
  | (.key + 1) as $n
  | (.value | norm) as $line
  # 1. URL
  | ([$line | scan(urlre) | trimurl]) as $urls
  | ($urls[] | select(allowed_url(.) | not)
      | ["url", $n, url_mask, "許可した一覧の外の URL"]),
  # 2. ID・トークン（URL の中も見る。許可した先の URL にトークンを付けたものを通さない）
    (secret_patterns[] as $p
      | $line | [scan($p[1])][]
      | ["secret", $n, mask, $p[0] + " の形"]),
  # 3. ハンドル（URL の中も見る。許可した先の URL のパスに他人のハンドルを付けたものを通さない）
    ($line | [scan(handlere)][]
      | select(ascii_downcase != "@gameforgejp")
      | ["handle", $n, mask, "@gameforgejp 以外の @ハンドル"]),
  # 4. 数字（URL・ID・ハンドル・照合しない形を除いてから）
    ($line
      | gsub(urlre; " ")
      | reduce (secret_patterns[] | .[1]) as $re (.; gsub($re; " "))
      | gsub(handlere; " ")
      | strip_exempt
      | [scan(numre)][]
      | . as $tok
      | select(($tok | tonum) as $v | ($known | index([$v])) == null)
      | ["number", $n, $tok, "材料の JSON に無い数字"])
  | @tsv
' "$DRAFT")"
jq_rc=$?

if [[ $jq_rc -ne 0 ]]; then
  echo "$PREFIX 検査そのものが失敗しました（jq の終了コード ${jq_rc}）。" >&2
  echo "OPS_REPORT_CHECK_ERROR"
  exit 2
fi

if [[ -z "$VIOLATIONS" ]]; then
  echo "OPS_REPORT_CHECK_PASS"
  exit 0
fi

count=0
while IFS="$(printf '\t')" read -r kind line token reason; do
  [[ -n "$kind" ]] || continue
  printf '%s NG %s %s 行目: %s（%s）\n' "$PREFIX" "$kind" "$line" "$token" "$reason" >&2
  count=$((count + 1))
done <<<"$VIOLATIONS"

# 呼ぶ側が通知の理由に使う 1 行（種類ごとの件数。該当の文字列は載せない）。
summary="$(printf '%s\n' "$VIOLATIONS" | cut -f1 | sort | uniq -c | awk '{printf "%s%s=%s", (NR>1?" ":""), $2, $1}')"
echo "$PREFIX 違反 ${count} 件（${summary}）" >&2
echo "OPS_REPORT_CHECK_FAIL ${summary}"
exit 1
