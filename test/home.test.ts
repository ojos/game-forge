import { SELF, env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { createAppRoutes, devRoutesEnabled, handleAppRequest } from '../src/app.js';
import { PUBLISHED_STATUS } from '../src/games.js';
import { CLOSED_BETA_NOTICE, HOME_PATH } from '../src/home.js';
import {
  HOME_CACHE_KEY,
  HOME_SECTION_LIMIT,
  HOME_SORT_TITLES,
  OFFICIAL_SECTION_TITLE,
} from '../src/home-feed.js';
import { purgeListCache } from '../src/list-cache.js';
import { GENERATE_PAGE_PATH, INVITES_PATH, SIGNUP_PATH } from '../src/paths.js';
import { MY_WORKS_PATH } from '../src/works-paths.js';
import { findDuplicateRoutes } from '../src/routes.js';
import { workPagePath } from '../src/work-page.js';
import { worksListPath } from '../src/works-list.js';
import { applySchema } from './helpers/schema.js';
import { pageBodyOf } from './helpers/site-shell.js';

/**
 * 公開トップと、`/__dev/*` の本番遮断（#89 / #329）。
 *
 * **受け入れ条件のうち、ローカルで機械判定できる 2 つをここで押さえる。**
 * 「`/` が開発用ページではない」と「`/__dev/*` が本番で 404 になる」は、実配備を
 * 待たなくても経路表の組み立てで決まる。実配備でしか見られないもの（実ドメインの
 * CSP / cookie、カスタムドメインの解決）は 9.1 の表のとおりここでは扱わない。
 *
 * **#329（M9-3）でトップが D1 を読むようになった。** ここが持つのは**画面の構造**
 * ——節が 4 つ・各 8 件・見出し・「もっと見る」の行き先——で、**読み取りの上限と
 * 索引は `test/home-feed.test.ts` が持つ。**
 *
 * **カードの中身をここで確かめない**（仕様 2.3.6 の項目は `src/work-card.ts` の
 * 受け持ちで、一覧・トップ・作者ページが同じ 1 枚を使う）。確かめるのは
 * 「その作品がトップに並んでいるか」までである。
 */

const APP_ORIGIN = `https://${env.APP_HOST}`;

/**
 * `DEV_ROUTES` だけを差し替えた env を作る。
 *
 * `wrangler.toml` のトップレベル（＝ローカル）は `enabled` なので、無効側は
 * テストの中で作るしかない。**バインディングは実物を引き継ぐ**（D1 / R2 を
 * 差し替えると、遮断の検査のはずが疎通の検査になってしまう）。
 *
 * @param devRoutes `DEV_ROUTES` に入れる値
 * @returns 差し替えた env
 */
function envWithDevRoutes(devRoutes: string): Env {
  return { ...env, DEV_ROUTES: devRoutes } as unknown as Env;
}

/** 本番と同じ設定（`[env.production.vars]` の `DEV_ROUTES = "disabled"`）。 */
const productionEnv = envWithDevRoutes('disabled');

beforeAll(async () => {
  await applySchema();
});

/**
 * 決まった行だけを返す D1。
 *
 * **保存領域を空にせずに「0 本」や「いいねが 1 件も無い」を作るためである。** `games` は
 * テストの間で積み上がるので、実物の D1 では「全作品のいいねが 0」という状態を作れない
 * （他のテストが仕込んだ行が混ざる）。
 *
 * 運営アカウントを引く問い合わせだけは別に扱う（`users` を引いており、作品の行とは形が違う）。
 *
 * @param rows 作品の問い合わせが返す行
 * @returns D1 の差し替え
 */
function stubDb(rows: readonly Record<string, unknown>[]): D1Database {
  return {
    prepare: (sql: string) => ({
      bind: () => ({
        all: async () => ({ results: sql.includes('is_operator') ? [] : rows, meta: {} }),
      }),
    }),
  } as unknown as D1Database;
}

/** 作品を 1 件も返さない D1。 */
const EMPTY_DB = stubDb([]);

/**
 * `games` の 1 行ぶんの形（`publishedGamesSql` が選ぶ列）。
 *
 * @param likeCount いいねの数
 * @returns 行
 */
function stubRow(likeCount: number): Record<string, unknown> {
  return {
    id: crypto.randomUUID(),
    title: 'いいねの無い作品',
    published_at: 1,
    fork_count: 1,
    like_count: likeCount,
    parent_id: null,
    ogp_state: 'ready',
    author_name: '作者',
  };
}

/**
 * トップを開く。
 *
 * **毎回キャッシュを捨てる。** `caches.default` はテストの間で共有されるので、捨てないと
 * 前のテストが仕込んだ行を読む（`test/works-list.test.ts` と同じ扱い）。
 *
 * @param target 使う env（省略時は実物）
 * @returns 本文
 */
async function openHome(target: Env = env): Promise<string> {
  await purgeListCache(HOME_CACHE_KEY);
  const response = await handleAppRequest(new Request(`${APP_ORIGIN}${HOME_PATH}`), target);
  expect(response.status).toBe(200);
  return await response.text();
}

/**
 * 公開作品を 1 件仕込む。
 *
 * @param options 作者の印と数
 * @returns 作った作品の id
 */
async function seedPublished(
  options: {
    readonly operator?: boolean;
    readonly likeCount?: number;
    readonly forkCount?: number;
  } = {},
): Promise<string> {
  const userId = `home-${crypto.randomUUID()}`;
  await env.DB.prepare(
    `insert into users (id, google_sub, email, display_name, created_at, is_operator)
     values (?, ?, ?, ?, 1, ?)`,
  )
    .bind(userId, `sub-${userId}`, `${userId}@example.com`, '作者', options.operator === true ? 1 : 0)
    .run();

  const id = crypto.randomUUID();
  stamp += 1;
  await env.DB.prepare(
    `insert into games
       (id, author_id, status, title, go_version, created_at, generation_state,
        published_at, fork_count, like_count, ogp_state)
     values (?, ?, ?, ?, '', ?, 'ready', ?, ?, ?, 'ready')`,
  )
    .bind(
      id,
      userId,
      PUBLISHED_STATUS,
      'トップに並ぶ作品',
      stamp,
      stamp,
      options.forkCount ?? 0,
      options.likeCount ?? 0,
    )
    .run();
  return id;
}

/** 仕込む時刻の種。**常に「いままでで最も新しい」値を使う**（節の先頭側へ来させる）。 */
let stamp = 9_700_000_000;

describe('公開トップ（#89）', () => {
  it('`/` が開発用の索引ではなく公開トップを返す', async () => {
    const response = await SELF.fetch(`${APP_ORIGIN}${HOME_PATH}`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8');

    const body = await response.text();
    expect(body).toContain('<h1 class="gf-header-title">');
    // **トップの `<h1>` はヘッダのロゴだけ**（仕様 2.5.6 / #469）。本文の `<h1>Game Forge</h1>` は消した。
    expect(body.match(/<h1\b/gu)).toHaveLength(1);
    expect(pageBodyOf(body)).not.toMatch(/<h1\b/u);
    // 開発用の索引にしか無い文言が残っていないこと。受け入れ条件
    // 「`/` が開発用ページではない」を、見た目ではなく文字列で固定する。
    expect(body).not.toContain('/__dev/health');
    expect(body).not.toContain('ローカル開発用の索引');
  });

});

describe('トップの案内を「いまの状態」の告知 1 つに絞る（#471。仕様 2.3.3 の #435 注記）', () => {
  it('告知のブロックがちょうど 1 つあり、ヘッダの直後（作品の節より前）に置かれる', async () => {
    // 節が 1 つも無いと並びを確かめられないので、公開作品を 1 件仕込む。
    await seedPublished();
    const body = pageBodyOf(await openHome());
    expect(body.split('class="gf-block gf-home-notice"').length - 1).toBe(1);
    expect(body).toContain(`<p>${CLOSED_BETA_NOTICE}</p>`);
    // **告知が本文の先頭のブロックである**（ヘッダ → 告知 → 作品の 4 節 → お知らせ）。
    const notice = body.indexOf('gf-home-notice');
    expect(notice).toBeGreaterThan(0);
    expect(notice).toBeLessThan(body.indexOf('<section class="gf-home-section"'));
    // 文面は 2.3.3 の注記の案。冒頭の半文がサイトの正体を示すただ 1 つの文である。
    expect(CLOSED_BETA_NOTICE).toContain('プロンプト 1 行から 2D ゲームを作れるサービスです。');
    expect(CLOSED_BETA_NOTICE).toContain('招待制のクローズドβ');
    expect(CLOSED_BETA_NOTICE).toContain('生成は招待コードをお持ちの方に限ります');
  });

  it('「はじめる」「参加している方へ」と冒頭のサイト説明が無い', async () => {
    const body = pageBodyOf(await openHome());
    expect(body).not.toContain('はじめる');
    expect(body).not.toContain('参加している方へ');
    expect(body).not.toContain('<h2>いまの状態</h2>');
    // 冒頭のサイト説明の全文（FAQ の先頭へ移した。`src/faq.ts` の `about`）。
    expect(body).not.toContain('ブラウザで遊べる 2D ゲームが生まれます');
    // 生成の説明（待ち時間・下書き・公開。FAQ の `after-generation` へ移した）。
    expect(body).not.toContain('下書きとして保存されます');
    expect(body).not.toContain('1〜2 分');
    // **本文から外した導線**（行き先はヘッダとアカウントのメニュー。2.3.3 の注記の表）。
    for (const path of [SIGNUP_PATH, GENERATE_PAGE_PATH, MY_WORKS_PATH, INVITES_PATH]) {
      expect(body, path).not.toContain(`href="${path}"`);
    }
    expect(body).not.toContain('gf-cta');
  });
});

describe('ハブ型のトップ（#329 / M9-3。仕様 2.3.1 / 2.3.3）', () => {
  it('`/` が D1 を読む', async () => {
    // **かつてここは「`/` が D1 を読まない」を確かめていた**（3.6 の無料枠を理由に、
    // トップは 1 行も引かないと決めていた）。**仕様 2.3.3 がその決定を覆した**
    // ——ハブ型のトップは作品の行を読まないと 1 枚も描けない。
    //
    // **`src/home.ts` のコメントが説明している振る舞いを、ここで固定する。**
    // 引かなくなったら（＝コメントが説明している形へ戻ったら）赤くなる。
    await purgeListCache(HOME_CACHE_KEY);
    let prepared = 0;
    const watched = {
      ...env,
      DB: new Proxy(env.DB, {
        get(target, property, receiver) {
          const value = Reflect.get(target, property, receiver) as unknown;
          if (property === 'prepare') {
            prepared += 1;
          }
          return typeof value === 'function'
            ? (value as (...args: unknown[]) => unknown).bind(target)
            : value;
        },
      }),
    } as unknown as Env;

    await openHome(watched);
    expect(prepared).toBeGreaterThan(0);
  });

  it('D1 が落ちていてもトップは 200 を返す', async () => {
    // **トップは URL 拡散の着地点である。** 作品の節を引けなかったことで、案内と登録の
    // 導線（D1 を 1 行も要らない）まで一緒に落とさない（`src/home.ts` の `homeFeed`）。
    await purgeListCache(HOME_CACHE_KEY);
    const broken = {
      ...env,
      DB: new Proxy(
        {},
        {
          get() {
            throw new Error('D1 が使えません');
          },
        },
      ),
    } as unknown as Env;

    const response = await handleAppRequest(new Request(`${APP_ORIGIN}${HOME_PATH}`), broken);
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain('<h1 class="gf-header-title">');
    // **告知は D1 を読まないので残る**（仕様 2.3.3 の #435 注記。#471 で案内を告知 1 つに絞った）。
    expect(body).toContain(CLOSED_BETA_NOTICE);
    expect(body).not.toContain('gf-home-section');
  });

  it('4 節が仕様 2.3.1 の順に並ぶ', async () => {
    const official = await seedPublished({ operator: true, likeCount: 3, forkCount: 3 });
    const ordinary = await seedPublished({ likeCount: 5, forkCount: 5 });

    const body = await openHome();
    for (const title of [
      OFFICIAL_SECTION_TITLE,
      HOME_SORT_TITLES.recent,
      HOME_SORT_TITLES.forked,
      HOME_SORT_TITLES.liked,
    ]) {
      expect(body, title).toContain(`<h2 id="gf-home-`);
      expect(body, title).toContain(`>${title}</h2>`);
    }
    // **見出しの順序も仕様の順である**（公式サンプル → 新着 → 改造された数の順 →
    // いいねの多い順）。
    const order = [
      OFFICIAL_SECTION_TITLE,
      HOME_SORT_TITLES.recent,
      HOME_SORT_TITLES.forked,
      HOME_SORT_TITLES.liked,
    ].map((title) => body.indexOf(`>${title}</h2>`));
    expect(order).toEqual([...order].sort((a, b) => a - b));

    // 仕込んだ作品が実際に並んでいること（節が空の枠ではないこと）。
    expect(body).toContain(workPagePath(official));
    expect(body).toContain(workPagePath(ordinary));
    // 節は 4 つで、それ以上でも以下でもない。
    expect(body.split('<section class="gf-home-section"').length - 1).toBe(4);
  });

  it('節ごとの「もっと見る」が、その軸の一覧へ送る', async () => {
    await seedPublished({ likeCount: 2, forkCount: 2 });

    const body = await openHome();
    for (const sort of ['recent', 'forked', 'liked'] as const) {
      expect(body, sort).toContain(`href="${worksListPath(sort, 1)}"`);
    }
    // **公式サンプルの節には置かない**（`/works` の 3 軸はどれも公式サンプルを絞らない。
    // 行き先が実在しないリンクを置かない。2.3.7 / 4.4）。
    expect(body.split('gf-home-more"').length - 1).toBe(3);
    // **見出しの行の右に置く小さい副のボタン**（仕様 2.5.3 / 2.5.5。#471）。HTML の順は 見出し → ボタン。
    const recent = body.slice(body.indexOf('<section class="gf-home-section" aria-labelledby="gf-home-recent"'));
    const head = recent.slice(0, recent.indexOf('</div>'));
    expect(head).toContain('<div class="gf-home-head">');
    expect(head.indexOf('</h2>')).toBeLessThan(
      head.indexOf('<a class="gf-button gf-button-secondary gf-button-sm gf-home-more"'),
    );
  });

  it('1 節に並ぶカードは 8 枚までである', async () => {
    for (let count = 0; count < HOME_SECTION_LIMIT + 3; count += 1) {
      await seedPublished({ likeCount: count + 1, forkCount: count + 1 });
    }

    const body = await openHome();
    const sections = body.split('<section class="gf-home-section"').slice(1);
    expect(sections.length).toBe(4);
    for (const section of sections) {
      const cards = section.split('<li class="gf-card gf-block">').length - 1;
      expect(cards).toBeGreaterThan(0);
      expect(cards).toBeLessThanOrEqual(HOME_SECTION_LIMIT);
    }
  });

  it('作品が 0 本でも 200 を返し、節を 1 つも出さない', async () => {
    // **空の節を出さない**（見出しだけが並ぶ画面は、出来ていないものを出来ているように
    // 見せる）。告知は残る。
    const body = await openHome({ ...env, DB: EMPTY_DB } as unknown as Env);
    expect(body).toContain('<h1 class="gf-header-title">');
    expect(body).not.toContain('gf-home-section');
    expect(body).not.toContain(OFFICIAL_SECTION_TITLE);
    expect(body).toContain(CLOSED_BETA_NOTICE);
    // 後のテストが空の保存物を読まないよう捨てる（TTL 60 秒を待たない）。
    await purgeListCache(HOME_CACHE_KEY);
  });

  it('いいねが 1 件も無いと、いいねの節を出さない', async () => {
    // issue #329 / roadmap M9-3。**見出しだけが出て中身が全部「0」の節を置かない。**
    const body = await openHome({ ...env, DB: stubDb([stubRow(0), stubRow(0)]) } as unknown as Env);
    expect(body).toContain(`>${HOME_SORT_TITLES.recent}</h2>`);
    expect(body).toContain(`>${HOME_SORT_TITLES.forked}</h2>`);
    expect(body).not.toContain(`>${HOME_SORT_TITLES.liked}</h2>`);
    expect(body).not.toContain(`href="${worksListPath('liked', 1)}"`);
    await purgeListCache(HOME_CACHE_KEY);
  });

  it('いいねが 1 件でもあれば、いいねの節を出す', async () => {
    // 上のテストと対になる（**節が「常に出ない」形でも上が緑になる**ので、両向きを置く）。
    const body = await openHome({ ...env, DB: stubDb([stubRow(1), stubRow(0)]) } as unknown as Env);
    expect(body).toContain(`>${HOME_SORT_TITLES.liked}</h2>`);
    await purgeListCache(HOME_CACHE_KEY);
  });

  it('見出しの綴りが仕様 2.3.1 の `/` の行と一致する', () => {
    // **綴りをテストへ書き写さない。** `src/works-list.ts` の `SORT_LABELS` は輸出されて
    // いないので借りられない。正本は仕様 2.3.1 の表の `/` の行なので、そこと照合する
    // （同じ手を #17 が許可パッケージ一覧で使っている。shared-ai-rules 12 章）。
    const row = env.TEST_PRODUCT_SPEC.split('\n').find(
      (line) => line.startsWith('| `/` |') && line.includes('トップ'),
    );
    expect(row, '仕様 2.3.1 の `/` の行').toBeDefined();
    for (const title of [
      OFFICIAL_SECTION_TITLE,
      HOME_SORT_TITLES.recent,
      HOME_SORT_TITLES.forked,
      HOME_SORT_TITLES.liked,
    ]) {
      expect(row!, title).toContain(title);
    }
    // **1 節の件数も仕様から読む**（「各 8 件ずつ」）。
    expect(row!).toContain(`各 ${HOME_SECTION_LIMIT} 件`);
  });
});

describe('`/__dev/*` の本番遮断（#89）', () => {
  it('本番の設定では開発用の経路が 1 つも登録されない', () => {
    expect(devRoutesEnabled(productionEnv)).toBe(false);
    const paths = createAppRoutes(productionEnv).map((route) => route.path);
    expect(paths.filter((path) => path.startsWith('/__dev'))).toEqual([]);
  });

  it('本番の設定では `/__dev/*` が 404 になる', async () => {
    const paths = ['/__dev/', '/__dev/health', '/__dev/session', '/__dev/cookies', '/__dev/components'];
    await Promise.all(
      paths.map(async (path) => {
        const response = await handleAppRequest(
          new Request(`${APP_ORIGIN}${path}`),
          productionEnv,
        );
        expect(response.status, path).toBe(404);
        // set-cookie が出ないこと。`/__dev/session` は cookie を発行する経路なので、
        // 遮断が「本文だけ変えた」形になっていないかをここで見る。
        expect(response.headers.get('set-cookie'), path).toBeNull();
      }),
    );
  });

  it('本番の設定でも `/` と `/signup` は残る', () => {
    const registered = createAppRoutes(productionEnv).map(
      (route) => `${route.method} ${route.path}`,
    );
    expect(registered).toContain(`GET ${HOME_PATH}`);
    expect(registered).toContain(`GET ${SIGNUP_PATH}`);
    expect(registered).toContain(`POST ${SIGNUP_PATH}`);
  });

  it('有効・無効のどちらでも経路が重複しない', () => {
    // `/` の登録が公開トップと開発用の索引で二重にならないこと。dispatch は最初に
    // 一致した経路を使うため、重複しても動いてしまう（#89 で索引を `/__dev/` へ
    // 移した理由そのもの）。
    expect(findDuplicateRoutes(createAppRoutes(env))).toEqual([]);
    expect(findDuplicateRoutes(createAppRoutes(productionEnv))).toEqual([]);
  });

  it('綴りを間違えた値では有効にならない（既定は閉じる側）', () => {
    for (const value of ['', 'ENABLED', 'true', 'enable', 'disabled']) {
      expect(devRoutesEnabled(envWithDevRoutes(value)), value).toBe(false);
    }
    expect(devRoutesEnabled(envWithDevRoutes('enabled'))).toBe(true);
  });
});
