/**
 * 作品ページ（`/works/<game_id>`）。**#150 が作る「恒久的な URL」の実体である。**
 *
 * ## なぜこの画面が要るのか
 *
 * 生成は 90.9 秒かかる（1.2.38）。**91 秒のあいだブラウザのタブを開いたままに
 * してもらう設計そのものが問題である**（#150）。スマホで 91 秒は長く、画面が落ちる・
 * 通知でアプリが切り替わる・圏内外を跨ぐのは異常系ではなく通常の使い方である。
 *
 * 送信した瞬間に恒久的な URL が手に入れば、**タブを閉じてよくなり、「復帰」という
 * 概念自体が要らなくなる。** この画面がその URL の着地点になる。
 *
 * ## アプリ用ホストに置く（サンドボックス用ホストではない）
 *
 * 作品**そのもの**を配るのはサンドボックス用ホスト（`src/sandbox-delivery.ts`）だが、
 * **状態を読む画面はアプリ用ホストに置く。** 理由は 2 つある。
 *
 * - サンドボックス側の応答には `Content-Security-Policy: sandbox allow-scripts` が付き、
 *   **不透明オリジンになって cookie を一切持たない**（7.2）。所有者かどうかを見分けられない。
 * - 生成中の行はそもそもサンドボックス側から引けない（`preview_key` が無い。`src/games.ts`）。
 *
 * ## 誰が何を見られるか（#150 の決定）
 *
 * | | 状態（生成中 / 完成 / 失敗） | 仮タイトル・失敗の分類 |
 * |---|---|---|
 * | id を知っている人 | **見える** | 見えない |
 * | ログインした作者本人 | 見える | **見える** |
 *
 * **状態を誰でも読めるようにするのは、#150 の acceptance が「別のタブ・別の端末で
 * 開くと状態が読める」ことを求めるためである。** セッションを要求すると、別端末で
 * 開くたびにログインが要る。`games.id` は UUID（実効 122 ビット）で推測できず、
 * しかも**公開後は `/g/<game_id>/` として公開識別子になる**値なので、これ自体を
 * 秘密として扱う設計にはなっていない。
 *
 * **一方、仮タイトルはプロンプト由来である**（`draftTitleFromPrompt`）。利用者が
 * 書いた文章が id を知っているだけの相手に見えてよい理由は無いので、**本人にだけ出す。**
 * 失敗の分類も同じ扱いにする（何がどう失敗したかは作者の情報である）。
 *
 * ## JavaScript を要求しない
 *
 * 生成画面（`src/generate-page.ts`）は「この画面だけ」JS を要求すると決めている。
 * **ここへその例外を広げない。** 自動更新は `<meta http-equiv="refresh">` で行う。
 * JS を切っていても、通信が不安定でも、再読み込みさえできれば状態が読める。
 *
 * ## 応答本文の文字列を表示面へ持ち込まない（8.3）
 *
 * 出すのは**このモジュールが持つ固定の文言**と、D1 から読んだ値のうち
 * **利用者自身の入力（仮タイトル）だけ**である。`generation_error` は固定語彙の
 * 分類名で、**値そのものは出さない**（どの固定文言を出すかの鍵として使う）。
 */
import type { ForkChild, GenerationErrorCode, GenerationState } from './games.js';
import {
  countPublishedForks,
  listPublishedForks,
  PUBLISHED_STATUS,
  REMOVED_STATUS,
} from './games.js';
import {
  OGP_IMAGE_HEIGHT,
  OGP_IMAGE_WIDTH,
  ogpCaptureIsStale,
  ogpImagePath,
  ogpImageUrl,
} from './ogp.js';
import {
  FORK_PARENT_ID_FIELD,
  FORK_PATH,
  FORK_PROMPT_FIELD,
  OGP_RECAPTURE_GAME_ID_FIELD,
  OGP_RECAPTURE_PATH,
  PUBLISH_GAME_ID_FIELD,
  PUBLISH_PATH,
  RESTORE_PATH,
  REVISE_GAME_ID_FIELD,
  REVISE_PATH,
  REVISE_PROMPT_FIELD,
  REVISE_SEQ_FIELD,
} from './paths.js';
import { MAX_PROMPT_LENGTH } from './generate.js';
import {
  generationQuotaStatus,
  QUOTA_UNKNOWN_NOTICE,
  remainingQuotaNotice,
} from './quota.js';
import type { Revision } from './revisions.js';
import { listRevisions, revisionStatus } from './revisions.js';
import type { Route } from './routes.js';
import { html } from './routes.js';
import { resolveSessionUser } from './session-user.js';
// `escapeHtml` の正本は `src/signup.ts` である（`src/invite-issuance.ts` も
// そこから取っている）。同じ関数をこのモジュールで作り直さない。
import { escapeHtml, signupPathFrom } from './signup.js';

/**
 * 作品ページの接頭辞。
 *
 * **`/works/` にした。** サンドボックス側の `/g/`（公開）と `/p/`（プレビュー）と
 * 綴りを分けてある。ログや問い合わせで取り違えないことを優先した
 * （`src/games.ts` の `createPreviewKey` が UUID を避けたのと同じ判断）。
 *
 * 末尾の `/` は前方一致の規約である（`src/routes.ts` の `findMalformedPrefixRoutes`）。
 */
export const WORK_PAGE_PREFIX = '/works/';

/**
 * 作品ページのパスを組み立てる。
 *
 * **綴りを持つのはこのモジュールだけである。** 生成の経路（`src/generate.ts`）も
 * 生成画面（`src/generate-page.ts`）もここから取る。3 か所に `/works/` と書くと、
 * 変えたときに片方だけが古くなる。
 *
 * @param gameId 作品 id
 * @returns アプリ用ホスト上の絶対パス
 */
export function workPagePath(gameId: string): string {
  return `${WORK_PAGE_PREFIX}${gameId}`;
}

/**
 * `games.id` の綴り（`crypto.randomUUID()` が返す形）。
 *
 * **経路の入口で形を確かめる。** 確かめずに SQL のプレースホルダへ渡しても injection には
 * ならないが、`/works/../../etc` のような綴りが「作品が見つかりません」ではなく
 * D1 への問い合わせとして通ることになる。**引く前に落とすほうが安い**
 * （`src/sandbox-delivery.ts` の `GAME_ID_PATTERN` と同じ方針）。
 */
const GAME_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

/**
 * 生成中の行を「止まっているかもしれない」と見なすまでの秒数。
 *
 * **900 秒（15 分）。** 根拠は 2 つある。
 *
 * - 実測の待ち時間は 90.9 秒（1.2.38）で、5.2-7 のリトライで最大 3 試行まで伸びる。
 *   **正常な生成が誤って「中断」と表示されない**余裕が要る。
 * - AWS Lambda の実行時間の上限が 15 分である。オーケストレータ（別 issue）が
 *   どれだけ粘っても、これを超えて走ることはない。**超えたなら、もう返ってこない。**
 *
 * **D1 は書き換えない。** GET が状態を書き換える形にすると、ページを開いた人が
 * 行を壊せることになる。表示の上でだけ「中断した可能性」と言い、行は 3.7 の掃除
 * （未公開のまま 14 日で自動削除。確定13）に任せる。
 */
export const STALE_AFTER_SECONDS = 900;

/**
 * 生成が Worker の中で同期に走っているか（#150 / #160）。
 *
 * # なぜ画面がこれを知る必要があるのか
 *
 * 文言が実行形態と食い違うと、画面が嘘をつく。同期のあいだに「閉じてよい」と書けば
 * 生成は死に、非同期になってから「開いたままに」と書けば、要らない制約を課すことに
 * なる。**できていないことを、できているように書かない**（`src/home.ts` と同じ方針）。
 *
 * # いまは `false` である（#160）
 *
 * #150 が段（`GenerationPipeline.startJob`）を宣言し、**#160 がそれを
 * `startJobOnLambda`（オーケストレータ Lambda への非同期呼び出し）へ差し替えた。**
 * 生成の 90.9 秒は Worker の外で走るので、**タブを閉じても生成は進む。**
 *
 * # 変え忘れを機構で塞ぐ
 *
 * **呼びかけでは守らない**（shared-ai-rules 12 章）。`test/work-page.test.ts` が
 *
 *     (defaultPipeline.startJob === runJobInline) === GENERATION_IS_SYNCHRONOUS
 *
 * を照合しており、**段を差し替えた瞬間にこの定数の更新を要求して落ちる。**
 * import で結ばずにテストで結ぶのは、`src/generate.ts` がこのモジュールから
 * `workPagePath` を取っているため、逆向きの import が循環参照になるからである。
 *
 * 型を `boolean` と書いているのはリテラル型への絞り込みを避けるためで、
 * `false` のときに「常に偽」の比較として分岐が消えないようにしている。
 */
export const GENERATION_IS_SYNCHRONOUS: boolean = false;


