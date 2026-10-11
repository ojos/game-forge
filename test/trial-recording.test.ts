import { env } from 'cloudflare:test';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ADMIN_TRIALS_PATH } from '../src/admin-paths.js';
import { handleAdminRequest } from '../src/admin/routes.js';
import { dispatch } from '../src/routes.js';
import { buildSessionCookie, signSession } from '../src/session.js';
import { createTrialRoutes, renderTrialBody } from '../src/trial.js';
import {
  ADMIN_TRIAL_RECORDINGS_DELETE_PATH,
  ADMIN_TRIAL_RECORDING_PATH,
  TRIAL_CONSENT_AGREE,
  TRIAL_CONSENT_FIELD,
  TRIAL_FROM_FIELD,
  TRIAL_PATH,
  TRIAL_RECORDING_CHUNK_API_PATH,
  TRIAL_RECORDING_DELETE_CONFIRM_FIELD,
  TRIAL_RECORDING_DELETE_CONFIRM_VALUE,
  TRIAL_RECORDING_ID_PARAM,
  TRIAL_RECORDING_PART_PARAM,
  TRIAL_RECORDING_SEQ_PARAM,
  TRIAL_RECORDING_START_API_PATH,
  TRIAL_RECORDING_STOP_API_PATH,
  TRIAL_RECORDING_USER_FIELD,
  TRIAL_STEP_API_PATH,
} from '../src/trial-paths.js';
import { trialRecorderConfig } from '../src/trial-recorder-script.js';
import {
  TRIAL_RECORDING_ACCEPT_SECONDS,
  TRIAL_RECORDING_LIFECYCLE_LAG_DAYS,
  TRIAL_RECORDING_MAX_BYTES,
  TRIAL_RECORDING_MAX_CHUNKS,
  TRIAL_RECORDING_MAX_CHUNK_BYTES,
  TRIAL_RECORDING_MAX_PARTICIPANT_BYTES,
  TRIAL_RECORDING_MAX_PER_PARTICIPANT,
  TRIAL_RECORDING_PART_CHUNKS,
  detectTrialBrowser,
  parseChunkSeq,
  parseRecordingMimeType,
  pickRecordingMimeType,
  recordingMimeCandidates,
  trialRecordingChunkKey,
  trialRecordingPartCount,
} from '../src/trial-recording-store.js';
import { TRIAL_RETENTION_DAYS, sweepExpiredTrialRecords } from '../src/trial-store.js';
import { applySchema } from './helpers/schema.js';

/**
 * 試用の録画（#978）の検査。
 *
 * scope.in のテスト: 印や同意の無い送信を拒否する / 上限を超えた送信を拒否する / 連番の重複と抜けの扱い /
 * 形式の判定。あわせて、管理画面から断片をつないで落とせること・90 日の後片付け・宣言（terraform）の日数が
 * 同意の文面の日数と同じであることを見る。
 */

const APP_ORIGIN = `https://${env.APP_HOST}`;
const ADMIN_ORIGIN = `https://${env.ADMIN_HOST}`;
const SECRET = 'test-secret-value-for-trial-recording-0001';

/** PC の Chrome の User-Agent。 */
const CHROME_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36';

/** 試験の基準時刻（UNIX 秒）。 */
const NOW = 1_800_000_000;

/** 時計（テストが進める）。 */
let clock = NOW;

/**
 * セッションの秘密だけを差し替えた env。
 *
 * @returns env
 */
function testEnv(): Env {
  return { ...env, SESSION_SECRET: SECRET };
}

/**
 * 利用者を 1 人入れる。
 *
 * @param label 名前の目印
 * @returns 利用者の id
 */
async function insertUser(label: string): Promise<string> {
  const id = `rec-${label}-${crypto.randomUUID()}`;
  await env.DB.prepare(
    'insert into users (id, google_sub, email, display_name, created_at) values (?, ?, ?, ?, ?)',
  )
    .bind(id, `sub-${id}`, `${id}@example.test`, label, NOW)
    .run();
  return id;
}

/**
 * 署名付きセッション cookie の `name=value` を作る。
 *
 * @param userId 利用者の id
 * @returns cookie
 */
async function cookieFor(userId: string): Promise<string> {
  const issuedAt = Math.floor(Date.now() / 1000);
  const token = await signSession({ userId, issuedAt, expiresAt: issuedAt + 3600 }, SECRET);
  return buildSessionCookie(token, 3600).split(';')[0]!;
}

