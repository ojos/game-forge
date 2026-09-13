#!/usr/bin/env bash
# deploy-is-head.sh — 配ろうとしているコミットが、いまも既定ブランチの HEAD かを確かめる（#427）
#
# 使い方:
#   bash scripts/deploy-is-head.sh                      # 手元の HEAD と origin の main を比べる
#   bash scripts/deploy-is-head.sh --remote <名前|URL> --branch <ブランチ> --sha <コミット>
#
# 終了コードと合図（最終行）:
#   0 + DEPLOY_IS_HEAD     = いまも HEAD である。配ってよい
#   0 + DEPLOY_SUPERSEDED  = もう HEAD ではない。**配らない**（新しいコミットの配備に任せる）
#   2                      = 判定できない（HEAD を取れない・引数の誤り）。**配らずに止める**
#
# ── なぜ要るのか ──────────────────────────────────────────────────────────
#
# **2026-09-13、古いコミットの配備が、先に配り終えた新しいコミットの本番を上書きしかけた。**
# #426（ad1da2b）と #425（8241cfc）が 6 秒差でマージされ、`.github/workflows/verify.yml` の
# deploy ジョブは **8241cfc を先に配り終え、そのあと ad1da2b を配り始めた。** likes Worker の
# Durable Objects のマイグレーション（v2）の不一致で偶然止まったので本番は無事だったが、
# 不一致が無ければ **ad1da2b の Pages が #425 を本番から消していた。**
#
# deploy ジョブは `deploy-production` の group で直列になっており、「待機中の古い方は GitHub が
# 取り消すので、最後に残るのは常に最新」と考えていた。**しかし group に入る順はコミットの順では
# なく、前段の verify が終わった順である。** 古いコミットの verify が長引くと、新しいコミットの
# 配備が終わってから group に入り、待機が重ならないので取り消されない。
#
# ── 判定を「配らない」に倒す ────────────────────────────────────────────────
#
# **HEAD でなければ配らず、成功で抜ける。** 新しいコミットの配備は、古いコミットの変更を含む。
# 古い方を配る理由は無く、失敗にすると同時にマージするたびに赤い実行が残り、本当の失敗と
# 見分けにくくなる。
#
# **HEAD を取れないときは「配る」に倒さない。** 判定できないことを「HEAD である」と読むと、
# この関門は外部の不調のたびに黙って外れる（`scripts/orchestrator-bundle-changed.sh` と同じ線）。
#
# **HEAD は手元の作業ツリーではなく、リモートに聞く。** 手元の `origin/main` はチェックアウトした
# 時点の値で、後から入ったマージを知らない。
#
# ── この関門で防げないこと ────────────────────────────────────────────────
#
# - **HEAD のコミットの verify が落ちた・CI を飛ばした場合**、その配備は走らず、古い方も配らない
#   ので、本番は main の HEAD より 2 つ以上前のまま残る。**その不一致は
#   `scripts/acceptance-remote.sh` の配備ずれ検知（#95）が拾う。** 古いコミットを配って HEAD に
#   近づけても、HEAD との不一致は解けない。
# - 判定から配り終えるまでの間に新しいマージが入る場合は、**防がなくてよい。** 新しい配備は
#   同じ group で待ち、この配備の後に走る。
#
# **GNU 拡張を使わない**（利用者の端末は macOS / bash 3.2。docs/handoff.md 3 章）。
set -uo pipefail

REMOTE="origin"
BRANCH="main"
SHA=""

##
# 値を取る引数に、値が付いていることを確かめる。
#
# @param $1 引数の綴り
# @param $2 残りの個数
##
require_value() {
  if [[ "$2" -lt 2 ]]; then
    echo "[deploy-head] $1 には値が要ります。" >&2
    exit 2
  fi
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --remote) require_value "$1" "$#"; REMOTE="$2"; shift 2 ;;
    --branch) require_value "$1" "$#"; BRANCH="$2"; shift 2 ;;
    --sha)    require_value "$1" "$#"; SHA="$2"; shift 2 ;;
    -h|--help) sed -n '2,11p' "${BASH_SOURCE[0]}" >&2; exit 0 ;;
    *) echo "[deploy-head] 不明な引数です: $1" >&2; exit 2 ;;
  esac
done

if [[ -z "$SHA" ]]; then
  # **配る段と同じところから取る。** Pages の段は `git rev-parse HEAD` を記録するので、
  # 比べる値もチェックアウト済みの作業ツリーから取る（verify.yml の Pages の段の注記）。
  if ! SHA="$(git rev-parse HEAD 2>/dev/null)"; then
    echo "[deploy-head] 手元の HEAD を取れません（git の作業ツリーではない）。" >&2
    exit 2
  fi
fi
if [[ ! "$SHA" =~ ^[0-9a-f]{40}$ ]]; then
  echo "[deploy-head] コミットは 40 桁のハッシュで渡してください: ${SHA}" >&2
  exit 2
fi

if ! out="$(git ls-remote --heads "$REMOTE" "refs/heads/${BRANCH}" 2>&1)"; then
  echo "[deploy-head] ${REMOTE} の ${BRANCH} の HEAD を取れません。判定できないので配りません:" >&2
  printf '%s\n' "$out" >&2
  exit 2
fi
HEAD_SHA="$(printf '%s\n' "$out" | awk -v ref="refs/heads/${BRANCH}" '$2 == ref { print $1; exit }')"
if [[ ! "$HEAD_SHA" =~ ^[0-9a-f]{40}$ ]]; then
  echo "[deploy-head] ${REMOTE} に ${BRANCH} が見つかりません。判定できないので配りません。" >&2
  exit 2
fi

echo "[deploy-head] 配ろうとしているコミット: ${SHA}"
echo "[deploy-head] ${REMOTE} の ${BRANCH} の HEAD:   ${HEAD_SHA}"
if [[ "$SHA" == "$HEAD_SHA" ]]; then
  echo "DEPLOY_IS_HEAD"
  exit 0
fi
echo "[deploy-head] もう HEAD ではありません。新しいコミットの配備に任せ、このコミットは配りません。"
echo "DEPLOY_SUPERSEDED"
exit 0
