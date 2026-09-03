#!/usr/bin/env bash
# check-migrations-applied.sh — 未適用のマイグレーションが無いことを見る（#275）
#
# ## なぜ要るのか
#
# **2026-09-03 に、これが無くて本番を約 10 分壊した。** #39 をマージしたとき
# `migrations apply --remote` を実行せず、`insertPendingGame` が `ip_notice` を
# INSERT に含めるのに本番の `games` にその列が無い状態で Worker が出た。
# **ログイン済み利用者の生成・フォーク・推敲がすべて失敗する状態**だった。
#
# **実害 0 件は偶然である**——窓の間に生成が 1 件も無かっただけで、手順で防げたものでは
# ない。`docs/handoff.md` は「入れたら `migrations apply` を忘れないこと」と既に警告して
# いた。**呼びかけでは止まらなかった。**
#
# ## 機構の非対称を埋める
#
# | ずれ | 止めるもの |
# |---|---|
# | オーケストレータの束 と Worker | #241 / #263 の関門 |
# | **マイグレーション と Worker** | **これ** |
#
# 使い方:
#   bash scripts/check-migrations-applied.sh --remote          # 本番（読み取りのみ）
#   bash scripts/check-migrations-applied.sh                   # 手元の D1（既定）
#   bash scripts/check-migrations-applied.sh --persist-to <dir> # 使い捨ての手元 D1
#
# 終了コード:
#   0 = MIGRATIONS_APPLIED（未適用は無い）
#   1 = MIGRATIONS_PENDING（有る。名前と実行すべきコマンドを出す）
#   2 = 判定できなかった（未認証・道具が無い・出力の形が変わった）
#
# **1 と 2 を分ける。** 「未適用が有った」と「調べられなかった」は別である。混ぜると、
# 認証が切れているだけの日に「未適用が有る」と読むことになる
# （`scripts/ogp-stale-report.sh` と `scripts/build-time-report.sh` が同じ線を引いている）。
#
# ## 「判定できなかった」を「無い」に倒さない
#
# **`wrangler` はどちらの場合も終了コード 0 を返す**（実測。2026-09-03）。したがって
# 出力を読むしかないが、**「未適用の表が無ければ適用済み」と読んではいけない。**
# 出力の綴りが変わった日に、関門が黙って外れる。**両方の合図を明示的に探し、
# どちらも出ていなければ落とす**（#263 の関門が採っているのと同じ規律）。
#
# ## 本番へは読み取りしか送らない
#
# `migrations list` は台帳を読むだけである。**適用はここではしない**——本番のスキーマ
# 変更は利用者の端末に留める（`docs/handoff.md`）。**手順を自動化しない**という判断で
# あり、関門はそれを崩さない。
#
# **GNU 拡張を使わない**（利用者の端末は macOS / bash 3.2。docs/handoff.md 3 章）。
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)" || exit 2
ROOT="$(dirname "$HERE")"
cd "$ROOT" || exit 2

SCOPE="--local"
PERSIST_TO=""

##
# 値を取る引数に、値が付いていることを確かめる。**無ければ落とす。**
#
# `shift 2` は残りが 1 個のときシフトせずに失敗し、`set -e` を使っていないので
# 無限ループになる（#42 の PR で 3 本に同じ形があった）。
#
# @param $1 引数の綴り
# @param $2 残りの個数
##
require_value() {
  if [[ "$2" -lt 2 ]]; then
    echo "[migrations] $1 には値が要ります。" >&2
    exit 2
  fi
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --remote)     SCOPE="--remote"; shift ;;
    --local)      SCOPE="--local"; shift ;;
    --persist-to) require_value "$1" "$#"; PERSIST_TO="$2"; shift 2 ;;
    -h|--help)    sed -n '2,30p' "${BASH_SOURCE[0]}" >&2; exit 0 ;;
    *) echo "[migrations] 不明な引数です: $1" >&2; exit 2 ;;
  esac
done

if [[ -n "$PERSIST_TO" && "$SCOPE" == "--remote" ]]; then
  echo "[migrations] --persist-to は手元の D1 専用です（--remote とは併用できません）。" >&2
  exit 2
fi

args=(d1 migrations list DB)
if [[ "$SCOPE" == "--remote" ]]; then
  # 本番の D1 は [env.production] 側にしか宣言が無い（scripts/usage-report.sh と同じ）。
  args+=(--remote --env production)
  if [[ -z "${CLOUDFLARE_API_TOKEN:-}" && -f "$HERE/load-project-env.sh" ]]; then
    # shellcheck source=scripts/load-project-env.sh
    . "$HERE/load-project-env.sh"
  fi
else
  args+=(--local)
  if [[ -n "$PERSIST_TO" ]]; then
    args+=(--persist-to "$PERSIST_TO")
  fi
fi

if ! out="$(CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV=false npx wrangler "${args[@]}" 2>&1)"; then
  echo "[migrations] 一覧を取れませんでした（${SCOPE}）:" >&2
  printf '%s\n' "$out" >&2
  exit 2
fi

# ── 2 つの合図を明示的に探す ────────────────────────────────────────────────
#
# **片方の不在をもう片方の根拠にしない**（冒頭の但し書き）。
NONE_MARK='No migrations to apply'
PENDING_MARK='Migrations to be applied'

has_none=0
has_pending=0
printf '%s\n' "$out" | grep -qF "$NONE_MARK" && has_none=1
printf '%s\n' "$out" | grep -qF "$PENDING_MARK" && has_pending=1

if [[ "$has_none" -eq 1 && "$has_pending" -eq 1 ]]; then
  echo "[migrations] 出力に両方の合図が出ています（形が変わった可能性があります）:" >&2
  printf '%s\n' "$out" >&2
  exit 2
fi

if [[ "$has_none" -eq 1 ]]; then
  echo "[migrations] 未適用はありません（${SCOPE}）。"
  echo "MIGRATIONS_APPLIED"
  exit 0
fi

if [[ "$has_pending" -eq 0 ]]; then
  echo "[migrations] どちらの合図も出ていません（wrangler の出力の形が変わった可能性があります）:" >&2
  printf '%s\n' "$out" >&2
  exit 2
fi

# 表の行から名前を拾う。**拾えなければ落とす**——「有るのに 0 件」を出すと、
# 呼ぶ側が「無い」と読む。
pending="$(printf '%s\n' "$out" | sed -n 's/^[^0-9a-zA-Z]*\([0-9][0-9]*_[A-Za-z0-9_]*\.sql\).*$/\1/p')"
if [[ -z "$pending" ]]; then
  echo "[migrations] 未適用が有ると出ていますが、名前を拾えませんでした:" >&2
  printf '%s\n' "$out" >&2
  exit 2
fi

count="$(printf '%s\n' "$pending" | grep -c .)"
echo "[migrations] 未適用が ${count} 件あります（${SCOPE}）:" >&2
printf '%s\n' "$pending" | while IFS= read -r name; do
  echo "  - ${name}" >&2
done
echo >&2
echo "  先に次を実行してください（本番のスキーマ変更は利用者の端末から叩きます）:" >&2
echo "    set -a; source scripts/load-project-env.sh; set +a" >&2
echo "    npx wrangler d1 migrations apply DB --remote --env production" >&2
echo "MIGRATIONS_PENDING"
exit 1