/**
 * 試用の経路に要求を投げる。
 *
 * @param path パス（問い合わせを含む）
 * @param init cookie・本文
 * @returns レスポンス
 */
async function call(
  path: string,
  init: { cookie?: string; json?: unknown; bytes?: Uint8Array; form?: Record<string, string>; ua?: string } = {},
): Promise<Response> {
  const headers: Record<string, string> = { 'user-agent': init.ua ?? CHROME_UA };
  if (init.cookie !== undefined) headers.cookie = init.cookie;
  let body: BodyInit | undefined;
  let method = 'GET';
  if (init.json !== undefined) {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(init.json);
    method = 'POST';
  } else if (init.bytes !== undefined) {
    headers['content-type'] = 'video/webm';
    body = init.bytes;
    method = 'POST';
  } else if (init.form !== undefined) {
    headers['content-type'] = 'application/x-www-form-urlencoded';
    body = new URLSearchParams(init.form).toString();
    method = 'POST';
  }
  return await dispatch(
    createTrialRoutes({ now: () => clock }),
    new Request(`${APP_ORIGIN}${path}`, { method, headers, body }),
    testEnv(),
  );
}

/** 試用者（印を付け、同意して録画の準備の段にいる）。 */
interface Participant {
  readonly userId: string;
  readonly cookie: string;
}

/**
 * 印を付け、同意させる。
 *
 * @param label 名前の目印
 * @param consented 同意させるか
 * @returns 試用者
 */
async function participant(label: string, consented = true): Promise<Participant> {
  const userId = await insertUser(label);
  await env.DB.prepare('insert into trial_participants (user_id, marked_at) values (?, ?)').bind(userId, NOW).run();
  const cookie = await cookieFor(userId);
  if (consented) {
    await call(TRIAL_STEP_API_PATH, {
      cookie,
      form: { [TRIAL_FROM_FIELD]: 'consent', [TRIAL_CONSENT_FIELD]: TRIAL_CONSENT_AGREE },
    });
  }
  return { userId, cookie };
}

/**
 * 段を直に置く（段の口を何度も押す代わり）。
 *
 * @param userId 利用者の id
 * @param stage 段
 */
async function setStage(userId: string, stage: string): Promise<void> {
  await env.DB.prepare('update trial_participants set stage = ? where user_id = ?').bind(stage, userId).run();
}

/**
 * 録画を始める。
 *
 * @param who 試用者
 * @param mimeType 形式
 * @returns 応答と本文
 */
async function start(
  who: Participant,
  mimeType = 'video/webm;codecs=vp9,opus',
): Promise<{ response: Response; data: { ok: boolean; recordingId?: string; error?: string } }> {
  const response = await call(TRIAL_RECORDING_START_API_PATH, {
    cookie: who.cookie,
    json: { mimeType, displaySurface: 'browser' },
  });
  return { response, data: (await response.json()) as { ok: boolean; recordingId?: string; error?: string } };
}

/**
 * 断片を送る。
 *
 * @param who 試用者
 * @param recordingId 録画の id
 * @param seq 連番
 * @param bytes 中身
 * @returns 応答と本文
 */
async function send(
  who: Participant,
  recordingId: string,
  seq: number | string,
  bytes: Uint8Array,
): Promise<{ status: number; data: { ok: boolean; error?: string; nextSeq?: number; duplicate?: boolean } }> {
  const response = await call(
    `${TRIAL_RECORDING_CHUNK_API_PATH}?${TRIAL_RECORDING_ID_PARAM}=${recordingId}&${TRIAL_RECORDING_SEQ_PARAM}=${seq}`,
    { cookie: who.cookie, bytes },
  );
  return {
    status: response.status,
    data: (await response.json()) as { ok: boolean; error?: string; nextSeq?: number; duplicate?: boolean },
  };
}

/**
 * 断片の中身を作る（文字列のバイト列）。
 *
 * @param text 中身
 * @returns バイト列
 */
function bytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

/**
 * 目録の行を引く。
 *
 * @param recordingId 録画の id
 * @returns 行
 */
async function recordingRow(recordingId: string): Promise<Record<string, unknown> | null> {
  return await env.DB.prepare('select * from trial_recordings where id = ?').bind(recordingId).first();
}

/**
 * R2 の断片の中身を読む。
 *
 * @param userId 利用者の id
 * @param recordingId 録画の id
 * @param seq 連番
 * @returns 中身（無ければ null）
 */
