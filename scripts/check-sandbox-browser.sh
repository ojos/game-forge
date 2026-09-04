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
# **#306 は、同じ穴をもう一度通り抜けた。** `script-src` に `blob:` が無いため
# `audioWorklet.addModule()` が拒否され、**#286 で入れた音は 1 度も鳴らなかった。**
# 症状の 2 行目は `Failed to load worklet module script: blob:null/… (CORS or access
# check error)` で、**#180 と字面まで似ている。** この検査は当時 CSP と CORS の
# 組み合わせを見るために生まれたのに、**音の経路を見ていなかったので通り抜けた。**
# 層 5 はその穴である。
#
# 効いていることの実測（2026-09-04、この環境）:
#   script-src に blob: 無し → rejected: AbortError: Unable to load a worklet's module.
#                              Log: "Loading the script 'blob:null/…' violates the
#                              following Content Security Policy directive: …"
#                              （＝ 本番で観測された症状の完全な再現）
#   script-src に blob: 有り → ok（`connect-src` はその作品の .wasm 1 本のまま）
#
# ══════════════════════════════════════════════════════════════════════════════
# 何を見るか（6 層。どこで落ちたかが分かる形にする）
# ══════════════════════════════════════════════════════════════════════════════
#
#   層 0  配信された `.wasm` の本文を**1 回展開**すると `00 61 73 6d`（`\0asm`）で
#         始まること（#181 の判定）。**ブラウザを使わない層である**——実 HTTP さえ
#         通れば見えるので、`GF_SKIP_BROWSER=1` でここだけを回せる。
#   層 1  文書が**不透明オリジン**になっていること（7.2 必須要件 1 が効いている）
#         → ここが崩れていたら、以降の緑には意味が無い。**前提の検査**である。
#   層 2  `.wasm` の取得が CORS で破棄されないこと（#180 の判定）
#   層 3  wasm が起動し、Go のコードが実際に走ること（プレイ経路の全体）
#   層 4  **作品ページ（`/works/<id>`）に埋め込んだ状態でも層 1 と層 3 が成り立つこと**
#         （#30）。利用者が実際に踏むのはこちらで、`frame-ancestors` と 2 重の
#         `sandbox` 指定が絡む。**層 1〜3 の緑からは導けない。**
#   層 5  **音のワークレットのモジュールが `blob:` URL から読み込めること**（#306）。
#         6.1 が許した音（`ebiten/v2/audio`）は oto を通じて AudioWorklet を使い、
#         そのモジュールを `blob:` から読む。**直接開いた形（層 1〜3）と埋め込んだ形
#         （層 4）の両方で見る**——CSP は同じでも、iframe の中では別の制約が乗りうる。
#
# **層 0 だけは単体テストで代替できない**（実測）。`SELF.fetch`（vitest の workers
# pool）は内部サブリクエストで **HTTP のエンコード境界を通らない**ため、
# `encodeBody` の指定に関係なく R2 のバイト列がそのまま返る。**#180 と同じ形の盲点で、
# だからこの検査が実 HTTP を通す。**
#
# ══════════════════════════════════════════════════════════════════════════════
# この検査が実際に見つけた不具合（#181）
# ══════════════════════════════════════════════════════════════════════════════
#
# **#180（CORS）を直した直後、この検査は層 3 で赤のままだった。**
#
#   起動できませんでした: CompileError: WebAssembly.instantiateStreaming():
#   expected magic word 00 61 73 6d, found 9b df d6 1d @+0
#
# 原因は **`.wasm` が二重に brotli 圧縮されて配信されていたこと**である（#181）。
# R2 のバイト列は既に 1 回圧縮済みなのに、`Response` の既定（`encodeBody: 'automatic'`）が
# それを未エンコードとみなしてもう一度圧縮していた。**ヘッダは全部正しく、curl の 200 も
# 正しく見える**ため、代理検査では永久に見つからない種類の不具合だった。
#
# 修正は `src/sandbox-delivery.ts` の `encodeBody: 'manual'`（因果はそこに書いてある）。
# **この検査があったから見つかった。** 層 0 は、同じものをブラウザ抜きでも見る。
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
#   - Go のツールチェーン（本物の `.wasm` と `wasm_exec.js` をその場で作るため）。
#     **版は正本から読む**ので、手元の Go がピン留めより古ければ go が
#     ツールチェインを取りに行く（初回はネットワークが要る。`GOTOOLCHAIN=auto`）
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

