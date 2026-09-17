/**
 * システムプロンプトの版（#605 / `src/prompt-version.ts`）。
 *
 * **このテストが落ちたときにやることは、値を合わせることではない。**
 * `PROMPT_VERSION` を上げたうえで `PROMPT_TEXT_SHA256` を合わせる。値だけを合わせると、
 * **版が同じまま本文だけが変わった生成が台帳に混ざり、前後比較が壊れる。**
 *
 * shared-ai-rules 12 章の「一覧の複製は機械照合で担保する」と同じ形である——版という
 * 複製を置くが、古くなったことを機械が判定するので、空更新では通らない。
 */
import { describe, expect, it } from 'vitest';
import {
  PROMPT_TEXT_SHA256,
  PROMPT_VERSION,
  PROMPT_VERSION_HISTORY,
} from '../src/prompt-version.js';
import { renderSystemPromptText } from '../src/system-prompt.js';

/**
 * 文字列の SHA-256 を小文字 16 進で返す。
 *
 * **`crypto.subtle` はテストの中でだけ使う。** 生成の経路では 1 度も計算しない
 * （`src/prompt-version.ts` の「なぜ本文のハッシュを実行時に計算しないのか」）。
 *
 * @param text ハッシュを取る文字列
 * @returns 小文字 16 進の SHA-256
 */
async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

describe('本文と版の照合', () => {
  it('いまの本文のハッシュが PROMPT_TEXT_SHA256 と一致する', async () => {
    // **落ちたら、まず `PROMPT_VERSION` を上げること。**
    await expect(sha256Hex(renderSystemPromptText())).resolves.toBe(PROMPT_TEXT_SHA256);
  });

  it('版は 1 以上の整数である', () => {
    expect(Number.isInteger(PROMPT_VERSION)).toBe(true);
    expect(PROMPT_VERSION).toBeGreaterThanOrEqual(1);
  });

  it('ハッシュは 64 桁の小文字 16 進である', () => {
    // 綴りが崩れた値（大文字・空・途中まで）を置いたまま通らないようにする。
    expect(PROMPT_TEXT_SHA256).toMatch(/^[0-9a-f]{64}$/u);
  });
});

describe('版の履歴（PR #607 の Copilot の指摘）', () => {
  it('最後の行がいまの版である', () => {
    // **値だけを合わせて版を据え置く**操作を、差分として見えるようにする。
    const last = PROMPT_VERSION_HISTORY[PROMPT_VERSION_HISTORY.length - 1]!;
    expect(last.version).toBe(PROMPT_VERSION);
    expect(last.sha256).toBe(PROMPT_TEXT_SHA256);
  });

  it('版は 1 から 1 つずつ増え、飛ばさない', () => {
    PROMPT_VERSION_HISTORY.forEach((entry, index) => {
      expect(entry.version).toBe(index + 1);
    });
  });

  it('同じ本文の版が 2 つ無い', () => {
    // 同じハッシュが 2 行あるのは、**中身を変えずに版だけ上げた**ということなので、
    // 台帳の版が意味を持たなくなる。
    const hashes = PROMPT_VERSION_HISTORY.map((entry) => entry.sha256);
    expect(new Set(hashes).size).toBe(hashes.length);
  });

  it('どの行も 64 桁の小文字 16 進である', () => {
    for (const entry of PROMPT_VERSION_HISTORY) {
      expect(entry.sha256).toMatch(/^[0-9a-f]{64}$/u);
    }
  });
});

describe('本文の側に版を持ち込まない', () => {
  it('システムプロンプトの本文に版の数字が現れない', () => {
    // **本文へ版を書くとキャッシュが割れる**（4.5）。版が上がるたびに本文が変わるので、
    // **本文を変えていないのにキャッシュが作り直しになる。** 版は台帳の列であって、
    // モデルへ渡すものではない。
    expect(renderSystemPromptText()).not.toContain(`PROMPT_VERSION`);
    expect(renderSystemPromptText()).not.toContain(PROMPT_TEXT_SHA256);
  });
});
