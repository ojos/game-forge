import type { StorageEnv } from '../../src/build-cache.js';

/**
 * D1 の文が走った本数を数える `Env` を作る（**batch は中の文の本数で数える**）。
 *
 * D1 の 1 呼び出しあたりの枠（50。仕様 3.6）は文の本数で数えられる。**`prepare` の回数ではなく
 * 実行した回数**を数えるため、`run` / `first` / `all` / `raw` と、`batch` に渡した文の数を足す。
 *
 * **batch へは包む前の文を渡す**（D1 の実装は包んだ Proxy を文として受け取らない）。
 *
 * **ここに置いてある理由。** 作品 1 件の削除（`test/game-deletion.test.ts`）と、退会の後続の
 * 処理のアラーム 1 回（`test/withdrawal-purge.test.ts`）が、どちらも同じ枠に対して同じ数え方を
 * する。テストごとに写すと、数え方が割れたときに**どちらの数字が枠と比べてよい値なのか
 * 分からなくなる**（shared-ai-rules 12 章）。
 *
 * @param base 元の `Env`（D1 と R2 を持つもの）
 * @returns 数える `Env` と、読み出し口
 */
export function countingEnv<T extends StorageEnv>(base: T): { env: T; count: () => number } {
  let statements = 0;
  const originals = new WeakMap<object, D1PreparedStatement>();

  const wrap = (statement: D1PreparedStatement): D1PreparedStatement => {
    const proxy = new Proxy(statement, {
      get(target, property, receiver) {
        const value = Reflect.get(target, property, receiver) as unknown;
        if (typeof value !== 'function') return value;
        return (...args: unknown[]): unknown => {
          if (property === 'bind') {
            return wrap((value as (...a: unknown[]) => D1PreparedStatement).apply(target, args));
          }
          if (property === 'run' || property === 'first' || property === 'all' || property === 'raw') {
            statements += 1;
          }
          return (value as (...a: unknown[]) => unknown).apply(target, args);
        };
      },
    });
    originals.set(proxy, statement);
    return proxy;
  };

  const db = new Proxy(base.DB, {
    get(target, property, receiver) {
      if (property === 'prepare') {
        return (sql: string): D1PreparedStatement => wrap(target.prepare(sql));
      }
      if (property === 'batch') {
        return (list: D1PreparedStatement[]): Promise<D1Result[]> => {
          statements += list.length;
          return target.batch(list.map((item) => originals.get(item) ?? item));
        };
      }
      return Reflect.get(target, property, receiver);
    },
  });
  return { env: { ...base, DB: db } as T, count: () => statements };
}