/** 表示に使う `games` の 1 行（作者名と親作品を結合して引く）。 */
interface WorkRow {
  author_id: string;
  /** 5.4 の公開状態（`draft` / `published` / `removed`）。 */
  status: string;
  title: string;
  generation_state: string;
  generation_error: string | null;
  preview_key: string | null;
  created_at: number;
  generation_started_at: number | null;
  /** OGP 画像の撮影状態（`migrations/0009_games_ogp.sql`）。 */
  ogp_state: string | null;
  /** OGP の撮影を始めた時刻（`migrations/0012_games_ogp_started_at.sql`）。 */
  ogp_started_at: number | null;
  /** 公開した時刻。未公開なら null。**撮影を始めた時刻の代用**に使う（#235）。 */
  published_at: number | null;
  /** 作者の表示名（`users.display_name`）。結合が空振りしたら null。 */
  author_name: string | null;
  /**
   * この作品が指す親の id（`games.parent_id` そのもの）。オリジナルなら null。
   *
   * **結合結果の `p.id` ではない。** 結合が空振りした場合に「親が無い」と
   * 「親の行が引けない」を区別できなくなる。
   */
  parent_ref: string | null;
  /** 親作品の公開状態。親の行を引けなければ null。 */
  parent_status: string | null;
  /** 親作品の題名。親の行を引けなければ null。 */
  parent_title: string | null;
}

/**
 * ロード中画面が出す「元ゲーム」の中身（3.4-5 / 5.3 / 5.5）。
 *
 * **題名を出せる場合と出せない場合を、同じ型の別の枝にする。** 「題名が null なら
 * 親が無い」という表現にすると、**親が居るのに題名を出せない状態**（未公開・
 * tombstone）と区別できず、`null` の意味が 3 つになる。
 */
export type ParentWork =
  /** 親が無い（この作品がオリジナル）。 */
  | { readonly kind: 'none' }
  /** 親が公開されている。題名とリンクを出す。 */
  | { readonly kind: 'published'; readonly title: string; readonly path: string }
  /** 親が居るが公開されていない。**題名を出さない**（プロンプト由来のため）。 */
  | { readonly kind: 'unlisted' }
  /** 親が tombstone 化されている（5.3）。 */
  | { readonly kind: 'removed' };

/**
 * 1 頁に並べる子作品の数（5.5 / M5-3 / #34）。
 *
 * **20 件。** 5.5 が「`status='published'` のみ、新しい順、20件＋もっと見る」と値まで
 * 定めている。**ここで別の値を選ばない。**
 *
 * 値の置き場がこちら側なのは `listAuthoredGames` と同じ理由で、上限は
 * 「何件並べるか・次があることをどう示すか」という表示側の都合と一体だからである
 * （`src/games.ts` の `listPublishedForks` は既定値を持たない）。
 */
export const FORKS_PER_PAGE = 20;

/**
 * 「もっと見る」で頁を送るときの問い合わせ文字列の鍵（5.5 / #34）。
 *
 * **経路を増やさない。** 子の一覧は作品ページの一部であり、別の URL に出すと
 * 「同じ作品に 2 つの URL」ができる（`shareUrl` が問い合わせ文字列を捨てて正規の
 * 綴りを組み立て直しているのと同じ懸念）。**JavaScript も要求しない**——素の
 * `<a href="?forks=20">` である（このモジュール冒頭の方針）。
 */
export const FORKS_OFFSET_PARAM = 'forks';

/** 系統の下側（この作品からの改造）に出すもの（5.5 / M5-3 / #34）。 */
export interface ForkNeighbors {
  /**
   * 公開されている子の**実件数**。
   *
   * **`games.fork_count` ではない**（`src/games.ts` の `countPublishedForks`）。
   * 非正規化列は本番に「その更新経路を 1 度も通っていない行」を残しており、
   * 読むと初日から嘘の数が出る。
   */
  readonly total: number;
  /** この頁に並べる子（新しい順）。 */
  readonly items: readonly ForkChild[];
  /** 「もっと見る」の行き先。次の頁が無ければ null。 */
  readonly morePath: string | null;
  /** 「前へ」の行き先。1 頁目なら null。 */
  readonly backPath: string | null;
}

/** 子が 1 件も無い（＝一覧を引く必要も無い）状態。 */
const NO_FORKS: ForkNeighbors = { total: 0, items: [], morePath: null, backPath: null };

/**
 * 失敗の分類名ごとの固定文言（8.3）。
 *
 * **生成画面（`src/generate-page.ts`）の `GENERATE_MESSAGES` を再利用しない。**
 * あちらは「送信した要求が断られた」ときの文言で、こちらは「終わった仕事が失敗
 * だった」ときの文言である。時制も、利用者にできることも違う。共有すると、
 * どちらかに合わない文言を両方が我慢することになる。
 *
 * **鍵に無い値は既定の文言へ落とす。** 分類名は D1 から来るので、コードを戻した・
 * 進めた状況で知らない値が入っていることがありうる。
 */
const FAILURE_MESSAGES: Readonly<Record<GenerationErrorCode, string>> = {
  'source-rejected':
    '生成されたコードに、このサービスで許可していない機能の呼び出しが含まれていました。' +
    '別の言い方でもう一度お試しください。',
  'build-failed':
    '生成されたコードが最後までビルドできませんでした。' +
    '何度か作り直しましたが通らなかったため、ここで止めています。別の言い方でもう一度お試しください。',
  // **「コードが悪い」と言わない**（#164）。時間切れはこちら側の容量の問題であり、
  // 作りたいものを簡単にしても直らない。**利用者にできることは「もう一度」だけ**
  // なので、それだけを言う。
  'build-timeout':
    'ビルドが時間内に終わりませんでした。こちら側の混み具合による一時的なもので、' +
    '作りたいものの内容は関係ありません。そのままもう一度お試しください。',
  internal: '生成の途中で問題が起きました。しばらくしてからもう一度お試しください。',
};

/** 分類できない失敗に出す文言。 */
const UNKNOWN_FAILURE_MESSAGE =
  '生成できませんでした。しばらくしてからもう一度お試しください。';

/**
 * 自動更新の間隔（秒）。
 *
 * **5 秒。** 生成中のあいだだけ付ける。1 回の再読み込みで増えるのは D1 の読み取り
 * 1 件で、単価は書き込みの 1/1000 である（3.6）。生成は 1 日 12 回までなので
 * （確定25）、無料枠に響く量にならない。
 */
const REFRESH_SECONDS = 5;

/**
 * 生成中の行が「止まっているかもしれない」かを判定する。
 *
 * @param row 対象の行
 * @param now 現在時刻（UNIX 秒）
 * @returns 止まっている可能性が高ければ true
 */
export function looksStalled(
  row: { readonly createdAt: number; readonly startedAt: number | null },
  now: number,
): boolean {
  // **`generation_started_at` があればそちらを見る。** 非同期実行では、行を作ってから
  // ジョブが始まるまでにキューで待つ時間がある。作成時刻だけで測ると、その待ち時間が
  // そのまま「中断」に見える。
  const since = row.startedAt ?? row.createdAt;
  return now - since >= STALE_AFTER_SECONDS;
}

/**
 * サンドボックス用ホスト上の作者プレビュー URL を組み立てる（5.4 / #28）。
 *
 * **スキームとポートはこのリクエストから借りる。** 同じ Worker がアプリ用ホストと
 * サンドボックス用ホストの両方を受けているため、違うのはホスト名だけである
 * （`src/sandbox-delivery.ts` の `responseContextOf` と同じ組み立て方）。
 *
 * @param request 受信したリクエスト
 * @param env バインディングと環境変数
 * @param previewKey プレビュー用キー
 * @returns 絶対 URL
 */
function previewUrl(request: Request, env: Env, previewKey: string): string {
  const url = new URL(request.url);
  const port = url.port === '' ? '' : `:${url.port}`;
  return `${url.protocol}//${env.SANDBOX_HOST}${port}/p/${previewKey}/`;
}

/**
 * サンドボックス用ホスト上の公開 URL を組み立てる（5.4）。
 *
 * **プレビュー URL と綴りを分ける。** 5.4 が「公開前後で綴りを分ける」と定めており、
 * `/g/` は `status='published'` の作品しか返さない（`src/sandbox-delivery.ts`）。
 * 組み立て方は {@link previewUrl} と同じで、違うのは接頭辞と、鍵ではなく id を使う点である。
 *
 * @param request 受信したリクエスト
 * @param env バインディングと環境変数
 * @param gameId 作品 id
 * @returns 絶対 URL
 */
function publishedUrl(request: Request, env: Env, gameId: string): string {
  const url = new URL(request.url);
  const port = url.port === '' ? '' : `:${url.port}`;
  return `${url.protocol}//${env.SANDBOX_HOST}${port}/g/${gameId}/`;
}

/** 画面に出す状態。D1 の綴りを、そのまま表示の分岐に使わない。 */
type ViewState = 'working' | 'stalled' | 'ready' | 'failed' | 'unknown';

/**
 * `generation_state` を画面の状態へ落とす。
 *
 * @param state D1 の `generation_state`
 * @param stalled 生成中で、かつ止まっている可能性が高いか
 * @returns 画面の状態
 */
function viewStateOf(state: string, stalled: boolean): ViewState {
  const known: readonly GenerationState[] = ['pending', 'running', 'ready', 'failed'];
  if (!(known as readonly string[]).includes(state)) {
    // CHECK があるので通常は起こらない。**それでも既定へ落とさない**
    // （「生成中」と言い続けるより、分からないと言うほうがよい）。
    return 'unknown';
  }
  if (state === 'ready') {
    return 'ready';
  }
  if (state === 'failed') {
    return 'failed';
  }
  return stalled ? 'stalled' : 'working';
}

