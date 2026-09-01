#!/usr/bin/env node
/**
 * #25 の A/B の集計を、本番の台帳に対して読み出す（#238）。
 *
 * ## なぜこの形なのか
 *
 * **集計そのもの（`src/cost-ledger.ts` の `effortExperimentTotals`）を書き直さない。**
 * あれは依頼の切り分け・層別・元ソースの有無の判定を持っており、SQL へ写すと
 * **数え方の定義が 2 か所になる**——`scripts/report-selftest.sh` が「定義は 1 か所で
 * あること」を機械で検査しているので、それを自分で壊すことになる。
 *
 * **だから同じ関数を回す。** 本番の行を読み取りだけで取り出し、**その場限りの SQLite**
 * （`node:sqlite`。ファイルを作らない `:memory:`）へ入れて、そこへ D1 の形をした薄い
 * 覆いを被せて渡す。
 *
 * ## スキーマの写しを作らない
 *
 * `migrations/*.sql` をそのまま適用する（wrangler と同じくファイル名順）。**列を手で
 * 書き出すと、次にマイグレーションが増えた日にずれる。**
 *
 * ## 覆いが持つのは 3 つの呼び出しだけである
 *
 * `effortExperimentTotals` が使うのは `prepare().bind().all()` だけで、書き込みは
 * 1 つも無い（読み出しの道具なので当然だが、**覆いの側も書けない形にしてある**）。
 *
 * 使い方（直接叩かず `scripts/effort-ab-report.sh` から呼ばれる）:
 *   node scripts/effort-ab-report.mjs --rows <json> --bundle <mjs> --from <sec> --to <sec>
 */

import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(HERE);

const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

const rowsPath = opt('--rows');
const bundlePath = opt('--bundle');
const fromSeconds = Number(opt('--from'));
const toSeconds = Number(opt('--to'));
const format = opt('--format') ?? 'table';

if (!rowsPath || !bundlePath || !Number.isFinite(fromSeconds) || !Number.isFinite(toSeconds)) {
  console.error('[effort-ab] --rows / --bundle / --from / --to が要ります。');
  process.exit(2);
}

const rows = JSON.parse(readFileSync(rowsPath, 'utf8'));
if (!Array.isArray(rows.generations) || !Array.isArray(rows.games)) {
  console.error('[effort-ab] 取り出した行の形が想定と違います（generations / games の配列）。');
  process.exit(2);
}

// **その場限りの SQLite。** ファイルを作らないので、後片付けの漏れが起こらない。
const db = new DatabaseSync(':memory:');
for (const file of readdirSync(join(ROOT, 'migrations')).filter((f) => f.endsWith('.sql')).sort()) {
  db.exec(readFileSync(join(ROOT, 'migrations', file), 'utf8'));
}

// 参照制約を満たすための最小の行。**集計はこれらの列を 1 つも読まない。**
db.prepare(
  `insert into users (id, google_sub, email, display_name, created_at)
   values ('u', 'sub', 'reader@example.invalid', 'reader', 0)`,
).run();

const insertGeneration = db.prepare(
  `insert into generations
     (id, game_id, user_id, prompt, model, effort,
      input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens,
      cost_jpy, succeeded, created_at)
   values (?, null, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
);
for (const r of rows.generations) {
  insertGeneration.run(
    String(r.id),
    'u',
    // **本文ではなく識別子が入っている**（取り出す側が dense_rank へ置き換えている）。
    // 集計は等しいかどうかしか見ないので、これで足りる。
    String(r.prompt),
    String(r.model),
    r.effort === null || r.effort === undefined ? null : String(r.effort),
    Number(r.input_tokens),
    Number(r.output_tokens),
    Number(r.cache_creation_input_tokens),
    Number(r.cache_read_input_tokens),
    Number(r.cost_jpy),
    Number(r.succeeded),
    Number(r.created_at),
  );
}

const insertGame = db.prepare(
  `insert into games
     (id, author_id, status, title, go_version, created_at, generation_state, generation_error)
   values (?, 'u', 'draft', 't', 'go', ?, ?, ?)`,
);
for (const r of rows.games) {
  insertGame.run(
    String(r.id),
    Number(r.created_at),
    r.generation_state === null || r.generation_state === undefined
      ? null
      : String(r.generation_state),
    r.generation_error === null || r.generation_error === undefined
      ? null
      : String(r.generation_error),
  );
}

/**
 * D1 の形をした薄い覆い。**読み出しだけを通す。**
 *
 * `effortExperimentTotals` が使うのは `prepare().bind().all()` だけである。
 * `run` / `first` を生やさないので、**書き込みを足した日にここで落ちる**（黙って
 * 本番と違う経路が増えない）。
 */
const DB = {
  prepare(sql) {
    let bound = [];
    const statement = {
      bind(...values) {
        bound = values;
        return statement;
      },
      all() {
        return Promise.resolve({ results: db.prepare(sql).all(...bound) });
      },
    };
    return statement;
  },
};

const { effortExperimentTotals } = await import(pathToFileURL(resolve(bundlePath)).href);
const report = await effortExperimentTotals({ DB }, { fromSeconds, toSeconds });

if (format === 'json') {
  console.log(JSON.stringify(report, null, 2));
} else {
  const jpy = (v) => (v === null || v === undefined ? '-' : Number(v).toFixed(2));
  const rate = (v) => (v === null || v === undefined ? '-' : `${(Number(v) * 100).toFixed(0)}%`);
  console.log(`[effort-ab] 窓 [${report.fromSeconds}, ${report.toSeconds})`);
  console.log('');
  console.log(
    ['群', '呼び出し', '依頼', '実コスト(円)', '1 呼び出しの出力', '初回完了', '曖昧', '使えない'].join('\t'),
  );
  for (const g of report.groups) {
    console.log(
      [
        `${g.modelKey}${g.effort === null ? '' : `/${g.effort}`}${g.withBaseSource ? '（推敲）' : ''}`,
        g.calls,
        g.jobs,
        jpy(g.costJpy),
        g.outputTokensPerCall ?? '-',
        `${g.firstCallCompleted}（${rate(g.firstCallCompletionRate)}）`,
        g.ambiguousJobs,
        g.unusableCalls,
      ].join('\t'),
    );
  }
  console.log('');
  console.log('注記:');
  console.log('  - **ambiguousJobs / unusableCalls が 0 でない群は、そのまま結論に使わないこと**（#25）。');
  console.log('  - **withBaseSource が true の群は推敲である**（1.2.43。新規生成とは別の値）。');
  console.log('  - firstCallCompleted は上界である（5.2-5 の即拒否も「初回で終わった」に数える）。');
}
