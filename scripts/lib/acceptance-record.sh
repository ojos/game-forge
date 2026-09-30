#!/usr/bin/env bash
# lib/acceptance-record.sh — 外部層の定期実行の記録（#844）の設定。source して使う。
#
# 書く側（scripts/acceptance-remote-scheduled.sh。利用者の Mac の devcontainer の中）と、
# 読む側（scripts/acceptance-record-freshness.sh。GitHub Actions の定期ジョブ）が、
# **同じこのファイルを読む。** 番号や印の綴りを片方へ書き写すと、投稿はされているのに
# 確認側から見えない状態になる（second-opinion-gate の印と同じ事情）。
#
# **リポジトリの変数（Actions variables）にしなかった理由**: この repo の Actions の変数は
# すべて terraform が宣言している（terraform/main.tf の github_actions_variable）。
# 手で足すと宣言の外の外部状態が 1 つ増える。追跡ファイルなら、書く側も読む側も
# 同じ commit の値を読む（書く側はプライマリが origin/main と一致していることを
# 確かめてから読む）。

# 記録を載せる固定の issue の番号。**空のあいだは、書く側も読む側も失敗する**
# （どこへ書くか・どこを読むかが決まっていないことを、合格にも「記録なし」にもしない）。
# shellcheck disable=SC2034  # source した側が読む（下の 2 つも同じ）
ACCEPTANCE_RECORD_ISSUE=""

# 記録の鮮度の上限（秒）。3 日。系統ごとの「前提が通った最後の記録」にも同じ値を使う。
# shellcheck disable=SC2034
ACCEPTANCE_RECORD_MAX_AGE_SEC=259200

# 記録のコメントの 1 行目。**これと完全に一致する行で始まるコメントだけを記録として読む。**
# 版（v1）を変えるときは、読む側（acceptance-record-judge.sh）も同じ commit で直す。
# shellcheck disable=SC2034
ACCEPTANCE_RECORD_MARKER='<!-- acceptance-remote-record v1 -->'
