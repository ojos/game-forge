import { env } from 'cloudflare:test';
import { NEW_CHAT_TARGET } from '../src/chat-target.js';
import { WORK_EDIT_SUFFIX } from '../src/work-edit-paths.js';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAppRoutes, handleAppRequest } from '../src/app.js';
import {
  BUILD_STOPPED_NOTICE,
  CANDIDATE_KEYS_EXPRESSION,
  GAME_ID_EXPRESSION,
  DAILY_QUOTA_MESSAGE_KEY,
  DEFAULT_MESSAGE_KEY,
  GENERATE_MESSAGES,
  LONG_WAIT_SECONDS,
  MONTHLY_LIMIT_MESSAGE_KEY,
  NETWORK_MESSAGE_KEY,
  QUOTA_UNKNOWN_NOTICE,
  TITLE_DECLARATION_EXAMPLE,
  TITLE_DECLARATION_NOTICE,
  TYPICAL_WAIT_TEXT,
  UNCLASSIFIED_QUOTA_MESSAGE_KEY,
  availabilityNotice,
  canSubmit,
  generateMessageKeyCandidates,
  remainingQuotaNotice,
  renderGeneratePage,
  selectGenerateMessageKey,
} from '../src/generate-page.js';
import type { GenerateAvailability } from '../src/generate-page.js';
import {
  DAILY_QUOTA_PER_USER,
  DAILY_QUOTA_REASON,
  MONTHLY_COST_LIMIT_JPY,
  MONTHLY_LIMIT_REASON,
  QUOTA_EXCEEDED_STATUS,
  QUOTA_REJECTION_REASONS,
  UNCLASSIFIED_QUOTA_CODE,
  describeQuotaRejection,
  jstDayRange,
} from '../src/quota.js';
import { DEFAULT_GENERATION_MODEL_KEY } from '../src/generation-models.js';
import { GENERATE_PATH, MAX_PROMPT_LENGTH } from '../src/generate.js';
import { HOME_PATH } from '../src/home.js';
import { GENERATE_PAGE_PATH, SIGNUP_PATH } from '../src/paths.js';
import { LOGIN_PATH } from '../src/auth/google.js';
import { dispatch, findDuplicateRoutes } from '../src/routes.js';
import { WORK_PAGE_PREFIX } from '../src/work-page.js';
import { buildSessionCookie, signSession } from '../src/session.js';
import { GENERATE_CALLBACK_PATH, generateCallbackRoutes } from '../src/generate-callback.js';
import { MAX_TITLE_LENGTH, createPendingGame, draftTitleFromPrompt } from '../src/games.js';
import { applySchema } from './helpers/schema.js';
import { pageBodyOf } from './helpers/site-shell.js';
import { MY_WORKS_PATH } from '../src/works-paths.js';

/**
 * 生成画面（5.2-1 / 4.4 / 8.3 / #128）。
 *
 * issue の acceptance 3 件のうち、ローカルで機械判定できる 2 件をここで押さえる
 * （3 件目は `bash scripts/verify.sh` そのもの）。あわせて、この画面が守ると
 * 宣言した性質——**応答本文の文字列を表示面へ持ち込まない**（8.3）——を、
 * 変異させて確かめる。
 *
 * **`/api/generate` は呼ばない。** 生成経路は本番で開通済みで、呼べば課金が発生する。
 * この画面が持つのは「送る手段」と「返ってきた状態から文言を選ぶ規則」だけなので、
 * 検査もそこで閉じる。
 */

const APP_ORIGIN = `https://${env.APP_HOST}`;
const SECRET = 'test-secret-value-for-generate-page-1';

/**
 * テスト用の env。
 *
 * @returns 秘密を差し替えた env
 */
function testEnv(): Env {
  return { ...env, SESSION_SECRET: SECRET };
}

/**
 * 利用者を 1 人用意する。
 *
 * @param suffix テスト内で一意な接尾辞
 * @param options BAN 状態
 * @returns 利用者の id
 */
async function seedUser(suffix: string, options: { banned?: boolean } = {}): Promise<string> {
  const id = `page-user-${suffix}`;
  await env.DB.prepare(
    'insert into users (id, google_sub, email, display_name, created_at, banned_at) values (?, ?, ?, ?, 1, ?)',
  )
    .bind(id, `sub-${id}`, `${id}@example.com`, suffix, options.banned === true ? 1 : null)
    .run();
  return id;
}

/**
 * セッション cookie を組み立てる。
 *
 * 失効時刻は実時刻から取る（`test/generate.test.ts` と同じ理由。固定値にすると
 * その日を過ぎた時点で壊れる時限式になる）。
 *
 * @param userId 利用者の id
 * @returns `Cookie` ヘッダの値
 */
async function sessionCookie(userId: string): Promise<string> {
  const issuedAt = Math.floor(Date.now() / 1000);
  const token = await signSession({ userId, issuedAt, expiresAt: issuedAt + 3600 }, SECRET);
  return buildSessionCookie(token, 3600).split(';')[0]!;
}

/**
 * 生成画面を開く。
 *
 * @param cookie `Cookie` ヘッダ（省略すると未ログイン）
 * @returns レスポンス
 */
async function openPage(cookie?: string): Promise<Response> {
  const headers: Record<string, string> = {};
  if (cookie !== undefined) {
    headers['cookie'] = cookie;
  }
  return await handleAppRequest(
    new Request(`${APP_ORIGIN}${GENERATE_PAGE_PATH}`, { headers }),
    testEnv(),
  );
}

/**
 * ページに埋め込まれたスクリプトを取り出す。
 *
 * **定数を直接 import せず、実際に配られる HTML から取る。** 検査したいのは
 * 「利用者のブラウザで動くもの」であって、モジュール内の文字列ではない。
 *
 * @param page ページの HTML
 * @returns `<script>` の中身
 */
function embeddedScript(page: string): string {
  const opened = page.indexOf('<script>');
  const closed = page.indexOf('</script>', opened);
  expect(opened).toBeGreaterThan(-1);
  expect(closed).toBeGreaterThan(opened);
  return page.slice(opened + '<script>'.length, closed);
}

beforeAll(async () => {
  await applySchema();
});

afterEach(async () => {
  // **月次上限はサービス全体の累計で判定する**（4.3 / `src/quota.ts`）。台帳の行を
  // 残すと、前のテストが積んだ 1 万円が次のテストの画面表示に効く。**このファイルが
  // 作った行だけを消す**（`generations` を丸ごと空にすると、storage を共有している
  // 他のテストを壊す。`test/quota.test.ts` と同じ理由）。
  await env.DB.prepare("delete from generations where user_id like 'page-user-%'").run();
  // 3.8 の degrade の信号も**サービス全体の状態**である（#140）。残すと次のテストの
  // 画面表示に効く。
  await env.DB.prepare('delete from build_health').run();
});

/**
 * 台帳へ行を 1 件置く（＝生成枠を 1 回消費した状態を作る）。
 *
 * **`/api/generate` を呼ばない。** 呼べば 1 回あたり約 16 円が実際に課金される
 * （2026-08-28 の実測 15.80 円 / 16.75 円）。枠の判定が見るのは `user_id` /
 * `created_at` / `cost_jpy` の 3 列だけなので、そこを直接置く
 * （`test/quota.test.ts` の `seedLedgerRow` と同じ方針）。
 *
 * @param userId 利用者の id
 * @param costJpy 円換算の費用
 * @returns なし
 */
async function seedLedgerRow(userId: string, costJpy = 0): Promise<void> {
  await env.DB.prepare(
    `insert into generations
       (id, game_id, user_id, prompt, model,
        input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens,
        cost_jpy, succeeded, created_at)
     values (?, null, ?, 'ゲーム', ?, 0, 0, 0, 0, ?, 1, ?)`,
  )
    .bind(
      crypto.randomUUID(),
      userId,
      DEFAULT_GENERATION_MODEL_KEY,
      costJpy,
      Math.floor(Date.now() / 1000),
    )
    .run();
}

