#!/usr/bin/env bash
# deploy-cleanup.sh — 退会の後続の処理の Worker `game-forge-cleanup` を配る（#518 / #586 / 仕様 3.7）
#
# ## 誰が、いつ叩くか
#
# - **マージ後の配備**: `.github/workflows/verify.yml` の deploy ジョブが、**Pages を配る段の
#   前**に叩く（likes Worker の隣）。同じジョブの段は上から順に走り、どれかが落ちると後ろの段は
#   走らないので、**cleanup Worker が配れなかった日は Pages も配られない**
# - **初回の配備**: 利用者が自分の端末で叩く（手順は `docs/cleanup-worker.md`）。エージェントの
#   実行環境は本番への書き込みを拒否する
#
# ## Pages はこの Worker を指さない（順序の意味が likes とは違う）
#
# **`scripts/deploy-likes.sh` は「Pages が指す先を先に作る」ために順序が要る。** こちらは
# Pages から指されていない（#518 の J3。退会の口は D1 に状態を書くだけで、後続の処理は cron が
# 起こす）ので、**順序そのものに依存は無い。** それでも Pages の前に置くのは、**Worker を配る段を
# 1 か所に集めて、段の読み方を 1 つに保つ**ためである。
#
# **逆に言えば、この Worker が配れなくても Pages は壊れない。** 落ちた日は退会の後続の処理が
# 古い版のまま走り続けるだけで、利用者から見える動きは変わらない。
#
# ## 配る前に、公開の入口が無いことを確かめる
#
# **`scripts/check-cleanup-worker.sh` を先に通す。** acceptance でも回っているが、配る手前で
# もう一度見る。**この Worker は R2 のバケット全体を消せる**ので、開いた入口を本番へ出す経路を
# この 1 本の中で塞ぐ。
#
# ## cron はこのコマンドが登録する
#
# `wrangler deploy` は `workers/cleanup/wrangler.toml` の `[triggers]` を読んで cron を登録する。
# **別の手順は要らない。** 登録されたかを読むコマンドは wrangler に無いので、確かめ方は
# `docs/cleanup-worker.md` にある（ダッシュボード、または Cloudflare の API を読み取りだけで叩く）。
#
# ## 前提
#
# - `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID` が環境にあること（`.env` と GitHub
#   Secrets の同じ 1 本。`docs/pages-deploy.md`）
# - トークンに **Account / Workers Scripts: Edit** があること（`game-forge-likes` を配るために
#   2026-09-11 に足してある。**このスクリプトのために足すものは無い**）
#
# 使い方:
#   set -a; . scripts/load-project-env.sh; set +a   # 手元で叩くとき
#   bash scripts/deploy-cleanup.sh
#
# 終了コード: 0 = 成功 / 非0 = 失敗
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$(dirname "$HERE")"

CONFIG="workers/cleanup/wrangler.toml"

fail() {
  printf '[deploy-cleanup] %s\n' "$1" >&2
  exit 1
}

# **欠けている前提を名指しで言う**（`scripts/deploy-likes.sh` と同じ考え方）。wrangler に任せると、
# 認証の失敗として読み取りにくい形で落ちる。
[[ -n "${CLOUDFLARE_API_TOKEN:-}" ]] || fail "CLOUDFLARE_API_TOKEN がありません（docs/pages-deploy.md「前提: 認証」）。"
[[ -n "${CLOUDFLARE_ACCOUNT_ID:-}" ]] || fail "CLOUDFLARE_ACCOUNT_ID がありません（docs/pages-deploy.md「前提: 認証」）。"
[[ -x node_modules/.bin/wrangler ]] || fail "node_modules/.bin/wrangler がありません。npm ci を実行してください。"

echo "[deploy-cleanup] 公開の入口が無いことを確かめます（scripts/check-cleanup-worker.sh）"
if ! bash scripts/check-cleanup-worker.sh; then
  fail "宣言の検査に通らないので配りません。"
fi

# **件名だけを載せる**（`scripts/deploy-likes.sh` と同じ。本文まで渡すと一覧で 1 行に潰れる）。
commit_hash="$(git rev-parse HEAD)"
commit_subject="$(git log -1 --pretty=format:%s)"

echo "[deploy-cleanup] game-forge-cleanup を配ります（${commit_hash}）"
# `.env` を秘密として読ませない（npm scripts と同じ理由。test/worker.test.ts の冒頭）。
CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV=false node_modules/.bin/wrangler deploy \
  --config "$CONFIG" \
  --tag "${commit_hash:0:12}" \
  --message "$commit_subject"

echo "[deploy-cleanup] 配り終えました（cron は宣言から登録されます）。"
