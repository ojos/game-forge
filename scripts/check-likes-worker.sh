#!/usr/bin/env bash
# check-likes-worker.sh — いいねの Worker `game-forge-likes` に公開の入口が無いことと、
# Pages との結線が揃っていることを、宣言から機械で確かめる（#339 / 仕様 5.8）。
#
# ## なぜ要るのか
#
# **`LikeHub`（workers/likes/src/hub.ts）は、受け取った利用者 id を信じる。** それを
# 渡せるのはセッションを確かめた Pages（src/likes.ts）だけでなければならない。
# `game-forge-likes` に公開の入口を 1 本でも足すと、セッションを持たない呼び出し元が
# id を偽装していいねを付けられる（仕様 5.8）。
#
# **入口は宣言 1 行で開く。** `workers_dev` を消す（既定は true）、`route` を足す、
# 環境を足してそちらで `workers_dev = true` にする——どれも差分としては小さく、
# テストは緑のまま通る（テストは本番の公開状態を見ない）。**だから宣言を機械で見る。**
#
# ## 見るもの
#
# 1. **公開の入口が無い**（workers/likes/wrangler.toml）
#    - `workers_dev = false` を**明示している**（既定は true なので、省略は開いているのと同じ）
#    - `preview_urls = false` を**明示している**（既定は workers_dev に従うが、既定に頼らない）
#    - `route` / `routes` を持たない（カスタムドメインも `routes` の中に書く）
#    - `env` を持たない（環境ごとに上の 3 つを上書きできるため、環境そのものを置かせない）
# 2. **SQLite 版で作る**（`new_sqlite_classes` に LikeHub と PlayHub がある。`new_classes` に無い）
#    ——Workers Free で使えるのは SQLite 版だけで、一度作ると保存形式を変えられない
# 3. **Pages との結線が揃っている**（ルートの wrangler.toml）
#    - トップレベル・`env.production`・`env.preview` のすべてに `LIKE_HUB` と `PLAY_HUB`（#377）があり、
#      `class_name` と `script_name` が likes Worker の宣言と一致する
#      （durable_objects は環境へ引き継がれないので、1 か所でも欠けると本番から消える）
#    - likes Worker の D1（同期の書き込み先）が、Pages の本番 D1 と同じ `database_id`
#      （片方だけ書き換えると、同期が別のデータベースへ書く）
#    - likes Worker の `preview_database_id`（`wrangler dev` だけが使う）が、Pages のローカル D1
#      （トップレベルの `database_id`）と同じ（ずれるとローカルの同期が空の D1 へ書く。実測済み）
# 4. **`env.LIKE_HUB` を読むのは src/likes.ts だけ、`env.PLAY_HUB` を読むのは src/plays.ts だけ**
#    （窓口を 1 つにする。5.8 / #377）
# 5. **配る順序**: `.github/workflows/verify.yml` の deploy ジョブで、likes Worker を配る段が
#    Pages を配る段より前にある（5.8。Pages が存在しない DO を指さないように）
# 6. **likes Worker が束ねられる**（`wrangler deploy --dry-run`。資格情報もネットワークも
#    要らない）。配備の段で初めて落ちる形にしない
# 7. **機械が読める口の上限の結線が揃っている**（#699 / 仕様 5.13）
#    - likes Worker に `[[ratelimits]]` の `API_RATE_LIMIT` があり、値が 60 秒あたり 60 回
#      （`src/api-rate-limit.ts` の `API_RATE_LIMIT` と一致する）
#    - ルートの wrangler.toml のトップレベル・`env.production`・`env.preview` のすべてに Service binding
#      `API_RATE_LIMITER` があり、`service` が likes Worker の name、`entrypoint` が `ApiRateLimiter`
#      （services も環境へ引き継がれない）
#    - 束ねた likes Worker が `ApiRateLimiter` を輸出している（入口の無い版を配らない）
#    - `env.API_RATE_LIMITER` を読むのは src/api-rate-limit.ts だけ
#
# ## 読み方
#
# **TOML は wrangler 自身の読み取り器で読む**（`experimental_readRawConfig`）。正規表現で
# 読むと、表の書き方（インラインテーブル・引用符付きのキー）で見落とす。**既定値で
# 埋めない生の値**を読むので、「省略」と「false の明示」を区別できる。
#
# ## この検査が約束しないこと
#
# - **本番の Worker が実際に公開されていないこと**は見ない（宣言だけを見る）。
#   ダッシュボードで手で workers.dev を有効にした場合は捕まらない。本番の確かめ方は
#   docs/likes.md にある
# - Service binding など、**他の Worker から `game-forge-likes` を呼ぶ結線**は、公開の入口としては
#   見ない（同じアカウントの中からしか届かないため）。7 で見るのは Pages からの上限の結線が揃っていることである
#
# 使い方:
#   bash scripts/check-likes-worker.sh
#
# 終了コード: 0 = LIKES_WORKER_PASS / 1 = LIKES_WORKER_FAIL
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$(dirname "$HERE")"