describe('未ログインの導線（acceptance 1 / 8.1）', () => {
  it('未ログインで開くと、案内の文と `/signup`（ログイン・登録）への主のボタン 1 つが出る（#473）', async () => {
    const response = await openPage();
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8');

    const body = await response.text();
    const main = pageBodyOf(body);
    // **案内の文は残す**（#473 の scope.in）。
    expect(main).toContain('<h2>生成には招待コードでの登録が必要です</h2>');
    expect(main).toContain('<strong>生成は招待コードをお持ちの方に限ります</strong>');
    // **#473 までの 3 つのリンク（招待コードで登録 / 待機リスト / Google でログイン）を、主のボタン 1 つにまとめた。**
    // 待機リストとログインは `/signup` の 3 つのブロックが持つ（#472）。
    expect(main).toContain(`<p><a class="gf-button gf-button-primary" href="${SIGNUP_PATH}">ログイン・登録</a></p>`);
    expect(main.match(/<a [^>]*href="[^"]*"/gu) ?? [], '本文のリンクはボタン 1 つだけ').toHaveLength(1);
    expect(main).not.toContain(`href="${LOGIN_PATH}"`);
    expect(main.match(/gf-button-primary/gu) ?? []).toHaveLength(1);
    // ヘッダの「ログイン」も `/signup` を指す（#472）。プレイの導線はヘッダが持つ。
    expect(body).toContain(`href="${HOME_PATH}"`);
  });

  it('未ログインにはプロンプトの入力フォームを出さない', async () => {
    // 押しても必ず 401 になるフォームを出すと、利用者から見て「壊れている」ことと
    // 「登録が要る」ことの区別がつかない（`src/invite-issuance.ts` と同じ判断）。
    const body = await (await openPage()).text();
    expect(body).not.toContain('id="generate-form"');
    expect(body).not.toContain(`action="${GENERATE_PATH}"`);
    // 文言を隠し持たせてもいない（`hidden` を外すだけで見える状態にしない）。
    expect(body).not.toContain('data-message-key');
  });

  it('BAN された利用者は未ログインと同じ扱いになる', async () => {
    // 判定は `resolveSessionUser` に寄せてある。画面側で署名だけを見る実装にすると、
    // BAN が最大 7 日効かない（`src/session-user.ts`）。
    const banned = await seedUser('banned', { banned: true });
    const body = await (await openPage(await sessionCookie(banned))).text();
    expect(body).not.toContain('id="generate-form"');
    expect(body).toContain(`href="${SIGNUP_PATH}"`);
  });
});

describe('ログイン済みの入力フォーム（acceptance 2 / 5.2-1）', () => {
  it('プロンプトを送れるフォームが出る', async () => {
    const user = await seedUser('form');
    const body = await (await openPage(await sessionCookie(user))).text();

    expect(body).toContain('id="generate-form"');
    expect(body).toContain(`action="${GENERATE_PATH}"`);
    expect(body).toContain('name="prompt"');
    // 上限は `src/generate.ts` の定数から取る。書き写すと、あちらを見直したときに
    // 画面だけが古い上限で切る。
    expect(body).toContain(`maxlength="${MAX_PROMPT_LENGTH}"`);
  });

  it('待っている間に何も出ない状態を作らない（1.2.27 / #30 の手前）', async () => {
    const user = await seedUser('waiting');
    const body = await (await openPage(await sessionCookie(user))).text();

    // 経過表示の器と、通常かかる時間。**本番の実測はリクエスト全体で 90.9 秒**
    // （2026-08-28。うちビルドが 21.6 秒）。#128 の「20〜30 秒」はビルド単体の実測で、
    // 生成側を含む待ち時間ではなかった。
    expect(body).toContain('id="generate-progress"');
    expect(body).toContain('id="generate-elapsed"');
    expect(body).toContain(TYPICAL_WAIT_TEXT);
    expect(body).not.toContain('20〜30 秒');

    const script = embeddedScript(body);
    // 送信直後に器を見せ、1 秒ごとに経過を更新すること。
    expect(script).toContain('startWaiting()');
    expect(script).toContain('progress.hidden = false');
    expect(script).toContain('setInterval');
    // 二重送信で枠を空撃ちしないこと（1 回あたり**約 16 円**が出る経路である。
    // 2026-08-28 の実測 15.80 円 / 16.75 円。4.2 の「約 12 円」は古い見込み）。
    expect(script).toContain('button.disabled = true');
  });

  it('90 秒級の待ち時間で、経過秒数のほかにもう一言出す（1.2.27）', async () => {
    // **動いている数字だけでは「これは正常なのか」に答えていない。** 送信してから
    // 90 秒、画面が実質何も言わない状態は「押しても動かないボタン」と同じ問題である。
    const user = await seedUser('long-wait');
    const body = await (await openPage(await sessionCookie(user))).text();

    expect(body).toContain('id="generate-long-wait"');
    // 器は隠して描き、スクリプトは `hidden` を外すだけ（8.3）。
    expect(body).toContain('<p id="generate-long-wait" role="status" aria-live="polite" hidden>');

    const script = embeddedScript(body);
    expect(script).toContain(`seconds >= ${LONG_WAIT_SECONDS}`);
    expect(script).toContain('longWait.hidden = false');
  });

  it('JavaScript が要ることを画面上で断っている', async () => {
    // `/api/generate` は JSON しか受け付けない（`src/generate.ts`）。素のフォーム送信では
    // 届かないので、動かない環境に黙って空振りさせない。
    const user = await seedUser('noscript');
    const body = await (await openPage(await sessionCookie(user))).text();
    expect(body).toContain('<noscript>');
    expect(body).toContain('JavaScript が必要です');
    // 押しても必ず断られるボタンを出さない。HTML では無効で描き、スクリプトが
    // 動いたときだけ押せるようにする。
    expect(body).toContain('type="submit" disabled');
    expect(embeddedScript(body)).toContain('button.disabled = false;');
  });

  it('生成物をこの画面で描かない（7.2）', async () => {
    const user = await seedUser('sandboxed');
    const body = await (await openPage(await sessionCookie(user))).text();
    // 成果物を読み込む要素を持たない。配信は別オリジン（サンドボックス側）が持つ。
    expect(body).not.toContain('<iframe');
    expect(body).not.toContain('.wasm');
    expect(body).not.toContain('wasm_exec');
  });

  it('題名の宣言の書き方が画面に出ている（#365）', async () => {
    // **この画面にタイトルの入力欄は無い**（5.4）。題名を決める手段があること自体を
    // 画面で伝えないかぎり、宣言の経路は誰にも使われない。
    const user = await seedUser('title-hint');
    const body = await (await openPage(await sessionCookie(user))).text();

    expect(body).toContain(TITLE_DECLARATION_NOTICE);
    // 見出しの綴りと、それが「1 行目」であることが書かれている。
    expect(TITLE_DECLARATION_NOTICE).toContain('タイトル:');
    expect(TITLE_DECLARATION_NOTICE).toContain('1 行目');
    // 宣言が独立した 1 行であることは `placeholder` の例が示す。
    expect(body).toContain(TITLE_DECLARATION_EXAMPLE);
    expect(TITLE_DECLARATION_EXAMPLE).toContain('タイトル: ');
    // **例は「例:」で始めない**（PR #385 のレビュー指摘）。詳細は次の検査。
    // 入力欄からたどれる（読み上げでも案内が結び付く）。
    expect(body).toContain('aria-describedby="generate-title-hint"');
    expect(body).toContain('id="generate-title-hint"');
  });

  it('入力例をそのまま送ると、案内どおりの題名になる（PR #385 のレビュー指摘）', () => {
    // **例と解釈の規則を突き合わせる**（shared-ai-rules 12 章）。初版の例は `例:` の
    // 行から始まっており、写して送ると題名が `例:` になった——案内文が言っている
    // 「1 行目に宣言」と食い違っていた。ここは**例を実際に解釈して**確かめる。
    const typed = TITLE_DECLARATION_EXAMPLE.replaceAll('&#10;', '\n');
    expect(draftTitleFromPrompt(typed)).toBe('ブロックよけ');
    // 1 行目が丸ごと宣言であること（＝フォールバックに落ちていないこと）。
    expect(typed.split('\n')[0]).toBe('タイトル: ブロックよけ');
    expect(draftTitleFromPrompt(typed)).not.toBe(typed.split('\n')[0]);
  });

  it('題名の上限を案内文へ書き写していない（#365 / shared-ai-rules 12 章）', () => {
    // **`src/games.ts` の定数から作る。** 直値だと、あちらを見直した日にこの画面だけが
    // 古い字数を案内する。ここは「定数を動かせば文面も動く」ことを見る。
    expect(TITLE_DECLARATION_NOTICE).toContain(`${MAX_TITLE_LENGTH} 文字まで`);
  });
});

describe('失敗の種別ごとの文言（acceptance 2 / 4.4 / 3.8）', () => {
  it('429 と 422 が読める文言に対応づく', async () => {
    const user = await seedUser('messages');
    const body = await (await openPage(await sessionCookie(user))).text();

    // 表の鍵がそのまま描かれていること（スクリプトはこれを引くだけである）。
    for (const key of Object.keys(GENERATE_MESSAGES)) {
      expect(body, key).toContain(`data-message-key="${key}"`);
    }
    // 枠切れ（429）と、許可外 import / ビルド失敗（422 の 2 種）を出し分ける。
    // **429 は日次と月次で別の鍵になる**（#132）。分類名の正本は `src/quota.ts`。
    expect(selectGenerateMessageKey(QUOTA_EXCEEDED_STATUS, DAILY_QUOTA_REASON)).toBe(
      DAILY_QUOTA_MESSAGE_KEY,
    );
    expect(selectGenerateMessageKey(QUOTA_EXCEEDED_STATUS, MONTHLY_LIMIT_REASON)).toBe(
      MONTHLY_LIMIT_MESSAGE_KEY,
    );
    // 分類を持たない 429（段を差し替えた実装が知らない理由を返した場合）。
    expect(selectGenerateMessageKey(QUOTA_EXCEEDED_STATUS, UNCLASSIFIED_QUOTA_CODE)).toBe(
      UNCLASSIFIED_QUOTA_MESSAGE_KEY,
    );
    expect(selectGenerateMessageKey(422, 'source-rejected')).toBe('422:source-rejected');
    expect(selectGenerateMessageKey(422, 'build-failed')).toBe('422:build-failed');
    // 分類を知らない 422 でも、422 としての文言まではたどり着く。
    expect(selectGenerateMessageKey(422, 'something-new')).toBe('422:');
    // 知らないステータスは既定へ倒す（`src/signup.ts` の `REASON_MESSAGES` と同じ）。
    expect(selectGenerateMessageKey(418, '')).toBe(DEFAULT_MESSAGE_KEY);
  });

  it('422 の 2 種は「消費した枠の数」が違うことまで伝える（5.2-7）', () => {
    // 5.2-7 の注記は「試行回数と、消費した枠の回数を書いた固定の文言を載せる」と
    // 定めている（4.4 の残枠が 3 減る理由が利用者から見て消えないため）。
    expect(GENERATE_MESSAGES['422:source-rejected']).toContain('この試行ぶん');
    expect(GENERATE_MESSAGES['422:build-failed']).toContain('試行した回数ぶん');
  });

  it('500 は degrade（3.8）としても読める', () => {
    // ビルド関数の失敗・タイムアウト・スロットリングは `BuildRejected` ではないため
    // 経路層の既定の catch に落ち、500 になる。3.8 は「プレイ側には一切影響を出さない」
    // と定めるので、そこまでを文言に含める。
    expect(GENERATE_MESSAGES['500:']).toContain('プレイと共有');
  });

  it('202 の文言は、作品ページへ移れなかったときの受け皿として「準備中」を言わない（#402）', async () => {
    // **202 は通常、作品ページへ送られて表示されない**（#150。上の遷移の検査）。出るのは
    // 202 なのに `gameId` を読めなかったとき（本文が読めない・綴りが合わない）だけである。
    // **表から消すと既定の鍵まで落ちる**——生成は受け付けられ枠も使ったのに、画面は
    // 「生成に失敗しました」と言い、利用者はもう一度押す。
    expect(selectGenerateMessageKey(202, '')).toBe('202:');
    const accepted = GENERATE_MESSAGES['202:']!;
    expect(accepted).not.toBe(GENERATE_MESSAGES[DEFAULT_MESSAGE_KEY]);
    expect(accepted).not.toContain('失敗');
    expect(accepted).toContain('受け付けました');
    // 作品ページでは既に遊べて公開もできる。**開く手段が無いと読める文を残さない。**
    for (const [key, message] of Object.entries(GENERATE_MESSAGES)) {
      expect(message, key).not.toContain('準備中');
    }

    // **文言が指す行き先が、この画面から実際に押せること。** ヘッダのメニューの綴りを
    // 写さず、描かれた画面から拾う（外枠に載るので `pageBodyOf` を通さない）。
    const user = await seedUser('accepted-fallback');
    const html = await (await openPage(await sessionCookie(user))).text();
    const label = /<a href="([^"]+)">([^<]+)<\/a>/gu;
    const myWorksLabels = [...html.matchAll(label)]
      .filter((matched) => matched[1] === MY_WORKS_PATH)
      .map((matched) => matched[2]!);
    expect(myWorksLabels, '自分の作品へのリンクが無い').not.toEqual([]);
    expect(myWorksLabels.some((name) => accepted.includes(`「${name}」`)), myWorksLabels.join('/')).toBe(
      true,
    );
    // 文言そのものは本文の側に描かれている。
    expect(pageBodyOf(html)).toContain(accepted);
  });

  it('応答が返らなかった場合の文言を持つ', () => {
    // ブラウザ側のタイムアウトや通信断。**枠を消費した可能性を隠さない**
    // （生成そのものは Workers 側で走り続けうる。1.2.27）。
    expect(GENERATE_MESSAGES[NETWORK_MESSAGE_KEY]).toContain('生成枠を消費');
  });
});

