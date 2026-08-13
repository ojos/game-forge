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

# Ebitengine と許可パッケージを vendor へ焼き込む（M2-4 / #18）。
#
# **ネットワークが要るのはここだけである。** イメージのビルド時に解決して焼き込み、
# 実行時は --network=none で回す。実行時に依存を取りに行く経路を作らない。
#
# vendor ディレクトリをリポジトリへ入れない理由: Ebitengine の vendor は数 MB・
# 数千ファイルになり、差分もレビューも埋もれる。代わりに go.mod で版を固定し、
# go.sum で完全性を担保する（再現性はそちらが持つ）。
#
# vendor-deps.go は `vendordeps` タグ付きでのみ見えるファイルで、許可パッケージを
# 一度 import して vendor の対象にするためだけに存在する。焼き込んだあとに消すのは、
# 生成物へ不要なパッケージが連結されないようにするため（3.4 のバイナリサイズ削減）。
# タグで通常ビルドから外れているので消さなくても連結はされないが、/work へ複製されて
# 生成コードと同じパッケージに同居する意味が無いため置かない。
# `go mod tidy` は走らせない。版はリポジトリの go.mod / go.sum が正であり、ここで
# tidy すると**イメージをビルドした日の最新版**へ動きうる。差分が出ないまま生成物だけ
# が変わる状態を作らない。go.sum があるので `go mod vendor` は完全性も検証する。
RUN cd /src \
 && GOFLAGS= GOOS=js GOARCH=wasm go mod vendor \
 && rm -f /src/vendor-deps.go \
 && chown -R 65534:65534 /src

COPY entrypoint.sh /entrypoint.sh
RUN chmod 0555 /entrypoint.sh

# 数値で指定する。`nobody` は名前解決がイメージ依存（7.1）。
USER 65534:65534

ENTRYPOINT ["/entrypoint.sh"]