LIKES_CONFIG="workers/likes/wrangler.toml"
PAGES_CONFIG="wrangler.toml"
# 束縛の名前と、それを読んでよい唯一のファイル（窓口）の組。**プレイ数（#377）は同じ Worker の
# 別クラスなので、同じ検査を同じ形で当てる。**
#
# **連想配列を使わない。** macOS の `/bin/bash`（3.2）には `declare -A` が無く、利用者が
# `scripts/deploy-likes.sh` から叩くこの検査が起動の時点で落ちる。対応は `case` で引く。
BINDINGS="LIKE_HUB PLAY_HUB"

# 束縛の名前から、それを読んでよい唯一のファイルを返す。
#
# 引数: $1 = 束縛の名前
# 出力: 窓口のファイルのパス（知らない名前なら何も出さずに 1 を返す）
window_of() {
  case "$1" in
    LIKE_HUB) echo "src/likes.ts" ;;
    PLAY_HUB) echo "src/plays.ts" ;;
    *) return 1 ;;
  esac
}

fail() {
  printf '[likes-worker] %s\n' "$1" >&2
  echo "LIKES_WORKER_FAIL"
  exit 1
}

[[ -f "$LIKES_CONFIG" ]] || fail "$LIKES_CONFIG がありません。"
[[ -f "$PAGES_CONFIG" ]] || fail "$PAGES_CONFIG がありません。"
for binding in $BINDINGS; do
  window="$(window_of "$binding")" || fail "$binding の窓口が決まっていません（window_of に足すこと）。"
  [[ -f "$window" ]] || fail "$window がありません。"
done
command -v node >/dev/null 2>&1 || fail "node が見つかりません。Node.js を導入してください。"
[[ -d node_modules/wrangler ]] || fail "node_modules/wrangler がありません。npm ci を実行してください。"

# 機械が読める口の上限（#699）。束縛の名前・入口の名前と、値の正本の写し（src/api-rate-limit.ts）。
RATE_LIMIT_BINDING="API_RATE_LIMIT"
RATE_LIMITER_SERVICE="API_RATE_LIMITER"
RATE_LIMITER_ENTRYPOINT="ApiRateLimiter"
RATE_LIMITER_WINDOW="src/api-rate-limit.ts"
[[ -f "$RATE_LIMITER_WINDOW" ]] || fail "$RATE_LIMITER_WINDOW がありません。"
# `export const API_RATE_LIMIT = { limit: 60, periodSeconds: 60 } as const;` の 1 行から値を読む。
rate_limit_line="$(grep -E '^export const API_RATE_LIMIT = \{ limit: [0-9]+, periodSeconds: [0-9]+ \}' "$RATE_LIMITER_WINDOW" || true)"
[[ -n "$rate_limit_line" ]] || fail "$RATE_LIMITER_WINDOW に API_RATE_LIMIT の値の行が見つかりません（検査が成立しません）。"
rate_limit_limit="$(printf '%s\n' "$rate_limit_line" | sed -E 's/.*limit: ([0-9]+),.*/\1/')"
rate_limit_period="$(printf '%s\n' "$rate_limit_line" | sed -E 's/.*periodSeconds: ([0-9]+) .*/\1/')"

