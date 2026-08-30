#!/usr/bin/env bash
# check-sandbox-browser.sh — プレイ経路を**実ブラウザで**通す（#180 / 7.2 / 3.4）
#
# ══════════════════════════════════════════════════════════════════════════════
# なぜこの検査が要るのか
# ══════════════════════════════════════════════════════════════════════════════
#
# **#180 は、機械的な代理検査を全部すり抜けて本番へ出た。**
#
#   #28 / #29 の報告: 「ブラウザで動かしていない。CSP の許可集合の完全一致と
#   ローダー本文の文字列照合という機械的な代理で検査している」
#
# **代理検査は「CSP が許しているか」しか見ていない。** ところが 7.2 必須要件 1
# （`sandbox allow-scripts`、`allow-same-origin` なし）の帰結として文書は**不透明
# オリジン**になり、**自分自身のホストへの `fetch` すらクロスオリジン要求になる。**
# つまり「CSP は許しているが CORS が別の理由で塞ぐ」という組み合わせが成立する。
# **その組み合わせは、CSP を読む検査では原理的に捕まらない。**
#
# **curl も同じ穴を持つ。** curl は CORS を評価しないので、`Origin: null` を付けて
# 200 が返っても、ブラウザが応答を破棄するかどうかは何も分からない。
#
# **捕まえられるのは実ブラウザだけである。** だからこの検査がある。
#
# 効いていることの実測（2026-08-30、この環境）:
#   ACAO を外した状態     → 「起動できませんでした: TypeError: Failed to fetch」
#                            CORS 診断: MissingAllowOriginHeader / origin 'null'
#                            （＝ 本番で観測された症状の完全な再現）
#   ACAO を付けた状態     → 取得は成功する（`fetch` を越えて先へ進む）
#
# **空回りしない検査であることを確認済みである。** 実装を戻せば赤くなる。
#
# ══════════════════════════════════════════════════════════════════════════════
# 何を見るか（3 層。どこで落ちたかが分かる形にする）
# ══════════════════════════════════════════════════════════════════════════════
#
#   層 1  文書が**不透明オリジン**になっていること（7.2 必須要件 1 が効いている）
#         → ここが崩れていたら、以降の緑には意味が無い。**前提の検査**である。
#   層 2  `.wasm` の取得が CORS で破棄されないこと（#180 の判定）
#   層 3  wasm が起動し、Go のコードが実際に走ること（プレイ経路の全体）
#
# ══════════════════════════════════════════════════════════════════════════════
# **既知: 現在この検査は層 3 で赤である（#180 とは別の不具合）**
# ══════════════════════════════════════════════════════════════════════════════
#
# **スクリプトの故障ではない。** 層 1 と層 2 は通る（＝ #180 は直っている）。層 3 で
# 次の表示になる。
#
#   起動できませんでした: CompileError: WebAssembly.instantiateStreaming():
#   expected magic word 00 61 73 6d, found 9b df d6 1d @+0
#
# **原因は `.wasm` が二重に brotli 圧縮されて配信されていることである**（実測）。
# `src/sandbox-delivery.ts` の `wasmResponse` は、R2 の**圧縮済みバイト列**を本文にして
# `Content-Encoding: br` を付けた `Response` を作る。ところが Response の既定は
# `encodeBody: 'automatic'` で、**ランタイムは本文を未エンコードとみなしてもう一度
# 圧縮する。** ブラウザは 1 回だけ展開するので、手元に残るのは brotli ストリームである
# （`9b df d6 1d` は brotli の先頭バイト）。
#
# 実測値: R2 に置いた .br が 445,648 バイト、配信されたのは 430,790 バイト。
# 配信されたものを 1 回展開すると R2 の .br と完全一致し、2 回展開して初めて
# wasm のマジックナンバー `00 61 73 6d` が出る。
#
# **`encodeBody: 'manual'` を足すとこの検査は全層が緑になる**（実測で確認済み）。
# ただし **#180 の範囲外**であり、**本番の実挙動と突き合わせていない**ため、この
# ブランチでは直していない。別の issue で扱うこと。
#
# ══════════════════════════════════════════════════════════════════════════════
# なぜ scripts/acceptance.sh へ配線しないのか
# ══════════════════════════════════════════════════════════════════════════════
#
# ローカル層（acceptance.sh）の契約は「ネットワークも外部認証も要さない検査」である
# （.github/project-ai-rules.md「受け入れ検証の二層」）。この検査は **Chromium の
# 実行ファイル**を要求し、その入手にはネットワークと（Linux では）システムパッケージの
# 導入が要る。ループの接地信号をそこへ依存させると、**実装が正しいのにループが止まる。**
#
# 一方、**「入っていなければ黙って飛ばす」形にもしない。** 飛ばして緑を出すのは、
# #180 が通り抜けたときの形そのものである。**前提が満たされないなら赤で落ちる。**
#
# したがって、この検査は**明示的に起動する**。起動の契機は
# 「サンドボックス配信（src/sandbox-*.ts）を触ったとき」である。
#
# ══════════════════════════════════════════════════════════════════════════════
# 前提
# ══════════════════════════════════════════════════════════════════════════════
#
#   - Go のツールチェーン（本物の `.wasm` と `wasm_exec.js` をその場で作るため）
#   - Node.js 22 以降（`WebSocket` が組み込みであること。CDP を素で話す）
#   - Chromium 系の実行ファイル。`GF_BROWSER_BIN` で渡すか、既知の場所に置く
#
# 使い方:
#   GF_BROWSER_BIN=/path/to/headless_shell bash scripts/check-sandbox-browser.sh
#
# Chromium の入手（この devcontainer で実測した手順）:
#   npm i playwright-core && npx playwright install chromium-headless-shell
#   sudo npx playwright install-deps chromium-headless-shell
#   GF_BROWSER_BIN="$(node -e "console.log(require('playwright-core').chromium.executablePath())")"
#
# 終了コード: 0 = 実ブラウザでプレイ経路が通った / 非0 = 通らなかった・検査不能
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$(dirname "$HERE")"