/**
 * 失敗の分類名に対応する固定文言を選ぶ。
 *
 * @param code D1 の `generation_error`
 * @returns 表示する文言
 */
export function failureMessageOf(code: string | null): string {
  if (code !== null && Object.prototype.hasOwnProperty.call(FAILURE_MESSAGES, code)) {
    return FAILURE_MESSAGES[code as GenerationErrorCode];
  }
  return UNKNOWN_FAILURE_MESSAGE;
}

/** 画面を組み立てるのに必要なものだけを集めた入力。 */
export interface WorkPageView {
  readonly state: ViewState;
  /** 作者本人が見ているか。**本人にだけ出す項目の門番である。** */
  readonly owner: boolean;
  /**
   * 公開済みか（5.4）。**この 1 つが画面の性格を変える。**
   *
   * 未公開なら作者のための状態画面（`noindex`・本人にしか中身を出さない）、
   * 公開済みなら**共有される URL の着地点**（OGP のメタタグを持ち、タイトルを誰にでも
   * 出す）になる。
   */
  readonly published: boolean;
  /** 仮タイトル（プロンプト由来）。本人でも公開済みでもなければ null。 */
  readonly title: string | null;
  /** 失敗の分類名。本人でなければ null。 */
  readonly errorCode: string | null;
  /**
   * 遊べる URL。
   *
   * 公開済みなら `/g/<game_id>/`（誰でも）、未公開なら `/p/<preview_key>/`
   * （**作者本人にだけ**）。
   */
  readonly playUrl: string | null;
  /** この作品 id（公開のフォームに入れる）。公開の操作を出さないなら null。 */
  readonly publishableId: string | null;
  /**
   * この作品 id（フォークのフォームに**親として**入れる。5.3 / #32）。
   *
   * **`publishableId` と兼ねない。** あちらは「未公開・完成済み・本人」のときの id で、
   * こちらは「**公開済み**」のときの id である。**同時に非 null になることが無い**
   * 2 つの値を 1 つの項目に畳むと、片方の条件を変えた日にもう片方が黙って壊れる。
   */
  readonly forkableId: string | null;
  /** 公開済みのときの共有 URL（この作品ページ自身の絶対 URL）。 */
  readonly shareUrl: string | null;
  /** OGP 画像の絶対 URL。まだ撮れていなければ null。 */
  readonly imageUrl: string | null;
  /**
   * ロード中画面に出す OGP 画像のパス（3.4-5 / #30）。まだ撮れていなければ null。
   *
   * **`imageUrl`（絶対 URL）と別に持つ。** あちらはメタタグ用で、クローラのために
   * 絶対 URL でなければならない。画面に貼る `<img>` は**同一オリジンの絶対パス**で
   * よく、`og:image` の値を使い回すと、要求された URL のホスト表記（開発時の
   * `localtest.me:8788` など）がそのまま画面の依存先になる。
   */
  readonly imagePath: string | null;
  /**
   * 作者の表示名（`users.display_name`）。**公開済みのときだけ入る。**
   *
   * 3.4-5 と 2.2-2 が名指しする 4 要素の 1 つである。**UGC 由来の文字列**なので
   * `escapeHtml` を通す（この値がサンドボックス文書へ渡らないことが 7.2 の要点。
   * 下の {@link loadingScreen} を参照）。
   */
  readonly authorName: string | null;
  /** 元ゲーム（3.4-5 の 4 要素の 1 つ）。公開済みのときだけ意味を持つ。 */
  readonly parent: ParentWork;
  /**
   * この作品からの改造（5.5 / M5-3 / #34）。**公開済みのときだけ引く。**
   *
   * 未公開の作品に公開済みの子はありえない（フォークの親になれるのは公開済みだけ。
   * 5.3）が、**「ありえないから 0 件」を画面が前提にしない**——空の
   * {@link NO_FORKS} を渡すのは `showWorkPage` の判断であって、この型の含意ではない。
   */
  readonly forks: ForkNeighbors;
  /**
   * この画面を見ている人がログインしているか。
   *
   * **`owner` とは別である。** 「改造する」の行き先を決めるのに要るのは
   * 「招待された参加者かどうか」であって、この作品の作者かどうかではない（2.2-4）。
   */
  readonly signedIn: boolean;
  /**
   * 推敲の入力を出してよいか（5.7 / 確定28）。
   *
   * **画面で `owner && !published && …` を組み立てない。** 5.7 の対象条件は仕様の値で
   * あって画面の都合ではなく、判定が 2 か所に散ると**経路（`src/revise.ts`）は断るのに
   * 画面は出す**という食い違いが生まれる。ここへ来るのは既に判定された真偽だけである。
   */
  readonly revisable: boolean;
  /**
   * 4.4 の「本日の残り生成枠 N回」の数。読めなければ null。
   *
   * **推敲（5.7）とフォーク（5.3）が同じ値を見る。** 確定25 の日次枠は 1 人あたりの
   * ものであって操作ごとのものではない（5.7「別枠は作らない」）ので、**画面にも 1 つ
   * しか置かない。**
   */
  readonly dailyRemaining: number | null;
  /** この作品にあと何回推敲できるか（5.7）。作者でなければ null。 */
  readonly revisionsRemaining: number | null;
  /** いま推敲が走っているか。走っているあいだは新しく始められない。 */
  readonly revisionRunning: boolean;
  /** 直前の推敲が失敗していれば、その分類名。 */
  readonly revisionError: string | null;
  /** 版の一覧（新しい順）。作者でなければ空。 */
  readonly revisions: readonly Revision[];
  /**
   * この作品 id（撮り直しのフォームに入れる。5.4 / #235）。撮り直せないなら null。
   *
   * **`publishableId` と兼ねない。** あちらは「未公開・完成済み・本人」のときの id で、
   * こちらは「**公開済み**・撮影が中断したまま・本人」のときの id である
   * （`forkableId` を分けたのと同じ理由——同時に非 null になりえない値を 1 つに畳むと、
   * 片方の条件を変えた日にもう片方が黙って壊れる）。
   *
   * **画面でこの条件を組み立てない**（`revisable` と同じ方針）。掴めるかどうかを
   * 決めるのは `reclaimStaleOgpCapture` の SQL で、ここへ来るのは判定済みの値だけである。
   */
  readonly recapturableId: string | null;
}

/**
 * 作品ページの HTML を組み立てる。
 *
 * **`escapeHtml` を通すのは `title` だけである。** 他はすべてこのモジュールが持つ
 * 固定の文字列か、正規表現で形を確かめた URL である。
 *
 * @param view 表示に必要な値
 * @returns HTML
 */
export function renderWorkPage(view: WorkPageView): string {
  // 生成中のあいだだけ自動更新する。完成・失敗の画面で再読み込みを続ける理由が無い
  // （D1 の読み取りが増えるだけで、表示は変わらない）。
  // **推敲中も更新する。** 5.7 の「押したら作り直しが始まり、完成したら差し替わる」は、
  // 作者が待っているあいだ画面が変わらないことを許さない。**`state` は `ready` のまま
  // なので、この条件を足さないと止まって見える**（推敲は `games` の状態機械を動かさない。
  // `migrations/0009_game_revisions.sql`）。
  const refresh =
    view.state === 'working' || view.state === 'stalled' || view.revisionRunning
      ? `\n<meta http-equiv="refresh" content="${REFRESH_SECONDS}">`
      : '';

  const title = view.title === null ? '' : `<p>お題: ${escapeHtml(view.title)}</p>`;

  // **公開済みの作品にだけ `noindex` を外す。** 未公開の作品ページは作者のための
  // 状態画面であり、検索結果に現れる意味が無い（`src/my-works.ts` と同じ扱い）。
  //
  // 公開済みで外すのは体裁の問題ではない。**`noindex` を付けたページのカードを
  // 描かないクローラがある**ため、付けたままだと 5.4 の「公開して共有」が、
  // 共有先で画像も題名も出ないという形で黙って壊れる。
  const robots = view.published ? '' : '\n<meta name="robots" content="noindex">';

  return `<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">${refresh}${robots}
<title>${escapeHtml(documentTitleOf(view))}</title>${ogpMeta(view)}${loadingScreenStyle(view)}
<h1>作品</h1>
${sectionFor(view)}
${title}
<p><a href="/">トップへ</a></p>`;
}

/** OGP の説明文（固定）。**作品ごとに変えない**——中身を説明できるのは作者だけである。 */
const OGP_DESCRIPTION = 'Game Forge で作られたゲームです。ブラウザでそのまま遊べます。';

/** 作品名を出せないときの表題。 */
const FALLBACK_WORK_TITLE = 'Game Forge の作品';

/**
 * `<title>` に出す文字列を決める。
 *
 * @param view 表示に必要な値
 * @returns 表題
 */
function documentTitleOf(view: WorkPageView): string {
  const name = view.title === null || view.title.trim() === '' ? FALLBACK_WORK_TITLE : view.title;
  return `${name} - Game Forge`;
}

