#!/usr/bin/env bash
# 選択された AI CLI ツールを導入する（生成時に --with-* で選ばれたものだけ）。
set -euo pipefail

install_if_missing() {
  local cmd="$1"
  local pkg="$2"
  if command -v "$cmd" >/dev/null 2>&1; then
    echo "[install-ai-tools] $cmd already installed, skipping"
    return 0
  fi
  echo "[install-ai-tools] installing $pkg ..."
  npm install -g "$pkg"
  echo "[install-ai-tools] $cmd installed: $(command -v "$cmd")"
}

# agy（Antigravity CLI）は npm 配布ではないため install_if_missing の同型に乗らない。
# 配布元のインストーラを取得して実行し、~/.local/bin/agy へ置く。
#
# 認証は OAuth のみで、API キーには対応しない。導入だけでは使えず、初回に
# 対話で `agy` を起動して Google アカウントへログインする必要がある。資格情報は
# ~/.gemini/antigravity-cli/ 配下に置かれ、この devcontainer では ~/.gemini が
# named volume（gemini-storage）なので rebuild しても消えない。
install_agy_if_missing() {
  if command -v agy >/dev/null 2>&1; then
    echo "[install-ai-tools] agy already installed, skipping"
    return 0
  fi
  echo "[install-ai-tools] installing agy (Antigravity CLI) ..."
  curl -fsSL https://antigravity.google/cli/install.sh | bash
  # インストーラは ~/.local/bin へ置く。PATH に無ければ、導入直後の同一シェルからは
  # 見えない。これは失敗ではないので、次に何をすればよいかを言うに留める。
  #
  # ただし「PATH に無いだけ」と「そもそも置かれていない」を取り違えない。実体の
  # 有無で分ける。curl 自体の失敗は set -e + pipefail が捕まえるが、インストーラが
  # 0 で終わりながらバイナリを置かない経路はそれをすり抜ける。取り違えると、導入に
  # 失敗しているのに成功として先へ進む。
  if command -v agy >/dev/null 2>&1; then
    echo "[install-ai-tools] agy installed: $(command -v agy)"
  elif [[ -x "$HOME/.local/bin/agy" ]]; then
    echo "[install-ai-tools] agy installed to ~/.local/bin (PATH に無いため現シェルからは見えません)"
  else
    echo "[install-ai-tools] error: インストーラは完了しましたが agy が見つかりません" >&2
    echo "                   ~/.local/bin/agy が存在しません。導入は失敗しています。" >&2
    return 1
  fi
  echo "[install-ai-tools] agy は OAuth のみです。初回は対話で 'agy' を起動してログインしてください。"
}

# agy のテレメトリ（利用統計・クラッシュログ・対話ログの送信）を既定で止める。
#
# 環境変数によるオプトアウトは存在しない（agy 1.1.11 のバイナリを実測。AGY_* は
# 自動更新・描画・認証まわりのみで、テレメトリ系は無い。DO_NOT_TRACK も非対応）。
# したがって設定ファイルへ書く以外の手段が無い。キーは enableTelemetry（既定 true）。
#
# 上書きではなくマージする。このファイルは agy 自身も書き込む（colorScheme /
# trustedWorkspaces 等）ため、丸ごと置き換えると利用者の設定が消える。
#
# 導入の有無に関わらず毎回通す。「導入したときだけ」にすると、先に手で入れた
# 環境や、既存コンテナへ後追いで適用したい場合にオプトアウトが効かない。
AGY_SETTINGS="$HOME/.gemini/antigravity-cli/settings.json"

disable_agy_telemetry() {
  local dir tmp current
  dir="$(dirname "$AGY_SETTINGS")"

  # jq が無い場合に「黙って未適用」で先へ進めない。オプトアウトが効いていない
  # ことに誰も気づけないまま、送信だけが続く状態になる。
  if ! command -v jq >/dev/null 2>&1; then
    echo "[install-ai-tools] error: jq が無いため agy のテレメトリを無効化できません" >&2
    echo "                   jq を導入してから再実行してください: bash scripts/install-ai-tools.sh" >&2
    return 1
  fi

  mkdir -p "$dir"
  if [[ ! -e "$AGY_SETTINGS" ]]; then
    printf '{}\n' > "$AGY_SETTINGS"
    chmod 600 "$AGY_SETTINGS"
  fi

  # 壊れた JSON を黙って {} で置き換えない。利用者の設定を捨てることになる。
  if ! jq -e . "$AGY_SETTINGS" >/dev/null 2>&1; then
    echo "[install-ai-tools] error: JSON として読めないため書き換えを中止しました: $AGY_SETTINGS" >&2
    echo "                   内容を修復するか退避してから再実行してください（オプトアウトは未適用です）" >&2
    return 1
  fi

  # 冪等。既に false なら書き込まない（mtime も動かさない）。
  #
  # `// empty` は使わない。jq の `//` は null だけでなく **false も** 代替側へ
  # 落とすため、既に false のときに「未設定」と区別できず、毎回書き込みが起きる。
  # 値をそのまま出す（未設定なら null が出る）。
  current="$(jq -r '.enableTelemetry' "$AGY_SETTINGS")"
  if [[ "$current" == "false" ]]; then
    echo "[install-ai-tools] agy telemetry already disabled, skipping"
    return 0
  fi

  # 一時ファイルへ書いて mv で差し替える。`jq ... > 同じファイル` はリダイレクトが
  # 先に空へ切り詰めるため、設定が消える。一時ファイルは同じディレクトリに作る
  # （/tmp は別ファイルシステムのことがあり、その場合 mv が原子的にならない）。
  # テンプレートを明示するのは BSD 系の mktemp が必須とするため。
  tmp="$(mktemp "$dir/.settings.json.XXXXXX")"
  # jq が落ちたら一時ファイルを残さない。作成先が設定ディレクトリ直下なので、
  # 失敗のたびに .settings.json.XXXXXX が積み上がり、利用者の設定ディレクトリを
  # 汚し続ける（set -e で即座に抜けるため、後始末の機会もここしかない）。
  if ! jq '.enableTelemetry = false' "$AGY_SETTINGS" > "$tmp"; then
    rm -f "$tmp"
    echo "[install-ai-tools] error: settings.json の書き換えに失敗しました: $AGY_SETTINGS" >&2
    return 1
  fi
  chmod 600 "$tmp"
  mv "$tmp" "$AGY_SETTINGS"
  echo "[install-ai-tools] agy telemetry disabled (enableTelemetry=false)"
}
install_if_missing claude "@anthropic-ai/claude-code"
install_agy_if_missing
disable_agy_telemetry
echo "[install-ai-tools] done"