# `GF_SKIP_BROWSER=1` は**層 0 だけ**を回す（ブラウザを要求しない）。層 0 は実 HTTP さえ
# 通れば見えるためで、**ブラウザを入れられない環境でも #181 の回帰は見られる。**
# **層 1〜5 を飛ばしたことは最後に明示する**（黙って一部だけ回して緑に見せない）。
SKIP_BROWSER="${GF_SKIP_BROWSER:-0}"

BROWSER_BIN=""
if [[ "$SKIP_BROWSER" != "1" ]]; then
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
    fail "Chromium の実行ファイルが見つかりません。GF_BROWSER_BIN で渡すか、層 0 だけなら GF_SKIP_BROWSER=1 を付けてください（入手手順はこのファイルの冒頭）。"
  note "browser: $BROWSER_BIN"
else
  note "GF_SKIP_BROWSER=1: 層 0（HTTP）だけを見ます"
fi

# ホスト名は wrangler.toml の宣言から読む。**ここへ書き写さない**——設定を変えたときに
# 検査だけが古いホストを見続ける（shared-ai-rules.md 12 章）。
read_var() {
  sed -nE "s/^[[:space:]]*$1[[:space:]]*=[[:space:]]*\"([^\"]+)\".*/\1/p" wrangler.toml | head -1
}
SANDBOX_HOST="$(read_var SANDBOX_HOST)"
[[ -n "$SANDBOX_HOST" ]] || fail "wrangler.toml から SANDBOX_HOST を読めませんでした。"
APP_HOST="$(read_var APP_HOST)"
[[ -n "$APP_HOST" ]] || fail "wrangler.toml から APP_HOST を読めませんでした。"

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
# ## 版は**正本から読む**（#101 / #141 / #151。ここへ書き写さない）
#
# **新しい検査を足すと、新しい写しが生まれる。** この検査は「本物を通す」ために Go の
# ソースをその場でビルドするので、`go.mod` の `go` ディレクティブという形で**版を持つ
# 必要が生まれた**。ここに版番号を直接書くと、それは**検査の外にある写し**になる——
# `scripts/check-go-version-copies.sh` は「版番号 ＋ `ARG GO_VERSION` ＋『正本』が
# 同じ行に揃った行」だけを写しとみなすため、**`go.mod` に書いた素の版指定は捕まらない。**
# 実際に一度そうなった（この検査の初版が固定値を書き、ピン留めが動いても気づけなかった）。
# **次に同種の検査を足す人も同じことをするので、ここに書いておく。**
#
# 正本は `docker/isolated-build/Dockerfile` の `ARG GO_VERSION` である（#101）。ここでは
# `docker/isolated-build/template/go.mod` の `go` ディレクティブから読む。**あちらは
# イメージのビルドが `ARG GO_VERSION` と機械照合しており**（版がずれたイメージは存在
# できない）、そこから読めば正本に繋がる。**読めなければ落とす。既定値へ倒れない。**
PINNED_GO_VERSION="$(
  sed -nE 's/^go[[:space:]]+([0-9]+\.[0-9]+(\.[0-9]+)?)([[:space:]].*)?$/\1/p' \
    docker/isolated-build/template/go.mod | head -1
)"
[[ -n "$PINNED_GO_VERSION" ]] ||
  fail "docker/isolated-build/template/go.mod の go ディレクティブを読めませんでした。版の正本は docker/isolated-build/Dockerfile の ARG GO_VERSION です（#101）。両者が揃っているかを確認してください。"
