#!/usr/bin/env node
// input-keys-backfill.mjs — 作品が読むキーを既存作品へ埋め戻す。欠けの点検を兼ねる（#493 / 仕様 3.9.5）
//
// **入口は `scripts/input-keys-backfill.sh` である**（本番の資格情報を環境へ移してから、ここを呼ぶ）。
// 使い方と読み方は `docs/usage-report.md`「作品が読むキーの欠けを点検し、埋め戻す」。
//
// ## 何をするか
//
// 1. **対象を D1 から読む**——`games.source_key`（NULL を除く）と `game_revisions.source_key` の和集合のうち、
//    `source_input_keys` の行が無いか `rule_version` が古いもの。**綴りは `src/source-input-keys.ts` の
//    `SOURCE_INPUT_KEYS_TARGETS_SQL` をそのまま使う**（写さない）。
// 2. 既定（dry-run）は**件数と一覧を出して終わる。1 行も書かない。**
// 3. `--apply` のときだけ、対象ごとに **R2 からソースを読み**、`src/input-keys.ts` の `extractInputKeyCodes`（読むキー）と
//    `extractHeldInputKeyCodes`（押し続けて読むキー。規則の版 2 / #529）と `extractAliasGroups`（同じ条件式で読むキーの組。
//    規則の版 3 / #543）と、`src/source-input-keys.ts` の `layoutColumnsOf`（作品の論理解像度。規則の版 4 / #514）で拾い、
//    `UPSERT_SOURCE_INPUT_KEYS_SQL` で書く（新しい版だけが上書きする＝何度流しても壊れない）。**書いた行の `OK` には論理解像度
//    （`layout=320x240`。拾えなければ `layout=null`）も出す**——向き（横長・縦長・正方形）を利用者が一覧で確かめられる。
// 4. 書いたあと、**対象を数え直す**（報告された件数を信じない。`scripts/moderation-prune.sh` と同じ規律）。
//
// ## 値を実行時に読む（#380 の教訓）
//
// **対象の一覧もソースの本文も、このスクリプトが走っている間に読む。** 事前に取った一覧や、手元に置いた
// ソースを使う口を持たない——事前に埋めた値は、書く時点で古くなりうる。
//
// ## 抽出の規則を 2 か所に書かない
//
// TypeScript のモジュールを esbuild で一時ファイルへ束ねて import する（`scripts/bundle-orchestrator.sh` と
// 同じ道具）。**Worker の完成の経路と、この埋め戻しは、同じ関数・同じ SQL で拾う。**
//
// 終了コード:
//   0 = INPUT_KEYS_BACKFILL_PASS（dry-run で数えた / 書いて、対象が 0 件になった）
//   1 = INPUT_KEYS_BACKFILL_INCOMPLETE（読めないソース、または形の合わないキーが残った。一覧を出す）
//   2 = 前提の不成立（引数・道具・D1 の応答の形）
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const TAG = '[input-keys-backfill]';
/** 1 回の `d1 execute` に載せる書き込みの文の数。コマンド行を短く保つ。 */
const WRITE_CHUNK = 20;

/**
 * 前提の不成立で終わる。
 *
 * @param {string[]} lines 標準エラーへ出す行
 * @returns {never}
 */
function abort(lines) {
  for (const line of lines) {
    console.error(`${TAG} ${line}`);
  }
  process.exit(2);
}

// ── 引数 ─────────────────────────────────────────────────────────────────────
let scope = 'local';
let apply = false;
let persistTo = '';
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i += 1) {
  const arg = args[i];
  if (arg === '--remote') {
    scope = 'remote';
  } else if (arg === '--local') {
    scope = 'local';
  } else if (arg === '--apply') {
    apply = true;
  } else if (arg === '--persist-to') {
    if (i + 1 >= args.length) {
      abort(['--persist-to には値が要ります。']);
    }
    persistTo = args[i + 1];
    i += 1;
  } else {
    abort([`不明な引数です: ${arg}`]);
  }
}
if (persistTo !== '' && scope === 'remote') {
  abort(['--persist-to は手元の D1 / R2 専用です（--remote とは併用できません）。']);
}