async function chunkText(userId: string, recordingId: string, seq: number): Promise<string | null> {
  const object = await env.TRIAL_RECORDINGS.get(trialRecordingChunkKey(userId, recordingId, seq));
  return object === null ? null : await object.text();
}

beforeAll(async () => {
  await applySchema();
});

beforeEach(() => {
  clock = NOW;
});

describe('形式とブラウザの判定', () => {
  it('4 つのブラウザだけを判定し、ほかは null', () => {
    expect(detectTrialBrowser(CHROME_UA)).toBe('chrome');
    expect(
      detectTrialBrowser(
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36 Edg/129.0.0.0',
      ),
    ).toBe('edge');
    expect(
      detectTrialBrowser(
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15',
      ),
    ).toBe('safari');
    expect(detectTrialBrowser('Mozilla/5.0 (Macintosh; Intel Mac OS X 14.6; rv:131.0) Gecko/20100101 Firefox/131.0')).toBe(
      'firefox',
    );
    expect(
      detectTrialBrowser(
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36 OPR/114.0.0.0',
      ),
    ).toBeNull();
    expect(detectTrialBrowser('curl/8.0')).toBeNull();
    expect(detectTrialBrowser(null)).toBeNull();
  });

  it('Safari は MP4 を先に、ほかは WebM を先に選ぶ', () => {
    expect(recordingMimeCandidates('safari')[0]).toMatch(/^video\/mp4/u);
    for (const browser of ['chrome', 'edge', 'firefox'] as const) {
      expect(recordingMimeCandidates(browser)[0]).toMatch(/^video\/webm/u);
    }
    const supported = new Set(['video/webm', 'video/mp4']);
    expect(pickRecordingMimeType(recordingMimeCandidates('firefox'), (type) => supported.has(type))).toBe('video/webm');
    expect(pickRecordingMimeType(recordingMimeCandidates('safari'), (type) => supported.has(type))).toBe('video/mp4');
    expect(pickRecordingMimeType(recordingMimeCandidates('chrome'), () => false)).toBeNull();
    // ブラウザへ渡す設定も同じ候補を持つ。
    expect(trialRecorderConfig('safari').candidates).toEqual(recordingMimeCandidates('safari'));
    expect(trialRecorderConfig('chrome').displaySurface).toBe('browser');
    expect(trialRecorderConfig('firefox').displaySurface).toBe('window');
  });

  it('WebM と MP4 だけを受け付け、入れ物を決める', () => {
    expect(parseRecordingMimeType('video/webm;codecs=vp9,opus')).toEqual({
      mimeType: 'video/webm;codecs=vp9,opus',
      container: 'webm',
    });
    expect(parseRecordingMimeType(' Video/MP4; codecs="avc1.42E01E, mp4a.40.2" ')?.container).toBe('mp4');
    for (const bad of ['audio/webm', 'video/x-matroska', 'text/html', '', 'video/webm<script>', 'x'.repeat(200), 42, null]) {
      expect(parseRecordingMimeType(bad), String(bad)).toBeNull();
    }
  });

  it('連番は先頭に 0 の無い整数で、上限の手前まで。鍵は 6 桁に揃える', () => {
    expect(parseChunkSeq('0')).toBe(0);
    expect(parseChunkSeq(String(TRIAL_RECORDING_MAX_CHUNKS - 1))).toBe(TRIAL_RECORDING_MAX_CHUNKS - 1);
    for (const bad of [null, '', '-1', '01', '1.5', 'a', String(TRIAL_RECORDING_MAX_CHUNKS)]) {
      expect(parseChunkSeq(bad), String(bad)).toBeNull();
    }
    expect(trialRecordingChunkKey('u1', 'r1', 7)).toBe('trial/u1/r1/000007');
    expect(trialRecordingPartCount(0)).toBe(0);
    expect(trialRecordingPartCount(TRIAL_RECORDING_PART_CHUNKS)).toBe(1);
    expect(trialRecordingPartCount(TRIAL_RECORDING_PART_CHUNKS + 1)).toBe(2);
  });
});