note "pinned go: $PINNED_GO_VERSION (docker/isolated-build/template/go.mod)"

cat >"$WORK/gosrc/go.mod" <<EOF
module gfbrowsercheck

go ${PINNED_GO_VERSION}
EOF

# Go 側が JavaScript の世界へ印を立てる。**この印が付いていることが層 3 の判定**で、
# 「wasm が本当に走った」以外の理由では立たない。
#
# あわせて**層 5（#306）の材料**をここで作る。**Ebitengine も oto も持ち込まない**
# （上記のとおり依存の取得が検査の前提を重くする）。持ち込むのは oto がやることの
# **手順そのもの**——`AudioContext` を作り、ワークレットのモジュールを `Blob` から組み立て、
# `URL.createObjectURL` の `blob:` URL を `audioWorklet.addModule()` へ渡す——であり、
# **CSP が見ているのはこの手順であってライブラリではない。**
cat >"$WORK/gosrc/main.go" <<'EOF'
package main

import (
	"fmt"
	"syscall/js"
	"time"
)

// ワークレットのモジュールを組み立てる最小のソース。中身は問わない。
// **見たいのは `blob:` からモジュールとして読み込めるかどうか**である。
const workletSource = "class P extends AudioWorkletProcessor { process() { return true } }\n" +
	"registerProcessor('gf-probe', P)\n"

// addModule() の解決を待つ上限。**待ち続けない**——通らないときに「wasm が走らなかった」
// という別の失敗として現れると、原因の切り分けができなくなる。
const workletTimeout = 10 * time.Second

// probeAudioWorklet は oto と同じ手順で `blob:` のワークレットを読み込み、結果を返す。
//
// 返す文字列がそのまま判定の材料になる（"ok" 以外はすべて赤）。
func probeAudioWorklet() (verdict string) {
	// JS 側の綴りが変わって Get/Call が落ちても、**検査が観測不能で終わらないようにする。**
	defer func() {
		if recovered := recover(); recovered != nil {
			verdict = fmt.Sprint("panic: ", recovered)
		}
	}()

	global := js.Global()
	constructor := global.Get("AudioContext")
	if !constructor.Truthy() {
		return "no-audiocontext"
	}
	context := constructor.New()

	// `js.ValueOf` が変換する（`[]any` → JS の配列、`map[string]any` → JS のオブジェクト。
	// `syscall/js` の変換表）。**`Array` / `Object` を自分で組み立てない。**
	blob := global.Get("Blob").New(
		[]any{workletSource},
		map[string]any{"type": "application/javascript"},
	)
	url := global.Get("URL").Call("createObjectURL", blob)

	// 緩衝を持たせる。**解決と時間切れが競ったときに送り手を止めない**
	// （止まると js.Func が解放されず、ページ側に残る）。
	settled := make(chan string, 2)
	onFulfilled := js.FuncOf(func(_ js.Value, _ []js.Value) any {
		settled <- "ok"
		return nil
	})
	defer onFulfilled.Release()
	onRejected := js.FuncOf(func(_ js.Value, args []js.Value) any {
		reason := "(理由なし)"
		if len(args) > 0 {
			reason = fmt.Sprintf("%s: %s", args[0].Get("name"), args[0].Get("message"))
		}
		settled <- "rejected: " + reason
		return nil
	})
	defer onRejected.Release()

	context.Get("audioWorklet").Call("addModule", url).Call("then", onFulfilled, onRejected)

	select {
	case verdict := <-settled:
		return verdict
	case <-time.After(workletTimeout):
		return "timeout"
	}
}

