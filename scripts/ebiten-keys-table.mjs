#!/usr/bin/env node
// ebiten-keys-table.mjs — Ebitengine のキーの表を、Ebitengine のソースから生成し、写しと照合する（#493 / 仕様 3.9.5）
//
// ## なぜ要るのか
//
// 作品が読むキー（仕様 3.9.5）は、ソースの `ebiten.Key*` の名前をブラウザの `KeyboardEvent.code` へ写して
// 保存する。**その対応表は Ebitengine のソースの写しである**（`keys.go` の `Key*` 定数と、
// `internal/ui/keys_js.go` の `uiKeyToJSCode`）。写しは必ず古くなる——Ebitengine の版を上げた日に、
// 増えたキーや変わった対応が表に無いまま通る（shared-ai-rules 12 章「一覧の複製は機械照合で担保する」）。
//
// **だから表を手で書かない。** このスクリプトが Ebitengine のソースから `src/ebiten-keys.generated.ts` を
// 生成し、`--check` で「今のソースから作り直したものと、コミットされたものが 1 バイトも違わない」ことを見る。
//
// ## 使い方
//
//   node scripts/ebiten-keys-table.mjs --write   # 生成してファイルへ書く
//   node scripts/ebiten-keys-table.mjs --check   # 照合する（scripts/acceptance.sh が呼ぶ）
//
// 標準出力の最終行:
//   EBITEN_KEYS_PASS          — 版・go.sum の h1・表の中身がすべて一致した
//   EBITEN_KEYS_VERSION_ONLY  — CI で、Ebitengine のソースが手元に無い。版と h1 の一致だけを確かめた（下記）
//   EBITEN_KEYS_FAIL          — 一致しない、または照合が成立しない
//
// 終了コード: 0 = PASS / VERSION_ONLY、1 = FAIL
//
// ## 照合の 2 段（ソースが無い環境をどう扱うか）
//
// **1 段目（どこでも走る）: 版と go.sum の h1。** 生成したファイルは、生成に使ったモジュールの版と、
// `docker/isolated-build/template/go.sum` にある `h1:` のハッシュを持つ。これが今の go.mod / go.sum と
// 違えば落とす。**Ebitengine の版を上げて表を作り直し忘れた、はここで必ず捕まる。** Go のモジュールは
// 版ごとに中身が不変で、h1 はその中身のハッシュである（go.sum が保証する）。
//
// **2 段目（ソースがあるときだけ走れる）: 表の中身。** Go のモジュールキャッシュ
// （`$GOMODCACHE/github.com/hajimehoshi/ebiten/v2@<版>`）から作り直し、コミットされたファイルと比べる。
//
// **ソースが無いときの扱いを環境で分ける。**
//
// - **CI（`CI=true`）では、2 段目が成立しないことを明示して `EBITEN_KEYS_VERSION_ONLY` で抜ける。**
//   `.github/workflows/verify.yml` のジョブは Go のモジュールキャッシュを持たず、取りに行くにはネットワークが要る
//   （受け入れ検証のローカル層へ外部の可用性を持ち込まない。`.github/project-ai-rules.md`）。失敗にすると
//   CI が恒常的に赤くなり、赤が定常のゲートは誰も見なくなる。**合格の綴り（PASS）は出さない。**
// - **それ以外（手元・devcontainer）では落とす。** devcontainer は Go とモジュールキャッシュを持っており、
//   `scripts/loop-gate.sh` はここで 2 段目まで走る。無いのは「照合していない」のであって「一致した」ではない。
//
// **GNU 拡張も依存パッケージも使わない**（Node だけで動く。`scripts/check-token-contrast.mjs` と同じ）。
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const GO_MOD = path.join(ROOT, 'docker', 'isolated-build', 'template', 'go.mod');
const GO_SUM = path.join(ROOT, 'docker', 'isolated-build', 'template', 'go.sum');
const OUTPUT = path.join(ROOT, 'src', 'ebiten-keys.generated.ts');
const MODULE_PATH = 'github.com/hajimehoshi/ebiten/v2';
const TAG = '[ebiten-keys]';

/**
 * 左右の区別の無い名前（仕様 3.9.5 の 2）。**左へ写す**——Ebitengine は左右どちらかが押されていれば押下と見る。
 * `keys_js.go` の表に無い名前のうち、この 4 つだけを許す。**ほかの名前が表に無ければ落とす**（黙って捨てない）。
 */