describe('印や同意の無い送信を断る', () => {
  it('未ログインは 401、印の無い利用者は 404、同意していなければ 409。どれも書かない', async () => {
    const unmarked = await insertUser('unmarked');
    const unmarkedCookie = await cookieFor(unmarked);
    const notConsented = await participant('not-consented', false);
    const someId = crypto.randomUUID();
    for (const [cookie, status] of [
      [undefined, 401],
      [unmarkedCookie, 404],
      [notConsented.cookie, 409],
    ] as const) {
      const started = await call(TRIAL_RECORDING_START_API_PATH, { cookie, json: { mimeType: 'video/webm' } });
      expect(started.status).toBe(status);
      const chunk = await call(
        `${TRIAL_RECORDING_CHUNK_API_PATH}?${TRIAL_RECORDING_ID_PARAM}=${someId}&${TRIAL_RECORDING_SEQ_PARAM}=0`,
        { cookie, bytes: bytes('x') },
      );
      expect(chunk.status).toBe(status);
      const stopped = await call(TRIAL_RECORDING_STOP_API_PATH, {
        cookie,
        json: { recordingId: someId, reason: 'finished' },
      });
      expect(stopped.status).toBe(status);
    }
    const count = await env.DB.prepare('select count(*) as n from trial_recordings where user_id in (?, ?)')
      .bind(unmarked, notConsented.userId)
      .first<{ n: number }>();
    expect(count?.n).toBe(0);
  });

  it('同意した利用者でも、他人の録画の id には書けない', async () => {
    const owner = await participant('owner');
    const other = await participant('other');
    const { data } = await start(owner);
    const result = await send(other, data.recordingId!, 0, bytes('intruder'));
    expect(result.status).toBe(404);
    expect(await chunkText(other.userId, data.recordingId!, 0)).toBeNull();
    expect(await chunkText(owner.userId, data.recordingId!, 0)).toBeNull();
  });

  it('始められるのは録画の準備〜振り返り 5、断片はアンケートの段まで。終わった後は断る', async () => {
    const who = await participant('stages');
    await setStage(who.userId, 'survey');
    expect((await start(who)).response.status).toBe(409);
    await setStage(who.userId, 'q3');
    const { response, data } = await start(who);
    expect(response.status).toBe(201);
    await setStage(who.userId, 'survey');
    expect((await send(who, data.recordingId!, 0, bytes('last'))).status).toBe(200);
    await setStage(who.userId, 'done');
    const late = await send(who, data.recordingId!, 1, bytes('late'));
    expect(late.status).toBe(409);
    expect(late.data.error).toBe('stage');
    expect(await chunkText(who.userId, data.recordingId!, 1)).toBeNull();
  });
});

describe('録画を始める', () => {
  it('始めた時刻（サーバーの時計）・形式・ブラウザ・面を残し、id を返す', async () => {
    const who = await participant('start');
    clock = NOW + 42;
    const { response, data } = await start(who, 'video/webm;codecs=vp8,opus');
    expect(response.status).toBe(201);
    expect(data.recordingId).toMatch(/^[0-9a-f-]{36}$/u);
    expect(await recordingRow(data.recordingId!)).toMatchObject({
      user_id: who.userId,
      started_at: NOW + 42,
      mime_type: 'video/webm;codecs=vp8,opus',
      container: 'webm',
      browser: 'chrome',
      display_surface: 'browser',
      next_seq: 0,
      total_bytes: 0,
      ended_at: null,
    });
  });

  it('録れない形式は 400 で、行を作らない', async () => {
    const who = await participant('bad-format');
    const { response, data } = await start(who, 'audio/ogg');
    expect(response.status).toBe(400);
    expect(data.error).toBe('unsupported-format');
    const count = await env.DB.prepare('select count(*) as n from trial_recordings where user_id = ?')
      .bind(who.userId)
      .first<{ n: number }>();
    expect(count?.n).toBe(0);
  });

  it(`1 人 ${TRIAL_RECORDING_MAX_PER_PARTICIPANT} 本まで`, async () => {
    const who = await participant('many');
    for (let index = 0; index < TRIAL_RECORDING_MAX_PER_PARTICIPANT; index += 1) {
      expect((await start(who)).response.status).toBe(201);
    }
    const { response, data } = await start(who);
    expect(response.status).toBe(409);
    expect(data.error).toBe('too-many-recordings');
  });
});