describe('4.4 の記述と、429 の出し分けの機械照合（#132）', () => {
  /**
   * 仕様書 4.4 の節を切り出す。
   *
   * @param spec 仕様書の本文
   * @returns 4.4 の節
   */
  function section44(spec: string): string {
    const start = spec.indexOf('### 4.4 生成枠の UX 上の扱い');
    const end = spec.indexOf('### 4.5', start);
    return spec.slice(start, end);
  }

  /**
   * 4.4 の中で、ある目印を含む行を取り出す。
   *
   * @param spec 仕様書の本文
   * @param marker 行を特定する目印
   * @returns その行（見つからなければ空文字）
   */
  function bulletWith(spec: string, marker: string): string {
    return (
      section44(spec)
        .split('\n')
        .find((candidate) => candidate.includes(marker)) ?? ''
    );
  }

  /**
   * 行が鉤括弧で囲んでいる文言を取り出す。
   *
   * @param line 4.4 の 1 行
   * @returns 鉤括弧の中身（無ければ空文字）
   */
  function quoted(line: string): string {
    return line.match(/「([^」]+)」/u)?.[1] ?? '';
  }

  /**
   * 4.4 が分けている停止の状態と、応答の分類に対応する文言の鍵。
   *
   * **書き写しているのは「4.4 のどの行が、どの分類に対応するか」だけである。**
   * 文言そのものと、「翌日の再開時刻を示す」ことを求めているかどうかは、その行から
   * 読み取る（shared-ai-rules 12 章。文言をコードへ写すと必ず古くなる）。
   */
  const STOP_STATES = [
    { messageKey: DAILY_QUOTA_MESSAGE_KEY, marker: '枠が尽きたら' },
    { messageKey: MONTHLY_LIMIT_MESSAGE_KEY, marker: '月次上限に達した場合' },
  ] as const;

  /**
   * 画面が出す再開時刻の言い回し。
   *
   * **時刻を書き写さない。** 日次の枠が戻るのは `src/quota.ts` の日の境界、すなわち
   * JST の翌 0 時である（確定25）。境界を UTC で切る実装へ変えると、この期待は
   * 「翌日 9 時」になって文言と食い違う。
   */
  const resumeClock = (() => {
    const resetsAt = jstDayRange(Date.UTC(2020, 4, 15, 3) / 1000).toSeconds;
    const jstHour = new Date((resetsAt + 9 * 60 * 60) * 1000).getUTCHours();
    return `翌日 ${jstHour} 時`;
  })();

  /**
   * 4.4 の記述と、画面の文言表の食い違いを数え上げる。
   *
   * **判定を関数に出しているのは、変異させて確かめるためである**（仕様書側を変えても、
   * 文言表を潰しても、破れることを同じテストの中で見せる）。
   *
   * @param spec 仕様書の本文
   * @param messages 画面の文言表
   * @returns 見つかった食い違い（空なら一致）
   */
  function collationViolations(
    spec: string,
    messages: Readonly<Record<string, string>>,
  ): string[] {
    const problems: string[] = [];
    const wordings = new Map<string, string>();

    for (const state of STOP_STATES) {
      const line = bulletWith(spec, state.marker);
      const wording = quoted(line);
      if (wording === '') {
        problems.push(`4.4 から文言を拾えない: ${state.marker}`);
        continue;
      }
      wordings.set(state.messageKey, wording);

      const message = messages[state.messageKey];
      if (message === undefined) {
        problems.push(`分類に対応する文言が無い: ${state.messageKey}`);
        continue;
      }
      if (!message.includes(wording)) {
        problems.push(`4.4 の言い回しを含まない: ${state.messageKey}`);
      }
      // **「翌日の再開時刻を示す」ことを求めているのは日次の行だけである。**
      // その要求も本文から読む（行に書かれているかを見る）。
      if (line.includes('再開時刻') && !message.includes(resumeClock)) {
        problems.push(`再開時刻を示していない: ${state.messageKey}`);
      }
    }

    // **混ぜない。** 「明日また使える」と「今月はもう使えないがプレイはできる」は
    // 別の情報で、片方の文言にもう片方の言い回しが入ると、必ずどちらかが誤りになる。
    for (const [key, wording] of wordings) {
      for (const [otherKey, otherWording] of wordings) {
        if (otherKey !== key && messages[key]?.includes(otherWording) === true) {
          problems.push(`別の状態の言い回しを混ぜている: ${key}`);
        }
      }
      if (messages[UNCLASSIFIED_QUOTA_MESSAGE_KEY]?.includes(wording) === true) {
        problems.push(`分類を持たない 429 が ${key} の主張をしている`);
      }
    }

    // **区別できること自体を見る。** 同じ文言へ潰すと、分類を返す意味が消える。
    const distinct = new Set(STOP_STATES.map((state) => messages[state.messageKey]));
    if (distinct.size !== STOP_STATES.length) {
      problems.push('日次と月次が同じ文言になっている');
    }
    return problems;
  }

  it('4.4 の 2 つの状態が、応答の分類ごとの文言と一致する', () => {
    expect(collationViolations(env.TEST_PRODUCT_SPEC, GENERATE_MESSAGES)).toEqual([]);
  });

  it('応答が返しうる分類をすべて出し分けられる', () => {
    // **一覧の正本は `src/quota.ts`。** 分類を増やして文言を足し忘れると落ちる。
    expect(STOP_STATES.map((state) => state.messageKey)).toEqual(
      QUOTA_REJECTION_REASONS.map((reason) => `${QUOTA_EXCEEDED_STATUS}:${reason}`),
    );
    for (const reason of QUOTA_REJECTION_REASONS) {
      const key = selectGenerateMessageKey(QUOTA_EXCEEDED_STATUS, reason);
      expect(key, reason).toBe(`${QUOTA_EXCEEDED_STATUS}:${reason}`);
      expect(GENERATE_MESSAGES[key], reason).toBeDefined();
    }
  });

  it('応答が再開時刻を載せなくても、画面は再開時刻を示す（PR #135 のレビュー指摘）', () => {
    // 段が契約を満たさない `resetsAt` を返したとき、応答はそれを**載せない**
    // （`src/quota.ts` の `isResetTimestamp`）。**画面の照合はそれで壊れない。**
    // 枠が戻るのは常に JST の 0 時で、画面が出す時刻は応答の値によらないためである
    // （スクリプトが応答から読むのは `error` の 1 つだけ。8.3）。
    const body = describeQuotaRejection(DAILY_QUOTA_REASON, 0);
    expect(body).toEqual({ error: DAILY_QUOTA_REASON });

    const key = selectGenerateMessageKey(QUOTA_EXCEEDED_STATUS, body.error);
    expect(key).toBe(DAILY_QUOTA_MESSAGE_KEY);
    expect(GENERATE_MESSAGES[key]).toContain(resumeClock);
    // 4.4 との照合そのものも、応答の値に依存していない。
    expect(collationViolations(env.TEST_PRODUCT_SPEC, GENERATE_MESSAGES)).toEqual([]);
  });

  it('仕様書側を変異させると照合が破れる', () => {
    // **この検査が効いていることを確かめる。** 抽出が何も拾わない状態でも
    // `toContain('')` で通ってしまう書き方を避けるため、両方の行を変異させる。
    const daily = env.TEST_PRODUCT_SPEC.replace(
      '「本日の枠は終了しました」',
      '「本日ぶんの生成は締め切りました」',
    );
    expect(daily).not.toBe(env.TEST_PRODUCT_SPEC);
    expect(collationViolations(daily, GENERATE_MESSAGES)).toContain(
      `4.4 の言い回しを含まない: ${DAILY_QUOTA_MESSAGE_KEY}`,
    );

    const monthly = env.TEST_PRODUCT_SPEC.replace(
      '「今月の生成は終了しました。プレイと共有は引き続きご利用いただけます」',
      '「今月の生成枠は使い切りました」',
    );
    expect(monthly).not.toBe(env.TEST_PRODUCT_SPEC);
    expect(collationViolations(monthly, GENERATE_MESSAGES)).toContain(
      `4.4 の言い回しを含まない: ${MONTHLY_LIMIT_MESSAGE_KEY}`,
    );
  });

  it('4.4 が再開時刻を求めていることを、本文から読んでいる', () => {
    // **要求そのものを書き写していない。** 4.4 から「再開時刻」の要求が消えれば、
    // 画面が時刻を出しているかどうかは検査されなくなる（そして 4.4 の変更として
    // レビューに現れる）。逆に、要求が残ったまま文言から時刻を落とせば落ちる。
    const withoutResume = env.TEST_PRODUCT_SPEC.replace(
      '翌日の再開時刻を示す',
      '翌日また使えることを示す',
    );
    expect(withoutResume).not.toBe(env.TEST_PRODUCT_SPEC);
    expect(bulletWith(withoutResume, '枠が尽きたら')).not.toContain('再開時刻');

    const withoutClock = {
      ...GENERATE_MESSAGES,
      [DAILY_QUOTA_MESSAGE_KEY]: '生成枠を使い切りました。本日の枠は終了しました。',
    };
    expect(collationViolations(env.TEST_PRODUCT_SPEC, withoutClock)).toContain(
      `再開時刻を示していない: ${DAILY_QUOTA_MESSAGE_KEY}`,
    );
  });

  it('分類を 1 種類へ潰すと照合が破れる', () => {
    // **#132 の本体は「区別できること」である。** #128 の状態（429 の文言が 1 つ
    // しかなく、両方の言い回しを 1 つに束ねている）へ戻すと落ちる。
    const collapsed = {
      ...GENERATE_MESSAGES,
      [DAILY_QUOTA_MESSAGE_KEY]: GENERATE_MESSAGES[MONTHLY_LIMIT_MESSAGE_KEY]!,
    };
    const problems = collationViolations(env.TEST_PRODUCT_SPEC, collapsed);
    expect(problems).toContain('日次と月次が同じ文言になっている');
    expect(problems).toContain(`別の状態の言い回しを混ぜている: ${DAILY_QUOTA_MESSAGE_KEY}`);

    const merged = {
      ...GENERATE_MESSAGES,
      [UNCLASSIFIED_QUOTA_MESSAGE_KEY]:
        GENERATE_MESSAGES[DAILY_QUOTA_MESSAGE_KEY]! + GENERATE_MESSAGES[MONTHLY_LIMIT_MESSAGE_KEY]!,
    };
    expect(collationViolations(env.TEST_PRODUCT_SPEC, merged)).toContain(
      `分類を持たない 429 が ${DAILY_QUOTA_MESSAGE_KEY} の主張をしている`,
    );
  });
});

