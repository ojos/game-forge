/**
 * エディットページのまとめて保存する口（`POST /api/works/save`。#664）。
 *
 * ## 何をするか
 *
 * **作品名・説明・タグ・公開設定を、右上の「保存」1 つでまとめて送る**（2026-09-18 の利用者の決定。YouTube Studio の
 * 「動画の詳細」と同じ形）。**確認は公開設定を変えたときだけ出す**——変えていなければ、そのまま保存して
 * エディットページへ戻す（POST-redirect-GET）。
 *
 * ## 規則をここに書かない
 *
 * **1 項目ずつの口（`/api/publish`・`/api/works/rename`・`/api/works/describe`・`/api/works/retag`・
 * `/api/works/unpublish`）が通る関数を、そのまま順に呼ぶ**（`publishGame` は `src/publish.ts` の `runPublish` 経由で、
 * 撮影と改造の通知の起こし方も同じになる）。作者の一致・状態・長さ・語・変更の間隔は、それぞれの関数の SQL と検査が
 * 1 か所で持つ。**まとめて送れるようにしたことで、どれか 1 つの検査が緩むことはない**——ここが持つのは「どれを、
 * どの順に呼ぶか」だけである。
 *
 * ## 呼ぶ順
 *
 * **説明とタグは下書きにも書く**（#673。`describeGame` / `retagGame` へ `allowDraft: true` を渡す）。Studio の
 * 「動画の詳細」と同じく、下書きのまま説明とタグを整えてから公開できるようにするためである。**1 件ずつの口
 * （`/api/works/describe`・`/api/works/retag`）は既定のまま公開済みにしか書かない**（#673 の scope.out）。
 * 変更の間隔と履歴（`description_set_at` / `tags_set_at` / `description_changes`）は同じ SQL を通るので、公開済みと
 * 同じ規則になる。下書きの説明とタグが作者以外に見えない理由は `src/games.ts` の `WorkDetailsEditOptions` にある。
 *
 * | いま → 保存後 | 順 |
 * |---|---|
 * | 下書き → 公開 | 作品名 → 説明 → 公開（タグを載せる） |
 * | 公開 → 下書き | 作品名 → 説明 → タグ → 公開をやめる |
 * | 公開 → 公開・下書き → 下書き | 作品名 → 説明 → タグ |
 *
 * **公開は最後に呼ぶ。** 説明が断られたら（8.3 の語・長すぎる・変更の間隔）、公開せずに止まる——読む人が現れる前に
 * 作者が書いたつもりの説明が欠けた作品を出さない。**タグは公開と同じ 1 本で書く**（`publishGame`。#376）ので、
 * 下書き → 公開では付け直しを呼ばない（公開の UPDATE がタグを置き換え、`tags_set_at` を消費しない）。
 *
 * **変えていない項目は呼ばない**（同じ値の入れ直しで変更の間隔を消費しない）。変えたかどうかは、それぞれの関数と
 * 同じ正規化（`normalizeTitle` / `validateDescription` / `validateWorkTags`）を通した値と、いまの行を比べて決める。
 *
 * ## 途中で断られたら
 *
 * **そこで止め、何を保存できて何を保存できなかったかを言う。** 1 本の D1 の batch に畳めないのは、各関数が自分の
 * 履歴の行と条件付きの UPDATE を 1 本の batch に持っており（`title_changes` / `description_changes`）、それを崩さない
 * ためである。「保存しました」と言い切らない（仕様 1.2.31「黙って失敗を作らない」）。
 *
 * ## 確認を省かない
 *
 * **公開設定を変える要求は、確認の画面を通った印（`confirm`）が無ければ 1 行も書かずに確認の画面を返す。**
 * 画面の JavaScript ではなくこの口が止めるので、フォームを書き換えても確認を飛ばせない。確認の画面は、公開する前に
 * 「ソースコードが読めるようになる・戻せないもの」（5.4 / #383 の決定 1）を、下書きに戻す前に「試遊 URL が変わる・
 * 紹介用の画像は撮り直す・フォークは残る」（5.4 の #636）を書く。
 *
 * ## CSRF について
 *
 * セッション cookie は `SameSite=Lax`（8.1 / `src/session.ts`）なので、他サイトからの POST には cookie が乗らない
 * （`src/publish.ts` と同じ理由でトークンを足していない）。
 */
