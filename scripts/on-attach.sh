#!/usr/bin/env bash
set -euo pipefail
echo "[on-attach] bootstrap active"

# スクリプト自身の位置から解決する（起動時 CWD に依存しない）。scripts/ 直下に
# load-project-env.sh / setup-git-identity.sh が並ぶ。
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HELPER="$HERE/load-project-env.sh"

# このスクリプト自身にもプロジェクト .env を効かせる。
#
# 下の rc 注入は「これから開く対話シェル」にしか効かず、bash で実行される
# on-attach.sh 自身には届かない。読まないと .env のキー（GH_TOKEN 等）が常に
# 空に見え、PAT を設定している利用者を「未認証」と誤認して 'gh auth login' を
# 案内してしまう。ローダーは source 専用・冪等で、.env が無ければ何もしない。
if [[ -f "$HELPER" ]]; then
  # shellcheck source=/dev/null
  . "$HELPER"
fi

# git identity の無害化。VS Code の dev.containers.copyGitConfig がリビルドのたびに
# ホストの ~/.gitconfig をコンテナへコピーし直すため、接続のたびに再適用する。
# 失敗しても on-attach 全体は落とさない。identity が未適用でも、未指定のまま
# コミットしようとすれば git 自身が exit 128 で止めるため、ここで打ち切る理由がない。
# `if ! ...` で捕捉するため setup-git-identity.sh が非ゼロで終了しても on-attach は 0 のまま。
if ! bash "$HERE/setup-git-identity.sh"; then
  echo "[on-attach] WARN: git identity の適用に失敗しました。" >&2
  # CWD に依存しないよう絶対パスで案内する（そのままコピペして実行できる形）。
  echo "[on-attach] WARN: 手動確認: bash $HERE/setup-git-identity.sh --check" >&2
fi

# 対話シェルでプロジェクト .env を自動 override 読み込みするための rc 注入（冪等）。
# これにより、ターミナルから起動する CLI（gemini 等）やスクリプトにも .env の値が効く。
inject_env_autoload() {
  local rc="$1"
  local marker="# >>> project .env autoload >>>"
  # rc が無いベースイメージでも autoload を効かせるため、存在しなければ作成する
  # （touch は既存ファイルを切り詰めない）。zsh 未導入環境で作られても無害（誰も読まない）。
  [[ -f "$rc" ]] || touch "$rc"
  grep -qF "$marker" "$rc" && return 0
  {
    echo ""
    echo "$marker"
    echo "if [[ -f \"$HELPER\" ]]; then . \"$HELPER\"; fi"
    echo "# <<< project .env autoload <<<"
  } >> "$rc"
  echo "[on-attach] injected project .env autoload into $rc"
}
inject_env_autoload "$HOME/.bashrc"
inject_env_autoload "$HOME/.zshrc"

# ホストの Docker 資格情報ヘルパーを打ち消す。
#
# VS Code の dev.containers.dockerCredentialHelper は、接続のたびにコンテナの
# ~/.docker/config.json へ credsStore を書き込む。これが残っていると、コンテナ内の
# docker login/pull がホスト OS のキーチェーンへ問い合わせ、ホスト側の資格情報を
# 黙って使う。remoteEnv を絞ってもこの経路は塞がらないため、接続ごとに打ち消す。
#
# 接続順序の都合で VS Code の書き込みに負ける場合があるため、これは多層防御の 1 枚に
# すぎない。確実に塞ぐにはホスト側で dev.containers.dockerCredentialHelper: false を
# 設定する（README 参照）。
strip_docker_creds_store() {
  local cfg="$HOME/.docker/config.json"
  [[ -f "$cfg" ]] || return 0
  if ! command -v jq >/dev/null 2>&1; then
    echo "[on-attach] WARN: jq が無いため $cfg の credsStore を除去できません。" >&2
    return 0
  fi
  # credsStore / credHelpers のどちらも対象にする。前者はレジストリ横断、後者は
  # レジストリ個別にホストのヘルパーを指す。
  if ! jq -e 'has("credsStore") or has("credHelpers")' "$cfg" >/dev/null 2>&1; then
    return 0
  fi
  local tmp="$cfg.on-attach.tmp"
  if jq 'del(.credsStore, .credHelpers)' "$cfg" > "$tmp" 2>/dev/null && mv "$tmp" "$cfg"; then
    echo "[on-attach] removed credsStore/credHelpers from $cfg"
  else
    rm -f "$tmp"
    echo "[on-attach] WARN: $cfg の credsStore を除去できませんでした。" >&2
  fi
}
strip_docker_creds_store

# gh の認証状態を確認する。
#
# 判定は「いま実際に使われている資格情報が有効か」だけに絞る（--active）。環境変数の
# トークンと hosts.yml の保存済み認証は共存しうるため、--active を付けないと gh は
# 両方を並べて報告し、使っていない側が無効なだけで exit=1 になる。
GH_AUTH_TIMEOUT_SECS=10

