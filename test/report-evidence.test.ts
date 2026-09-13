import { env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  DESCRIPTION_HISTORY,
  DISPLAY_NAME_HISTORY,
  TITLE_HISTORY,
  differsFromNow,
  displayNameRecordedAt,
  restoreValueAt,
} from '../src/admin/report-evidence.js';
import type { HistoryNeighbors, HistorySource } from '../src/admin/report-evidence.js';
import {
  DISPLAY_NAME_CHANGES_TABLE,
  DISPLAY_NAME_HISTORY_START_TABLE,
} from '../src/display-name-changes.js';
import { applySchema } from './helpers/schema.js';

/**
 * 通報の時点の値を復元する規則（#405。`src/admin/report-evidence.ts`）。
 *
 * **ここは規則そのもの（純粋な関数）と、履歴の表の綴りを見る。** 審査キューの画面に
 * 実際に出ることと、読み取りの本数が通報の数に比例しないことは `test/admin-screens.test.ts`
 * が見る。
 *
 * **変異で確かめた**（2026-09-13。`restoreValueAt` / `displayNameRecordedAt` を 1 か所ずつ
 * 書き換えて、このファイルと `test/admin-screens.test.ts` を回した。結果は
 * `test/admin-screens.test.ts` の #405 の describe の冒頭にまとめた）。
 */

/** 変更が 1 件も無い前後。 */
const NO_CHANGES: HistoryNeighbors = {
  newAtOrBefore: null,
  oldAfter: null,
  newBefore: null,
  oldAtOrAfter: null,
  sameSecond: false,
};

beforeAll(async () => {
  await applySchema();
});

describe('復元の規則（#405 の constraints の 1 行目）', () => {
  it('T 以前で最後の変更があれば、その新しい値（T より後の変更の古い値より先に使う）', () => {
    // **履歴が繋がっていれば 2 つは同じ値になる**ので、順序を確かめるために違う値を置く
    // （記録されない変更——運営の直接 UPDATE など——を挟むと、実際に食い違う）。
    expect(
      restoreValueAt({ ...NO_CHANGES, newAtOrBefore: 'B', newBefore: 'B', oldAfter: 'X' }, 'C', true),
    ).toEqual({ kind: 'known', value: 'B' });
  });

  it('T 以前に変更が無ければ、T より後で最初の変更の古い値', () => {
    expect(
      restoreValueAt({ ...NO_CHANGES, oldAfter: 'A', oldAtOrAfter: 'A' }, 'C', true),
    ).toEqual({ kind: 'known', value: 'A' });
  });

  it('変更が 1 件も無ければ、いまの値', () => {
    expect(restoreValueAt(NO_CHANGES, 'いまの値', true)).toEqual({ kind: 'known', value: 'いまの値' });
  });

  it('空文字は値である（説明を消した状態を「変更が無い」と取り違えない）', () => {
    // `||` で繋ぐと、空の説明の次の候補（いまの値）へ落ちる。
    expect(restoreValueAt({ ...NO_CHANGES, newAtOrBefore: '' }, '書き足した説明', true)).toEqual({
      kind: 'known',
      value: '',
    });
    expect(restoreValueAt({ ...NO_CHANGES, oldAfter: '' }, '書き足した説明', true)).toEqual({
      kind: 'known',
      value: '',
    });
  });
});

describe('同じ秒は、どちらかに倒さずに両方を出す（#405 の constraints）', () => {
  it('通報と同じ秒に変更があれば、その秒の変更の前と後を両方返す', () => {
    // 時刻 T に A → B の変更が 1 件だけある。
    expect(
      restoreValueAt(
        { newAtOrBefore: 'B', oldAfter: null, newBefore: null, oldAtOrAfter: 'A', sameSecond: true },
        'B',
        true,
      ),
    ).toEqual({ kind: 'same-second', before: 'A', after: 'B' });
  });

  it('同じ秒の前後にも変更があれば、その秒の最初の前と最後の後である', () => {
    // T-10 に X → A、T に A → B と B → C、T+10 に C → D。
    expect(
      restoreValueAt(
        { newAtOrBefore: 'C', oldAfter: 'C', newBefore: 'A', oldAtOrAfter: 'A', sameSecond: true },
        'D',
        true,
      ),
    ).toEqual({ kind: 'same-second', before: 'A', after: 'C' });
  });

  it('同じ秒の変更が無ければ、境界を動かしても同じ値なので 1 つに決める', () => {
    expect(
      restoreValueAt(
        { newAtOrBefore: 'A', oldAfter: 'A', newBefore: 'A', oldAtOrAfter: 'A', sameSecond: false },
        'D',
        true,
      ),
    ).toEqual({ kind: 'known', value: 'A' });
  });
});