describe('連番の重複と抜け', () => {
  it('順に受け取り、重複は上書きせずに受け取ったことにし、抜けは次に要る番号を返して断る', async () => {
    const who = await participant('seq');
    const { data } = await start(who);
    const id = data.recordingId!;

    expect(await send(who, id, 0, bytes('first'))).toEqual({ status: 200, data: { ok: true, nextSeq: 1 } });
    // 同じ番号をもう一度（送り直し）。**上書きしない。**
    const again = await send(who, id, 0, bytes('different'));
    expect(again).toEqual({ status: 200, data: { ok: true, duplicate: true, nextSeq: 1 } });
    expect(await chunkText(who.userId, id, 0)).toBe('first');

    // 1 を飛ばして 2。
    const gap = await send(who, id, 2, bytes('third'));
    expect(gap.status).toBe(409);
    expect(gap.data).toMatchObject({ ok: false, error: 'gap', nextSeq: 1 });
    expect(await chunkText(who.userId, id, 2)).toBeNull();

    expect((await send(who, id, 1, bytes('second'))).data.nextSeq).toBe(2);
    expect((await send(who, id, 2, bytes('third'))).data.nextSeq).toBe(3);
    expect(await recordingRow(id)).toMatchObject({ next_seq: 3, total_bytes: 5 + 6 + 5, last_chunk_at: NOW });
  });

  it('R2 に同じ番号の断片が先に在れば、後から届いた中身で置き換えず、在るほうで目録を進める', async () => {
    const who = await participant('race');
    const { data } = await start(who);
    const id = data.recordingId!;
    // 前の試みが R2 に書けて目録で落ちた・同じ番号が同時に届いた、のどちらかで先に在る断片。
    await env.TRIAL_RECORDINGS.put(trialRecordingChunkKey(who.userId, id, 0), 'winner');
    const result = await send(who, id, 0, bytes('loser!!!'));
    expect(result).toEqual({ status: 200, data: { ok: true, nextSeq: 1 } });
    expect(await chunkText(who.userId, id, 0)).toBe('winner');
    expect(await recordingRow(id)).toMatchObject({ next_seq: 1, total_bytes: 'winner'.length });
  });

  it('形の読めない番号・id は 400、空の断片は 400', async () => {
    const who = await participant('bad-seq');
    const { data } = await start(who);
    expect((await send(who, data.recordingId!, '01', bytes('x'))).status).toBe(400);
    expect((await send(who, data.recordingId!, 'x', bytes('x'))).status).toBe(400);
    expect((await send(who, 'not-an-id', 0, bytes('x'))).status).toBe(400);
    expect((await send(who, data.recordingId!, 0, new Uint8Array(0))).status).toBe(400);
  });
});

describe('上限を超えた送信を断る', () => {
  it(`断片 1 つは ${TRIAL_RECORDING_MAX_CHUNK_BYTES} バイトまで`, async () => {
    const who = await participant('chunk-size');
    const { data } = await start(who);
    const exact = await send(who, data.recordingId!, 0, new Uint8Array(TRIAL_RECORDING_MAX_CHUNK_BYTES));
    expect(exact.status).toBe(200);
    const over = await send(who, data.recordingId!, 1, new Uint8Array(TRIAL_RECORDING_MAX_CHUNK_BYTES + 1));
    expect(over.status).toBe(413);
    expect(over.data.error).toBe('chunk-too-large');
    expect(await recordingRow(data.recordingId!)).toMatchObject({ next_seq: 1 });
  });

  it('1 本の合計と、1 人の合計に上限がある', async () => {
    const who = await participant('total');
    const first = (await start(who)).data.recordingId!;
    await env.DB.prepare('update trial_recordings set total_bytes = ? where id = ?')
      .bind(TRIAL_RECORDING_MAX_BYTES - 3, first)
      .run();
    expect((await send(who, first, 0, bytes('abc'))).status).toBe(200);
    const overRecording = await send(who, first, 1, bytes('d'));
    expect(overRecording.status).toBe(413);
    expect(overRecording.data.error).toBe('recording-too-large');

    // 2 本目は 1 本の上限に届かないが、1 人の合計が上限に届いている。
    const second = (await start(who)).data.recordingId!;
    await env.DB.prepare('update trial_recordings set total_bytes = ? where id = ?')
      .bind(TRIAL_RECORDING_MAX_PARTICIPANT_BYTES - TRIAL_RECORDING_MAX_BYTES, second)
      .run();
    const overParticipant = await send(who, second, 0, bytes('e'));
    expect(overParticipant.status).toBe(413);
    expect(overParticipant.data.error).toBe('recording-too-large');
    expect(await chunkText(who.userId, second, 0)).toBeNull();
  });

  it('始めてから 60 分と送り直しの猶予を過ぎた断片・番号の上限を超えた断片は断る', async () => {
    const who = await participant('too-long');
    const { data } = await start(who);
    clock = NOW + TRIAL_RECORDING_ACCEPT_SECONDS;
    expect((await send(who, data.recordingId!, 0, bytes('ok'))).status).toBe(200);
    clock = NOW + TRIAL_RECORDING_ACCEPT_SECONDS + 1;
    const late = await send(who, data.recordingId!, 1, bytes('late'));
    expect(late.status).toBe(409);
    expect(late.data.error).toBe('too-long');
    const beyond = await send(who, data.recordingId!, TRIAL_RECORDING_MAX_CHUNKS, bytes('x'));
    expect(beyond.status).toBe(409);
    expect(beyond.data.error).toBe('too-long');
  });
});

