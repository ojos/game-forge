import { describe, expect, it } from 'vitest';
import { FORK_NOTICE_KIND_LABEL, MAIL_KINDS, unmutableUserMailKinds } from '../src/mail/kinds.js';

/**
 * メールの種別の登録簿（`src/mail/kinds.ts`。5.11 / #384）。
 *
 * **登録簿は一覧の複製である**（送信のモジュールがそれぞれ `LABEL` を持つ）。複製は必ず腐るので、
 * **ソースを走査して機械照合する**（shared-ai-rules 12 章）。通知を 1 本足した人が登録簿へ 1 行
 * 足さないと、ここが赤くなる。
 *
 * **ソースは Vite の `import.meta.glob` で文字列として読む。** テストは workerd の中で走り、
 * ファイルシステムが無い（`vitest.config.ts` の冒頭）。glob はビルド時に展開されるので、
 * 設定ファイルへ束縛を足さずに済む。
 */

declare global {
  interface ImportMeta {
    /** Vite が変換時に展開する（`?raw` で中身の文字列を返す）。 */
    glob(
      pattern: string | readonly string[],
      options: { readonly query: '?raw'; readonly import: 'default'; readonly eager: true },
    ): Record<string, string>;
  }
}

/** アプリのソース（パス → 中身）。Pages Functions の入口と、別スクリプトの Worker も含める。 */
const SOURCES: Readonly<Record<string, string>> = import.meta.glob(
  ['../src/**/*.ts', '../functions/**/*.ts', '../workers/**/*.ts'],
  { query: '?raw', import: 'default', eager: true },
);

/** 送信の土台（1 通の送り方だけを持ち、札を持たない）。 */
const MAIL_BASE = '../src/mail/resend.ts';

/** 登録簿そのもの。 */
const REGISTRY = '../src/mail/kinds.ts';

/** 改造通知の送信の口。 */
const FORK_NOTICE = '../src/mail/fork-notice.ts';

/**
 * `sendMail` を使う（＝メールを送る）モジュール。
 *
 * **`sendMail` という名前が現れるかで見る。** 送信の依存を差し替えられる形（`deps.send`）でも、
 * 既定値として `sendMail` を import するので、名前は必ず現れる。
 *
 * @returns パス → 中身
 */
function senderSources(): [string, string][] {
  return Object.entries(SOURCES).filter(
    ([path, text]) => path !== MAIL_BASE && path !== REGISTRY && /\bsendMail\b/u.test(text),
  );
}

/**
 * モジュールが持つ札（`const LABEL = '...'`）を取り出す。
 *
 * @param text ソース
 * @returns 札の一覧
 */
function labelsOf(text: string): string[] {
  return [...text.matchAll(/\bconst LABEL = '([^']+)'/gu)].map((match) => match[1]!);
}

/**
 * コメントを落とす（**文書として列の名前を書いただけのファイルを、読んでいると数えない**）。
 *
 * 粗い落とし方である（文字列の中の `//` も落ちる）。使うのは列の名前を探すときだけで、
 * SQL は文字列の中にあり `//` を含まないので足りる。
 *
 * @param text ソース
 * @returns コメントを除いたソース
 */
function withoutComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/^\s*\/\/.*$/gmu, '');
}

describe('ソースの走査が空振りしていない', () => {
  it('送信の土台と、既知の送信のモジュールを読めている', () => {
    // **読めていなければ、下の照合はすべて「0 件どうしで一致」して緑になる。**
    expect(SOURCES[MAIL_BASE]).toContain('export async function sendMail');
    expect(SOURCES[FORK_NOTICE]).toContain('export async function notifyForkPublished');
    expect(senderSources().length).toBeGreaterThanOrEqual(4);
  });
});

describe('sendMail を呼ぶすべての札が登録簿に載っている（#384）', () => {
  it('送信のモジュールは札をちょうど 1 つ持ち、それを送信へ渡している', () => {
    for (const [path, text] of senderSources()) {
      expect(labelsOf(text), `${path} の札`).toHaveLength(1);
      // 札を文字列で直に渡す送信があると、下の照合をすり抜ける。**送信へ渡す引数が `LABEL` で
      // あること**を見る（`send(env, message, LABEL, deps)` / `send(env, {...}, LABEL)`）。
      expect(text, `${path} は LABEL を送信へ渡していない`).toMatch(/,\s*LABEL\s*[,)]/u);
    }
  });

  it('ソースの札の集合と、登録簿の「送る実体がある種別」の集合が一致する', () => {
    const inSources = senderSources().flatMap(([, text]) => labelsOf(text)).sort();
    const inRegistry = MAIL_KINDS.filter((kind) => kind.implemented)
      .map((kind) => kind.label)
      .sort();
    // **足した通知が登録簿に無い**と左が多く、**消した通知が登録簿に残っている**と右が多い。
    expect(inSources).toEqual(inRegistry);
  });

  it('Resend を直に呼ぶ経路が、送信の土台の外に無い', () => {
    // `sendMail` を通らない送信は、上の走査に 1 行も現れない。
    for (const [path, text] of Object.entries(SOURCES)) {
      if (path === MAIL_BASE) {
        continue;
      }
      expect(text, `${path} が Resend を直に呼んでいる`).not.toContain('api.resend.com');
    }
  });
});

