#!/usr/bin/env bash
# check-cleanup-worker.sh — 退会の後続の処理を回す Worker `game-forge-cleanup` の宣言を、
# 機械で確かめる（#518 / #586 / 仕様 3.7 / 5.8）。
#
# ## なぜ要るのか
#
# **この Worker は R2 のバケット全体と D1 を消せる資格情報を持つ。** いいねの Worker
# （`scripts/check-likes-worker.sh`）が守っているのは「利用者 id を偽装させない」ことだが、
# こちらで守るのはもっと重い——**公開の入口が 1 本でも開けば、作品の成果物とアイコンを
# 外から消せる経路になる。**
#
# **入口は宣言 1 行で開く。** `workers_dev` を消す（既定は true）、`route` を足す、環境を
# 足してそちらで `workers_dev = true` にする——どれも差分としては小さく、テストは緑のまま
# 通る（テストは本番の公開状態を見ない）。**だから宣言を機械で見る。**
#
# ## 見るもの
#
# 1. **公開の入口が無い**（`workers/cleanup/wrangler.toml`）
#    - `workers_dev = false` を**明示している**（既定は true なので、省略は開いているのと同じ）
#    - `preview_urls = false` を**明示している**（既定は workers_dev に従うが、既定に頼らない）
#    - `route` / `routes` を持たない（カスタムドメインも `routes` の中に書く）
#    - `env` を持たない（環境ごとに上の 3 つを上書きできるため、環境そのものを置かせない）
# 2. **SQLite 版で作る**（`new_sqlite_classes` に `WithdrawalHub` がある。`new_classes` に無い）
#    ——Workers Free で使えるのは SQLite 版だけで、一度作ると保存形式を変えられない
# 3. **cron が宣言されている**（`[triggers]` の `crons`）。**これが唯一の起こし方である**
#    ——消えると、退会した作品が誰にも消されないまま残る（どのテストも赤くならない）
# 4. **Pages はこの Worker を指さない**（#518 の J3。`check-likes-worker.sh` の「結線が揃っている」の逆）
#    - ルートの `wrangler.toml` に `script_name = "game-forge-cleanup"` の束縛が無い
#    - `src/` が `WITHDRAWAL_HUB` に触れていない
#    **足すと、退会の口が「後続の処理を起こす」責任まで持つ**——起こし損ねた退会が止まり、
#    しかも Pages が「存在しない DO を指す」経路が 1 本増える
# 5. **保存先が Pages と同じ**（D1 の `database_id` / `preview_database_id`、R2 の `bucket_name`）
#    ——片方だけ書き換えると、後続の処理が別のデータベースや別のバケットを消しに行く
# 6. **配る順序**: `.github/workflows/verify.yml` の deploy ジョブで、この Worker を配る段が
#    Pages を配る段より前にある（likes と同じ並びに揃える）
# 7. **束ねられる**（`wrangler deploy --dry-run`。資格情報もネットワークも要らない）。配備の段で
#    初めて落ちる形にしない
#
# ## 読み方
#
# **TOML は wrangler 自身の読み取り器で読む**（`experimental_readRawConfig`）。正規表現で読むと、
# 表の書き方（インラインテーブル・引用符付きのキー）で見落とす。**既定値で埋めない生の値**を
# 読むので、「省略」と「false の明示」を区別できる。
#
# ## この検査が約束しないこと
#
# - **本番の Worker が実際に公開されていないこと**は見ない（宣言だけを見る）。ダッシュボードで
#   手で workers.dev を有効にした場合は捕まらない。本番の確かめ方は `docs/cleanup-worker.md`
# - **cron が本番で実際に登録されていること**も見ない（`wrangler` に cron を読むコマンドが無い。
#   確かめ方は `docs/cleanup-worker.md`）
#
# 使い方:
#   bash scripts/check-cleanup-worker.sh
#
# 終了コード: 0 = CLEANUP_WORKER_PASS / 1 = CLEANUP_WORKER_FAIL
#
# **GNU 拡張を使わない**（利用者の端末は macOS / bash 3.2。`docs/handoff.md` 3 章）。
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$(dirname "$HERE")"

