#!/usr/bin/env bash
# check-app-css.sh — app.css の区画の規約と、画面幅の段を機械で見る（#371）
#
# ══════════════════════════════════════════════════════════════════════════════
# なぜこの検査が要るのか
# ══════════════════════════════════════════════════════════════════════════════
#
# **M12 は複数のレーンが並行して `public/assets/app.css` へ追記する**（#373 / #375 /
# #382 / #372）。全員が末尾へ書けば毎回競合するので、画面ごとの区画をあらかじめ切り、
# 規約を同ファイルの冒頭へ書いた（#371）。**しかし、呼びかけだけの規約は守られない。**
#
# ここが見るのは 3 つである。どれも「更新したか」ではなく**一致しているか**を見るので、
# 空の更新では通らない（`.ai-playbook/shared-ai-rules.md` 12 章）。
#
#   1. **区画の索引（冒頭の表）と `@section` の見出しが、並び順まで一致すること。**
#      索引は見出しの複製であり、**複製は必ず腐る。** 区画を足した人が索引を書き忘れると、
#      次に来たレーンは索引を読んで「自分の区画は無い」と判断し、また末尾へ書く。
#
#   2. **幅に反応する `@media` が `@section shell` にしか無いこと。**
#      2.3.9 の「breakpoint を画面ごとに書かない。器の側に持つ」を機械で保つ。画面ごとに
#      断点が散ると、画面を 1 枚足すたびに全部の断点を読み直すことになる。
#
#   3. **CSS の段と、実ブラウザの検査が回る幅が噛み合っていること。**
#      段は `@media (min-width: Npx)` から導く（**CSS が正本で、ここは写しを持たない**）。
#      導いた段のどれか 1 つでも検査の幅に覆われていなければ落とす——**見ていない段が
#      あるのに緑になる**のが、この検査がいちばん防ぎたい状態である。
#      あわせて、**下限 390px が外れていないこと**も見る（#282 の実測値。2.3.9 が
#      「390px の判定は緩めない」と定めている）。
#
# ══════════════════════════════════════════════════════════════════════════════
# なぜ実ブラウザの検査そのものを acceptance に入れないのか
# ══════════════════════════════════════════════════════════════════════════════
#
# **`scripts/check-page-width.sh` はブラウザの実行ファイルを前提にする。** 道具の有無で
# ループの接地信号が止まると、実装が正しいのにループが止まる（あちらの冒頭と
# `.ai-playbook/loop-workflow.md`）。**だから単一入口へ載せるのはこちらである**
# ——bash と awk しか要らず、40 ms 前後で終わり、しかも「段と幅が噛み合っているか」という
# **実ブラウザの検査が正しい幅で回るための前提**を見る。実ブラウザの検査は、画面か CSS を
# 触ったときに手で回す層に残す（`docs/local-dev.md`）。
#
# 使い方:
#   bash scripts/check-app-css.sh
#
# 終了コード: 0 = APP_CSS_PASS / 1 = 規約違反・検査不能
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$(dirname "$HERE")"

CSS='public/assets/app.css'
WIDTH_CHECK='scripts/check-page-width.sh'

fail() {
  printf '[app-css] %s\n' "$*" >&2
  exit 1
}

[[ -f "$CSS" ]] || fail "$CSS がありません。"
[[ -f "$WIDTH_CHECK" ]] || fail "$WIDTH_CHECK がありません。"

# ── 検査の幅を、実ブラウザの検査の既定から読む ────────────────────────────────
#
# **ここへ幅を書き写さない。** 正本は `scripts/check-page-width.sh` の既定値である。
WIDTHS="$(sed -nE 's/^WIDTHS="\$\{GF_PAGE_WIDTHS:-([0-9,]+)\}"$/\1/p' "$WIDTH_CHECK" | head -1)"
[[ -n "$WIDTHS" ]] ||
  fail "$WIDTH_CHECK から既定の幅（GF_PAGE_WIDTHS）を読めませんでした。綴りを変えたなら、この検査も直してください。"

awk -v widths="$WIDTHS" -v css="$CSS" -v width_check="$WIDTH_CHECK" '
function problem(message) {
  printf "[app-css] %s\n", message > "/dev/stderr"
  bad++
}

# ── 冒頭の索引（表）から区画の id を拾う ──────────────────────────────────────
#
# 表の始まりは見出しの行で見分ける。行が表でなくなったら索引は終わり
# （区切りの `|---|---|` も表の行なので、`|` の後ろに空白を求めないこと）。
/^ \* [|] 区画 [|] / { in_index = 1; next }
in_index && $0 !~ /^ \* [|]/ { in_index = 0 }
in_index {
  # `| tokens | ... |` の 1 セル目だけを見る。区切りの `|---|---|` は先頭が英小文字で
  # ないので当たらない。
  if (match($0, /^ \* [|] [a-z][a-z0-9-]* [|]/)) {
    id = $0
    sub(/^ \* [|] /, "", id)
    sub(/ [|].*$/, "", id)
    index_ids[++index_count] = id
  }
  next
}