/**
 * OGP のメタタグを組み立てる（5.4 / 11.2）。
 *
 * # 公開済みのときだけ出す
 *
 * **未公開の作品のメタタグを出さない。** 出す値（題名・画像）はどちらも
 * 「公開したから出してよくなったもの」であり、5.4 の遅延（`OGP 画像の生成は「公開」時
 * まで遅延する`）と揃える。
 *
 * # 画像が無ければ画像のタグごと出さない
 *
 * 撮影は非同期なので、公開した直後の数秒は `og:image` が無い状態がありうる
 * （`src/ogp.ts`）。**その間だけ `summary_large_image` を名乗らない**——大きなカードを
 * 宣言しておいて画像が 404 になるより、小さなカードのほうが壊れて見えない。
 *
 * # `escapeHtml` を通すのは題名だけである
 *
 * 他はこのモジュールが持つ固定の文字列か、`crypto.randomUUID()` から組み立てた URL
 * である（`renderWorkPage` と同じ方針）。
 *
 * @param view 表示に必要な値
 * @returns メタタグ（未公開なら空文字）
 */
function ogpMeta(view: WorkPageView): string {
  if (!view.published || view.shareUrl === null) {
    return '';
  }
  const name = view.title === null || view.title.trim() === '' ? FALLBACK_WORK_TITLE : view.title;
  const image =
    view.imageUrl === null
      ? '\n<meta name="twitter:card" content="summary">'
      : `
<meta property="og:image" content="${view.imageUrl}">
<meta property="og:image:width" content="${OGP_IMAGE_WIDTH}">
<meta property="og:image:height" content="${OGP_IMAGE_HEIGHT}">
<meta name="twitter:card" content="summary_large_image">`;

  return `
<meta property="og:type" content="website">
<meta property="og:site_name" content="Game Forge">
<meta property="og:title" content="${escapeHtml(name)}">
<meta property="og:description" content="${OGP_DESCRIPTION}">
<meta property="og:url" content="${view.shareUrl}">${image}`;
}

/**
 * 状態ごとの本文を組み立てる。
 *
 * @param view 表示に必要な値
 * @returns HTML
 */
function sectionFor(view: WorkPageView): string {
  switch (view.state) {
    case 'working':
      // **文言は `GENERATION_IS_SYNCHRONOUS` が決める。** #160 で非同期実行になった
      // ので「閉じてよい」が正しい。同期側の文言は消さずに残す——段を戻したときに
      // 書き直すのではなく、定数 1 つで両方の実行形態を言い当てられるようにしておく。
      return GENERATION_IS_SYNCHRONOUS
        ? `<h2>生成中です</h2>
<p><strong>生成が終わるまで、このタブを開いたままにしてください。</strong>
   いま閉じると生成は中断します。</p>
<p>通常 1〜2 分かかります。この画面は自動で更新されます。</p>
<p>この URL は作品の恒久的な URL です。控えておけば、あとから状態を確認できます。</p>`
        : `<h2>生成中です</h2>
<p><strong>このページは開いたままにしなくて構いません。</strong>
   タブを閉じても生成は進みます。この URL をもう一度開けば、続きから状態が読めます。</p>
<p>通常 1〜2 分かかります。この画面は自動で更新されます。</p>`;
    case 'stalled':
      return `<h2>生成中です</h2>
<p><strong>時間がかかりすぎています。中断した可能性があります。</strong>
   しばらく待っても変わらない場合は、お手数ですがもう一度生成してください。</p>
<p>この画面は自動で更新されます。</p>`;
    case 'ready':
      return view.published ? publishedSection(view) : readySection(view);
    case 'failed':
      return `<h2>生成できませんでした</h2>
<p>${view.owner ? escapeHtml(failureMessageOf(view.errorCode)) : escapeHtml(UNKNOWN_FAILURE_MESSAGE)}</p>`;
    case 'unknown':
      return `<h2>状態を読み取れませんでした</h2>
<p>この作品の状態が想定外の値になっています。時間をおいてもう一度お試しください。</p>`;
  }
}

/**
 * 試遊画面の主ボタン（5.4）。
 *
 * **文言は 5.4 が定めている**（「試遊画面の主ボタンは「**公開して共有**」とし、
 * 1タップに畳んでフォーク連鎖の遅延を最小化する」）。ここで言い換えない。
 *
 * **1 タップに畳む。** 題名を入力させる欄も、確認の画面も置かない。5.4 が
 * 「フォーク連鎖の遅延を最小化する」と定めているのは、**公開の手数がそのまま
 * コア体験ループ（2.2）の長さになる**ためである。題名は生成のプロンプトから
 * 借りたものがそのまま公開される（`src/games.ts` の `draftTitleFromPrompt`）。
 *
 * **JavaScript を要求しない。** 素の `<form method="post">` で、押した結果は
 * POST-redirect-GET でこのページへ戻る（`src/publish.ts`）。
 *
 * @param gameId 作品 id
 * @returns HTML
 */
function publishForm(gameId: string): string {
  return `<form method="post" action="${PUBLISH_PATH}">
  <input type="hidden" name="${PUBLISH_GAME_ID_FIELD}" value="${gameId}">
  <button type="submit">公開して共有</button>
</form>`;
}

/**
 * 完成したが、まだ公開していない作品の本文。
 *
 * **試遊 URL を出すのは作者本人にだけである。** `preview_key` は unlisted 配信の
 * 唯一の資格情報で（5.4 / `migrations/0006_games_preview_key.sql`）、id を知って
 * いるだけの相手へ渡す理由が無い。**状態は誰でも読めるが、鍵は本人だけが読める。**
 *
 * @param view 表示に必要な値
 * @returns HTML
 */
function readySection(view: WorkPageView): string {
  if (!view.owner) {
    return `<h2>できました</h2>
<p>この作品はまだ公開されていません。</p>`;
  }
  const play =
    view.playUrl === null
      ? '<p>作品は完成していますが、試遊 URL を組み立てられませんでした。</p>'
      : `<p><a href="${view.playUrl}">この作品を遊ぶ</a></p>
<p>この URL は<strong>あなただけが知っている URL</strong> です（まだ公開されていません）。</p>`;
  const publish =
    view.publishableId === null
      ? ''
      : `
<p>遊んでみて、よければ公開できます。</p>
${publishForm(view.publishableId)}`;
  return `<h2>できました</h2>
${play}${publish}${reviseSection(view)}${revisionList(view)}`;
}

/**
 * 推敲の入力（5.7 / #193）。
 *
 * # 主ボタンは「公開して共有」のままである
 *
 * 5.4 は試遊画面の主ボタンを「公開して共有」と定め、**1 タップに畳んでフォーク連鎖の
 * 遅延を最小化する**と書いている。推敲はその**あと**に置く——先に置くと、公開までの
 * 手数が 1 つ増えたのと同じことになる。
 *
 * # 待ち時間と費用を隠さない
 *
 * 5.7 が「プレイ画面の横で対話するような形にしない」と定めているのは、**その形が
 * 即応性を約束してしまい、実測（90.9 秒）と食い違う**ためである。押す前に何が起きるかを
 * 書く。**二重送信はボタンの無効化ではなく、走っているあいだフォームを出さないことで
 * 防ぐ**（JavaScript を要求しない。`src/publish.ts` と同じ形）。
 *
 * @param view 表示に必要な値
 * @returns HTML
 */
function reviseSection(view: WorkPageView): string {
  if (!view.owner) {
    return '';
  }
  if (view.revisionRunning) {
    return `
<h3>手直しをしています</h3>
<p><strong>このページは開いたままにしなくて構いません。</strong>
   通常 1〜2 分かかります。この画面は自動で更新されます。</p>
<p>できあがるまで、上の URL では<strong>いまの版</strong>が遊べます。</p>`;
  }

  // **失敗は残す。** 作品は無傷なので画面は「できました」のままだが、押した操作が
  // どうなったかを言わないと、作者からは何も起きなかったように見える。
  const failed =
    view.revisionError === null
      ? ''
      : `
<p><strong>前回の手直しはうまくいきませんでした。</strong>
   ${escapeHtml(failureMessageOf(view.revisionError))}
   作品はそのまま残っています。</p>`;

  // **`publishableId` が無ければフォームを描かない。** ここは推敲の対象そのものの id で、
  // `revisable` が真ならこちらも非 null である（`showWorkPage` が同じ条件から作る）。
  // **その含意に寄りかからない**——空の `value` を持つフォームを描くくらいなら、
  // 出さないほうがよい。
  if (!view.revisable || view.publishableId === null) {
    return failed;
  }

  const remaining =
    view.revisionsRemaining === null
      ? ''
      : `<p>この作品はあと ${Math.max(0, Math.trunc(view.revisionsRemaining))} 回手直しできます。</p>`;
  const daily =
    view.dailyRemaining === null
      ? `<p>${QUOTA_UNKNOWN_NOTICE}</p>`
      : `<p>${remainingQuotaNotice(view.dailyRemaining)}</p>`;

  // **本日の枠が尽きていたらフォームを出さない**（4.4）。4.4 は「UI に露出させなければ
  // 押しても動かないボタンになる」と書いており、**その裏返しも真である**——押せば
  // `/api/revise` が 429 で断る操作を、押せる形で出さない。`src/generate-page.ts` が
  // 同じ状態でフォームを描かないのと揃える。
  //
  // **残数の表示は出したまま**にする。フォームごと消すと、作者からは「昨日はあった口が
  // 消えた」としか読めない。**日次と月次のどちらで止まったかはここでは言わない**
  // （文言の正本は `src/generate-page.ts` の文言表で、書き写すと片方だけが古くなる）。
  const form =
    view.dailyRemaining === 0
      ? ''
      : `
<form method="post" action="${REVISE_PATH}">
  <input type="hidden" name="${REVISE_GAME_ID_FIELD}" value="${view.publishableId}">
  <label for="revise-prompt">どう直しますか</label>
  <textarea id="revise-prompt" name="${REVISE_PROMPT_FIELD}" rows="3"
            maxlength="${MAX_PROMPT_LENGTH}" required
            placeholder="例: 玉の動きをもっと速くして、当たったら音を鳴らす"></textarea>
  <button type="submit">この内容で直す</button>
</form>`;

  return `${failed}
<h3>気になるところを直す</h3>
<p>どう直したいかを書くと、いまのソースをもとに作り直します。
   <strong>1 回につき 1〜2 分かかり、生成枠を 1 回使います。</strong></p>
${remaining}${daily}${form}`;
}

