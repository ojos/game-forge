import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { handleAppRequest } from '../src/app.js';
import { DEV_COMPONENTS_PATH, renderDevComponentsPage } from '../src/dev-components.js';
import { APP_CSS_PATH } from '../src/html.js';

/**
 * 部品の一覧（`/__dev/components`。#457）。
 *
 * **本番に出ないこと**は `test/home.test.ts` の「`/__dev/*` の本番遮断」が同じ一覧で見る。ここで見るのは、
 * ローカルで開けることと、仕様 2.5 の部品がすべて並んでいること（後続の issue が確かめる場所として欠けない）。
 */

const APP_ORIGIN = `https://${env.APP_HOST}`;

describe('部品の一覧（/__dev/components。#457）', () => {
  it('ローカルの設定では 200 で開き、見た目の土台を参照する', async () => {
    const response = await handleAppRequest(new Request(`${APP_ORIGIN}${DEV_COMPONENTS_PATH}`), env as unknown as Env);
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain(`<link rel="stylesheet" href="${APP_CSS_PATH}">`);
    expect(body).toContain('<meta name="robots" content="noindex">');
  });

  it('仕様 2.5.5 の押せる物（ボタン 3 段 × 2 サイズ・チップ・リンクの見せ方 3 つ）と、2.5.4 のブロックと項目名と値の並びが並ぶ', () => {
    const page = renderDevComponentsPage();
    for (const cls of ['gf-button-primary', 'gf-button-secondary', 'gf-button-tertiary']) {
      expect(page, cls).toContain(`class="gf-button ${cls}"`);
      expect(page, `${cls} の小`).toContain(`class="gf-button ${cls} gf-button-sm"`);
    }
    for (const part of ['class="gf-chip"', 'gf-chip-current', 'gf-chip-emphasis', 'class="gf-link-quiet"', 'class="gf-tabs"', 'class="gf-block"', 'class="gf-kv"', 'gf-block-rows']) {
      expect(page, part).toContain(part);
    }
    // 状態は data-state で固定して見せる（ホバーと焦点）。押せないは disabled。
    expect(page).toContain('data-state="hover"');
    expect(page).toContain('data-state="focus"');
    expect(page).toContain(' disabled>');
  });

  it('色の段の見本に、新設の 2 つのトークンが並ぶ（仕様 2.5.2）', () => {
    const page = renderDevComponentsPage();
    expect(page).toContain('var(--gf-rule-strong)');
    expect(page).toContain('var(--gf-rule-input)');
  });
});