# ── 1〜3. 宣言 ───────────────────────────────────────────────────────────────
if ! report="$(LIKES_CONFIG="$LIKES_CONFIG" PAGES_CONFIG="$PAGES_CONFIG" BINDINGS="$BINDINGS" \
  RATE_LIMIT_BINDING="$RATE_LIMIT_BINDING" RATE_LIMITER_SERVICE="$RATE_LIMITER_SERVICE" \
  RATE_LIMITER_ENTRYPOINT="$RATE_LIMITER_ENTRYPOINT" RATE_LIMIT_LIMIT="$rate_limit_limit" \
  RATE_LIMIT_PERIOD="$rate_limit_period" \
  node --input-type=module - 2>&1 <<'JS'
const { experimental_readRawConfig } = await import('wrangler');
const likes = experimental_readRawConfig({ config: process.env.LIKES_CONFIG }).rawConfig;
const pages = experimental_readRawConfig({ config: process.env.PAGES_CONFIG }).rawConfig;
const bindings = process.env.BINDINGS.split(' ');
const problems = [];

// 1. 公開の入口
if (likes.workers_dev !== false) {
  problems.push(`workers_dev が false と明示されていません（値: ${JSON.stringify(likes.workers_dev)}。省略すると既定の true で *.workers.dev に出る）`);
}
if (likes.preview_urls !== false) {
  problems.push(`preview_urls が false と明示されていません（値: ${JSON.stringify(likes.preview_urls)}）`);
}
for (const key of ['route', 'routes']) {
  if (likes[key] !== undefined) {
    problems.push(`${key} を宣言しています（公開の入口になる）: ${JSON.stringify(likes[key])}`);
  }
}
if (likes.env !== undefined) {
  problems.push(`環境（env）を宣言しています。環境ごとに workers_dev / routes を上書きできるので置かない: ${Object.keys(likes.env).join(', ')}`);
}

// 2. SQLite 版（束縛ごと）
const migrations = likes.migrations ?? [];
const sqlite = migrations.flatMap((m) => m.new_sqlite_classes ?? []);
const kv = migrations.flatMap((m) => m.new_classes ?? []);
const tags = migrations.map((m) => m.tag);
if (new Set(tags).size !== tags.length) {
  problems.push(`migrations のタグが重複しています: ${tags.join(', ')}`);
}
for (const binding of bindings) {
  const own = (likes.durable_objects?.bindings ?? []).find((b) => b.name === binding);
  const className = own?.class_name;
  if (className === undefined) {
    problems.push(`${process.env.LIKES_CONFIG} に ${binding} の durable_objects.bindings がありません`);
  }
  if (className !== undefined && !sqlite.includes(className)) {
    problems.push(`${className} が new_sqlite_classes にありません（Workers Free で使えるのは SQLite 版だけ）`);
  }
  if (className !== undefined && kv.includes(className)) {
    problems.push(`${className} が new_classes（KV 版）にあります。保存形式は後から変えられない`);
  }

  // 3. Pages との結線
  const scopes = [
    ['トップレベル', pages],
    ['env.production', pages.env?.production ?? {}],
    ['env.preview', pages.env?.preview ?? {}],
  ];
  for (const [label, scope] of scopes) {
    const found = (scope.durable_objects?.bindings ?? []).find((b) => b.name === binding);
    if (found === undefined) {
      problems.push(`${process.env.PAGES_CONFIG} の ${label} に ${binding} がありません（durable_objects は環境へ引き継がれない）`);
      continue;
    }
    if (found.script_name !== likes.name) {
      problems.push(`${label} の ${binding}.script_name（${found.script_name}）が likes Worker の name（${likes.name}）と一致しません`);
    }
    if (className !== undefined && found.class_name !== className) {
      problems.push(`${label} の ${binding}.class_name（${found.class_name}）が likes Worker の宣言（${className}）と一致しません`);
    }
  }
}
const likesDb = (likes.d1_databases ?? []).find((d) => d.binding === 'DB');
const pagesDb = (pages.env?.production?.d1_databases ?? []).find((d) => d.binding === 'DB');
if (likesDb === undefined || pagesDb === undefined) {
  problems.push('likes Worker と Pages の本番のどちらかに D1（DB）がありません');
} else if (likesDb.database_id !== pagesDb.database_id) {
  problems.push(`likes Worker の D1（${likesDb.database_id}）が Pages の本番 D1（${pagesDb.database_id}）と一致しません`);
}
// ローカル: `wrangler dev` は preview_database_id を先に使う。Pages のローカル D1
// （トップレベルの database_id）と同じでないと、ローカルの同期が別の空の D1 へ書く。
const pagesLocalDb = (pages.d1_databases ?? []).find((d) => d.binding === 'DB');
if (likesDb !== undefined && pagesLocalDb !== undefined && likesDb.preview_database_id !== pagesLocalDb.database_id) {
  problems.push(`likes Worker の preview_database_id（${likesDb.preview_database_id}）が Pages のローカル D1（${pagesLocalDb.database_id}）と一致しません（ローカルの同期が Pages の読む D1 に届かない）`);
}

