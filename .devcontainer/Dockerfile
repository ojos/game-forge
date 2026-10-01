# devcontainer のベースイメージ（#802）。
#
# **足しているのは vscode の UID/GID の付け替えだけである。** 道具の導入は従来どおり
# devcontainer.json の features と postCreateCommand が持つ（ここへ移さない）。
#
# 値は compose.yaml の build.args から来る。**既定の 1000 は compose.yaml の 1 か所にだけ書く。**
# ここで ARG に既定値を持たせないのは、写しを 2 つにしないためである（空で来たら
# remap-vscode-user.sh が落とす）。既定が 1000 のままであることは
# scripts/check-devcontainer-dev01.sh が `docker compose config` で確かめる。
#
# **ベースは Ubuntu の版の名前（noble = 24.04）で固定する。浮動の `base:ubuntu` に戻さない。**
# `base:ubuntu` は 2026-09-10 に 26.04（resolute）へ移り、26.04 には `apt-key` が無いので、
# devcontainer.json の google-cloud-cli の feature（install.sh が `apt-key` を呼ぶ）が exit 127 で落ちる
# （#802 で dev01 の初回ビルドが実際に落ちた。Mac は 24.04 の古いキャッシュで動いていた）。
# 版を上げるときは、features がすべて新しい版で入ることを確かめてから、この行を書き換える。
FROM mcr.microsoft.com/devcontainers/base:noble

ARG USER_UID
ARG USER_GID

COPY remap-vscode-user.sh /tmp/remap-vscode-user.sh
RUN bash /tmp/remap-vscode-user.sh "${USER_UID}" "${USER_GID}" \
  && rm -f /tmp/remap-vscode-user.sh
