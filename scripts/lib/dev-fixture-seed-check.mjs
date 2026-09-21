#!/usr/bin/env node
// dev-fixture-seed-check.mjs — 仕込んだ行が実在することを、仕込みの本文から導いて確かめる（#732）
//
// ══════════════════════════════════════════════════════════════════════════════
// なぜ要るのか
// ══════════════════════════════════════════════════════════════════════════════
//
// **仕込み（`scripts/lib/dev-fixture.sh`）の関門は、長いあいだ「手続き」しか見ていなかった。**
//
//   npx wrangler d1 execute DB ... --command "…" >"$WORK/seed.log" 2>&1 || fail "…"
//
// これが見ているのは**走ったものの終了コード**である。ところが引用符が壊れると、
// **走るものそのものが変わる**——`--command` が別のコマンドとして実行され、`||` が
// 受け取る終了コードは別の何かのものになる。**#715 の仕込みは入った日からずっと
// 落ちていたのに、幅の検査は `PAGE_WIDTH_PASS` を出し続けた**（#726 で気づいた。#732）。
//
// **見るべきは実質——仕込んだ行が在るか——である**（`.ai-playbook/shared-ai-rules.md`
// 12 章「機構が結果そのものを生むか」）。
//
// ══════════════════════════════════════════════════════════════════════════════
// 数える行を、どこから決めるか
// ══════════════════════════════════════════════════════════════════════════════
//
// **「N 件あること」だけを書かない。** 数だけを書くと、仕込みを 1 行足すたびに数が
// 古くなり、足した行が入らなくても気づけない（12 章「一覧の複製は機械照合で担保する」）。
//
// **数える対象は、仕込みの本文そのものから導く。** 実際に `--file` へ渡す SQL を読み、
// `insert into <表> (<先頭の列>, …) values ('<先頭の値>', …)` を拾って
// **「表・列・値」の組**にする。この 3 つがそろっているので、**足りないときは名前が出る**
// （`chat_conversations.id=width-check-chat` のように）。仕込みへ 1 行足せば、数える対象も
// 同じコミットで 1 つ増える——**写しが無いので、古くなりようがない。**
//
// **拾い漏れたら落とす。** `insert into` の出現回数と、組にできた数が食い違ったら
// 例外にする。綴りを変えて拾えなくなった仕込みが、黙って「検査の対象外」へ落ちるのを防ぐ。
//
// ══════════════════════════════════════════════════════════════════════════════
// 何を約束しないか
// ══════════════════════════════════════════════════════════════════════════════
//
// - **`update` は見ない。** 見るのは「行が在るか」であって、列の値が期待どおりかではない。
//   値まで見ると、仕込みの意図（何を描かせたいか）をここへ書き写すことになる。
// - **仕込みから消された行は分からない。** 導出の元が同じ本文なので、行ごと消せば期待も
//   消える。この検査が塞ぐのは「**書いたのに入らなかった**」であって、「書くのをやめた」ではない。
// - **SQL の構文解析はしない。** 行頭の `--` のコメントだけを外して、正規表現で拾う。
//   仕込みは人が書く固定の本文で、機械が組み立てる任意の SQL ではない。
//
// 使い方:
//   node scripts/lib/dev-fixture-seed-check.mjs plan  <seed.sql>                 > verify.sql
//   node scripts/lib/dev-fixture-seed-check.mjs judge <seed.sql> <d1-json>
//   node scripts/lib/dev-fixture-seed-check.mjs --selftest
//
// 終了コード: 0 = 合格 / 1 = 仕込んだ行が足りない・導出に失敗した

/** `insert into <表> (<列>, …) values ('<値>', …)` の先頭の列と値を拾う。 */
const INSERT_RE =
  /\binsert\s+into\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(\s*([A-Za-z_][A-Za-z0-9_]*)[^)]*\)\s*values\s*\(\s*'((?:[^']|'')*)'/gi;

/** `insert into` の出現。拾えた数と突き合わせて、拾い漏れを落とすために数える。 */
const INSERT_HEAD_RE = /\binsert\s+into\b/gi;

/**
 * 行頭のコメント（`-- …`）を外す。
 *
 * **行の途中の `--` は外さない。** 文字列リテラルの中の `--` まで落とすと、仕込みの
 * 本文を壊して拾い漏れる。仕込みのコメントは行頭に書く決まりにしてある。
 *
 * @param {string} sql 仕込みの SQL
 * @returns {string} コメントを外した SQL
 */
export function stripLineComments(sql) {
  return sql
    .split('\n')
    .filter((line) => !/^\s*--/.test(line))
    .join('\n');
}