describe('止まったことを残す', () => {
  it('最初の知らせだけを残し、知らない理由は 400', async () => {
    const who = await participant('stop');
    const { data } = await start(who);
    const id = data.recordingId!;
    clock = NOW + 30;
    const bad = await call(TRIAL_RECORDING_STOP_API_PATH, { cookie: who.cookie, json: { recordingId: id, reason: 'x' } });
    expect(bad.status).toBe(400);
    const ok = await call(TRIAL_RECORDING_STOP_API_PATH, {
      cookie: who.cookie,
      json: { recordingId: id, reason: 'share-ended' },
    });
    expect(ok.status).toBe(200);
    clock = NOW + 60;
    await call(TRIAL_RECORDING_STOP_API_PATH, { cookie: who.cookie, json: { recordingId: id, reason: 'finished' } });
    expect(await recordingRow(id)).toMatchObject({ ended_at: NOW + 30, end_reason: 'share-ended' });
  });
});

describe('画面', () => {
  it('対応するブラウザなら録画の欄とスクリプトを出し、対応しなければ先へ進むボタンを出さない', async () => {
    const chrome = renderTrialBody('recording', 'chrome');
    expect(chrome).toContain('id="trial-stage" data-trial-stage="recording"');
    expect(chrome).toContain('id="trial-recorder"');
    expect(chrome).toContain('id="trial-record-start"');
    expect(chrome).toContain('「タブ」から「Game Forge」のタブを選んで');
    expect(chrome).toContain(`action="${TRIAL_STEP_API_PATH}"`);
    expect(renderTrialBody('recording', 'firefox')).toContain('このブラウザのウィンドウを選んで');

    const unsupported = renderTrialBody('recording', null);
    expect(unsupported).toContain('このブラウザでは録画できません');
    expect(unsupported).not.toContain('trial-record-start');
    expect(unsupported).not.toContain(TRIAL_STEP_API_PATH);
    expect(unsupported).not.toContain('<script');

    // 同意の段と終わりの段には、録画の欄もスクリプトも出さない。
    for (const stage of ['consent', 'done'] as const) {
      expect(renderTrialBody(stage, 'chrome')).not.toContain('<script');
    }
    // アンケートの段には、止めた案内と、待たずに送るボタンを出す。
    const survey = renderTrialBody('survey', 'safari');
    expect(survey).toContain('録画を止めました');
    expect(survey).toContain('id="trial-survey-skip"');
  });

  it('スクリプトの設定は </script> で閉じられない', () => {
    const body = renderTrialBody('explore', 'edge');
    const config = /window\.__trialRecorderConfig = (.*?);<\/script>/su.exec(body);
    expect(config).not.toBeNull();
    expect(config![1]).not.toContain('<');
  });

  it('アプリの経路から、PC の Chrome で録画の準備の段を開ける', async () => {
    const who = await participant('page');
    const response = await call(TRIAL_PATH, { cookie: who.cookie });
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('id="trial-record-start"');
  });
});

