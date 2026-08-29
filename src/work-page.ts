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
import type { GenerationErrorCode, GenerationState } from './games.js';
import type { Route } from './routes.js';
import { html } from './routes.js';
import { resolveSessionUser } from './session-user.js';
// `escapeHtml` の正本は `src/signup.ts` である（`src/invite-issuance.ts` も
// そこから取っている）。同じ関数をこのモジュールで作り直さない。
import { escapeHtml } from './signup.js';

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
 * 生成が Worker の中で同期に走っているか（#150）。**暫定の値である。**
 *
 * # なぜ画面がこれを知る必要があるのか
 *
 * #150 の狙いは「タブを閉じてよくすること」だが、**この PR ではまだそうなっていない。**
 * `GenerationPipeline.startJob` の既定は `runJobInline`（Worker の中で同期に走らせる）
 * なので、**いまタブを閉じると生成は死ぬ。** 恒久的な URL と作品行は先に存在するように
 * なったが、待ち時間そのものは 1 秒も縮んでいない。
 *
 * したがって画面は「開いたままにしてください」と言わなければならない。
 * **できていないことを、できているように書かない**（`src/home.ts` と同じ方針）。
 *
 * # 差し替えたときに、この 1 行を変え忘れないようにする
 *
 * オーケストレータ Lambda（別 issue）が入って `startJob` が非同期実装へ差し替わると、
 * **この定数は `false` にしなければならない。** 忘れると画面が嘘をつく——今度は
 * 「開いたままにしてください」という不要な制約として。
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
 * `false` にしたときに「常に真」の比較として警告されないようにしている。
 */
export const GENERATION_IS_SYNCHRONOUS: boolean = true;


/** 表示に使う `games` の 1 行。 */
interface WorkRow {
  author_id: string;
  title: string;
  generation_state: string;
  generation_error: string | null;
  preview_key: string | null;
  created_at: number;
  generation_started_at: number | null;
}

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
  /** 仮タイトル（プロンプト由来）。本人でなければ null。 */
  readonly title: string | null;
  /** 失敗の分類名。本人でなければ null。 */
  readonly errorCode: string | null;
  /** 完成しているときの試遊 URL。 */
  readonly playUrl: string | null;
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
  const refresh =
    view.state === 'working' || view.state === 'stalled'
      ? `\n<meta http-equiv="refresh" content="${REFRESH_SECONDS}">`
      : '';

  const title = view.title === null ? '' : `<p>お題: ${escapeHtml(view.title)}</p>`;

  return `<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">${refresh}
<meta name="robots" content="noindex">
<title>作品 - Game Forge</title>
<h1>作品</h1>
${sectionFor(view)}
${title}
<p><a href="/">トップへ</a></p>`;
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
      // **文言は `GENERATION_IS_SYNCHRONOUS` が決める。** いまは同期実行なので
      // 「開いたままにしてください」が正しい。差し替えの手順はあの定数の注記にある。
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
      return `<h2>できました</h2>
${
  view.playUrl === null
    ? '<p>作品は完成していますが、試遊 URL を組み立てられませんでした。</p>'
    : `<p><a href="${view.playUrl}">この作品を遊ぶ</a></p>
<p>この URL は<strong>あなただけが知っている URL</strong> です（まだ公開されていません）。</p>`
}`;
    case 'failed':
      return `<h2>生成できませんでした</h2>
<p>${view.owner ? escapeHtml(failureMessageOf(view.errorCode)) : escapeHtml(UNKNOWN_FAILURE_MESSAGE)}</p>`;
    case 'unknown':
      return `<h2>状態を読み取れませんでした</h2>
<p>この作品の状態が想定外の値になっています。時間をおいてもう一度お試しください。</p>`;
  }
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
 * 作品ページを表示する。
 *
 * @param request 受信したリクエスト
 * @param env バインディングと環境変数
 * @returns レスポンス
 */
async function showWorkPage(request: Request, env: Env): Promise<Response> {
  const pathname = new URL(request.url).pathname;
  const gameId = pathname.slice(WORK_PAGE_PREFIX.length);
  if (!GAME_ID_PATTERN.test(gameId)) {
    return notFound();
  }

  const row = await env.DB.prepare(
    `select author_id, title, generation_state, generation_error, preview_key,
            created_at, generation_started_at
       from games where id = ?`,
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

  return html(
    renderWorkPage({
      state,
      owner,
      // **本人にだけ出す。** 仮タイトルはプロンプト由来である（モジュール冒頭）。
      title: owner ? row.title : null,
      errorCode: owner ? row.generation_error : null,
      // `ready` なら `preview_key` は必ず入っている（`src/games.ts` の不変条件）。
      // それでも null を扱えるようにしてあるのは、**不変条件を画面が前提にしない**ため。
      playUrl:
        state === 'ready' && row.preview_key !== null
          ? previewUrl(request, env, row.preview_key)
          : null,
    }),
  );
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
