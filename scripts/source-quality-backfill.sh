#!/usr/bin/env bash
# source-quality-backfill.sh — 生成物の質の指標を既存作品へ埋め戻す（#605 / マイグレーション 0046）
#
# 使い方:
#   bash scripts/source-quality-backfill.sh                    # 手元の D1 の対象を数える（既定。書き込まない）
#   bash scripts/source-quality-backfill.sh --apply            # 手元の D1 へ書く
#   bash scripts/source-quality-backfill.sh --remote           # 本番の対象を数える（読み取りのみ）
#   bash scripts/source-quality-backfill.sh --remote --apply   # 本番へ書く
#   --persist-to <DIR>                                     # 手元の D1 / R2 の置き場所を差し替える
#
# 終了コード:
#   0 = SOURCE_QUALITY_BACKFILL_PASS / 1 = SOURCE_QUALITY_BACKFILL_INCOMPLETE（読めない・測れないソース、形の合わないキーが残った）/ 2 = 前提の不成立
#
# **本体は scripts/source-quality-backfill.mjs にある。** ここは本番の資格情報を環境へ移すだけで、値は
# スクリプトへ持ち込まない（scripts/moderation-prune.sh と同じ形）。読み方と手順は docs/usage-report.md。
#
# **既定は「数えるだけ」である。** `--apply` を付けない限り 1 行も書かない。
#
# **GNU 拡張を使わない**（利用者の端末は macOS / bash 3.2。docs/handoff.md 3 章）。
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)" || exit 2
ROOT="$(dirname "$HERE")"
cd "$ROOT" || exit 2

case " $* " in
  *" -h "*|*" --help "*)
    sed -n '2,18p' "${BASH_SOURCE[0]}" >&2
    exit 0
    ;;
esac

if ! command -v node >/dev/null 2>&1; then
  echo "[source-quality-backfill] node がありません。" >&2
  exit 2
fi

case " $* " in
  *" --remote "*)
    if [[ -z "${CLOUDFLARE_API_TOKEN:-}" && -f "$HERE/load-project-env.sh" ]]; then
      # shellcheck source=scripts/load-project-env.sh
      . "$HERE/load-project-env.sh"
    fi
    ;;
esac

exec node "$HERE/source-quality-backfill.mjs" "$@"