/**
 * 仕込みの本文から「在るはずの行」を導く。
 *
 * @param {string} sql 仕込みの SQL（`--file` へ渡すものそのもの）
 * @returns {{ table: string, column: string, value: string, label: string }[]} 在るはずの行
 * @throws {Error} 1 件も拾えないとき、または `insert into` の数と食い違うとき
 */
export function seedExpectations(sql) {
  const body = stripLineComments(sql);
  const declared = (body.match(INSERT_HEAD_RE) ?? []).length;

  /** @type {{ table: string, column: string, value: string, label: string }[]} */
  const expectations = [];
  for (const match of body.matchAll(INSERT_RE)) {
    const [, table, column, value] = match;
    expectations.push({
      table: String(table),
      column: String(column),
      value: String(value),
      label: `${table}.${column}=${value}`,
    });
  }

  if (declared === 0 || expectations.length === 0) {
    throw new Error(
      '仕込みの本文から insert を 1 つも読めませんでした。' +
        'scripts/lib/dev-fixture.sh の seed.sql が空か、綴りが変わっています。',
    );
  }
  if (declared !== expectations.length) {
    throw new Error(
      `仕込みには insert が ${declared} 件ありますが、読めたのは ${expectations.length} 件です。` +
        "insert into <表> (<列>, …) values ('<値>', …) の綴りから外れた行があります。",
    );
  }
  const labels = new Set();
  for (const { label } of expectations) {
    if (labels.has(label)) {
      throw new Error(
        `仕込みに同じ名前の行が 2 つあります: ${label}。` +
          '名前は数える列の名前になるので、重ならない値にしてください。',
      );
    }
    labels.add(label);
  }
  return expectations;
}

/**
 * SQL の文字列リテラルとして埋める（`'` を 2 つに畳む）。
 *
 * @param {string} value 値
 * @returns {string} リテラル（引用符を含む）
 */
function literal(value) {
  return `'${value.replaceAll("'", "''")}'`;
}

/**
 * SQL の識別子として埋める（`"` を 2 つに畳む）。
 *
 * @param {string} name 名前
 * @returns {string} 識別子（引用符を含む）
 */
function identifier(name) {
  return `"${name.replaceAll('"', '""')}"`;
}

/**
 * 「在るはずの行」を数える問い合わせを組み立てる。
 *
 * **1 文・1 行・名前ごとに 1 列**にする。`union all` で縦に並べる形も書けるが、
 * **D1 は複合 SELECT の項数に上限を持ち**（実測で `too many terms in compound SELECT`）、
 * 仕込みが育つと問い合わせのほうが先に落ちる。列に並べれば、増えるのは列の数だけである。
 *
 * @param {{ table: string, column: string, value: string, label: string }[]} expectations 在るはずの行
 * @returns {string} 問い合わせ（名前を列の名前に持ち、値がその件数の 1 行）
 */
export function verificationSql(expectations) {
  const columns = expectations.map(
    ({ table, column, value, label }) =>
      `  (select count(*) from ${table} where ${column} = ${literal(value)}) as ${identifier(label)}`,
  );
  return `select\n${columns.join(',\n')};\n`;
}

/**
 * `wrangler d1 execute --json` の出力から、入っていない行の名前を返す。
 *
 * @param {{ label: string }[]} expectations 在るはずの行
 * @param {unknown} payload `--json` の出力を JSON.parse したもの
 * @returns {string[]} 入っていない行の名前（空なら合格）
 */
export function missingRows(expectations, payload) {
  /** @type {Record<string, unknown>} */
  let counts = {};
  for (const entry of Array.isArray(payload) ? payload : [payload]) {
    const results = entry && typeof entry === 'object' ? entry.results : undefined;
    if (!Array.isArray(results)) {
      continue;
    }
    for (const row of results) {
      if (row && typeof row === 'object') {
        counts = { ...counts, ...row };
      }
    }
  }
  return expectations
    .filter(({ label }) => !(Number(counts[label]) >= 1))
    .map(({ label }) =>
      Object.hasOwn(counts, label) ? label : `${label}（問い合わせが返しませんでした）`,
    );
}

/**
 * `--json` の出力を取り出す。
 *
 * wrangler は前置きの行を混ぜることがあるので、**最初の `[` から末尾まで**を読む。
 *
 * @param {string} text 出力の全文
 * @returns {unknown} JSON
 */
export function parseD1Json(text) {
  const start = text.indexOf('[');
  if (start < 0) {
    throw new Error(`d1 execute --json の出力に JSON がありません: ${text.slice(0, 200)}`);
  }
  return JSON.parse(text.slice(start));
}

