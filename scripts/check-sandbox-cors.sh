#!/usr/bin/env bash
# check-sandbox-cors.sh — 配備済みの配信を、実 HTTP で確かめる（#180 / #181）
#
# 見るのは 2 つである。**どちらも「配備した実物」でしか分からない。**
#
#   1. 応答に `Access-Control-Allow-Origin` が付いていること（#180）
#   2. 配信された `.wasm` の本文を**1 回展開**すると `00 61 73 6d` で始まること（#181）
#      → こちらは `GF_SANDBOX_PREVIEW_URL` を渡したときだけ見る（実在の作品が要る）
#
# ## なぜ要るのか
#
# 7.2 必須要件 1（`sandbox allow-scripts`、`allow-same-origin` なし）の帰結で、
# サンドボックスの文書は**不透明オリジン**になる。その帰結として**自分自身のホストへの
# `fetch` すらクロスオリジン要求になり**、応答に `Access-Control-Allow-Origin` が無いと
# ブラウザは応答を破棄する。**本番でそうなっていた**（#180。利用者の画面には
# `起動できませんでした: TypeError: Failed to fetch` だけが出ていた）。
#
# 配備した実物がこのヘッダを返しているかは、**外部状態の問題である**（コードが正しくても
# 配備していなければ返らない）。だからローカル層ではなくこの層で見る。
#
# ## **この検査が約束しないこと（重要）**
#
# **curl は CORS を評価しない。** ここで見ているのは「応答に ACAO が付いているか」
# だけで、**ブラウザが実際に応答を読めるかどうかではない。** #180 が代理検査を
# すり抜けたのは、まさにこの種の取り違えによる。
#
# **実ブラウザでの確認は `scripts/check-sandbox-browser.sh` が行う。**
# こちらはその代わりにはならない。**両方が要る**（こちらは配備済みの実物を、
# あちらはブラウザの挙動を見る）。
#
# ## なぜ 2 つ目（#181）も実 HTTP でしか見られないのか
#
# R2 のバイト列は既に 1 回 brotli 圧縮されている。`Response` の既定
# （`encodeBody: 'automatic'`）はそれを未エンコードとみなして**もう一度圧縮する**ため、
# ブラウザが 1 回展開しても brotli のままになり、`instantiateStreaming` が落ちる（#181）。
#
# **単体テストでは捕まらない**（実測）。`SELF.fetch` は内部サブリクエストで HTTP の
# エンコード境界を通らないため、`encodeBody` の指定に関係なく同じ結果になる。
# **ヘッダも全部正しく見える**ので、`curl -i` の 200 を見ても分からない。
# **1 回展開してもまだ brotli であることを見て初めて分かる。**
#
# ## 何を見るか（CORS 側）
#
#   1. ACAO が付いていること
#   2. その値が `*` であること（判断の根拠は src/sandbox-delivery.ts の `ALLOW_ORIGIN`）
#   3. `Vary` に `Origin` が入っていないこと（応答は Origin に依らない。`/g/` の .wasm は
#      共有キャッシュに載るため、Origin 依存に見える宣言を残さない）
#
# 対象は**作品を要さない経路**（サンドボックス用ホストの `/`。404 が返る）である。
# ACAO は `sandboxHeaders` が一律に付けるので、ここが返れば配備物全体が返している。
#
# 実在の作品まで見たい場合は `GF_SANDBOX_PREVIEW_URL` に `/p/<key>/` を渡す。
# 渡すと `.wasm` の実物も見る。**渡さなくても検査は成立する**（上記のとおり）。
#
# 使い方:
#   bash scripts/check-sandbox-cors.sh
#   GF_SANDBOX_PREVIEW_URL="https://sandbox.game-forge.ojos.jp/p/<key>/" bash scripts/check-sandbox-cors.sh
#
# 終了コード: 0 = SANDBOX_CORS_PASS / 1 = 乖離、または前提の不成立
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$(dirname "$HERE")"

