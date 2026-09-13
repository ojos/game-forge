import { BUILD_DIAGNOSTIC_CATEGORIES, BUILD_STAGES } from '../../src/build-diagnostics.js';

/**
 * `[build-diagnostics]` の行の**許された形**（4.2 の #443 注記 / 8.3）。
 *
 * **許可した形だけを通す**（禁じた語を探すのではない。`test/mechanical-fix.test.ts` の
 * `MECHANICAL_FIX_LOG_PATTERN` と同じ考え方）。項目の名前と並び、分類名と段の語彙まで
 * 実装の定数から組み立てるので、**分類名でない語が 1 つでも混じれば合致しない。**
 *
 * **生成経路のログを捕まえる検査は 2 つのファイルにある**（機械修正の行と、この行が
 * 同じ経路に並んで出る）。形の定義を 1 か所に置くため、ここへ切り出した。
 */
const BUILD_DIAGNOSTICS_LOG_PATTERN = new RegExp(
  '^\\[build-diagnostics\\] \\{' +
    '"attempt":\\d+,' +
    `"stage":"(?:${BUILD_STAGES.join('|')})",` +
    '"total":\\d+,' +
    '"truncated":(?:true|false),' +
    '"unpositioned":\\d+,' +
    '"counts":\\{' +
    BUILD_DIAGNOSTIC_CATEGORIES.map((category) => `"${category}":\\d+`).join(',') +
    '\\}\\}$',
  'u',
);

/** `[build-diagnostics]` の行から読み取ったもの。 */
export interface BuildDiagnosticsLogLine {
  readonly attempt: number;
  readonly stage: string;
  readonly total: number;
  readonly truncated: boolean;
  readonly unpositioned: number;
  readonly counts: Readonly<Record<string, number>>;
}

/**
 * 1 行が、#443 で定めた形かどうか。
 *
 * @param line ログ 1 行
 * @returns 許された形なら true
 */
export function isAllowedBuildDiagnosticsLine(line: string): boolean {
  return BUILD_DIAGNOSTICS_LOG_PATTERN.test(line);
}

/**
 * 捕まえたログから `[build-diagnostics]` の行だけを読む。**形に合わない行があれば投げる。**
 *
 * @param lines 捕まえたログ
 * @returns 読み取ったもの（出た順）
 */
export function readBuildDiagnosticsLines(lines: readonly string[]): BuildDiagnosticsLogLine[] {
  return lines
    .filter((line) => line.startsWith('[build-diagnostics] '))
    .map((line) => {
      if (!isAllowedBuildDiagnosticsLine(line)) {
        throw new Error(`許された形でない行です: ${line}`);
      }
      return JSON.parse(line.slice('[build-diagnostics] '.length)) as BuildDiagnosticsLogLine;
    });
}
