import { SOURCE_KEY_PATTERN_BODY } from '../../src/source-input-keys.js';
import { SOURCE_QUALITY_LOG_TAG } from '../../src/source-quality-metrics.js';

/**
 * `[source-quality]` の行の**許された形**（#605）。
 *
 * 同期実行の生成経路は、完成のあとで質の指標を測る（`runJobInline`）。テストの段は R2 にソースを
 * 置かないので、**測れなかった行が生成経路のログに並ぶ。** 生成経路のログを「許した形だけを通す」で
 * 見る検査（`test/mechanical-fix.test.ts`）が、この形をここから借りる。
 *
 * **形は `src/source-quality-metrics.ts` が出す 5 つだけ**で、キーの形は `src/source-input-keys.ts` の
 * `SOURCE_KEY_PATTERN_BODY` から組み立てる（写さない）。**ソースの本文も、測った値も、例外の文面も
 * 合致しない**——`src/source-quality.ts` が指標を真偽値と数だけにしているのと同じ理由で、
 * 生成物由来の文字列をログへ持ち出さない。
 */
const SOURCE_QUALITY_LOG_PATTERN = new RegExp(
  `^${SOURCE_QUALITY_LOG_TAG.replace(/[[\]]/g, '\\$&')} ` +
    '(?:' +
    [
      `source-unreadable (?:source-missing|source-too-large) ${SOURCE_KEY_PATTERN_BODY}`,
      `unparsable ${SOURCE_KEY_PATTERN_BODY}`,
      `failed [A-Za-z]+ ${SOURCE_KEY_PATTERN_BODY}`,
      'invalid-source-key',
      'callback-failed [A-Za-z]+',
    ].join('|') +
    ')$',
  'u',
);

/**
 * 1 行が、#605 で定めた形かどうか。
 *
 * @param line ログ 1 行
 * @returns 許された形なら true
 */
export function isAllowedSourceQualityLine(line: string): boolean {
  return SOURCE_QUALITY_LOG_PATTERN.test(line);
}