import { LOGIN_PATH } from './auth/google.js';
import type { PublishOutcome } from './games.js';
import {
  DRAFT_STATUS,
  PUBLISHED_STATUS,
  REMOVED_STATUS,
  describeGame,
  normalizeTitle,
  renameGame,
  retagGame,
  unpublishGame,
  validateDescription,
  validateWorkTags,
  workTagsOf,
} from './games.js';
import { escapeHtml, siteHead } from './html.js';
import { siteFooter } from './legal.js';
import type { ForkNoticeOutcome } from './mail/fork-notice.js';
import { notifyForkPublished } from './mail/fork-notice.js';
import type { StartOgpCapture } from './ogp-client.js';
import { startOgpCaptureOnLambda } from './ogp-client.js';
import { PUBLISH_REFUSALS, runPublish } from './publish.js';
import type { Route } from './routes.js';
import { html, json, readLimitedText } from './routes.js';
import { resolveSessionUser } from './session-user.js';
import { workEditPath } from './work-edit-paths.js';
import {
  DESCRIBE_MAX_BODY_BYTES,
  DESCRIBE_OUTCOME_REFUSALS,
  GAME_ID_PATTERN,
  PUBLISH_SOURCE_NOTICE,
  RENAME_MAX_BODY_BYTES,
  RENAME_OUTCOME_REFUSALS,
  RETAG_OUTCOME_REFUSALS,
  REMOVE_BODY_REFUSALS,
  UNPUBLISH_OUTCOME_REFUSALS,
  seeOther,
} from './work-page.js';
import type { RemoveRejection } from './work-page.js';
import { WORK_TAG_FIELD } from './work-tags.js';

/**
 * まとめて保存する口（#664）。
 *
 * **`/api/works/` の下に置く**（取り下げ・改名・説明・付け直しと同じ規約）。`/works/` の前方一致に当たらない綴りで、
 * 経路表の完全一致に載る。
 */
export const WORK_SAVE_PATH = '/api/works/save';

/** 保存の対象を指す項目名（フォームの `name` と JSON の鍵の両方）。 */
export const WORK_SAVE_GAME_ID_FIELD = 'game_id';

/** 作品名の項目名。 */
export const WORK_SAVE_TITLE_FIELD = 'title';

/** 説明の項目名。 */
export const WORK_SAVE_DESCRIPTION_FIELD = 'description';

/**
 * 公開設定の項目名。値は {@link WORK_VISIBILITIES} のどちらか（`games.status` と同じ綴り）。
 *
 * **`removed` は選べない**（運営の措置と退会の専用状態である。5.4 の #636）。
 */
export const WORK_SAVE_VISIBILITY_FIELD = 'visibility';

/**
 * 確認の画面を通った印の項目名。値は {@link WORK_SAVE_CONFIRMED}。
 *
 * **確認の画面のフォームだけが載せる。** エディットページのフォームには無いので、公開設定を変えて「保存」を押すと
 * 必ず確認の画面が出る。
 */
export const WORK_SAVE_CONFIRM_FIELD = 'confirm';

/** 確認の画面を通った印の値。 */
export const WORK_SAVE_CONFIRMED = '1';

/** 選べる公開設定（`games.status` の綴り）。 */
export const WORK_VISIBILITIES = [DRAFT_STATUS, PUBLISHED_STATUS] as const;

/** 選べる公開設定の 1 つ。 */
export type WorkVisibility = (typeof WORK_VISIBILITIES)[number];

