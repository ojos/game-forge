# devcontainer のベースイメージ（#802）。
#
# **足しているのは vscode の UID/GID の付け替えだけである。** 道具の導入は従来どおり
# devcontainer.json の features と postCreateCommand が持つ（ここへ移さない）。
#
# 値は compose.yaml の build.args から来る。**既定の 1000 は compose.yaml の 1 か所にだけ書く。**
# ここで ARG に既定値を持たせないのは、写しを 2 つにしないためである（空で来たら
# remap-vscode-user.sh が落とす）。既定が 1000 のままであることは
# scripts/check-devcontainer-dev01.sh が `docker compose config` で確かめる。
FROM mcr.microsoft.com/devcontainers/base:ubuntu

ARG USER_UID
ARG USER_GID

COPY remap-vscode-user.sh /tmp/remap-vscode-user.sh
RUN bash /tmp/remap-vscode-user.sh "${USER_UID}" "${USER_GID}" \
  && rm -f /tmp/remap-vscode-user.sh
