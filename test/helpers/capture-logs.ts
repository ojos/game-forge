/**
 * 実行中の `console` への出力をすべて捕まえる。
 *
 * **生成経路のログを検査するテストが共有する**（`test/mechanical-fix.test.ts` /
 * `test/build-diagnostics.test.ts`）。捕まえ方が食い違うと、片方の検査の外へ出力が落ちる。
 *
 * **5 つのメソッドを全部差し替える。** 1 つでも素通しにすると、そこへ出したものが
 * 検査の外に落ちる。文字列以外の引数も JSON にして記録するので、オブジェクトに
 * 包んで渡した文字列も捕まる。
 *
 * @param run 実行するもの
 * @returns 戻り値と、捕まえた行
 */
export async function captureLogs<T>(run: () => T | Promise<T>): Promise<{ value: T; lines: string[] }> {
  const lines: string[] = [];
  const original = {
    log: console.log,
    info: console.info,
    warn: console.warn,
    error: console.error,
    debug: console.debug,
  };
  const record = (...values: unknown[]): void => {
    lines.push(
      values
        .map((value) => (typeof value === 'string' ? value : (JSON.stringify(value) ?? String(value))))
        .join(' '),
    );
  };
  console.log = record;
  console.info = record;
  console.warn = record;
  console.error = record;
  console.debug = record;
  try {
    const value = await run();
    return { value, lines };
  } finally {
    console.log = original.log;
    console.info = original.info;
    console.warn = original.warn;
    console.error = original.error;
    console.debug = original.debug;
  }
}