PORT="${GF_BROWSER_CHECK_PORT:-8791}"
TIMEOUT_MS="${GF_BROWSER_CHECK_TIMEOUT_MS:-45000}"

fail() {
  printf '[browser-check] %s\n' "$*" >&2
  exit 1
}

note() { printf '[browser-check] %s\n' "$*"; }

# ── 前提の確認 ────────────────────────────────────────────────────────────────
#
# **満たされないなら赤で落とす。** 「道具が無いので飛ばした」を緑にすると、
# 検査していないことと、検査して通ったことが区別できなくなる。

command -v go >/dev/null 2>&1 ||
  fail "go が見つかりません。本物の .wasm と wasm_exec.js を作るのに要ります。"
command -v node >/dev/null 2>&1 || fail "node が見つかりません。"
command -v npx >/dev/null 2>&1 || fail "npx が見つかりません（wrangler の起動に使います）。"

# `WebSocket` が組み込みであること（Node 22 以降）。無い環境で走らせると、CDP へ
# 繋げないという読みにくい失敗になる。**先に前提として落とす。**
node -e 'if (typeof WebSocket !== "function") { process.exit(1) }' 2>/dev/null ||
  fail "この Node には WebSocket が組み込まれていません（Node 22 以降が要ります）: $(node --version)"

BROWSER_BIN="${GF_BROWSER_BIN:-}"
if [[ -z "$BROWSER_BIN" ]]; then
  for candidate in \
    /usr/bin/chromium /usr/bin/chromium-browser /usr/bin/google-chrome \
    /Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome; do
    if [[ -x "$candidate" ]]; then
      BROWSER_BIN="$candidate"
      break
    fi
  done
fi
[[ -n "$BROWSER_BIN" && -x "$BROWSER_BIN" ]] ||
  fail "Chromium の実行ファイルが見つかりません。GF_BROWSER_BIN で渡してください（入手手順はこのファイルの冒頭）。"

note "browser: $BROWSER_BIN"

# ホスト名は wrangler.toml の宣言から読む。**ここへ書き写さない**——設定を変えたときに
# 検査だけが古いホストを見続ける（shared-ai-rules.md 12 章）。
read_var() {
  sed -nE "s/^[[:space:]]*$1[[:space:]]*=[[:space:]]*\"([^\"]+)\".*/\1/p" wrangler.toml | head -1
}
SANDBOX_HOST="$(read_var SANDBOX_HOST)"
[[ -n "$SANDBOX_HOST" ]] || fail "wrangler.toml から SANDBOX_HOST を読めませんでした。"

