/**
 * 一覧の読み取りを Cache API の前段に置く（仕様 2.3.3 の条件 3 / #328）。
 *
 * ## 載せるのは HTML ではなく、引いたデータである
 *
 * **理由が 2 つあり、どちらも同じ結論を指す。**
 *
 * 1. **ヘッダはログイン状態で出し分かれる**（仕様 2.3.7 / M9-5）。HTML を丸ごと共有
 *    キャッシュへ載せると、**未ログインの閲覧で作られた HTML がログイン済みの利用者へ
 *    配られる**（逆も起きる）。
 * 2. `src/routes.ts` の `html()` は `cache-control: no-store` を**固定で付ける**
 *    （引数で上書きできない）。`caches.default` はその応答を保存しない。
 *
 * したがって **`html()` は触らない。** 合成したキーの下に**引いた行だけ**を JSON として
 * 置き、HTML は毎回そのリクエストのログイン状態で組み立てる。
 *
 * ## 3.6 の指示は「読み取りを減らす」ことにある
 *
 * 3.6 は「タイムラインの読み取りは Cache API を前段に置く」と書いている。減らしたいのは
 * **D1 の読み取り**であって、描画ではない。ここが担うのはその 1 点だけである。
 *
 * ## キーは合成する
 *
 * 実在しないホスト（{@link CACHE_ORIGIN}）の下に置く。**利用者のリクエスト URL を
 * そのまま鍵にしない**——クエリの並びや余分なパラメータが違うだけで別の鍵になり、
 * 同じ一覧が何本も溜まる。鍵は「どの一覧の何頁目か」だけで決める。
 */

/**
 * キャッシュの鍵に使う架空のオリジン。
 *
 * **アプリのホストを使わない。** 実在するホストの下に置くと、同じ URL の実リクエストと
 * 鍵が衝突しうる。到達しないホスト名にしておけば、この用途以外の応答が混ざらない。
 */
export const CACHE_ORIGIN = 'https://list-cache.game-forge.invalid';

/**
 * 一覧のキャッシュ TTL（秒）。
 *
 * **60 秒。** 公開は月数十件の規模であり（3.7 / 確定25 の生成枠から導かれる上限）、
 * **60 秒古い一覧が実害を持たない。** 公開した本人がすぐ確かめたい先は作品ページ
 * （`/works/<id>`）で、そちらはキャッシュを通らない。
 *
 * **長くしない理由もここにある。** 1 分より長くすると、「公開したのに一覧に出ない」を
 * 説明できる時間が伸びる。読み取りの節約はどのみち 3〜4 桁の余裕の中の話である
 * （仕様 2.3.3）。
 */
export const LIST_CACHE_TTL_SECONDS = 60;

/**
 * 一覧の鍵を組み立てる。
 *
 * @param name 一覧の名前（`works` など）
 * @param params 鍵に効く値（並べ替え軸・頁など）
 * @returns 鍵に使う URL
 */
export function listCacheKey(name: string, params: Record<string, string | number>): string {
  const query = Object.entries(params)
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`)
    .sort()
    .join('&');
  return `${CACHE_ORIGIN}/${encodeURIComponent(name)}?${query}`;
}

/**
 * Cache API が使えるか。
 *
 * **使えない環境で落とさない。** キャッシュは読み取りを減らすための前段であって、
 * 一覧が出るための条件ではない。`caches` が無いランタイムでは素通しにする。
 *
 * @returns 使えるなら true
 */
function cacheAvailable(): boolean {
  return typeof caches !== 'undefined' && caches.default !== undefined;
}

/**
 * 引いた行をキャッシュ越しに取る。
 *
 * **ログイン状態に依存する値をここへ渡さないこと。** 保存されるのは全員に同じものが
 * 出るデータだけである（仕様 2.3.3）。
 *
 * @param key {@link listCacheKey} が返した鍵
 * @param load キャッシュが無いときに引く関数
 * @param ttlSeconds 保存する秒数
 * @returns 行
 */
export async function cachedRows<T>(
  key: string,
  load: () => Promise<T>,
  ttlSeconds: number = LIST_CACHE_TTL_SECONDS,
): Promise<T> {
  if (!cacheAvailable()) {
    return await load();
  }

  const request = new Request(key, { method: 'GET' });
  const cache = caches.default;

  // **キャッシュの失敗で一覧を落とさない。** ここは読み取りを減らすための前段で
  // あって、一覧が出るための条件ではない（Copilot code review の指摘。2026-09-05）。
  // `match` も `put` も、容量やランタイムの都合で投げうる。**投げたら素通しにする。**
  try {
    const hit = await cache.match(request);
    if (hit !== undefined) {
      // **壊れた保存物で一覧を落とさない。** JSON として読めなければ引き直す。
      try {
        return (await hit.json()) as T;
      } catch {
        // 読めない保存物は捨てる。残すと TTL の間ずっと引き直しになる。
        await cache.delete(request);
      }
    }
  } catch {
    // 読めなければ引くだけである。**握りつぶしてよい唯一の理由**は、この層が
    // 無くても一覧が正しく出ることにある（4.3 の「判定できなかったときは止まる側へ
    // 倒す」とは性質が違う——あちらは握りつぶすと上限が静かに開く）。
  }

  const rows = await load();
  try {
    await cache.put(
      request,
      new Response(JSON.stringify(rows), {
        headers: {
          'content-type': 'application/json; charset=utf-8',
          'cache-control': `max-age=${ttlSeconds}`,
        },
      }),
    );
  } catch {
    // 保存できなくても、引いた行はそのまま返す。次のリクエストがまた引くだけである。
  }
  return rows;
}

/**
 * 鍵 1 本ぶんの保存物を捨てる。
 *
 * **テストが使う。** 本番の経路は TTL で切れるのを待つが、テストは「引いた行が
 * キャッシュされていること」と「捨てれば引き直すこと」の両方を確かめる必要がある。
 * **本番と同じ経路を確かめるために、本番と同じ実装へ口を 1 つ開ける**（別の実装を
 * テスト用に持つと、確かめたものと動くものが別になる）。
 *
 * @param key {@link listCacheKey} が返した鍵
 * @returns 捨てたなら true
 */
export async function purgeListCache(key: string): Promise<boolean> {
  if (!cacheAvailable()) {
    return false;
  }
  try {
    return await caches.default.delete(new Request(key, { method: 'GET' }));
  } catch {
    return false;
  }
}
