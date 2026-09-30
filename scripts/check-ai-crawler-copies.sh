#!/usr/bin/env bash
# check-ai-crawler-copies.sh — 入口で止める学習クローラの一覧（terraform/waf-ojos-jp.tf）が、
# robots.txt で拒否している一覧（src/robots.ts の AI_TRAINING_CRAWLERS）と一致することを確かめる（#776）。
#
# ## なぜ要るのか
#
# **同じ一覧が 2 か所にある。** robots.txt はアプリ（TypeScript）が出し、WAF のルールは
# terraform が宣言する。terraform は TypeScript を読めないので、片方は写しになる。
#
# **ずれると、どちらの側を見ても正しく見える壊れ方をする。** robots.ts に足して WAF に
# 足し忘れれば、robots.txt では拒否しているのに入口では素通りする。逆に WAF にだけ足せば、
# robots.txt で拒否を表明していない相手を黙って止める（#594 の「用途で分ける」の外になる）。
# **写しは機械照合で担保する**（shared-ai-rules.md 12 章）。
#
# ## 何を見るか
#
# 宣言のテキストどうしの照合だけである。ネットワークも認証も要らない。**順序は問わず、
# 集合として一致すること**を見る。1 本も拾えない側があれば、照合が成立していないとして落とす。
#
# 宣言の場所は `ACCEPTANCE_TF_DIR` で差し替えられる（scripts/lib/tf-dir.sh）。robots.ts の場所は
# `AI_CRAWLER_ROBOTS_TS` で差し替えられる。変異させた写しを指せば、宣言を汚さずに
# 「ずれで落ちること」を確かめられる。
#
# 使い方:
#   bash scripts/check-ai-crawler-copies.sh
#
# 終了コード: 0 = AI_CRAWLER_COPIES_PASS / 1 = ずれている・照合が成立しない
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$(dirname "$HERE")"

# shellcheck source=scripts/lib/tf-dir.sh
. "$HERE/lib/tf-dir.sh"

readonly ROBOTS_TS="${AI_CRAWLER_ROBOTS_TS:-src/robots.ts}"
readonly WAF_TF="$TF_DIR/waf-ojos-jp.tf"

for f in "$ROBOTS_TS" "$WAF_TF"; do
  if [[ ! -f "$f" ]]; then
    echo "[ai-crawler-copies] FAIL: $f がありません"
    exit 1
  fi
done

# 配列の本文（開き括弧の行から、行頭の閉じ括弧まで）から、引用符で囲まれた名前だけを拾う。
# コメント行（// や #）は落とす——注記に書いた名前を一覧と取り違えないため。
extract() {
  local file="$1" open_re="$2" close_re="$3"
  awk -v open_re="$open_re" -v close_re="$close_re" '
    $0 ~ open_re { inside = 1; next }
    inside && $0 ~ close_re { exit }
    inside {
      sub(/[ \t]*(\/\/|#).*$/, "")
      while (match($0, /["\047][^"\047]+["\047]/)) {
        print substr($0, RSTART + 1, RLENGTH - 2)
        $0 = substr($0, RSTART + RLENGTH)
      }
    }
  ' "$file" | sort -u
}

# **角括弧は `[[]` / `[]]` と書く。`\[` と書かない。** 正規表現は `awk -v` で渡すので、awk が先に
# 文字列のエスケープを解釈する。gawk（CI の ubuntu）は `\[` を `[` にしてから正規表現にするので
# 壊れた式になって落ち、mawk（手元）は通す——**手元では緑、CI では赤**（PR #837 で実際に踏んだ）。
# 角括弧式の中の `[` と、先頭の `]` は、どの awk でもバックスラッシュなしで文字そのものになる。
robots="$(extract "$ROBOTS_TS" '^export const AI_TRAINING_CRAWLERS[^=]*= *[[]' '^[]];')"
waf="$(extract "$WAF_TF" '^[ \t]*ai_training_crawlers[ \t]*=[ \t]*[[]' '^[ \t]*[]]')"

if [[ -z "$robots" ]]; then
  echo "[ai-crawler-copies] FAIL: $ROBOTS_TS から AI_TRAINING_CRAWLERS を 1 本も拾えません（照合が成立していません）"
  exit 1
fi
if [[ -z "$waf" ]]; then
  echo "[ai-crawler-copies] FAIL: $WAF_TF から ai_training_crawlers を 1 本も拾えません（照合が成立していません）"
  exit 1
fi

if [[ "$robots" != "$waf" ]]; then
  echo "[ai-crawler-copies] FAIL: 学習クローラの一覧が食い違っています"
  only_robots="$(comm -23 <(printf '%s\n' "$robots") <(printf '%s\n' "$waf"))"
  only_waf="$(comm -13 <(printf '%s\n' "$robots") <(printf '%s\n' "$waf"))"
  [[ -n "$only_robots" ]] && printf '  robots.ts にだけある: %s\n' $only_robots
  [[ -n "$only_waf" ]] && printf '  WAF にだけある: %s\n' $only_waf
  echo "  正本は $ROBOTS_TS です。$WAF_TF の ai_training_crawlers を同じにすること。"
  exit 1
fi

echo "[ai-crawler-copies] $(wc -l <<<"$robots" | tr -d ' ') 本が robots.ts と WAF で一致しています"
echo "AI_CRAWLER_COPIES_PASS"