func main() {
	js.Global().Set("__gfAudioWorklet", probeAudioWorklet())
	// **`__gfWasmRan` は最後に立てる。** 観測側（`scripts/sandbox-browser-probe.mjs`）は
	// この印が立った時点で読み取りを打ち切るため、先に立てるとワークレットの結果が
	// 間に合わず、層 5 が「観測できなかった」で不安定になる。
	js.Global().Set("__gfWasmRan", "ok")
}
EOF

# ## 実効ツールチェインは**モジュールの中で**解決する（3.5）
#
# **`go.mod` を書いた「あと」に、その中で `go env` を引く。** ピン留めが手元の Go より
# 新しいと、go はツールチェインを切り替えてビルドする（`GOTOOLCHAIN=auto` の既定）。
# **モジュールの外で引いた値は切り替え前のものになる。**
#
# ここを外で引くと、**ビルドに使った版と `wasm_exec.js` の版がずれる。** それは 3.5 が
# 「いちばん原因が読めない失敗」と呼ぶ形そのもの（読み込みは成功し、実行時に壊れる）で、
# **この検査自身が同じ罠を踏むことになる。** GOROOT も同じ理由で中から引く。
GO_VERSION="$(cd "$WORK/gosrc" && go env GOVERSION)" ||
  fail "実効の Go ツールチェインを解決できませんでした（ピン留め ${PINNED_GO_VERSION} の取得に失敗した可能性があります）。"
[[ -n "$GO_VERSION" ]] || fail "go env GOVERSION が空を返しました。"

# ピン留めと実効版がずれたまま進まない。ずれる原因は主に 2 つある。
#   - `GOTOOLCHAIN=local` で切り替えが止められている（手元の Go が古いままになる）
#   - 正本側の綴りがメジャー.マイナーだけの 2 要素になっている
#     （Dockerfile 側は 3 要素で照合するため、そちらとも食い違う）
if [[ "$GO_VERSION" != "go${PINNED_GO_VERSION}" ]]; then
  fail "ピン留め go${PINNED_GO_VERSION} に対して、実効のツールチェインが ${GO_VERSION} です。GOTOOLCHAIN（現在: $(go env GOTOOLCHAIN)）と、docker/isolated-build/ 側の版の綴りを確認してください。"
fi
note "effective go: $GO_VERSION"

# `wasm_exec.js` は**ビルドに使ったツールチェイン**のものを使う（3.5 が版の一致を要求する）。
WASM_EXEC_SRC="$(cd "$WORK/gosrc" && go env GOROOT)/lib/wasm/wasm_exec.js"
[[ -f "$WASM_EXEC_SRC" ]] || fail "wasm_exec.js が見つかりません: $WASM_EXEC_SRC"

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

# ── D1 / R2 を仕込む ──────────────────────────────────────────────────────────

WASM_KEY="builds/browsercheck/${GO_VERSION}/game.wasm.br"
PREVIEW_KEY="$(node -e 'console.log([...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, "0")).join(""))')"
GAME_ID="$(node -e 'console.log(crypto.randomUUID())')"
# 層 4（#30）が開く、公開済みの作品。**draft の行を使い回さない**——`/works/<id>` が
# 作品を埋め込むのは公開済みのときだけで、状態を変えると層 1〜3 の対象まで変わる。
PUBLISHED_ID="$(node -e 'console.log(crypto.randomUUID())')"
PUBLISHED_PREVIEW_KEY="$(node -e 'console.log([...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, "0")).join(""))')"

note "applying migrations"
npx wrangler d1 migrations apply DB --local --persist-to "$STATE" >"$WORK/d1.log" 2>&1 ||
  { sed 's/^/    /' "$WORK/d1.log" >&2; fail "D1 のマイグレーションに失敗しました。"; }

