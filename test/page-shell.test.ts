import { env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { createAppRoutes, handleAppRequest } from '../src/app.js';
import { DRAFT_STATUS } from '../src/games.js';
import { NON_PAGE_PATHS, ssrPagePaths } from '../src/page-paths.js';
import { buildSessionCookie, signSession } from '../src/session.js';
import { WORK_PAGE_PREFIX } from '../src/work-page.js';
import { applySchema } from './helpers/schema.js';

/**
 * 全 SSR 画面に共通する外枠の検査（#282）。
 *
 * # なぜ経路表から導くのか
 *
 * **画面の一覧をここへ書き写さない。** 書き写すと、画面を 1 枚足した日から
 * 「検査が見ている一覧」と「実際に配られている画面」が静かにずれる
 * （`.ai-playbook/shared-ai-rules.md` 12 章）。この検査が捕まえたいのは
 * まさに「足した画面が外枠に乗っていない」ことなので、一覧を写した時点で
 * 目的を失う。`createAppRoutes` が返す経路表そのものを歩く。
 *
 * # なぜ「末尾」ではなく「フッタより後ろに本文が無い」なのか
 *
 * `/generate` はフッタのあとに `<script>` を置く（`src/generate-page.ts`）。
 * 「文字列の末尾がフッタであること」を条件にすると、**正しい画面が赤くなる。**
 * 一方 #282 で見つかった `/signup` の不具合は「フッタのあとに `<h2>` が 2 節続く」で、
 * 見たいのは**本文が後ろに残っていないこと**である。`<script>` と空白・コメントだけを
 * 許し、それ以外のタグが 1 つでも現れたら赤にする。
 *
 * # 飛ばした経路を黙って緑にしない
 *
 * HTML を返さない GET 経路（ログイン開始のリダイレクト等）は検査できない。
 * **その集合を明示して突き合わせる。** 一覧を持つのは画面の側ではなく例外の側で、
 * 画面を足したときは自動で検査対象に入り、HTML を返さない経路を足したときだけ
 * 赤くなって説明を求められる（失敗の向きを閉じる側へ倒す）。
 */

const APP_ORIGIN = `https://${env.APP_HOST}`;
const SECRET = 'test-secret-value-for-page-shell-checks-1';

/** 共通フッタの目印（`src/legal.ts` の `siteFooter`）。 */
const FOOTER_MARK = '<footer class="gf-footer">';

/**
 * セッションの秘密だけを差し替えた env。
 *
 * @returns 差し替えた env
 */
function testEnv(): Env {
  return { ...env, SESSION_SECRET: SECRET };
}

let cookie = '';
let gameId = '';

beforeAll(async () => {
  await applySchema();

  const userId = `shell-${crypto.randomUUID()}`;
  await env.DB.prepare(
    `insert into users (id, google_sub, email, display_name, created_at)
     values (?, ?, ?, ?, ?)`,
  )
    .bind(userId, `sub-${userId}`, `${userId}@example.test`, '外枠検査', Math.floor(Date.now() / 1000))
    .run();

  gameId = crypto.randomUUID();
  await env.DB.prepare(
    `insert into games (id, author_id, status, title, go_version, created_at, generation_state)
     values (?, ?, ?, ?, '', ?, 'ready')`,
  )
    .bind(gameId, userId, DRAFT_STATUS, '外枠検査の作品', Math.floor(Date.now() / 1000))
    .run();

  const issuedAt = Math.floor(Date.now() / 1000);
  const token = await signSession({ userId, issuedAt, expiresAt: issuedAt + 3600 }, SECRET);
  cookie = buildSessionCookie(token, 3600).split(';')[0]!;
});

/**
 * 検査対象の画面パスを、経路表から導いて実際に開ける形へ落とす。
 *
 * 導出そのものは `src/page-paths.ts` が持つ。**ここで条件を書き直さない**——
 * 実ブラウザ側の検査（`scripts/check-page-width.sh`）と同じ一覧を見る必要がある。
 *
 * @returns パスの配列
 */
function getPaths(): string[] {
  return ssrPagePaths(createAppRoutes(testEnv())).map((path) =>
    path === WORK_PAGE_PREFIX ? `${WORK_PAGE_PREFIX}${gameId}` : path,
  );
}

/**
 * 1 経路を開いて、本文と content-type を返す。
 *
 * @param path パス
 * @returns 応答の本文と content-type
 */
async function open(path: string): Promise<{ body: string; type: string }> {
  const response = await handleAppRequest(
    new Request(`${APP_ORIGIN}${path}`, { headers: { cookie } }),
    testEnv(),
  );
  return {
    body: await response.text(),
    type: response.headers.get('content-type') ?? '',
  };
}

/**
 * HTML の末尾から `<script>` ブロック・コメント・空白を取り除く。
 *
 * @param tail フッタより後ろの HTML
 * @returns 残り
 */
function stripAllowedTail(tail: string): string {
  return tail
    .replaceAll(/<script\b[\s\S]*?<\/script>/gu, '')
    .replaceAll(/<!--[\s\S]*?-->/gu, '')
    .trim();
}

describe('全 SSR 画面の外枠', () => {
  it('画面として導いた経路は、すべて HTML を返す', async () => {
    // 導出が拾いすぎていないことの確認。ここが緑なら、以下の検査が「HTML でないので
    // 飛ばした」経路を 1 本も持たない。
    const notHtml: string[] = [];
    for (const path of getPaths()) {
      const { type } = await open(path);
      if (!type.includes('text/html')) {
        notHtml.push(path);
      }
    }
    expect(notHtml).toEqual([]);
  });

  it('画面でないと宣言した経路は、本当に HTML を返さない', async () => {
    // 逆向き。例外一覧へ画面を紛れ込ませて検査から逃がす経路を塞ぐ。
    for (const path of NON_PAGE_PATHS) {
      const { type } = await open(path === '/ogp/' ? '/ogp/none' : path);
      expect(type, `${path} の content-type`).not.toContain('text/html');
    }
  });

  it('検査対象の画面が 1 枚も無い、という状態にはならない', () => {
    expect(getPaths().length).toBeGreaterThan(5);
  });

  it('どの画面にも共通フッタが 1 つある', async () => {
    for (const path of getPaths()) {
      const { body, type } = await open(path);
      if (!type.includes('text/html')) {
        continue;
      }
      expect(body.split(FOOTER_MARK).length - 1, `${path} のフッタの数`).toBe(1);
    }
  });

  it('フッタより後ろに本文が残っていない', async () => {
    for (const path of getPaths()) {
      const { body, type } = await open(path);
      if (!type.includes('text/html')) {
        continue;
      }
      const closing = '</footer>';
      const end = body.lastIndexOf(closing);
      expect(end, `${path} に </footer> が無い`).toBeGreaterThan(-1);
      const rest = stripAllowedTail(body.slice(end + closing.length));
      expect(rest, `${path} のフッタより後ろに残った本文`).toBe('');
    }
  });
});
