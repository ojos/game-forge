import { env } from 'cloudflare:test';

/**
 * 作品を `status = 'removed'`（tombstone）にする。
 *
 * **#637 で作者の口が無くなった。** 作者が公開をやめると `draft` へ戻るので（確定35 /
 * `src/games.ts` の `unpublishGame`）、`removed` を作るのは**運営の措置（8.4）と退会（確定34）と
 * 作者の削除**だけになった。運営の措置は管理画面に置かず D1 の直接 UPDATE で行う決定（仕様 2.4）
 * なので、**このヘルパも同じ 1 本の UPDATE である。**
 *
 * **各テストで書き写さないこと**（`./schema.ts` と同じ理由）。書き写すと、tombstone の作り方が
 * テストの数だけ増える。
 *
 * @param gameId 対象の作品 id
 */
export async function markGameRemoved(gameId: string): Promise<void> {
  const result = await env.DB.prepare("update games set status = 'removed' where id = ?")
    .bind(gameId)
    .run();
  // **0 行なら、仕込みが噛み合っていない。** 黙って通すと「tombstone のはずの作品」で
  // 公開中の画面を検査することになり、落ちてほしいテストが緑になる。
  if ((result.meta.changes ?? 0) === 0) {
    throw new Error(`markGameRemoved: 対象の作品がありません: ${gameId}`);
  }
}
