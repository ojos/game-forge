#!/usr/bin/env bash
# check-isolated-build.sh — 7.1 の封じ込め要件のもとで隔離ビルドが成立することを確かめる
# （#51 acceptance 2）。
#
# 検査するのは 4 点:
#   1. --network=none --read-only --tmpfs 3 か所 --user 65534:65534 でビルドが通る
#   2. 非 root 実行で permission denied が出ない（/cache の chown が効いている）
#   3. **コンテナ内から外部ネットワークへ到達できない**
#   4. vendor 済みテンプレートが --tmpfs /work に隠されていない（7.1 の前提 1）
#
# 3 と 4 を入れる理由: 1 が通っただけでは「封じ込めが効いている」ことにならない。
# --network=none が実際に効いていなくてもビルドは成功するし、vendor が隠れていても
# 依存ゼロのサンプルなら成功する。**制約が実際に効いていること自体**を検査しないと、
# 設定が外れたことに気づけないまま緑が出続ける。
#
# 前提: Docker が使えること。イメージの取得には初回のみネットワークが要る。
#   このためローカル層の受け入れ条件（scripts/acceptance.sh）へは入れない。
#
# 終了コード:
#   0 = ISOLATED_BUILD_PASS
#   1 = ISOLATED_BUILD_FAIL
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$(dirname "$HERE")"

IMAGE="game-forge/isolated-build:local"
CACHE_VOLUME="game-forge-go-cache"
BUILD_TIMEOUT="${BUILD_TIMEOUT:-60}"
FAILURES=0
WORKDIR=""

ng() { printf '[isolated-build] NG %s\n' "$1" >&2; FAILURES=$((FAILURES + 1)); }
ok() { printf '[isolated-build] OK %s\n' "$1"; }
fatal() {
  printf '[isolated-build] %s\n' "$1" >&2
  echo "ISOLATED_BUILD_FAIL"
  exit 1
}

# trap から呼ぶため、静的解析からは呼び出しが見えない。
# shellcheck disable=SC2329
cleanup() { [[ -n "$WORKDIR" ]] && rm -rf -- "$WORKDIR"; return 0; }
trap cleanup EXIT

command -v docker >/dev/null 2>&1 || fatal "docker が見つかりません。"
docker info >/dev/null 2>&1 || fatal "Docker デーモンへ接続できません。"

WORKDIR="$(mktemp -d "${TMPDIR:-/tmp}/isolated-build.XXXXXX")" || fatal "一時ディレクトリを作成できませんでした。"

# 7.1 の docker run オプション一式。ここを配列で 1 か所に持ち、すべての検査で使う。
# 検査ごとに書き下すと、片方だけ制約が緩んだ状態で緑になる経路ができる。
CONTAIN_OPTS=(
  --rm
  --network=none
  --read-only
  --tmpfs /tmp:rw,nosuid,nodev,size=512m
  --tmpfs /work:rw,nosuid,nodev,size=256m
  -v "${CACHE_VOLUME}:/cache"
  --user 65534:65534
  --pids-limit=64
  --memory=512m
  --cpus=1
  --security-opt no-new-privileges
)

echo "[isolated-build] イメージをビルドします: $IMAGE"
if ! docker build -q -t "$IMAGE" docker/isolated-build >"$WORKDIR/build.log" 2>&1; then
  sed 's/^/    /' "$WORKDIR/build.log" >&2
  fatal "イメージのビルドに失敗しました。"
fi
ok "イメージをビルドできた"

# ── 1. 封じ込め下でのビルド ──────────────────────────────────────────────────
cat >"$WORKDIR/main.go" <<'EOF'
package main

// M0.5-3 のサンプル。標準ライブラリだけを使う。
// Ebitengine を使った実物のビルドは M2-4 の範囲。
func main() {
	println("game-forge isolated build sample")
}
EOF