// ── 抽出の関数と SQL を、TypeScript のモジュールから借りる ──────────────────────────
const esbuild = path.join(ROOT, 'node_modules', '.bin', 'esbuild');
if (!existsSync(esbuild)) {
  abort([`esbuild がありません: ${esbuild}`, 'npm ci を実行してください。']);
}
const work = mkdtempSync(path.join(tmpdir(), 'input-keys-backfill-'));
process.on('exit', () => rmSync(work, { recursive: true, force: true }));
const bundled = path.join(work, 'input-keys.mjs');
const entry = [
  `export { INPUT_KEYS_RULE_VERSION, extractAliasGroups, extractHeldInputKeyCodes, extractInputKeyCodes } from ${JSON.stringify(path.join(ROOT, 'src', 'input-keys.ts'))};`,
  `export { SOURCE_INPUT_KEYS_TARGETS_SQL, UPSERT_SOURCE_INPUT_KEYS_SQL, isStoredSourceKey, layoutColumnsOf } from ${JSON.stringify(path.join(ROOT, 'src', 'source-input-keys.ts'))};`,
].join('\n');
const build = spawnSync(
  esbuild,
  ['--bundle', '--format=esm', '--platform=node', '--log-level=error', `--outfile=${bundled}`, '--loader=ts'],
  { input: entry, encoding: 'utf8', cwd: ROOT },
);
if (build.status !== 0) {
  abort(['抽出のモジュールを束ねられませんでした:', build.stderr ?? '']);
}
const {
  INPUT_KEYS_RULE_VERSION,
  extractAliasGroups,
  extractHeldInputKeyCodes,
  extractInputKeyCodes,
  SOURCE_INPUT_KEYS_TARGETS_SQL,
  UPSERT_SOURCE_INPUT_KEYS_SQL,
  isStoredSourceKey,
  layoutColumnsOf,
} = await import(pathToFileURL(bundled).href);

// ── wrangler ─────────────────────────────────────────────────────────────────
/**
 * wrangler.toml から R2 のバケット名を読む（`BUCKET` の binding）。
 *
 * @returns {string} バケット名
 */
function bucketName() {
  const text = readFileSync(path.join(ROOT, 'wrangler.toml'), 'utf8');
  const header = scope === 'remote' ? '[[env.production.r2_buckets]]' : '[[r2_buckets]]';
  const blocks = text.split('\n[').map((block, index) => (index === 0 ? block : `[${block}`));
  for (const block of blocks) {
    if (block.startsWith(header) && /\nbinding\s*=\s*"BUCKET"/.test(block)) {
      const match = /\nbucket_name\s*=\s*"([^"]+)"/.exec(block);
      if (match) {
        return match[1];
      }
    }
  }
  abort([`wrangler.toml から R2 のバケット名を読めません（${header}）。`]);
}

/**
 * wrangler を呼ぶ。
 *
 * @param {string[]} wranglerArgs 引数
 * @returns {{ ok: boolean, stdout: string, stderr: string }}
 */