/**
 * 版の一覧と「この版に戻す」（5.7）。
 *
 * **全文再出力である以上、「少し直したつもりが全体が変わる」ことは異常ではない。**
 * 戻せなければ推敲は 1 回 約 16 円の賭けになり、作者は 2 回目を押さない。
 *
 * **`seq = 1` のプロンプトは null である**（`migrations/0009_game_revisions.sql`）。
 * 初回のプロンプトは費用台帳にしか無く、確定27 により版から引けない。**「最初の生成」と
 * 出せば作者は選べる**ので、そのために値を 3 か所目へ複製しない。
 *
 * **推敲が走っているあいだは戻す口を出さない。** 戻しても 90 秒後に黙って上書き
 * されるので、経路側も断る（`src/revisions.ts` の `restoreRevision`）。
 *
 * @param view 表示に必要な値
 * @returns HTML
 */
function revisionList(view: WorkPageView): string {
  // **1 つしかない版を「履歴」として見せない。** 初回生成だけの作品では戻す先が
  // 現在地しかなく、選択肢のない一覧は画面を重くするだけである。
  if (!view.owner || view.revisions.length < 2) {
    return '';
  }

  // **戻す口は id が要る。** {@link reviseSection} と同じ理由で、含意に寄りかからず
  // 明示的に見る（一覧そのものは id が無くても読める値なので、出し続ける）。
  const restorable = view.publishableId;

  const items = view.revisions
    .map((revision) => {
      const label =
        revision.prompt === null ? '最初の生成' : escapeHtml(revision.prompt);
      const current = revision.current ? ' <strong>（いまの版）</strong>' : '';
      const restore =
        revision.current || view.revisionRunning || restorable === null
          ? ''
          : `
    <form method="post" action="${RESTORE_PATH}">
      <input type="hidden" name="${REVISE_GAME_ID_FIELD}" value="${restorable}">
      <input type="hidden" name="${REVISE_SEQ_FIELD}" value="${revision.seq}">
      <button type="submit">この版に戻す</button>
    </form>`;
      return `  <li>${label}${current}${restore}</li>`;
    })
    .join('\n');

  return `
<h3>これまでの版</h3>
<p>戻すのに生成枠は使いません。</p>
<ul>
${items}
</ul>`;
}

/**
 * 公開済みの作品の本文。**この画面が 3.4-5 の「ロード中画面」である**（#30）。
 *
 * # なぜ作品ページが遊ぶ場所になるのか
 *
 * 2.2 のループは「発見（SNS の URL）→ ロード（タップから数秒）」である。**共有される
 * URL はこのページである**（カードが出るのはこちらで、`/g/` は不透明オリジンの
 * iframe 用文書）。ここで遊べないと、利用者は 1 回よけいにタップし、その先の数秒は
 * 文脈を持たない黒い画面になる。**待ち時間が起きる場所と、文脈を出せる場所を同じに
 * する**のが 3.4-5 の求めていることである。
 *
 * **`/g/<game_id>/` へのリンクを別に出さない。** 出せる URL は 2 本あるが、5.4 の
 * 「配る URL は 1 本でよい」に従い、遊ぶための URL は iframe の `src` としてだけ現れる。
 *
 * # 4 要素をアプリ用ホスト側に置く（7.2 を崩さないための判断）
 *
 * 3.4-5 は OGP スクリーンショット・作者名・親ゲーム名・「改造する」の 4 つを先に出せと
 * 言う。**このうち作者名と親ゲーム名は UGC 由来である。** 一方 7.2 の必須要件を満たす
 * サンドボックス文書は `script-src 'unsafe-inline'` を持つため、**そこへ UGC 由来の
 * 文字列を入れると、エスケープ漏れが即座にスクリプト実行になる**（`src/sandbox-loader.ts`）。
 *
 * **したがって 4 要素はこちら側に描く。** 結果として、
 *
 * - サンドボックス文書は UGC 由来の文字列を 1 つも持たないまま変わらない（7.2）
 * - OGP 画像は**このページと同一オリジン**になり、サンドボックスの `img-src` を
 *   緩める必要が消える（`src/sandbox-csp.ts` は 1 文字も変わらない）
 * - iframe は `sandbox="allow-scripts"` だけを付ける。**`allow-same-origin` も
 *   `allow-popups` も付けない**（7.2）。配信側の `frame-ancestors` は既にこのオリジン
 *   だけを許している（`src/sandbox-delivery.ts`）
 *
 * # ロード中画面を「覆い」にしない
 *
 * 4 要素を iframe の上へ重ねて、読み込み完了で消す形は採らない。**消す契機を作れない**
 * ためである。JavaScript で消すなら、親は wasm が起動したことを知る必要があり、経路は
 * 不透明オリジン（`origin` が `null`）からの `postMessage` しかない。**`null` は名乗り
 * であって身元ではなく**、しかも送り手の文書では UGC が動く。CSS だけで重ねる形も
 * 成立しない——iframe の中の文書は自前の背景を持つので、**wasm ではなく文書が
 * 読み込まれた瞬間**（数秒ではなく数十ミリ秒）に覆いを塗りつぶす。**出したい数秒の
 * 手前で消える。**
 *
 * **だから並べる。** 4 要素は枠の手前（文書順で先）に置き、読み込み中も、読み込み後も
 * そのまま残る。作者名・元ゲーム・改造導線は、遊び終わったあとにも要る情報である。
 *
 * @param view 表示に必要な値
 * @returns HTML
 */
function publishedSection(view: WorkPageView): string {
  const share =
    view.shareUrl === null
      ? ''
      : `
<p>共有する URL: <code>${view.shareUrl}</code></p>`;
  return `<h2>公開しています</h2>
${loadingScreen(view)}${share}
${forkList(view.forks)}${recaptureSection(view)}`;
}

/**
 * 「このゲームからの改造: N 件」（5.5 / M5-3 / #34）。
 *
 * # 件数は必ず出す
 *
 * **0 件でも見出しを消さない。** 5.5 は親の 1 リンクと子の一覧を対で定めており、
 * 「元ゲーム: ありません（この作品がオリジナルです）」を出しているのに、下側だけ
 * 何も無いと**「まだ誰も改造していない」と「機能が無い」を読み手が区別できない**
 * （{@link loadingScreen} の「無いときは、無いことを言う固定文言へ倒す」と同じ規則）。
 *
 * # 枠の**下**に置く
 *
 * 3.4-5 の 4 要素は iframe より前に置くと決まっている（{@link loadingScreen}）。
 * **子の一覧はその 4 要素ではない。** 前に置くと、拡散の着地点で最初に目に入るものが
 * 「このゲーム」ではなく「派生の一覧」になり、待ち時間を埋めるための版面が押し下げられる。
 *
 * # 題名を出してよいのは、公開済みの行だけである
 *
 * 引く時点で `status='published'` に絞ってある（`src/games.ts` の
 * `listPublishedForks`）。**ここで再度絞らない**——絞りを 2 か所に置くと、片方を
 * 直した日にもう片方が古くなる。UGC 由来なので `escapeHtml` は通す。
 *
 * @param forks 子作品の一覧と件数
 * @returns HTML
 */
function forkList(forks: ForkNeighbors): string {
  const heading = `<p class="gf-forks">このゲームからの改造: ${forks.total} 件</p>`;
  if (forks.items.length === 0) {
    return heading;
  }
  const items = forks.items
    .map(
      (child) =>
        `<li><a href="${workPagePath(child.id)}">${escapeHtml(child.title)}</a></li>`,
    )
    .join('\n');
  // **「もっと見る」も「前へ」も素のリンクである**（このモジュール冒頭の「JavaScript を
  // 要求しない」）。次が無ければ出さない——押しても何も起きない導線を出さない
  // （`publishForm` と同じ方針）。
  const more =
    forks.morePath === null ? '' : `\n<p class="gf-forks-more"><a href="${forks.morePath}">もっと見る</a></p>`;
  const back =
    forks.backPath === null ? '' : `\n<p class="gf-forks-back"><a href="${forks.backPath}">前へ</a></p>`;
  return `${heading}
<ul class="gf-fork-list">
${items}
</ul>${back}${more}`;
}

