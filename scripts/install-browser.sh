#!/usr/bin/env bash
# install-browser.sh — devcontainer へ Chromium（headless shell）と、その依存のシステムのパッケージ
# （日本語のフォントを含む）を、playwright-core の版を固定して入れる（#960）
#
# 使い方: bash scripts/install-browser.sh [--check]
#   devcontainer の postCreateCommand から呼ぶ。手で打ってもよい（入っていれば何もしない）。
#   --check: 何も入れずに、入っているかだけを確かめる（終了コード 0 = 入っている / 1 = 足りない）。
#
# **なぜ要るのか。** 次の 3 つが Chromium の実行ファイルを使い、運営報告の画像の段は日本語のフォントも使う。
# どちらも devcontainer を作り直すと消えるので、作り直しのたびに手で入れ直していた。
#   - scripts/ops-report-draft.sh の画像の段（#957。フォントが無いと図が豆腐（□）になる）
#   - scripts/check-page-width.sh・scripts/shoot-pages.sh（scripts/lib/dev-fixture.sh 経由）
#   - scripts/check-sandbox-browser.sh
# 見つけ方は scripts/lib/find-browser.sh。playwright のキャッシュ（~/.cache/ms-playwright/）を見るので、
# ここで入れたものを GF_BROWSER_BIN なしで使う。
#
# **版を固定する理由。** `npx playwright install` は、その日の最新の playwright-core が決めるブラウザを入れるので、
# 作り直すたびに違う版が入り、公開から日の浅い版も入りうる。ここでは**公開から 2 週間以上たった版**を選び、
# npm の tarball のチェックサムを書いておき、合わなければ使わない（#956 の install-uv.sh と同じ形）。
#   1.63.0: 2026-09-04 公開。headless shell の revision は 1243（tarball の browsers.json）。
#           tarball の sha512 が npm の dist.integrity と一致することを 2026-10-09 に確かめ、その sha256 を下に書いた。
#           tarball はアーキテクチャによらず 1 つ。headless shell は playwright が Mac（aarch64）と
#           dev01（x86_64）それぞれの版を取る（chrome-headless-shell-linux-arm64/ と -linux64/）。
#
# **playwright-core を package.json の依存に足さない理由。** アプリの依存（npm ci が CI と配備で入れるもの）と
# 開発の道具を分けるため。足すと verify.yml と deploy.yml の npm ci が要らない 3 MB を毎回取り、
# 版を上げる Dependabot の PR が、作り直しで入る版と食い違う。ここでは tarball を一時ディレクトリに展開して
# cli.js を直接動かす（依存は持たない）。展開したものは ~/.cache/game-forge/ に残す（理由は下の展開の箇所）。
#
# **sudo で入れるのは install-deps が挙げるパッケージだけ**（#960 の constraints）。日本語のフォント
# （fonts-ipafont-gothic・fonts-wqy-zenhei・fonts-unifont）も install-deps の一覧に入っている。
# 足りないかは `install-deps --dry-run`（apt の simulate。sudo 不要）で確かめ、足りないときだけ sudo を使う。
#
# 版を上げるときは、PW_VERSION・PW_TARBALL_SHA256・HEADLESS_SHELL_REVISION を同じコミットで直す
# （revision は tarball の browsers.json の chromium-headless-shell の値。食い違うと入れずに落ちる）。
# scripts/post-rebuild-check.sh はこのファイルの --check を呼ぶので、そちらは直さなくてよい。
#
# 置き場所は playwright の既定（PLAYWRIGHT_BROWSERS_PATH が無ければ ~/.cache/ms-playwright）。
# ~/.cache は volume ではないので、作り直すと消え、postCreateCommand がまた入れる。
#
# 終了コード: 0 = 入った（または既に入っている）/ 1 = 入れられない（取得の失敗・チェックサムの不一致・
#             revision の食い違い・sudo が使えない・入れた後も確かめが通らない）/ 2 = 引数の誤り
set -euo pipefail

readonly PW_VERSION="1.63.0"
readonly PW_TARBALL_SHA256="208593d4e1bcd8f8fe5f869cad1cc332dc7f1d70dc1d58c102dc3ac36e30f26c"
readonly HEADLESS_SHELL_REVISION="1243"
readonly PREFIX="[install-browser]"
readonly BROWSERS_DIR="${PLAYWRIGHT_BROWSERS_PATH:-${HOME}/.cache/ms-playwright}"
readonly PKG_DIR="${HOME}/.cache/game-forge/playwright-core-${PW_VERSION}"

check_only=0
case "${1:-}" in
  "") ;;
  --check) check_only=1 ;;
  *)
    echo "$PREFIX usage: bash scripts/install-browser.sh [--check]" >&2
    exit 2
    ;;
esac

# 固定した revision の headless shell の実行ファイルを返す（無ければ空）。
# 置き場所の名前は arm64 が chrome-headless-shell-linux-arm64/、x86_64 が chrome-headless-shell-linux64/。
#
# @return 標準出力に実行ファイルのパス
headless_shell_bin() {
  local candidate
  for candidate in "$BROWSERS_DIR/chromium_headless_shell-${HEADLESS_SHELL_REVISION}"/chrome-headless-shell-linux*/chrome-headless-shell; do
    if [[ -x "$candidate" ]]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done
}

# headless shell が動くか（共有ライブラリが揃っているか）を、--version を実際に走らせて確かめる。
#
# @return 0 = 動く / 1 = 無いか動かない
headless_shell_runs() {
  local bin
  bin="$(headless_shell_bin)"
  [[ -n "$bin" ]] && "$bin" --version >/dev/null 2>&1
}