function wrangler(wranglerArgs) {
  const result = spawnSync('npx', ['wrangler', ...wranglerArgs], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: 'false' },
    maxBuffer: 64 * 1024 * 1024,
  });
  return { ok: result.status === 0, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

/** @returns {string[]} 手元か本番かの引数（D1） */
function d1ScopeArgs() {
  if (scope === 'remote') {
    return ['--remote', '--env', 'production'];
  }
  return persistTo === '' ? ['--local'] : ['--local', '--persist-to', persistTo];
}

/** @returns {string[]} 手元か本番かの引数（R2） */
function r2ScopeArgs() {
  if (scope === 'remote') {
    return ['--remote'];
  }
  return persistTo === '' ? ['--local'] : ['--local', '--persist-to', persistTo];
}

/**
 * SQL の値を文字列のリテラルへ直す。**`wrangler d1 execute --command` は束縛を持たない**ので、ここで埋める。
 *
 * @param {string | number | null} value 値（null は `null`。論理解像度が拾えなかった列。#514）
 * @returns {string} リテラル
 */
function sqlLiteral(value) {
  if (value === null) {
    return 'null';
  }
  if (typeof value === 'number') {
    if (!Number.isInteger(value)) {
      abort([`整数でない値は埋めません: ${value}`]);
    }
    return String(value);
  }
  if (value.includes('\0')) {
    abort(['NUL を含む値は埋めません。']);
  }
  return `'${value.replaceAll("'", "''")}'`;
}

/**
 * `?` を順に値で埋める。**`?` の数と値の数が合わなければ落とす**（SQL の綴りが変わったのに気づかない形にしない）。
 *
 * @param {string} sql `?` を持つ SQL
 * @param {(string | number | null)[]} values 値
 * @returns {string} 埋めた SQL
 */
function bindLiterals(sql, values) {
  const parts = sql.split('?');
  if (parts.length - 1 !== values.length) {
    abort([`SQL の ? の数（${parts.length - 1}）と値の数（${values.length}）が合いません。`]);
  }
  return parts.reduce((out, part, index) => out + part + (index < values.length ? sqlLiteral(values[index]) : ''), '');
}

/**
 * D1 へ文を送り、1 つ目の結果の行を返す。
 *
 * @param {string} sql SQL
 * @returns {Record<string, unknown>[]} 行
 */
function d1(sql) {
  const out = wrangler(['d1', 'execute', 'DB', '--json', '--command', sql, ...d1ScopeArgs()]);
  if (!out.ok) {
    const text = `${out.stdout}\n${out.stderr}`;
    const lines = ['D1 を操作できません:', text.slice(0, 2000)];
    if (text.includes('no such table')) {
      lines.push('表がありません。マイグレーション（0040）が未適用の可能性があります。');
    }
    // **SQLite の文面で見る**（`held_codes` の綴りだけで見ると、SQL を載せた別の失敗でもこの行が出る）。
    if (/no column named held_codes|no such column: held_codes/.test(text)) {
      lines.push('列 held_codes がありません。マイグレーション（0042）が未適用の可能性があります。');
    }
    if (/no column named alias_groups|no such column: alias_groups/.test(text)) {
      lines.push('列 alias_groups がありません。マイグレーション（0043）が未適用の可能性があります。');
    }
    if (/no column named layout_(?:width|height)|no such column: layout_(?:width|height)/.test(text)) {
      lines.push('列 layout_width / layout_height がありません。マイグレーション（0044）が未適用の可能性があります。');
    }
    abort(lines);
  }
  const start = out.stdout.indexOf('[');
  let parsed;
  try {
    parsed = JSON.parse(out.stdout.slice(start));
  } catch {
    abort(['wrangler の応答に JSON が含まれていません:', out.stdout.slice(0, 500)]);
  }
  // **形を先に検査する。** 静かに 0 行にすると「対象が無かった」と読める。
  if (!Array.isArray(parsed) || typeof parsed[0] !== 'object' || !Array.isArray(parsed[0]?.results)) {
    abort(['D1 の応答の形が想定と違います:', JSON.stringify(parsed).slice(0, 500)]);
  }
  return parsed[0].results;
}

/**
 * 対象の `source_key` を読む。
 *
 * @returns {string[]} 対象
 */
function readTargets() {
  const rows = d1(bindLiterals(SOURCE_INPUT_KEYS_TARGETS_SQL, [INPUT_KEYS_RULE_VERSION]));
  return rows.map((row) => {
    if (typeof row.source_key !== 'string' || row.source_key === '') {
      abort(['対象の行の source_key が文字列ではありません:', JSON.stringify(row)]);
    }
    return row.source_key;
  });
}

// ── 本体 ─────────────────────────────────────────────────────────────────────
const where = scope === 'remote' ? '本番（--remote --env production）' : `手元${persistTo === '' ? '' : `（--persist-to ${persistTo}）`}`;
console.log(`${TAG} 対象: ${where} / 規則の版: ${INPUT_KEYS_RULE_VERSION} / ${apply ? '書き込む（--apply）' : 'dry-run（書き込まない）'}`);

/**
 * 形の合わないキーを報告する。**キーはそのまま出さず、JSON の文字列として符号化する**（改行などでログの行を崩させない）。
 *
 * @param {string[]} keys 形の合わないキー
 */
function reportInvalid(keys) {
  if (keys.length === 0) {
    return;
  }
  console.error(`${TAG} 形の合わないキーが ${keys.length} 件あります（builds/<sha256>/source.go でない。書きません）:`);
  for (const key of keys) {
    console.error(`${TAG}   INVALID ${JSON.stringify(key)}`);
  }
}

const allTargets = readTargets();
// **形を確かめてから扱う**（`src/source-input-keys.ts` の `isStoredSourceKey`。エッジと同じ判定）。
// 形の合わないキーは R2 を読まず、書かず、ログにも生のまま出さない。
const invalid = allTargets.filter((key) => !isStoredSourceKey(key));
const targets = allTargets.filter((key) => isStoredSourceKey(key));
console.log(`${TAG} 埋め戻しの対象: ${allTargets.length} 件（うち形の合わないキー ${invalid.length} 件）`);
for (const key of targets) {
  console.log(`${TAG}   ${key}`);
}
reportInvalid(invalid);

if (!apply) {
  if (targets.length > 0) {
    console.log(`${TAG} 書くには --apply を付けてください（既定では 1 行も書きません）。`);
  }
  if (invalid.length > 0) {
    console.log('INPUT_KEYS_BACKFILL_INCOMPLETE');
    process.exit(1);
  }
  console.log('INPUT_KEYS_BACKFILL_PASS');
  process.exit(0);
}

const bucket = bucketName();
const statements = [];
const unreadable = [];
for (const key of targets) {
  const file = path.join(work, 'source.go');
  rmSync(file, { force: true });
  const got = wrangler(['r2', 'object', 'get', `${bucket}/${key}`, '--file', file, ...r2ScopeArgs()]);
  if (!got.ok || !existsSync(file)) {
    console.error(`${TAG} NG ${key} — R2 から読めません`);
    unreadable.push(key);
    continue;
  }
  const source = readFileSync(file, 'utf8');
  if (source === '') {
    console.error(`${TAG} NG ${key} — 空です`);
    unreadable.push(key);
    continue;
  }
  const codes = extractInputKeyCodes(source);
  const heldCodes = extractHeldInputKeyCodes(source);
  const aliasGroups = extractAliasGroups(source);
  // **両方に値があるか両方 NULL**（組み立てはエッジと同じ関数。片方だけの値を書かない）。
  const [layoutWidth, layoutHeight] = layoutColumnsOf(source);
  const layout = layoutWidth === null ? 'null' : `${layoutWidth}x${layoutHeight}`;
  console.log(
    `${TAG} OK ${key} ${JSON.stringify(codes)} held=${JSON.stringify(heldCodes)} groups=${JSON.stringify(aliasGroups)} layout=${layout}`,
  );
  statements.push(
    bindLiterals(UPSERT_SOURCE_INPUT_KEYS_SQL, [
      key,
      JSON.stringify(codes),
      JSON.stringify(heldCodes),
      JSON.stringify(aliasGroups),
      layoutWidth,
      layoutHeight,
      INPUT_KEYS_RULE_VERSION,
      Math.floor(Date.now() / 1000),
    ]),
  );
}

for (let i = 0; i < statements.length; i += WRITE_CHUNK) {
  d1(statements.slice(i, i + WRITE_CHUNK).join(';\n'));
}
console.log(`${TAG} 書き込みを送った文: ${statements.length} 件（新しい版だけが上書きするので、既に今の版の行は変わりません）`);

// **報告された数を信じない。数え直す。**
const remaining = readTargets();
console.log(`${TAG} 書いたあとの対象: ${remaining.length} 件`);
const unexpected = remaining.filter((key) => !unreadable.includes(key) && !invalid.includes(key));
if (unexpected.length > 0) {
  abort(['書いたはずの対象が残っています（書き込みが効いていない）:', ...unexpected.map((key) => JSON.stringify(key))]);
}
if (unreadable.length > 0 || invalid.length > 0) {
  if (unreadable.length > 0) {
    console.error(`${TAG} R2 から読めないソースが ${unreadable.length} 件残りました（上の NG の行）。`);
  }
  if (invalid.length > 0) {
    console.error(`${TAG} 形の合わないキーが ${invalid.length} 件残りました（上の INVALID の行）。`);
  }
  console.log('INPUT_KEYS_BACKFILL_INCOMPLETE');
  process.exit(1);
}
console.log('INPUT_KEYS_BACKFILL_PASS');
process.exit(0);