# ── `@section` の見出しを拾い、いまどの区画に居るかを覚える ───────────────────
/^   @section [a-z][a-z0-9-]* / {
  id = $2
  section_ids[++section_count] = id
  if (id in seen) {
    problem(css " の @section " id " が 2 回あります（区画の id は一意にしてください）。")
  }
  seen[id] = 1
  current = id
  next
}

# ── コメントの行は見ない ──────────────────────────────────────────────────────
#
# **説明の文章の中にも `@media` や `min-width` は出てくる**（この規約そのものを説明して
# いる冒頭のコメントがまさにそうである）。区画の見出しは上で拾い終えているので、
# ここから先は行頭が `*` または `/*` の行を飛ばす。
/^[[:space:]]*(\*|\/\*)/ { next }

# ── 幅に反応する @media の置き場所と書き方 ────────────────────────────────────
/@media/ && /max-width/ {
  problem(css ":" NR " 段は min-width で書いてください（max-width では段を導けません）。")
}
/@media/ && /min-width/ {
  if (current != "shell") {
    problem(css ":" NR " 幅に反応する @media は @section shell にしか置けません（いまは @section " \
      (current == "" ? "（区画の外）" : current) "）。2.3.9「breakpoint を画面ごとに書かない」。")
  }
  if (match($0, /min-width: *[0-9]+px/)) {
    value = substr($0, RSTART, RLENGTH)
    sub(/min-width: */, "", value)
    sub(/px/, "", value)
    breakpoints[value + 0] = 1
  } else {
    problem(css ":" NR " min-width の値を px で読み取れませんでした（段の導出に使います）。")
  }
}

END {
  # ── 1. 索引と見出しの一致（並び順まで）──────────────────────────────────────
  if (index_count == 0) {
    problem(css " の冒頭に区画の索引が見つかりません。")
  }
  if (section_count == 0) {
    problem(css " に @section の見出しが 1 つもありません。")
  }
  if (index_count != section_count) {
    problem("区画の索引は " index_count " 件、@section の見出しは " section_count \
      " 件です。片方だけを足していませんか。")
  }
  limit = index_count < section_count ? index_count : section_count
  for (i = 1; i <= limit; i++) {
    if (index_ids[i] != section_ids[i]) {
      problem(i " 件目の区画が索引と見出しでずれています（索引: " index_ids[i] \
        " / 見出し: " section_ids[i] "）。並び順も揃えてください。")
    }
  }

  # ── 2. 段と検査の幅 ─────────────────────────────────────────────────────────
  tier_count = 0
  for (value in breakpoints) {
    bounds[++tier_count] = value + 0
  }
  if (tier_count == 0) {
    problem(css " に幅の @media が 1 つもありません（2.3.9 は 3 段を求めています）。")
  }
  # 小さい順に並べる（段の数は 2〜3 なので単純な挿入で足りる）。
  for (i = 2; i <= tier_count; i++) {
    value = bounds[i]
    for (j = i - 1; j >= 1 && bounds[j] > value; j--) {
      bounds[j + 1] = bounds[j]
    }
    bounds[j + 1] = value
  }

  split(widths, probe, ",")
  smallest = 0
  for (i in probe) {
    probe[i] = probe[i] + 0
    if (smallest == 0 || probe[i] < smallest) {
      smallest = probe[i]
    }
  }
  # **下限は 390px。** #282 の実測に基づく値で、2.3.9 が「緩めない」と定めている。
  if (smallest != 390) {
    problem(width_check " の既定の幅のいちばん狭い値が " smallest \
      "px です。390px は #282 の実測に基づく下限なので外せません（2.3.9）。")
  }

  # 段は「下限のひとつ前まで」で区切る。段の数は境界の数 + 1。
  for (tier = 0; tier <= tier_count; tier++) {
    low = (tier == 0) ? 0 : bounds[tier]
    high = (tier == tier_count) ? 0 : bounds[tier + 1]
    covered = 0
    for (i in probe) {
      if (probe[i] >= low && (high == 0 || probe[i] < high)) {
        covered = 1
      }
    }
    if (!covered) {
      problem("段 " (tier + 1) "（" low "px〜" (high == 0 ? "" : (high - 1) "px") "）を、" \
        width_check " のどの幅も見ていません（既定: " widths "）。段を足したなら幅も足してください。")
    }
  }

  if (bad > 0) {
    printf "[app-css] %d 件の違反があります。\n", bad > "/dev/stderr"
    exit 1
  }
  printf "[app-css] 区画 %d 件 / 段 %d 段 / 検査の幅 %s\n", section_count, tier_count + 1, widths
}
' "$CSS" || fail "app.css の規約に違反しています。"

echo "APP_CSS_PASS"