describe('止められる種別と、止められない種別（5.11）', () => {
  it('札は重複しない', () => {
    const labels = MAIL_KINDS.map((kind) => kind.label);
    expect(new Set(labels).size).toBe(labels.length);
  });

  it('止められるのは改造通知だけである（止められる種別を足したら、ここと送信の口の判定を足す）', () => {
    // **ここを書き換える人は、足した種別の送信の口にも設定の判定を置くこと。** 判定の無い
    // 「止められる種別」は、画面で止めても届き続ける（5.11「明示した以上、そのとおりに動く」）。
    expect(MAIL_KINDS.filter((kind) => kind.mutable).map((kind) => kind.label)).toEqual([
      FORK_NOTICE_KIND_LABEL,
    ]);
    expect(labelsOf(SOURCES[FORK_NOTICE]!)).toEqual([FORK_NOTICE_KIND_LABEL]);
  });

  it('運用者宛ての種別と、送る実体の無い種別は止められない', () => {
    for (const kind of MAIL_KINDS) {
      if (kind.audience === 'operator' || !kind.implemented) {
        expect(kind.mutable, kind.label).toBe(false);
      }
    }
  });

  it('利用者宛ての止められない種別は、生成の完了と、約束だけの 2 つである（利用者の決定）', () => {
    // **送っているのは生成の完了だけ**（#384 の着手前の決定 1）。**セキュリティと仕様変更は
    // 送る実体が無い**（決定 2）。**送る実体のある止められない種別を足したら、
    // `test/mail.test.ts` の「設定にかかわらず送る」の検査も足すこと。**
    expect(
      unmutableUserMailKinds().map((kind) => [kind.label, kind.implemented]),
    ).toEqual([
      ['generation-finished', true],
      ['account-security', false],
      ['important-changes', false],
    ]);
    for (const kind of unmutableUserMailKinds().filter((entry) => !entry.implemented)) {
      // 出来ていないものを出来ているように書かない。
      expect(kind.note, kind.label).toContain('いまは送っていません');
      expect(kind.note, kind.label).toContain('設定にかかわらず送ります');
    }
  });
});

describe('設定の判定は、止められる種別の送信の口の 1 か所にだけある（5.11）', () => {
  it('受け取らない設定の列を読む送信のモジュールは、改造通知だけである', () => {
    const readers = senderSources()
      .filter(([, text]) => withoutComments(text).includes('fork_notice_muted_at'))
      .map(([path]) => path);
    expect(readers).toEqual([FORK_NOTICE]);
  });

  it('列を触るアプリのソースは、送信の口・設定の画面・退会の 3 つだけである', () => {
    // **4 つ目が現れたら、判定が 2 か所になっていないかを疑う**（数え方を 2 か所に持たない。2.3.13）。
    //
    // **退会（`src/withdrawal.ts`。#518 / #586）はこの列を「判定」しない。** 匿名化の一部として
    // NULL（＝既定）へ戻すだけで、送るかどうかを決める条件をここへ増やしていない
    // （下の検査が、読む側は改造通知だけであることを見ている）。
    const touching = Object.entries(SOURCES)
      .filter(([, text]) => withoutComments(text).includes('fork_notice_muted_at'))
      .map(([path]) => path)
      .sort();
    expect(touching).toEqual(['../src/account.ts', FORK_NOTICE, '../src/withdrawal.ts'].sort());
  });
});

describe('登録簿は値だけの葉である', () => {
  it('登録簿は何も import しない', () => {
    expect(SOURCES[REGISTRY]).not.toMatch(/^import\b/mu);
  });

  it('送信のモジュールは登録簿を import しない（束に入るファイルを画面の都合で動かさない）', () => {
    // `src/mail/generation-notice.ts` と `src/mail/resend.ts` はオーケストレータの束に入っている。
    // **送信のモジュールからは一律に import させない**——どれが束に入るかは import の連鎖で
    // 変わるので、いま入っていないモジュールだけを許すと、連鎖が変わった日に黙って入る。
    for (const [path, text] of [...senderSources(), [MAIL_BASE, SOURCES[MAIL_BASE]!] as [string, string]]) {
      expect(text, `${path} が登録簿を import している`).not.toMatch(/from '(?:\.\.?\/)+(?:mail\/)?kinds\.js'/u);
    }
  });
});
