#!/usr/bin/env bash
# check-ojos-jp-records-output.sh — terraform/dns-ojos-jp.tf が宣言した DNS レコードが、
# 1 本残らず output `ojos_jp_declared_records` に載っていることを確かめる（#813）。
#
# ## なぜ要るのか
#
# **外部層の検査（scripts/acceptance-remote.sh の check_ojos_jp_declared_records）は、
# 期待値をこの output から取る。** 書き写さないための規約で、それ自体は正しい。ただし
# output がどのリソースを並べるかは、**宣言とは別に手で書いた一覧**である。
#
# **dns-ojos-jp.tf にレコードを足して output へ足し忘れると、そのレコードは照合の対象から
# 黙って外れる。** 検査は「載っているものが全部一致した」で緑になり、足したレコードが
# 実在しなくても何も言わない。#359 で、output に無かった admin のホストが同じ形で
# 検査から外れていた。
#
# ## 何を見るか
#
# **宣言のテキストどうしの照合だけである。** ネットワークも認証も terraform の状態も
# 要らない。dns-ojos-jp.tf の `resource "cloudflare_dns_record" "<名前>"` を全部拾い、
# outputs.tf の `ojos_jp_declared_records` の本文に `cloudflare_dns_record.<名前>` が
# 現れることを見る。
#
# **値は見ない。** 値が実状態と一致するかは外部層が Cloudflare の API に対して確かめる。
#
# 宣言の場所は `ACCEPTANCE_TF_DIR` で差し替えられる（scripts/lib/tf-dir.sh）。変異させた
# 写しを指せば、宣言を汚さずに「足し忘れで落ちること」を確かめられる。
#
# 使い方:
#   bash scripts/check-ojos-jp-records-output.sh
#
# 終了コード: 0 = OJOS_JP_RECORDS_OUTPUT_PASS / 1 = 載っていないレコードがある・検査が成立しない
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$(dirname "$HERE")"

# shellcheck source=scripts/lib/tf-dir.sh
. "$HERE/lib/tf-dir.sh"

readonly DECL="$TF_DIR/dns-ojos-jp.tf"
readonly OUTPUTS="$TF_DIR/outputs.tf"
readonly OUTPUT_NAME="ojos_jp_declared_records"

for f in "$DECL" "$OUTPUTS"; do
  if [[ ! -f "$f" ]]; then
    echo "[ojos-jp-records-output] FAIL: $f がありません"
    exit 1
  fi
done

declared="$(sed -n 's/^resource "cloudflare_dns_record" "\([A-Za-z0-9_-]*\)".*/\1/p' "$DECL" | sort -u)"

# **1 本も拾えないことを合格にしない。** 綴りが変わって正規表現が外れると、照合する相手が
# 空になり「足し忘れは 0 件」で緑になる。
if [[ -z "$declared" ]]; then
  echo "[ojos-jp-records-output] FAIL: $DECL から cloudflare_dns_record を 1 本も拾えません（検査が成立していません）"
  exit 1
fi

# output の本文を切り出す。最上位ブロックは `terraform fmt` の整形により、必ず桁 0 の `}` で閉じる。
#
# **説明文とコメントは外す。** 名前が本文に現れるだけで「載っている」とすると、description や
# コメントにだけ `cloudflare_dns_record.<名前>` を書き、一覧（value）へ足し忘れた場合に通って
# しまう。ヒアドキュメント（`<<-EOT` 〜 `EOT`）、`/* */`、行頭と行末の `#` / `//` を落とす。
body="$(awk -v name="$OUTPUT_NAME" '
  $0 ~ "^output \"" name "\" \\{" { inside = 1; next }
  !inside { next }
  /^}/ { exit }
  heredoc != "" { if ($0 ~ "^[ \t]*" heredoc "[ \t]*$") heredoc = ""; next }
  block { if ($0 ~ /\*\//) block = 0; next }
  /^[ \t]*\/\*/ { if ($0 !~ /\*\//) block = 1; next }
  /<<-?[A-Za-z_]+[ \t]*$/ { tag = $0; sub(/.*<<-?/, "", tag); sub(/[ \t]*$/, "", tag); heredoc = tag; next }
  { sub(/[ \t]*(#|\/\/).*$/, ""); print }
' "$OUTPUTS")"

if [[ -z "$body" ]]; then
  echo "[ojos-jp-records-output] FAIL: $OUTPUTS に output \"$OUTPUT_NAME\" がありません（検査が成立していません）"
  exit 1
fi

missing=0
count=0
while read -r name; do
  count=$((count + 1))
  if ! grep -Eq "cloudflare_dns_record\\.${name}([^A-Za-z0-9_-]|\$)" <<<"$body"; then
    echo "[ojos-jp-records-output] FAIL: cloudflare_dns_record.${name} が output \"$OUTPUT_NAME\" に載っていません"
    echo "  $DECL にあるレコードは、外部層の照合の対象にするため $OUTPUTS の一覧へも足すこと。"
    missing=1
  fi
done <<<"$declared"

if [[ "$missing" -ne 0 ]]; then
  exit 1
fi

echo "[ojos-jp-records-output] ${count} 本の宣言がすべて output \"$OUTPUT_NAME\" に載っています"
echo "OJOS_JP_RECORDS_OUTPUT_PASS"