/**
 * 中断したままの撮影を撮り直す口（5.4 / #235）。
 *
 * # なぜ作者に見せるのか
 *
 * 撮影が中断したまま残っても、**作品ページはそれを待たずに出る。** 共有 URL は
 * OGP 無しで拡散し、**気づく経路がどこにも無かった**（`docs/ogp-capture.md` 7 章）。
 * 黙って失敗を作らない（仕様 1.2.31）。
 *
 * # 主ボタンを増やさない
 *
 * 5.4 は試遊画面の主ボタンを「公開して共有」と定める。ここは**公開したあと**の画面で、
 * しかも**出るのは中断が起きたときだけ**である（`recapturableId` が null なら 1 バイトも
 * 出ない）。1 タップの導線は 1 文字も変わらない。
 *
 * # 押せるときにしか出さない
 *
 * 押しても何も起きないボタンを出さない（`publishForm` と同じ方針）。**押した結果を
 * 決めるのは `reclaimStaleOgpCapture` の SQL** で、ここは口を出すかだけを決める。
 *
 * @param view 表示に必要な値
 * @returns HTML
 */
function recaptureSection(view: WorkPageView): string {
  if (view.recapturableId === null) {
    return '';
  }
  // **「失敗しました」と言い切らない。** ここへ来るのは「900 秒たっても終わっていない」
  // ことだけで、撮影関数が何を返したかは分かっていない（返せずに落ちたから残っている）。
  return `
<h3>スクリーンショット</h3>
<p>この作品のスクリーンショットの撮影が、途中で止まったままです。共有した URL に画像が出ません。</p>
<form method="post" action="${OGP_RECAPTURE_PATH}">
  <input type="hidden" name="${OGP_RECAPTURE_GAME_ID_FIELD}" value="${view.recapturableId}">
  <button type="submit">スクリーンショットを撮り直す</button>
</form>`;
}

/**
 * 「改造する」の文言（2.2-4）。**仕様の言い回しをここで言い換えない。**
 */
const FORK_LABEL = 'このゲームを改造する';

/**
 * ロード中画面（3.4-5 / 2.2-2 / #30）。
 *
 * **4 要素は 1 つも条件付きにしない。** どれか 1 つでも「値が無ければ出さない」に
 * すると、acceptance が求める「4 要素すべてが描画される」が**データの状態しだいで
 * 崩れる。** 値が無いときは、無いことを言う固定文言へ倒す（撮影中のスクリーンショット、
 * 親を持たない作品）。
 *
 * **文書順が描画順である。** 4 要素は iframe より前に置く。HTML は上から解釈されるので、
 * ここに書いたものは**枠の中身が 1 バイトも届く前に**描かれる。
 *
 * @param view 表示に必要な値
 * @returns HTML
 */
function loadingScreen(view: WorkPageView): string {
  const frame =
    view.playUrl === null
      ? '<p>公開されていますが、遊ぶための URL を組み立てられませんでした。</p>'
      : // **`sandbox` は `allow-scripts` だけである**（7.2）。属性を足すときは 7.2 を先に読むこと。
        `<iframe class="gf-frame" src="${view.playUrl}" sandbox="allow-scripts" title="ゲーム"></iframe>`;

  return `<div class="gf-context">
${screenshot(view)}
<p class="gf-author">作者: <strong>${escapeHtml(view.authorName ?? UNKNOWN_AUTHOR)}</strong></p>
<p class="gf-parent">${parentLine(view.parent)}</p>
${forkCta(view)}
</div>
${frame}`;
}

/** 作者名を引けなかったときの表示。**空欄にしない。** */
const UNKNOWN_AUTHOR = '不明';

/**
 * OGP スクリーンショット（3.4-5 の 4 要素の 1 つ）。
 *
 * **撮影中・失敗のときは `<img>` を出さない。** 出すと確実に 404 を引き（`src/ogp.ts` の
 * 配信は行と実体の両方を見る）、壊れた画像として見える。代わりに、同じ場所へ同じ
 * 大きさの枠と固定文言を置く。**要素そのものは消さない**（消すと読み込み後に版面が
 * 飛ぶ）。
 *
 * `width` / `height` を属性で書くのは版面の飛びを防ぐためで、値は撮影側の定数
 * （`src/ogp.ts`）から取る。**書き写さない。**
 *
 * @param view 表示に必要な値
 * @returns HTML
 */
function screenshot(view: WorkPageView): string {
  if (view.imagePath === null) {
    // 大きさは `.gf-shot` の `aspect-ratio` が持つ（`width` / `height` 属性は
    // 置換要素のためのものなので、ここには書かない）。
    //
    // **撮り直しの口が出ている画面で「準備しています」と書かない**（#235）。
    // 同じページが「準備中」と「止まったまま」を同時に言うことになる。
    // **口が出るのは作者だけ**なので、他人には従来の文言のままにする——中断を
    // 見せても、その人にできることが 1 つも無い。
    return view.recapturableId === null
      ? `<p class="gf-shot gf-shot-pending">スクリーンショットを準備しています。</p>`
      : `<p class="gf-shot gf-shot-pending">スクリーンショットの撮影が止まっています。</p>`;
  }
  // **`loading="lazy"` を付けない。** この画像は待ち時間を埋めるためのもので、
  // 遅らせると出したい数秒に間に合わない。
  return `<img class="gf-shot" src="${view.imagePath}" width="${OGP_IMAGE_WIDTH}" height="${OGP_IMAGE_HEIGHT}" alt="この作品の画面">`;
}

/**
 * 「元ゲーム」の 1 行（3.4-5 の 4 要素の 1 つ / 5.3 / 5.5）。
 *
 * **親が居ても題名を出さないことがある。** 題名はプロンプト由来（`draftTitleFromPrompt`）
 * であり、公開されていない作品のそれを他人へ出す理由が無い（このモジュール冒頭の表と
 * 同じ規則）。tombstone 化された親は 5.3 の言い回しで出す。
 *
 * @param parent 親作品
 * @returns HTML
 */
function parentLine(parent: ParentWork): string {
  switch (parent.kind) {
    case 'none':
      return '元ゲーム: ありません（この作品がオリジナルです）';
    case 'published':
      return `元ゲーム: <a href="${parent.path}">${escapeHtml(parent.title)}</a>`;
    case 'unlisted':
      return '元ゲーム: まだ公開されていない作品から派生';
    case 'removed':
      return '元ゲーム: 削除済みの作品から派生';
  }
}

/**
 * 「改造する」（3.4-5 の 4 要素の 1 つ / 2.2-4 / 5.3 / 4.4）。
 *
 * # 見ている人で 2 つに分かれる
 *
 * | 見ている人 | 出すもの | 根拠 |
 * |---|---|---|
 * | 未ログイン（共有 URL を踏んだ大半） | 登録画面の待機リストへのリンク（`from=fork-cta`） | 2.2-4「未招待: 待機リストへの登録導線に変換する」。10.2 がこの導線の登録率を見る |
 * | ログイン済み（招待された参加者） | **差分プロンプトの入力（`POST /api/fork`）** | 5.3。M5-1（#32）でフォークの生成が入り、ここが本物の導線になった |
 *
 * **未ログイン側は 1 文字も変わっていない**（#30 のまま）。**この導線が 10.2 の
 * 分子への唯一の送り手**であり、綴り（`from=fork-cta`）を変えると受け皿
 * （`src/waitlist.ts` の `WAITLIST_SOURCES`）ごと数えられなくなる。
 *
 * # 作者本人にも出す
 *
 * **「他人の作品だけ」に絞らない。** 5.7 が「公開後に手を入れたい作者はフォークする
 * （自分の作品を親にしても親子関係は正しく引ける）」と明示しており、公開後の作り直しは
 * この口しか無い。**条件は公開済みであることだけ**である（5.3 の対象条件そのもの）。
 *
 * # 行き先の無いボタンにしない（4.4）
 *
 * **本日の枠が尽きていたらフォームを出さない。** 4.4 は「UI に露出させなければ押しても
 * 動かないボタンになる」と書いており、**その裏返しも真である**——押せば `/api/fork` が
 * 429 で断る操作を、押せる形で出さない（{@link reviseSection} と同じ判断）。
 *
 * **それでも「改造する」の見出しと残枠は出したままにする。** 3.4-5 の 4 要素は
 * 「1 つも条件付きにしない」のが {@link loadingScreen} の規則であり、**枠の状態で
 * 要素そのものが消える形にしない。**
 *
 * @param view 表示に必要な値
 * @returns HTML
 */
