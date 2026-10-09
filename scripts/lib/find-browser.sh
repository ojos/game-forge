#!/usr/bin/env bash
# lib/find-browser.sh — 実ブラウザの検査が使う Chromium の実行ファイルを、既知の場所から探す（#960）
#
# source して使う:
#   . scripts/lib/find-browser.sh
#   BROWSER_BIN="${GF_BROWSER_BIN:-$(find_browser_bin)}"
#
# **探す場所を 1 か所にまとめる理由。** これまで scripts/lib/dev-fixture.sh は playwright のキャッシュを見て、
# scripts/check-sandbox-browser.sh は見ていなかった。scripts/install-browser.sh（postCreateCommand）が
# headless shell を playwright のキャッシュへ入れるので、片方だけが見つけられる状態を作らない。
#
# 見る順:
#   1. システムの Chromium / Chrome（/usr/bin/…、Mac の Google Chrome）
#   2. playwright のキャッシュ（PLAYWRIGHT_BROWSERS_PATH があればそこ、無ければ ~/.cache/ms-playwright）の
#      headless shell。revision の新しいものから。新しい playwright（1.5x 以降）は
#      chrome-headless-shell-linux64/ か -linux-arm64/ に、古いものは chrome-linux/headless_shell に置く（#957 で実測）
#   3. 同じキャッシュのフルの Chromium（chromium-*/chrome-linux/chrome）
#
# 見つからなければ何も書かずに 1 を返す。落とす（赤にする）かどうかは呼ぶ側が決める。

# 既知の場所から、実行できる Chromium 系の実行ファイルを 1 つ返す。
#
# @return 標準出力に実行ファイルのパス。終了コード 0 = 見つけた / 1 = 見つからない
find_browser_bin() {
  local cache="${PLAYWRIGHT_BROWSERS_PATH:-${HOME}/.cache/ms-playwright}"
  local candidate
  while IFS= read -r candidate; do
    if [[ -n "$candidate" && -x "$candidate" ]]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done < <(
    printf '%s\n' \
      /usr/bin/chromium /usr/bin/chromium-browser /usr/bin/google-chrome \
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
    ls -1d "$cache"/chromium_headless_shell-*/chrome-linux/headless_shell \
      "$cache"/chromium_headless_shell-*/chrome-headless-shell-linux*/chrome-headless-shell \
      "$cache"/chromium-*/chrome-linux/chrome 2>/dev/null | sort -r
  )
  return 1
}
