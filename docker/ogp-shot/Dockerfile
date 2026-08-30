# OGP 撮影関数のイメージ（5.4 / 11.2 / #26）。
#
# **zip では配れない。** chromium の実体は zip パッケージの上限（展開後 250 MB）に
# 収まらない。コンテナイメージなら 10 GB まで置ける。これが「関数のサイズ上限で
# 成立しない」を回避している唯一の点なので、zip へ戻さないこと
# （terraform/ogp-function.tf の aws_lambda_function.ogp）。
#
# **ベースは AWS 公式の Lambda ランタイムイメージである。** @sparticuz/chromium は
# この Amazon Linux 2023 系のイメージで動くことを前提に、必要な共有ライブラリと
# フォントを自分の tarball に同梱している。**別のベース（debian 等）へ移すなら、
# 同梱の前提が崩れることを承知で移すこと。**
#
# ## 版について（未検証）
#
# **このイメージは本番で 1 度もビルドしていない。** 下の 2 つのパッケージは
# npm の解決に任せており、`npm install` が失敗する（その範囲の版が無い）ことがありうる。
# その場合は `npm view @sparticuz/chromium versions` で実在する版を見て package.json を
# 直すこと。**解決された版は、最初にビルドが通った時点で docs/ogp-capture.md へ記録する。**
#
# docker/isolated-build/Dockerfile が Go の版を `ARG GO_VERSION` として固定しているのと
# 揃っていない。**揃えないのは、まだ 1 度も通っていない値を「正本」として置かないため**
# である（動いていないものを動いているように書かない）。
FROM public.ecr.aws/lambda/nodejs:22

# 依存だけを先に入れる。ハンドラを直しただけの再ビルドで chromium を引き直さない。
COPY package.json ${LAMBDA_TASK_ROOT}/
RUN npm install --omit=dev --no-audit --no-fund

COPY index.mjs ${LAMBDA_TASK_ROOT}/

# ハンドラは `index.mjs` の `handler`。
CMD [ "index.handler" ]
