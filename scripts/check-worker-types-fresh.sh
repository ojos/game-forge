#!/usr/bin/env bash
# check-worker-types-fresh.sh — worker-configuration.d.ts が wrangler.toml より古くないことの、
# ループの反復ごとに回せる安価な照合。
#
# 位置づけ:
#   worker-configuration.d.ts は `wrangler types` の生成物で、**追跡していない**
#   （共通規範「再生成できる大容量の生成物はコミットしない」）。生成は package.json の
#   `prepare`（`npm ci` / `npm install` の後）に結ばれているため、**`npm ci` を打たない
#   worktree では走らない。** wrangler.toml へ [vars] を 1 つ足した PR が入った時点で、
#   既存の全 worktree の生成物が黙って古くなる。
#
#   古い生成物のまま反復すると、こう出る（#175。**第 4 波で 4 者が同じ赤を踏んだ**）:
#
#       test/orchestrator.test.ts: error TS2339:
#         Property 'ORCHESTRATOR_FUNCTION_NAME' does not exist on type 'Env'
#
#   **これは自分の変更と無関係な赤で、しかも原因が読み取りにくい。** 直し方（`npm run types`
#   を 1 回）は 1 行だが、それを知らないと自分の変更を疑う。scripts/check-deps-installed.sh
#   の冒頭が書いているのと同じ種類の事故が、別の生成物で起きている。
#
#   検査するのは「再生成したか」ではなく「宣言に追いついているか」である。
#
# なぜ scripts/check-worker-types.sh と別に置くのか:
#   あちらは `wrangler types` を実際に走らせて全行を突き合わせる**完全な照合**で、
#   これは正しいが**外側（acceptance）にしか置けない値段**である（実測 0.6〜1.0 秒。
#   しかもファイルを 1 つ生成する）。#175 が問題にしているのは**ループの反復**
#   （`npm run typecheck` / `npm test`）が読めない赤で落ちることなので、反復に置ける
#   安さの検査が要る。
#
#   そこでこちらは **`wrangler types` を走らせない。** wrangler.toml（宣言）と
#   worker-configuration.d.ts（生成物）を**テキストとして直接読み比べる**。
#   `check-deps-installed.sh` が package-lock.json（宣言）と node_modules/.package-lock.json
#   （実体）を比べているのと同じ形で、**3 方向**を見る:
#
#     - 宣言にあって生成物に無い … [vars] / バインディングを足したのに再生成していない
#                                  （#175 で踏んだ経路。TS2339 として現れる）
#     - 生成物にあって宣言に無い … 宣言から消したのに再生成していない
#     - 値が食い違う             … var の値を変えたのに再生成していない
#                                  （`wrangler types` は既定で var を文字列リテラル型に
#                                  するため、値の変更は型の変更として現れる）
#
#   加えて compatibility_date / compatibility_flags を見る（生成物の 3 行目
#   `// Runtime types generated with workerd@<版> <日付> <フラグ>` が写している）。
#
#   **実測 20 ms**（10 回で 0.195 秒。同じ形の check-deps-installed.sh が 15 ms）。
#   ループの反復ごとに通ることを前提にした値段である。全行を突き合わせる
#   check-worker-types.sh は 0.6〜1.0 秒なので、1 桁半の差がある。
#
# **直さない。落とすだけである。**
#   `check-deps-installed.sh` と同じ判断で、根拠も同じである——ゲートの役割は判定であって
#   環境の修復ではない。黙って `wrangler types` を走らせると、何が起きたのかが見えないまま
#   Env の型だけが変わる。**この生成物にはもう 1 つ、あちらに無い理由がある**: 生成結果が
#   手元の環境に依存する。wrangler は既定でリポジトリ直下の .env をシークレットとして
#   読み込み、それが Env の面に現れる。ゲートが勝手に生成すると、**環境変数の設定次第で
#   型の面が変わる**ことになる。`npm run types` は
#   `CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV=false` を明示して呼ぶ入口なので、
#   **人（またはエージェント）がその 1 本を通す**ほうが、結果が読める。
#
# .dev.vars を宣言側に数える理由:
#   `wrangler types` は .dev.vars のキーも Env のメンバ（`: string`）として出す
#   （実測で確認した）。数えないと、.dev.vars を持つ端末では毎回「生成物にあって宣言に
#   無い」が並ぶ**偽の赤**になる。値は見ない（シークレットであり、型は常に `string`）。
#
# この検査が約束しないこと（**網羅ではない**）:
#   - 見るのは **Env のメンバの名前と、var の値と、compatibility_date / flags** だけである。
#     ランタイム型 14,000 行の一致は見ない。それは scripts/check-worker-types.sh が持つ。
#   - 宣言側で読むのは **[vars] 系のテーブルと `binding = "..."` を持つテーブル**だけである。
#     `[[durable_objects.bindings]]` のように別の綴りでバインディングを宣言する形は
#     読まない（このリポジトリには無い）。**緑でも古いことはありうる。** 完全な照合は
#     acceptance の check-worker-types.sh が引き受ける。この検査が引き受けるのは
#     「**反復のたびに、ほぼ全ての実例を、原因の読める赤で捕まえる**」ことである。
#   - node_modules の workerd の版は見ない。生成物と node_modules のずれは `npm ci` の
#     prepare が閉じており、package-lock.json と node_modules のずれは
#     check-deps-installed.sh が持つ。ここで重ねると、同じ赤が 2 か所から出る。
#
# どこから呼ばれるか:
#   - package.json の `typecheck` / `test`（**ここが本命**。#175 が問題にしている
#     「ループの反復が読めない赤で落ちる」を塞ぐには、落ちる当のコマンドの手前へ
#     置くしかない）
#   - scripts/acceptance.sh の node ブロック（check-deps-installed.sh の直後。
#     受け入れ検証としても、npm test より前に落ちることを明示しておく）
#
# 終了コード:
#   0 = WORKER_TYPES_FRESH_PASS
#   1 = WORKER_TYPES_FRESH_FAIL（古い、または検査が成立しなかった）
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$(dirname "$HERE")"

