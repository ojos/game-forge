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
 * ここへ書き写さない。**測り方（バイト数か文字数か）も書き写さない**
 * ——`src/source-size.ts` の `measureSourceBytes` が持つ（#33）。
 *
 * **断つ大きさは引数で受ける**（既定は 5.3 の上限）。整理パス（確定18 の条件 2〜4）
 * だけが上限超のソースを読むためで、**既定を変えたわけではない。**
 */

import { MAX_SOURCE_BYTES, measureSourceBytes } from './source-size.js';

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
 * # 上限を引数にしてある（確定18 の整理パス / #33）
 *
 * **既定は `MAX_SOURCE_BYTES` で、これまでと同じ振る舞いである。** 引数にしたのは
 * 整理パス（5.3 の条件 2〜4）だけが上限超のソースを読む必要があるためで、
 * `src/fork.ts` が {@link TIDY_MAX_SOURCE_BYTES} を渡す。
 *
 * **呼ぶ側が上限を決められる形にしても、上限が消えるわけではない。** 渡された値で
 * 必ず断つ——「無制限」を意味する値を用意していないのは、そのためである。
 *
 * @param env バインディングと環境変数
 * @param sourceKey R2 のキー
 * @param maxBytes 断つバイト数（**これを超えたら**断る）。既定は 5.3 の上限
 * @returns ソース、または失敗の理由
 */
export async function readStoredSource(
  env: Env,
  sourceKey: string,
  maxBytes: number = MAX_SOURCE_BYTES,
): Promise<StoredSourceResult> {
  const object = await env.BUCKET.get(sourceKey);
  if (object === null) {
    return { ok: false, reason: 'source-missing' };
  }
  // **本文を読む前に、保存されている大きさで断る。** R2 は本文を読まなくても
  // `size`（保存されたバイト数）を返す。ここを読んでから測ると、**上限で断ると
  // 決まっているものを、いったん全部メモリへ載せることになる。** 上限を守るための
  // 判定が、上限を超えたものによって落ちうる形にしない。
  if (object.size > maxBytes) {
    return { ok: false, reason: 'source-too-large' };
  }
  const source = await object.text();
  if (source === '') {
    return { ok: false, reason: 'source-missing' };
  }
  // **読み出した本文でも測る。** 上の `size` は保存時のバイト数で、判定したいのは
  // 「いま LLM へ渡そうとしている文字列」の大きさである。この 2 つは同じはずだが、
  // **同じはずだから省く**のは、確かめていないものを確かめた証拠として使うことになる。
  if (measureSourceBytes(source) > maxBytes) {
    return { ok: false, reason: 'source-too-large' };
  }
  return { ok: true, source };
}
