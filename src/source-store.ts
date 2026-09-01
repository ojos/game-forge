/**
 * 作品の Go ソースを R2 から読む（確定18 / 確定26 / #217）。
 *
 * # なぜ 1 か所に寄せたのか
 *
 * **フォーク（5.3）と推敲（5.7）が、実質同じ 10 行を持っていた。** #32 の実装時、
 * レーンの所有ファイルが分かれていて `src/revise.ts` を触れなかったためである
 * （経緯は #217）。5.7 が「方式はフォークと同じ、扱いだけが違う」と書いているとおり、
 * **上限も切り詰めない規約も出典は同じ確定18 である。**
 *
 * # ここに置くのは「読んで測る」だけである
 *
 * **前後は共有しない**（#217 の scope.out / constraints）。
 *
 * | | フォーク | 推敲 |
 * |---|---|---|
 * | 前段（誰の何を読んでよいか） | **公開済み**であること。作者かは見ない | 自分の `draft` であること |
 * | 失敗時の後始末 | まだ枠を取っていないので何もしない | **枠を返す**（`releaseRevisionSlot`） |
 *
 * **ここを一緒に畳むと、フォークが取っていない枠を返す、といった壊れ方をする。**
 * 呼ぶ側が前段を済ませ、失敗の後始末も呼ぶ側が持つ。
 *
 * # 30KB 超を「読めなかった」と同じ扱いにしない（確定18 / 5.3）
 *
 * あれは確定した上限で、**何度やっても成功しない。**「時間をおいてもう一度」と案内
 * すると、利用者は成功しない操作を繰り返す。だから理由を畳まず 2 つに分ける——
 * **作者への文言も、状態コードも、枠の扱いも変わる。** 超過時に LLM へ整理させる
 * 経路は M5-2（#33）が持つ。
 *
 * **黙って切り詰めない。** 切れた Go のソースを渡すと、コンパイルが必ず落ちて
 * 枠だけが消える。
 *
 * **上限の値そのものは `src/system-prompt.ts` の 1 か所にある**（`MAX_SOURCE_BYTES`）。
 * ここへ書き写さない。
 */

import { MAX_SOURCE_BYTES } from './system-prompt.js';

/**
 * ソースを読めなかった理由。**畳まない**——呼ぶ側で文言も後始末も変わる。
 *
 * - `source-missing` … キーが無い・実体が無い・空。**やり直す価値がある**
 * - `source-too-large` … 30KB 超。**何度やっても成功しない**
 */
export type StoredSourceFailure = 'source-missing' | 'source-too-large';

/** {@link readStoredSource} の結果。 */
export type StoredSourceResult =
  | { ok: true; source: string }
  | { ok: false; reason: StoredSourceFailure };

/**
 * R2 のキーからソースを読み、30KB 上限を判定する。
 *
 * **資格の判定はここで行わない。** 呼ぶ側が済ませてからキーを渡すこと——
 * `src/fork.ts` は `status='published'` を確かめてから、`src/revise.ts` は枠を
 * 取ってから引く。**確かめる前にキーを読むと、未公開の作品の R2 キーを引ける
 * 経路ができる。**
 *
 * @param env バインディングと環境変数
 * @param sourceKey R2 のキー
 * @returns ソース、または失敗の理由
 */
export async function readStoredSource(env: Env, sourceKey: string): Promise<StoredSourceResult> {
  const object = await env.BUCKET.get(sourceKey);
  if (object === null) {
    return { ok: false, reason: 'source-missing' };
  }
  const source = await object.text();
  if (source === '') {
    return { ok: false, reason: 'source-missing' };
  }
  if (new TextEncoder().encode(source).length > MAX_SOURCE_BYTES) {
    return { ok: false, reason: 'source-too-large' };
  }
  return { ok: true, source };
}