CLEANUP_CONFIG="workers/cleanup/wrangler.toml"
PAGES_CONFIG="wrangler.toml"
# **この Worker のバインディングの名前**（`src/` が触れてはいけない名前でもある）。
CLEANUP_BINDING="WITHDRAWAL_HUB"

fail() {
  printf '[cleanup-worker] %s\n' "$1" >&2
  echo "CLEANUP_WORKER_FAIL"
  exit 1
}

[[ -f "$CLEANUP_CONFIG" ]] || fail "$CLEANUP_CONFIG がありません。"
[[ -f "$PAGES_CONFIG" ]] || fail "$PAGES_CONFIG がありません。"
command -v node >/dev/null 2>&1 || fail "node が見つかりません。Node.js を導入してください。"
[[ -d node_modules/wrangler ]] || fail "node_modules/wrangler がありません。npm ci を実行してください。"

# ── 1〜5. 宣言 ───────────────────────────────────────────────────────────────
if ! report="$(CLEANUP_CONFIG="$CLEANUP_CONFIG" PAGES_CONFIG="$PAGES_CONFIG" \
  node --input-type=module - 2>&1 <<'JS'
const { experimental_readRawConfig } = await import('wrangler');
const cleanup = experimental_readRawConfig({ config: process.env.CLEANUP_CONFIG }).rawConfig;
const pages = experimental_readRawConfig({ config: process.env.PAGES_CONFIG }).rawConfig;
const problems = [];

// 1. 公開の入口
if (cleanup.workers_dev !== false) {
  problems.push(`workers_dev が false と明示されていません（値: ${JSON.stringify(cleanup.workers_dev)}。省略すると既定の true で *.workers.dev に出る）`);
}
if (cleanup.preview_urls !== false) {
  problems.push(`preview_urls が false と明示されていません（値: ${JSON.stringify(cleanup.preview_urls)}）`);
}
for (const key of ['route', 'routes']) {
  if (cleanup[key] !== undefined) {
    problems.push(`${key} を宣言しています（公開の入口になる）: ${JSON.stringify(cleanup[key])}`);
  }
}
if (cleanup.env !== undefined) {
  problems.push(`環境（env）を宣言しています。環境ごとに workers_dev / routes を上書きできるので置かない: ${Object.keys(cleanup.env).join(', ')}`);
}

// 2. SQLite 版
const migrations = cleanup.migrations ?? [];
const sqlite = migrations.flatMap((m) => m.new_sqlite_classes ?? []);
const kv = migrations.flatMap((m) => m.new_classes ?? []);
const tags = migrations.map((m) => m.tag);
if (new Set(tags).size !== tags.length) {
  problems.push(`migrations のタグが重複しています: ${tags.join(', ')}`);
}
const own = (cleanup.durable_objects?.bindings ?? []).find((b) => b.name === 'WITHDRAWAL_HUB');
const className = own?.class_name;
if (className === undefined) {
  problems.push(`${process.env.CLEANUP_CONFIG} に WITHDRAWAL_HUB の durable_objects.bindings がありません`);
} else {
  if (!sqlite.includes(className)) {
    problems.push(`${className} が new_sqlite_classes にありません（Workers Free で使えるのは SQLite 版だけ）`);
  }
  if (kv.includes(className)) {
    problems.push(`${className} が new_classes（KV 版）にあります。保存形式は後から変えられない`);
  }
}