note "seeding a draft game"
npx wrangler d1 execute DB --local --persist-to "$STATE" --command "
  insert into users (id, google_sub, email, display_name, created_at)
    values ('browsercheck', 'sub-browsercheck', 'browsercheck@example.invalid', 'browsercheck', 1);
  insert into games (id, author_id, status, title, go_version, source_key, wasm_key, created_at, preview_key)
    values ('$GAME_ID', 'browsercheck', 'draft', 't', '$GO_VERSION', 'builds/browsercheck/source.go', '$WASM_KEY', 1, '$PREVIEW_KEY');
  insert into games (id, author_id, status, title, go_version, source_key, wasm_key, created_at, published_at, preview_key)
    values ('$PUBLISHED_ID', 'browsercheck', 'published', 't2', '$GO_VERSION', 'builds/browsercheck/source.go', '$WASM_KEY', 1, 1, '$PUBLISHED_PREVIEW_KEY');
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

# ── 層 0: 配信された `.wasm` の本文が正しいこと（#181 / #182。ブラウザ不要）──
#
# **判定はここに書かない。** `scripts/wasm-body-verdict.mjs` が持つ。**`check-sandbox-cors.sh`
# と同じ判定体を使う**——2 箇所に書けば、片方だけ直る日が来る（実際に #182 で、
# 同じ誤りが 2 箇所に複製されていた）。
#
# **`Accept-Encoding: br` を明示し、返ってきた `Content-Encoding` で判定を分ける。**
# dev サーバの前には展開する経路が無いので、いまは必ず br が返る。**それでも宣言を
# 見て分岐する**——「経路は本文を透過的に展開しうる」という前提を、環境が変わった日に
# 踏み直さないためである（本番でそれが起き、#182 の偽陽性になった）。
WASM_URL="${BASE}/p/${PREVIEW_KEY}/game.wasm"
note "層 0: fetching $WASM_URL"
# 自己署名の開発用証明書を明示的に信頼する（`-k` で丸ごと無視するより範囲が狭い）。
# **`--compressed` は付けない**（curl が展開するとヘッダと本文の対応が崩れる）。
curl -sS --max-time 60 --cacert certs/dev.crt -H 'Accept-Encoding: br' \
  --resolve "${SANDBOX_HOST}:${PORT}:127.0.0.1" \
  -D "$WORK/wire.headers" -o "$WORK/wire.bin" "$WASM_URL" ||
  fail "層 0: .wasm を取得できませんでした（$WASM_URL）。"

WIRE_ENCODING="$(awk 'tolower($0) ~ /^content-encoding:/ { sub(/^[^:]*:[[:space:]]*/, ""); sub(/\r$/, ""); print; exit }' "$WORK/wire.headers")"

node scripts/wasm-body-verdict.mjs \
  --body "$WORK/wire.bin" \
  --content-encoding "$WIRE_ENCODING" \
  --label "[browser-check] 層 0" ||
  fail "層 0 (#181) が通りませんでした。"

if [[ "$SKIP_BROWSER" == "1" ]]; then
  note "OK (層 0 のみ): 配信された .wasm の本文は正しい形です。"
  note "**層 1〜5（実ブラウザ）は見ていません。** GF_SKIP_BROWSER を外すと見ます。"
  exit 0
fi

# ── 層 1〜3・層 5: 実ブラウザで開く ─────────────────────────────────────────────────

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