/**
 * 組み込みの自己検査。**判定そのものを、wrangler も D1 も使わずに確かめる。**
 *
 * この道具は workerd（vitest）から呼べない（Node のファイルと外部コマンドの上にある）ので、
 * `scripts/*-verdict.mjs` と同じく、自分で自分を検査する形にしてある。
 *
 * @throws {Error} 期待と違う結果になったとき
 */
export function selftest() {
  /** @param {boolean} ok @param {string} what */
  const assert = (ok, what) => {
    if (!ok) {
      throw new Error(`自己検査に失敗しました: ${what}`);
    }
  };

  const sql = [
    "-- insert into ignored (id) values ('comment');",
    "insert into users (id, name) values ('u1', 'ゆーざー');",
    'insert into games (id, author_id)',
    "  values ('g1', 'u1');",
    "update games set title = 'x' where id = 'g1';",
  ].join('\n');

  const expectations = seedExpectations(sql);
  assert(expectations.length === 2, `insert を 2 件拾うこと（拾えたのは ${expectations.length} 件）`);
  assert(expectations[0].label === 'users.id=u1', `1 件目の名前（${expectations[0].label}）`);
  assert(expectations[1].label === 'games.id=g1', `2 件目の名前（${expectations[1].label}）`);
  assert(!verificationSql(expectations).includes('update'), 'update を数えないこと');
  assert(
    verificationSql(expectations).includes("count(*) from games where id = 'g1'"),
    '在るはずの行を数える問い合わせになること',
  );

  const payload = [{ results: [{ 'users.id=u1': 1, 'games.id=g1': 0 }] }];
  const missing = missingRows(expectations, payload);
  assert(
    missing.length === 1 && missing[0] === 'games.id=g1',
    `入っていない行の名前が出ること（${missing.join(' / ')}）`,
  );
  assert(
    missingRows(expectations, [{ results: [{ 'users.id=u1': 1 }] }]).length === 1,
    '返らなかった行も落とすこと',
  );
  assert(missingRows(expectations, [{ results: [] }]).length === 2, '1 行も返らない出力を合格にしないこと');

  let threw = false;
  try {
    seedExpectations("insert into users (id) values ('u1');\ninsert into users (id) values ('u1');");
  } catch {
    threw = true;
  }
  assert(threw, '同じ名前が 2 つある本文を落とすこと');

  threw = false;
  try {
    seedExpectations("update games set title = 'x';");
  } catch {
    threw = true;
  }
  assert(threw, 'insert が 1 件も無い本文を落とすこと');

  threw = false;
  try {
    // 値がリテラルでない（綴りが規約から外れた）insert は拾えない。**黙って対象外にしない。**
    seedExpectations("insert into users (id, name) values (?, 'x');");
  } catch {
    threw = true;
  }
  assert(threw, '拾えない insert がある本文を落とすこと');

  assert(
    Array.isArray(parseD1Json('  \n[{"results":[]}]')),
    '前置きのある出力からも JSON を読めること',
  );
}

/**
 * コマンドとして呼ばれたときの入口。
 *
 * @param {string[]} argv `process.argv.slice(2)`
 * @returns {Promise<number>} 終了コード
 */
async function main(argv) {
  const [mode, ...rest] = argv;
  if (mode === '--selftest') {
    selftest();
    console.log('DEV_FIXTURE_SEED_CHECK_SELFTEST_PASS');
    return 0;
  }

  const fs = await import('node:fs');
  if (mode === 'plan') {
    const [seedPath] = rest;
    if (seedPath === undefined) {
      console.error('使い方: dev-fixture-seed-check.mjs plan <seed.sql>');
      return 1;
    }
    process.stdout.write(verificationSql(seedExpectations(fs.readFileSync(seedPath, 'utf8'))));
    return 0;
  }

  if (mode === 'judge') {
    const [seedPath, jsonPath] = rest;
    if (seedPath === undefined || jsonPath === undefined) {
      console.error('使い方: dev-fixture-seed-check.mjs judge <seed.sql> <d1-json>');
      return 1;
    }
    const expectations = seedExpectations(fs.readFileSync(seedPath, 'utf8'));
    const missing = missingRows(expectations, parseD1Json(fs.readFileSync(jsonPath, 'utf8')));
    if (missing.length > 0) {
      for (const label of missing) {
        console.error(`  入っていない行: ${label}`);
      }
      console.error(
        `  仕込んだはずの ${expectations.length} 件のうち ${missing.length} 件が D1 にありません。`,
      );
      return 1;
    }
    console.log(`${expectations.length}`);
    return 0;
  }

  console.error(`知らないコマンドです: ${mode ?? '（無し）'}`);
  return 1;
}

// **読み込まれたときは何もしない。** 上の関数は自己検査から呼ぶ。
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch (error) {
    console.error(`  ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