CURRENT="worker-configuration.d.ts"

fail() {
  printf '[worker-types-fresh] %s\n' "$1" >&2
  echo "WORKER_TYPES_FRESH_FAIL"
  exit 1
}

# 検査が成立しない状態を合格にしない（verify.sh の既定方針）。
[[ -f wrangler.toml ]] || fail "wrangler.toml がありません。照合の対象がありません。"
[[ -f "$CURRENT" ]] || fail "$CURRENT がありません。'npm run types' を実行してください（'npm ci' の prepare でも生成されます）。"

command -v node >/dev/null 2>&1 || fail "node が見つかりません。Node.js を導入してください。"

# 比較そのものは node で行う。理由は check-deps-installed.sh と同じで、テキストを
# 正しく読む道具が要り、node はこの検査の対象（Node プロジェクト）に必ず存在するため、
# 新しい依存を増やさずに済む。差分は先頭 10 件だけ出す。全件出しても取るべき行動
# （`npm run types`）は変わらず、大量の行で「対処」が画面から流れると読めない赤になる。
if ! diff_report="$(node - <<'JS'
const fs = require('fs');

const TYPES_FILE = 'worker-configuration.d.ts';
const CONFIG_FILE = 'wrangler.toml';
const DEV_VARS_FILE = '.dev.vars';

/**
 * 行から TOML のコメント（引用符の外にある `#` 以降）を落とす。
 * @param {string} line 元の行
 * @returns {string} コメントを除いた行
 */
function stripComment(line) {
  let out = '';
  let quote = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote !== null) {
      out += c;
      // 基本文字列（"）だけがエスケープを持つ。リテラル文字列（'）は持たない。
      if (quote === '"' && c === '\\' && i + 1 < line.length) {
        out += line[++i];
        continue;
      }
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      out += c;
      continue;
    }
    if (c === '#') break;
    out += c;
  }
  return out;
}

/**
 * TOML の基本文字列のエスケープを、このリポジトリで実際に使う範囲だけ戻す。
 * @param {string} body 引用符を外した中身
 * @returns {string} エスケープを解いた文字列
 */