// 3. cron（**唯一の起こし方**）
//
// **綴りまで見る。** 「空でない」だけだと、`0 0 1 1 *`（年 1 回）へ書き換えても緑のまま通る
// ——退会した作品が 1 年消えない形が、宣言 1 行の差分で作れてしまう（PR #588 の Copilot の指摘）。
// **値を変えるときは、この検査も一緒に変える。**
const EXPECTED_CRONS = ['*/5 * * * *'];
const crons = cleanup.triggers?.crons ?? [];
if (JSON.stringify(crons) !== JSON.stringify(EXPECTED_CRONS)) {
  problems.push(`[triggers] の crons が ${JSON.stringify(EXPECTED_CRONS)} と一致しません（値: ${JSON.stringify(crons)}）。cron が唯一の起こし方なので、間隔を変えるならこの検査も一緒に変える`);
}

// 4. Pages はこの Worker を指さない
const scopes = [
  ['トップレベル', pages],
  ['env.production', pages.env?.production ?? {}],
  ['env.preview', pages.env?.preview ?? {}],
];
for (const [label, scope] of scopes) {
  const pointing = (scope.durable_objects?.bindings ?? []).filter((b) => b.script_name === cleanup.name);
  if (pointing.length > 0) {
    problems.push(`${process.env.PAGES_CONFIG} の ${label} に ${cleanup.name} を指す束縛があります（${pointing.map((b) => b.name).join(', ')}）。Pages からは起こさない（#518 の J3）`);
  }
  const services = (scope.services ?? []).filter((s) => s.service === cleanup.name);
  if (services.length > 0) {
    problems.push(`${process.env.PAGES_CONFIG} の ${label} に ${cleanup.name} への service binding があります（${services.map((s) => s.binding).join(', ')}）`);
  }
}

// 5. 保存先が Pages と同じ
const cleanupDb = (cleanup.d1_databases ?? []).find((d) => d.binding === 'DB');
const pagesDb = (pages.env?.production?.d1_databases ?? []).find((d) => d.binding === 'DB');
const pagesLocalDb = (pages.d1_databases ?? []).find((d) => d.binding === 'DB');
if (cleanupDb === undefined || pagesDb === undefined) {
  problems.push('cleanup Worker と Pages の本番のどちらかに D1（DB）がありません');
} else if (cleanupDb.database_id !== pagesDb.database_id) {
  problems.push(`cleanup Worker の D1（${cleanupDb.database_id}）が Pages の本番 D1（${pagesDb.database_id}）と一致しません`);
}
if (cleanupDb !== undefined && pagesLocalDb !== undefined && cleanupDb.preview_database_id !== pagesLocalDb.database_id) {
  problems.push(`cleanup Worker の preview_database_id（${cleanupDb.preview_database_id}）が Pages のローカル D1（${pagesLocalDb.database_id}）と一致しません`);
}
const cleanupBucket = (cleanup.r2_buckets ?? []).find((b) => b.binding === 'BUCKET');
const pagesBucket = (pages.env?.production?.r2_buckets ?? []).find((b) => b.binding === 'BUCKET');
if (cleanupBucket === undefined || pagesBucket === undefined) {
  problems.push('cleanup Worker と Pages の本番のどちらかに R2（BUCKET）がありません');
} else if (cleanupBucket.bucket_name !== pagesBucket.bucket_name) {
  problems.push(`cleanup Worker の R2（${cleanupBucket.bucket_name}）が Pages の本番 R2（${pagesBucket.bucket_name}）と一致しません`);
}

// 6. MCP の許可の KV が Pages と同じ（#696）。**退会の完了の段で許可を消す**ので、別の namespace を指すと
// 退会した人の許可が消えないまま完了の印が立つ（空の namespace を見て「残っていない」と読む）。
const cleanupKv = (cleanup.kv_namespaces ?? []).find((k) => k.binding === 'OAUTH_KV');
const pagesKv = (pages.env?.production?.kv_namespaces ?? []).find((k) => k.binding === 'OAUTH_KV');
const pagesLocalKv = (pages.kv_namespaces ?? []).find((k) => k.binding === 'OAUTH_KV');
if (cleanupKv === undefined || pagesKv === undefined) {
  problems.push('cleanup Worker と Pages の本番のどちらかに KV（OAUTH_KV）がありません');
} else if (cleanupKv.id !== pagesKv.id) {
  problems.push(`cleanup Worker の KV（${cleanupKv.id}）が Pages の本番 KV（${pagesKv.id}）と一致しません`);
}
if (cleanupKv !== undefined && pagesLocalKv !== undefined && cleanupKv.preview_id !== pagesLocalKv.id) {
  problems.push(`cleanup Worker の KV の preview_id（${cleanupKv.preview_id}）が Pages のローカル KV（${pagesLocalKv.id}）と一致しません`);
}

