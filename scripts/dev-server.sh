#!/usr/bin/env bash
# dev-server.sh — ローカル開発サーバ（wrangler pages dev）を HTTPS で起動する。
#
# Pages Functions を使う（確定22）。ゾーンが Route53 にある以上（確定17）Workers の
# カスタムドメインは張れないため、本番は Pages になる。開発も同じ起動形態に揃える。
# `wrangler dev` は Pages 構成に対して「Workers 用のコマンドです」と言って落ちる。
#
# 1 プロセスでアプリ用ホストとサンドボックス用ホストの両方を提供する。オリジンは
# スキーム・ホスト・ポートで決まるため、同じポートでもホスト名が違えば別オリジンに
# なる。7.2 が要求するのは別オリジンであって別ポートではない（src/index.ts）。
#
# HTTPS で起動する理由は scripts/dev-certs.sh のコメントに書いてある（`__Host-`）。
#
# 使い方:
#   npm run dev            # 既定ポート 8787
#   PORT=9000 npm run dev
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$(dirname "$HERE")"

PORT="${PORT:-8787}"

bash scripts/dev-certs.sh

APP_HOST="$(sed -nE 's/^[[:space:]]*APP_HOST[[:space:]]*=[[:space:]]*"([^"]+)".*/\1/p' wrangler.toml | head -1)"
SANDBOX_HOST="$(sed -nE 's/^[[:space:]]*SANDBOX_HOST[[:space:]]*=[[:space:]]*"([^"]+)".*/\1/p' wrangler.toml | head -1)"

echo "[dev] アプリ:         https://${APP_HOST}:${PORT}/"
echo "[dev] サンドボックス: https://${SANDBOX_HOST}:${PORT}/"
echo

# CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV=false を明示する。
#
# 既定（true）では、wrangler はリポジトリ直下の .env を「シークレット」として読み、
# Worker の env へ流し込む。このリポジトリの .env には開発ツール用の GH_TOKEN /
# GEMINI_API_KEY が入っており、アプリのコードから参照できる状態になるうえ、
# `wrangler deploy` では本番の secret としてアップロードされうる。
#
# アプリ向けのシークレットは .dev.vars（追跡除外）に置く。こちらはこのフラグと
# 無関係に読み込まれるため、止めても Dev 組織の API キーの経路は失われない。
exec env CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV=false \
  npx wrangler pages dev \
  --ip 127.0.0.1 \
  --port "$PORT" \
  --local-protocol https \
  --https-key-path certs/dev.key \
  --https-cert-path certs/dev.crt \
  "$@"