function forkCta(view: WorkPageView): string {
  if (!view.signedIn) {
    return `<p class="gf-fork"><a class="gf-fork-link" href="${signupPathFrom('fork-cta')}">${FORK_LABEL}</a></p>
<p class="gf-fork-note">改造には招待が必要です。招待コードをお持ちでない方は待機リストにご登録いただけます。</p>`;
  }

  // **枠の文言はこのモジュールで組み立てない**（正本は `src/quota.ts`）。読めなかった
  // ときに画面を落とさないのは {@link readDailyRemaining} の方針である。
  const daily =
    view.dailyRemaining === null
      ? `<p class="gf-fork-note">${QUOTA_UNKNOWN_NOTICE}</p>`
      : `<p class="gf-fork-note">${remainingQuotaNotice(view.dailyRemaining)}</p>`;

  // **id が無ければフォームを描かない。** 公開済みの画面からしか呼ばれないので
  // 通常は非 null だが、**空の `value` を持つフォームを描くくらいなら出さない**
  // （{@link reviseSection} と同じ理由で、含意に寄りかからない）。
  const form =
    view.forkableId === null || view.dailyRemaining === 0
      ? ''
      : `
<form method="post" action="${FORK_PATH}">
  <input type="hidden" name="${FORK_PARENT_ID_FIELD}" value="${view.forkableId}">
  <label for="fork-prompt">どう改造しますか</label>
  <textarea id="fork-prompt" name="${FORK_PROMPT_FIELD}" rows="3"
            maxlength="${MAX_PROMPT_LENGTH}" required
            placeholder="例: 玉の色を赤にして、敵を 2 体に増やす"></textarea>
  <button type="submit">この内容で改造する</button>
</form>`;

  return `<p class="gf-fork">${FORK_LABEL}</p>
<p class="gf-fork-note">どう改造したいかを書くと、このゲームのソースをもとに新しい作品を作ります。
   <strong>1 回につき 1〜2 分かかり、生成枠を 1 回使います。</strong>元の作品はそのまま残ります。</p>
${daily}${form}`;
}

/**
 * ロード中画面の見た目（#30）。
 *
 * **公開済みのときだけ出す。** 他の状態の画面はこの規則を 1 つも使わない。
 *
 * **外部資材を読まない。** ここで web フォントや CSS ファイルを引くと、3.4-5 が
 * 埋めようとしている数秒に、埋めるための資材の待ち時間を足すことになる。
 *
 * 枠の縦横比を撮影の大きさ（`src/ogp.ts`）から取るのは、**スクリーンショットが枠の
 * 予告になる**ようにするためである。別々の比率にすると、読み込みが終わった瞬間に
 * 版面が飛ぶ。
 *
 * @param view 表示に必要な値
 * @returns HTML（公開済みでなければ空文字）
 */
function loadingScreenStyle(view: WorkPageView): string {
  if (!view.published) {
    return '';
  }
  return `
<style>
  .gf-context, .gf-frame { display: block; width: 100%; max-width: ${OGP_IMAGE_WIDTH / 2}px; }
  .gf-shot { width: 100%; height: auto; aspect-ratio: ${OGP_IMAGE_WIDTH} / ${OGP_IMAGE_HEIGHT}; background: #111; }
  .gf-shot-pending { display: flex; align-items: center; justify-content: center; color: #ccc; }
  .gf-frame { aspect-ratio: ${OGP_IMAGE_WIDTH} / ${OGP_IMAGE_HEIGHT}; border: 0; background: #000; }
  .gf-author, .gf-parent, .gf-fork, .gf-fork-note, .gf-forks { margin: 0.4rem 0; }
  .gf-fork-note { font-size: 0.85em; }
</style>`;
}

/**
 * 作品が見つからないときの応答。
 *
 * **理由を分けない。** 「id の形が違う」「行が無い」「他人の作品だ」のどれであっても
 * 404 を返す。分けると、任意の id が存在するかを外から確かめられる手がかりになる
 * （`src/session-user.ts` が失敗の理由を返さないのと同じ考え方）。
 *
 * @returns レスポンス
 */
function notFound(): Response {
  return html(
    `<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>作品が見つかりません - Game Forge</title>
<h1>作品が見つかりません</h1>
<p>URL が正しいかご確認ください。</p>
<p><a href="/">トップへ</a></p>`,
    404,
  );
}

/**
 * 結合して引いた親作品の列を、画面が使う形へ落とす（5.3 / 5.5 / #30）。
 *
 * **`parent_id` ではなく結合結果を見る。** `games.parent_id` に値があっても、結合が
 * 空振りすることはありうる（行が消えた場合）。**そのときは「親が無い」ではなく
 * 「削除済み」に倒す**——`parent_id` が入っている以上、この作品は派生である。
 *
 * @param row 引いた行
 * @returns 画面が使う親作品
 */
export function parentWorkOf(row: {
  readonly parent_ref: string | null;
  readonly parent_status: string | null;
  readonly parent_title: string | null;
}): ParentWork {
  if (row.parent_ref === null) {
    return { kind: 'none' };
  }
  // 行が引けない（消えた）ときも 5.3 の「削除済みの作品から派生」に倒す。
  if (row.parent_status === null || row.parent_status === REMOVED_STATUS) {
    return { kind: 'removed' };
  }
  if (row.parent_status !== PUBLISHED_STATUS || row.parent_title === null) {
    return { kind: 'unlisted' };
  }
  return { kind: 'published', title: row.parent_title, path: workPagePath(row.parent_ref) };
}

/**
 * 作品ページを表示する。
 *
 * @param request 受信したリクエスト
 * @param env バインディングと環境変数
 * @returns レスポンス
 */
async function showWorkPage(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const pathname = url.pathname;
  const gameId = pathname.slice(WORK_PAGE_PREFIX.length);
  if (!GAME_ID_PATTERN.test(gameId)) {
    return notFound();
  }

  // **1 回の問い合わせで引く。** 作者名も親作品も、ロード中画面（3.4-5）が
  // 必ず出す項目である。3 回に分けると、待ち時間を埋めるための画面が、それ自体
  // 3 往復ぶん遅くなる。
  //
  // **`users` は `left join` である。** `author_id` は NOT NULL の外部キーなので
  // 通常は必ず当たるが、当たらなかったときに**ページ全体を 404 にしない**
  // （作者名が引けないことと、作品が無いことは別である）。
  const row = await env.DB.prepare(
    `select g.author_id, g.status, g.title, g.generation_state, g.generation_error,
            g.preview_key, g.created_at, g.generation_started_at,
            g.ogp_state, g.ogp_started_at, g.published_at,
            a.display_name as author_name,
            g.parent_id as parent_ref, p.status as parent_status, p.title as parent_title
       from games g
       left join users a on a.id = g.author_id
       left join games p on p.id = g.parent_id
      where g.id = ?`,
  )
    .bind(gameId)
    .first<WorkRow>();
  if (row === null) {
    return notFound();
  }

  // **セッションは「本人か」を見るためだけに引く。** 未ログインでも 401 にしない
  // （状態は誰でも読める。モジュール冒頭の表）。
  const session = await resolveSessionUser(request, env);
  const owner = session.ok && session.userId === row.author_id;

  const now = Math.floor(Date.now() / 1000);
  const stalled = looksStalled(
    { createdAt: row.created_at, startedAt: row.generation_started_at },
    now,
  );
  const state = viewStateOf(row.generation_state, stalled);

  const published = row.status === PUBLISHED_STATUS;

  // 5.7 の対象条件（自作・`draft`・完成済み）。**経路側と同じ条件をここで作り直して
  // いるように見えるが、判定の正本は `claimRevisionSlot` の SQL である**
  // （`src/revisions.ts`）。ここは「口を出すか」だけを決め、押した結果はあちらが決める。
  const revisableNow = owner && !published && state === 'ready';

  // **作者のときだけ引く。** 公開作品のページは拡散の着地点であり、閲覧者ごとに
  // 版と枠を引く理由が無い（3.6 の読み取りがそのまま費用になる）。
  const revisions = owner ? await listRevisions(env, gameId) : [];
  const revisionQuota = owner ? await revisionStatus(env, gameId) : null;

  // **枠を読むのは、その数を出す口が画面にあるときだけである**（3.6 の読み取りが
  // そのまま費用になる）。口は 2 つある——未公開の作者に出す推敲（5.7）と、公開済みの
  // 作品をログイン済みの誰かに出すフォーク（5.3）である。**後者は作者本人とは限らない**
  // ので、数えるのは行の作者ではなく**見ている人**の枠になる。
  //
  // **見ている人の枠を読む。** `revisableNow` は `owner`（＝ `session.userId` が
  // 作者）を含むので、推敲の場合もこの id は作者の id と同じ値になる。**行の
  // `author_id` を使わない**のは、フォークでは両者が違いうるためで、**同じ変数で
  // 両方を賄えることが「枠は 1 人あたり」（確定25）の裏返し**である。
  const forkableNow = published && session.ok;
  const dailyRemaining =
    session.ok && (revisableNow || forkableNow)
      ? await readDailyRemaining(env, session.userId)
      : null;

  return html(
    renderWorkPage({
      state,
      owner,
      published,
      // **本人か、公開済みのときだけ出す。** 仮タイトルはプロンプト由来である
      // （モジュール冒頭）が、**公開そのものが「これを作品として出す」という
      // 作者の意思表示**である（5.4 は作者を唯一のフィルタとして使う）。
      // 未公開のあいだは、id を知っているだけの相手には見えないままにする。
      title: owner || published ? row.title : null,
      errorCode: owner ? row.generation_error : null,
      // `ready` なら `preview_key` は必ず入っている（`src/games.ts` の不変条件）。
      // それでも null を扱えるようにしてあるのは、**不変条件を画面が前提にしない**ため。
      //
      // **公開後は id で引ける URL（`/g/`）へ切り替える。** プレビュー鍵は公開後も
      // 生きている（`/p/` は `removed` 以外を返す。5.4）が、**配る URL は 1 本でよい。**
      playUrl: published
        ? publishedUrl(request, env, gameId)
        : state === 'ready' && owner && row.preview_key !== null
          ? previewUrl(request, env, row.preview_key)
          : null,
      // 公開の操作を出すのは、**本人・完成済み・未公開**のときだけである。
      // （押せない・押しても何も起きないボタンを出さない。仕様 1.2.38 の #24 と同じ方針）
      publishableId: owner && !published && state === 'ready' ? gameId : null,
      // フォークの親になれるのは**公開済みの作品だけ**である（5.3）。**作者かどうかは
      // 見ない**（5.7 の「公開後に手を入れたい作者はフォークする」）。押した結果を
      // 決めるのは `src/fork.ts` の `readParentSource` で、ここは口を出すかだけを決める。
      forkableId: published ? gameId : null,
      // **要求された URL をそのまま写さない。** 問い合わせ文字列（`?utm_source=` など）が
      // 付いた URL を `og:url` に出すと、同じ作品が別の URL として拡散する。
      // 正規の綴りを組み立て直す。
      shareUrl: published ? new URL(workPagePath(gameId), request.url).toString() : null,
      // **`ready` のときだけ URL を出す。** 撮影中・失敗のときに URL を出すと、
      // クローラが 404 を引く（`src/ogp.ts` の配信は行と実体の両方を見る）。
      imageUrl: published && row.ogp_state === 'ready' ? ogpImageUrl(request, gameId) : null,
      // 画面に貼るほうは同一オリジンの絶対パスでよい（`WorkPageView.imagePath`）。
      // **条件はメタタグと同じものを使う。** 別々に書くと、片方だけが 404 を引く。
      imagePath: published && row.ogp_state === 'ready' ? ogpImagePath(gameId) : null,
      // **公開済みのときだけ出す。** 未公開の作品ページは作者のための状態画面で、
      // そこに作者名を出しても意味が無い（見ているのは本人か、id を知る誰かである）。
      authorName: published ? row.author_name : null,
      parent: parentWorkOf(row),
      // **公開済みのときだけ引く**（3.6 の読み取りがそのまま費用になる）。フォークの
      // 親になれるのは公開済みの作品だけなので（5.3）、未公開の行に公開済みの子は
      // 現れない。**2 回の問い合わせは、子が 1 件も無ければ 1 回で終わる。**
      forks: published ? await forkNeighborsOf(env, gameId, readForksOffset(url)) : NO_FORKS,
      signedIn: session.ok,
      // **走っているあいだは口を出さない。** 二重送信をボタンの無効化ではなく
      // 「フォームが無い」ことで防ぐ（JavaScript を要求しない）。
      revisable:
        revisableNow && revisionQuota !== null && !revisionQuota.running && revisionQuota.remaining > 0,
      dailyRemaining,
      revisionsRemaining: revisionQuota?.remaining ?? null,
      revisionRunning: revisionQuota?.running ?? false,
      revisionError: revisionQuota?.failed ?? null,
      revisions,
      // **撮影が中断したまま残ったときだけ、作者に口を出す**（5.4 / #235）。
      // 期限切れかどうかの判定は `src/ogp.ts` が持つ——ここで `now - x >= 900` と
      // 書くと、掴み直せるかを決める SQL と食い違いうる。
      recapturableId:
        owner &&
        published &&
        ogpCaptureIsStale(
          { state: row.ogp_state, startedAt: row.ogp_started_at, publishedAt: row.published_at },
          now,
        )
          ? gameId
          : null,
    }),
  );
}

