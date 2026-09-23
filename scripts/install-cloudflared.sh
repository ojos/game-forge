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
  if [[ -f "$config" ]] && grep -q "$SSH_HOST" "$config"; then
    echo "[install-cloudflared] ssh config already mentions ${SSH_HOST}, leaving it alone"
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

install_cloudflared_if_missing
write_ssh_config_if_missing