# gh が資格情報として読む環境変数のうち、いま効いているものの名前を返す（無ければ空）。
#
# gh は GH_TOKEN → GITHUB_TOKEN の順に読み、空文字は読み飛ばして次へ落ちる
# （gh 2.96.0 で実測。GH_TOKEN= だけなら保存済み認証、GH_TOKEN= かつ
# GITHUB_TOKEN=<値> なら GITHUB_TOKEN が使われる）。空文字を未設定と同じに扱うのは、
# この gh 側の境界へ合わせるため。GITHUB_TOKEN を見落とすと、実際は環境変数で
# 認証しているのに「保存済み認証を使用」と報告し、失敗時には 'gh auth login' を
# 案内してしまう。
gh_active_env_token_var() {
  if [[ -n "${GH_TOKEN:-}" ]]; then
    printf 'GH_TOKEN'
  elif [[ -n "${GITHUB_TOKEN:-}" ]]; then
    printf 'GITHUB_TOKEN'
  fi
}

check_gh_auth() {
  local rc=0 env_var
  env_var="$(gh_active_env_token_var)"

  # 応答が返らないまま接続処理を止め続けない。timeout が無い環境では打ち切れない
  # ため、その場合だけ素で呼ぶ（124 の分岐へは入らなくなる）。
  if command -v timeout >/dev/null 2>&1; then
    timeout "$GH_AUTH_TIMEOUT_SECS" gh auth status --active >/dev/null 2>&1 || rc=$?
  else
    gh auth status --active >/dev/null 2>&1 || rc=$?
  fi

  if [[ "$rc" -eq 0 ]]; then
    if [[ -n "$env_var" ]]; then
      echo "[on-attach] gh auth OK ($env_var の値を使用)"
    else
      echo "[on-attach] gh auth OK (コンテナ内の保存済み認証を使用)"
    fi
    # GITHUB_TOKEN は供給元として想定していない。設定されていると、保存済み認証も
    # .env の GH_TOKEN も黙って上書きされる。動いているうちに知らせる。
    if [[ "$env_var" == "GITHUB_TOKEN" ]]; then
      echo "[on-attach] WARN: GITHUB_TOKEN が保存済み認証より優先されています。恒久的に設定しないでください（空にすれば GH_TOKEN か保存済み認証へ戻ります）。" >&2
    fi
    return 0
  fi

  # ここで「到達できない」とも「認証が無効」とも断定しない。
  #
  # gh の出力では両者を区別できないことを実測している。プロキシ経由でしか外へ出られ
  # ない状態を作って `gh auth status --active` を走らせると、到達できていないだけでも
  # "The token in GH_TOKEN is invalid." と言う。
  #
  # 到達性を自前で測る案（bash の /dev/tcp で 443 へ直接つなぐ）は採らなかった。測れる
  # のは直接経路だけで、gh が使うのはプロキシ経路である。プロキシ経由でしか外へ出られ
  # ない環境では直接接続が塞がれ、gh は疎通しているのに「到達できません」と誤判定する。
  # 逆に直接は開いていてプロキシ設定だけが壊れている環境では、「到達できています」と
  # 誤判定して無効な断定を返す。配布物は網構成を知り得ないため、断定できないものを
  # 断定しない側へ寄せる。
  #
  # 打ち切り（timeout の exit 124）だけは観測できた事実なので、分けて報告する。
  if [[ "$rc" -eq 124 ]]; then
    echo "[on-attach] WARN: gh の認証確認が ${GH_AUTH_TIMEOUT_SECS} 秒で完了しませんでした。認証は判定していません（ネットワークへ到達できていない可能性があります）。" >&2
  else
    echo "[on-attach] WARN: gh の認証を確認できませんでした。認証は判定していません（資格情報が無効か、GitHub へ到達できていない可能性があります）。" >&2
  fi

  if [[ -n "$env_var" ]]; then
    # 環境変数で認証しているあいだは 'gh auth login' を案内しない。
    #
    # gh 2.96.0 で実測: 値が設定されているあいだ、gh はログインを拒否する
    # （--with-token / --web のいずれでも "The value of the <VAR> environment
    # variable is being used for authentication." で終了し、通信もしない）。
    # 危ないのはその先で、拒否メッセージ（"first clear the value from the
    # environment"）に従って値を空にしてログインすると、OAuth トークンの上限枠を
    # 1 つ消費する。上限に達していれば GitHub が既存のトークンを 1 本破棄する
    # （理由コード max_for_app）。ここで案内すると、その手順へ誘導することになる。
    echo "[on-attach] WARN: $env_var が設定されています。gh はこの値を保存済み認証より優先します。'gh auth login' は実行しないでください（gh 自身も値が設定されているあいだはログインを拒否します）。値を空にしてログインすると OAuth トークンの上限枠を 1 つ消費し、上限に達していれば他環境の認証が 1 本失効します。" >&2
    echo "[on-attach] WARN: $env_var の値（有効期限・権限・値の取り違え）と、ネットワークへ出られるかを確認してください。" >&2
  else
    echo "[on-attach] WARN: 未認証であれば、コンテナ内で 'gh auth login' を実行してください。ホストのトークンは注入されません。" >&2
  fi
}

if command -v gh >/dev/null 2>&1; then
  check_gh_auth
fi