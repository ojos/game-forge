#!/usr/bin/env bash
# dev-certs.sh — ローカル HTTPS 用の自己署名証明書を作る。
#
# なぜ必要か:
#   7.2 の必須要件 2（セッション cookie を `__Host-` 接頭辞にする）を検証するには
#   HTTPS が要る。ブラウザは `__Host-` を `Secure` 属性つきのときだけ受理し、
#   `Secure` は安全なコンテキストを要求する。`http://localhost` は例外的に安全な
#   コンテキストとして扱われるが、**`*.localtest.me` は該当しない**。同一サイトの
#   再現に `localtest.me` を使う以上、証明書は避けて通れない。
#
#   これが 9.1 の表で「実ドメインでの CSP / cookie 挙動」がローカル検証の限界として
#   挙げられている一方、「`localtest.me` 等で同一サイトは再現できるが、`__Host-` は
#   HTTPS 必須のため自己署名証明書が要る」と注記されている理由である。
#
# 冪等: 既に有効な証明書があれば作り直さない。
#
# 終了コード: 0 = 用意できた / 1 = 失敗
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$(dirname "$HERE")"

CERT_DIR="certs"
KEY_PATH="$CERT_DIR/dev.key"
CRT_PATH="$CERT_DIR/dev.crt"
DAYS=825

# 対象ホストは wrangler.toml の宣言から読む。ここへ書き写すと、設定を変えたときに
# 証明書だけが古いホスト名のまま残り、TLS は通るのに検証対象がずれる。
read_var() {
  local key="$1"
  sed -nE "s/^[[:space:]]*${key}[[:space:]]*=[[:space:]]*\"([^\"]+)\".*/\1/p" wrangler.toml | head -1
}

APP_HOST="$(read_var APP_HOST)"
SANDBOX_HOST="$(read_var SANDBOX_HOST)"
# 運営の管理画面（仕様 2.4.1。#356）。**3 つ目のホストである。**
#
# **足さないと、ローカルで admin ホストの TLS 検証が通らない。** ブラウザの検査は
# `--ignore-certificate-errors` で、curl は `-k` で走るため**失敗として現れない**
# ——「証明書が合っていないこと」に気づけないまま検証したことになる（#359 の Copilot の
# 指摘）。`--cacert certs/dev.crt` で検証する使い方（このファイルの末尾が案内している）
# では、ここが欠けた瞬間に admin だけが落ちる。
ADMIN_HOST="$(read_var ADMIN_HOST)"

if [[ -z "$APP_HOST" || -z "$SANDBOX_HOST" || -z "$ADMIN_HOST" ]]; then
  echo "[certs] wrangler.toml から APP_HOST / SANDBOX_HOST / ADMIN_HOST を読めませんでした。" >&2
  exit 1
fi

command -v openssl >/dev/null 2>&1 || { echo "[certs] openssl が見つかりません。" >&2; exit 1; }

SAN="DNS:${APP_HOST},DNS:${SANDBOX_HOST},DNS:${ADMIN_HOST},DNS:localhost,IP:127.0.0.1"

# 既存の証明書が「まだ有効」かつ「必要な SAN をすべて含む」なら作り直さない。
# 有効期限だけを見ると、ホスト名を増やしたときに古い証明書を使い続けてしまう。
#
# **増やしたホストをここへ足し忘れると、古い証明書が使われ続ける。** 3 つ目を足した
# 2026-09-12 の時点で、手元に 2 ホストぶんの証明書を持っている環境が実在する。
if [[ -f "$KEY_PATH" && -f "$CRT_PATH" ]]; then
  existing_san="$(openssl x509 -in "$CRT_PATH" -noout -ext subjectAltName 2>/dev/null || true)"
  if openssl x509 -in "$CRT_PATH" -noout -checkend 86400 >/dev/null 2>&1 \
     && [[ "$existing_san" == *"$APP_HOST"* && "$existing_san" == *"$SANDBOX_HOST"* \
           && "$existing_san" == *"$ADMIN_HOST"* ]]; then
    echo "[certs] 既存の証明書をそのまま使います: $CRT_PATH"
    exit 0
  fi
  echo "[certs] 既存の証明書が期限切れか SAN 不足のため作り直します。"
fi

mkdir -p "$CERT_DIR"

# -nodes: 秘密鍵をパスフレーズなしで出す。wrangler が非対話で読むため。
# この鍵はローカル開発専用で、certs/ は追跡除外にしてある。
openssl req -x509 -newkey rsa:2048 -sha256 -nodes \
  -keyout "$KEY_PATH" -out "$CRT_PATH" -days "$DAYS" \
  -subj "/CN=${APP_HOST}" \
  -addext "subjectAltName=${SAN}" \
  -addext "basicConstraints=critical,CA:FALSE" \
  -addext "keyUsage=critical,digitalSignature,keyEncipherment" \
  -addext "extendedKeyUsage=serverAuth" \
  >/dev/null 2>&1

chmod 600 "$KEY_PATH"

echo "[certs] 作成しました: $CRT_PATH"
echo "[certs] SAN: $SAN"
echo "[certs] 自己署名のため、ブラウザでは初回に警告が出ます（curl は --cacert certs/dev.crt で検証できます）。"
