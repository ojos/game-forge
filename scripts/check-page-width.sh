#!/usr/bin/env bash
# check-page-width.sh — 全 SSR 画面が、狭い端末の幅に収まっていることを実ブラウザで確かめる（#282）
#
# ══════════════════════════════════════════════════════════════════════════════
# なぜ実ブラウザが要るのか
# ══════════════════════════════════════════════════════════════════════════════
#
# **#282 の 2 件目は、機械的な代理検査を全部すり抜けた。** 削除申請フォームの
# `size="50"` は、幅 390px の端末で **layout viewport を 498px へ広げる**。
#
#   - `meta[name=viewport]` は `width=device-width, initial-scale=1` で正しく入っている
#     → viewport の検査は緑のまま
#   - HTML の文字列照合では「属性が 1 つある」以上のことが分からない
#   - `curl` はレイアウトを組まない
#
# **レイアウトを組んだブラウザだけが捕まえられる。** これは #180 が
# 「CSP は許しているのに CORS が塞ぐ」で通り抜けたのと同じ構造である
# （`docs/handoff.md` 4 章「実物を通すまで、動いているかは分からない」）。
#
# ══════════════════════════════════════════════════════════════════════════════
# なぜ画面の一覧を持たないのか
# ══════════════════════════════════════════════════════════════════════════════
#
# **パスをここへ書き並べない。** 書き並べると、画面を 1 枚足した日から検査だけが
# 古い一覧を見続ける（`.ai-playbook/shared-ai-rules.md` 12 章）。この検査が捕まえたい
# のはまさに「足した画面が土台に乗っていない」ことなので、一覧を写した時点で目的を失う。
#
# 一覧は **`/__dev/pages`** から受け取る。あれは `src/page-paths.ts` の導出を通して
# 経路表そのものを読んでおり、`test/page-shell.test.ts` と同じ一覧になる。
#
# ══════════════════════════════════════════════════════════════════════════════
# なぜ scripts/verify.sh のローカル層に入れないのか
# ══════════════════════════════════════════════════════════════════════════════
#
# **ブラウザの実行ファイルを前提にするため**である。ループの接地信号
# （`.ai-playbook/loop-workflow.md`）が道具の有無で止まると、実装が正しいのに
# ループが止まる。`scripts/check-sandbox-browser.sh` を単一入口へ含めていないのと
# 同じ理由で、この検査も**画面を触ったときに手で回す層**に置く。
#
# 前提:
#   - Node.js 22 以降（`WebSocket` が組み込みであること。CDP を素で話す）
#   - Chromium 系の実行ファイル。`GF_BROWSER_BIN` で渡すか、既知の場所に置く
#
# Chromium の入手（この devcontainer で実測した手順）:
#   npm i playwright-core && npx playwright install chromium-headless-shell
#   sudo npx playwright install-deps chromium-headless-shell
#
# 使い方:
#   bash scripts/check-page-width.sh
#   GF_BROWSER_BIN=/path/to/headless_shell bash scripts/check-page-width.sh
#   GF_PAGE_WIDTH=360 bash scripts/check-page-width.sh
#
# 終了コード: 0 = PAGE_WIDTH_PASS / 1 = 収まっていない・検査不能
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$(dirname "$HERE")"

# 幅の既定を 390 にする。iPhone 系の論理幅として広く使われる値で、#282 の実測もこの幅。
# **これより狭い端末は存在する。** 収まることの下限を保証する値ではなく、
# 「よくある狭い端末で壊れていない」を見る値である。
WIDTH="${GF_PAGE_WIDTH:-390}"
PORT="${GF_PAGE_WIDTH_PORT:-8793}"
TIMEOUT_MS="${GF_PAGE_WIDTH_TIMEOUT_MS:-20000}"

fail() {
  printf '[page-width] %s\n' "$*" >&2
  exit 1
}

note() { printf '[page-width] %s\n' "$*"; }

# ── 前提の確認 ────────────────────────────────────────────────────────────────
#
# **満たされないなら赤で落とす。** 「道具が無いので飛ばした」を緑にすると、
# 検査していないことと、検査して通ったことが区別できなくなる。

command -v node >/dev/null 2>&1 || fail "node が見つかりません。"
command -v npx >/dev/null 2>&1 || fail "npx が見つかりません（wrangler の起動に使います）。"

node -e 'if (typeof WebSocket !== "function") { process.exit(1) }' 2>/dev/null ||
  fail "この Node には WebSocket が組み込まれていません（Node 22 以降が要ります）: $(node --version)"