describe('8.3 の検査を通っていない文字列を表示面へ持ち込まない', () => {
  /**
   * DOM へ文字列を書き込みうる経路を数え上げる。
   *
   * @param script 埋め込みスクリプト
   * @returns 見つかった経路の名前
   */
  function sinksIn(script: string): string[] {
    const sinks = [
      'innerHTML',
      'outerHTML',
      'insertAdjacentHTML',
      'document.write',
      'createContextualFragment',
    ];
    return sinks.filter((sink) => script.includes(sink));
  }

  /**
   * `textContent` へ代入している式をすべて拾う。
   *
   * @param script 埋め込みスクリプト
   * @returns 代入されている式
   */
  function textAssignments(script: string): string[] {
    return [...script.matchAll(/textContent\s*=\s*([^;]+);/gu)].map((matched) =>
      matched[1]!.trim(),
    );
  }

  /**
   * 代入されてよい式か（数値から作った経過秒数だけを許す）。
   *
   * @param expression 代入されている式
   * @returns 許してよければ true
   */
  function isElapsedOnly(expression: string): boolean {
    return expression === "'0'" || /^String\(/u.test(expression);
  }

  it('スクリプトが HTML を書き込む経路を持たない', async () => {
    const user = await seedUser('sinks');
    const script = embeddedScript(await (await openPage(await sessionCookie(user))).text());
    expect(sinksIn(script)).toEqual([]);
  });

  it('スクリプトが文字を書くのは経過秒数だけである', async () => {
    const user = await seedUser('text');
    const script = embeddedScript(await (await openPage(await sessionCookie(user))).text());

    const assignments = textAssignments(script);
    // 器が空だと「代入が 1 つも無い」状態を合格にしてしまう。
    expect(assignments.length).toBeGreaterThan(0);
    for (const expression of assignments) {
      expect(isElapsedOnly(expression), expression).toBe(true);
    }
    // 応答本文の他の項目（生成物由来の import パスや理由）に触れていないこと。
    // **`.resetsAt` も読まない**（#132）。応答は日次の再開時刻を載せるが、枠が戻るのは
    // 常に JST の 0 時なので、画面の文言は固定文字列で足りる。読む項目を増やすと、
    // 「応答から読むのは分類名と id だけ」という性質が表示の都合で緩む。
    //
    // **`.gameId` はこの一覧から外した**（#150）。作品ページへ送るために読むが、
    // **表示面へは出さない**（上の 2 つの検査が、書ける経路が無いことを見ている）。
    // **`.url` は読まない。** 応答の文字列がそのまま遷移先になる形を作らないためで、
    // 遷移先は固定の接頭辞と、綴りを確かめた id の連結で組み立てる（下の検査）。
    for (const field of ['.imports', '.reason', '.step', '.message', '.url', '.resetsAt']) {
      expect(script, field).not.toContain(field);
    }
  });

  it('エディットページへの遷移は、綴りを確かめた id と固定の接頭辞・接尾辞だけで組み立てる（#150 / 8.3 / #664）', async () => {
    const user = await seedUser('navigate');
    const script = embeddedScript(await (await openPage(await sessionCookie(user))).text());

    // 遷移は 1 か所だけであること。増えると、どれが検査を通っているか読めなくなる。
    const navigations = [...script.matchAll(/location\.href\s*=\s*([^;]+);/gu)].map(
      (matched) => matched[1]!.trim(),
    );
    // **行き先はエディットページである**（#664。接尾辞も固定の文字列で、応答の値を混ぜない）。
    expect(navigations).toEqual([
      `${JSON.stringify(WORK_PAGE_PREFIX)} + outcome.id + ${JSON.stringify(WORK_EDIT_SUFFIX)}`,
    ]);

    // **綴りの検査を通ってからでなければ遷移しない。** 定数を写さずに、画面が
    // 実際に埋め込んだ式そのものを見る（shared-ai-rules 12 章）。
    expect(script).toContain(`${GAME_ID_EXPRESSION}.test(outcome.id)`);

    // 埋め込まれた正規表現が、作品ページ側の綴りと同じものであること。
    // **2 か所にある以上、一致を機械で見る。**
    // 埋め込みは正規表現リテラルの綴りなので、前後の `/` を落として組み立て直す。
    const pattern = new RegExp(GAME_ID_EXPRESSION.slice(1, -1), 'u');
    expect(pattern.test('9ffe7c2a-59a9-4a58-b82c-d4a8cea7c62f')).toBe(true);
    expect(pattern.test('javascript:alert(1)')).toBe(false);
    expect(pattern.test('../../etc')).toBe(false);
    expect(pattern.test('')).toBe(false);
  });

  it('変異させると上の 2 つの検査が破れる', async () => {
    // **この 2 つの検査が効いていることを確かめる。** 応答から来た文字列を画面へ
    // 書く実装を作り、検出できることを見る。検出できないなら、上の検査は
    // 「たまたま今の書き方が通っている」だけになる。
    const user = await seedUser('mutation');
    const script = embeddedScript(await (await openPage(await sessionCookie(user))).text());

    const leaksText = script.replace("elapsed.textContent = '0';", 'elapsed.textContent = code;');
    expect(leaksText).not.toBe(script);
    expect(textAssignments(leaksText).some((expression) => !isElapsedOnly(expression))).toBe(true);

    const leaksHtml = script.replace(
      "elapsed.textContent = '0';",
      'progress.innerHTML = outcome.code;',
    );
    expect(leaksHtml).not.toBe(script);
    expect(sinksIn(leaksHtml)).toContain('innerHTML');
  });

  it('分類名は鍵にしかならない（敵対的な値でも表の外へ出ない）', () => {
    // 応答の `error` は、経路層が固定文字列で入れている値だが、**画面はそれを
    // 前提にしない。** 生成物由来の文字列や HTML の断片が入っても、選ばれるのは
    // 必ず表の鍵である。
    const hostile = [
      '<img src=x onerror=alert(1)>',
      '__proto__',
      'constructor',
      './main.go:12:2: undefined: foo',
      'github.com/example/not-allowed',
      '"><script>alert(1)</script>',
    ];
    for (const value of hostile) {
      const key = selectGenerateMessageKey(422, value);
      expect(Object.keys(GENERATE_MESSAGES), value).toContain(key);
      const message = GENERATE_MESSAGES[key]!;
      expect(message, value).not.toContain(value);
    }
  });

  it('鍵の候補の順序が、埋め込みスクリプトと一致する', async () => {
    // 同じ順序が TypeScript と埋め込みスクリプトの 2 か所にある。式は文字列の連結
    // だけなので、置換で「その式が作る値」を機械的に再現して突き合わせる。
    const user = await seedUser('candidates');
    const script = embeddedScript(await (await openPage(await sessionCookie(user))).text());
    expect(script).toContain(CANDIDATE_KEYS_EXPRESSION);

    /**
     * 候補キーの式を、与えられた値で評価する（連結だけなので置換で足りる）。
     *
     * @param expression 候補キーの式
     * @returns 式が作る鍵の配列
     */
    function evaluate(expression: string): string[] {
      return expression
        .replace(/[[\]\s]/gu, '')
        .split(',')
        .map((piece) =>
          piece
            .replaceAll("'", '')
            .replaceAll('status', '422')
            .replaceAll('code', 'build-failed')
            .replaceAll('+', ''),
        );
    }

    expect(evaluate(CANDIDATE_KEYS_EXPRESSION)).toEqual([
      ...generateMessageKeyCandidates(422, 'build-failed'),
    ]);

    // **変異検査。** 順序を入れ替えた式では一致しないこと（一致してしまうなら、
    // 上の照合は順序を見ていない）。
    const doctored = "[status + ':', status + ':' + code, '']";
    expect(evaluate(doctored)).not.toEqual([...generateMessageKeyCandidates(422, 'build-failed')]);
  });
});

describe('残枠と停止状態の常時表示（acceptance 1 / 4.4 / #24）', () => {
  /**
   * 仕様書 4.4 の中で、ある目印を含む行が鉤括弧で囲んでいる文言を取り出す。
   *
   * **下の「4.4 の記述と、429 の出し分けの機械照合」と同じことをしている。**
   * あちらは停止時の 2 つの文言を、こちらは常時表示の 1 つを見る。
   *
   * @param marker 行を特定する目印
   * @returns 鉤括弧の中身（見つからなければ空文字）
   */
  function quotedIn44(marker: string): string {
    const spec = env.TEST_PRODUCT_SPEC;
    const start = spec.indexOf('### 4.4 生成枠の UX 上の扱い');
    const line = spec
      .slice(start, spec.indexOf('### 4.5', start))
      .split('\n')
      .find((candidate) => candidate.includes(marker));
    return line?.match(/「([^」]+)」/u)?.[1] ?? '';
  }

  /**
   * 画面を「状態として意味のある形」へ落とす。
   *
   * **HTML の全文をスナップショットに取らない。** 文言を 1 語見直すたびに全状態の
   * 差分が出て、**意味のある変化（フォームが出た・ボタンが残った）がその中に埋もれる。**
   * 取るのは 4.4 と #24 の goal が決めている 5 点だけにする。
   *
   * **プレイ導線は「本文に出ているか」を見る**（`<a href="/"` という素の綴りを探す）。
   * #331 でヘッダにサイト内のナビが入り、**どの画面からでもトップと一覧へ行ける**ように
   * なったが、それは外枠であって 4.4 が求めているものではない。4.4 が求めているのは
   * **生成が止まったときに、プレイと共有への導線を本文で押せるリンクとして出すこと**で、
   * ここはそれだけを見る（ヘッダのロゴは `class` 付きなのでこの綴りに当たらない。**#372 で
   * パンくずの「トップ」が同じ綴りになったので、外枠を取り除いてから探す**）。
   * **外枠まで数えると、止まっていない状態でも真になり、この行は何も見分けなくなる。**
   *
   * @param page 画面の HTML
   * @returns スナップショットに取る形
   */
  function summarize(page: string): string {
    // 残枠の段落はクラスを持つ（入力欄の名前の行の右 / 止まっているときはブロック。#473）。id で拾う。
    const notice = page.match(/<p[^>]* id="generate-quota">([^<]*)<\/p>/u)?.[1] ?? '(出ていない)';
    return [
      `常時表示: ${notice}`,
      `入力フォーム: ${page.includes('id="generate-form"')}`,
      `送信ボタン: ${page.includes('id="generate-submit"')}`,
      `埋め込みスクリプト: ${page.includes('<script>')}`,
      `プレイ導線（本文。4.4）: ${pageBodyOf(page).includes(`<a href="${HOME_PATH}"`)}`,
    ].join('\n');
  }

  /** 4.4 と 3.8 が分けている状態の全体。**画面はこのどれかで描かれる。** */
  const STATES: readonly {
    readonly label: string;
    readonly signedIn: boolean;
    readonly availability: GenerateAvailability;
  }[] = [
    {
      // **表題も定数から作る。** 直値だと、枠を変えた日に「残り 12 回」と書いた見出しの
      // 下へ「残り 10 回」の本文が並ぶ（#284）。スナップショット側は直値のままでよい
      // ——あれは差分を人が読むためのもので、値の錨も兼ねている。
      label: `生成できる（残り ${DAILY_QUOTA_PER_USER} 回）`,
      signedIn: true,
      availability: { kind: 'available', remaining: DAILY_QUOTA_PER_USER },
    },
    { label: '日次の枠が尽きた', signedIn: true, availability: { kind: DAILY_QUOTA_REASON } },
    { label: '月次上限に達した', signedIn: true, availability: { kind: MONTHLY_LIMIT_REASON } },
    { label: '残枠を読めなかった', signedIn: true, availability: { kind: 'unknown' } },
    { label: '未ログイン', signedIn: false, availability: { kind: 'unknown' } },
  ];

  it('各状態の見え方（acceptance 1 のスナップショット）', () => {
    const rendered = STATES.map(
      (state) =>
        `## ${state.label}\n${summarize(
          renderGeneratePage(state.signedIn, { availability: state.availability, headerAvatar: null, chat: null, target: NEW_CHAT_TARGET }),
        )}`,
    ).join('\n\n');
    expect(rendered).toMatchInlineSnapshot(`
      "## 生成できる（残り 10 回）
      常時表示: 本日の残り生成枠 10回
      入力フォーム: true
      送信ボタン: true
      埋め込みスクリプト: true
      プレイ導線（本文。4.4）: false

      ## 日次の枠が尽きた
      常時表示: 生成枠を使い切りました。本日の枠は終了しました。枠は翌日 0 時（日本時間）に戻ります。
      入力フォーム: false
      送信ボタン: false
      埋め込みスクリプト: false
      プレイ導線（本文。4.4）: true

      ## 月次上限に達した
      常時表示: サービス全体の月次上限に達しました。今月の生成は終了しました。プレイと共有は引き続きご利用いただけます。
      入力フォーム: false
      送信ボタン: false
      埋め込みスクリプト: false
      プレイ導線（本文。4.4）: true

      ## 残枠を読めなかった
      常時表示: 本日の残り生成枠を確認できませんでした。生成そのものは試せますが、枠が残っていない場合は送信後に断られます。
      入力フォーム: true
      送信ボタン: true
      埋め込みスクリプト: true
      プレイ導線（本文。4.4）: false

      ## 未ログイン
      常時表示: (出ていない)
      入力フォーム: false
      送信ボタン: false
      埋め込みスクリプト: false
      プレイ導線（本文。4.4）: false"
    `);
  });

  it('4.4 の「本日の残り生成枠 N回」と一致する', () => {
    // **文言を書き写さない。** 4.4 の箇条書きから拾って、N を数に置き換えたものと
    // 突き合わせる（shared-ai-rules 12 章）。
    const wording = quotedIn44('常時表示する');
    expect(wording).not.toBe('');
    expect(remainingQuotaNotice(7)).toBe(wording.replace('N', '7'));

    // **変異検査。** 4.4 側を書き換えれば破れる（＝この照合は効いている）。
    expect(remainingQuotaNotice(7)).not.toBe(
      wording.replace('本日の残り生成枠', '今日つかえる生成').replace('N', '7'),
    );
  });

  it('残数は数からしか作らない', () => {
    // 値は `src/quota.ts` が数えた回数で、負にも小数にもならない。**それでも
    // 表示は最後の砦なので、壊れた形の文字列を利用者へ出さない。**
    expect(remainingQuotaNotice(0)).toContain('0回');
    expect(remainingQuotaNotice(-3)).toContain('0回');
    expect(remainingQuotaNotice(3.7)).toContain('3回');
  });

  it('停止時の文言は 429 の文言表と同じものを使う', () => {
    // **同じ状態に 2 つの文言を作らない。** 4.4 との一致はあちらが機械照合の対象で、
    // 常時表示のために別の文字列を書くと、片方だけが古くなる。
    expect(availabilityNotice({ kind: DAILY_QUOTA_REASON })).toBe(
      GENERATE_MESSAGES[DAILY_QUOTA_MESSAGE_KEY],
    );
    expect(availabilityNotice({ kind: MONTHLY_LIMIT_REASON })).toBe(
      GENERATE_MESSAGES[MONTHLY_LIMIT_MESSAGE_KEY],
    );
    expect(availabilityNotice({ kind: 'unknown' })).toBe(QUOTA_UNKNOWN_NOTICE);
    // 3.8 の degrade（#140）。**残枠の文言と混ぜない。**
    expect(availabilityNotice({ kind: 'build-stopped' })).toBe(BUILD_STOPPED_NOTICE);
  });

  it('止まっている状態でだけフォームを落とす', () => {
    // **`unknown` では描く。** 枠が尽きたことを確かめられたわけではないので、
    // 押す機会まで奪うと、D1 の一時的な不調が「生成できない」に化ける。
    expect(canSubmit({ kind: 'available', remaining: 1 })).toBe(true);
    expect(canSubmit({ kind: 'unknown' })).toBe(true);
    expect(canSubmit({ kind: DAILY_QUOTA_REASON })).toBe(false);
    expect(canSubmit({ kind: MONTHLY_LIMIT_REASON })).toBe(false);
    // **`build-stopped` でも描かない**（3.8 / #140）。押すと生成は走ってビルドで
    // 落ちる——約 16〜19 円と日次枠 1 回が、成果物なしで消える。
    expect(canSubmit({ kind: 'build-stopped' })).toBe(false);
  });
});

describe('枠の状態が画面へ出る（4.4 / #24 / 経路まで通す）', () => {
  /** 基準時刻。2020-05-15 12:00 JST（= 03:00 UTC）。**JST の日境界から遠い時刻**を選ぶ。 */
  const AT_MS = Date.UTC(2020, 4, 15, 3);

  // **時計を止める**（`test/quota.test.ts` と同じ形）。この describe は台帳へ行を置いて
  // から画面を開き、画面側は判定時刻を既定値（現在時刻）で取る。行を「現在時刻」で
  // 置くと、**挿入と判定の間に JST の日または月の境界を跨いだ瞬間に、置いた行が集計の
  // 外へ出る**（枠の集計は `jstDayRange` で JST の 0 時に切られる。確定25）。1 日の
  // うち数分だけ落ちるテストは、落ちたときに自分の変更を疑わせる。**跨いでも当たる
  // ように行を増やすのではなく、時刻そのものを固定して跨ぐ経路を消す。**
  //
  // セッション cookie の失効時刻も同じ時計から作られる（`sessionCookie`）。署名の
  // 検証も止めた時計を見るため、固定しても期限切れにはならない。
  //
  // `toFake` を `Date` だけに絞るのは、`setTimeout` まで差し替えると D1 の I/O が
  // 進まなくなるためである。
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(AT_MS);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('残り枠が本日の消費ぶんだけ減る', async () => {
    const user = await seedUser('quota-remaining');
    expect(await (await openPage(await sessionCookie(user))).text()).toContain(
      remainingQuotaNotice(DAILY_QUOTA_PER_USER),
    );

    // **数える単位は「費用の出る LLM 呼び出し回数」である**（確定25）。台帳の行数が
    // そのまま消費である。
    await seedLedgerRow(user);
    await seedLedgerRow(user);
    expect(await (await openPage(await sessionCookie(user))).text()).toContain(
      remainingQuotaNotice(DAILY_QUOTA_PER_USER - 2),
    );
  });

  it('日次の枠が尽きたら、押しても動かないボタンを出さない（goal）', async () => {
    const user = await seedUser('quota-daily-out');
    for (let index = 0; index < DAILY_QUOTA_PER_USER; index += 1) {
      await seedLedgerRow(user);
    }

    const body = await (await openPage(await sessionCookie(user))).text();
    // 4.4 の「本日の枠は終了しました」と翌日の再開時刻。
    expect(body).toContain(GENERATE_MESSAGES[DAILY_QUOTA_MESSAGE_KEY]);
    // **押せば必ず 429 になるボタンを描かない。**
    expect(body).not.toContain('id="generate-form"');
    expect(body).not.toContain('id="generate-submit"');
    // 動かす対象が無いので、スクリプトも置かない（`getElementById` が null を返す）。
    expect(body).not.toContain('<script>');
  });

  it('月次上限に達してもプレイ導線は操作できる（acceptance 2 / 4.4 / 3.8）', async () => {
    // **月次はサービス全体の累計である**（4.3）。止めた利用者と、画面を開く利用者は
    // 別で構わない。
    const spender = await seedUser('quota-monthly-spender');
    await seedLedgerRow(spender, MONTHLY_COST_LIMIT_JPY);
    const user = await seedUser('quota-monthly-viewer');

    const body = await (await openPage(await sessionCookie(user))).text();
    expect(body).toContain(GENERATE_MESSAGES[MONTHLY_LIMIT_MESSAGE_KEY]);
    expect(body).not.toContain('id="generate-form"');
    // **プレイと共有は続く。** 押せるリンクとして出ていること（言うだけにしない）。
    expect(body).toContain(`<a href="${HOME_PATH}"`);
    expect(body).not.toContain('<a href="#"');
    // 日次の枠がまだ残っていても、月次で止まっているあいだは残数を出さない
    // （「あなたの本日の枠は残っています」は、この状態では誤りである）。
    expect(body).not.toContain(remainingQuotaNotice(DAILY_QUOTA_PER_USER));
  });

  it('残枠を読めなくても画面は出る（D1 の不調で導線ごと落とさない）', async () => {
    const user = await seedUser('quota-unreadable');
    // 枠の集計だけを失敗させる。セッションの解決（`select banned_at`）は通す。
    const broken = {
      ...testEnv(),
      DB: {
        prepare(query: string) {
          if (query.includes('sum(cost_jpy)')) {
            throw new Error('D1 is down');
          }
          return env.DB.prepare(query);
        },
      } as unknown as D1Database,
    };

    const response = await handleAppRequest(
      new Request(`${APP_ORIGIN}${GENERATE_PAGE_PATH}`, {
        headers: { cookie: await sessionCookie(user) },
      }),
      broken,
    );
    expect(response.status).toBe(200);

    const body = await response.text();
    expect(body).toContain(QUOTA_UNKNOWN_NOTICE);
    // **「残り 0 回」とは言わない。** 集計が読めなかっただけで、枠は尽きていない。
    expect(body).not.toContain(remainingQuotaNotice(0));
    // 押す機会まで奪わない（押せば API 側が同じ判定をやり直す）。
    expect(body).toContain('id="generate-form"');
  });

  it('未ログインの画面では枠を読まない（3.6）', async () => {
    // **D1 は読み取りも従量である。** 残枠を出す相手が居ない画面で引かない。
    const queries: string[] = [];
    const counting = {
      ...testEnv(),
      DB: {
        prepare(query: string) {
          queries.push(query);
          return env.DB.prepare(query);
        },
      } as unknown as D1Database,
    };

    await handleAppRequest(new Request(`${APP_ORIGIN}${GENERATE_PAGE_PATH}`), counting);
    expect(queries).toEqual([]);
  });
});

describe('生成停止中（3.8 の degrade）', () => {
  /**
   * 仕様書 3.8 の節を切り出す。
   *
   * @returns 3.8 の節
   */
  function section38(): string {
    const spec = env.TEST_PRODUCT_SPEC;
    const start = spec.indexOf('### 3.8 ビルド実行環境');
    const end = spec.indexOf('## 4. コスト構造', start);
    return spec.slice(start, end);
  }

  /**
   * 3.8 の中で、ある目印を含む行が鉤括弧で囲んでいる文言を取り出す。
   *
   * @param marker 行を特定する目印
   * @returns 鉤括弧の中身（見つからなければ空文字）
   */
  function quotedIn38(marker: string): string {
    const line = section38()
      .split('\n')
      .find((candidate) => candidate.includes(marker));
    return line?.match(/「([^」]+)」/u)?.[1] ?? '';
  }

  it('3.8 の言い回しをそのまま使う', () => {
    // **文言を書き写さない**（shared-ai-rules 12 章）。
    const wording = quotedIn38('degrade 設計');
    expect(wording).not.toBe('');
    expect(BUILD_STOPPED_NOTICE).toContain(wording);
  });

  it('発火条件が「ビルド依頼の失敗」であることを本文から読む（確定24）', () => {
    // v1.8 までは「VPS の死活監視」だった。**主語が変わっている。** 画面から観測
    // できるのは自分が投げた要求の結果だけなので、5xx を発火条件に使っている。
    const line = section38()
      .split('\n')
      .find((candidate) => candidate.includes('発火条件'));
    expect(line).toContain('ビルド依頼の失敗');
    expect(line).not.toBe(undefined);
  });

  it('停止を観測したらボタンを戻さない（押しても動かないボタンを無くす）', async () => {
    const user = await seedUser('degraded');
    const body = await (await openPage(await sessionCookie(user))).text();

    // 文言はサーバが描いて隠しておく（8.3）。
    expect(body).toContain('id="generate-degraded"');
    expect(body).toContain(BUILD_STOPPED_NOTICE);

    const script = embeddedScript(body);
    expect(script).toContain('status >= 500');
    expect(script).toContain('degraded.hidden = false');
    // **`button.disabled = false` を固定で書かない。** 停止を観測したあとも押せる
    // ボタンが残ると、3.8 の degrade が画面上で無効になる。
    expect(script).toContain('button.disabled = stopped');
    expect(script).not.toContain('button.disabled = false;\n    progress');
  });

  it('プレイ側に影響が無いことは 500 の文言が言う（3.8）', () => {
    // 2 つが同時に出るので、同じことを 2 度言わない。
    expect(GENERATE_MESSAGES['500:']).toContain('プレイと共有');
    expect(BUILD_STOPPED_NOTICE).not.toContain('プレイと共有');
  });
});

describe('サーバ側の信号で「生成停止中」を出す（#140 acceptance）', () => {
  /**
   * ビルド依頼が失敗した状態を、**コールバック経路を実際に通して**作る。
   *
   * **`build_health` へ直接 insert しない。** それだと「失敗がこの表へ届くか」が
   * 検査から抜け、表の中身を自分で置いて自分で読むだけになる（docs/handoff.md 4 章）。
   *
   * @param suffix テスト内で一意な接尾辞
   * @param buildPathFailed ビルド依頼そのものが失敗したか（false は D1 の不調に相当）
   */
  async function failGeneration(suffix: string, buildPathFailed: boolean): Promise<void> {
    const author = await seedUser(`signal-${suffix}`);
    const pending = await createPendingGame(env, author, { prompt: `${suffix} のゲーム` });
    // `finish` は `running` の行にしか効かない（`src/generate-callback.ts`）。
    const claimed = await dispatch(
      generateCallbackRoutes,
      new Request(`${APP_ORIGIN}${GENERATE_CALLBACK_PATH}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ gameId: pending.id, jobToken: pending.jobToken, kind: 'claim' }),
      }),
      env,
    );
    expect(await claimed.json()).toEqual({ claimed: true });

    const finished = await dispatch(
      generateCallbackRoutes,
      new Request(`${APP_ORIGIN}${GENERATE_CALLBACK_PATH}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          gameId: pending.id,
          jobToken: pending.jobToken,
          kind: 'finish',
          // **分類名はどちらでも `internal` である**（`src/games.ts` の語彙に区別が
          // 無い）。区別しているのは `buildPathFailed` だけで、そこが #140 の
          // acceptance 2 が要求する分かれ目である。
          errorCode: 'internal',
          buildPathFailed,
        }),
      }),
      env,
    );
    expect(await finished.json()).toEqual({ accepted: true, finished: true });
  }

  it('ビルド依頼が失敗した状態を作ると「生成停止中」が出る（acceptance 1）', async () => {
    const viewer = await seedUser('degrade-viewer');

    // 1 件では出ない。**確定24 の停止事象は 1 つの要求からは読み取れない。**
    await failGeneration('a', true);
    const single = await (await openPage(await sessionCookie(viewer))).text();
    expect(single).toContain('id="generate-form"');

    // **別の依頼**で 2 件目。ここで停止とみなす。
    await failGeneration('b', true);
    const body = await (await openPage(await sessionCookie(viewer))).text();

    // 常時表示の位置（4.4）に 3.8 の文言が出る。**隠してある `generate-degraded` の
    // ほうと取り違えない**ので、`id` ごと照合する。
    expect(body).toContain(`id="generate-quota">${BUILD_STOPPED_NOTICE}`);
    // **押すと約 16〜19 円と日次枠 1 回が成果物なしで消えるボタンを描かない。**
    expect(body).not.toContain('id="generate-form"');
    expect(body).not.toContain('id="generate-submit"');
    // **プレイと共有は続く**（3.8 の degrade 設計の核）。押せるリンクとして出す。
    expect(body).toContain(`<a href="${HOME_PATH}"`);
  });

  it('D1 の不調では出ない（acceptance 2）', async () => {
    const viewer = await seedUser('degrade-not-viewer');

    // **同じ回数・同じ分類名（`internal`）で失敗している。** 違うのは
    // 「ビルド依頼そのものが失敗したか」だけである。
    await failGeneration('c', false);
    await failGeneration('d', false);

    const body = await (await openPage(await sessionCookie(viewer))).text();
    expect(body).not.toContain(`id="generate-quota">${BUILD_STOPPED_NOTICE}`);
    // 4.4 の常時表示は残枠のままで、フォームも描く。
    expect(body).toContain(remainingQuotaNotice(DAILY_QUOTA_PER_USER));
    expect(body).toContain('id="generate-form"');
  });

  it('信号を読めなくても停止と言わない（D1 障害の増幅器にしない）', async () => {
    const viewer = await seedUser('degrade-unreadable');
    const broken = {
      ...testEnv(),
      DB: {
        prepare(query: string) {
          if (query.includes('build_health')) {
            throw new Error('D1 is down');
          }
          return env.DB.prepare(query);
        },
      } as unknown as D1Database,
    };

    const response = await handleAppRequest(
      new Request(`${APP_ORIGIN}${GENERATE_PAGE_PATH}`, {
        headers: { cookie: await sessionCookie(viewer) },
      }),
      broken as unknown as Env,
    );
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).not.toContain(`id="generate-quota">${BUILD_STOPPED_NOTICE}`);
    expect(body).toContain('id="generate-form"');
    // **枠の集計は読めている。** 残枠の常時表示（4.4）まで巻き込んで
    // {@link QUOTA_UNKNOWN_NOTICE} へ倒れていたら、信号が読めないことが画面の
    // 他の部分を道連れにしている（`buildPathStopped` が投げている）。
    expect(body).toContain(remainingQuotaNotice(DAILY_QUOTA_PER_USER));
    expect(body).not.toContain(QUOTA_UNKNOWN_NOTICE);
  });

  it('枠が尽きているときは信号を引かない（3.6 / 読み取りも従量）', async () => {
    const user = await seedUser('degrade-no-read');
    for (let index = 0; index < DAILY_QUOTA_PER_USER; index += 1) {
      await seedLedgerRow(user);
    }

    const queries: string[] = [];
    const counting = {
      ...testEnv(),
      DB: {
        prepare(query: string) {
          queries.push(query);
          return env.DB.prepare(query);
        },
      } as unknown as D1Database,
    };

    await handleAppRequest(
      new Request(`${APP_ORIGIN}${GENERATE_PAGE_PATH}`, {
        headers: { cookie: await sessionCookie(user) },
      }),
      counting as unknown as Env,
    );
    // 押せない理由は枠であり、**そちらのほうが具体的**である（再開時刻が言える）。
    expect(queries.some((query) => query.includes('build_health'))).toBe(false);
  });
});

