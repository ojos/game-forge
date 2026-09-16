import { env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { HANDLES_TABLE, HANDLE_RESERVATION_SECONDS, changeHandle } from '../src/handle.js';
import { withdrawUser } from '../src/withdrawal.js';
import { applySchema } from './helpers/schema.js';

/**
 * 退会した利用者のハンドル名の予約（#518 の acceptance 5 / #586 / M15-3a）。
 *
 * **退会は改名と同じ扱いにする**（#518 の本文）。`handles` の行を消さず `released_at` を入れる
 * ので、**90 日のあいだ他人が取れない**。期限が切れたあとは、既存どおり「他の人が取るときに
 * 消す」（`src/handle.ts` の `changeHandle` の 1 番目の文）。
 *
 * **行を消さない理由。** 消すと、退会した直後に他人が同じハンドル名を取れてしまう。
 * `/@handle` は 90 日以内なら旧い持ち主の `/users/<id>` へ転送する（5.10）ので、
 * **転送先が生きているあいだに別人がその名前を名乗れる**形になる。
 */

beforeAll(async () => {
  await applySchema();
});

const NOW = 1_800_000_000;

/**
 * 利用者を 1 人用意する。
 *
 * @returns 利用者の id
 */
async function seedUser(): Promise<string> {
  const id = `wdh-${crypto.randomUUID()}`;
  await env.DB.prepare(
    'insert into users (id, google_sub, email, display_name, created_at) values (?, ?, ?, ?, 1)',
  )
    .bind(id, `sub-${id}`, `${id}@example.com`, 'ハンドルの人')
    .run();
  return id;
}

describe('退会したハンドル名は 90 日のあいだ他人が取れない', () => {
  it('退会で予約へ移り、90 日以内は他人が取れず、90 日を過ぎれば取れる', async () => {
    const owner = await seedUser();
    const handle = `wd${Math.floor(Math.random() * 1e6)}`;
    expect(await changeHandle(env.DB, owner, handle, NOW - 1000)).toEqual({ ok: true, changed: true });

    expect(await withdrawUser(env, owner, NOW)).toEqual({ ok: true, result: 'withdrawn' });

    // **行は消えず、`released_at` が入る**（改名と同じ）。
    const reserved = await env.DB.prepare(
      `select user_id, released_at from ${HANDLES_TABLE} where handle = ?`,
    )
      .bind(handle)
      .first<{ user_id: string; released_at: number | null }>();
    expect(reserved).toEqual({ user_id: owner, released_at: NOW });

    // 90 日 - 1 秒: 他人は取れない。
    const stranger = await seedUser();
    expect(await changeHandle(env.DB, stranger, handle, NOW + HANDLE_RESERVATION_SECONDS - 1)).toEqual({
      ok: false,
      reason: 'handle-taken',
    });
    const stillReserved = await env.DB.prepare(
      `select user_id from ${HANDLES_TABLE} where handle = ?`,
    )
      .bind(handle)
      .first<{ user_id: string }>();
    expect(stillReserved?.user_id).toBe(owner);

    // 90 日 + 1 秒: 取れる（予約の行は取る側が消す）。
    expect(await changeHandle(env.DB, stranger, handle, NOW + HANDLE_RESERVATION_SECONDS + 1)).toEqual({
      ok: true,
      changed: true,
    });
    const taken = await env.DB.prepare(
      `select user_id, released_at from ${HANDLES_TABLE} where handle = ?`,
    )
      .bind(handle)
      .first<{ user_id: string; released_at: number | null }>();
    expect(taken).toEqual({ user_id: stranger, released_at: null });
  });

  it('ハンドル名を持っていない利用者でも退会できる', async () => {
    const owner = await seedUser();
    expect(await withdrawUser(env, owner, NOW)).toEqual({ ok: true, result: 'withdrawn' });
  });
});
