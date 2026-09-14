import { SOURCE_INPUT_KEYS_LOG_TAG, SOURCE_KEY_PATTERN_BODY } from '../../src/source-input-keys.js';

/**
 * `[source-input-keys]` の行の**許された形**（仕様 3.9.5 / #493）。
 *
 * 同期実行の生成経路は、完成のあとで作品が読むキーを拾う（`runJobInline`）。テストの段は R2 にソースを
 * 置かないので、**拾えなかった行が生成経路のログに並ぶ。** 生成経路のログを「許した形だけを通す」で見る
 * 検査（`test/mechanical-fix.test.ts`）が、この形をここから借りる。
 *
 * **形は `src/source-input-keys.ts` の `SOURCE_INPUT_KEYS_LOG_TAG` の説明にある 4 つだけ**で、キーの形は
 * 同じモジュールの `SOURCE_KEY_PATTERN_BODY` から組み立てる（写さない）。ソースの本文も例外の文面も合致しない。
 */
const SOURCE_INPUT_KEYS_LOG_PATTERN = new RegExp(
  `^${SOURCE_INPUT_KEYS_LOG_TAG.replace(/[[\]]/g, '\\$&')} ` +
    '(?:' +
    [
      `source-unreadable (?:source-missing|source-too-large) ${SOURCE_KEY_PATTERN_BODY}`,
      `failed [A-Za-z]+ ${SOURCE_KEY_PATTERN_BODY}`,
      'invalid-source-key',
      'callback-failed [A-Za-z]+',
    ].join('|') +
    ')$',
  'u',
);

/**
 * 1 行が、#493 で定めた形かどうか。
 *
 * @param line ログ 1 行
 * @returns 許された形なら true
 */
export function isAllowedSourceInputKeysLine(line: string): boolean {
  return SOURCE_INPUT_KEYS_LOG_PATTERN.test(line);
}