/**
 * 「もっと見る」で送られてきた位置を読む（5.5 / #34）。
 *
 * **読めない値は 0 に倒す。** ここへ来るのは URL の問い合わせ文字列で、**誰でも
 * 好きな値を書ける。** 負の値・小数・巨大な値・文字列を `listPublishedForks` へ
 * 渡すと例外になり（`assertLimit`）、**作品ページ全体が 500 になる**——問い合わせ
 * 文字列を 1 つ足すだけで拡散の着地点を落とせることになる。**1 頁目を出すほうが正しい。**
 *
 * 上限を `Number.MAX_SAFE_INTEGER` ではなく置いていないのは、範囲外の位置が
 * 0 件を返すだけで、その先の分岐（`morePath` が null）が正しく働くためである。
 *
 * @param url 要求された URL
 * @returns 読み飛ばす件数（0 以上の安全な整数）
 */
function readForksOffset(url: URL): number {
  const raw = url.searchParams.get(FORKS_OFFSET_PARAM);
  if (raw === null) {
    return 0;
  }
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 0;
}

/**
 * この作品からの改造（子）を引いて、画面が使う形へ落とす（5.5 / M5-3 / #34）。
 *
 * # 件数を先に数える
 *
 * 「N 件」の N は**この頁に並んだ数ではない**（20 件目までしか出さないので、
 * 並んだ数を出すと 21 件目以降が存在しないことになる）。そして**次の頁があるか**も
 * 総数から決まるので、どちらにせよ数は要る。
 *
 * **0 件なら一覧は引かない。** 大半の作品には子が居らず、その場合の問い合わせは
 * 1 回で終わる。
 *
 * # 頁送りのリンクはパスだけを組み立てる
 *
 * **要求された URL を写さない。** 写すと `?utm_source=` のような外から付いた
 * 問い合わせ文字列が頁送りのたびに引き継がれる（`shareUrl` が正規の綴りを
 * 組み立て直しているのと同じ理由）。
 *
 * @param env バインディングと環境変数
 * @param gameId この作品の id（＝子から見た親）
 * @param offset 読み飛ばす件数
 * @returns 画面が使う子作品の一覧
 */
async function forkNeighborsOf(
  env: Env,
  gameId: string,
  offset: number,
): Promise<ForkNeighbors> {
  const total = await countPublishedForks(env, gameId);
  if (total === 0) {
    return NO_FORKS;
  }

  const items = await listPublishedForks(env, gameId, FORKS_PER_PAGE, offset);
  const nextOffset = offset + items.length;
  const previousOffset = Math.max(offset - FORKS_PER_PAGE, 0);

  return {
    total,
    items,
    morePath: nextOffset < total ? forksPagePath(gameId, nextOffset) : null,
    backPath: offset > 0 ? forksPagePath(gameId, previousOffset) : null,
  };
}

/**
 * 頁送りの行き先を組み立てる。
 *
 * @param gameId 作品 id
 * @param offset 読み飛ばす件数（0 なら問い合わせ文字列を付けない）
 * @returns アプリ用ホスト上の絶対パス
 */
function forksPagePath(gameId: string, offset: number): string {
  return offset === 0
    ? workPagePath(gameId)
    : `${workPagePath(gameId)}?${FORKS_OFFSET_PARAM}=${offset}`;
}

/**
 * 4.4 の「本日の残り生成枠 N回」に出す数を読む。
 *
 * **読めなかったら null を返す。** 4.4 は残枠を出せと言うが、**出せないことは作品
 * ページを 500 にしてよい理由ではない**（この画面の本題は作品の状態である）。画面は
 * null を受け取ったら `QUOTA_UNKNOWN_NOTICE` を出す——`src/generate-page.ts` が
 * 同じ状況で選んでいる形と揃える。
 *
 * @param env バインディングと環境変数
 * @param userId 作者
 * @returns 残り回数、読めなければ null
 */
async function readDailyRemaining(env: Env, userId: string): Promise<number | null> {
  try {
    const status = await generationQuotaStatus(env, userId);
    // **止まっているときは 0 を返す。** `available` の `remaining` は必ず 1 以上で、
    // 0 は日次・月次のどちらかで止まった状態を意味する（`src/quota.ts`）。
    //
    // **日次と月次を出し分けない。** 4.4 はそれぞれに別の文言を求めており、その正本は
    // `src/generate-page.ts` の文言表が持っている。ここへ書き写すと**同じ状態に 2 つの
    // 文言**ができ、片方だけが古くなる。この画面が言うべきことは「いまは手直しできない」
    // ことで、**なぜ止まっているかを知る場所は生成画面である**（残枠 0 なら口も出ない）。
    return status.kind === 'available' ? status.remaining : 0;
  } catch (error) {
    console.error(
      `[work-page] 残枠を読めませんでした: ${error instanceof Error ? error.name : typeof error}`,
    );
    return null;
  }
}

/**
 * 作品ページの経路（#150）。
 *
 * **前方一致で登録する。** `/works/<game_id>` の id は 1 件ごとに違うので、完全一致の
 * 表では表現できない。`src/routes.ts` に `match: 'prefix'` を足したのはこのためで、
 * **既定は完全一致のままなので既存の経路は 1 つも影響を受けない。**
 */
export const workPageRoutes: readonly Route[] = [
  { method: 'GET', path: WORK_PAGE_PREFIX, match: 'prefix', handler: showWorkPage },
];