/**
 * 受け付ける本文の最大バイト数。
 *
 * **説明の口と改名の口の上限の和に 1 KiB を足す**（載るのは説明・作品名・id・タグ・公開設定・確認の印）。
 * どちらの上限も「上限を超えた入力に 413 ではなく、その口の断り（長すぎます・切り詰め）を返す」ための値なので、
 * 和を取れば同じ扱いが保てる。
 */
const MAX_BODY_BYTES = DESCRIBE_MAX_BODY_BYTES + RENAME_MAX_BODY_BYTES + 1024;

/**
 * 確認の画面の主のボタン（仕様 2.5.5）。**同じファイルに文字列の定数として持つ**（`test/button-parts.test.ts` が
 * 同じファイルの定数まで解いて部品のクラスを確かめる）。
 */
const PRIMARY_BUTTON = 'gf-button gf-button-primary';

/** 素の HTML フォームが送ってくる `Content-Type`。 */
const FORM_MEDIA_TYPE = 'application/x-www-form-urlencoded';

/** `fetch` から呼ぶときの `Content-Type`。 */
const JSON_MEDIA_TYPE = 'application/json';

/**
 * 本文から読んだ保存の要求。**null は「送られていない（変えない）」である。**
 *
 * フォームからは作品名・説明・タグ・公開設定が必ず来る（タグは何も選ばなければ空配列）。JSON では鍵を省けば
 * その項目を変えない。
 */
export interface WorkSaveInput {
  readonly gameId: string;
  readonly title: string | null;
  readonly description: string | null;
  readonly tags: readonly string[] | null;
  readonly visibility: WorkVisibility | null;
  /** 確認の画面を通ったか。 */
  readonly confirmed: boolean;
}

/** JSON で `null` を送った項目の置き換え先（どの型の検査にも通らない値）。 */
const INVALID_JSON_VALUE = Symbol('invalid');

/** 本文を読んだ結果。 */
type SaveTarget =
  | { readonly ok: true; readonly input: WorkSaveInput }
  | { readonly ok: false; readonly reason: RemoveRejection };

/**
 * 値が選べる公開設定か。
 *
 * @param value 送られた値
 * @returns 選べる公開設定なら true
 */
function isVisibility(value: unknown): value is WorkVisibility {
  return typeof value === 'string' && (WORK_VISIBILITIES as readonly string[]).includes(value);
}

/**
 * 保存の本文を読む。
 *
 * **1 項目ずつの口と同じ規律である**（媒体型を絞り、大きさを縛り、id の綴りを見る。`src/work-page.ts` の
 * `readGameTextTarget` / `readGameTagsTarget`）。**中身（長さ・語・語彙）はここで検査しない**——それぞれの関数が見る。
 *
 * @param request 受信したリクエスト
 * @returns 読めた要求、読めなければ理由
 */