describe('履歴が無い時点について、いまの値を当時の値として出さない（#405 の constraints）', () => {
  it('記録が無ければ、変更の有無に関わらず「記録が無い」', () => {
    expect(restoreValueAt(NO_CHANGES, 'いまの名前', false)).toEqual({ kind: 'unrecorded' });
    expect(restoreValueAt({ ...NO_CHANGES, oldAfter: '旧い名前' }, 'いまの名前', false)).toEqual({
      kind: 'unrecorded',
    });
  });

  it('表示名は、履歴を書き始めた時刻より後の通報だけ記録がある（同じ秒は記録が無い側）', () => {
    expect(displayNameRecordedAt(1_000, 999)).toBe(true);
    expect(displayNameRecordedAt(1_000, 1_000)).toBe(false);
    expect(displayNameRecordedAt(1_000, 1_001)).toBe(false);
    // 基準の行が無ければ、記録が無いとみなす（誤った値を出す側へ倒さない）。
    expect(displayNameRecordedAt(1_000, null)).toBe(false);
  });

  it('記録が無いものは、いまの値と「違う・同じ」を判定しない', () => {
    expect(differsFromNow({ kind: 'unrecorded' }, 'いまの名前')).toBeNull();
    expect(differsFromNow({ kind: 'known', value: 'A' }, null)).toBeNull();
    expect(differsFromNow({ kind: 'known', value: 'A' }, 'A')).toBe(false);
    expect(differsFromNow({ kind: 'known', value: 'A' }, 'B')).toBe(true);
    // 同じ秒は、どちらだった可能性もあるので、片方でも違えば「違う」。
    expect(differsFromNow({ kind: 'same-second', before: 'A', after: 'B' }, 'B')).toBe(true);
    expect(differsFromNow({ kind: 'same-second', before: 'B', after: 'B' }, 'B')).toBe(false);
  });
});

describe('3 つの履歴の表の綴りが、実在の表と一致する（書き写した綴りは腐る）', () => {
  /**
   * 表の列の名前を引く。
   *
   * @param table 表の名前
   * @returns 列の名前
   */
  async function columnsOf(table: string): Promise<string[]> {
    const rows = await env.DB.prepare('select name from pragma_table_info(?)')
      .bind(table)
      .all<{ name: string }>();
    return rows.results.map((row) => row.name);
  }

  const sources: readonly [string, HistorySource][] = [
    ['題名', TITLE_HISTORY],
    ['説明', DESCRIPTION_HISTORY],
    ['表示名', DISPLAY_NAME_HISTORY],
  ];
  for (const [label, source] of sources) {
    it(`${label}の履歴（${source.table}）が同じ形の列を持つ`, async () => {
      const columns = await columnsOf(source.table);
      for (const column of ['id', source.keyColumn, source.oldColumn, source.newColumn, 'changed_at']) {
        expect(columns, `${source.table}.${column}`).toContain(column);
      }
    });
  }

  it('表示名の履歴は (user_id, changed_at) の索引を持つ（通報 1 件ごとの端を読むため）', async () => {
    const indexes = await env.DB.prepare(
      "select name from sqlite_master where type = 'index' and tbl_name = ?",
    )
      .bind(DISPLAY_NAME_CHANGES_TABLE)
      .all<{ name: string }>();
    const shapes: string[][] = [];
    for (const { name } of indexes.results) {
      const info = await env.DB.prepare('select name from pragma_index_info(?) order by seqno')
        .bind(name)
        .all<{ name: string }>();
      shapes.push(info.results.map((column) => column.name));
    }
    expect(shapes).toContainEqual(['user_id', 'changed_at']);
  });

  it('履歴を書き始めた時刻の行が 1 つだけあり、2 行目は入らない', async () => {
    const rows = await env.DB.prepare(`select id, started_at from ${DISPLAY_NAME_HISTORY_START_TABLE}`).all<{
      id: number;
      started_at: number;
    }>();
    expect(rows.results).toHaveLength(1);
    expect(rows.results[0]?.id).toBe(1);
    expect(rows.results[0]?.started_at).toBeGreaterThan(0);
    await expect(
      env.DB.prepare(`insert into ${DISPLAY_NAME_HISTORY_START_TABLE} (id, started_at) values (2, 1)`).run(),
    ).rejects.toThrow();
  });
});