const SIDELESS_TO_LEFT = ['Alt', 'Control', 'Meta', 'Shift'];

/**
 * `ui.Key*` を経由しない定数のうち、捨てる名前（仕様 3.9.5 の 2「表に無い名前は捨てる」の `KeyMax`）。
 * **ほかの形の定数が現れたら落とす**——版を上げたときに、新しい書き方を黙って捨てないため。
 */
const DISCARDED_ALIASES = ['Max'];

/**
 * 失敗を報告して終わる。
 *
 * @param {string[]} lines 標準エラーへ出す行
 * @returns {never}
 */
function fail(lines) {
  for (const line of lines) {
    console.error(`${TAG} ${line}`);
  }
  console.log('EBITEN_KEYS_FAIL');
  process.exit(1);
}

/**
 * go.mod から Ebitengine の版を読む。**1 行だけあること**まで見る。
 *
 * @returns {string} 版（例: `v2.9.9`）
 */
function readModuleVersion() {
  const lines = readFileSync(GO_MOD, 'utf8').split('\n');
  const versions = [];
  for (const line of lines) {
    // コメントの中の `github.com/hajimehoshi/ebiten/v2/audio` を拾わない。行頭（空白の後）で、版が続く形だけ。
    const match = /^\s*github\.com\/hajimehoshi\/ebiten\/v2\s+(v[0-9][^\s]*)\s*(?:\/\/.*)?$/.exec(line);
    if (match) {
      versions.push(match[1]);
    }
  }
  if (versions.length !== 1) {
    fail([`${path.relative(ROOT, GO_MOD)} に ${MODULE_PATH} の版が 1 行だけありません（${versions.length} 行）。`]);
  }
  return versions[0];
}

/**
 * go.sum から、その版のモジュールの `h1:` を読む（`/go.mod` の行ではないほう）。
 *
 * @param {string} version 版
 * @returns {string} `h1:...`
 */
function readModuleSum(version) {
  const prefix = `${MODULE_PATH} ${version} `;
  const sums = readFileSync(GO_SUM, 'utf8')
    .split('\n')
    .filter((line) => line.startsWith(prefix))
    .map((line) => line.slice(prefix.length).trim());
  if (sums.length !== 1 || !sums[0].startsWith('h1:')) {
    fail([`${path.relative(ROOT, GO_SUM)} に ${MODULE_PATH} ${version} の h1 が 1 行だけありません。`]);
  }
  return sums[0];
}

/**
 * Go のモジュールキャッシュの場所。`GOMODCACHE` → `go env GOMODCACHE` → `$HOME/go/pkg/mod` の順に引く。
 *
 * @returns {string} 置き場所
 */
