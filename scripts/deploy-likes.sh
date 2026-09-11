#!/usr/bin/env bash
# deploy-likes.sh — いいねの Worker `game-forge-likes` を配る（#339 / 仕様 5.8）
#
# ## 誰が、いつ叩くか
#
# - **マージ後の配備**: `.github/workflows/verify.yml` の deploy ジョブが、**Pages を配る段の
#   直前**に叩く。同じジョブの段は上から順に走り、どれかが落ちると後ろの段は走らないので、
#   **likes Worker が配れなかった日は Pages も配られない。** これが「DO の Worker を Pages
#   より先に配る」（5.8）の機構である
# - **初回の配備**: 利用者が自分の端末で叩く（手順は docs/likes.md）。エージェントの実行環境は
#   本番への書き込みを拒否する
#
# ## なぜ Pages より先なのか
#
# **Pages の宣言（ルートの wrangler.toml）は `script_name = "game-forge-likes"` を指す。**
# 指す先のスクリプトが無いまま Pages を配ると、いいねの口が binding を解決できない。
# 逆向き（likes Worker だけ新しい）は害が無い——likes Worker は Pages を呼ばない。
#
# ## 配る前に、公開の入口が無いことを確かめる
#
# **`scripts/check-likes-worker.sh` を先に通す。** acceptance でも回っているが、配る手前で
# もう一度見る。**入口が開いた宣言を本番へ出す経路を、この 1 本の中で塞ぐ**
# （`LikeHub` は受け取った利用者 id を信じるので、開いた入口は id の偽装口になる）。
#
# ## 前提
#
# - `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID` が環境にあること（`.env` と GitHub
#   Secrets の同じ 1 本。docs/pages-deploy.md）
# - トークンに **Account / Workers Scripts: Edit** があること（Pages の配備だけなら要らない。
#   #339 で増えた権限。docs/likes.md）
#
# 使い方:
#   set -a; . scripts/load-project-env.sh; set +a   # 手元で叩くとき
#   bash scripts/deploy-likes.sh
#
# 終了コード: 0 = 成功 / 非0 = 失敗
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$(dirname "$HERE")"

CONFIG="workers/likes/wrangler.toml"

fail() {
  printf '[deploy-likes] %s\n' "$1" >&2
  exit 1
}

# **欠けている前提を名指しで言う**（scripts/deploy-orchestrator.sh の #243 と同じ考え方）。
# wrangler に任せると、認証の失敗として読み取りにくい形で落ちる。
[[ -n "${CLOUDFLARE_API_TOKEN:-}" ]] || fail "CLOUDFLARE_API_TOKEN がありません（docs/pages-deploy.md「前提: 認証」）。"
[[ -n "${CLOUDFLARE_ACCOUNT_ID:-}" ]] || fail "CLOUDFLARE_ACCOUNT_ID がありません（docs/pages-deploy.md「前提: 認証」）。"
[[ -x node_modules/.bin/wrangler ]] || fail "node_modules/.bin/wrangler がありません。npm ci を実行してください。"

echo "[deploy-likes] 公開の入口が無いことを確かめます（scripts/check-likes-worker.sh）"
if ! bash scripts/check-likes-worker.sh; then
  fail "宣言の検査に通らないので配りません。"
fi

# **件名だけを載せる**（`.github/workflows/verify.yml` の Pages の段と同じ。本文まで渡すと
# 一覧で 1 行に潰れる）。どのコミットを配ったかを Cloudflare 側から辿れるようにする。
commit_hash="$(git rev-parse HEAD)"
commit_subject="$(git log -1 --pretty=format:%s)"

echo "[deploy-likes] game-forge-likes を配ります（${commit_hash}）"
# `.env` を秘密として読ませない（npm scripts と同じ理由。test/worker.test.ts の冒頭）。
CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV=false node_modules/.bin/wrangler deploy \
  --config "$CONFIG" \
  --tag "${commit_hash:0:12}" \
  --message "$commit_subject"

echo "[deploy-likes] 配り終えました。"
