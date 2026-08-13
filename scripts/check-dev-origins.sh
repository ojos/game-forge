#!/usr/bin/env bash
# check-dev-origins.sh — 開発ホスト名が「別オリジン・同一サイト」になっていることを、
# 実際に起動したサーバへ HTTP を投げて確かめる（#51 acceptance 3）。
#
# 単体テスト（test/worker.test.ts）との違い:
#   単体テストは workerd 上でハンドラの出力を検査する。こちらは **TLS と cookie の
#   実挙動**を検査する。`__Host-` の受理条件（Secure / Path=/ / Domain なし）は
#   ヘッダ文字列としては単体テストで確かめられるが、「HTTPS でしか成立しないこと」と
#   「ホスト限定なのでサンドボックス側へ送られないこと」は、実際に喋らせないと
#   確かめられない。7.2 の必須要件はこの後者の性質そのものである。
#
# サーバは自分で起動して自分で止める。起動済みのサーバへ相乗りしない
# （相乗りすると、古いコードのまま緑になる経路ができる）。
#
# 前提: Docker もネットワークも要さないが、npm install 済みであること。
#   ネットワークを要さないため、ローカル層の検査として扱える。
#
# 終了コード:
#   0 = ORIGINS_PASS
#   1 = ORIGINS_FAIL
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$(dirname "$HERE")"

PORT="${PORT:-8799}"
FAILURES=0
SERVER_PID=""
SERVER_USES_PGID=0
WORKDIR=""

ng() {
  printf '[origins] NG %s\n' "$1" >&2
  FAILURES=$((FAILURES + 1))
}

ok() {
  printf '[origins] OK %s\n' "$1"
}

fatal() {
  printf '[origins] %s\n' "$1" >&2
  echo "ORIGINS_FAIL"
  exit 1
}

# trap から呼ぶため、静的解析からは呼び出しが見えない。
# shellcheck disable=SC2329
cleanup() {
  if [[ -n "$SERVER_PID" ]] && kill -0 "$SERVER_PID" 2>/dev/null; then
    # wrangler は子プロセス（workerd）を持つ。setsid で起動できていれば
    # プロセスグループごと止められる。落とせていない場合は、親を止める前に
    # 子を明示的に止める（親だけ殺すと workerd がポートを掴んだまま残り、
    # 次回の起動が「ポート使用中」で失敗する）。
    if [[ "${SERVER_USES_PGID:-0}" -eq 1 ]]; then
      kill -- "-$SERVER_PID" 2>/dev/null || kill "$SERVER_PID" 2>/dev/null || true
    else
      if command -v pkill >/dev/null 2>&1; then
        pkill -P "$SERVER_PID" 2>/dev/null || true
      fi
      kill "$SERVER_PID" 2>/dev/null || true
    fi
    wait "$SERVER_PID" 2>/dev/null || true
  fi
  [[ -n "$WORKDIR" ]] && rm -rf -- "$WORKDIR"
  return 0
}
trap cleanup EXIT

command -v curl >/dev/null 2>&1 || fatal "curl が見つかりません。"
[[ -d node_modules/wrangler ]] || fatal "node_modules/wrangler がありません。'npm ci' を先に実行してください。"