for (const problem of problems) console.log(problem);
process.exit(problems.length === 0 ? 0 : 1);
JS
)"; then
  printf '%s\n' "$report" | while IFS= read -r line; do printf '[cleanup-worker]   %s\n' "$line" >&2; done
  fail "宣言に問題があります（上記）。"
fi

# ── 4（続き）. Pages（src/）はこの DO の名前を知らない ────────────────────────
# **コメントも数える**（`scripts/check-likes-worker.sh` の窓口の検査と同じ理由——「読んでいるのは
# コメントだけ」を見分けるには構文解析が要り、そこで緩めると検査が空振りする）。
readers="$(grep -rlF "$CLEANUP_BINDING" src || true)"
if [[ -n "$readers" ]]; then
  printf '%s\n' "$readers" | while IFS= read -r line; do printf '[cleanup-worker]     %s\n' "$line" >&2; done
  fail "src/ が ${CLEANUP_BINDING} に触れています。Pages からは後続の処理を起こしません（#518 の J3）。"
fi

# ── 6. 配る順序 ───────────────────────────────────────────────────────────────
# **cleanup Worker を Pages より先に配る。** Pages はこの Worker を指さないので依存は無いが、
# **Worker を配る段を Pages の前に集めておく**ほうが、段の読み方が 1 つで済む（likes と同じ並び）。
WORKFLOW=".github/workflows/verify.yml"
[[ -f "$WORKFLOW" ]] || fail "$WORKFLOW がありません。"
# **`|| true` を付ける。** `set -euo pipefail` の下では、grep が見つけられなかった時点で
# スクリプトが**何も言わずに**終わる——下の「段がありません」という名指しの失敗へ届かない。
cleanup_line="$(grep -nF 'run: bash scripts/deploy-cleanup.sh' "$WORKFLOW" | head -1 | cut -d: -f1 || true)"
pages_line="$(grep -nF 'npx wrangler pages deploy' "$WORKFLOW" | head -1 | cut -d: -f1 || true)"
[[ -n "$cleanup_line" ]] || fail "$WORKFLOW に cleanup Worker を配る段（run: bash scripts/deploy-cleanup.sh）がありません。"
[[ -n "$pages_line" ]] || fail "$WORKFLOW に Pages を配る段（npx wrangler pages deploy）が見つかりません。検査が成立しません。"
if [[ "$cleanup_line" -ge "$pages_line" ]]; then
  fail "$WORKFLOW で cleanup Worker を配る段（${cleanup_line} 行目）が Pages を配る段（${pages_line} 行目）より後にあります。"
fi

# ── 7. 束ねられる ─────────────────────────────────────────────────────────────
out_dir="$(mktemp -d "${TMPDIR:-/tmp}/cleanup-worker-dry-run.XXXXXX")"
trap 'rm -rf "$out_dir"' EXIT
if ! dry_run="$(CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV=false WRANGLER_SEND_METRICS=false \
  node_modules/.bin/wrangler deploy --dry-run --config "$CLEANUP_CONFIG" --outdir "$out_dir" 2>&1)"; then
  printf '%s\n' "$dry_run" | tail -20 >&2
  fail "cleanup Worker を束ねられません（wrangler deploy --dry-run が失敗）。"
fi
[[ -s "$out_dir/index.js" ]] || fail "cleanup Worker を束ねた結果（index.js）がありません。"

echo "CLEANUP_WORKER_PASS"
