#!/usr/bin/env bash
# lib/dev-fixture.sh — 実ブラウザで画面を開くための下ごしらえ（#303）
#
# ══════════════════════════════════════════════════════════════════════════════
# 何をするか
# ══════════════════════════════════════════════════════════════════════════════
#
#   1. ブラウザの実行ファイルを見つける（無ければ赤で落とす）
#   2. 使い捨ての `.wrangler` state を作り、D1 を仕込む（利用者の手元を汚さない）
#   3. 署名付きセッションを作る（ログインが要る画面まで開けるようにする）
#   4. dev サーバを HTTPS で起動し、応答するまで待つ
#
# 終わると、呼ぶ側は次を使える。
#
#   BROWSER_BIN   ブラウザの実行ファイル
#   BASE          https://<APP_HOST>:<PORT>
#   COOKIE_VALUE  `__Host-gf_session` の値
#   GAME_ID       仕込んだ作品の id（`prefix` 経路の続きに使う）
#   WORK          使い捨ての作業場
#
# ══════════════════════════════════════════════════════════════════════════════
# なぜ共有するのか
# ══════════════════════════════════════════════════════════════════════════════
#
# **M8 で踏んだ失敗は、すべてここで起きた**（#303）——別の worktree でサーバを立てて
# いた / `certs/` が無い / 仕込みが別ツリーへ入った / 古い workerd がポートを掴んだまま /
# セッションを手で作り直した。**撮る部分では 1 度も失敗していない。**
#
# 幅の検査（`scripts/check-page-width.sh`）と撮影（`scripts/shoot-pages.sh`）が
# 同じ下ごしらえを要るので、**写しを作らずここへ置く**（shared-ai-rules 12 章）。
#
# ══════════════════════════════════════════════════════════════════════════════
# 使い方
# ══════════════════════════════════════════════════════════════════════════════
#
#   GF_FIXTURE_LABEL='[shoot]'
#   GF_FIXTURE_PORT=8795
#   . scripts/lib/dev-fixture.sh
#   trap dev_fixture_down EXIT
#   dev_fixture_up
#
# **`fail` と `note` は呼ぶ側が定義する。** 文言の接頭辞をそれぞれの道具が持つため。
#
# シェルの関数として読み込む前提なので `set -euo pipefail` はここで宣言しない
# （呼ぶ側の設定を上書きしない）。

: "${GF_FIXTURE_LABEL:=[dev-fixture]}"
: "${GF_FIXTURE_PORT:=8793}"

##
# 下ごしらえを行う。
#
# 失敗したら `fail` で落ちる（呼ぶ側が定義した関数）。
#
dev_fixture_up() {
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

  note "starting wrangler pages dev on :$GF_FIXTURE_PORT"
  set -m
  env CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV=false \
    npx wrangler pages dev \
    --ip 127.0.0.1 \
    --port "$GF_FIXTURE_PORT" \
    --local-protocol https \
    --https-key-path certs/dev.key \
    --https-cert-path certs/dev.crt \
    --persist-to "$STATE" \
    --binding "SESSION_SECRET=$SESSION_SECRET" \
    --show-interactive-dev-session false \
    >"$WORK/dev.log" 2>&1 &
  DEV_PID=$!
  set +m

  BASE="https://${APP_HOST}:${GF_FIXTURE_PORT}"

  # 起動を待つ。**固定の sleep にしない**——遅い環境で「起動前に叩いて赤」になると、
  # 実装の問題と区別できない。
  ready=0
  for _ in $(seq 1 60); do
    if curl -sk --max-time 3 --resolve "${APP_HOST}:${GF_FIXTURE_PORT}:127.0.0.1" -o /dev/null "${BASE}/"; then
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
}

##
# 後片付け。**呼ぶ側が `trap dev_fixture_down EXIT` を張る。**
#
dev_fixture_down() {
  if [[ -n "${DEV_PID:-}" ]]; then
    # プロセスグループごと落とす。wrangler は workerd を子として持つため、
    # 親だけを落とすと workerd がポートを掴んだまま残る（M8 で 3 度踏んだ）。
    kill -- "-$DEV_PID" 2>/dev/null || kill "$DEV_PID" 2>/dev/null || true
    wait "$DEV_PID" 2>/dev/null || true
  fi
  if [[ -n "${WORK:-}" ]]; then
    rm -rf "$WORK"
  fi
}

##
# 経路表から SSR 画面のパスを受け取る（`/__dev/pages`）。
#
# **一覧を書き写さない。** 導出の正本は `src/page-paths.ts` で、`/__dev/pages` が
# それを返す（#282 / #290）。`match: 'prefix'` の経路は仕込んだ作品の id を補う。
#
# @return カンマ区切りのパス（標準出力）
#
dev_fixture_paths() {
  curl -sk --max-time 10 --resolve "${APP_HOST}:${GF_FIXTURE_PORT}:127.0.0.1" \
    -o "$WORK/pages.json" "${BASE}/__dev/pages" ||
    fail "/__dev/pages を取得できませんでした。DEV_ROUTES が enabled であることを確認してください。"

  node -e '
const fs = require("node:fs");
const { paths } = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
if (!Array.isArray(paths) || paths.length === 0) {
  console.error("/__dev/pages が画面のパスを返しませんでした");
  process.exit(1);
}
console.log(paths.map((path) => (path.endsWith("/") && path !== "/" ? path + process.argv[2] : path)).join(","));
' "$WORK/pages.json" "$GAME_ID" || fail "画面の一覧を読めませんでした。"
}