function unescapeBasic(body) {
  return body.replace(/\\(["\\nrt])/g, (_, c) =>
    ({ '"': '"', '\\': '\\', n: '\n', r: '\r', t: '\t' })[c]
  );
}

/**
 * TOML の値を読む。**文字列だと確信できるときだけ値を返す。**
 * 読めない形（配列・多行文字列・数値・真偽値など）は kind:'other' として値の照合から外す。
 * 分からないものを推測して照合すると、偽の赤になる。
 * @param {string} raw `=` の右辺（コメント除去済み）
 * @returns {{kind: 'string', value: string} | {kind: 'other'}}
 */
function parseValue(raw) {
  const s = raw.trim();
  if (s.length >= 2 && s.startsWith('"') && s.endsWith('"') && !s.startsWith('"""')) {
    return { kind: 'string', value: unescapeBasic(s.slice(1, -1)) };
  }
  if (s.length >= 2 && s.startsWith("'") && s.endsWith("'") && !s.startsWith("'''")) {
    return { kind: 'string', value: s.slice(1, -1) };
  }
  return { kind: 'other' };
}

/**
 * wrangler.toml を行単位で走査し、Env の面に現れる宣言だけを集める。
 * @param {string} text wrangler.toml の中身
 * @returns {{vars: Map<string, {values: Set<string>, hasOther: boolean}>, bindings: Set<string>, compatDate: string|null, compatFlags: string[]}}
 */
function scanConfig(text) {
  const vars = new Map();
  const bindings = new Set();
  let compatDate = null;
  let compatFlags = [];
  let table = '';

  for (const rawLine of text.split('\n')) {
    const line = stripComment(rawLine).trim();
    if (line === '') continue;

    const header = line.match(/^\[\[?\s*([^\]]+?)\s*\]\]?$/);
    if (header) {
      table = header[1].replace(/"/g, '').replace(/'/g, '');
      continue;
    }

    const kv = line.match(/^["']?([A-Za-z0-9_.-]+)["']?\s*=\s*(.+)$/);
    if (!kv) continue;
    const key = kv[1];
    const value = parseValue(kv[2]);

    // [vars] と [env.<名前>.vars]。どちらのキーも __BaseEnv_Env へ集約される。
    if (table === 'vars' || /^env\.[^.]+\.vars$/.test(table)) {
      let entry = vars.get(key);
      if (!entry) {
        entry = { values: new Set(), hasOther: false };
        vars.set(key, entry);
      }
      if (value.kind === 'string') entry.values.add(value.value);
      else entry.hasOther = true;
      continue;
    }

    // バインディングは、どのテーブルであっても `binding = "名前"` の綴りで宣言される
    // （d1_databases / r2_buckets / kv_namespaces / services / queues.producers …）。
    if (key === 'binding' && table !== '' && value.kind === 'string') {
      bindings.add(value.value);
      continue;
    }

    if (table === '' && key === 'compatibility_date' && value.kind === 'string') {
      compatDate = value.value;
      continue;
    }
    if (table === '' && key === 'compatibility_flags') {
      compatFlags = [...kv[2].matchAll(/"([^"]*)"|'([^']*)'/g)].map((m) => m[1] ?? m[2]);
      continue;
    }
  }

  return { vars, bindings, compatDate, compatFlags };
}

/**
 * .dev.vars（Worker から見えるシークレット）のキー名を読む。値は見ない。
 * @param {string} text .dev.vars の中身
 * @returns {Set<string>} キー名
 */
function scanDevVars(text) {
  const keys = new Set();
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;
    const m = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/);
    if (m) keys.add(m[1]);
  }
  return keys;
}

/**
 * 生成物から Env のメンバ（名前 -> 型の文字列）と、ランタイムのヘッダ行を読む。
 * @param {string} text worker-configuration.d.ts の中身
 * @returns {{members: Map<string, string>, runtimeHeader: string|null} | null} 形が読めなければ null
 */
function scanTypes(text) {
  const lines = text.split('\n');
  const runtimeHeader =
    lines.find((l) => l.startsWith('// Runtime types generated with workerd@')) ?? null;

  // 名前付き環境があると集約用の __BaseEnv_Env が出る。無い構成では Env が本体になる。
  let start = lines.findIndex((l) => /^interface __BaseEnv_\w+ \{$/.test(l));
  if (start === -1) start = lines.findIndex((l) => /^interface \w+ \{$/.test(l));
  if (start === -1) return null;

  const members = new Map();
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i] === '}') return { members, runtimeHeader };
    const m = lines[i].match(/^\s*["']?([A-Za-z0-9_$-]+)["']?\??\s*:\s*(.+);\s*$/);
    if (m) members.set(m[1], m[2].trim());
  }
  return null;
}

/**
 * 型が文字列リテラルの合併（`"a" | "b"`）なら、その集合を返す。
 * `string` や他の型（バインディングやシークレット）は null を返し、値の照合から外す。
 * @param {string} type 型の文字列
 * @returns {Set<string>|null}
 */
function literalUnion(type) {
  const parts = type.split('|').map((p) => p.trim());
  const values = new Set();
  for (const p of parts) {
    if (!/^"(?:[^"\\]|\\.)*"$/.test(p)) return null;
    values.add(unescapeBasic(p.slice(1, -1)));
  }
  return values;
}

const config = scanConfig(fs.readFileSync(CONFIG_FILE, 'utf8'));
const devVars = fs.existsSync(DEV_VARS_FILE)
  ? scanDevVars(fs.readFileSync(DEV_VARS_FILE, 'utf8'))
  : new Set();
const generated = scanTypes(fs.readFileSync(TYPES_FILE, 'utf8'));

const problems = [];

if (generated === null) {
  console.log('1');
  console.log(`${TYPES_FILE} から Env の宣言を読み取れませんでした（生成物の形が想定と違います）。`);
  process.exit(1);
}

// 宣言側の名前。どこ由来かを添える（対処は同じだが、どの宣言を足したのかが読める）。
const declared = new Map();
for (const name of config.vars.keys()) declared.set(name, 'wrangler.toml の [vars]');
for (const name of config.bindings) declared.set(name, 'wrangler.toml のバインディング');
for (const name of devVars) declared.set(name, `${DEV_VARS_FILE} のキー`);

// 1. 宣言にあって生成物に無い（#175 で踏んだ経路。TS2339 として現れる）
for (const [name, origin] of declared) {
  if (!generated.members.has(name)) problems.push(`生成物に無い: ${name}（${origin}）`);
}

// 2. 生成物にあって宣言に無い
for (const name of generated.members.keys()) {
  if (!declared.has(name)) problems.push(`宣言に無い: ${name}（生成物にだけあります）`);
}

// 3. 値が食い違う。**生成物側が文字列リテラルの合併のときだけ見る。**
//    `string` になるのはシークレット（.dev.vars）か --strict-vars=false の生成物で、
//    どちらも値を写していないため、比べると偽の赤になる。
for (const [name, entry] of config.vars) {
  if (devVars.has(name)) continue;
  if (entry.hasOther) continue;
  const type = generated.members.get(name);
  if (type === undefined) continue;
  const got = literalUnion(type);
  if (got === null) continue;
  const want = [...entry.values].sort();
  const have = [...got].sort();
  if (want.join('\u0000') !== have.join('\u0000')) {
    problems.push(`値ちがい: ${name} 宣言=${want.join(' | ')} 生成物=${have.join(' | ')}`);
  }
}

// 4. compatibility_date / compatibility_flags。生成物の 3 行目が写している:
//    `// Runtime types generated with workerd@<版> <日付> <フラグをソートしてカンマ連結>`
if (config.compatDate !== null) {
  if (generated.runtimeHeader === null) {
    problems.push('ランタイム型のヘッダ行がありません（生成物が途中で壊れています）。');
  } else {
    const rest = generated.runtimeHeader.slice(
      '// Runtime types generated with workerd@'.length
    );
    const fields = rest.split(' ');
    const gotDate = fields[1] ?? '';
    const gotFlags = fields[2] ?? '';
    const wantFlags = [...config.compatFlags].sort().join(',');
    if (gotDate !== config.compatDate) {
      problems.push(`compatibility_date ちがい: 宣言=${config.compatDate} 生成物=${gotDate}`);
    }
    if (gotFlags !== wantFlags) {
      problems.push(`compatibility_flags ちがい: 宣言=${wantFlags || '(なし)'} 生成物=${gotFlags || '(なし)'}`);
    }
  }
}

if (problems.length === 0) process.exit(0);
console.log(String(problems.length));
for (const line of problems.slice(0, 10)) console.log(line);
if (problems.length > 10) console.log(`... 他 ${problems.length - 10} 件`);
process.exit(1);
JS
)"; then
  # node 自身が落ちた場合（生成物が読めない等）も、ここへ来る。
  #
  # **node の stderr は捕捉していない**（`2>&1` を付けていない）ので、`diff_report` は
  # 空になり、下の分岐が読めるメッセージを出す。混ぜると、スタックの 1 行目を件数として
  # 表示してしまう（check-deps-installed.sh に同じ注記がある）。
  if [[ -z "$diff_report" ]]; then
    printf '[worker-types-fresh] ---- 上は node の出力 ----\n' >&2
    fail "wrangler.toml / $CURRENT を読めませんでした。'npm run types' を実行して生成し直してください。"
  fi

  # 先頭行が件数（数字）でなければ、想定外の出力である。**件数として表示しない。**
  if [[ ! "$(printf '%s\n' "$diff_report" | head -1)" =~ ^[0-9]+$ ]]; then
    printf '[worker-types-fresh] 照合が想定外の出力を返しました。そのまま出します:\n' >&2
    printf '%s\n' "$diff_report" | sed 's/^/[worker-types-fresh]     /' >&2
    echo "WORKER_TYPES_FRESH_FAIL"
    exit 1
  fi

  count="$(printf '%s\n' "$diff_report" | head -1)"
  printf '[worker-types-fresh] %s が wrangler.toml の宣言より古くなっています（差分 %s 件）:\n' "$CURRENT" "$count" >&2
  printf '%s\n' "$diff_report" | tail -n +2 | sed 's/^/[worker-types-fresh]     /' >&2
  printf '[worker-types-fresh] 対処: npm run types\n' >&2
  printf '[worker-types-fresh] （%s は wrangler types の生成物で、追跡していません。wrangler.toml を\n' "$CURRENT" >&2
  printf '[worker-types-fresh]   変えた PR を取り込むと、npm ci を打っていない worktree では古いまま残ります。#175）\n' >&2
  printf '[worker-types-fresh] このゲートは自動で直しません（判定と修復を混ぜると、何が起きたのかが見えなくなるため）。\n' >&2
  echo "WORKER_TYPES_FRESH_FAIL"
  exit 1
fi

echo "WORKER_TYPES_FRESH_PASS"