describe('管理画面から録画を落とす', () => {
  /**
   * admin ホストへ GET する。
   *
   * @param path パス
   * @param cookie cookie
   * @returns レスポンス
   */
  async function admin(path: string, cookie?: string): Promise<Response> {
    return await handleAdminRequest(
      new Request(`${ADMIN_ORIGIN}${path}`, { headers: cookie === undefined ? {} : { cookie } }),
      testEnv(),
    );
  }

  it('一覧に録画が並び、部分を順につなぐと送った断片を順に並べたものになる。admin 以外は 404', async () => {
    const operator = await insertUser('operator');
    await env.DB.prepare('update users set is_admin = 1 where id = ?').bind(operator).run();
    const operatorCookie = await cookieFor(operator);
    const who = await participant('download');
    const { data } = await start(who);
    const id = data.recordingId!;
    const count = TRIAL_RECORDING_PART_CHUNKS + 3;
    for (let seq = 0; seq < count; seq += 1) {
      expect((await send(who, id, seq, bytes(`[${seq}]`))).status).toBe(200);
    }

    const list = await admin(ADMIN_TRIALS_PATH, operatorCookie);
    const page = await list.text();
    expect(page).toContain(`data-trial-download="${id}"`);
    expect(page).toContain('data-parts="2"');

    let joined = '';
    for (const part of [0, 1]) {
      const response = await admin(
        `${ADMIN_TRIAL_RECORDING_PATH}?${TRIAL_RECORDING_ID_PARAM}=${id}&${TRIAL_RECORDING_PART_PARAM}=${part}`,
        operatorCookie,
      );
      expect(response.status).toBe(200);
      expect(response.headers.get('x-trial-recording-parts')).toBe('2');
      joined += await response.text();
    }
    expect(joined).toBe(Array.from({ length: count }, (_, seq) => `[${seq}]`).join(''));

    // 範囲の外の部分・知らない id・admin 以外は 404。
    expect(
      (await admin(`${ADMIN_TRIAL_RECORDING_PATH}?${TRIAL_RECORDING_ID_PARAM}=${id}&${TRIAL_RECORDING_PART_PARAM}=2`, operatorCookie))
        .status,
    ).toBe(404);
    expect(
      (
        await admin(
          `${ADMIN_TRIAL_RECORDING_PATH}?${TRIAL_RECORDING_ID_PARAM}=${crypto.randomUUID()}&${TRIAL_RECORDING_PART_PARAM}=0`,
          operatorCookie,
        )
      ).status,
    ).toBe(404);
    for (const cookie of [undefined, who.cookie]) {
      const response = await admin(
        `${ADMIN_TRIAL_RECORDING_PATH}?${TRIAL_RECORDING_ID_PARAM}=${id}&${TRIAL_RECORDING_PART_PARAM}=0`,
        cookie,
      );
      expect(response.status).toBe(404);
    }
  });

  it('試用者に頼まれたら、確かめのチェックつきで、その人の録画を R2 と目録からすべて消せる', async () => {
    const operator = await insertUser('operator-delete');
    await env.DB.prepare('update users set is_admin = 1 where id = ?').bind(operator).run();
    const operatorCookie = await cookieFor(operator);
    const who = await participant('delete-me');
    const keep = await participant('keep-me');
    const ids: string[] = [];
    for (let index = 0; index < 2; index += 1) {
      const id = (await start(who)).data.recordingId!;
      ids.push(id);
      await send(who, id, 0, bytes('a'));
      await send(who, id, 1, bytes('b'));
    }
    // 目録で落ちた断片（next_seq の番号）も消える。
    await env.TRIAL_RECORDINGS.put(trialRecordingChunkKey(who.userId, ids[0]!, 2), 'orphan');
    const kept = (await start(keep)).data.recordingId!;
    await send(keep, kept, 0, bytes('k'));

    /**
     * 消す口へ POST する。
     *
     * @param fields フォームの項目
     * @param cookie cookie
     * @returns レスポンス
     */
    async function post(fields: Record<string, string>, cookie: string | undefined): Promise<Response> {
      const headers: Record<string, string> = { 'content-type': 'application/x-www-form-urlencoded' };
      if (cookie !== undefined) headers.cookie = cookie;
      return await handleAdminRequest(
        new Request(`${ADMIN_ORIGIN}${ADMIN_TRIAL_RECORDINGS_DELETE_PATH}`, {
          method: 'POST',
          headers,
          body: new URLSearchParams(fields).toString(),
        }),
        testEnv(),
      );
    }

    // admin 以外は 404、確かめのチェックが無ければ消さない。
    for (const cookie of [undefined, who.cookie]) {
      const refused = await post(
        { [TRIAL_RECORDING_USER_FIELD]: who.userId, [TRIAL_RECORDING_DELETE_CONFIRM_FIELD]: TRIAL_RECORDING_DELETE_CONFIRM_VALUE },
        cookie,
      );
      expect(refused.status).toBe(404);
    }
    const unconfirmed = await post({ [TRIAL_RECORDING_USER_FIELD]: who.userId }, operatorCookie);
    expect(unconfirmed.status).toBe(303);
    expect(unconfirmed.headers.get('location')).toContain('deleted=invalid');
    expect(await chunkText(who.userId, ids[0]!, 0)).toBe('a');

    const done = await post(
      { [TRIAL_RECORDING_USER_FIELD]: who.userId, [TRIAL_RECORDING_DELETE_CONFIRM_FIELD]: TRIAL_RECORDING_DELETE_CONFIRM_VALUE },
      operatorCookie,
    );
    expect(done.status).toBe(303);
    expect(done.headers.get('location')).toBe(`${ADMIN_TRIALS_PATH}?deleted=2`);
    for (const id of ids) {
      for (const seq of [0, 1, 2]) {
        expect(await chunkText(who.userId, id, seq), `${id} ${seq}`).toBeNull();
      }
      expect(await recordingRow(id)).toBeNull();
    }
    // ほかの試用者の録画は残る。
    expect(await chunkText(keep.userId, kept, 0)).toBe('k');
    expect(await recordingRow(kept)).not.toBeNull();
  });

  it('印を先に消した試用者の録画も、一覧に並べて消せるようにする', async () => {
    const operator = await insertUser('operator-orphan');
    await env.DB.prepare('update users set is_admin = 1 where id = ?').bind(operator).run();
    const who = await participant('orphan');
    const id = (await start(who)).data.recordingId!;
    await send(who, id, 0, bytes('x'));
    await env.DB.prepare('delete from trial_participants where user_id = ?').bind(who.userId).run();
    const page = await (await admin(ADMIN_TRIALS_PATH, await cookieFor(operator))).text();
    expect(page).toContain('印の無い試用者の録画');
    expect(page).toContain(`data-trial-download="${id}"`);
    expect(page).toContain(`name="${TRIAL_RECORDING_USER_FIELD}" value="${who.userId}"`);
  });

  it('断片が欠けていたら、つないだ流れを途中で壊す（黙って飛ばさない）', async () => {
    const operator = await insertUser('operator-missing');
    await env.DB.prepare('update users set is_admin = 1 where id = ?').bind(operator).run();
    const who = await participant('missing');
    const { data } = await start(who);
    const id = data.recordingId!;
    for (let seq = 0; seq < 3; seq += 1) {
      await send(who, id, seq, bytes(`[${seq}]`));
    }
    await env.TRIAL_RECORDINGS.delete(trialRecordingChunkKey(who.userId, id, 1));
    const response = await admin(
      `${ADMIN_TRIAL_RECORDING_PATH}?${TRIAL_RECORDING_ID_PARAM}=${id}&${TRIAL_RECORDING_PART_PARAM}=0`,
      await cookieFor(operator),
    );
    expect(response.status).toBe(200);
    await expect(response.text()).rejects.toThrow();
  });
});