function moduleCacheDir() {
  if (process.env.GOMODCACHE) {
    return process.env.GOMODCACHE;
  }
  try {
    const out = execFileSync('go', ['env', 'GOMODCACHE'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    if (out !== '') {
      return out;
    }
  } catch {
    // go が無い。既定の場所を見る（無ければ呼ぶ側が「ソースが無い」として扱う）。
  }
  return path.join(homedir(), 'go', 'pkg', 'mod');
}

/**
 * `internal/ui/keys_js.go` の `uiKeyToJSCode` を読む。
 *
 * @param {string} text ファイルの中身
 * @returns {Map<string, string>} `ui.Key` の名前（`Key` を除く）→ `code`
 */
function parseJsCodes(text) {
  const start = text.indexOf('var uiKeyToJSCode = map[Key]js.Value{');
  if (start < 0) {
    fail(['keys_js.go に uiKeyToJSCode が見つかりません（Ebitengine の書き方が変わった）。']);
  }
  const end = text.indexOf('\n}', start);
  const body = text.slice(start, end);
  const codes = new Map();
  for (const line of body.split('\n').slice(1)) {
    if (line.trim() === '') {
      continue;
    }
    const match = /^\s*Key([A-Za-z0-9]+):\s*js\.ValueOf\("([A-Za-z0-9]+)"\),$/.exec(line);
    if (!match) {
      fail([`keys_js.go の uiKeyToJSCode に読めない行があります: ${line.trim()}`]);
    }
    codes.set(match[1], match[2]);
  }
  if (codes.size === 0) {
    fail(['keys_js.go の uiKeyToJSCode が空です。']);
  }
  return codes;
}

/**
 * `keys.go` の `Key*` 定数を、`code` へ写す。
 *
 * @param {string} text ファイルの中身
 * @param {Map<string, string>} jsCodes {@link parseJsCodes} の結果
 * @returns {Map<string, string>} `ebiten.Key` の名前（`Key` を除く）→ `code`
 */
function mapKeyConstants(text, jsCodes) {
  const start = text.indexOf('\n// Keys.\nconst (');
  if (start < 0) {
    fail(['keys.go に Key の定数の宣言（// Keys. const (）が見つかりません。']);
  }
  const end = text.indexOf('\n)', start);
  const body = text.slice(start, end);
  const table = new Map();
  const discarded = [];
  for (const raw of body.split('\n').slice(3)) {
    const line = raw.trim();
    if (line === '' || line.startsWith('//')) {
      continue;
    }
    const viaUi = /^Key([A-Za-z0-9]+)\s+Key\s*=\s*Key\(ui\.Key([A-Za-z0-9]+)\)$/.exec(line);
    if (viaUi) {
      const [, name, uiName] = viaUi;
      const code = jsCodes.get(uiName);
      if (code !== undefined) {
        table.set(name, code);
        continue;
      }
      if (SIDELESS_TO_LEFT.includes(uiName) && jsCodes.has(`${uiName}Left`)) {
        table.set(name, jsCodes.get(`${uiName}Left`));
        continue;
      }
      fail([`keys.go の Key${name} が指す ui.Key${uiName} は keys_js.go の表にありません（規則 3.9.5 の外の形）。`]);
    }
    const alias = /^Key([A-Za-z0-9]+)\s+Key\s*=\s*Key([A-Za-z0-9]+)$/.exec(line);
    if (alias && DISCARDED_ALIASES.includes(alias[1])) {
      discarded.push(alias[1]);
      continue;
    }
    fail([`keys.go に読めない定数があります: ${line}`]);
  }
  for (const name of DISCARDED_ALIASES) {
    if (!discarded.includes(name)) {
      fail([`keys.go に Key${name} がありません（捨てる名前の一覧が古い）。`]);
    }
  }
  if (table.size === 0) {
    fail(['keys.go の Key の定数が 0 件です。']);
  }
  return table;
}

/**
 * 生成するファイルの中身を組み立てる。**決定的である**（名前の順に並べる）。
 *
 * @param {string} version 版
 * @param {string} sum go.sum の h1
 * @param {Map<string, string>} table 名前 → `code`
 * @returns {string} ファイルの中身
 */
function render(version, sum, table) {
  const names = [...table.keys()].sort();
  const codes = [...new Set(table.values())].sort();
  const lines = [
    '/**',
    ' * Ebitengine のキーの表（仕様 3.9.5 / #493）。**このファイルは生成物である。手で書き換えない。**',
    ' *',
    ` * - 正本: \`${MODULE_PATH}@${version}\` の \`keys.go\`（\`Key*\` 定数）と \`internal/ui/keys_js.go\`（\`uiKeyToJSCode\`）`,
    ' * - 生成: `node scripts/ebiten-keys-table.mjs --write`',
    ' * - 照合: `node scripts/ebiten-keys-table.mjs --check`（`scripts/acceptance.sh` が呼ぶ）',
    ' *',
    ' * 左右の区別の無い `Alt` / `Control` / `Meta` / `Shift` は左へ写し、`KeyMax` は捨てる（3.9.5 の 2）。',
    ' * 読むのは `src/input-keys.ts` だけにする。',
    ' */',
    '',
    '/** 生成に使った Ebitengine の版（`docker/isolated-build/template/go.mod`）。 */',
    `export const EBITEN_MODULE_VERSION = '${version}';`,
    '',
    '/** 生成に使ったモジュールの h1（`docker/isolated-build/template/go.sum`）。 */',
    `export const EBITEN_MODULE_SUM = '${sum}';`,
    '',
    '/** `ebiten.Key<名前>` の `<名前>` → `KeyboardEvent.code`。 */',
    'export const EBITEN_KEY_CODES: Readonly<Record<string, string>> = {',
    ...names.map((name) => `  '${name}': '${table.get(name)}',`),
    '};',
    '',
    '/** 上の表が写す `code` の集合（重複を除き、昇順）。 */',
    'export const EBITEN_KEY_CODE_LIST: readonly string[] = [',
    ...codes.map((code) => `  '${code}',`),
    '];',
    '',
  ];
  return lines.join('\n');
}

/**
 * コミットされたファイルから、記録された版と h1 を読む。
 *
 * @param {string} text ファイルの中身
 * @returns {{ version: string | null, sum: string | null }}
 */
function readRecorded(text) {
  const version = /export const EBITEN_MODULE_VERSION = '([^']+)';/.exec(text);
  const sum = /export const EBITEN_MODULE_SUM = '([^']+)';/.exec(text);
  return { version: version ? version[1] : null, sum: sum ? sum[1] : null };
}

