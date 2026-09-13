/**
 * ハンドル名（`/@handle`）の綴りと形（#381 / 仕様 5.10 / 2.3.1）。
 *
 * # なぜ値だけの葉に置くのか
 *
 * **作品カード（`src/work-card.ts`）と作品ページ（`src/work-page.ts`）が、作者名のリンクを
 * `/@handle` へ向けるためにここを読む。** ハンドル名の保存と検査を持つ `src/handle.ts` は
 * D1 と経路表の型を読むので、画面の側からそちらを import すると依存が太る。作者ページの綴り
 * （`src/users-page-paths.ts`）と同じく、**綴りと形だけを import を持たない葉に置く。**
 *
 * **`src/paths.ts` には置かない**——あちらはオーケストレータ Lambda の束に入る（#336。
 * `src/users-page-paths.ts` の冒頭）。
 */

/**
 * ハンドル名の作者ページの接頭辞（2.3.1 / 5.10）。
 *
 * **前方一致（`/` で終わる接頭辞）ではなく、1 セグメントの経路で登録する**（`src/routes.ts` の
 * `RouteMatch` の `segment`）。`/@` は `/` で終えられない（`/@/foo` は AivisHub と同じ形ではない）。
 */
export const HANDLE_PAGE_PREFIX = '/@';

/** ハンドル名の最短の長さ（5.10。**2 文字以下は予約語や短縮形と紛らわしい**）。 */
export const HANDLE_MIN_LENGTH = 3;

/** ハンドル名の最長の長さ（5.10。URL と作品カードに載るので短く保つ）。 */
export const HANDLE_MAX_LENGTH = 20;

/**
 * 保存されたハンドル名の形（**小文字の ASCII 英字・数字・`_` の 3〜20 文字**）。
 *
 * **許可リストで書く。** 禁じる文字を並べる形（表示名の検査。`src/account.ts`）では、全角英数・
 * ゼロ幅の文字・文字の向きを変える書式文字・見た目の似た別の文字を 1 つずつ足すことになる。
 * **URL の一部になる値は、足し忘れた 1 文字がそのままなりすましになる**ので、通すものだけを書く。
 *
 * **`migrations/` の handles の CHECK と同じ規則である**（`test/schema-handles.test.ts` が同じ入力で
 * 突き合わせる）。
 */
export const HANDLE_PATTERN = /^[a-z0-9_]{3,20}$/u;

/**
 * ハンドル名の作者ページのパスを組み立てる。
 *
 * **形を満たさない値を渡されたら投げる。** 呼ぶ側は {@link isStoredHandle} で確かめてから呼ぶ
 * （作品カードは Cache API を通った JSON を読むので、型の上で文字列でも何が来るか分からない）。
 * 形を満たす値は URL で意味を持つ文字を含まないので、`encodeURIComponent` は要らない。
 *
 * @param handle 保存されたハンドル名（小文字）
 * @returns アプリ用ホスト上の絶対パス
 * @throws 形を満たさない値の場合
 */
export function handlePagePath(handle: string): string {
  if (!HANDLE_PATTERN.test(handle)) {
    throw new Error('ハンドル名の形を満たさない値からパスを組み立てようとしました');
  }
  return `${HANDLE_PAGE_PREFIX}${handle}`;
}

/**
 * 値が保存されたハンドル名の形か（実行時の値を見る）。
 *
 * @param value 調べる値（キャッシュを通った JSON の値でもよい）
 * @returns 形を満たす文字列なら true
 */
export function isStoredHandle(value: unknown): value is string {
  return typeof value === 'string' && HANDLE_PATTERN.test(value);
}