describe('90 日', () => {
  it('録画の目録は、始めてから 90 日＋R2 の遅れの 1 日を過ぎたら、試用の記録の後片付けが消す', async () => {
    const who = await participant('sweep');
    clock = NOW;
    const old = (await start(who)).data.recordingId!;
    clock = NOW + 10 * 24 * 60 * 60;
    const recent = (await start(who)).data.recordingId!;
    const day = 24 * 60 * 60;
    // 90 日ちょうどでは、まだ消さない（断片が R2 に残りうる間は、目録から辿れるようにする）。
    await sweepExpiredTrialRecords(env.DB, NOW + TRIAL_RETENTION_DAYS * day + 1);
    expect(await recordingRow(old)).not.toBeNull();
    await sweepExpiredTrialRecords(env.DB, NOW + (TRIAL_RETENTION_DAYS + TRIAL_RECORDING_LIFECYCLE_LAG_DAYS) * day + 1);
    expect(await recordingRow(old)).toBeNull();
    expect(await recordingRow(recent)).not.toBeNull();
  });

  it('バケットのライフサイクルの日数（terraform）は、同意の文面と /privacy が読む日数から R2 の遅れを引いた日数', () => {
    const sources = (
      import.meta as unknown as {
        readonly glob: (
          pattern: string,
          options: { readonly query: '?raw'; readonly import: 'default'; readonly eager: true },
        ) => Record<string, string>;
      }
    ).glob('../terraform/trial-recordings.tf', { query: '?raw', import: 'default', eager: true });
    const declaration = sources['../terraform/trial-recordings.tf'];
    expect(declaration).toBeDefined();
    const days = /trial_recordings_retention_days\s*=\s*(\d+)/u.exec(declaration!);
    expect(Number(days?.[1]) + TRIAL_RECORDING_LIFECYCLE_LAG_DAYS).toBe(TRIAL_RETENTION_DAYS);
  });
});