// 7. 機械が読める口の上限（#699 / 仕様 5.13）
const limitName = process.env.RATE_LIMIT_BINDING;
const limiterBinding = process.env.RATE_LIMITER_SERVICE;
const limiterEntrypoint = process.env.RATE_LIMITER_ENTRYPOINT;
const expectedLimit = Number(process.env.RATE_LIMIT_LIMIT);
const expectedPeriod = Number(process.env.RATE_LIMIT_PERIOD);
const ratelimit = (likes.ratelimits ?? []).find((r) => r.name === limitName);
if (ratelimit === undefined) {
  problems.push(`${process.env.LIKES_CONFIG} に [[ratelimits]] の ${limitName} がありません`);
} else if (ratelimit.simple?.limit !== expectedLimit || ratelimit.simple?.period !== expectedPeriod) {
  problems.push(`${limitName} の値（${JSON.stringify(ratelimit.simple)}）が src/api-rate-limit.ts の ${expectedLimit} 回 / ${expectedPeriod} 秒と一致しません`);
}
for (const [label, scope] of [
  ['トップレベル', pages],
  ['env.production', pages.env?.production ?? {}],
  ['env.preview', pages.env?.preview ?? {}],
]) {
  const found = (scope.services ?? []).find((s) => s.binding === limiterBinding);
  if (found === undefined) {
    problems.push(`${process.env.PAGES_CONFIG} の ${label} に Service binding ${limiterBinding} がありません（services は環境へ引き継がれない）`);
    continue;
  }
  if (found.service !== likes.name) {
    problems.push(`${label} の ${limiterBinding}.service（${found.service}）が likes Worker の name（${likes.name}）と一致しません`);
  }
  if (found.entrypoint !== limiterEntrypoint) {
    problems.push(`${label} の ${limiterBinding}.entrypoint（${found.entrypoint}）が ${limiterEntrypoint} ではありません`);
  }
}

for (const problem of problems) console.log(problem);
process.exit(problems.length === 0 ? 0 : 1);
JS
)"; then
  printf '%s\n' "$report" | while IFS= read -r line; do printf '[likes-worker]   %s\n' "$line" >&2; done
  fail "宣言に問題があります（上記）。"
fi

