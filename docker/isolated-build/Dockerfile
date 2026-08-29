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

# ── ピン留めした Go の版（確定12 / 3.5）──────────────────────────────────────
#
# **下の `ARG GO_VERSION` が、イメージにおける版の正本である。** 版は「ベースイメージのタグ」
# 「template/go.mod の `go` ディレクティブ」「handler/go.mod の `go` ディレクティブ」の
# 3 か所で一致していなければならないが、**書き写すのはここだけにして、残り 2 か所は
# 下で機械照合する**（shared-ai-rules 12 章「一覧の複製は機械照合で担保する」）。
#
# 更新の契機と判断の根拠は確定12、手順は 3.5 にある。**「上げるかどうか」を毎回人が
# 判断する形は採らない**（確定12）。ここが古くなっていること自体が、契機の側の失敗である。
ARG GO_VERSION=1.27.0

FROM golang:${GO_VERSION}

# **FROM をまたぐと ARG の値は失われる**（FROM より前の ARG はビルド引数の宣言だけが
# グローバルで、値はステージへ引き継がれない）。以降の RUN で使うため宣言し直す。
# **既定値は上の 1 か所だけが持つ**ので、ここに書き足さない。
ARG GO_VERSION

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

# ── 版の機械照合（確定12 / 3.5）──────────────────────────────────────────────
#
# **版がずれたイメージは存在できない。** 下の「テストが通らないイメージは存在できない」
# と同じ考え方で、担保をイメージのビルドへ埋め込む。検査スクリプトの側だけに置くと、
# **検査を回さない経路でイメージが配れる。**
#
# **照合するのは 3 者の一致である。** ベースイメージが実際に持つ Go の版・`GO_VERSION`・
# 2 つの go.mod の `go` ディレクティブ。**ずれの向きで壊れ方が違い、片方は黙っている。**
#
#   - go.mod が**上**へずれる: `GOTOOLCHAIN=local` があるのでツールチェインを取りに
#     行かず、`go.mod requires go >= ...` で落ちる。**うるさく壊れるので気づける。**
#   - go.mod が**下**へずれる: **何も起きずビルドが通る。** ピン留めの申告だけが嘘になり、
#     3.5 の `wasm_exec.js` 出し分けが根拠にしている「イメージの版」と実際にビルドした
#     版がずれる。**この検査が捕まえたいのはこちらである。**
#
# **`go mod tidy` を走らせない方針（下記）の裏返しでもある。** 版を手で整合させると
# 決めた以上、整合しているかどうかを人の目に委ねない。
#
# go.mod だけを先に複製するのは、**vendor の解決（ネットワークが要る唯一の段）より
# 前で落とす**ためである。照合し終えたら消す。
#
# **`head -n 1` と書く（`head -1` ではない）。** 数字だけを渡す形は POSIX が定めておらず、
# 解釈しない実装がある。**ここはベースイメージの中でしか動かないので現に困ってはいない**が、
# scripts/check-isolated-build.sh が `sort -V`（GNU 拡張）を避けたのと同じ理由で揃える
# （PR #108 の Copilot code review。**検査そのものが黙って無効になる形を作らない**）。
COPY template/go.mod /pin/template.go.mod
COPY handler/go.mod /pin/handler.go.mod
RUN set -eu; \
    image_go="$(go env GOVERSION)"; \
    if [ "$image_go" != "go${GO_VERSION}" ]; then \
      echo "ベースイメージの Go が go${GO_VERSION} ではありません: ${image_go}" >&2; \
      exit 1; \
    fi; \
    for f in /pin/template.go.mod /pin/handler.go.mod; do \
      directive="$(sed -n 's/^go \([0-9][0-9.]*\)[[:space:]]*$/\1/p' "$f" | head -n 1)"; \
      if [ "$directive" != "${GO_VERSION}" ]; then \
        echo "${f} の go ディレクティブが ${GO_VERSION} ではありません: ${directive:-（読み取れません）}" >&2; \
        exit 1; \
      fi; \
    done; \
    rm -rf /pin

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