command -v curl >/dev/null 2>&1 || {
  echo "[sandbox-cors] curl が見つかりません。" >&2
  exit 1
}

# 対象ホストは宣言（wrangler.toml の `[env.production.vars]`）から読む。
# **ここへ書き写さない**——宣言を変えたときに検査だけが古いホストを見続ける
# （shared-ai-rules.md 12 章）。
SANDBOX_HOST="$(
  awk '
    /^\[env\.production\.vars\]/ { inside = 1; next }
    /^\[/ { inside = 0 }
    inside && /^[[:space:]]*SANDBOX_HOST[[:space:]]*=/ {
      sub(/^[^"]*"/, "")
      sub(/".*$/, "")
      print
      exit
    }
  ' wrangler.toml
)"

if [[ -z "$SANDBOX_HOST" ]]; then
  echo "[sandbox-cors] wrangler.toml の [env.production.vars] から SANDBOX_HOST を読めませんでした。" >&2
  exit 1
fi

failed=0

# 1 つの URL のヘッダを見る。
#
# **`Origin: null` を付けて送る。** 不透明オリジンの文書が実際に送る形である。
# 応答が Origin に依らないことも、この検査の対象に含まれる。
#
#   check_url <ラベル> <URL>
check_url() {
  local label="$1" url="$2" headers status acao vary

  # **到達不能は「乖離」ではない。** 前提の不成立として別に報告する
  # （scripts/acceptance-remote.sh 冒頭の方針）。
  if ! headers="$(curl -sS -i --max-time 30 -o /dev/null -D - -H 'Origin: null' "$url" 2>&1)"; then
    echo "[sandbox-cors] 前提の不成立: $label へ到達できません（$url）"
    echo "  $headers"
    failed=$((failed + 1))
    return
  fi

  status="$(printf '%s\n' "$headers" | awk 'NR == 1 { print $2 }')"

  # ヘッダ名の大小は経路によって変わりうる。値だけを取り出す。
  acao="$(printf '%s\n' "$headers" |
    awk 'BEGIN { IGNORECASE = 1 } /^access-control-allow-origin:/ { sub(/^[^:]*:[[:space:]]*/, ""); sub(/\r$/, ""); print; exit }')"
  vary="$(printf '%s\n' "$headers" |
    awk 'BEGIN { IGNORECASE = 1 } /^vary:/ { sub(/^[^:]*:[[:space:]]*/, ""); sub(/\r$/, ""); print; exit }')"

  if [[ -z "$acao" ]]; then
    echo "[sandbox-cors] 乖離: $label に Access-Control-Allow-Origin がありません（HTTP $status / $url）"
    echo "  不透明オリジンの文書からは、この応答が読めません（#180 の症状）。"
    echo "  配備が古い可能性があります。src/sandbox-delivery.ts の sandboxHeaders を含む版を配備してください。"
    failed=$((failed + 1))
    return
  fi

  if [[ "$acao" != "*" ]]; then
    echo "[sandbox-cors] 乖離: $label の Access-Control-Allow-Origin が '*' ではありません: '$acao'"
    echo "  値を変える判断は src/sandbox-delivery.ts の ALLOW_ORIGIN に書いてあります。"
    failed=$((failed + 1))
    return
  fi

  # `Vary: Origin` は「応答が Origin に依る」という宣言である。`*` は定数なので依らない。
  # 依らないものに Vary を付けると、共有キャッシュの効きだけが落ちる。
  if printf '%s\n' "$vary" | grep -qi 'origin'; then
    echo "[sandbox-cors] 乖離: $label の Vary に Origin が入っています: '$vary'"
    echo "  ACAO は '*' で固定であり、応答は Origin に依りません。"
    failed=$((failed + 1))
    return
  fi

  echo "[sandbox-cors] OK: $label (HTTP $status, ACAO: $acao)"
}