describe('経路の登録', () => {
  it('本番の設定でも生成画面が登録され、経路が重複しない', () => {
    const productionEnv = { ...env, DEV_ROUTES: 'disabled' } as unknown as Env;
    const registered = createAppRoutes(productionEnv).map(
      (route) => `${route.method} ${route.path}`,
    );
    expect(registered).toContain(`GET ${GENERATE_PAGE_PATH}`);
    // API の経路は画面と別のパスに置く（`src/invite-issuance.ts` と同じ理由）。
    expect(registered).toContain(`POST ${GENERATE_PATH}`);
    expect(findDuplicateRoutes(createAppRoutes(productionEnv))).toEqual([]);
    expect(findDuplicateRoutes(createAppRoutes(env))).toEqual([]);
  });
});

describe('公開トップの書き換え（#128）', () => {
  it('「生成機能はまだ公開していません」が消え、生成画面への導線がある', async () => {
    const body = await (await handleAppRequest(new Request(`${APP_ORIGIN}${HOME_PATH}`), env)).text();
    expect(body).not.toContain('生成機能はまだ公開していません');
    // 生成画面への導線はヘッダの「つくる」が持つ（#471 でトップの本文の「はじめる」を外した）。
    expect(body).toContain(`href="${GENERATE_PAGE_PATH}"`);
    // **待ち時間の説明を 2 つ持たない。** 正本は生成画面の `TYPICAL_WAIT_TEXT` である。公開トップは #128 以来
    // それを書き写していた（`src/home.ts` は循環参照になるため import できない）が、**#471 でトップから外し、
    // FAQ の「生成した作品はどうなりますか？」へ移した**——FAQ は定数を import して差し込むので、写しは残っていない
    // （`test/faq.test.ts` が差し込みを見る）。トップに写しが戻ったら赤くする。
    expect(body).not.toContain(TYPICAL_WAIT_TEXT);
    // ビルド単体の実測（3.8）を、生成の待ち時間として出したままにしない。
    expect(body).not.toContain('20〜30 秒');
  });
});