# バケット名も宣言から読む（R2 へ資材を置くのに要る）。
BUCKET_NAME="$(sed -nE 's/^[[:space:]]*bucket_name[[:space:]]*=[[:space:]]*"([^"]+)".*/\1/p' wrangler.toml | head -1)"
[[ -n "$BUCKET_NAME" ]] || fail "wrangler.toml から bucket_name を読めませんでした。"

# ── 使い捨ての作業場 ──────────────────────────────────────────────────────────
#
# **開発者の .wrangler/state を汚さない。** 検査のために作った `games` 行が
# 手元の開発環境へ残ると、次に画面を開いた人が「知らない作品」を見ることになる。
WORK="$(mktemp -d "${TMPDIR:-/tmp}/gf-browser-check.XXXXXX")"
DEV_PID=""
cleanup() {
  if [[ -n "$DEV_PID" ]]; then
    # プロセスグループごと落とす。wrangler は workerd を子として持つため、
    # 親だけを落とすと workerd がポートを掴んだまま残る。
    kill -- "-$DEV_PID" 2>/dev/null || kill "$DEV_PID" 2>/dev/null || true
    wait "$DEV_PID" 2>/dev/null || true
  fi
  rm -rf "$WORK"
}
trap cleanup EXIT

STATE="$WORK/state"
mkdir -p "$STATE" "$WORK/gosrc"

# ── 本物の Go の wasm をその場で作る ──────────────────────────────────────────
#
# **ダミーのバイト列を置かない。** 見たいのは「不透明オリジンの文書が、自分の wasm を
# 取得し、`instantiateStreaming` でコンパイルし、`wasm_exec.js` 経由で Go を走らせる」
# という経路の全体である。偽物のバイト列だと、どこまで通ったのかが分からない失敗になる。
#
# **Ebitengine のゲームは使わない。** 依存の取得が要り、検査の前提が重くなる。
# 標準ライブラリだけで書いた最小の Go は、この経路の全部を同じように通る。
GO_VERSION="$(go env GOVERSION)"
[[ -n "$GO_VERSION" ]] || fail "go env GOVERSION を読めませんでした。"
note "go: $GO_VERSION"

cat >"$WORK/gosrc/go.mod" <<'EOF'
module gfbrowsercheck

go 1.26
EOF

# Go 側が JavaScript の世界へ印を立てる。**この印が付いていることが層 3 の判定**で、
# 「wasm が本当に走った」以外の理由では立たない。
cat >"$WORK/gosrc/main.go" <<'EOF'
package main

import "syscall/js"

func main() {
	js.Global().Set("__gfWasmRan", "ok")
}
EOF

note "building game.wasm (GOOS=js GOARCH=wasm)"
(cd "$WORK/gosrc" && GOOS=js GOARCH=wasm go build -o "$WORK/game.wasm" .) ||
  fail "検査用の wasm をビルドできませんでした。"

# 3.4-1 は R2 へ brotli で置くことを求める。**配信経路をそのまま再現する**ので、
# ここでも圧縮して置く。zlib は Node の組み込みなので依存が増えない。
node -e '
const zlib = require("node:zlib");
const fs = require("node:fs");
const source = process.argv[1];
fs.writeFileSync(`${source}.br`, zlib.brotliCompressSync(fs.readFileSync(source)));
' "$WORK/game.wasm" || fail "wasm を brotli 圧縮できませんでした。"

# `wasm_exec.js` は**ビルドに使った Go に同梱のもの**を使う（3.5 が版の一致を要求する）。
WASM_EXEC_SRC="$(go env GOROOT)/lib/wasm/wasm_exec.js"
[[ -f "$WASM_EXEC_SRC" ]] || fail "wasm_exec.js が見つかりません: $WASM_EXEC_SRC"

# ── D1 / R2 を仕込む ──────────────────────────────────────────────────────────

WASM_KEY="builds/browsercheck/${GO_VERSION}/game.wasm.br"
PREVIEW_KEY="$(node -e 'console.log([...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, "0")).join(""))')"
GAME_ID="$(node -e 'console.log(crypto.randomUUID())')"

note "applying migrations"
npx wrangler d1 migrations apply DB --local --persist-to "$STATE" >"$WORK/d1.log" 2>&1 ||
  { sed 's/^/    /' "$WORK/d1.log" >&2; fail "D1 のマイグレーションに失敗しました。"; }

note "seeding a draft game"
npx wrangler d1 execute DB --local --persist-to "$STATE" --command "
  insert into users (id, google_sub, email, display_name, created_at)
    values ('browsercheck', 'sub-browsercheck', 'browsercheck@example.invalid', 'browsercheck', 1);
  insert into games (id, author_id, status, title, go_version, source_key, wasm_key, created_at, preview_key)
    values ('$GAME_ID', 'browsercheck', 'draft', 't', '$GO_VERSION', 'builds/browsercheck/source.go', '$WASM_KEY', 1, '$PREVIEW_KEY');
" >"$WORK/seed.log" 2>&1 ||
  { sed 's/^/    /' "$WORK/seed.log" >&2; fail "games 行を作れませんでした。"; }

npx wrangler r2 object put "$BUCKET_NAME/$WASM_KEY" --file "$WORK/game.wasm.br" --local --persist-to "$STATE" >>"$WORK/seed.log" 2>&1 ||
  { sed 's/^/    /' "$WORK/seed.log" >&2; fail "wasm を R2 へ置けませんでした。"; }
npx wrangler r2 object put "$BUCKET_NAME/runtime/${GO_VERSION}/wasm_exec.js" --file "$WASM_EXEC_SRC" --local --persist-to "$STATE" >>"$WORK/seed.log" 2>&1 ||
  { sed 's/^/    /' "$WORK/seed.log" >&2; fail "wasm_exec.js を R2 へ置けませんでした。"; }

# ── dev サーバを起動する ──────────────────────────────────────────────────────
#
# **HTTPS で起動する。** `*.localtest.me` は安全なコンテキストとして扱われないため、
# 7.2 の検証には HTTPS が要る（scripts/dev-certs.sh の冒頭）。証明書は自己署名で、
# ブラウザ側で明示的に無視する（検査対象は TLS ではない）。
bash scripts/dev-certs.sh >/dev/null

note "starting wrangler pages dev on :$PORT"
set -m
env CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV=false \
  npx wrangler pages dev \
  --ip 127.0.0.1 \
  --port "$PORT" \
  --local-protocol https \
  --https-key-path certs/dev.key \
  --https-cert-path certs/dev.crt \
  --persist-to "$STATE" \
  --show-interactive-dev-session false \
  >"$WORK/dev.log" 2>&1 &
DEV_PID=$!
set +m

BASE="https://${SANDBOX_HOST}:${PORT}"
DOC_URL="${BASE}/p/${PREVIEW_KEY}/"

# 起動を待つ。**固定の sleep にしない**——遅い環境で「起動前に叩いて赤」になると、
# 実装の問題と区別できない。
ready=0
for _ in $(seq 1 60); do
  if curl -sk --max-time 3 --resolve "${SANDBOX_HOST}:${PORT}:127.0.0.1" -o /dev/null "$DOC_URL"; then
    ready=1
    break
  fi
  if ! kill -0 "$DEV_PID" 2>/dev/null; then
    break
  fi
  sleep 1
done
if [[ "$ready" -ne 1 ]]; then
  sed 's/^/    /' "$WORK/dev.log" >&2
  fail "dev サーバが応答しませんでした（${BASE}）。"
fi

# ── 実ブラウザで開く ──────────────────────────────────────────────────────────

note "opening $DOC_URL"
node scripts/sandbox-browser-probe.mjs \
  --browser "$BROWSER_BIN" \
  --url "$DOC_URL" \
  --timeout-ms "$TIMEOUT_MS" >"$WORK/probe.json" ||
  { fail "ブラウザでの観測ができませんでした。"; }

# 判定はここが持つ（観測と判定を分ける理由は sandbox-browser-probe.mjs の冒頭）。
node -e '
const fs = require("node:fs");
const result = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
const state = result.state ?? {};
const problems = [];

// 層 1: 前提。文書が不透明オリジンでなければ、以降の緑には意味が無い。
//
// `settingsOrigin`（= self.origin）を見る。`location.origin` は URL のオリジンを
// 返すため、不透明オリジンでも実オリジンの文字列になる（実測。probe 側の注記）。
if (state.settingsOrigin !== "null" || state.storageThrows !== true) {
  problems.push(
    `層 1 前提: 文書が不透明オリジンになっていません（self.origin=${String(state.settingsOrigin)},` +
      ` localStorage が投げる=${String(state.storageThrows)}）。` +
      " 7.2 必須要件 1 が効いていないか、検査の前提が崩れています。この状態の緑は無意味です。",
  );
}

// 層 2: #180 の判定。CORS で応答が破棄されていないこと。
const corsFailures = (result.loadingFailed ?? []).filter((entry) => entry.corsErrorStatus !== null);
const statusText = String(state.statusText ?? "");
if (corsFailures.length > 0 || statusText.includes("Failed to fetch")) {
  problems.push(
    "層 2 (#180): .wasm の取得が CORS で破棄されました。" +
      " 応答に Access-Control-Allow-Origin が付いていません" +
      `（${JSON.stringify(corsFailures)}）。`,
  );
}

// 層 3: プレイ経路の全体。Go が実際に走ったこと。
if (state.wasmRan !== "ok") {
  problems.push(
    `層 3: wasm が起動しませんでした。画面の表示: ${JSON.stringify(statusText)}`,
  );
} else if (state.statusHidden !== true) {
  problems.push("層 3: 起動したのに読み込み表示が消えていません。");
}

if (problems.length > 0) {
  for (const problem of problems) {
    process.stderr.write(`[browser-check] ${problem}\n`);
  }
  process.stderr.write("[browser-check] --- 観測結果 ---\n");
  process.stderr.write(`${JSON.stringify(result, null, 2)}\n`);
  process.exit(1);
}
' "$WORK/probe.json" || fail "実ブラウザでプレイ経路が通りませんでした。"

note "OK: 不透明オリジンの文書が自分の wasm を取得し、Go が走りました。"