# 暖機実行。出力は使わない。
#
# ビルドキャッシュが空のまま計測すると、コンテナの標準出力が無音で失われる
# （docker/isolated-build/entrypoint.sh の注記。実測で決定的に再現する）。
# キャッシュを温めてから計測すると再現しない。ここを省くと、設定が正しいのに
# 初回だけ赤が出る不安定な検査になる。
echo "[isolated-build] ビルドキャッシュを温めます（出力は使いません）"
timeout "$BUILD_TIMEOUT" docker run -i "${CONTAIN_OPTS[@]}" "$IMAGE" \
  <"$WORKDIR/main.go" >/dev/null 2>&1 || true

if timeout "$BUILD_TIMEOUT" docker run -i "${CONTAIN_OPTS[@]}" "$IMAGE" \
     <"$WORKDIR/main.go" >"$WORKDIR/game.b64" 2>"$WORKDIR/run.log"; then
  ok "封じ込め下で go build が成功した"
else
  sed 's/^/    /' "$WORKDIR/run.log" >&2
  ng "封じ込め下で go build が失敗した"
fi

# 成果物の検証。**終了コードを信用しない。**
#
# コンテナの標準出力は無音で切り詰められうるため、コンテナ自身が申告した
# バイト数・sha256 と、こちらが受け取ったものを突き合わせる。申告が届いて
# いない（＝標準エラーごと失われた）場合も失敗として扱う。
reported="$(sed -nE 's/^\[build\] bytes=([0-9]+) sha256=([0-9a-f]+)$/\1 \2/p' "$WORKDIR/run.log" | tail -1)"
if [[ -z "$reported" ]]; then
  ng "コンテナが申告したバイト数・sha256 を受け取れませんでした（出力が失われた疑い）"
else
  reported_bytes="${reported%% *}"
  reported_sha="${reported##* }"

  if base64 -d <"$WORKDIR/game.b64" >"$WORKDIR/game.wasm" 2>/dev/null; then
    actual_bytes="$(wc -c <"$WORKDIR/game.wasm")"
    actual_sha="$(sha256sum "$WORKDIR/game.wasm" | cut -d' ' -f1)"
    actual_magic="$(head -c 4 "$WORKDIR/game.wasm" | od -An -tx1 | tr -d ' \n')"

    if [[ "$actual_bytes" == "$reported_bytes" && "$actual_sha" == "$reported_sha" ]]; then
      ok "成果物がコンテナの申告と一致する（${actual_bytes} バイト）"
    else
      ng "成果物が申告と一致しません（申告 ${reported_bytes}B/${reported_sha:0:12} ≠ 受領 ${actual_bytes}B/${actual_sha:0:12}）"
    fi

    if [[ "$actual_magic" == "0061736d" ]]; then
      ok "成果物が wasm のマジックナンバー（\\0asm）を持つ"
    else
      ng "成果物が wasm ではありません（先頭 4 バイト: ${actual_magic:-空}）"
    fi
  else
    ng "成果物を base64 として復号できませんでした"
  fi
fi

# ── 2. 非 root 実行で permission denied が出ていない ─────────────────────────
if grep -qi 'permission denied' "$WORKDIR/run.log"; then
  sed 's/^/    /' "$WORKDIR/run.log" >&2
  ng "permission denied が出ています（/cache の chown が効いていない可能性）"
else
  ok "permission denied が出ていない"
fi

# 実行ユーザーが本当に 65534 か。--user を書いただけでは、効いていることの確認にならない。
actual_uid="$(docker run --rm --entrypoint /usr/bin/id "${CONTAIN_OPTS[@]:1}" "$IMAGE" -u 2>/dev/null || true)"
if [[ "$actual_uid" == "65534" ]]; then
  ok "実行ユーザーが uid 65534"
else
  ng "実行ユーザーが 65534 ではありません（実測: ${actual_uid:-取得できず}）"
fi

