import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { describeOriginRelation, normalizeHost } from '../src/origins.js';

describe('normalizeHost', () => {
  it('ポートと末尾ドットを落とし、小文字へそろえる', () => {
    expect(normalizeHost('Game-Forge.LocalTest.me:8787')).toBe('game-forge.localtest.me');
    expect(normalizeHost('game-forge.ojos.jp.')).toBe('game-forge.ojos.jp');
    expect(normalizeHost('  game-forge.ojos.jp  ')).toBe('game-forge.ojos.jp');
  });
});

describe('describeOriginRelation', () => {
  it('本番の組み合わせ（兄弟）が別オリジン・同一サイトになる', () => {
    // #89 でアプリ用ホストが `app.` 付きになり、サンドボックスとは兄弟関係になった
    // （`game-forge.ojos.jp` は Route53 ゾーンの apex で CNAME を張れない）。
    const relation = describeOriginRelation(
      'app.game-forge.ojos.jp',
      'sandbox.game-forge.ojos.jp',
    );
    expect(relation.differentOrigin).toBe(true);
    expect(relation.sameSite).toBe(true);
    expect(relation.reasons).toEqual([]);
  });

  it('開発の組み合わせが本番と同じ関係になる', () => {
    const relation = describeOriginRelation(
      'game-forge.localtest.me',
      'sandbox.game-forge.localtest.me',
    );
    expect(relation.differentOrigin).toBe(true);
    expect(relation.sameSite).toBe(true);
  });

  it('同一ホストは別オリジンとして扱わない', () => {
    const relation = describeOriginRelation('game-forge.ojos.jp', 'game-forge.ojos.jp');
    expect(relation.differentOrigin).toBe(false);
  });

  it('サブドメイン関係（片方が他方の下）も同一サイトのまま扱う', () => {
    // #89 の一般化で兄弟を通すようにしたが、従来通る形が落ちてはいけない。
    const relation = describeOriginRelation('game-forge.ojos.jp', 'sandbox.ojos.jp');
    expect(relation.sameSite).toBe(true);
  });

  it('共通の親が TLD だけのホストを同一サイトとして扱わない', () => {
    const relation = describeOriginRelation('game-forge.jp', 'sandbox.jp');
    expect(relation.differentOrigin).toBe(true);
    expect(relation.sameSite).toBe(false);
    expect(relation.reasons.join('\n')).toContain('共通の親ドメインがありません');
  });

  it('別サイトのホストを同一サイトと誤判定しない', () => {
    const relation = describeOriginRelation('game-forge.ojos.jp', 'sandbox.example.com');
    expect(relation.differentOrigin).toBe(true);
    expect(relation.sameSite).toBe(false);
  });

  it('接尾辞が一致するだけのホストで共通の親を取り違えない', () => {
    // "evilojos.jp" は "ojos.jp" で終わるが、ラベル境界が一致しないため共通の親は
    // `jp` しかない。ドット無しの endsWith で書くとここが通ってしまう。
    const relation = describeOriginRelation('ojos.jp', 'evilojos.jp');
    expect(relation.sameSite).toBe(false);
  });

  it('サブドメインのラベルが空のホストを同一サイト扱いしない', () => {
    // ".game-forge.ojos.jp" はラベル単位の突き合わせでは共通接尾辞を持ってしまうが、
    // 先頭ラベルが空でホスト名として成立しない。空ラベルの検査で弾く。
    const relation = describeOriginRelation('game-forge.ojos.jp', '.game-forge.ojos.jp');
    expect(relation.sameSite).toBe(false);
  });
});

/**
 * `wrangler.toml` が宣言している**本番の**ホスト名の組を、宣言そのものから読んで
 * 検査する（#89）。
 *
 * `describeOriginRelation` は「同一サイトか」を PSL 無しの近似で答える関数で、
 * `ojos.jp` 配下ならどんな綴りでも通す。**ホスト名の取り違えを捕まえる役目はここが持つ。**
 * 期待値をテストへ書き写さず宣言を読むのは、宣言を変えたときにテストだけが古い値を
 * 見続ける状態を作らないため（shared-ai-rules.md 12 章）。
 */
describe('wrangler.toml の本番ホスト（#89）', () => {
  /**
   * `[env.production.vars]` から `KEY = "value"` を取り出す。
   *
   * TOML の完全な解析はしない。見たいのは 1 つのテーブルの中の文字列 2 つだけで、
   * そのために依存を増やすと、増やしたものの版ずれが検証の前提になる。
   *
   * @param toml wrangler.toml の中身
   * @param key 取り出すキー名
   * @returns 値（見つからなければ null）
   */
  function productionVar(toml: string, key: string): string | null {
    const table = /^\[env\.production\.vars\][^\[]*/m.exec(toml);
    if (table === null) {
      return null;
    }
    const matched = new RegExp(`^${key}\\s*=\\s*"([^"]*)"`, 'm').exec(table[0]);
    return matched === null ? null : matched[1]!;
  }

  it('本番の APP_HOST / SANDBOX_HOST が宣言されている', () => {
    expect(productionVar(env.TEST_WRANGLER_TOML, 'APP_HOST')).toBe('app.game-forge.ojos.jp');
    expect(productionVar(env.TEST_WRANGLER_TOML, 'SANDBOX_HOST')).toBe(
      'sandbox.game-forge.ojos.jp',
    );
  });

  it('本番の組み合わせが 7.2 の別オリジン・同一サイトを満たす', () => {
    const appHost = productionVar(env.TEST_WRANGLER_TOML, 'APP_HOST');
    const sandboxHost = productionVar(env.TEST_WRANGLER_TOML, 'SANDBOX_HOST');
    expect(appHost).not.toBeNull();
    expect(sandboxHost).not.toBeNull();

    const relation = describeOriginRelation(appHost!, sandboxHost!);
    expect(relation.reasons).toEqual([]);
    expect(relation.differentOrigin).toBe(true);
    expect(relation.sameSite).toBe(true);
  });

  it('本番では開発用の経路が無効に宣言されている', () => {
    // src/app.ts の `devRoutesEnabled` は `enabled` のときだけ有効にする。宣言側が
    // 空でも閉じるが、**明示されていること**まで見る（暗黙に閉じているのと、
    // 閉じると決めたのとは、次に触る人にとって別物である）。
    expect(productionVar(env.TEST_WRANGLER_TOML, 'DEV_ROUTES')).toBe('disabled');
  });
});
