/**
 * 作品が読むキーを、ソースから拾う（仕様 3.9.5 / #493 / M14-4）。
 *
 * **純粋関数だけを置く。** D1 も R2 も触らない——保存は `src/source-input-keys.ts`、
 * 既存作品への埋め戻しは `scripts/input-keys-backfill.mjs` が持ち、どちらもここを呼ぶ。
 * **抽出の規則を 2 か所に書かない**（埋め戻しとエッジで拾い方がずれると、同じソースに違う行ができる）。
 *
 * # 規則（`rule_version = 1`。正本は仕様 3.9.5）
 *
 * 1. 本文から `\bebiten\.Key([A-Za-z0-9]+)\b` に当たる名前をすべて拾う
 * 2. Ebitengine v2.9.9 のキーの表で `KeyboardEvent.code` へ写す。**表に無い名前は捨てる**
 *    （`ebiten.KeyName(` の `Name`、`KeyMax` など）
 * 3. 重複を除き、`code` の昇順の配列にする。1 つも読まなければ空配列
 *
 * **表は手で書かない。** `src/ebiten-keys.generated.ts` は Ebitengine のソースから生成し、
 * `scripts/ebiten-keys-table.mjs --check` が照合する（shared-ai-rules 12 章）。
 * 非推奨の別名（`KeyUp` → `ArrowUp`、`Key0` → `Digit0`）も、左右の区別の無い名前を左へ寄せる規則
 * （`KeyShift` → `ShiftLeft`）も、生成の側が持つ。
 *
 * # 規則が拾わないもの（仕様 3.9.5 で受け入れた）
 *
 * `ebiten` 以外の名前で import したソース、`AppendPressedKeys` のような列挙できない読み方。
 * コメントや文字列の中の `ebiten.Key*` は拾う（構文解析を持ち込まない）。
 */
import { EBITEN_KEY_CODES, EBITEN_KEY_CODE_LIST } from './ebiten-keys.generated.js';

/**
 * 抽出の規則の版。**規則を変えたら上げる**——保存した行のうち古い版のものが、
 * 完成の経路と埋め戻しで拾い直される（`source_input_keys.rule_version`）。
 */
export const INPUT_KEYS_RULE_VERSION = 1;

/**
 * 許可表: キーの表が写す `code` の集合（仕様 3.9.7）。
 *
 * **ローダーへ埋める定数は、ここから組み立てる**（M14-5）。写しを 2 つ作らない。
 * 生成物の配列をそのまま渡す（ここで `new Set` を作らない——呼ぶ側が要る形に直す）。
 */
export const INPUT_KEY_CODES: readonly string[] = EBITEN_KEY_CODE_LIST;

/**
 * `ebiten.Key<名前>` の `<名前>` を `code` へ写す。表に無ければ null。
 *
 * **`Object.hasOwn` で引く。** `ebiten.Keyconstructor` のような綴りでも、
 * `Object.prototype` の値を `code` として返さない。
 *
 * @param name `Key` の後ろの名前（例: `Space`、`Up`）
 * @returns `KeyboardEvent.code`、または null
 */
export function ebitenKeyCode(name: string): string | null {
  return Object.hasOwn(EBITEN_KEY_CODES, name) ? (EBITEN_KEY_CODES[name] ?? null) : null;
}

/**
 * ソースが読むキーの `code` を拾う（仕様 3.9.5 の規則）。
 *
 * @param source Go のソース本文
 * @returns 重複を除いた `code` の昇順の配列（読まなければ空配列）
 */
export function extractInputKeyCodes(source: string): string[] {
  const codes = new Set<string>();
  // **正規表現を関数の中で作る。** `g` の付いた正規表現は `lastIndex` を持つので、
  // モジュールの値として共有すると、呼び出しの間で状態が漏れる。
  for (const match of source.matchAll(/\bebiten\.Key([A-Za-z0-9]+)\b/g)) {
    const code = ebitenKeyCode(match[1] ?? '');
    if (code !== null) {
      codes.add(code);
    }
  }
  // **昇順は code unit の順で決める**（`localeCompare` にしない）。埋め戻しの Node と
  // Worker で並びが変わらないようにするため。
  return [...codes].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}