# ── 4. 窓口を 1 つにする ──────────────────────────────────────────────────────
# **コメントも数える。** 「読んでいるのはコメントだけ」を見分けるには構文解析が要り、
# そこで緩めると検査が空振りする形を作れる。窓口の外でこの名前に触れる必要は無い。
for binding in $BINDINGS; do
  window="$(window_of "$binding")" || fail "$binding の窓口が決まっていません（window_of に足すこと）。"
  readers="$(grep -rlF "$binding" src || true)"
  if [[ "$readers" != "$window" ]]; then
    printf '[likes-worker]   %s を含むファイル:\n' "$binding" >&2
    printf '%s\n' "${readers:-（なし）}" | while IFS= read -r line; do printf '[likes-worker]     %s\n' "$line" >&2; done
    fail "src/ で ${binding} に触れてよいのは ${window} だけです（窓口を 1 つにする。仕様 5.8）。"
  fi
done

readers="$(grep -rlF "$RATE_LIMITER_SERVICE" src || true)"
if [[ "$readers" != "$RATE_LIMITER_WINDOW" ]]; then
  printf '[likes-worker]   %s を含むファイル:\n' "$RATE_LIMITER_SERVICE" >&2
  printf '%s\n' "${readers:-（なし）}" | while IFS= read -r line; do printf '[likes-worker]     %s\n' "$line" >&2; done
  fail "src/ で ${RATE_LIMITER_SERVICE} に触れてよいのは ${RATE_LIMITER_WINDOW} だけです（窓口を 1 つにする。仕様 5.13）。"
fi

# ── 5. 配る順序 ───────────────────────────────────────────────────────────────
# **likes Worker を Pages より先に配る**（5.8）。順序は verify.yml の deploy ジョブの段の
# 並びが持つので、並びそのものを見る（段を入れ替えた差分は小さく、どのテストも見ない）。
WORKFLOW=".github/workflows/verify.yml"
[[ -f "$WORKFLOW" ]] || fail "$WORKFLOW がありません。"
likes_line="$(grep -nF 'run: bash scripts/deploy-likes.sh' "$WORKFLOW" | head -1 | cut -d: -f1)"
pages_line="$(grep -nF 'npx wrangler pages deploy' "$WORKFLOW" | head -1 | cut -d: -f1)"
[[ -n "$likes_line" ]] || fail "$WORKFLOW に likes Worker を配る段（run: bash scripts/deploy-likes.sh）がありません。"
[[ -n "$pages_line" ]] || fail "$WORKFLOW に Pages を配る段（npx wrangler pages deploy）が見つかりません。検査が成立しません。"
if [[ "$likes_line" -ge "$pages_line" ]]; then
  fail "$WORKFLOW で likes Worker を配る段（${likes_line} 行目）が Pages を配る段（${pages_line} 行目）より後にあります。"
fi

# ── 6. 束ねられる ─────────────────────────────────────────────────────────────
out_dir="$(mktemp -d "${TMPDIR:-/tmp}/likes-worker-dry-run.XXXXXX")"
trap 'rm -rf "$out_dir"' EXIT
if ! dry_run="$(CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV=false WRANGLER_SEND_METRICS=false \
  node_modules/.bin/wrangler deploy --dry-run --config "$LIKES_CONFIG" --outdir "$out_dir" 2>&1)"; then
  printf '%s\n' "$dry_run" | tail -20 >&2
  fail "likes Worker を束ねられません（wrangler deploy --dry-run が失敗）。"
fi
[[ -s "$out_dir/index.js" ]] || fail "likes Worker を束ねた結果（index.js）がありません。"
# 7. 上限の入口を輸出している（#699）。**Pages の Service binding が指す名前付きの入口が、配る束に無い**
# 形を配らない。esbuild の束の末尾の `export {` から `};` までに、1 行 1 つで名前が並ぶ。
if ! sed -n '/^export {/,/^};/p' "$out_dir/index.js" | grep -qE "^[[:space:]]*${RATE_LIMITER_ENTRYPOINT},?$"; then
  fail "束ねた likes Worker が ${RATE_LIMITER_ENTRYPOINT} を輸出していません（Pages の ${RATE_LIMITER_SERVICE} が指す入口）。"
fi

echo "LIKES_WORKER_PASS"
