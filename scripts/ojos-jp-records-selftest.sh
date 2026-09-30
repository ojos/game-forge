#!/usr/bin/env bash
# ojos-jp-records-selftest.sh — 外部層の DNS レコードの照合（#813）が、食い違いを落とし、
# 値を出さないことを、仕込みの JSON で確かめる。
#
# ## なぜ要るのか
#
# **照合する本体（scripts/acceptance-remote.sh の compare_declared_dns_records）は外部層にあり、
# 認証済みの環境で本物のゾーンに対してしか回らない。** 本物のゾーンは宣言と一致しているので、
# 照合が壊れて「何を渡しても一致」になっていても、外部層は緑のまま通る。**落ちるべき形を
# 1 度も見ないまま緑になる検査は、何も確かめていない。**
#
# そこで照合だけを、ネットワークにも terraform にも触れない入口
# （`--compare-declared-dns-records`）から、仕込みで回す。
#
# ## 何を見るか
#
# - 一致する組は通る（大小文字と末尾のドットの違いは一致として扱う）
# - 食い違う組は落ちる: proxied の反転（#813 の acceptance）・欠落・内容・TTL・優先度
# - 照合が成立しない入力（宣言 0 本・壊れた JSON）を合格にしない
# - **出力にレコードの値が出ない**（所有証明の TXT を模した値で見る）
#
# **仕込みは本物がしないことをしない。** 実状態の側は Cloudflare の API が返す形
# （NS に priority が無い、proxied を持たない型がある）に寄せてある。
#
# 使い方:
#   bash scripts/ojos-jp-records-selftest.sh
#
# 終了コード: 0 = OJOS_JP_RECORDS_SELFTEST_PASS / 1 = どれかの場合が期待と違う
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$(dirname "$HERE")"

tmp="$(mktemp -d "${TMPDIR:-/tmp}/ojos-jp-records-selftest.XXXXXX")"
cleanup() { rm -rf "$tmp"; }
trap cleanup EXIT

readonly SECRET='google-site-verification=SELFTEST-SECRET-9f3a'

cat >"$tmp/expected.json" <<EOF
[
  {"name":"ojos.jp","type":"MX","content":"aspmx.l.google.com","ttl":3600,"proxied":false,"priority":10},
  {"name":"ojos.jp","type":"MX","content":"alt1.aspmx.l.google.com","ttl":3600,"proxied":false,"priority":20},
  {"name":"ojos.jp","type":"TXT","content":"\"${SECRET}\"","ttl":3600,"proxied":false,"priority":null},
  {"name":"app.game-forge.ojos.jp","type":"CNAME","content":"game-forge.pages.dev","ttl":300,"proxied":false,"priority":null},
  {"name":"code-narrative.ojos.jp","type":"NS","content":"ns-170.awsdns-21.com","ttl":3600,"proxied":false,"priority":null}
]
EOF

# 実状態。宣言外のレコード（トンネル）が混ざっていても照合には関係しない。
cat >"$tmp/actual.json" <<EOF
[
  {"name":"ojos.jp","type":"MX","content":"ASPMX.L.GOOGLE.COM.","ttl":3600,"proxied":false,"priority":10},
  {"name":"ojos.jp","type":"MX","content":"alt1.aspmx.l.google.com","ttl":3600,"proxied":false,"priority":20},
  {"name":"ojos.jp","type":"TXT","content":"\"${SECRET}\"","ttl":3600,"proxied":false},
  {"name":"App.Game-Forge.ojos.jp.","type":"CNAME","content":"game-forge.pages.dev","ttl":300,"proxied":false},
  {"name":"code-narrative.ojos.jp","type":"NS","content":"ns-170.awsdns-21.com","ttl":3600},
  {"name":"llm01.ojos.jp","type":"CNAME","content":"example.cfargotunnel.com","ttl":1,"proxied":true}
]
EOF

failed=0

# $1 = 名前 / $2 = 期待する終了コード / $3 = 出力に現れるべき語（空なら見ない） / $4 = 宣言 / $5 = 実状態
expect() {
  local name="$1" want="$2" needle="$3" exp="$4" act="$5" out got=0
  out="$(bash scripts/acceptance-remote.sh --compare-declared-dns-records "$exp" "$act" 2>&1)" || got=$?
  if [[ "$want" -eq 0 && "$got" -ne 0 ]] || [[ "$want" -ne 0 && "$got" -eq 0 ]]; then
    echo "[ojos-jp-records-selftest] FAIL: ${name}: 終了コード ${got}（期待 ${want}）"
    printf '%s\n' "$out" | sed 's/^/    /'
    failed=1
    return
  fi
  if [[ -n "$needle" ]] && ! grep -qF -- "$needle" <<<"$out"; then
    echo "[ojos-jp-records-selftest] FAIL: ${name}: 出力に「${needle}」がありません"
    printf '%s\n' "$out" | sed 's/^/    /'
    failed=1
    return
  fi
  if grep -qF -- "SELFTEST-SECRET" <<<"$out"; then
    echo "[ojos-jp-records-selftest] FAIL: ${name}: 出力にレコードの値が出ています"
    failed=1
    return
  fi
  echo "[ojos-jp-records-selftest] ok: ${name}"
}

mutate() {
  jq "$1" "$tmp/actual.json" >"$tmp/$2.json"
}

expect "宣言どおりなら通る（大小文字・末尾のドットは揃える）" 0 "" "$tmp/expected.json" "$tmp/actual.json"

mutate '(.[] | select(.type == "CNAME" and (.name | ascii_downcase | startswith("app.")))).proxied = true' proxied
expect "proxied を宣言と反対にすると落ちる" 1 "proxied が宣言と一致しません" "$tmp/expected.json" "$tmp/proxied.json"

mutate 'map(select(.type != "TXT"))' missing
expect "宣言したレコードが無いと落ちる" 1 "実在しません" "$tmp/expected.json" "$tmp/missing.json"

mutate '(.[] | select(.type == "TXT")).content = "\"google-site-verification=SELFTEST-SECRET-other\""' content
expect "内容が違うと落ちる（値は出さない）" 1 "ojos.jp TXT (1/1)" "$tmp/expected.json" "$tmp/content.json"

mutate '(.[] | select(.type == "NS")).ttl = 300' ttl
expect "TTL が違うと落ちる" 1 "ttl が宣言と一致しません" "$tmp/expected.json" "$tmp/ttl.json"

mutate '(.[] | select(.type == "MX" and .priority == 20)).priority = 30' priority
expect "MX の優先度が違うと落ちる" 1 "ojos.jp MX (2/2): priority" "$tmp/expected.json" "$tmp/priority.json"

mutate '[(.[] | select(.type == "TXT")) | .ttl = 300] + .' duplicate
expect "同じ内容のレコードが宣言外にもう 1 本あっても、宣言どおりの 1 本があれば通る" 0 "" "$tmp/expected.json" "$tmp/duplicate.json"

echo '[]' >"$tmp/empty.json"
expect "宣言が 0 本なら合格にしない" 1 "照合が成立していません" "$tmp/empty.json" "$tmp/actual.json"

echo 'not json' >"$tmp/broken.json"
expect "実状態が JSON でなければ合格にしない" 1 "照合が成立していません" "$tmp/expected.json" "$tmp/broken.json"

if [[ "$failed" -ne 0 ]]; then
  exit 1
fi
echo "OJOS_JP_RECORDS_SELFTEST_PASS"
