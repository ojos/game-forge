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

# 記録を載せる固定の issue の番号（#854。2026-10-01 に作成・ロック済み）。**空にすると、書く側も
# 読む側も失敗する**（どこへ書くか・どこを読むかが決まっていないことを、合格にも「記録なし」にもしない）。
# shellcheck disable=SC2034  # source した側が読む（下の 2 つも同じ）
ACCEPTANCE_RECORD_ISSUE="854"

# 記録の鮮度の上限（秒）。3 日。系統ごとの「前提が通った最後の記録」にも同じ値を使う。
# shellcheck disable=SC2034
ACCEPTANCE_RECORD_MAX_AGE_SEC=259200

# 定期実行（と --pr）で、AWS_PROFILE が空のときに入れる本番のプロファイル名（#844）。
#
# **本番の AWS は環境変数 AWS_PROFILE で選ぶ設計である**（terraform/providers.tf の注記。開発の側だけ
# 宣言の profile を使う）。手で外部層を回すときは端末で export してから回すが、launchd から docker exec
# で入る login シェルには何も設定されていない。2026-10-01 の 1 回目の記録（#854）は、これで
# aws の前提と、それに依存する 14 件が「前提の不成立」になった。
#
# **.env に置かない理由**: .env を読むすべてのスクリプトで aws の既定が本番になる。いまは明示しない限り
# どのアカウントも選ばれない（安全側）形なので、それを崩さず、この入口だけで補う。
# profile は資格情報ではなく選択子で、実体は ~/.aws/config と SSO のキャッシュにある（秘密は入らない）。
# shellcheck disable=SC2034
ACCEPTANCE_AWS_PROFILE="game-forge-prod"

# 記録のコメントの 1 行目。**これと完全に一致する行で始まるコメントだけを記録として読む。**
# 版（v1）を変えるときは、読む側（acceptance-record-judge.sh）も同じ commit で直す。
# shellcheck disable=SC2034
ACCEPTANCE_RECORD_MARKER='<!-- acceptance-remote-record v1 -->'