BROWSER_BIN="${GF_BROWSER_BIN:-}"
if [[ -z "$BROWSER_BIN" ]]; then
  # 既知の場所を順に見る。**playwright のキャッシュも見る**——冒頭の入手手順が
  # そこへ置くため、手順どおりに入れた人が毎回 GF_BROWSER_BIN を書く羽目にならない。
  while IFS= read -r candidate; do
    if [[ -n "$candidate" && -x "$candidate" ]]; then
      BROWSER_BIN="$candidate"
      break
    fi
  done < <(
    printf '%s\n' \
      /usr/bin/chromium /usr/bin/chromium-browser /usr/bin/google-chrome \
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
    ls -1d "${HOME}"/.cache/ms-playwright/chromium_headless_shell-*/chrome-linux/headless_shell \
      "${HOME}"/.cache/ms-playwright/chromium-*/chrome-linux/chrome 2>/dev/null | sort -r
  )
fi
[[ -n "$BROWSER_BIN" && -x "$BROWSER_BIN" ]] ||
  fail "Chromium の実行ファイルが見つかりません。GF_BROWSER_BIN で渡してください（入手手順はこのファイルの冒頭）。"
note "browser: $BROWSER_BIN"

# ホスト名は wrangler.toml の宣言から読む。**ここへ書き写さない**——設定を変えたときに
# 検査だけが古いホストを見続ける（shared-ai-rules.md 12 章）。
APP_HOST="$(sed -nE 's/^[[:space:]]*APP_HOST[[:space:]]*=[[:space:]]*"([^"]+)".*/\1/p' wrangler.toml | head -1)"
[[ -n "$APP_HOST" ]] || fail "wrangler.toml から APP_HOST を読めませんでした。"

# ── 使い捨ての作業場 ──────────────────────────────────────────────────────────
#
# **開発者の .wrangler/state を汚さない。** 検査のために作った `games` 行が手元へ残ると、
# 次に画面を開いた人が「知らない作品」を見ることになる。
WORK="$(mktemp -d "${TMPDIR:-/tmp}/gf-page-width.XXXXXX")"
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
mkdir -p "$STATE"

# ── D1 を仕込む ───────────────────────────────────────────────────────────────
#
# ログインが要る画面（`/works` / `/invites`）まで開く。**開かないと、それらの画面は
# リダイレクトになり「幅は正しい」で緑になる。**

SESSION_SECRET="page-width-check-secret-value-0123456789"
USER_ID="pagewidth"
GAME_ID="$(node -e 'console.log(crypto.randomUUID())')"

note "applying migrations"
npx wrangler d1 migrations apply DB --local --persist-to "$STATE" >"$WORK/d1.log" 2>&1 ||
  { sed 's/^/    /' "$WORK/d1.log" >&2; fail "D1 のマイグレーションに失敗しました。"; }

note "seeding a user and a game"
npx wrangler d1 execute DB --local --persist-to "$STATE" --command "
  insert into users (id, google_sub, email, display_name, created_at)
    values ('$USER_ID', 'sub-$USER_ID', '$USER_ID@example.invalid', '幅の検査', 1);
  insert into games (id, author_id, status, title, go_version, created_at, generation_state)
    values ('$GAME_ID', '$USER_ID', 'draft', '幅の検査の作品', '', 1, 'ready');
" >"$WORK/seed.log" 2>&1 ||
  { sed 's/^/    /' "$WORK/seed.log" >&2; fail "検査用の行を作れませんでした。"; }

# セッションの署名は `src/session.ts` と同じ形（`<base64url(JSON)>.<base64url(HMAC)>`）。
# **秘密はこの検査の中だけで作って渡す。** `.dev.vars` を読まないのは、開発者の環境に
# 依存しない検査にするためであり、値をどこにも書き残さないためでもある。
COOKIE_VALUE="$(node -e '
const crypto = require("node:crypto");
const b64u = (buf) => Buffer.from(buf).toString("base64").replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
const now = Math.floor(Date.now() / 1000);
const body = b64u(Buffer.from(JSON.stringify({ userId: process.argv[2], issuedAt: now, expiresAt: now + 3600 }), "utf8"));
const signature = crypto.createHmac("sha256", process.argv[1]).update(body).digest();
console.log(body + "." + b64u(signature));
' "$SESSION_SECRET" "$USER_ID")"

# ── dev サーバを起動する ──────────────────────────────────────────────────────
#
# **HTTPS で起動する。** セッション cookie は `__Host-` 接頭辞を持ち、ブラウザは
# `Secure` でなければ受理しない（`src/app.ts` の DEV_SESSION_COOKIE の説明）。
# 証明書は自己署名で、ブラウザ側で明示的に無視する（検査対象は TLS ではない）。
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
  --binding "SESSION_SECRET=$SESSION_SECRET" \
  --show-interactive-dev-session false \
  >"$WORK/dev.log" 2>&1 &
DEV_PID=$!
set +m

BASE="https://${APP_HOST}:${PORT}"

# 起動を待つ。**固定の sleep にしない**——遅い環境で「起動前に叩いて赤」になると、
# 実装の問題と区別できない。
ready=0
for _ in $(seq 1 60); do
  if curl -sk --max-time 3 --resolve "${APP_HOST}:${PORT}:127.0.0.1" -o /dev/null "${BASE}/"; then
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

# ── 検査対象の一覧を経路表から受け取る ────────────────────────────────────────

curl -sk --max-time 10 --resolve "${APP_HOST}:${PORT}:127.0.0.1" \
  -o "$WORK/pages.json" "${BASE}/__dev/pages" ||
  fail "/__dev/pages を取得できませんでした。DEV_ROUTES が enabled であることを確認してください。"

PATHS="$(node -e '
const fs = require("node:fs");
const { paths } = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
if (!Array.isArray(paths) || paths.length === 0) {
  console.error("/__dev/pages が画面のパスを返しませんでした");
  process.exit(1);
}
// `match: "prefix"` の経路は続きを補う（src/page-paths.ts の説明）。
console.log(paths.map((path) => (path.endsWith("/") && path !== "/" ? path + process.argv[2] : path)).join(","));
' "$WORK/pages.json" "$GAME_ID")" || fail "画面の一覧を読めませんでした。"

COUNT="$(printf '%s\n' "$PATHS" | tr ',' '\n' | wc -l | tr -d ' ')"
note "対象 ${COUNT} 経路 / 幅 ${WIDTH}px"

# **1 枚も無い状態を緑にしない。** 導出が壊れて空になったとき、以下の判定は
# 「すべて収まっている」を返してしまう。
[[ "$COUNT" -ge 5 ]] || fail "検査対象が ${COUNT} 経路しかありません。/__dev/pages の導出を確認してください。"

# ── 実ブラウザで開く ──────────────────────────────────────────────────────────

node scripts/page-width-probe.mjs \
  --browser "$BROWSER_BIN" \
  --base "$BASE" \
  --paths "$PATHS" \
  --width "$WIDTH" \
  --cookie "__Host-gf_session=$COOKIE_VALUE" \
  --timeout-ms "$TIMEOUT_MS" >"$WORK/probe.json" ||
  fail "ブラウザでの観測ができませんでした。"

# ── 判定 ──────────────────────────────────────────────────────────────────────
#
# 判定はここが持つ（観測と判定を分ける理由は scripts/page-width-probe.mjs の冒頭）。
node -e '
const fs = require("node:fs");
const { width, observations } = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
const problems = [];
for (const o of observations) {
  if (!o.loaded) {
    problems.push(`${o.path}: 読み込みが完了しませんでした`);
    continue;
  }
  if (o.status !== 200 && o.status !== 404) {
    // 404 は作品ページの「見つかりません」があるので通す。それ以外の非 200 は、
    // **画面を見ずに緑になっている**ことの現れなので落とす。
    problems.push(`${o.path}: 応答が ${o.status}（最終 URL: ${o.responseUrl}）`);
    continue;
  }
  // **ステータスだけではリダイレクトを検出できない。** 303 を返した経路でも、
  // ブラウザが追跡した先の 200 で上書きされる。**要求したパスと最終パスを突き合わせる**
  // ——そうしないと、ログインへ飛ばされた画面を「幅は正しい」で通してしまう
  // （第二意見の指摘。#282）。
  const finalPath = o.responseUrl === null ? null : new URL(o.responseUrl).pathname;
  if (finalPath !== o.path) {
    problems.push(`${o.path}: 別の画面へ移動しました（最終 URL: ${o.responseUrl}）`);
    continue;
  }
  if (o.innerWidth !== width) {
    problems.push(
      `${o.path}: layout viewport が ${o.innerWidth}px（端末は ${width}px）。` +
        `いちばん右まで出ている要素: ${o.widest} → right=${o.widestRight}`,
    );
    continue;
  }
  if (o.scrollWidth > width) {
    problems.push(
      `${o.path}: 横に ${o.scrollWidth}px はみ出しています（端末は ${width}px）。` +
        `いちばん右まで出ている要素: ${o.widest} → right=${o.widestRight}`,
    );
  }
}
for (const problem of problems) {
  console.error(`[page-width] ${problem}`);
}
if (problems.length > 0) {
  console.error(`[page-width] ${problems.length} 経路が幅 ${width}px に収まっていません。`);
  process.exit(1);
}
console.log(`[page-width] ${observations.length} 経路すべてが幅 ${width}px に収まっています。`);
' "$WORK/probe.json" || fail "幅の検査が通りませんでした。"

echo "PAGE_WIDTH_PASS"