# 配信された `.wasm` の本文が、**1 回展開で wasm になる**ことを見る（#181）。
#
# **curl は `--compressed` を付けない限り展開しない**ので、受け取るのはワイヤ上の
# バイト列そのものである。二重に圧縮されていれば、1 回展開しても brotli のままになる。
#
#   check_wasm_body <URL>
check_wasm_body() {
  local url="$1" body

  body="$(mktemp "${TMPDIR:-/tmp}/sandbox-wasm.XXXXXX")" || {
    echo "[sandbox-cors] 一時ファイルを作れませんでした。" >&2
    failed=$((failed + 1))
    return
  }

  if ! curl -sS --max-time 120 -o "$body" "$url" 2>/dev/null; then
    echo "[sandbox-cors] 前提の不成立: .wasm を取得できません（$url）"
    rm -f "$body"
    failed=$((failed + 1))
    return
  fi

  if node -e '
const zlib = require("node:zlib");
const fs = require("node:fs");
const wire = fs.readFileSync(process.argv[1]);
const head = (buffer) => [...buffer.subarray(0, 4)].map((b) => b.toString(16).padStart(2, "0")).join(" ");
const MAGIC = Buffer.from([0x00, 0x61, 0x73, 0x6d]);

let once;
try {
  once = zlib.brotliDecompressSync(wire);
} catch (error) {
  process.stderr.write(`  配信された本文を brotli として展開できません (${wire.length} バイト, 先頭 ${head(wire)}): ${String(error)}\n`);
  process.exit(1);
}
if (once.subarray(0, 4).equals(MAGIC)) {
  process.stdout.write(`  1 回展開で wasm になりました (配信 ${wire.length} → 展開 ${once.length} バイト)\n`);
  process.exit(0);
}
process.stderr.write(`  1 回展開しても wasm になりません (配信 ${wire.length} → 1 回展開 ${once.length} バイト, 先頭 ${head(once)})\n`);
let twice = null;
try {
  twice = zlib.brotliDecompressSync(once);
} catch {
  twice = null;
}
if (twice !== null && twice.subarray(0, 4).equals(MAGIC)) {
  process.stderr.write(`  2 回展開すると wasm になります (${twice.length} バイト)。**二重に brotli 圧縮されています**（#181）。\n`);
  process.stderr.write("  src/sandbox-delivery.ts の wasmResponse に encodeBody: \x27manual\x27 を含む版を配備してください。\n");
}
process.exit(1);
' "$body"; then
    echo "[sandbox-cors] OK: 配信された .wasm は 1 回展開で wasm になります"
  else
    echo "[sandbox-cors] 乖離: 配信された .wasm の圧縮が二重です（#181 / $url）"
    failed=$((failed + 1))
  fi
  rm -f "$body"
}

check_url "サンドボックス用ホストの応答" "https://${SANDBOX_HOST}/"

# 実在の作品まで見る場合。**渡されなければ検査は成立している**（ACAO は
# sandboxHeaders が一律に付けるため、上の 1 本で配備物全体を代表できる）。
if [[ -n "${GF_SANDBOX_PREVIEW_URL:-}" ]]; then
  preview="${GF_SANDBOX_PREVIEW_URL%/}"
  check_url "プレビュー文書" "${preview}/"
  check_url "プレビューの .wasm" "${preview}/game.wasm"
  if command -v node >/dev/null 2>&1; then
    check_wasm_body "${preview}/game.wasm"
  else
    echo "[sandbox-cors] 前提の不成立: node が無いため .wasm の本文（#181）を見ていません。" >&2
    failed=$((failed + 1))
  fi
else
  echo "[sandbox-cors] 注記: GF_SANDBOX_PREVIEW_URL が未指定のため、実在の作品の .wasm は見ていません。"
  echo "[sandbox-cors] 注記: **本文の二重圧縮（#181）はこの実行では見ていません。**"
  echo "[sandbox-cors]        ローカルなら GF_SKIP_BROWSER=1 bash scripts/check-sandbox-browser.sh で見られます。"
fi

if [[ "$failed" -gt 0 ]]; then
  echo "[sandbox-cors] $failed 件の問題があります。" >&2
  exit 1
fi

echo "SANDBOX_CORS_PASS"
