#!/usr/bin/env bash
# second-opinion-gate-exempt.sh — 第二意見の記録を求めない PR かを判定する
#
# `.github/workflows/second-opinion-gate.yml` が、記録を探す前にこれを呼ぶ。判定を YAML へ
# 書かずここに置くのは、ワークフローが GitHub 上でしか動かないためである。表での確かめは
# 対になる自己検査スクリプトが受け持つ。
#
# ## なぜ除外するのか
#
# このゲートが検出したいのは「著者が第二意見を回し忘れたまま通る」ことである。**Dependabot
# の PR には、回す著者が最初からいない。** 除外しないと依存更新の PR が毎回赤くなり、赤が
# 常態になって本当の失念と見分けがつかなくなる。差分はほぼロックファイルで、第二意見の
# 価値も低い。差分を読む・マージを承認するのは、いずれも人間またはエージェントの最終確認
# （規範「確認側は要求しません」）に委ねる。
#
# ## 何を見るか
#
# **PR の著者と、PR のすべてのコミットの author が `dependabot[bot]` であること。**
# PR の著者だけを見ると、Dependabot のブランチへ人が足したコミットまで素通りする。
# `[bot]` の付いた login は利用者が取れないので、名前の一致で足りる。ブランチ名は誰でも
# 付けられるので見ない。
#
# 入力（標準入力）:
#   1 行目     PR の著者の login
#   2 行目以降 コミットの author の login（1 コミット 1 行）。**author を信じてよいコミット
#              だけ login を渡し、それ以外は `-` で渡す。** 信じてよいかはワークフローが決める
#              （GitHub が署名したコミットか。Git の author は作る側が自由に書けるため）。
#              アカウントに紐づかないコミットも `-`
#
# 出力（標準出力）:
#   exempt  … 記録を求めない
#   judge   … いつもどおり記録を確かめる
#
# 終了コード: 0 = 判定した / 2 = 入力が読めない（何も出さない。呼ぶ側は judge として扱う）
set -euo pipefail

EXEMPT_LOGIN='dependabot[bot]'

pr_author=""
commits=0
all_exempt=1
first=1
while IFS= read -r line || [ -n "$line" ]; do
  line="${line%$'\r'}"
  if [ "$first" -eq 1 ]; then
    pr_author="$line"
    first=0
    continue
  fi
  [ -n "$line" ] || continue
  commits=$((commits + 1))
  [ "$line" = "$EXEMPT_LOGIN" ] || all_exempt=0
done

# 著者が読めない、またはコミットが 1 つも無いときは判定できない。
# **読めないことを exempt に倒さない**——確かめていないものを通すことになる。
if [ -z "$pr_author" ] || [ "$commits" -eq 0 ]; then
  exit 2
fi

if [ "$pr_author" = "$EXEMPT_LOGIN" ] && [ "$all_exempt" -eq 1 ]; then
  echo exempt
else
  echo judge
fi
