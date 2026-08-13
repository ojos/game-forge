import { applyD1Migrations, env } from 'cloudflare:test';

/**
 * テスト用の D1 へ `migrations/` のマイグレーションを適用する。
 *
 * **このヘルパを各テストで作り直さないこと。** M1 の #12 / #13 / #14 は D1 を触る
 * テストを並行して書くため、それぞれが独自の適用手順を持つと、同じことをする
 * 3 つの実装が生まれ、マイグレーションを足したときの追随箇所が 3 か所になる。
 *
 * `applyD1Migrations` は適用済みの一覧を `d1_migrations` テーブルへ記録するため、
 * 二度目以降の呼び出しは何もしない。テストごとに呼んでよい。
 *
 * @param db 適用先。既定はテスト用の `DB` バインディング
 */
export async function applySchema(db: D1Database = env.DB): Promise<void> {
  await applyD1Migrations(db, env.TEST_MIGRATIONS);
}