# ── 3. ネットワークへ到達できない ────────────────────────────────────────────
#
# --network=none が実際に効いているかを、コンテナの中から確かめる。
# ここを省くと、オプションを書き落としてもビルドは成功するため気づけない。
#
# `ip` コマンドは使わない。golang イメージに iproute2 が入っていないため、
# `ip -o link show | wc -l` は常に 0 を返し、--network=bridge でも「インターフェイス
# 無し」と読めてしまう（実測。この検査は当初それで偽陰性になっていた）。
#
# 判定は経路表で行う。--network=none では /proc/net/route に 1 件も無く、
# bridge では既定経路を含む 2 件が現れる（実測）。経路が無ければ外へは出られない。
net_routes="$(docker run --rm --entrypoint /bin/sh "${CONTAIN_OPTS[@]:1}" "$IMAGE" \
  -c 'tail -n +2 /proc/net/route | wc -l' 2>/dev/null || echo "error")"
net_ifaces="$(docker run --rm --entrypoint /bin/sh "${CONTAIN_OPTS[@]:1}" "$IMAGE" \
  -c 'ls /sys/class/net | grep -c "^eth" || true' 2>/dev/null || echo "error")"

if [[ "$net_routes" == "0" && "$net_ifaces" == "0" ]]; then
  ok "コンテナに経路も外部インターフェイスも無い（--network=none が効いている）"
else
  ng "ネットワークへ到達しうる状態です（経路 ${net_routes} 件 / eth 系 ${net_ifaces} 個。--network=none が効いていない）"
fi

# ルートファイルシステムが読み取り専用であること。
#
# **この検査だけは root で実行する。** uid 65534 では、--read-only の有無に関わらず
# / へ書き込めない（/ は root 所有 0755）。非 root のまま検査すると「書けなかった」の
# 原因が読み取り専用なのか権限なのか区別できず、--read-only を外しても緑になる
# （実測。この検査は当初それで偽陰性になっていた）。--user を後ろに置いて上書きする。
if docker run --rm --entrypoint /bin/sh "${CONTAIN_OPTS[@]:1}" --user 0:0 "$IMAGE" \
     -c 'touch /should-fail' >/dev/null 2>&1; then
  ng "root でルートファイルシステムへ書き込めました（--read-only が効いていない）"
else
  ok "ルートファイルシステムが読み取り専用（root でも書けない）"
fi

# 書き込みが許された 3 か所は実際に書けること。読み取り専用にしすぎると go build が
# 動かないため、「塞がっている」だけでなく「必要な穴が開いている」ことも確かめる。
if docker run --rm --entrypoint /bin/sh "${CONTAIN_OPTS[@]:1}" "$IMAGE" \
     -c 'touch /tmp/a && touch /work/b && touch /cache/c' >/dev/null 2>&1; then
  ok "/tmp・/work・/cache の 3 か所が書き込み可能"
else
  ng "/tmp・/work・/cache のいずれかへ書き込めません"
fi

# ── 4. vendor が /work のマウントに隠されていない（7.1 の前提 1） ────────────
vendor_check="$(docker run --rm --entrypoint /bin/sh "${CONTAIN_OPTS[@]:1}" "$IMAGE" \
  -c 'test -f /src/vendor/modules.txt && cp -R /src/. /work/ && test -f /work/vendor/modules.txt && echo ok' 2>/dev/null || true)"
if [[ "$vendor_check" == "ok" ]]; then
  ok "vendor が /src に焼かれ、/work へ複製されている"
else
  ng "vendor が /src に無いか、/work へ複製できていません（7.1 の前提 1）"
fi

# ── 5. 失敗するソースがきちんと失敗する ──────────────────────────────────────
#
# 成功だけを見ていると、ビルドしていなくても緑になる経路に気づけない。
if printf 'package main\nfunc main() { this is not go }\n' \
   | timeout "$BUILD_TIMEOUT" docker run -i "${CONTAIN_OPTS[@]}" "$IMAGE" \
     >/dev/null 2>"$WORKDIR/fail.log"; then
  ng "壊れたソースのビルドが成功しました（検査が成立していません）"
else
  ok "壊れたソースのビルドは失敗する"
fi

if [[ "$FAILURES" -gt 0 ]]; then
  printf '[isolated-build] %s 件の検査に失敗しました。\n' "$FAILURES" >&2
  echo "ISOLATED_BUILD_FAIL"
  exit 1
fi

echo "ISOLATED_BUILD_PASS"
exit 0