# 日本語のフォントの名前を 1 つ返す（fontconfig が日本語を描けると答えるもの。無ければ空）。
# fc-list の出力を head へつながない（pipefail の下で早く閉じると fc-list の失敗に見えるため）。
#
# @return 標準出力にフォントの名前
japanese_font_name() {
  local fonts
  fonts="$(fc-list :lang=ja family 2>/dev/null || true)"
  printf '%s' "${fonts%%$'\n'*}"
}

# 入っているかを 2 行で書き、両方そろっていれば 0 を返す。
#
# @return 0 = 入っている / 1 = 足りない
report_state() {
  local ok=0 bin font
  bin="$(headless_shell_bin)"
  if headless_shell_runs; then
    echo "$PREFIX headless shell OK (playwright-core ${PW_VERSION} / revision ${HEADLESS_SHELL_REVISION}: $bin)"
  elif [[ -n "$bin" ]]; then
    echo "$PREFIX headless shell present but does not run (missing system libraries?): $bin"
    ok=1
  else
    echo "$PREFIX headless shell missing (revision ${HEADLESS_SHELL_REVISION} under $BROWSERS_DIR)"
    ok=1
  fi
  font="$(japanese_font_name)"
  if [[ -n "$font" ]]; then
    echo "$PREFIX japanese font OK ($font)"
  else
    echo "$PREFIX japanese font missing (fc-list :lang=ja is empty)"
    ok=1
  fi
  return "$ok"
}

if [[ "$check_only" == "1" ]]; then
  report_state
  exit $?
fi

if report_state >/dev/null; then
  echo "$PREFIX headless shell (revision ${HEADLESS_SHELL_REVISION}) and a japanese font are already installed, skipping"
  exit 0
fi

command -v node >/dev/null 2>&1 || { echo "$PREFIX error: node が見つかりません" >&2; exit 1; }

work="$(mktemp -d "${TMPDIR:-/tmp}/install-browser.XXXXXX")"
trap 'rm -rf -- "$work"' EXIT

url="https://registry.npmjs.org/playwright-core/-/playwright-core-${PW_VERSION}.tgz"
echo "$PREFIX fetching playwright-core ${PW_VERSION} ..."
if ! curl -fsSL --retry 3 -o "$work/playwright-core.tgz" "$url"; then
  echo "$PREFIX error: 取得できません: ${url}" >&2
  exit 1
fi
got="$(openssl dgst -sha256 -r "$work/playwright-core.tgz" | awk '{ print $1 }')"
if [[ "$got" != "$PW_TARBALL_SHA256" ]]; then
  echo "$PREFIX error: チェックサムが合いません（期待 ${PW_TARBALL_SHA256} / 実際 ${got}）。使いません" >&2
  exit 1
fi
tar -xzf "$work/playwright-core.tgz" -C "$work"
# 展開した playwright-core は消さずに置いておく。playwright は入れたブラウザを、入れた playwright-core の場所への
# 参照（$BROWSERS_DIR/.links）で数え、別の版の `playwright install` が走ると、参照先が消えたブラウザを片付ける。
# 一時ディレクトリから入れると、後で誰かが別の版を入れた日に headless shell が黙って消える。
mkdir -p "$(dirname "$PKG_DIR")"
rm -rf -- "$PKG_DIR"
mv "$work/package" "$PKG_DIR"
cli="$PKG_DIR/cli.js"

# 書いておいた revision と、tarball の browsers.json の値が同じかを確かめる（版だけ上げて revision を直し忘れると、
# 入れたのに --check が「無い」と言い続けるため）。
listed="$(node -e '
  const b = require(process.argv[1]).browsers.find((x) => x.name === "chromium-headless-shell");
  process.stdout.write(b ? String(b.revision) : "");
' "$PKG_DIR/browsers.json")"
if [[ "$listed" != "$HEADLESS_SHELL_REVISION" ]]; then
  echo "$PREFIX error: playwright-core ${PW_VERSION} の headless shell は revision ${listed:-（不明）} です（このファイルは ${HEADLESS_SHELL_REVISION}）。HEADLESS_SHELL_REVISION を直してください" >&2
  exit 1
fi

if [[ -z "$(headless_shell_bin)" ]]; then
  echo "$PREFIX downloading chromium-headless-shell (revision ${HEADLESS_SHELL_REVISION}) into $BROWSERS_DIR ..."
  # --no-remove: ほかの版の playwright が入れたブラウザ（手で入れたものを含む）を片付けない。
  node "$cli" install --no-remove chromium-headless-shell
fi

# システムのパッケージは、足りないときだけ sudo で入れる（--dry-run は sudo なしで apt の simulate を回す）。
if ! node "$cli" install-deps --dry-run chromium-headless-shell >/dev/null 2>&1; then
  if ! sudo -n true 2>/dev/null; then
    echo "$PREFIX error: システムのパッケージが足りませんが、sudo をパスワードなしで使えません。次を手で打ってください:" >&2
    echo "$PREFIX   sudo env \"PATH=\$PATH\" node $cli install-deps chromium-headless-shell" >&2
    exit 1
  fi
  echo "$PREFIX installing system packages listed by playwright install-deps (includes japanese fonts) ..."
  sudo -n env "PATH=$PATH" DEBIAN_FRONTEND=noninteractive node "$cli" install-deps chromium-headless-shell
fi

if ! report_state; then
  echo "$PREFIX error: 入れた後も確かめが通りません（上の行）" >&2
  exit 1
fi
echo "$PREFIX installed"