// 層 5: #306 の判定。音のワークレットのモジュールが blob: URL から読めること。
//
// **CSP の文字列照合では原理的に捕まらない。** #306 は `script-src` に `blob:` が
// 無いことで拒否されたが、**同じ症状は「CSP は許しているが別の理由で塞ぐ」形でも
// 起きうる**（#180 がまさにそれだった）。だから実ブラウザでモジュールを読ませる。
if (state.audioWorklet !== "ok") {
  problems.push(
    `層 5 (#306): 音のワークレットのモジュールを blob: URL から読み込めませんでした` +
      `（${JSON.stringify(state.audioWorklet)}）。` +
      " src/sandbox-csp.ts の script-src に blob: があるかを確認してください。" +
      " CSP 違反なら logEntries に「violates the following Content Security Policy directive」が出ます。",
  );
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

# ── 層 4: 作品ページに埋め込んだ状態でも同じことが起きること（#30 / 3.4-5）─────
#
# **層 1〜3 が見ているのはサンドボックス URL を直接開いた場合である。** ところが
# 利用者が踏むのは作品ページ（`/works/<id>`）で、そこでは同じ文書が
# **アプリ用ホストの iframe の中**に入る。この形は層 1〜3 の緑からは導けない。
#
#   - 配信側の `frame-ancestors` が親のオリジンと一致していなければ、**枠ごと落ちる**
#     （CSP ヘッダの文字列照合では、親が実際に何のオリジンで配られるかを見ていない）
#   - iframe 属性の `sandbox` と応答ヘッダの `sandbox` は**両方が効く**。片方に
#     `allow-scripts` が無ければ、そこで黙って止まる
#
# **どちらも「動いているつもりで動いていない」形で現れる。** #180 / #181 と同じ質の
# 盲点なので、同じ場所で見る。
WORK_PAGE_URL="https://${APP_HOST}:${PORT}/works/${PUBLISHED_ID}"
note "層 4: opening $WORK_PAGE_URL"
node scripts/sandbox-browser-probe.mjs \
  --browser "$BROWSER_BIN" \
  --url "$WORK_PAGE_URL" \
  --timeout-ms "$TIMEOUT_MS" >"$WORK/embed.json" ||
  { fail "層 4: ブラウザでの観測ができませんでした。"; }

node -e '
const fs = require("node:fs");
const result = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
const problems = [];

// 親ページ自身は**不透明オリジンではない**（アプリ用ホストである）。ここが null に
// なっていたら、開いている URL が違う。
if (result.state?.settingsOrigin === "null") {
  problems.push("層 4 前提: 親ページが不透明オリジンです。作品ページではないものを開いています。");
}

// 埋め込まれた文書の中で、7.2 と 3.4 の両方が成立していること。
const frames = result.frameContexts ?? [];
const embedded = frames.filter((frame) => frame.state?.settingsOrigin === "null");
if (embedded.length === 0) {
  problems.push(
    "層 4: 不透明オリジンの子文書が 1 つもありません。" +
      " frame-ancestors で枠ごと落ちているか、iframe が読み込まれていません。",
  );
} else if (!embedded.some((frame) => frame.state?.wasmRan === "ok")) {
  problems.push(
    "層 4: 埋め込んだ文書の中で wasm が起動しませんでした。画面の表示: " +
      JSON.stringify(embedded.map((frame) => frame.state?.statusText)),
  );
} else if (!embedded.some((frame) => frame.state?.audioWorklet === "ok")) {
  // 層 5 を埋め込んだ形でも見る（#306）。**直接開いた形の緑からは導けない**——
  // iframe の中では Permissions Policy と 2 重の `sandbox` 指定が乗るため、
  // 同じ CSP でも結果が変わりうる。**利用者が実際に踏むのはこちらである。**
  problems.push(
    "層 5 (#306): 埋め込んだ文書の中で音のワークレットのモジュールを読み込めませんでした: " +
      JSON.stringify(embedded.map((frame) => frame.state?.audioWorklet)),
  );
}

if (problems.length > 0) {
  for (const problem of problems) {
    process.stderr.write(`[browser-check] ${problem}\n`);
  }
  process.stderr.write("[browser-check] --- 観測結果 ---\n");
  process.stderr.write(`${JSON.stringify(result, null, 2)}\n`);
  process.exit(1);
}
' "$WORK/embed.json" || fail "層 4: 作品ページに埋め込んだプレイ経路が通りませんでした。"

note "OK: 不透明オリジンの文書が自分の wasm を取得し、Go が走り、音のワークレットが読み込めました（直接・埋め込みの両方）。"
