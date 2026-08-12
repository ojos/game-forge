# 隔離ビルドコンテナ（7.1）のローカル版。
#
# 位置づけ: M0.5-3 の範囲は「封じ込めの形がローカルで成立すること」の確認までである。
# Ebitengine の vendor 焼き込みと VPS への自動デプロイは M2-4 が所有する。
# ここで確かめるのは、7.1 が「選択肢ではなく前提条件」と書いた制約
# （--network=none / --read-only / tmpfs 3 か所 / --user 65534:65534）のもとで
# `go build` が実際に通ること、そのために Dockerfile 側へ必要な 2 つの前提が
# 満たされていることの 2 点。

FROM golang:1.26.5

# 7.1 が列挙する環境変数。
ENV CGO_ENABLED=0 \
    GOFLAGS=-mod=vendor \
    GOCACHE=/cache/go-build \
    GOMODCACHE=/cache/go-mod \
    GOTMPDIR=/tmp \
    GOOS=js \
    GOARCH=wasm \
    # ルートファイルシステムが読み取り専用なので、HOME を書き込める場所へ逃がす。
    # 既定の /root は書けないうえ、--user 65534 では所有者でもない。
    HOME=/tmp \
    # go.mod の `go` ディレクティブが導入済みより新しいと、go は toolchain を
    # ダウンロードしようとする。--network=none 下では確定で失敗するため、
    # 手元のツールチェインだけを使うよう固定する。
    GOTOOLCHAIN=local

# 7.1 の前提 2: /cache はイメージビルド時に作成し、実行ユーザーへ chown しておく。
# named volume はマウント先がイメージ内に存在しないと root:root 0755 で作られ、
# 非 root 実行では書き込めず permission denied になる。
RUN mkdir -p /cache/go-build /cache/go-mod && chown -R 65534:65534 /cache

# 7.1 の前提 1: vendor 済みテンプレートは /work ではなく /src に焼き込む。
# --tmpfs /work は空のファイルシステムをその位置にかぶせるため、/work に置くと
# マウント時に隠れて見えなくなり、--network=none 下で依存を解決できない。
COPY template/ /src/

COPY entrypoint.sh /entrypoint.sh
RUN chmod 0555 /entrypoint.sh

# 数値で指定する。`nobody` は名前解決がイメージ依存（7.1）。
USER 65534:65534

ENTRYPOINT ["/entrypoint.sh"]
