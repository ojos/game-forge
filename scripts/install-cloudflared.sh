#!/usr/bin/env bash
# devcontainer へ cloudflared を導入し、dev01 への ssh の入口を用意する（#792 / M22-2）。
#
# **なぜ devcontainer に要るのか。** このコンテナは Docker のブリッジ網にいて、
# **ホストの LAN（192.168.3.0/24）へ出られない**（2026-09-23 に実測。laptop も
# ルータも Mac も、拒否ではなくタイムアウトになる）。外向きには出られるので、
# dev01 へ届く経路は **Cloudflare Tunnel を回るものだけ**である。
#
# **鍵はこのコンテナに置かない。** VS Code が SSH agent を転送しており
# （SSH_AUTH_SOCK）、認証はそれで足りる。秘密鍵の写しを増やさない。
#
# **Access の認証は導入では済まない。** 初回に一度だけ、対話で
#   cloudflared access login https://dev01-ssh.ojos.jp
# を叩き、表示される URL をブラウザで開いて Google（ojos.jp）で認証する。
# トークンは ~/.cloudflared/ に置かれる。手順の全体は docs/local-llm-tunnel.md。
set -euo pipefail

readonly SSH_HOST="dev01-ssh.ojos.jp"
readonly MARKER="# managed by scripts/install-cloudflared.sh (#792)"

install_cloudflared_if_missing() {
  if command -v cloudflared >/dev/null 2>&1; then
    echo "[install-cloudflared] already installed: $(cloudflared --version)"
    return 0
  fi
  echo "[install-cloudflared] installing cloudflared ..."
  curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg \
    | sudo tee /usr/share/keyrings/cloudflare-main.gpg >/dev/null
  echo "deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared any main" \
    | sudo tee /etc/apt/sources.list.d/cloudflared.list >/dev/null
  sudo apt-get update -qq
  sudo apt-get install -y -qq cloudflared
  echo "[install-cloudflared] installed: $(cloudflared --version)"
}

# ~/.ssh/config へ入口を書く。
#
# **既にこのホストの設定があれば触らない。** 利用者が手で書いた設定を、
# コンテナの作り直しのたびに上書きしない（マーカーで自分の書いた分だけを見分ける）。
write_ssh_config_if_missing() {
  local config="${HOME}/.ssh/config"
  mkdir -p "${HOME}/.ssh"
  chmod 700 "${HOME}/.ssh"
  # **ホスト名の文字列があるかでは判定しない**（第二意見の指摘。2026-09-29）。
  # `HostName` の行やコメントに現れるだけで「設定済み」と読み、`ssh dev01` の別名が
  # 足されないまま終わる。見るのは自分のマーカーと、`Host` 行の別名だけ。
  if [[ -f "$config" ]] && {
    grep -qxF "$MARKER" "$config" ||
      grep -qE '^[[:space:]]*Host([[:space:]]+[^[:space:]]+)*[[:space:]]+dev01([[:space:]]|$)' "$config"
  }; then
    echo "[install-cloudflared] ssh config already has Host dev01, leaving it alone"
    return 0
  fi
  cat >>"$config" <<EOF

${MARKER}
Host ${SSH_HOST} dev01
  HostName ${SSH_HOST}
  User ido
  ProxyCommand cloudflared access ssh --hostname %h
  ForwardAgent no
EOF
  chmod 600 "$config"
  echo "[install-cloudflared] wrote ssh config for ${SSH_HOST}"
}

# **dev01 の上のコンテナでは何もしない**（#802）。
#
# 上の前提（コンテナはホストの LAN へ出られないので、dev01 へはトンネルを回るしかない）は
# **ホストが Mac のときの話である。** dev01 の上で立てたコンテナでは、ホストが dev01 自身なので、
# ここで入口を書くと「dev01 から dev01 へトンネルを回って入る」自己参照の設定になる。
# 使い道が無いうえ、`ssh dev01` が通ってしまうぶん、どの機械にいるのかを取り違えやすい。
# cloudflared の導入も、この入口のためだけにあるので一緒に飛ばす。
#
# **判定はホストからの宣言（環境変数 DEVCONTAINER_HOST）で行う。** dev01 では
# `.devcontainer/.env`（追跡外）に `DEVCONTAINER_HOST=dev01` を書き、compose.yaml の
# environment がコンテナへ渡す。自動の判定を採らなかった理由:
#   - コンテナのホスト名はコンテナ ID で、ホストの名前は見えない。
#   - `docker info` の Name はホストの名前を返すが、postCreate の時点でソケットが使える保証が無く、
#     ホスト名を dev01 以外にした日に黙って外れる。
#   - LAN（192.168.3.0/24）へ届くかで見る案は、Mac 側が拒否ではなくタイムアウトになるので遅く、
#     網の設定で結果が変わる。
# 宣言は UID の DEVCONTAINER_UID=1001 と同じファイルに並べる。UID を渡し忘れると
# ワークスペースへ書き込めずすぐ気づくので、同じ場所の書き忘れも一緒に見つかる。
#
# 比べる相手は、書こうとしている Host の別名（dev01）である。
if [[ "${DEVCONTAINER_HOST:-}" == "dev01" ]]; then
  echo "[install-cloudflared] DEVCONTAINER_HOST=dev01: このコンテナのホストが入口の行き先そのものなので、導入も ~/.ssh/config への追記もしません"
  exit 0
fi

install_cloudflared_if_missing
write_ssh_config_if_missing
