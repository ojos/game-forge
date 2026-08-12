#!/bin/sh
# 隔離ビルドコンテナのエントリポイント。
#
# 契約:
#   標準入力  = ビルドする Go ソース 1 ファイル分（生成されたゲーム本体）
#   標準出力  = ビルド成果物を **base64（改行なし）** で符号化したもの
#   標準エラー = ログ。最終行に `[build] bytes=<N> sha256=<hex>` を必ず出す
#
# 標準入出力で受け渡すのは、bind mount を使わないためである。ビルドサーバーは
# ホストのファイルシステムを攻撃者が制御しうるコードへ差し出さない（7.1）。
# 副次的に、devcontainer のような docker-outside-of-docker 構成でも
# ホスト側のパスを気にせず動く。
#
# なぜ生バイナリではなく base64 か（実測に基づく）:
#   コンテナの標準出力でバイナリを運ぶ経路は、2 通りとも壊れることを確認した。
#     - `docker run` の attach 経由: **無音で落ちる。** ビルドキャッシュが空の状態で
#       `go build` を回すと、ビルド開始前の出力は届くのに、それ以降の標準出力・
#       標準エラーがすべて失われた（終了コードは 0 のまま）。
#       リソース制限（--pids-limit / --memory / --cpus）とは無関係で、全部外しても再現した。
#     - `docker logs` 経由: **バイト列が壊れる。** json-file ログドライバは値を
#       UTF-8 文字列として保持するため、1,802,361 バイトの wasm が 2,260,527 バイトになった。
#   base64 は ASCII なので後者を回避できる。前者は検出できる形にするしかないため、
#   バイト数と sha256 を標準エラーへ出し、呼び出し側に照合させる（切り詰めが
#   起きたら合わない）。**終了コードだけを信用しないこと。**
#   scripts/check-isolated-build.sh がこの照合を実装している。
set -eu

# 7.1 の前提 1: /src から /work へ複製する。/work は tmpfs なので、
# コンテナ終了時に消えてホストに残らない。
#
# -a ではなく -R を使う。-a は複製先ディレクトリ（/work）自身の所有者・時刻まで
# 合わせようとするが、/work は tmpfs のマウント点で root 所有であり、uid 65534 では
# 変更できず `cp: preserving times for '/work/.': Operation not permitted` で落ちる
# （実測）。ビルドに要るのは内容だけで、所有者と時刻の保存は要らない。
cp -R /src/. /work/

# 生成コードを置く。/src 側に main.go を焼き込まないのは、標準入力が空のときに
# 「前回のテンプレートがビルドされて成功した」と読める状態を作らないため。
cat > /work/main.go

if [ ! -s /work/main.go ]; then
  echo "[build] 標準入力が空です。ビルドするソースを渡してください。" >&2
  exit 2
fi

cd /work

# -ldflags="-s -w" は 3.4-3（バイナリサイズ削減）。
go build -ldflags="-s -w" -o /work/game.wasm . >&2

if [ ! -s /work/game.wasm ]; then
  echo "[build] 成果物が生成されませんでした。" >&2
  exit 3
fi

echo "[build] bytes=$(wc -c < /work/game.wasm) sha256=$(sha256sum /work/game.wasm | cut -d' ' -f1)" >&2

base64 -w0 /work/game.wasm
