# 隔離ビルドコンテナ（7.1）。**本番は AWS Lambda のコンテナイメージである**（確定24 / 3.8）。
#
# 位置づけ: 同じイメージを 2 通りに動かす。
#
#   - **本番**: ECR へ置き、ビルド関数の実体として Lambda が起動する。入口は
#     Lambda Runtime API（handler/main.go の runLambda）。
#   - **ローカル**: `docker run` で 7.1 のフラグ列のもとに起動し、
#     scripts/check-isolated-build.sh が回す。入口は同じバイナリの oneshot モード。
#
# **ハンドラ本体はどちらでも同じコードである。** 検査が本番と違う経路を通ると、
# 検査が緑でも本番が壊れている状態を作れてしまう。
#
# **ずれの向きは「ローカルのほうが本番より強い」**（7.1）。ローカルにだけ
# `--network=none` があり、本番に対応物は無い。検査の位置づけは
# scripts/check-isolated-build.sh の冒頭に表で置いた。

FROM golang:1.26.5

# brotli(1) を入れる（3.3-6 / 3.4-1）。
#
# **なぜ外部コマンドか。** 標準ライブラリに brotli は無く、handler/ は依存パッケージを
# 1 つも持たない方針である（handler/go.mod の注記）。加えて **q11 は本プロダクトで
# 最も重い処理**であり、参照実装（C）より遅い純 Go 移植を選ぶ余地が無い。
#
# **ネットワークが要るのはイメージのビルド時だけである。** 実行時は取りに行かない。
RUN apt-get update \
 && apt-get install -y --no-install-recommends brotli \
 && rm -rf /var/lib/apt/lists/*

# 7.1 が列挙する環境変数。
ENV CGO_ENABLED=0 \
    GOFLAGS=-mod=vendor \
    GOOS=js \
    GOARCH=wasm \
    # ルートファイルシステムが読み取り専用なので、HOME を書き込める場所へ逃がす。
    # 既定の /root は本番でも書けない。GOCACHE / GOMODCACHE / GOTMPDIR は
    # **ハンドラが呼び出しごとに /tmp 配下へ設定し直す**ので、ここには置かない。
    # 置くと「宣言に無い既定値」が生まれ、掃除の対象から外れた場所へ書きうる。
    HOME=/tmp \
    # go.mod の `go` ディレクティブが導入済みより新しいと、go は toolchain を
    # ダウンロードしようとする。手元のツールチェインだけを使うよう固定する。
    # **7.1 が egress 遮断の欠落を受け入れた根拠の 1 つがこれである**（確定24）。
    GOTOOLCHAIN=local

# 7.1 の前提 1: vendor 済みテンプレートは作業ディレクトリではなく /src に焼き込む。
# ハンドラが呼び出しごとに /src → /tmp/inv-xxxx へ複製する（本番の書き込み先は
# /tmp だけである。7.1 の対応表）。
COPY template/ /src/

# Ebitengine と許可パッケージを vendor へ焼き込む（M2-4 / #18）。
#
# **ネットワークが要るのはここだけである。** イメージのビルド時に解決して焼き込み、
# 実行時は依存を取りに行かない。**本番に `--network=none` は無い**が、
# `GOFLAGS=-mod=vendor` による依存の固定は本番でもそのまま効く（7.1）。
#
# vendor ディレクトリをリポジトリへ入れない理由: Ebitengine の vendor は数 MB・
# 数千ファイルになり、差分もレビューも埋もれる。代わりに go.mod で版を固定し、
# go.sum で完全性を担保する（再現性はそちらが持つ）。
#
# vendor-deps.go は、許可パッケージを一度 import して vendor の対象にするためだけに
# 存在する（`go mod vendor` は実際に import されているものしか入れない）。
#
# **焼き込んだら消す。** ビルドタグで通常ビルドから隠す手もあるが、`go mod vendor` が
# タグ付きファイルを拾うかは実装依存なので、確実な「消す」を採る。残すと作業ディレクトリへ
# 複製されて生成コードと同じ package main に同居し、生成物が使わないパッケージまで
# 連結されうる（3.4 のバイナリサイズ削減）。
# `go mod tidy` は走らせない。版はリポジトリの go.mod / go.sum が正であり、ここで
# tidy すると**イメージをビルドした日の最新版**へ動きうる。差分が出ないまま生成物だけ
# が変わる状態を作らない。go.sum があるので `go mod vendor` は完全性も検証する。
RUN cd /src \
 && GOFLAGS= GOOS=js GOARCH=wasm go mod vendor \
 && rm -f /src/vendor-deps.go \
 && chown -R 65534:65534 /src

# ── ハンドラ ────────────────────────────────────────────────────────────────
#
# TARGETARCH は BuildKit が自動で与える。**Lambda の関数アーキテクチャと一致させる**
# 必要があるため、決め打ちしない（terraform/build-function.tf の architectures）。
ARG TARGETARCH
COPY handler/ /build/handler/

# **テストが通らないイメージは存在できない。**
#
# 7.1 の「受け入れた劣化」3 点目は、`docker run --rm` の使い捨てを手放す理由として
# 「掃除がテスト可能な単位であること」を挙げている。**その担保をイメージのビルドに
# 埋め込む。** 検査スクリプトの中だけに置くと、検査を回さない経路でイメージが配れる。
#
# GOFLAGS を空にするのは、handler/ が vendor を持たない（依存 0 件の）モジュール
# だからである。GOOS/GOARCH はイメージ既定の js/wasm を上書きする。
RUN cd /build/handler \
 && GOFLAGS= GOOS=linux GOARCH="${TARGETARCH}" go vet ./... \
 && GOFLAGS= GOOS=linux GOARCH="${TARGETARCH}" go test ./... \
 && GOFLAGS= GOOS=linux GOARCH="${TARGETARCH}" go build -ldflags="-s -w" -o /build-handler . \
 && rm -rf /build \
 && chmod 0555 /build-handler

# 数値で指定する。`nobody` は名前解決がイメージ依存（7.1）。
#
# **Lambda はこの指定を保証しない。** AWS がコンテナイメージで解釈すると明記している
# のは ENTRYPOINT / CMD / WORKDIR / ENV であり、USER は含まれない。非 root では
# あるが `65534` 固定にはできない（7.1 の「受け入れた劣化」5 点目。実値は未実測）。
# ローカルの `docker run` では効くので、そちらの検査のために残す。
USER 65534:65534

# 相対パスが読み取り専用の領域へ落ちないよう、作業ディレクトリを書ける場所にする。
WORKDIR /tmp

ENTRYPOINT ["/build-handler"]