const mode = process.argv[2];
if (mode !== '--write' && mode !== '--check') {
  console.error(`${TAG} 使い方: node scripts/ebiten-keys-table.mjs --write | --check`);
  process.exit(1);
}

const version = readModuleVersion();
const sum = readModuleSum(version);
const moduleDir = path.join(moduleCacheDir(), `${MODULE_PATH}@${version}`);
const keysGo = path.join(moduleDir, 'keys.go');
const keysJsGo = path.join(moduleDir, 'internal', 'ui', 'keys_js.go');
const sourceAvailable = existsSync(keysGo) && existsSync(keysJsGo);

/**
 * ソースから表を作り直す。
 *
 * @returns {string} 生成したファイルの中身
 */
function regenerate() {
  const jsCodes = parseJsCodes(readFileSync(keysJsGo, 'utf8'));
  const table = mapKeyConstants(readFileSync(keysGo, 'utf8'), jsCodes);
  return render(version, sum, table);
}

if (mode === '--write') {
  if (!sourceAvailable) {
    fail([
      `Ebitengine のソースがありません: ${moduleDir}`,
      `取得: (cd docker/isolated-build/template && go mod download ${MODULE_PATH})`,
    ]);
  }
  writeFileSync(OUTPUT, regenerate());
  console.log(`${TAG} ${path.relative(ROOT, OUTPUT)} を ${MODULE_PATH}@${version} から生成しました。`);
  process.exit(0);
}

// --check
if (!existsSync(OUTPUT)) {
  fail([`${path.relative(ROOT, OUTPUT)} がありません。検査が成立しないため失敗させます。`]);
}
const committed = readFileSync(OUTPUT, 'utf8');
const recorded = readRecorded(committed);
if (recorded.version !== version || recorded.sum !== sum) {
  fail([
    `表を生成した版と、今の go.mod / go.sum が一致しません。`,
    `  表: ${recorded.version ?? '(読めない)'} ${recorded.sum ?? '(読めない)'}`,
    `  今: ${version} ${sum}`,
    '作り直す: node scripts/ebiten-keys-table.mjs --write',
  ]);
}
console.log(`${TAG} 版と h1 は一致しました: ${MODULE_PATH}@${version} ${sum}`);

if (!sourceAvailable) {
  const reason = `Ebitengine のソースがありません: ${moduleDir}`;
  if (process.env.CI === 'true') {
    console.log(`${TAG} 表の中身の照合は成立しません（${reason}）。`);
    console.log(`${TAG} CI は Go のモジュールキャッシュを持たないため、版と h1 の一致だけを確かめました（合格ではありません）。`);
    console.log('EBITEN_KEYS_VERSION_ONLY');
    process.exit(0);
  }
  fail([
    reason,
    '表の中身を照合できないため失敗させます（照合していないことを合格にしない）。',
    `取得: (cd docker/isolated-build/template && go mod download ${MODULE_PATH})`,
  ]);
}

if (regenerate() !== committed) {
  fail([
    `${path.relative(ROOT, OUTPUT)} が、Ebitengine のソースから作り直したものと一致しません。`,
    '作り直す: node scripts/ebiten-keys-table.mjs --write',
  ]);
}
console.log(`${TAG} 表の中身も ${MODULE_PATH}@${version} のソースと一致しました。`);
console.log('EBITEN_KEYS_PASS');