describe('見た目の規約の部品（#473 / 仕様 2.5.4 / 2.5.5）', () => {
  /**
   * 画面全体の主のボタンの数（外枠のヘッダは主を持たない。`test/html.test.ts`）。
   *
   * @param page 画面の HTML
   * @returns 主のボタンの数
   */
  function primaryButtonsOf(page: string): number {
    return (page.match(/\bgf-button-primary\b/gu) ?? []).length;
  }

  const ALL_STATES: readonly { readonly label: string; readonly signedIn: boolean; readonly availability: GenerateAvailability }[] = [
    { label: '生成できる', signedIn: true, availability: { kind: 'available', remaining: DAILY_QUOTA_PER_USER } },
    { label: '日次の枠が尽きた', signedIn: true, availability: { kind: DAILY_QUOTA_REASON } },
    { label: '月次上限', signedIn: true, availability: { kind: MONTHLY_LIMIT_REASON } },
    { label: '生成停止中', signedIn: true, availability: { kind: 'build-stopped' } },
    { label: '残枠を読めなかった', signedIn: true, availability: { kind: 'unknown' } },
    { label: '未ログイン', signedIn: false, availability: { kind: 'unknown' } },
  ];

  it('どの状態でも主のボタンは 1 つ以下で、送れる状態と未ログインではちょうど 1 つ', () => {
    for (const state of ALL_STATES) {
      const page = renderGeneratePage(state.signedIn, { availability: state.availability, headerAvatar: null, chat: null, target: NEW_CHAT_TARGET });
      const expected = !state.signedIn || canSubmit(state.availability) ? 1 : 0;
      expect(primaryButtonsOf(page), state.label).toBe(expected);
    }
  });

  it('入力欄の名前・残枠・ヒント・入力欄・「生成する」が 1 つのブロックに、この順で並ぶ', () => {
    const page = pageBodyOf(
      renderGeneratePage(true, { availability: { kind: 'available', remaining: 3 }, headerAvatar: null, chat: null, target: NEW_CHAT_TARGET }),
    );
    const form = /<form id="generate-form" class="gf-block[^"]*"[\s\S]*?<\/form>/u.exec(page)?.[0] ?? '';
    expect(form, 'フォームがブロックでない').not.toBe('');
    const order = [
      '<label for="generate-prompt">',
      `id="generate-quota">${remainingQuotaNotice(3)}</p>`,
      'id="generate-title-hint"',
      '<textarea id="generate-prompt"',
      '<button id="generate-submit" class="gf-button gf-button-primary" type="submit" disabled>生成する</button>',
    ].map((part) => form.indexOf(part));
    expect(order.every((position) => position >= 0), order.join(',')).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    // 名前と残枠は同じ見出しの行にある（狭い段では残枠が下へ折り返す。並べ替えはしない）。
    expect(form).toMatch(/<div class="gf-heading-row gf-generate-head">\s*<label[^>]*>[^<]*<\/label>\s*<p class="gf-generate-quota" id="generate-quota">/u);
    // 残枠はブロックの外に 2 つ目を出さない（常時表示は 1 つ）。
    expect(page.match(/id="generate-quota"/gu) ?? []).toHaveLength(1);
  });

  it('生成が止まっている状態の知らせ（常時表示の文言）はブロックで、フォームは無い', () => {
    for (const availability of [
      { kind: DAILY_QUOTA_REASON },
      { kind: MONTHLY_LIMIT_REASON },
      { kind: 'build-stopped' },
    ] as const satisfies readonly GenerateAvailability[]) {
      const page = pageBodyOf(renderGeneratePage(true, { availability, headerAvatar: null, chat: null, target: NEW_CHAT_TARGET }));
      expect(page, availability.kind).toContain(`<p class="gf-block" id="generate-quota">${availabilityNotice(availability)}</p>`);
      expect(page, availability.kind).not.toContain('id="generate-form"');
    }
  });

  it('送信の後に出す「生成停止中」の知らせもブロックである（スクリプトは hidden を外すだけ）', () => {
    const page = renderGeneratePage(true, { availability: { kind: 'available', remaining: 1 }, headerAvatar: null, chat: null, target: NEW_CHAT_TARGET });
    expect(page).toContain('<p id="generate-degraded" class="gf-block" role="status" aria-live="polite" hidden>');
  });
});