APP_HOST="$(sed -nE 's/^[[:space:]]*APP_HOST[[:space:]]*=[[:space:]]*"([^"]+)".*/\1/p' wrangler.toml | head -1)"
SANDBOX_HOST="$(sed -nE 's/^[[:space:]]*SANDBOX_HOST[[:space:]]*=[[:space:]]*"([^"]+)".*/\1/p' wrangler.toml | head -1)"
[[ -n "$APP_HOST" && -n "$SANDBOX_HOST" ]] || fatal "wrangler.toml から APP_HOST / SANDBOX_HOST を読めませんでした。"

WORKDIR="$(mktemp -d "${TMPDIR:-/tmp}/dev-origins.XXXXXX")" || fatal "一時ディレクトリを作成できませんでした。"
COOKIE_JAR="$WORKDIR/cookies.txt"
SERVER_LOG="$WORKDIR/server.log"

# ── 0. 名前解決 ──────────────────────────────────────────────────────────────
#
# 解決できないと以降がすべて接続エラーになり、「同一サイトでない」のか
# 「名前が引けない」のかが読み分けられなくなる。先に切り分ける。
# getent は glibc 付属で、macOS には無い。無い環境で `getent hosts` が失敗すると、
# 「名前が引けない」と「getent が無い」を区別できないまま赤になる。Node は
# 手順書が前提として挙げているので、無いときはそちらの DNS 解決へ回す。
resolve_host() {
  local host="$1"
  if command -v getent >/dev/null 2>&1; then
    getent hosts "$host" >/dev/null 2>&1
    return $?
  fi
  if command -v node >/dev/null 2>&1; then
    node -e '
      const dns = require("node:dns");
      dns.lookup(process.argv[1], (err) => process.exit(err ? 1 : 0));
    ' "$host" >/dev/null 2>&1
    return $?
  fi
  echo "[origins] 名前解決を確認する手段がありません（getent も node も見つかりません）" >&2
  return 2
}

for host in "$APP_HOST" "$SANDBOX_HOST"; do
  if ! resolve_host "$host"; then
    ng "ホスト名を解決できません: $host（*.localtest.me は公開 DNS が 127.0.0.1 を返す。オフラインなら /etc/hosts に足す）"
  fi
done
[[ "$FAILURES" -eq 0 ]] || { echo "ORIGINS_FAIL"; exit 1; }
ok "両ホストが解決できる"

# ── 1. 構造の検査（別オリジン・同一サイト） ──────────────────────────────────
if [[ "$APP_HOST" == "$SANDBOX_HOST" ]]; then
  ng "アプリ用とサンドボックス用のホスト名が同一です（別オリジンになりません）"
else
  ok "別オリジン: $APP_HOST ≠ $SANDBOX_HOST"
fi

# サンドボックスがアプリの真のサブドメインであれば、登録可能ドメインは必ず一致する
# （src/origins.ts の注記。PSL を持ち込まずに構成として保証できる十分条件）。
if [[ "$SANDBOX_HOST" == *".$APP_HOST" && "$SANDBOX_HOST" != ".$APP_HOST" ]]; then
  ok "同一サイト: $SANDBOX_HOST は $APP_HOST の真のサブドメイン"
else
  ng "同一サイトになりません: $SANDBOX_HOST は $APP_HOST の真のサブドメインではありません"
fi

# ── 2. サーバの起動 ──────────────────────────────────────────────────────────
bash scripts/dev-certs.sh >/dev/null

echo "[origins] wrangler pages dev を起動します（port $PORT）"
# setsid でプロセスグループを分け、後片付けで workerd ごと確実に止める。
#
# setsid は util-linux 付属で macOS には無い。無い環境で必須にすると、ここで
# 即失敗して検査そのものが成立しない。無ければ通常起動へ落とす。その場合は
# プロセスグループが分かれないため、後片付けは子プロセスを個別に止める
# （cleanup() が両方を扱う）。
if command -v setsid >/dev/null 2>&1; then
  SERVER_USES_PGID=1
  setsid env CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV=false \
    npx wrangler pages dev \
    --ip 127.0.0.1 --port "$PORT" \
    --local-protocol https \
    --https-key-path certs/dev.key --https-cert-path certs/dev.crt \
    >"$SERVER_LOG" 2>&1 &
else
  SERVER_USES_PGID=0
  env CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV=false \
    npx wrangler pages dev \
    --ip 127.0.0.1 --port "$PORT" \
    --local-protocol https \
    --https-key-path certs/dev.key --https-cert-path certs/dev.crt \
    >"$SERVER_LOG" 2>&1 &
fi
SERVER_PID=$!

for _ in $(seq 1 60); do
  if curl -sk --max-time 2 "https://${APP_HOST}:${PORT}/" -o /dev/null 2>/dev/null; then
    break
  fi
  if ! kill -0 "$SERVER_PID" 2>/dev/null; then
    sed 's/^/    /' "$SERVER_LOG" >&2
    fatal "wrangler pages dev が起動しませんでした。"
  fi
  sleep 1
done

if ! curl -sk --max-time 5 "https://${APP_HOST}:${PORT}/" -o /dev/null; then
  sed 's/^/    /' "$SERVER_LOG" >&2
  fatal "wrangler pages dev が応答しません（60 秒待機）。"
fi
ok "wrangler pages dev が HTTPS で応答した"

# ── 3. 証明書が両ホストをカバーしている ──────────────────────────────────────
#
# 自己署名なので --cacert で自分自身を信頼させたうえで、ホスト名の検証は有効にする。
# -k で通すと SAN の不足を見逃し、ブラウザでだけ落ちる状態を緑にしてしまう。
for host in "$APP_HOST" "$SANDBOX_HOST"; do
  if curl -s --cacert certs/dev.crt --max-time 5 "https://${host}:${PORT}/" -o /dev/null; then
    ok "証明書がホスト名を検証できる: $host"
  else
    ng "証明書が $host を検証できません（SAN 不足）"
  fi
done

# ── 4. __Host- cookie の実挙動（7.2 必須要件 2） ─────────────────────────────
rm -f "$COOKIE_JAR"
SESSION_HEADERS="$(curl -s --cacert certs/dev.crt --max-time 5 -D - -o /dev/null \
  -c "$COOKIE_JAR" "https://${APP_HOST}:${PORT}/__dev/session")"

if grep -qi '^set-cookie:.*__Host-' <<<"$SESSION_HEADERS"; then
  ok "アプリ側が __Host- cookie を発行した"
else
  ng "アプリ側が __Host- cookie を発行しませんでした"
fi

# HTTPS 越しに実際にクライアントが受理したか。__Host- の条件を 1 つでも欠くと
# ここが空になる（ヘッダに出ているだけでは受理されたことにならない）。
if [[ -f "$COOKIE_JAR" ]] && grep -q '__Host-' "$COOKIE_JAR"; then
  ok "クライアントが __Host- cookie を受理した（Secure / Path=/ / Domain なし）"
else
  ng "クライアントが __Host- cookie を受理しませんでした（HTTPS か属性の条件を満たしていない）"
fi

# ── 5. cookie がサンドボックス側へ送られない ─────────────────────────────────
#
# ここが 7.2 の眼目。`__Host-` は Domain 属性を持てないためホスト限定になり、
# 同一サイトであってもサブドメインへは送られない。もし送られていたら、
# サンドボックス側のコードがセッションを持つ状態になっている。
SANDBOX_COOKIES="$(curl -s --cacert certs/dev.crt --max-time 5 \
  -b "$COOKIE_JAR" "https://${SANDBOX_HOST}:${PORT}/__dev/cookies" || true)"
APP_COOKIES="$(curl -s --cacert certs/dev.crt --max-time 5 \
  -b "$COOKIE_JAR" "https://${APP_HOST}:${PORT}/__dev/cookies" || true)"

if grep -q '__Host-' <<<"$APP_COOKIES"; then
  ok "アプリ側のリクエストには __Host- cookie が載る"
else
  ng "アプリ側のリクエストに __Host- cookie が載りません（送信条件の検査が成立していません）"
fi

# サンドボックス側は 404 でも「アプリのハンドラに届いていない」ことの確認になるが、
# 判定は cookie 名が出ないことに置く。
if grep -q '__Host-' <<<"$SANDBOX_COOKIES"; then
  ng "サンドボックス用ホストへのリクエストに __Host- cookie が送られています"
else
  ok "サンドボックス用ホストへは __Host- cookie が送られない"
fi

# ── 6. CSP sandbox ヘッダ（7.2 必須要件 1） ──────────────────────────────────
SANDBOX_HEADERS="$(curl -s --cacert certs/dev.crt --max-time 5 -D - -o /dev/null \
  "https://${SANDBOX_HOST}:${PORT}/")"

if grep -qi '^content-security-policy:.*sandbox allow-scripts' <<<"$SANDBOX_HEADERS"; then
  ok "サンドボックス側が CSP: sandbox allow-scripts を返す"
else
  ng "サンドボックス側が CSP: sandbox allow-scripts を返しません"
fi

if grep -qi '^content-security-policy:.*allow-same-origin' <<<"$SANDBOX_HEADERS"; then
  ng "サンドボックス側の CSP に allow-same-origin が入っています（決して付けない）"
else
  ok "サンドボックス側の CSP に allow-same-origin が無い"
fi

if grep -qi '^set-cookie:' <<<"$SANDBOX_HEADERS"; then
  ng "サンドボックス側が cookie を設定しています"
else
  ok "サンドボックス側は cookie を設定しない"
fi

# ── 結果 ─────────────────────────────────────────────────────────────────────
if [[ "$FAILURES" -gt 0 ]]; then
  printf '[origins] %s 件の検査に失敗しました。\n' "$FAILURES" >&2
  echo "ORIGINS_FAIL"
  exit 1
fi

echo "ORIGINS_PASS"
exit 0