async function readSaveTarget(request: Request): Promise<SaveTarget> {
  const mediaType = (request.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
  if (mediaType !== FORM_MEDIA_TYPE && mediaType !== JSON_MEDIA_TYPE) {
    return { ok: false, reason: 'unsupported-content-type' };
  }
  const read = await readLimitedText(request, MAX_BODY_BYTES);
  if (!read.ok) {
    return { ok: false, reason: read.reason };
  }

  let rawId: unknown;
  let rawTitle: unknown;
  let rawDescription: unknown;
  let rawTags: unknown;
  let rawVisibility: unknown;
  let rawConfirm: unknown;
  if (mediaType === FORM_MEDIA_TYPE) {
    const form = new URLSearchParams(read.text);
    rawId = form.get(WORK_SAVE_GAME_ID_FIELD) ?? undefined;
    rawTitle = form.get(WORK_SAVE_TITLE_FIELD);
    rawDescription = form.get(WORK_SAVE_DESCRIPTION_FIELD);
    // **フォームではタグは必ず送られたものとして読む**（チェックボックスを全部外すと項目ごと来ない＝タグを外す）。
    rawTags = form.getAll(WORK_TAG_FIELD);
    rawVisibility = form.get(WORK_SAVE_VISIBILITY_FIELD);
    rawConfirm = form.get(WORK_SAVE_CONFIRM_FIELD);
  } else {
    try {
      const parsed: unknown = JSON.parse(read.text);
      const record =
        typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
      rawId = record[WORK_SAVE_GAME_ID_FIELD];
      // **JSON では鍵を省いた項目を変えない**（`undefined` → null）。**`null` を送った項目は形の誤りとして断る**
      // （`src/publish.ts` の #419 の扱いと同じく、「無い」と「null」を畳まない。下の型の検査で落ちる値へ置き換える）。
      const pick = (key: string): unknown =>
        record[key] === undefined ? null : record[key] === null ? INVALID_JSON_VALUE : record[key];
      rawTitle = pick(WORK_SAVE_TITLE_FIELD);
      rawDescription = pick(WORK_SAVE_DESCRIPTION_FIELD);
      rawTags = pick(WORK_TAG_FIELD);
      rawVisibility = pick(WORK_SAVE_VISIBILITY_FIELD);
      rawConfirm = record[WORK_SAVE_CONFIRM_FIELD] === true ? WORK_SAVE_CONFIRMED : null;
    } catch {
      return { ok: false, reason: 'invalid-game-id' };
    }
  }

  if (typeof rawId !== 'string' || !GAME_ID_PATTERN.test(rawId)) {
    return { ok: false, reason: 'invalid-game-id' };
  }
  if (rawTitle !== null && typeof rawTitle !== 'string') {
    return { ok: false, reason: 'invalid-game-id' };
  }
  if (rawDescription !== null && typeof rawDescription !== 'string') {
    return { ok: false, reason: 'invalid-game-id' };
  }
  if (rawTags !== null && (!Array.isArray(rawTags) || !rawTags.every((value) => typeof value === 'string'))) {
    return { ok: false, reason: 'invalid-game-id' };
  }
  if (rawVisibility !== null && !isVisibility(rawVisibility)) {
    return { ok: false, reason: 'invalid-game-id' };
  }
  return {
    ok: true,
    input: {
      gameId: rawId,
      title: rawTitle,
      description: rawDescription,
      tags: rawTags as readonly string[] | null,
      visibility: rawVisibility,
      confirmed: rawConfirm === WORK_SAVE_CONFIRMED,
    },
  };
}

/** 保存の前に読む、いまの行（作者の一致と、変えたかどうかの比較に使う）。 */
interface CurrentWork {
  readonly author_id: string;
  readonly status: string;
  readonly generation_state: string;
  readonly title: string;
  readonly description: string | null;
  readonly tag1: string | null;
  readonly tag2: string | null;
  readonly tag3: string | null;
}

/** 保存できたものの名前（断りの画面で「ここまでは保存しました」と言うため）。 */
type SavedPart = '作品名' | '説明' | 'タグ' | '公開設定';

/** 断りの中身。 */
interface SaveRefusal {
  readonly status: number;
  readonly heading: string;
  readonly body: string;
  /** JSON で返す理由の綴り。 */
  readonly reason: string;
}

/** 保存の結果。 */
export type WorkSaveOutcome =
  /** すべて保存した（変えた項目が無ければ `saved` は空）。 */
  | { readonly kind: 'saved'; readonly saved: readonly SavedPart[] }
  /** 公開設定を変えるので、確認の画面を出す（**何も書いていない**）。 */
  | { readonly kind: 'confirm'; readonly to: WorkVisibility }
  /** 途中で断られた。`saved` はそれまでに保存できたもの。 */
  | { readonly kind: 'refused'; readonly refusal: SaveRefusal; readonly saved: readonly SavedPart[] };

/** 見つからないとき（**他人の作品と、存在しない作品を区別しない**）。 */
const NOT_FOUND: SaveRefusal = {
  status: 404,
  heading: '作品が見つかりません',
  body: 'URL が正しいかご確認ください。',
  reason: 'not-found',
};

/** 公開を停止した作品（`removed`。運営の措置・退会・作者の削除）。 */
const REMOVED: SaveRefusal = {
  status: 409,
  heading: '保存できません',
  body: 'この作品は公開を停止しています。公開を停止した作品は編集できません。',
  reason: 'removed',
};

/** まだできあがっていない作品（生成中・失敗）。 */
const NOT_READY: SaveRefusal = {
  status: 409,
  heading: 'まだ保存できません',
  body: 'この作品はまだできあがっていません。生成が終わってから保存してください。',
  reason: 'not-ready',
};

/**
 * タグの組が同じか（並びは問わない）。
 *
 * @param a 片方
 * @param b もう片方
 * @returns 同じ組なら true
 */
function sameTags(a: readonly string[], b: readonly string[]): boolean {
  const left = [...a].sort();
  const right = [...b].sort();
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

/** 撮影と改造の通知の段（`src/publish.ts` の `createPublishRoutes` と同じく、テストで差し替える）。 */
export interface WorkSaveDeps {
  readonly start: StartOgpCapture;
  readonly notify: (env: Env, gameId: string) => Promise<ForkNoticeOutcome>;
}

/**
 * まとめて保存する（#664）。**HTTP から切り離した本体**（テストが順と止まり方を直接見る）。
 *
 * @param env バインディングと環境変数
 * @param userId 保存しようとしている利用者
 * @param input 読んだ要求
 * @param deps 撮影と通知の段
 * @returns 保存の結果
 */
export async function saveWork(
  env: Env,
  userId: string,
  input: WorkSaveInput,
  deps: WorkSaveDeps,
): Promise<WorkSaveOutcome> {
  const row = await env.DB.prepare(
    `select author_id, status, generation_state, title, description, tag1, tag2, tag3
       from games where id = ?`,
  )
    .bind(input.gameId)
    .first<CurrentWork>();
  if (row === null || row.author_id !== userId) {
    return { kind: 'refused', refusal: NOT_FOUND, saved: [] };
  }
  // **公開を停止した作品・できあがっていない作品は、確認の画面より前に断る**（確認してから断ると、押した意味が無い）。
  // どちらも 1 項目ずつの口でも必ず断られる状態で（`renameGame` の `removed` / `not-ready` など）、ここで先に言うだけである。
  if (row.status === REMOVED_STATUS) {
    return { kind: 'refused', refusal: REMOVED, saved: [] };
  }
  if (row.generation_state !== 'ready') {
    return { kind: 'refused', refusal: NOT_READY, saved: [] };
  }

  const current: WorkVisibility = row.status === PUBLISHED_STATUS ? PUBLISHED_STATUS : DRAFT_STATUS;
  const target: WorkVisibility = input.visibility ?? current;
  if (target !== current && !input.confirmed) {
    return { kind: 'confirm', to: target };
  }

  const currentTags = workTagsOf(row);
  const titleChanged = input.title !== null && normalizeTitle(input.title) !== row.title;
  const descriptionChanged =
    input.description !== null &&
    (() => {
      const validated = validateDescription(input.description);
      return !validated.ok || validated.value !== (row.description ?? '');
    })();
  const tagsChanged =
    input.tags !== null &&
    (() => {
      const validated = validateWorkTags(input.tags);
      return !validated.ok || !sameTags(validated.tags, currentTags);
    })();

  const saved: SavedPart[] = [];
  const refused = (refusal: SaveRefusal): WorkSaveOutcome => ({ kind: 'refused', refusal, saved: [...saved] });

  const rename = async (): Promise<SaveRefusal | null> => {
    if (!titleChanged || input.title === null) {
      return null;
    }
    const outcome = await renameGame(env, input.gameId, userId, input.title);
    if (!outcome.ok) {
      return { ...RENAME_OUTCOME_REFUSALS[outcome.reason], reason: outcome.reason };
    }
    saved.push('作品名');
    return null;
  };
  const describe = async (): Promise<SaveRefusal | null> => {
    if (!descriptionChanged || input.description === null) {
      return null;
    }
    const outcome = await describeGame(env, input.gameId, userId, input.description, undefined, { allowDraft: true });
    if (!outcome.ok) {
      return { ...DESCRIBE_OUTCOME_REFUSALS[outcome.reason], reason: outcome.reason };
    }
    saved.push('説明');
    return null;
  };
  const retag = async (): Promise<SaveRefusal | null> => {
    if (!tagsChanged || input.tags === null) {
      return null;
    }
    const outcome = await retagGame(env, input.gameId, userId, input.tags, undefined, { allowDraft: true });
    if (!outcome.ok) {
      return { ...RETAG_OUTCOME_REFUSALS[outcome.reason], reason: outcome.reason };
    }
    saved.push('タグ');
    return null;
  };
  const publish = async (): Promise<SaveRefusal | null> => {
    // **タグは公開と同じ 1 本で書く**（#376。`publishGame` が語彙と個数を見る）。JSON で鍵を省いたときは、
    // いま付いているタグをそのまま載せる（公開の UPDATE はタグを置き換えるので、渡さないと黙って消える。#637）。
    const { outcome }: { outcome: PublishOutcome } = await runPublish(
      env,
      input.gameId,
      userId,
      input.tags ?? currentTags,
      deps.start,
      deps.notify,
    );
    if (!outcome.ok) {
      return { ...PUBLISH_REFUSALS[outcome.reason], reason: outcome.reason };
    }
    saved.push('公開設定');
    if (tagsChanged) {
      saved.push('タグ');
    }
    return null;
  };
  const unpublish = async (): Promise<SaveRefusal | null> => {
    const outcome = await unpublishGame(env, input.gameId, userId);
    if (!outcome.ok) {
      return { ...UNPUBLISH_OUTCOME_REFUSALS[outcome.reason], reason: outcome.reason };
    }
    saved.push('公開設定');
    return null;
  };

  // **順は冒頭の表のとおり。** 1 つでも断られたら、そこで止める。
  const steps: readonly (() => Promise<SaveRefusal | null>)[] =
    current === DRAFT_STATUS && target === PUBLISHED_STATUS
      ? [rename, describe, publish]
      : current === PUBLISHED_STATUS && target === DRAFT_STATUS
        ? [rename, describe, retag, unpublish]
        : [rename, describe, retag];
  for (const step of steps) {
    const refusal = await step();
    if (refusal !== null) {
      return refused(refusal);
    }
  }
  return { kind: 'saved', saved };
}

/**
 * 公開前の確認の本文（5.4 / #383 の決定 1 / #664）。**押す前に、読めるようになるものと戻せないものを書く。**
 *
 * テストが同じ綴りを見るために export している（書き写さない）。
 */
export const PUBLISH_CONFIRM_ITEMS: readonly string[] = [
  '作品ページが誰でも開けるようになり、作品名・説明・タグ・作者名が誰にでも見えるようになります。ログインしている参加者は、この作品をフォークできるようになります。',
  PUBLISH_SOURCE_NOTICE,
];

/**
 * 公開したあとに戻せないもの（#664）。**公開をやめて下書きに戻すことはできる**（5.4 の #636）が、戻らないものがある。
 */
export const PUBLISH_IRREVERSIBLE_ITEMS: readonly string[] = [
  '公開をやめて下書きに戻すことはできますが、公開しているあいだに読まれたソースコードや、そのあいだに作られたフォークは戻せません（フォークした作品は、公開をやめてもそのまま残ります）。',
  '最初に公開した日時は、公開をやめて出し直しても変わりません。',
];

/**
 * 下書きへ戻す前の確認の本文（5.4 の「公開をやめて下書きへ戻せる」 / #636 / #664）。**戻るものと戻らないものを書く。**
 *
 * **#637 の作品ページの「公開をやめる」の口と同じことを言う**（あの口の文言をここへ移した）。
 */
export const UNPUBLISH_CONFIRM_ITEMS: readonly string[] = [
  '共有した URL からは遊べなくなり、「あなたの作品」の一覧には下書きとして並びます。下書きに戻した作品は、作り直したり、公開し直したり、削除したりできます。',
  'この作品をフォークした作品は、そのまま公開されたままです（連鎖して消えることはありません）。',
  '試遊用の URL は新しいものに変わります（前の URL を知っている人は遊べなくなります）。',
  '紹介用の画像は、次に公開したときに撮り直します。',
];

/**
 * 確認の画面を組み立てる（#664）。
 *
 * **送られた値をそのまま hidden で持ち回し、確認の印を足して同じ口へ送り直す。** 確認のあいだに行を書かないので、
 * 「やめる」を押せば何も変わらない。**値は UGC を含む**ので、属性へ入れる前に `escapeHtml` を通す
 * （`"` と `'` まで置き換える）。**`<input type="hidden">` は改行を落とさない**（値の正規化が無い型である）。
 *
 * **POST の結果なのでヘッダのナビは出さない**（`src/html.ts` の `siteHeader` の「`viewer` を省いた画面」）。
 *
 * @param input 読んだ要求
 * @param to 変えようとしている公開設定
 * @returns HTML
 */
export function renderSaveConfirmation(input: WorkSaveInput, to: WorkVisibility): string {
  const hidden: string[] = [
    `<input type="hidden" name="${WORK_SAVE_GAME_ID_FIELD}" value="${input.gameId}">`,
    `<input type="hidden" name="${WORK_SAVE_VISIBILITY_FIELD}" value="${to}">`,
    `<input type="hidden" name="${WORK_SAVE_CONFIRM_FIELD}" value="${WORK_SAVE_CONFIRMED}">`,
  ];
  if (input.title !== null) {
    hidden.push(`<input type="hidden" name="${WORK_SAVE_TITLE_FIELD}" value="${escapeHtml(input.title)}">`);
  }
  if (input.description !== null) {
    hidden.push(
      `<input type="hidden" name="${WORK_SAVE_DESCRIPTION_FIELD}" value="${escapeHtml(input.description)}">`,
    );
  }
  for (const tag of input.tags ?? []) {
    hidden.push(`<input type="hidden" name="${WORK_TAG_FIELD}" value="${escapeHtml(tag)}">`);
  }

  const list = (items: readonly string[]): string =>
    `<ul>\n${items.map((item) => `  <li>${item}</li>`).join('\n')}\n</ul>`;
  const publishing = to === PUBLISHED_STATUS;
  const heading = publishing ? 'この作品を公開しますか' : '公開をやめて下書きに戻しますか';
  const body = publishing
    ? `<div>
<h2>公開すると</h2>
${list(PUBLISH_CONFIRM_ITEMS)}
</div>
<div>
<h2>あとから戻せないもの</h2>
${list(PUBLISH_IRREVERSIBLE_ITEMS)}
</div>`
    : `<div>
<h2>下書きに戻すと</h2>
${list(UNPUBLISH_CONFIRM_ITEMS)}
</div>`;
  const submit = publishing ? '公開する' : '公開をやめて下書きに戻す';
  const back = publishing ? '公開せずに編集へ戻る' : '公開したまま編集へ戻る';
  return `${siteHead({ title: `${heading} - Game Forge`, noindex: true })}
<h1>${heading}</h1>
<section class="gf-block gf-block-rows gf-save-confirm" aria-label="確認">
${body}
<div>
<p>作品名・説明・タグを変えていれば、あわせて保存します。</p>
<form method="post" action="${WORK_SAVE_PATH}">
  ${hidden.join('\n  ')}
  <button type="submit" class="${PRIMARY_BUTTON}">${submit}</button>
</form>
<p><a href="${workEditPath(input.gameId)}">${back}</a></p>
</div>
</section>
${siteFooter()}`;
}

/**
 * 断りの画面を組み立てる（#664）。
 *
 * **エディットページへ 303 で戻さない**（戻すと、断られたことが URL にもステータスにも残らない。`src/publish.ts` の
 * `refusal` と同じ判断）。**保存できたものがあれば、それを言う**——「何も起きなかった」と「一部だけ保存した」を
 * 読み手が区別できるようにする。見つからないときは戻る先が無いので、リンクを添えない。
 *
 * @param gameId 作品 id
 * @param refusal 断りの中身
 * @param saved それまでに保存できたもの
 * @returns HTML
 */
export function renderSaveRefusal(gameId: string, refusal: SaveRefusal, saved: readonly SavedPart[]): string {
  const savedLine =
    saved.length === 0
      ? '<p>何も保存していません。</p>'
      : `<p><strong>${saved.join('・')}は保存しました。</strong>それより後の項目は保存していません。</p>`;
  const back = refusal.status === 404 ? '' : `\n<p><a href="${workEditPath(gameId)}">編集へ戻る</a></p>`;
  return `${siteHead({ title: `${refusal.heading} - Game Forge`, noindex: true })}
<h1>${refusal.heading}</h1>
<p class="gf-block">${refusal.body}</p>
${savedLine}${back}
${siteFooter()}`;
}

/**
 * 保存の要求を受ける（`POST /api/works/save`）。
 *
 * @param request 受信したリクエスト
 * @param env バインディングと環境変数
 * @param deps 撮影と通知の段
 * @returns レスポンス
 */
async function handleSave(request: Request, env: Env, deps: WorkSaveDeps): Promise<Response> {
  const asHtml = (request.headers.get('accept') ?? '').includes('text/html');

  const session = await resolveSessionUser(request, env);
  if (!session.ok) {
    return asHtml ? seeOther(LOGIN_PATH) : json({ error: 'unauthorized' }, 401);
  }

  const target = await readSaveTarget(request);
  if (!target.ok) {
    const refused = REMOVE_BODY_REFUSALS[target.reason];
    return asHtml
      ? html(
          `${siteHead({ title: '保存できません - Game Forge', noindex: true })}
<h1>保存できません</h1>
<p class="gf-block">${refused.body}</p>
${siteFooter()}`,
          refused.status,
        )
      : json({ error: target.reason }, refused.status);
  }

  const outcome = await saveWork(env, session.userId, target.input, deps);
  switch (outcome.kind) {
    case 'saved':
      // POST-redirect-GET。戻り先はエディットページで、そこに保存した値が出る。
      return asHtml
        ? seeOther(workEditPath(target.input.gameId))
        : json({ saved: true, parts: outcome.saved }, 200);
    case 'confirm':
      // **何も書いていない。** JSON の呼び出し側には、確認が要ることを 409 で返す（`confirm: true` を付けて送り直す）。
      return asHtml
        ? html(renderSaveConfirmation(target.input, outcome.to))
        : json({ error: 'confirmation-required', visibility: outcome.to }, 409);
    case 'refused':
      return asHtml
        ? html(renderSaveRefusal(target.input.gameId, outcome.refusal, outcome.saved), outcome.refusal.status)
        : json({ error: outcome.refusal.reason, saved: outcome.saved }, outcome.refusal.status);
  }
}

/**
 * まとめて保存する口の経路を組み立てる（#664）。
 *
 * **撮影の段と通知の段を差し替えられるのはここだけである**（`src/publish.ts` の `createPublishRoutes` と同じ形）。
 *
 * @param start 撮影を投げる段（既定は AWS Lambda への非同期呼び出し）
 * @param notify 改造の通知を送る段（既定は本物の送信）
 * @returns 経路表
 */
export function createWorkSaveRoutes(
  start: StartOgpCapture = startOgpCaptureOnLambda,
  notify: WorkSaveDeps['notify'] = notifyForkPublished,
): readonly Route[] {
  return [
    {
      method: 'POST',
      path: WORK_SAVE_PATH,
      handler: (request, env) => handleSave(request, env, { start, notify }),
    },
  ];
}

/** アプリの経路表へ連結する、まとめて保存する口。 */
export const workSaveRoutes: readonly Route[] = createWorkSaveRoutes();
