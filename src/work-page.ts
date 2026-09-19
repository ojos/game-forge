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
 * > **#377 注記。公開済みの作品ページには、プレイ数を数える小さなスクリプトが入る**
 * > （`src/plays.ts` の `playReportScript`。iframe の直前——合図より先にリスナーを登録する）。**「要求しない」は崩していない**
 * > ——スクリプトは画面を 1 文字も書き換えず、JS を切っても遊べる（数えられないだけである）。
 * > 起動を知っているのは iframe の中のローダーだけで、それを受けられるのがこの画面だけなので、
 * > ここに置く（理由の全文は `src/plays.ts` の冒頭）。
 *
 * > **#502 注記。公開済みの作品ページの iframe はスクリプトが作る**（`src/work-play.ts`。仕様 3.9.4）。タッチ端末では
 * > 開いた時点でゲームを読み込まず、スクリーンショットのタップで全画面の覆いを開くためである。**「要求しない」は崩していない**
 * > ——JavaScript を切ると `<noscript>` の中の今の埋め込みで遊べる。4 要素はスクリプトより前にあり、スクリプトは 4 要素を書き換えない。
 * > **#575 から、公開前の作品ページ（作者本人の「できました」）も同じ埋め込みを使う**（`/p/` の URL。計上のスクリプトは置かない）。
 *
 * ## 応答本文の文字列を表示面へ持ち込まない（8.3）
 *
 * 出すのは**このモジュールが持つ固定の文言**と、D1 から読んだ値のうち
 * **利用者自身の入力（仮タイトル、公開後は作者の説明。#388）だけ**である。`generation_error` は固定語彙の
 * 分類名で、**値そのものは出さない**（どの固定文言を出すかの鍵として使う）。
 */
import { siteFooter } from './legal.js';
import type {
  DescribeRejection,
  ForkChild,
  GenerationState,
  RenameRejection,
  RetagRejection,
} from './games.js';
import {
  DESCRIPTION_CHANGE_INTERVAL_SECONDS,
  MAX_DESCRIPTION_LENGTH,
  MAX_TITLE_LENGTH,
  WORK_TAGS_CHANGE_INTERVAL_SECONDS,
  countPublishedForks,
  describeGame,
  listPublishedForks,
  PUBLISHED_STATUS,
  REMOVED_STATUS,
  unpublishGame,
  renameGame,
  retagGame,
  STALE_AFTER_SECONDS,
  workTagsOf,
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
  RESTORE_PATH,
  REVISE_GAME_ID_FIELD,
  REVISE_PATH,
  REVISE_PROMPT_FIELD,
  REVISE_SEQ_FIELD,
  WORK_PAGE_PREFIX,
  workPagePath,
} from './paths.js';
import { UNKNOWN_AUTHOR, knownWorkTags, workTagListPath } from './work-card.js';
import { MAX_WORK_TAGS, WORK_TAGS, WORK_TAG_FIELD } from './work-tags.js';
import { authorPagePathFor } from './users-page-paths.js';
import { authorHandleColumnSql } from './handle-sql.js';
import {
  LIKE_CANCEL_GAME_ID_FIELD,
  LIKE_CANCEL_PATH,
  LIKE_GAME_ID_FIELD,
  LIKE_PATH,
} from './like-paths.js';
// **いいねの読み書きは窓口だけを通す**（5.8）。この画面が触れるのは
// {@link isPressableGame}（D1 の読み取り）と {@link readLikeViewerState}（DO の読み取り）の
// 2 つで、どちらも窓口（`src/likes.ts`）が輸出しているものである。**DO のバインディングの
// 綴りはこの画面に現れない**（`scripts/check-likes-worker.sh` の 4 番がそれを機械で見る）。
import { isPressableGame, readLikeViewerState } from './likes.js';
// **プレイ数は窓口のスクリプトを埋めるだけである**（#377）。数えるのは作品ページのブラウザで、
// この画面の経路は DO を呼ばない。
import { playReportScript } from './plays.js';
// **ゲームの iframe と、タッチ端末の全画面の覆い**（M14-3 / #502 / 仕様 3.9.4）。iframe の属性の出どころはあちらの 1 か所である。
import type { PlayOrientation } from './work-play.js';
import { playEmbed, playEntry, playOrientationOf } from './work-play.js';
import { keyLegendOf, readAliasGroups, readHeldCodes, readInputKeyCodes } from './virtual-pad.js';
// **ソースの閲覧は別の経路である**（#383 / 2.3.12）。この画面が借りるのは綴りだけで、R2 は読まない。
import { workSourcePath } from './work-source.js';
// **作者の削除（#517 / M15-2）。** 綴り・表示の条件・確認画面・断りの文言はあちら、経路はこのモジュールが持つ
// （あちらはこのモジュールを import しない）。削除の本体は `src/game-deletion.ts` の `deleteGame` で、作者の検査と合わせて
// `src/work-delete.ts` の `deleteAuthoredGame` から呼ぶ（一括の口と共有する。#666）。
import type { DeleteRefusal, DeletionTargetRow } from './work-delete.js';
import {
  DELETE_REFUSALS,
  DELETION_TARGET_SQL,
  WORK_DELETED_REDIRECT,
  WORK_DELETE_GAME_ID_FIELD,
  WORK_DELETE_PATH,
  WORK_DELETE_SUFFIX,
  deleteAuthoredGame,
  deletionBlockOf,
  deletionStateOf,
  renderDeleteConfirmation,
  renderDeleteRefusal,
  workDeletePath,
} from './work-delete.js';
import { formatJstMinutes, toIsoTimestamp } from './jst.js';
// **エディットページ（#664）の綴りは Lambda が import しない葉から取る**（`src/paths.ts` に置かない理由はあちらの冒頭）。
import { WORK_EDIT_SUFFIX, workEditPath } from './work-edit-paths.js';
// **関連作品（#665）。** 引く SQL と並びの正本はあちらにある。
import type { RelatedWork } from './related-works.js';
import { listRelatedWorks } from './related-works.js';
import { avatarUrl, sandboxOriginOf } from './avatar-paths.js';
import { UNKNOWN_FAILURE_MESSAGE, failureMessageOf } from './generation-failure.js';
import { LOGIN_PATH, loginRequiredRedirect } from './auth/google.js';
import { MAX_PROMPT_LENGTH } from './generate.js';
// **値を読むだけである**（#402）。`src/build-retry.ts` はオーケストレータの束に入っており、
// 書き換えると束が変わって配り直すまで配備が止まる。ここは定数を import するだけにする。
import { MAX_GENERATION_ATTEMPTS } from './build-retry.js';
import {
  generationQuotaStatus,
  QUOTA_UNKNOWN_NOTICE,
  remainingQuotaNotice,
} from './quota.js';
import type { Revision } from './revisions.js';
import { listRevisions, revisionStatus } from './revisions.js';
import type { Route } from './routes.js';
import { html, json, readLimitedText } from './routes.js';
import { parseIpNotice } from './ip-substitution.js';
import { MODERATION_CATEGORY_SEPARATOR } from './input-moderation.js';
import { MAX_REASON_LENGTH, hasReported, recordReport, reviewVisibleSql } from './reports.js';
import type { ReportRejection } from './reports.js';
import { resolveSessionUser } from './session-user.js';
// `escapeHtml` の正本は `src/signup.ts` である（`src/invite-issuance.ts` も
// そこから取っている）。同じ関数をこのモジュールで作り直さない。
import {  signupPathFrom } from './signup.js';
import type { SiteViewer } from './html.js';
import {
  avatarImage,
  escapeHtml,
  headerAvatarUrl,
  resolveSiteViewer,
  siteHead,
  siteViewerAt,
} from './html.js';

/**
 * 作品ページの接頭辞とパスの組み立て。
 *
 * **正本は `src/paths.ts` である**（#290 で移した。理由はあちら）。ここから再輸出するのは、
 * 既にこのモジュールから読んでいる箇所を動かさないためで、値を二重に持っているわけではない。
 */
export { WORK_PAGE_PREFIX, workPagePath };

/**
 * 公開をやめる操作（`published → draft`。5.4 の「公開をやめて下書きへ戻せる」 / 確定35 / #637）。
 *
 * # なぜ `src/paths.ts` に置かないのか
 *
 * あちらの規約は「**提供する側と、そこへ送り返す側が別モジュールになるもの**だけ」
 * である（`src/paths.ts` 冒頭）。この経路はフォームも受け口も**このモジュールが
 * 持つ**ので、循環参照が起きる余地が無い。`HOME_PATH` / `GENERATE_PATH` と同じ扱い。
 *
 * # なぜ作品ページに置くのか
 *
 * 公開をやめるのは**その作品の状態を動かす操作**であり、押す場所も戻る場所も作品ページ
 * である。`src/publish.ts` が公開のために別モジュールを持っているのは、あちらが
 * **OGP の撮影という別の副作用**を起動するためで、こちらには無い。
 */
export const WORK_UNPUBLISH_PATH = '/api/works/unpublish';

/** 公開をやめる対象を指す項目名（フォームの `name` と JSON の鍵の両方）。 */
export const WORK_UNPUBLISH_GAME_ID_FIELD = 'game_id';

/**
 * 通報の受け口（8.4 / #40）。
 *
 * **公開をやめる口（{@link WORK_UNPUBLISH_PATH}）と別の経路にする。** あちらは作者が自分の
 * 作品に対して行い、通報は他者が行う。**同じ口にすると、誰の意思なのかが本文の中身
 * でしか分からなくなる。**
 */
export const WORK_REPORT_PATH = '/api/works/report';

/**
 * 通報の口（`<details>`）の `id`（#665）。**「…」メニューの「この作品を通報する」がここへ飛ぶ。**
 *
 * **綴りを 1 か所に持つ**（飛ばす側と着地する側へ書き写すと、片方だけを直した日に押しても何も起きないリンクになる。4.4）。
 */
export const WORK_REPORT_ANCHOR = 'report';

/** 通報の対象を指す項目名。 */
export const WORK_REPORT_GAME_ID_FIELD = 'game_id';

/** 通報の理由を載せる項目名。 */
export const WORK_REPORT_REASON_FIELD = 'reason';

/**
 * 題名を変える口（5.4 / #366）。
 *
 * **{@link WORK_UNPUBLISH_PATH} と同じ理由で `src/paths.ts` に置かない**——フォームも
 * 受け口もこのモジュールが持つので、循環参照が起きる余地が無い。
 *
 * **`/api/publish` に畳まない。** 5.4 は公開の主ボタンを 1 タップに畳むと定めており、
 * 公開時に題名を入力させない。**畳むと、公開の本文に題名が載りうる形**になり、その
 * 決定が実装の上で曖昧になる。改名は公開の前でも後でも押せる、別の操作である。
 */
export const WORK_RENAME_PATH = '/api/works/rename';

/** 改名の対象を指す項目名（フォームの `name` と JSON の鍵の両方）。 */
export const WORK_RENAME_GAME_ID_FIELD = 'game_id';

/** 新しい題名を載せる項目名。 */
export const WORK_RENAME_TITLE_FIELD = 'title';

/**
 * 作品の説明を書く口（#388）。
 *
 * **{@link WORK_RENAME_PATH} と同じ理由で `src/paths.ts` に置かない**——フォームも受け口も
 * このモジュールが持つ（しかも `src/paths.ts` はオーケストレータの束に入る。#328 / #336）。
 *
 * **改名の口に畳まない。** 題名と説明は正規化の規則が違い（題名は切る・説明は断る）、
 * 書ける作品も違う（題名は公開の前後を問わない・説明は公開後だけ）。**1 つの口にすると、
 * 片方の項目だけを送った要求の意味が本文の中身でしか決まらなくなる**（通報と取り下げを
 * 分けたのと同じ理由）。
 */
export const WORK_DESCRIBE_PATH = '/api/works/describe';

/** 説明を書く対象を指す項目名（フォームの `name` と JSON の鍵の両方）。 */
export const WORK_DESCRIBE_GAME_ID_FIELD = 'game_id';

/** 説明の本文を載せる項目名。 */
export const WORK_DESCRIBE_TEXT_FIELD = 'description';

/**
 * 公開後にタグを付け直す口（#376）。
 *
 * **{@link WORK_RENAME_PATH} と同じ理由で `src/paths.ts` に置かない**——フォームも受け口も
 * このモジュールが持つ（しかも `src/paths.ts` はオーケストレータの束に入る。#336）。
 *
 * **公開（`/api/publish`）にも説明の口にも畳まない。** 公開の口に畳むと「公開済みの作品へ
 * 公開を押し直すとタグが変わる」ことになり、二度押しでタグを上書きしないという公開の性質
 * （`src/publish.ts`）が崩れる。説明の口とは検査の規則も書く列も違う（通報と取り下げを分けた
 * のと同じ理由）。
 *
 * タグの値の項目名は公開フォームと同じ `WORK_TAG_FIELD`（`src/work-tags.ts`）である。
 */
export const WORK_RETAG_PATH = '/api/works/retag';

/** 付け直しの対象を指す項目名（フォームの `name` と JSON の鍵の両方）。 */
export const WORK_RETAG_GAME_ID_FIELD = 'game_id';

/**
 * `games.id` の綴り（`crypto.randomUUID()` が返す形）。
 *
 * **経路の入口で形を確かめる。** 確かめずに SQL のプレースホルダへ渡しても injection には
 * ならないが、`/works/../../etc` のような綴りが「作品が見つかりません」ではなく
 * D1 への問い合わせとして通ることになる。**引く前に落とすほうが安い**
 * （`src/sandbox-delivery.ts` の `GAME_ID_PATTERN` と同じ方針）。
 */
export const GAME_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

/**
 * 生成中の行を「止まっているかもしれない」と見なすまでの秒数（{@link looksStalled}）。
 *
 * **正本は `src/games.ts` にある**（#455）。進行中の要求の判定（`inFlightGuardSql`）も
 * 同じ区切りを読み、そちらはオーケストレータの束に入る `src/generate.ts` から呼ばれる。
 * 束は画面を import できない（`scripts/check-orchestrator-bundle.sh`）ので、束に入って
 * よい側へ正本を移し、ここは既存の import（`test/my-works.test.ts` など）のために
 * 再 export する。**値の根拠（829 < 870 < 900）も `src/games.ts` 側にある。**
 */
export { STALE_AFTER_SECONDS } from './games.js';

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
export interface WorkRow {
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
  /**
   * 作者が書いた説明（`games.description`。`migrations/0028_game_descriptions.sql`）。
   *
   * 列は `NOT NULL DEFAULT ''` だが、**型の上で必須であることは実行時の保証ではない**
   * （`like_count` と同じ扱い）。空文字と null はどちらも「説明なし」として読む。
   */
  description: string | null;
  /**
   * タグの枠（`games.tag1` / `tag2` / `tag3`。`migrations/` の `games_tags`。#376）。NULL はタグ無し。
   *
   * **語彙に照らして描くのは画面の側**（`src/work-card.ts` の `knownWorkTags`）で、ここは値を運ぶだけ。
   */
  tag1: string | null;
  tag2: string | null;
  tag3: string | null;
  /**
   * いいねの数（`games.like_count`。`migrations/0020_games_like_count.sql`）。
   *
   * **正本は Durable Objects にある**（5.8）。この列は DO のアラームが 5 分おきに
   * 上書きした写しで、**最大 5 分遅れる。** **未ログインの閲覧ではこの列を読む**
   * ——閲覧数で DO の枠を減らさない（5.8「数の読み方と同期」）。
   *
   * 列は `NOT NULL DEFAULT 0` だが、**型の上で必須であることは実行時の保証ではない**
   * （1.2.50 / #340）。読み方は {@link storedLikeCount} が 1 か所で持つ。
   */
  like_count: number | null;
  /**
   * プレイ数（`games.play_count`。`migrations/` の `games_play_count`。#377）。
   *
   * **正本は Durable Objects（`PlayHub`）にあり**、この列は 5 分おきに上書きした写しである。
   * **ログイン中も含めて、画面はこの列だけを読む**（いいねと違い、ログイン中に DO を引いて
   * 正確な数を出す理由が無い——押す操作が無い）。読み方は {@link storedLikeCount} を借りる。
   */
  play_count: number | null;
  /** 作者の表示名（`users.display_name`）。結合が空振りしたら null。 */
  author_name: string | null;
  /**
   * 作者が運営か（`users.is_operator`。`migrations/0021_users_operator.sql`）。
   *
   * 列は `NOT NULL` で 0 か 1 だが、**結合が空振りしたら null になる**（`left join`）。
   */
  author_is_operator: number | null;
  /** 作者がいま使っているハンドル名（`handles`。決めていなければ null。#381）。 */
  author_handle: string | null;
  /**
   * 作者のアイコンの版（`users.avatar_set_at`。アイコンが無ければ null。#380 / #665）。**`avatar_sha256` が無ければ使わない**
   * （外した後も時刻は進む。`src/users-page.ts` と同じ読み方）。
   */
  author_avatar_set_at: number | null;
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
  /**
   * 6.2 の開示（`migrations/0015_games_ip_notice.sql`）。
   *
   * **null は「当たらなかった」である。** 0015 より前に作られた行もすべて null に
   * なるが、そちらは「調べていない」——遡って判定する材料がもう無い。
   * **画面はどちらも「開示を出さない」に倒す**（無いことを断言しない）。
   */
  ip_notice: string | null;
  /**
   * 8.4 の審査で新規露出を止めていないか（`reviewVisibleSql` の真偽。#383）。
   *
   * **ソースへのリンクを出すかだけに使う。** 作品ページそのものは審査中も開ける
   * （止めるのは新規露出であって、既に共有された URL ではない）が、ソースの閲覧
   * （`src/work-source.ts`）は同じ条件で 404 にするので、押せば必ず 404 になるリンクを出さない。
   */
  review_visible: number | null;
  /**
   * `games.source_key` が入っているか（#383）。**キーそのものは選ばない**——内部の識別子で
   * あり（2.3.12）、選ばなければ画面の側で書き間違えても漏れようがない（`users.email` を
   * 選ばないのと同じ理由）。
   */
  has_source: number | null;
  /**
   * 作者の削除・退会で中身を消した tombstone か（`games.purged_at` が入っているか。#516 / #517）。
   * **時刻そのものは選ばない**（画面が要るのは真偽だけである）。
   */
  purged: number | null;
  /**
   * 配信している Wasm（`.wasm.br`）のバイト数（`build_cache.compressed_bytes`。#383）。
   * 索引の行が引けなければ null（{@link WORK_ROW_SQL} の結合）。
   */
  wasm_bytes: number | null;
  /**
   * 作品のソースが読むキーの集合（`source_input_keys.codes`。JSON 配列の文字列。仕様 3.9.5 / #494）。
   *
   * **主キー（`source_key`）で 1 行だけ結合する。** 行が無い・`games.source_key` が NULL（tombstone）なら null。
   * **この値をそのまま使わない**——`src/virtual-pad.ts` の `readInputKeyCodes` が許可表で絞る（D1 の値を信じ切らない）。
   */
  input_codes: string | null;
  /**
   * 作品のソースが押し続けて読むキーの集合（`source_input_keys.held_codes`。JSON 配列の文字列。仕様 3.9.6 の #528 / #530）。
   *
   * **`input_codes` と同じ 1 行から読む**（結合を増やさない）。版 1 の行・行が無い・`games.source_key` が NULL なら null。
   * **この値をそのまま使わない**——`src/virtual-pad.ts` の `readHeldCodes` が許可表で絞り、壊れた値は null（版 1）に倒す。
   */
  input_held_codes: string | null;
  /**
   * 作品のソースが同じ条件式で読むキーの組（`source_input_keys.alias_groups`。組の JSON 配列の文字列。仕様 3.9.6 の #543）。
   *
   * **`input_codes` と同じ 1 行から読む**（結合を増やさない）。版 2 以下の行・行が無い・`games.source_key` が NULL なら null。
   * **この値をそのまま使わない**——`src/virtual-pad.ts` の `readAliasGroups` が許可表で絞り、壊れた値は null（未記録）に倒す。
   */
  input_alias_groups: string | null;
  /**
   * 作品の論理解像度の幅と高さ（`source_input_keys.layout_width` / `layout_height`。仕様 3.9.4 の #514）。
   *
   * **`input_codes` と同じ 1 行から読む**（結合を増やさない）。版 3 以下の行（まだ拾っていない）・版 4 で拾えなかった行・行が無い・
   * `games.source_key` が NULL なら null。**この値をそのまま使わない**——`src/work-play.ts` の `playOrientationOf` が
   * 正の整数の組だけを向きにし、それ以外は「向きの操作をしない」に倒す。
   */
  input_layout_width: number | null;
  input_layout_height: number | null;
}

/**
 * ビルドの成果物の R2 キーの接頭辞（#383）。**綴りの正本はビルド関数である**
 * （`docker/isolated-build/handler/r2.go` の `builds/<source_sha256>/...`。#21 が持つ）。
 *
 * **ここでは索引（`build_cache`）を主キーで引くための手がかりにだけ使う。** `games` は
 * キャッシュ鍵（ソースの SHA-256）を持たない（5.1。`src/build-cache.ts` の
 * `takeBuildCacheByArtifact`）ので、キーから鍵を切り出す。**正しさは切り出しに頼らない**
 * ——結合の条件に `b.wasm_key = g.wasm_key` を必ず添えるので、綴りが変わった日には
 * 結合が空振りし、「サイズを出さない」に倒れる（誤ったサイズは出ない）。
 */
const BUILD_KEY_PREFIX = 'builds/';

/**
 * 作品ページの 1 行を引く SQL（{@link WorkRow}）。
 *
 * **1 回の問い合わせで引く**（{@link showWorkPage} の説明）。#383 で `build_cache` を
 * 結合した——**主キー（`source_sha256`）で 1 行だけ引く**（R2 に `head` を打たない。
 * `games` に列を足さない）。`wasm_key` 側に索引は無いので、`b.wasm_key = g.wasm_key` だけで
 * 結合すると索引の全行を読む。主キーで引けていることは `test/work-page.test.ts` が
 * クエリプランで確かめる（export はそのため）。
 */
export const WORK_ROW_SQL = `select g.author_id, g.status, g.title, g.generation_state, g.generation_error,
            g.preview_key, g.created_at, g.generation_started_at,
            g.ogp_state, g.ogp_started_at, g.published_at, g.like_count, g.play_count, g.ip_notice,
            g.description, g.tag1, g.tag2, g.tag3,
            (${reviewVisibleSql('g')}) as review_visible,
            (g.source_key is not null) as has_source,
            (g.purged_at is not null) as purged,
            b.compressed_bytes as wasm_bytes,
            k.codes as input_codes,
            k.held_codes as input_held_codes,
            k.alias_groups as input_alias_groups,
            k.layout_width as input_layout_width,
            k.layout_height as input_layout_height,
            a.display_name as author_name, a.is_operator as author_is_operator,
            case when a.avatar_sha256 is null then null else a.avatar_set_at end as author_avatar_set_at,
            ${authorHandleColumnSql('g.author_id')},
            g.parent_id as parent_ref, p.status as parent_status, p.title as parent_title
       from games g
       left join users a on a.id = g.author_id
       left join games p on p.id = g.parent_id
       left join build_cache b
              on b.source_sha256 = substr(g.wasm_key, ${BUILD_KEY_PREFIX.length + 1}, 64)
             and b.wasm_key = g.wasm_key
       left join source_input_keys k on k.source_key = g.source_key
      where g.id = ?`;

/**
 * 詳細情報パネルに出す値のうち、{@link WorkPageView} の他の項目から取れないもの（2.3.12 / #383）。
 *
 * **改造された数・いいね数・プレイ数・元ゲームは持たない。** それぞれ `forks.total`（その場で
 * 数えた実件数。5.5）・`likeCount`・`playCount`・`parent` を画面の他の場所と同じ値で使う
 * ——**同じ数を 2 か所で別々に持つと、片方だけが古くなる。**
 *
 * **出さないもの**（2.3.12）: モデル名（確定27 で作品から辿れない）・R2 のキー・ビルドの
 * ジョブ ID・SHA-256。**型に置き場所を作らない。**
 */
export interface WorkDetails {
  /** 作品 ID（`games.id`。公開識別子である）。 */
  readonly gameId: string;
  /** 生成日時（`games.created_at`。UNIX 秒）。 */
  readonly createdAt: number;
  /** 公開日時（`games.published_at`。UNIX 秒）。読めなければ null。 */
  readonly publishedAt: number | null;
  /** 配信している Wasm の圧縮後のバイト数。索引が引けなければ null（行ごと出さない）。 */
  readonly wasmBytes: number | null;
  /**
   * ソースの閲覧のパス（`/source/<id>`）。出さないなら null。
   *
   * **条件は `src/work-source.ts` の SQL と同じ**（公開済み・審査で止めていない）に、
   * キーがあることを足したもの。**画面でこの条件を組み立てない**（`revisable` と同じ方針）。
   */
  readonly sourcePath: string | null;
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
 * 自動更新の間隔（秒）。
 *
 * **5 秒。** 生成中のあいだだけ付ける。1 回の再読み込みで増えるのは D1 の読み取り
 * 1 件で、単価は書き込みの 1/1000 である（3.6）。生成は 1 日 10 回までなので
 * （確定25）、無料枠に響く量にならない。
 *
 * **#284 で 1 生成あたりのポーリング回数は約 3 倍になった**（生成が 91 → 297 秒。
 * 19 → 約 60 回、最悪ケースの 870 秒なら約 174 回）。それでも 1 人 1 日で
 * 約 600 読み取りにとどまり、**D1 の無料枠（1 日 500 万読み取り）に対して桁が
 * 4 つ違う。** 結論は変わらないが、**次に生成の秒数を伸ばすときはこの間隔も見直すこと。**
 */
export const REFRESH_SECONDS = 5;

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

/** 画面を組み立てるのに必要なものだけを集めた入力。 */
export interface WorkPageView {
  readonly state: ViewState;
  /** 作者本人が見ているか。**本人にだけ出す項目の門番である。** */
  readonly owner: boolean;
  /**
   * 入力に含まれていた著名 IP 名の正式名（6.2 / #39）。当たらなければ空配列。
   *
   * **作者にしか渡さない。** 開示はプロンプトを書いた本人へのものであり、
   * 公開ページへ商標を並べる理由が無い（6.2 の命名規制は生成物の話だが、
   * **こちらから増やす理由も無い**）。門番は {@link owner} である。
   */
  readonly ipNotice: readonly string[];
  /**
   * 入力側モデレーションが挙げたカテゴリ名（8.2 / #37）。遮断されていなければ空配列。
   *
   * **検出箇所・スコア・閾値は入らない。** 8.2 が返す粒度をカテゴリ名までに決めている
   * ——ゲームという題材上、正当な題材が暴力フィルタに当たることが現実的な頻度で起きる
   * ので**分類が分かれば言い直せる**必要がある一方、検出箇所まで返すと回避の手がかりに
   * なる。
   *
   * **作者にしか渡さない**（{@link ipNotice} と同じ扱い）。
   */
  readonly blockedCategories: readonly string[];
  /**
   * 通報できる作品の id（8.4 / #40）。できないなら null。
   *
   * **出す条件は「公開済み・ログイン済み・作者でない・まだ通報していない」。**
   * 押しても必ず断られるボタンを出さない（`src/invite-issuance.ts` が枠 0 のときに
   * フォームを出さないのと同じ判断——**利用者から見て「壊れている」ことと「できない」
   * ことの区別がつかなくなる**）。
   */
  readonly reportableId: string | null;
  /** 既に通報済みか。**押せない理由を示すために出す**（黙って消さない）。 */
  readonly alreadyReported: boolean;
  /**
   * 公開済みか（5.4）。**この 1 つが画面の性格を変える。**
   *
   * 未公開なら作者のための状態画面（`noindex`・本人にしか中身を出さない）、
   * 公開済みなら**共有される URL の着地点**（OGP のメタタグを持ち、タイトルを誰にでも
   * 出す）になる。
   */
  readonly published: boolean;
  /**
   * 取り下げられているか（tombstone。5.3 / M5-4 / #35）。
   *
   * **`published` の否定ではない。** `draft`（まだ公開していない）と `removed`
   * （公開したが取り下げた）は、作者にできることが正反対である——前者には
   * 「公開して共有」の口が出るが、**後者に出してはいけない**（押せば
   * `publishGame` が `removed` で断る）。1 つの真偽で表すと、その区別が消える。
   */
  readonly removed: boolean;
  /**
   * 作者の削除・退会で中身を消した tombstone か（`games.purged_at`。#516 / #517）。**`removed` の内側の区別である**
   * （中身を消した行は必ず `removed`）。取り下げ済みの表示のまま、作者本人に出す文だけを変える（{@link removedSection}）。
   *
   * **省略可にする**（描画を直接呼ぶテストが、削除に関係しない検査で値を用意しなくて済む。`authorHandle` と同じ）。
   */
  readonly purged?: boolean;
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
  /**
   * 作品が読むキーの集合（**許可表で絞った値**。仕様 3.9.5 / 3.9.6 / #494）。タッチ端末の覆いに出す仮想パッドの中身を決める。
   *
   * 読めなければ空で、パッドは出ない。**遊ぶ URL が無い画面では使わない**（覆いそのものが無い）。
   */
  readonly inputKeyCodes: readonly string[];
  /**
   * 作品が押し続けて読むキーの集合（**許可表で絞った値**。仕様 3.9.6 の #528 / #530）。仮想パッドの最初の形（スティック / 十字）を決める。
   *
   * **null は「読み方がまだ無い」（版 1 の行）で、十字で出す**（規則 6）。`[]` は「押し続けて読むキーは無い」（これも十字）。
   */
  readonly inputHeldCodes: readonly string[] | null;
  /**
   * 作品が同じ条件式で読むキーの組（**許可表で絞った値**。仕様 3.9.6 の #543）。スティックで右のボタンに回す方向のうち、
   * すでにボタンに出るキー（Space・Z・X）と同じ組にある方向を出さないために使う。
   *
   * **null は「組がまだ記録されていない」（版 2 以下の行）で、今の規則 5 のまま方向をボタンに回す。**
   */
  readonly inputAliasGroups: readonly (readonly string[])[] | null;
  /**
   * 作品のおすすめの向き（仕様 3.9.4 の #514）。論理解像度が横長なら `landscape`、縦長なら `portrait`。
   *
   * **null は向きの操作をしない**（正方形・解像度が分からない・版 3 以下の行）。タッチ端末の覆いで、固定する向きと案内を決める。
   */
  readonly playOrientation: PlayOrientation | null;
  /**
   * 作品 id（`games.id`）。タッチ端末の覆いで、遊ぶ人が切り替えた形を作品ごとに覚えるキーに使う（#530。ブラウザの外へは送らない）。
   */
  readonly workId: string;
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
   * 下の {@link watchSection} を参照）。
   */
  readonly authorName: string | null;
  /**
   * 作者ページ（`/users/<user_id>`）へ送るための `users.id`（#330 / 仕様 2.3.1）。
   *
   * **{@link authorName} が入っているときだけ入る。** 名前が引けていない（`users` の行が
   * 無い）作品でリンクを出すと、**押した人を必ず 404 へ送る**（作者ページは存在しない
   * 利用者を 404 にする）。4.4 が「押せるが何も起きないもの」を出さないと定めている。
   *
   * **UGC ではない。** `crypto.randomUUID()` の出力であり、`href` へ入れる前に
   * `authorPagePath` が `encodeURIComponent` を通す（`src/users-page-paths.ts`）。
   */
  readonly authorPageId: string | null;
  /**
   * 作者がいま使っているハンドル名（#381 / 5.10）。**あれば作者名のリンクを `/@handle` へ向ける**
   * （`src/users-page-paths.ts` の `authorPagePathFor`）。
   *
   * **省略可にする**（描画を直接呼ぶテストが、ハンドル名に関係しない検査で値を用意しなくて済む）。
   */
  readonly authorHandle?: string | null;
  /**
   * 作者が運営か（#334）。**公開済みのときだけ立ちうる**（{@link authorName} と同じ条件）。
   *
   * **名前から導かない。** 表示名は Google の表示名でログインのたびに上書きされ、
   * 仕様 5.9（#341）以後は利用者が自由に変えられる——誰でも「運営」と名乗れる。
   * 運営であることは `users.is_operator` の列だけで見分ける（なぜ導出せず列で持つのかは
   * `migrations/0021_users_operator.sql`）。
   */
  readonly authorIsOperator: boolean;
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
  /**
   * いま推敲が走っているか。走っているあいだは新しく始められない。
   *
   * **開始から区切りの内側だけである**（#480。`src/revisions.ts` の `revisionStatus`）。
   */
  readonly revisionRunning: boolean;
  /**
   * 区切りを過ぎても `pending` / `running` のまま残った推敲があるか（#480）。
   *
   * **画面で経過時間を測らない。** 区切りの判定は `revisionStatus` が `src/games.ts` の
   * `inFlightCutoff` で行い、ここへ来るのは判定済みの真偽だけである（`revisable` と
   * 同じ方針）。`revisionRunning` と同時に真にならない。
   */
  readonly revisionStalled: boolean;
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
  /**
   * この作品 id（改名のフォームに入れる。5.4 / #366）。改名できないなら null。
   *
   * **`publishableId` / `forkableId` / `unpublishableId` と兼ねない**（同時に非 null に
   * なりうるかどうかに関わらず、条件が違う値を 1 つに畳まない。`forkableId` を分けた
   * のと同じ理由）。条件は「**本人・完成済み・取り下げていない**」で、**公開の前後を
   * 問わない**——題名は未公開のあいだも作者に見えており（`title`）、公開後は
   * `og:title` として外へ出る。どちらの側でも変えられて困らない。
   *
   * **`title` が null なら出さない**（改名のフォームは現在の題名を初期値に入れる）。
   */
  readonly renamableId: string | null;
  /**
   * 作者が書いた説明（#388）。**公開済みのときだけ入る。** 説明が無ければ空文字。
   *
   * **UGC である**ので、画面へ出すときは `escapeHtml` を通す（{@link descriptionSection} /
   * エディットページ（`src/work-edit.ts`）の説明の欄）。**公開済みでなければ null**——説明は公開後にしか書けず
   * （`src/games.ts` の `describeGame`）、取り下げた作品の画面は本文ごと差し替わる。
   */
  readonly description: string | null;
  /**
   * この作品 id（説明のフォームに入れる。#388）。書けないなら null。
   *
   * **`renamableId` と兼ねない。** 条件が違う——こちらは「**本人・公開済み**・完成済み」で、
   * 改名は公開の前後を問わない。**5.4 の 1 タップの導線を変えない**ため、未公開の作品に
   * 説明の欄を出さない。**画面でこの条件を組み立てない**（`revisable` と同じ方針）。
   */
  readonly describableId: string | null;
  /**
   * 作品のタグの識別子（#376）。**公開済みのときだけ入る**（未公開ならタグは付いていない。
   * 公開フォームで選ぶ）。タグ無しなら空配列。
   *
   * **誰にでも出す**（カードと同じ情報である）。語彙に照らして描くのは {@link tagsSection}。
   */
  readonly tags: readonly string[];
  /**
   * この作品 id（タグの付け直しのフォームに入れる。#376）。付け直せないなら null。
   *
   * **`describableId` と同じ条件**（本人・公開済み・完成済み）だが、**兼ねない**——条件が
   * 違う値を 1 つに畳まない（`forkableId` を分けたのと同じ理由。どちらかの条件を変えた日に、
   * もう片方が黙って変わらないようにする）。**画面でこの条件を組み立てない。**
   */
  readonly retaggableId: string | null;
  /**
   * この作品 id（公開をやめるフォームに入れる。5.4 / 確定35 / #637）。やめられないなら null。
   *
   * **`publishableId` / `forkableId` / `recapturableId` と兼ねない**（同時に非 null に
   * なりえない値を 1 つに畳むと、片方の条件を変えた日にもう片方が黙って壊れる。
   * `forkableId` を分けたのと同じ理由）。条件は「**公開済み・本人**」である。
   */
  readonly unpublishableId: string | null;
  /**
   * この作品 id（削除の確認画面への導線に入れる。#517 / M15-2）。導線を出さないなら null。
   *
   * **`unpublishableId` と兼ねない**（同時に非 null になりえない——公開をやめるのは公開中、削除は公開中でない作品）。
   * 条件は「**本人**・中身をまだ消していない・公開中でない・生成中でない・リフォージのジョブが走っていない」で、
   * **画面でこの条件を組み立てない**——`src/work-delete.ts` の `deletionBlockOf`（表示の条件）が null を返した
   * ときだけ入る。消せるかどうかの正本は `deleteGame` である。
   */
  readonly deletableId: string | null;
  /**
   * 削除の導線を出さない理由が「止まったまま残ったリフォージ」か（#517）。**本人の、公開中でない完成済みの作品で
   * だけ立ちうる。** 立っていれば、削除の導線の代わりに「いまは削除できない」理由を 1 文出す
   * （リフォージの口は区切りを過ぎたジョブを終わったものとして扱うが、`deleteGame` は経過時間で区切らない）。
   *
   * **省略可にする**（`purged` と同じ理由）。
   */
  readonly deletionStalledByRevision?: boolean;
  /**
   * いいねの数（5.8 / #340）。**0 のときは出さない**（2.3.6 の `fork_count` と同じ扱い）。
   *
   * **どこから来た数かは、この型に現れない。** ログイン中なら DO が数えた実数、
   * 未ログインなら D1 の `games.like_count`（最大 5 分遅れる）である。画面は
   * どちらでも同じ 1 つの数として出す——**遅れているかどうかは見た目で示せない**し、
   * 示しても読み手にできることが無い。
   */
  readonly likeCount: number;
  /**
   * プレイ数（#377 / 仕様 2.3.6）。**0 のときは出さない**（いいねの数と同じ扱い）。
   *
   * **D1 の `games.play_count`（最大 5 分遅れる）である。** 誰が見ていても DO を引かない。
   */
  readonly playCount: number;
  /**
   * この作品 id（プレイ数を数えるスクリプトに入れる。#377）。数えないなら null。
   *
   * **条件は「公開済み・取り下げていない・遊ぶ URL を組み立てられた」である**（数えるのは
   * `/g/` の iframe から届いた起動の合図だけで、未公開のプレビュー `/p/` は数えない）。
   * **画面でこの条件を組み立てない**（`likableId` と同じ方針）。
   */
  readonly playCountableId: string | null;
  /**
   * この作品 id（いいねを**付ける**フォームに入れる。5.8）。付けられないなら null。
   *
   * **`unlikableId` と兼ねない**（`publishableId` / `forkableId` を分けたのと同じ理由
   * ——同時に非 null になりえない値を 1 つに畳むと、片方の条件を変えた日にもう片方が
   * 黙って壊れる）。**真偽 1 つで「押しているか」を表す形にもしない**——それだと
   * 「押せない人」（未ログイン・作者・審査で止めた作品）を表せず、4.4 の
   * 「押せないボタンを出さない」が画面側の `&&` に落ちる。
   *
   * **条件は窓口が決める。** 画面で `published && signedIn && !owner && …` を
   * 組み立てない——押せるかどうかの正本は `src/likes.ts` の `PRESSABLE_GAME_SQL`
   * であり、ここへ来るのは判定済みの値だけである（`revisable` と同じ方針）。
   */
  readonly likableId: string | null;
  /**
   * この作品 id（いいねを**取り消す**フォームに入れる。5.8）。取り消せないなら null。
   *
   * 置き方の理由は {@link likableId} と同じである。**押している人にだけ非 null になる。**
   */
  readonly unlikableId: string | null;
  /**
   * 詳細情報パネル（2.3.12 / #383）。**公開済み・取り下げていない作品のときだけ入る。**
   *
   * null ならパネルを出さない（未公開の作品ページは作者のための状態画面で、来歴を並べる
   * 場所ではない）。
   */
  readonly details: WorkDetails | null;
  /**
   * 作者が下書きを作品ページで開いたときの、公開後と同じ画面のプレビューか（#664）。
   *
   * **立っていれば、公開後の本文（{@link watchSection}）を描き、上に「下書きです」の帯と「編集へ戻る」を出す。**
   * `published` は偽のままにする——`noindex` を外さず、OGP のメタタグも出さない（公開して初めて外へ出す。5.4）。
   * 遊ぶ URL は試遊 URL（`/p/`）で、計上のスクリプトは置かない（`playCountableId` は公開済みだけ）。
   *
   * **省略可にする**（`purged` と同じ理由。描画を直接呼ぶテストが、プレビューに関係しない検査で値を用意しなくて済む）。
   */
  readonly draftPreview?: boolean;
  /**
   * 作者に出す「編集する」の行き先（`/works/<id>/edit`。#664）。作者でなければ null。
   *
   * **作品ページが作者と作者以外で違うのは、この 1 つだけである**（下書きのプレビューを除く）。作者だけの操作は
   * エディットページ（`src/work-edit.ts`）へ移した。**省略可にする**（`draftPreview` と同じ理由）。
   */
  readonly editPath?: string | null;
  /**
   * 右カラムの関連作品（#665。`src/related-works.ts`）。**公開済みの作品だけ**が入る（引く SQL が絞る）。
   *
   * **省略可にする**（`draftPreview` と同じ理由）。省けば関連作品のカラムを出さない。
   */
  readonly related?: readonly RelatedWork[];
  /**
   * 作者の行に出すアイコンの URL（#665。版つき。`src/avatar-paths.ts` の `avatarUrl`）。アイコンが無ければ null。
   *
   * **省略可にする**（`draftPreview` と同じ理由）。
   */
  readonly authorAvatarUrl?: string | null;
}

/**
 * 作品ページの HTML を組み立てる。
 *
 * **`escapeHtml` を通すのは利用者の入力である。** 題名（`title`）と作者名に加えて、
 * #388 で作者の説明（`description`）が加わった。他はすべてこのモジュールが持つ
 * 固定の文字列か、正規表現で形を確かめた URL である。
 *
 * @param view 表示に必要な値
 * @param viewer いま見ている人の状態（2.3.7 のヘッダの出し分け）
 * @returns HTML
 */
export function renderWorkPage(view: WorkPageView, viewer: SiteViewer): string {
  // 生成中のあいだだけ自動更新する。完成・失敗の画面で再読み込みを続ける理由が無い
  // （D1 の読み取りが増えるだけで、表示は変わらない）。
  // **推敲中も更新する。** 5.7 の「押したら作り直しが始まり、完成したら差し替わる」は、
  // 作者が待っているあいだ画面が変わらないことを許さない。**`state` は `ready` のまま
  // なので、この条件を足さないと止まって見える**（推敲は `games` の状態機械を動かさない。
  // `migrations/0009_game_revisions.sql`）。
  //
  // **止まった推敲では更新しない**（#480）。区切りを過ぎた行は `revisionRunning` に
  // 入らない（`revisionStalled` に分かれる）。待っても画面は変わらないので、生成の
  // 「中断した可能性」と違って読み取りを続ける理由が無い。
  //
  // **作者以外に未公開の作品を出すときも更新しない**（#690）。状態を言い分けない（{@link unpublishedSection}）ので、
  // 待っても画面は変わらない。更新の有無で状態が読める差も残さない。
  const refresh =
    !showsOnlyUnpublished(view) && (view.state === 'working' || view.state === 'stalled' || view.revisionRunning)
      ? `\n<meta http-equiv="refresh" content="${REFRESH_SECONDS}">`
      : '';



  const ipNotice = ipNoticeSection(view);

  // **公開済みの作品にだけ `noindex` を外す。** 未公開の作品ページは作者のための
  // 状態画面であり、検索結果に現れる意味が無い（`src/my-works.ts` と同じ扱い）。
  //
  // 公開済みで外すのは体裁の問題ではない。**`noindex` を付けたページのカードを
  // 描かないクローラがある**ため、付けたままだと 5.4 の「公開して共有」が、
  // 共有先で画像も題名も出ないという形で黙って壊れる。
  //
  // **下書きのプレビュー（#664）でも `noindex` を外さず、OGP のメタタグも出さない**（`published` が偽のまま。
  // {@link ogpMeta} は公開済みでなければ空を返す）。
  return `${siteHead({
    // **公開前の作品を検索避けする。** 公開して初めて外へ出す（5.4）。
    title: documentTitleOf(view),
    noindex: !view.published,
    beforeTitle: refresh,
    extraHead: ogpMeta(view),
    viewer,
  })}
${watchable(view) ? `${draftBanner(view)}${watchSection(view)}` : `<h1>${escapeHtml(workNameOf(view))}</h1>
${sectionFor(view)}
${ipNotice}${reportSection(view)}`}
${siteFooter()}`;
}

/**
 * 視聴ページの配置で描くか（#665）。**公開済みの作品と、作者の下書きのプレビュー（#664）だけ**である。
 *
 * それ以外（生成中・失敗・取り下げ済み・作者以外が見る下書き）は、状態の知らせだけの画面のまま（{@link sectionFor}）。
 *
 * @param view 表示に必要な値
 * @returns 視聴ページの配置なら true
 */
function watchable(view: WorkPageView): boolean {
  return !view.removed && view.state === 'ready' && (view.published || view.draftPreview === true);
}

/**
 * 下書きのプレビューの上に置く帯（#664）。**作者が下書きを作品ページで開いたときだけ出す。**
 *
 * **何が見えているかと、戻る道を 1 つの面に置く。** 公開後と同じ画面なので、帯が無いと「もう公開した」と読める。
 * 帯は面のブロック（`.gf-block`）で、枠線も影も使わない（仕様 2.5.4）。「編集へ戻る」は移動なので `<a>`（2.5.5）。
 *
 * @param view 表示に必要な値
 * @returns HTML（プレビューでなければ空文字）
 */
function draftBanner(view: WorkPageView): string {
  if (view.draftPreview !== true || view.editPath === null || view.editPath === undefined) {
    return '';
  }
  return `<div class="gf-block gf-draft-banner" role="note">
<p><strong>下書きです。</strong>公開すると、この画面がこのまま誰にでも見えるようになります（いまはあなたにだけ見えています）。</p>
<p><a class="${SECONDARY_BUTTON} gf-button-sm" href="${view.editPath}">編集へ戻る</a></p>
</div>
`;
}

/**
 * プレイ数を数えるスクリプト（#377）。**iframe の直前に置く**（{@link watchSection}。#502 からは、iframe を作るスクリプトが
 * デスクトップで iframe を差し込む `<noscript>` の直前）。
 *
 * **iframe より後ろに置かない。** 合図（`postMessage`）がリスナーの登録より先に届くと、そのページの
 * 起動は二度と数えられない（PR #425 の Copilot の指摘）。スクリプトは iframe を合図が届いた時点で
 * 引くので、登録の時点で iframe が無くてよい（`src/plays.ts` の `playReportScript`）。**4 要素より
 * 後ろではある**——スクリプトは DOM を書き換えないので、4 要素の描画は何も待たない（#30）。
 * 数えない画面では何も出さない。
 *
 * @param view 表示に必要な値
 * @returns `<script>` 要素（後ろに改行を 1 つ付ける）。数えないなら空文字
 */
function playScript(view: WorkPageView): string {
  if (view.playCountableId === null) {
    return '';
  }
  const script = playReportScript(view.playCountableId);
  return script === '' ? '' : `${script}\n`;
}

/**
 * `moderation_blocks` から、その作品が引っ掛かったカテゴリを引く（8.2 / #37）。
 *
 * **本文は引かない。** 画面が要るのは分類名だけで、`prompt` は運用の材料である
 * （`migrations/0016_moderation_blocks.sql`）。**引かなければ、画面の経路から
 * 本文が漏れる余地が構造的に無い。**
 *
 * @param env バインディングと環境変数
 * @param gameId 作品 id
 * @returns カテゴリの表示名（行が無ければ空配列）
 */
async function listBlockedCategories(env: Env, gameId: string): Promise<readonly string[]> {
  const row = await env.DB.prepare(
    'select categories from moderation_blocks where game_id = ? order by created_at desc limit 1',
  )
    .bind(gameId)
    .first<{ categories: string }>();
  if (row === null || row.categories === '') {
    return [];
  }
  return row.categories.split(MODERATION_CATEGORY_SEPARATOR).filter((part) => part !== '');
}

/**
 * 通報の口（8.4 / #40）。
 *
 * **ワンタップである。** 8.4 は「ワンタップ通報機能」と書いており、理由の入力を必須に
 * すると 1 タップで終わらない。理由欄は任意で、**空でも送れる。**
 *
 * **JavaScript を要求しない**（`src/publish.ts` と同じ形。素の `<form>`）。
 *
 * **畳んだ口は文章の外のリンクの見せ方にする**（#474 / 仕様 2.5.5）。`<summary>` に下線を常には出さず、ホバーと
 * キーボードの焦点で出す（`@section work` の `.gf-report summary`）。送信のボタンは小さい副のボタンである。
 *
 * **押した結果がどうなるかを書かない。** 「N 件で非表示になります」と出すと、
 * **閾値を外から測れる**——8.4 が警戒している通報爆撃の設計図になる。
 *
 * ## 何を通報してよいかを書く（#286）
 *
 * **音には出力側モデレーション（8.3）の検査対象が無い。** 8.3 が見るのは生成ソースの
 * 文字列リテラルであり、音は `math` で組み立てた数値の列なので、**検査すべきリテラルが
 * 1 つも残らない。** 音を許した時点で、止め役はこのフォームだけになった（仕様 8.3 の
 * #286 注記）。
 *
 * **唯一の止め役へ実際に届く経路を作る。** 「理由（任意）」だけを置くと、通報の対象は
 * 見た目の話だと読まれる。**耳で気づいたことをここへ書いてよい**と明示しなければ、
 * 届かない通報は最初から存在しないのと同じである。
 *
 * **具体例を並べない。** 何が該当するかを列挙すると、列挙されなかったものは対象外だと
 * 読まれる。**判断は審査キューが行う**（8.4）ので、ここは「見えるもの・聞こえるものが
 * 対象である」ことだけを伝える。
 *
 * @param view 表示に必要な値
 * @returns HTML（通報できなければ空文字、通報済みならその旨）
 */
function reportSection(view: WorkPageView): string {
  if (view.alreadyReported) {
    return `
<p class="gf-reported">この作品は通報済みです。運用側で確認します。</p>`;
  }
  if (view.reportableId === null) {
    return '';
  }
  return `
<details class="gf-report" id="${WORK_REPORT_ANCHOR}">
  <summary>この作品を通報する</summary>
  <form method="post" action="${WORK_REPORT_PATH}">
    <input type="hidden" name="${WORK_REPORT_GAME_ID_FIELD}" value="${view.reportableId}">
    <p class="gf-report-scope">画面に出るものだけでなく、<strong>この作品が鳴らす音</strong>も通報の対象です。気づいたことがあれば理由欄へ書いてください（空のままでも送れます）。</p>
    <p><label>理由（任意・${MAX_REASON_LENGTH} 文字まで）<br>
      <textarea name="${WORK_REPORT_REASON_FIELD}" maxlength="${MAX_REASON_LENGTH}" rows="3"></textarea>
    </label></p>
    <button type="submit" class="${SECONDARY_BUTTON} gf-button-sm">通報する</button>
  </form>
</details>`;
}

/**
 * 遮断されたカテゴリの提示（8.2 / #37）。
 *
 * **分類までしか出さない。** 検出箇所・スコア・閾値は出さない（{@link
 * WorkPageView.blockedCategories}）。**作者にしか出さない**——他人の入力が何で
 * 止められたかは、その人以外に関係が無い。
 *
 * @param view 表示に必要な値
 * @returns HTML（遮断されていなければ空文字）
 */
export function blockedCategoriesSection(view: WorkPageView): string {
  if (!view.owner || view.blockedCategories.length === 0) {
    return '';
  }
  const names = view.blockedCategories.map((name) => escapeHtml(name)).join('・');
  return `
<p class="gf-blocked-categories">引っ掛かった分類: <strong>${names}</strong></p>`;
}

/**
 * 著名 IP 名を置き換えたことの開示（6.2 / #39）。
 *
 * **6.2 は「置換したことをユーザーに開示する。黙って別物を出すのは体験として悪い」と
 * 定めている。** 置換そのものはシステムプロンプトが行い（`src/system-prompt.ts` の
 * `COPYRIGHT`）、ここはそれが起きたはずだと伝えるだけである。
 *
 * **「置き換えました」と断定しない。** モデルが実際に何をしたかは、こちらから
 * 見えない——出力は Go のソース 1 本だけで、置換の報告を返す口が無い
 * （`src/ip-substitution.ts` の冒頭）。**確かめていないことを、確かめたように
 * 書かない**（`docs/handoff.md` 4 章）。
 *
 * **作者にしか出さない。** {@link WorkPageView.ipNotice} が既に空になっているが、
 * ここでも `owner` を見る。**2 か所で止めるのは、片方の条件を将来ゆるめたときに
 * 商標が公開ページへ出ないようにするため**である。
 *
 * @param view 表示に必要な値
 * @returns HTML（開示が無ければ空文字）
 */
export function ipNoticeSection(view: WorkPageView): string {
  if (!view.owner || view.ipNotice.length === 0) {
    return '';
  }
  const names = view.ipNotice.map((name) => `「${escapeHtml(name)}」`).join('');
  return `
<p class="gf-ip-notice"><strong>${names}は、オリジナルの要素へ置き換えて作っています。</strong>
   有名な作品の名前・見た目・固有名詞はそのまま使えないため、遊びの仕組みだけを
   取り出しています（<a href="/">Game Forge</a> の方針です）。この案内はあなたにだけ見えています。</p>`;
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
  return `${workNameOf(view)} - Game Forge`;
}

/**
 * 画面と `<title>` と OGP が出す、その作品の名前（#267）。
 *
 * **3 か所が同じ判定を要る。** 以前は同じ式が 2 か所へ写っていた（`documentTitleOf` と
 * `ogpMeta`）。M8-2 で見出しにも要るようになったので、**写しを増やす前に 1 か所へ寄せる。**
 *
 * @param view 表示に必要な値
 * @returns 題名（空・未設定なら既定の文言）
 */
export function workNameOf(view: WorkPageView): string {
  return view.title === null || view.title.trim() === '' ? FALLBACK_WORK_TITLE : view.title;
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
  const name = workNameOf(view);
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
 * 作者以外に、未公開の作品を「まだ公開されていません」の 1 つだけで出すか（#690）。
 *
 * **公開していない・取り下げていない・作者の画面でも作者の下書きのプレビューでもない**ときに真になる。
 *
 * - **`owner` はエディットページ（`edit`）でだけ真になる**（{@link loadWorkView} の `ownerTools`）。作品ページ（`page`）では
 *   作者にも偽だが、作者が未公開の作品を作品ページで開くと、完成した下書きはプレビュー（`draftPreview`）になり、
 *   それ以外はエディットページへ 303 で送られる（{@link showWorkPage}）ので、この判定に作者は来ない
 * - **取り下げ済み（tombstone）は含めない**（#690 の scope.out。{@link sectionFor} が先に返す）
 *
 * @param view 表示に必要な値
 * @returns 作者以外に未公開の知らせだけを出すなら true
 */
function showsOnlyUnpublished(view: WorkPageView): boolean {
  return !view.removed && !view.published && !view.owner && view.draftPreview !== true;
}

/**
 * 状態ごとの本文を組み立てる。
 *
 * @param view 表示に必要な値
 * @returns HTML
 */
export function sectionFor(view: WorkPageView): string {
  // **`state` より先に見る。** tombstone は生成の進行状態と直交しており（取り下げても
  // `generation_state` は `ready` のまま）、`state` の分岐に混ぜると「できました」の
  // 枝の中に「取り下げています」を書き足して回ることになる。
  if (view.removed) {
    return removedSection(view);
  }
  // **作者以外には、未公開の作品の状態を言い分けない**（#690）。生成中・止まった・失敗・完成した下書き・リフォージ中の
  // どれでも {@link unpublishedSection} の 1 つを返す。`state` の分岐より先に見る（tombstone と同じ理由——枝ごとに
  // 「作者以外なら」を書き足して回ると、書き漏らした枝から作者向けの文言が漏れる）。
  if (showsOnlyUnpublished(view)) {
    return unpublishedSection();
  }
  switch (view.state) {
    case 'working':
      // **文言は `GENERATION_IS_SYNCHRONOUS` が決める。** #160 で非同期実行になった
      // ので「閉じてよい」が正しい。同期側の文言は消さずに残す——段を戻したときに
      // 書き直すのではなく、定数 1 つで両方の実行形態を言い当てられるようにしておく。
      return stateBlock(GENERATION_IS_SYNCHRONOUS
        ? `<h2>生成中です</h2>
<p><strong>生成が終わるまで、このタブを開いたままにしてください。</strong>
   いま閉じると生成は中断します。</p>
<p>通常 1〜2 分かかります。この画面は自動で更新されます。</p>
<p>この URL は作品の恒久的な URL です。控えておけば、あとから状態を確認できます。</p>`
        : `<h2>生成中です</h2>
<p><strong>このページは開いたままにしなくて構いません。</strong>
   タブを閉じても生成は進みます。この URL をもう一度開けば、続きから状態が読めます。</p>
<p>通常 1〜2 分かかります。この画面は自動で更新されます。</p>`);
    case 'stalled':
      return stateBlock(`<h2>生成中です</h2>
<p><strong>時間がかかりすぎています。中断した可能性があります。</strong>
   しばらく待っても変わらない場合は、お手数ですがもう一度生成してください。</p>
<p>この画面は自動で更新されます。</p>`);
    case 'ready':
      // **公開済みと下書きのプレビュー（#664）は視聴ページの配置で描く**（{@link watchSection}。#665）。
      // それ以外（作者以外が見る下書き）は上の {@link showsOnlyUnpublished} が先に返すので、ここへは来ない。
      return view.published || view.draftPreview === true ? watchSection(view) : unpublishedSection();
    case 'failed':
      // **遮断された分類の知らせはブロックの外、直後に置く**（`@section notices` の知らせの見た目を持ち、面の上に
      // 重ねると面が二重になる）。並びは #474 の前と同じである。
      //
      // **削除の導線（#517）は知らせの後ろ、設定のブロックに置く**（完成した下書きの画面と同じ形。出さないなら何も足さない）。
      return `${stateBlock(`<h2>生成できませんでした</h2>
<p>${view.owner ? escapeHtml(failureMessageOf(view.errorCode)) : escapeHtml(UNKNOWN_FAILURE_MESSAGE)}</p>`)}${blockedCategoriesSection(view)}${settingsBlock([deleteSection(view)])}`;
    case 'unknown':
      return stateBlock(`<h2>状態を読み取れませんでした</h2>
<p>この作品の状態が想定外の値になっています。時間をおいてもう一度お試しください。</p>`);
  }
}

/**
 * 状態の知らせ（生成中・生成できませんでした・取り下げ など）を、面のブロックで囲む（#474 / 仕様 2.5.4）。
 *
 * **中身の文言と並びは変えない**——外側に面を足すだけである。見出しの上の余白と最後の段落の下の余白は
 * `@section work` の `.gf-work-state` が打ち消す（面の内側の余白は `.gf-block` の 16px だけにする）。
 *
 * @param inner 知らせの HTML（`<h2>` と段落）
 * @returns HTML
 */
export function stateBlock(inner: string): string {
  return `<div class="gf-block gf-work-state">
${inner}
</div>`;
}

/**
 * 作者だけの設定の口を、1 つの面のブロックに行で並べる（#474 / 仕様 2.5.4）。
 *
 * **行の間は `.gf-block-rows` の淡い罫線で区切る**（ブロックの中で行を分ける作法。お知らせの行と同じ）。
 * 空の口（その作者・その状態で出さないもの）は行ごと落とし、**1 つも無ければブロックごと出さない**
 * （空の面を残さない）。**並びは渡された順のまま**である（呼ぶ側が #474 の前と同じ順で渡す）。
 *
 * **ボタンはすべて副にする**（2.5.5。主は 1 画面に 1 つまでで、公開済みの画面では「改造する」、未公開の画面では
 * 「公開して共有」が持つ）。**取り下げも赤くしない**——赤はエラーの意味だけに使う（2.5.10 の第 4 版の決定）。
 *
 * @param parts 口ごとの HTML（出さない口は空文字）
 * @returns HTML（出す口が無ければ空文字）
 */
export function settingsBlock(parts: readonly string[]): string {
  const rows = parts.filter((part) => part.trim() !== '').map((part) => `<div>${part}\n</div>`);
  if (rows.length === 0) {
    return '';
  }
  return `
<section class="gf-block gf-block-rows gf-work-settings" aria-label="作品の設定">
${rows.join('\n')}
</section>`;
}

/**
 * 副のボタン（仕様 2.5.5）。作品ページの主以外の動作（いいね・保存・撮り直し・取り下げ・通報・版に戻す）に当てる。
 *
 * **`<button>` の既定の見た目（黒地に白文字）に寄りかからない。** 既定は M13-6〜M13-11 の最後の 1 本が副へ切り替える
 * （`docs/mvp-roadmap.md` の M13 の節）ので、ここで強さを明示しておかないと、切り替えの前は主に見え、後は主の
 * 「公開して共有」「改造する」まで副に見える。見た目の正本は `public/assets/app.css` の `@section buttons` である。
 */
const SECONDARY_BUTTON = 'gf-button gf-button-secondary';

/**
 * 主のボタン（仕様 2.5.5）。**1 画面に 1 つまで**——公開済みの画面では「改造する」、未公開の作者の画面では
 * 「公開して共有」（5.4 の試遊画面の主ボタン）にだけ当てる。
 */
const PRIMARY_BUTTON = 'gf-button gf-button-primary';

/**
 * 公開を停止された作品の本文（tombstone。5.3 / M5-4 / #35 / 確定35）。
 *
 * **#637 以降、この状態を作るのは作者ではない**（運営の措置・退会・作者の削除。`src/games.ts` の
 * {@link REMOVED_STATUS}）。作者が公開をやめると `draft` へ戻り、この分岐は通らない。**そのため
 * 本文で「あなたが取り下げました」と言わない**——#35 から #636 までに作者が取り下げた行もここへ来るが、
 * 運営が止めた行と同じ文で足りる（誰が止めたかは、どちらの読み手にも文面から分からないほうがよい）。
 *
 * # 誰にでも同じことを言う
 *
 * **404 にしない。** 取り下げられたことは既に公開の事実である——**子の作品ページが
 * 「元ゲーム: 削除済みの作品から派生」と言っている**（{@link parentLine}）。ここだけ
 * 「作品が見つかりません」と言うと、辿ってきた人には**リンクが壊れているのか、
 * 取り下げられたのか**が読めない。
 *
 * それでも**題名は出さない**（`showWorkPage` が本人以外へ渡さない）。取り下げは
 * 「もう見せない」という作者の意思表示で、5.4 の公開が「見せてよい」の表明だった
 * のと対になっている。
 *
 * # 元に戻す口は置かない
 *
 * 5.3 も 5.4 も `removed` から戻る遷移を定義していない。**戻せるように見せて
 * 断るより、置かないほうがよい**（`publishGame` は `removed` を `reason: 'removed'`
 * で断る）。公開し直したいなら、5.7 が言うとおりフォークが正しい口である。
 *
 * @param view 表示に必要な値
 * @returns HTML
 */
function removedSection(view: WorkPageView): string {
  // **中身を消した作品（#516 / #517）でも、見出しと誰にでも出す文は変えない**（仕様 5.3 の #516 節「作品ページは既存の
  // 取り下げ済みの表示のまま」）。作者本人にだけ、中身が消えていることを言う——取り下げただけの作品と同じ文を出すと、
  // 「取り下げただけで、まだ残っている」と読める。
  const owned = !view.owner
    ? ''
    : view.purged === true
      ? `
<p>この作品はあなたが削除しました。ソースコード・遊ぶためのファイル・紹介用の画像は消えています。</p>
<p><strong>この作品をフォークした作品は、そのまま残っています。</strong>
   削除は、そこから派生した作品を巻き込みません。</p>`
      : `
<p>共有した URL からは遊べなくなっています。</p>
<p><strong>この作品をフォークした作品は、そのまま公開されたままです。</strong>
   公開の停止は、そこから派生した作品を巻き込みません。</p>`;
  // **段落を明示的に閉じる。** ブラウザの自動補正（`<p>` が次の `<p>` で閉じる）に
  // 寄りかからない——このモジュールの他の枝はどれも閉じており、ここだけ崩すと
  // 「閉じなくてよい」と読まれる。
  //
  // **削除の導線（#517）は知らせの後ろ、設定のブロックに置く**（取り下げた作品で中身をまだ消していないときだけ出る）。
  return `${stateBlock(`<h2>この作品は公開されていません</h2>
<p>この作品は公開を停止しています。</p>${owned}`)}${settingsBlock([deleteSection(view)])}`;
}

/**
 * 削除の確認画面への導線（#517 / M15-2 / 仕様 5.3 の #516 節）。
 *
 * # 押しても消えない。確認画面へ移動する
 *
 * **ここは `<a>` である**（仕様 2.5.5「移動は `<a>`」）。削除で起きること・起きないことは確認画面
 * （`src/work-delete.ts` の `renderDeleteConfirmation`）が書き、そこで送った POST だけが消す。
 *
 * # 主にしない
 *
 * **破壊的な操作なので副のボタンの見た目にする**（#517 の constraints。取り下げと同じ段）。未公開の画面の主は
 * 「公開して共有」のままである。
 *
 * # 出す条件は画面で組み立てない
 *
 * 門番は {@link WorkPageView.deletableId} で、null かどうかだけを見る（`revisable` と同じ方針）。
 *
 * @param view 表示に必要な値
 * @returns HTML（出さないなら空文字）
 */
export function deleteSection(view: WorkPageView): string {
  if (view.deletableId === null) {
    // **止まったリフォージだけは黙らない**（#517）。リフォージの口は区切りを過ぎたジョブを終わったものとして扱い、
    // 画面は完成した作品として導線を並べるので、削除の導線だけが黙って消えると理由が読めない。
    return view.deletionStalledByRevision === true
      ? `
<h3>作品の削除</h3>
<p>直前のリフォージが止まったまま残っているため、いまはこの作品を削除できません。お手数ですが、よくある質問にある窓口までご連絡ください。</p>`
      : '';
  }
  return `
<h3>作品の削除</h3>
<p>この作品を削除できます。<strong>削除すると元に戻せません。</strong>次の画面で、削除すると何が消えるかを確かめてから削除します。</p>
<p><a class="${SECONDARY_BUTTON}" href="${workDeletePath(view.deletableId)}">この作品を削除する</a></p>`;
}

/**
 * 公開フォームに添える「ソースも公開される」の 1 文（#383 の決定 1）。テストが同じ綴りを見るために
 * export している（書き写さない）。
 */
export const PUBLISH_SOURCE_NOTICE =
  '公開すると、この作品の Go のソースコードも誰でも読めるようになります。' +
  '入力した文章そのものは公開されませんが、生成されたコードのコメントや文字列に、その内容が反映されていることがあります。';

/**
 * タグのチェックボックスの組（#376）。**エディットページのまとめて保存するフォーム（#664。`src/work-edit.ts`）が使う**
 * （#664 までは公開フォームと付け直しのフォームが同じ 1 つを使っていた）。
 *
 * - **語彙の順に並べる**（`src/work-tags.ts`。保存の順と同じ）
 * - **値は識別子、見える文字はラベル**（どちらも語彙の固定の文字列で、UGC ではない）
 * - **`required` を付けない**（タグ無しを許す）。上限は凡例の文言で知らせ、超えればサーバが断る
 * - `id` の接頭辞を分けるのは、同じ画面に 2 つの組が並んでも `label for` が衝突しないためである
 *   （いまは未公開と公開済みで出る組が違うが、含意に寄りかからない）
 *
 * @param idPrefix 要素の `id` の接頭辞
 * @param checked 最初から選ばれているタグの識別子
 * @returns HTML（`<fieldset>`）
 */
export function tagChoices(idPrefix: string, checked: readonly string[]): string {
  const boxes = WORK_TAGS.map((tag) => {
    const id = `${idPrefix}-${tag.id}`;
    const on = checked.includes(tag.id) ? ' checked' : '';
    return `    <label for="${id}"><input id="${id}" type="checkbox" name="${WORK_TAG_FIELD}" value="${tag.id}"${on}> ${tag.label}</label>`;
  });
  return `  <fieldset class="gf-tag-choices">
    <legend>タグ（任意・${MAX_WORK_TAGS} 個まで）</legend>
${boxes.join('\n')}
  </fieldset>`;
}

/**
 * 公開前の作品の「遊ぶ」の口に置く、固定の文言のパネル（#575）。**スクリーンショットの撮影中のパネルと同じ部品**
 * （`.gf-shot gf-shot-pending`）で、UGC を含まない。
 *
 * **#664 から使うのは 2 か所である**——エディットページのプレビュー（`src/work-edit.ts`。タッチ端末でだけ見せる）と、
 * 下書きのプレビューのスクリーンショットの代わり（{@link screenshot}。公開前は撮っていない）。
 */
export const DRAFT_PLAY_PANEL = '<p class="gf-shot gf-shot-pending">公開前の作品です。スクリーンショットは公開したときに撮ります。</p>';

/**
 * まだ公開していない作品の本文（**作者以外に出すもの**。#690 から、未公開のどの状態でもこれ 1 つ）。
 *
 * **作者以外には、未公開であることだけを言う**（#690。2026-09-19 の利用者の決定）。生成中・止まった・失敗・
 * 完成した下書き・リフォージ中を言い分けない（{@link showsOnlyUnpublished}）。
 *
 * - **#690 の前は、完成した下書きに「できました」の見出しを付けていた**（関数名も `readySection`）。推敲中も `games` は
 *   `ready` のまま（`migrations/0009_game_revisions.sql`）なので、リフォージ中の作品にも作者以外には「できました」と
 *   出ていた。最初の生成中には、作者向けの「生成中です…タブを閉じても生成は進みます」が作者以外にも出ていた（#690 の背景）
 * - **見出しの「できました」は付けない**——作者以外にとって、何ができたかは意味を持たない
 *
 * 旧記述（#150 の決定。#690 で「状態」を「未公開であること」へ狭めた）: **作者以外には状態だけを言う**（仮タイトルと
 * 試遊 URL は作者の情報である）。
 *
 * **#664 から、作者はこの枝を通らない。** 作者が下書きを作品ページで開くと、公開後と同じ画面のプレビュー
 * （{@link WorkPageView.draftPreview}）になり、試遊・公開・リフォージ・版・作品名・削除はエディットページ
 * （`src/work-edit.ts`）へ移した。#575 の埋め込み・#600 の改名へ飛ぶ 1 行も、あちらのプレビューと作品名の欄が受け持つ。
 *
 * @returns HTML
 */
function unpublishedSection(): string {
  return stateBlock(`<p>この作品はまだ公開されていません。</p>`);
}

/**
 * 推敲とフォークの口に出す、1 回の操作で使う生成枠の説明（#402）。
 *
 * **枠は最大 {@link MAX_GENERATION_ATTEMPTS} 回分減る。** 推敲もフォークも新規生成と同じ
 * 試行のループ（`src/generate.ts`）を通り、生成されたコードがコンパイルできなかったときは
 * 自動でやり直す（5.2-7）。枠は成否に関わらず LLM を呼んだ回数で数える（4.3「数えるのは
 * 台帳の行数である」「成否で絞らない」）。**#402 までは「生成枠を 1 回使います」と
 * 書いていた**——この文を見て残りを数えた利用者は、実際より多く残っていると見積もる。
 *
 * **回数を書き写さず、定数から作る**（shared-ai-rules 12 章）。直値だと、やり直しの
 * 回数を見直した日にこの画面だけが古い回数を案内する。
 *
 * **言い回しはお知らせの記事（`src/news-articles.ts` の `generation-quota`）に揃える。**
 * 同じ事実を 2 か所で違う言い方にすると、どちらが正しいのか利用者には分からない。
 * 一致は `test/work-page.test.ts` が記事の本文から拾って照合する。記事は日付の付いた
 * 写しで回数を直書きしているので、**定数を動かすとその照合が落ちる**——記事を直すか、
 * 新しい記事を足す合図である。
 *
 * **整理パス（5.3 の確定18）はこの 1 文の外である。** 整理パスは `TIDY_ATTEMPTS`（1）で
 * 打ち切り、**自動のやり直しが乗らない**ので、この 1 文の「自動で やり直す」は当てはまらない。
 * 作品ページの口は親ソースの大きさを読まないため、フォークの口にだけ
 * {@link FORK_TIDY_QUOTA_NOTICE} を添えて例外を言う。整理の同意を問う画面
 * （`src/fork.ts`）は押す前に「生成枠を 1 回使います」と言うので、そちらは正しい。
 */
export const GENERATION_RETRY_QUOTA_NOTICE =
  `生成されたコードがコンパイルできなかったときは自動で ${MAX_GENERATION_ATTEMPTS - 1} 回だけやり直すため、` +
  `1 回の操作で枠を最大 ${MAX_GENERATION_ATTEMPTS} 回分使うことがあります。`;

/**
 * フォークの口に添える、整理パスの例外（#402 / 5.3 の確定18）。
 *
 * **親が上限を超えているフォークは、自動のやり直しの経路を通らない。** 押すと整理の
 * 同意を問う画面（`src/fork.ts`）へ送られ、そこで使う枠の回数を先に言う。作品ページは
 * 親ソースの大きさを読まない（R2 を 1 回読むことになる）ので、**場合分けせずに例外を
 * 言葉で添える。** {@link GENERATION_RETRY_QUOTA_NOTICE} を「どの場合も自動でやり直す」と
 * 読ませないためである（PR #407 のレビュー指摘）。
 */
export const FORK_TIDY_QUOTA_NOTICE =
  '元の作品が大きく、整理してからフォークする場合は、自動のやり直しは行わず、使う枠の回数を確認の画面で先にお知らせします。';

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
export function reviseSection(view: WorkPageView): string {
  if (!view.owner) {
    return '';
  }
  if (view.revisionRunning) {
    return `
<h3>リフォージしています</h3>
<p><strong>このページは開いたままにしなくて構いません。</strong>
   通常 1〜2 分かかります。この画面は自動で更新されます。</p>
<p>できあがるまで、上の URL では<strong>いまの版</strong>が遊べます。</p>`;
  }

  // **失敗は残す。** 作品は無傷なので画面は「できました」のままだが、押した操作が
  // どうなったかを言わないと、作者からは何も起きなかったように見える。
  //
  // **止まった推敲も同じ場所で言う**（#480）。行は `pending` / `running` のままで
  // 失敗の分類名を持たないので、生成の `looksStalled` と同じく「中断した可能性」と言う。
  //
  // **同時に真にならないのは案内どうしである。** `revisionError`（失敗の案内）と
  // `revisionStalled`（中断の案内）は、1 作品 1 行のジョブの状態（`failed` か、区切りを
  // 過ぎた `pending` / `running` か）から導くので、どちらか一方しか出ない。
  // `revisionRunning` と `revisionStalled` も同じ理由で同時に真にならない
  // （`revisionRunning` なら上で返している）。
  //
  // **止まった推敲では、推敲の口と「版に戻す」は両方とも出る。** 止まった行は次の推敲が
  // 引き取り（`claimRevisionSlot`）、戻す操作も断らない（`restoreRevision`）。推敲の口は
  // 下の `revisable` と日次の枠の条件で、「版に戻す」は {@link revisionList} で出す。
  const failed =
    view.revisionError !== null
      ? `
<p><strong>前回のリフォージはうまくいきませんでした。</strong>
   ${escapeHtml(failureMessageOf(view.revisionError))}
   作品はそのまま残っています。</p>`
      : view.revisionStalled
        ? `
<p><strong>時間がかかりすぎています。リフォージが中断した可能性があります。</strong>
   作品はそのまま残っています。</p>`
        : '';

  // **`publishableId` が無ければフォームを描かない。** ここは推敲の対象そのものの id で、
  // `revisable` が真ならこちらも非 null である（`showWorkPage` が同じ条件から作る）。
  // **その含意に寄りかからない**——空の `value` を持つフォームを描くくらいなら、
  // 出さないほうがよい。
  if (!view.revisable || view.publishableId === null) {
    return failed;
  }

  // **1 作品あたりの残り回数は出さない**（#515。上限をなくした）。回数として出すのは日次枠だけである。
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
  <button type="submit" class="${SECONDARY_BUTTON}">この内容でリフォージする</button>
</form>`;

  return `${failed}
<h3>リフォージ（気になるところを直す）</h3>
<p>どう直したいかを書くと、いまのソースをもとに作り直します。
   <strong>1 回につき 1〜2 分かかり、生成枠を使います。${GENERATION_RETRY_QUOTA_NOTICE}</strong></p>
${daily}${form}`;
}

/**
 * 版の一覧と「この版に戻す」（5.7）。
 *
 * **全文再出力である以上、「少し直したつもりが全体が変わる」ことは異常ではない。**
 * 戻せなければ推敲は 1 回 ¥22.41 前後の賭けになり（2026-09-04 / 本番の既定群 20 件の
 * 平均。4.2 の実測注記）、作者は 2 回目を押さない。
 *
 * **`seq = 1` のプロンプトは null である**（`migrations/0009_game_revisions.sql`）。
 * 初回のプロンプトは費用台帳にしか無く、確定27 により版から引けない。**「最初の生成」と
 * 出せば作者は選べる**ので、そのために値を 3 か所目へ複製しない。
 *
 * **推敲が走っているあいだは戻す口を出さない。** 戻しても 90 秒後に黙って上書き
 * されるので、経路側も断る（`src/revisions.ts` の `restoreRevision`）。**止まった推敲
 * （`revisionStalled`）では出す**（#480）——もう完成を書き戻せないので、経路も断らない。
 *
 * @param view 表示に必要な値
 * @returns HTML
 */
export function revisionList(view: WorkPageView): string {
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
      <button type="submit" class="${SECONDARY_BUTTON} gf-button-sm">この版に戻す</button>
    </form>`;
      return `  <li>${label}${current}${restore}</li>`;
    })
    .join('\n');

  return `
<h3>これまでの版</h3>
<p>戻すのに生成枠は使いません。</p>
<ul class="gf-revisions">
${items}
</ul>`;
}

/**
 * 作品ページの本文を、YouTube の視聴ページの配置で描く（#665 / レイアウト改修 2/3）。**公開済みと下書きのプレビューだけ。**
 *
 * # 並び（上から）
 *
 * ゲーム → 作品名 → 作者の行 → 操作の行 → 概要欄 → このゲームからのフォーク。右カラムに関連作品（{@link relatedSection}）。
 * 分けるのは器の `.gf-split-end`（`public/assets/app.css` の `@section shell`）で、段 3 でだけ右に並び、狭い段では
 * 本文の下へ積む（HTML の順が縦の順）。**借りるのは配置だけで、見た目は仕様 2.5 のまま**（無彩色・面で区切る）。
 *
 * # 3.4-5 の「ロード中画面」を置き換えた
 *
 * #30 以来、ゲームの枠の手前に 4 要素のブロック（スクリーンショット・作者・元ゲーム・改造する）を置いていた。
 * **#665 でゲームを最上段へ上げ、サムネイルをなくした**（スクリーンショットとゲーム画面で同じ絵を 2 回見せていた）。
 * 作者と「フォークする」は作品名の下の作者の行へ、元ゲームは概要欄へ移した。
 *
 * **タッチ端末では、ゲームの位置にスクリーンショットと「遊ぶ」を出す**（M14-3 / #502 の覆いの口。`src/work-play.ts`）。
 * デスクトップと JavaScript の無い形では口を隠し、同じ位置に埋め込みが入る（`.gf-watch-player`。下書きの試遊の口と同じ規則）。
 *
 * # JavaScript を要求しない
 *
 * 「フォークする」「共有」「…」「もっと見る」はどれも `<details>` / `<summary>` で開く（このモジュール冒頭の方針）。
 *
 * @param view 表示に必要な値
 * @returns HTML
 */
function watchSection(view: WorkPageView): string {
  const player =
    view.playUrl === null
      ? '<p class="gf-block">遊ぶための URL を組み立てられませんでした。</p>\n'
      : `<div class="gf-watch-player">
${playEntry(screenshot(view), true)}
</div>
${playScript(view)}${playEmbed(view.playUrl, view.workId, view.inputKeyCodes, view.inputHeldCodes, view.inputAliasGroups, view.playOrientation)}`;
  // **操作の案内は枠の直後に置く**（#599 / 仕様 3.9.11。遊んで手が止まったときに目が落ちる位置）。
  const main = `${player}${keyLegendSection(view)}
<h1 class="gf-watch-title">${escapeHtml(workNameOf(view))}</h1>
${authorRow(view)}
${actionsRow(view)}
${overviewSection(view)}${reportSection(view)}
${forkList(view.forks)}`;
  const related = relatedSection(view);
  if (related === '') {
    return `<div class="gf-watch-main">
${main}
</div>`;
  }
  return `<div class="gf-split-end gf-watch">
<div class="gf-watch-main">
${main}
</div>
${related}
</div>`;
}

/**
 * 作者の行（#665。YouTube のチャンネルの行）。**アイコン・名前・運営の印と、主のボタン「フォークする」。** 作者には「編集する」も出す。
 *
 * - **名前は作者ページへのリンク**（#330 の {@link authorLabel}。印はリンクの外。#334）
 * - **「フォークする」は `<details>` で、押すまで入力欄は閉じている**（#665 の acceptance）。開くと行のすぐ下に入力欄が出る
 * - **「編集する」は作者にだけ出す**（#664 で題名の直下に仮置きしていたものを、ここへ移した）。**下書きのプレビューでは出さない**
 *   （帯の「編集へ戻る」が同じ行き先を持つ）
 *
 * @param view 表示に必要な値
 * @returns HTML
 */
function authorRow(view: WorkPageView): string {
  const avatar =
    view.authorAvatarUrl === null || view.authorAvatarUrl === undefined
      ? ''
      : `<span class="gf-avatar" aria-hidden="true">${avatarImage(view.authorAvatarUrl)}</span>`;
  const edit =
    view.draftPreview === true || view.editPath === null || view.editPath === undefined
      ? ''
      : `<a class="gf-work-edit-link ${SECONDARY_BUTTON} gf-button-sm" href="${view.editPath}">編集する</a>`;
  const fork = forkCta(view);
  // **開く「フォークする」（`<details>`）は行の外、行のすぐ後ろに置く**（利用者の決定。PR #674）。行の中に置くと、開いた欄が
  // 作者名の右の列に広がり、作者名が縦の真ん中へずれた。**開く側（`<summary>`）だけを行の右端へ重ねる**（`.gf-watch-byline`）
  // ので、閉じているあいだの見た目は行の中にあるのと同じで、開いた欄は行の下に横幅いっぱいで出る。
  const opens = fork.startsWith('<details');
  const note =
    view.draftPreview !== true && !view.signedIn
      ? '\n<p class="gf-fork-note">フォークには招待が必要です。招待コードをお持ちでない方は待機リストにご登録いただけます。</p>'
      : '';
  return `<div class="gf-watch-byline">
<div class="gf-watch-author${opens ? ' gf-watch-author-forkable' : ''}">
<p class="gf-author">${avatar}<strong>${authorLabel(view)}</strong>${operatorMark(view)}</p>
${edit}${opens ? '' : fork}
</div>${opens ? `\n${fork}` : ''}
</div>${note}`;
}

/**
 * 操作の行（#665。YouTube の高評価・共有・「…」）。いいね・共有・「…」メニュー（通報・ソースコードを見る）。
 *
 * **どれも出すものが無ければ行ごと出さない。**
 *
 * @param view 表示に必要な値
 * @returns HTML（空なら空文字）
 */
function actionsRow(view: WorkPageView): string {
  const share =
    view.shareUrl === null
      ? ''
      : `
<details class="gf-watch-share">
<summary class="${SECONDARY_BUTTON} gf-button-sm">共有</summary>
<div class="gf-work-share">
<p class="gf-work-share-label">共有する URL</p>
<p class="gf-block gf-work-share-url"><code>${view.shareUrl}</code></p>
</div>
</details>`;
  const inner = `${likeSection(view)}${share}${moreMenu(view)}`;
  return inner === '' ? '' : `<div class="gf-watch-actions">${inner}
</div>`;
}

/**
 * 「…」メニュー（#665）。**通報とソースコードの表示を、いまと同じ経路で開く**（通報は `POST /api/works/report`、
 * ソースは `/source/<id>`）。`<details>` で開くので JavaScript を要求しない。
 *
 * **本文の上に浮かぶ小さなメニューにする**（利用者の決定。PR #674。`public/assets/app.css` の `.gf-watch-more-menu`）。
 * 項目は「ソースコードを見る」「この作品を通報する」の 2 行だけで、通報のフォームはメニューの外（概要欄の下の
 * {@link reportSection}）で開く——メニューの中でフォームを開くと、本文を押し下げる。
 *
 * **中身が無ければ出さない**（押しても空のメニューを出さない。4.4）——未ログインで、ソースを見せない作品のとき。
 *
 * @param view 表示に必要な値
 * @returns HTML（空なら空文字）
 */
function moreMenu(view: WorkPageView): string {
  const items: string[] = [];
  if (view.details !== null && view.details.sourcePath !== null) {
    items.push(`<li><a class="gf-link-quiet" href="${view.details.sourcePath}">ソースコードを見る</a></li>`);
  }
  // **通報のフォームはメニューの中に開かない**（利用者の決定。PR #674）。項目は口（概要欄の下の `<details>`）へ飛ぶだけで、
  // フォームはそこで開く。**押しても通報できない人（未ログイン・作者・通報済み）には項目を出さない**（4.4）。
  if (view.reportableId !== null) {
    items.push(`<li><a class="gf-link-quiet" href="#${WORK_REPORT_ANCHOR}">この作品を通報する</a></li>`);
  }
  if (items.length === 0) {
    return '';
  }
  return `
<details class="gf-watch-more">
<summary class="${SECONDARY_BUTTON} gf-button-sm" aria-label="その他の操作">…</summary>
<ul class="gf-watch-more-menu">
${items.join('\n')}
</ul>
</details>`;
}

/**
 * 概要欄（#665。YouTube の視聴回数・日時・ハッシュタグ・説明・「もっと見る」）。
 *
 * **見えている行: プレイ数・公開日時・タグ。「もっと見る」で開く中身: 遊び方（作者の説明）・元ゲーム・作品の情報。**
 * プレイ数は 0 なら出さない（2.3.6）。**説明を 2 か所に出さない**（#626 の「二重に出さない」。#627 の枠の直前の折りたたみは
 * この欄へ畳んだ）。
 *
 * @param view 表示に必要な値
 * @returns HTML
 */
function overviewSection(view: WorkPageView): string {
  const meta: string[] = [];
  if (view.playCount > 0) {
    meta.push(`<span class="gf-plays">プレイ ${view.playCount} 回</span>`);
  }
  const published = view.details === null ? null : timeElement(view.details.publishedAt);
  if (published !== null) {
    meta.push(`<span>${published}</span>`);
  }
  const metaLine = meta.length === 0 ? '' : `\n<p class="gf-watch-meta">${meta.join('')}</p>`;
  const details = view.details === null ? '' : `\n${detailsPanel(view, view.details)}`;
  return `<section class="gf-watch-overview gf-block" aria-label="概要">${metaLine}${tagsSection(view)}
<details class="gf-watch-overview-more">
<summary>もっと見る</summary>${descriptionSection(view)}
<p class="gf-parent">${parentLine(view.parent)}</p>${details}
</details>
</section>`;
}

/** 関連の種類ごとの札（押せない札。仕様 2.5.5 のチップ）。 */
const RELATION_LABELS: Readonly<Record<RelatedWork['relation'], string>> = {
  parent: 'フォーク元',
  fork: 'この作品のフォーク',
  tag: '同じタグ',
};

/**
 * 関連作品（#665。YouTube の右カラムの関連動画）。**フォーク元 → フォーク先 → 同じタグ**の順（`src/related-works.ts`）。
 *
 * **1 件も無ければ出さない**（空のカラムを置かない。本文だけの 1 段になる）。題名と作者名は UGC なので `escapeHtml` を通す。
 * 画像は撮れた作品だけ `<img>`（同一オリジンの `/ogp/<id>.png`）、撮れていなければ固定の文言のパネル（壊れた画像を出さない）。
 *
 * @param view 表示に必要な値
 * @returns HTML（出さないなら空文字）
 */
function relatedSection(view: WorkPageView): string {
  const related = view.related ?? [];
  if (related.length === 0) {
    return '';
  }
  const items = related
    .map((work) => {
      const shot = work.hasImage
        ? `<img class="gf-shot gf-related-shot" src="${ogpImagePath(work.id)}" width="${OGP_IMAGE_WIDTH}" height="${OGP_IMAGE_HEIGHT}" alt="" loading="lazy">`
        : '<span class="gf-shot gf-shot-pending gf-related-shot">画像はまだありません</span>';
      const author = work.authorName === null ? '' : `<span class="gf-related-author">${escapeHtml(work.authorName)}</span>`;
      return `<li class="gf-related-${work.relation}"><a class="gf-related-link gf-link-quiet" href="${workPagePath(work.id)}">${shot}<span class="gf-related-body"><span class="gf-related-title">${escapeHtml(work.title)}</span>${author}<span class="gf-chip">${RELATION_LABELS[work.relation]}</span></span></a></li>`;
    })
    .join('\n');
  return `<aside class="gf-related" aria-labelledby="gf-related-heading">
<h2 id="gf-related-heading">関連作品</h2>
<ol class="gf-related-list">
${items}
</ol>
</aside>`;
}

/**
 * Wasm のバイト数を読める大きさにする（#383）。
 *
 * **10 進の単位（1 MB = 1,000,000 バイト）で、小数 1 桁。** `toLocaleString` を使わない
 * （ロケールで出力が変わる。`src/jst.ts` と同じ理由）。1 MB に満たなければ KB の整数で出す。
 *
 * @param bytes バイト数（正の整数）
 * @returns 表記
 */
export function formatWasmSize(bytes: number): string {
  if (bytes >= 1_000_000) {
    return `${(bytes / 1_000_000).toFixed(1)} MB`;
  }
  return `${Math.max(1, Math.round(bytes / 1_000))} KB`;
}

/**
 * 日時を `<time>` にする。**読めない値なら null**（`datetime=""` は不正。`src/work-card.ts` と同じ扱い）。
 *
 * @param epochSeconds UNIX 秒
 * @returns HTML、または null
 */
function timeElement(epochSeconds: number | null): string | null {
  if (epochSeconds === null) {
    return null;
  }
  const iso = toIsoTimestamp(epochSeconds);
  const shown = formatJstMinutes(epochSeconds);
  return iso === '' || shown === '' ? null : `<time datetime="${iso}">${shown}</time>`;
}

/**
 * 詳細情報パネル（2.3.12 / #383）。**作品の来歴を、項目名と値の組で並べる。**
 *
 * # 並べるもの
 *
 * 作品 ID / 生成日時 / 公開日時 / 元ゲーム / Wasm のサイズ / 改造された数 / いいね数。
 *
 * **#665 から、置き場は概要欄の「もっと見る」の中である**（{@link overviewSection}。右カラムは関連作品になった）。
 * **プレイ数は概要欄の見えている行へ、「ソースコードを見る」は操作の行の「…」メニューへ移した**（{@link moreMenu}）。
 *
 * - **モデル名は出さない。** 確定27 が「`generations.game_id` は結び付けない」と決めており、
 *   作品からモデルへ辿る経路が無い（#383 の訂正）。**確定27 は覆していない。**
 * - **説明（#388）はパネルに入れない。** 同じ「もっと見る」の中で、パネルの前に本文として出す。
 * - **プレイ数はパネルに並べない**（#665。概要欄の見えている行に出す——同じ数を 2 か所に出さない。#383 から #664
 *   まではここにだけ出していた）。**いいねの数はボタンの隣にも残る**——数とボタンは 5.8 の対であり、
 *   `test/liked-works.test.ts` が DO の障害時にボタンの側の数（D1 の写し）へ倒れることを見ている。パネルは来歴の一覧として
 *   **同じ値**（`likeCount`）を並べる。**0 のときは行ごと出さない**——2.3.6 / #340 の「0 を並べない」をパネルでも崩さない。
 * - **改造された数は 0 でも出す。** 本文の「このゲームからの改造: N 件」（5.5）と同じ値
 *   （`forks.total`。その場で数えた実件数で、`fork_count` 列は読まない）であり、あちらが 0 件を
 *   消さないのと揃える。
 * - **Wasm のサイズは、配信している圧縮後のバイト数である**（利用者の端末が実際に受け取る量）。
 *   索引が引けなければ行ごと出さない（分からない値を 0 と書かない）。
 *
 * # 項目名と値の並び（`.gf-kv`。#474 / 仕様 2.5.4）
 *
 * **1 行に項目名を左、値を右に置き、値が 1 行に収まらないときは値だけを項目名の下の行へ回す。** 値を途中で
 * 折り返さない（「2.3 MB（配信時の圧縮後）」が 2 行に割れると、どこまでが 1 つの値か読みにくい）。行ごとに
 * 「長い値」の印を付けない——折り返しは `.gf-kv` の flex の `wrap` だけで決まる。列より長い値（作品 ID の 36 文字）だけは、
 * 値の中で折る（`.gf-kv dd` の `overflow-wrap`）。
 *
 * > **#474 の前は項目名と値を縦に積んでいた**（16rem では横に並べると作品 ID が 1 文字ずつ折れる、という判断）。
 * > 2.5.4 の「値だけを下の行へ回す」で、その懸念は値を縮めない形で解けた。
 *
 * 面は概要欄（`.gf-watch-overview`。面のブロック）が持つので、パネル自身は面を持たない（面を二重に重ねない。2.5.4）。
 *
 * @param view 表示に必要な値
 * @param details パネルの値
 * @returns HTML
 */
function detailsPanel(view: WorkPageView, details: WorkDetails): string {
  const rows: string[] = [];
  const row = (label: string, value: string, className = ''): void => {
    const attr = className === '' ? '' : ` class="${className}"`;
    rows.push(`<div${attr}><dt>${label}</dt><dd>${value}</dd></div>`);
  };

  row('作品 ID', `<code>${escapeHtml(details.gameId)}</code>`);
  const created = timeElement(details.createdAt);
  if (created !== null) {
    row('生成日時', created);
  }
  const published = timeElement(details.publishedAt);
  if (published !== null) {
    row('公開日時', published);
  }
  row('元ゲーム', parentValue(view.parent));
  if (details.wasmBytes !== null) {
    row('Wasm のサイズ', `${formatWasmSize(details.wasmBytes)}（配信時の圧縮後）`);
  }
  row('フォークされた数', `${view.forks.total} 件`);
  if (view.likeCount > 0) {
    row('いいね', `${view.likeCount}`);
  }
  // **プレイ数はここに並べない**（#665。概要欄の見えている行に出す——同じ数を 2 か所に出さない）。

  // **#665 から、概要欄の「もっと見る」の中に置く**（右カラムは関連作品になった）。「ソースコードを見る」は「…」メニューへ
  // 移した（{@link moreMenu}）。
  return `<div class="gf-details" aria-labelledby="gf-details-heading">
<h3 id="gf-details-heading">作品の情報</h3>
<dl class="gf-kv">
${rows.join('\n')}
</dl>
</div>`;
}

/**
 * 作品のタグ（#376）。**誰にでも出す**（カードと同じ情報である）。
 *
 * **1 つずつ、そのタグで絞り込んだ一覧へのリンクにする**（カードと同じ行き先。
 * `src/work-card.ts` の `workTagListPath`）。**語彙に無い値は出さない**（{@link knownWorkTags}）。
 * タグ無しなら何も出さない（「タグはありません」を全作品に並べない。{@link descriptionSection} と
 * 同じ判断）。
 *
 * **1 つずつをチップ（`a.gf-chip`）にする**（#474 / 仕様 2.5.5。カードのタグと同じ部品）。区切りの「/」は
 * チップの間の余白に置き換えた。
 *
 * @param view 表示に必要な値
 * @returns HTML（出すタグが無ければ空文字）
 */
function tagsSection(view: WorkPageView): string {
  const tags = knownWorkTags(view.tags);
  if (tags.length === 0) {
    return '';
  }
  const links = tags.map((tag) => `<a class="gf-chip" href="${workTagListPath(tag.id)}">${tag.label}</a>`);
  return `
<p class="gf-work-tags"><span class="gf-work-tags-label">タグ</span>${links.join('')}</p>`;
}

/**
 * デスクトップで遊ぶ人に、その作品が読むキーを伝える 1 行（仕様 3.9.11 / M16-1 / #599）。**誰にでも出す。**
 *
 * # なぜ要るのか
 *
 * キーの集合は `source_input_keys` に記録済みだが（3.9.5）、それを使うのは仮想パッド（3.9.6）だけで、
 * **パッドはタッチ端末にしか出ない。** そのためデスクトップで遊ぶ人は、**作者が説明（#388）に書かない限り
 * 操作方法を知る手段が無かった。** 説明は任意の自由文なので、書かれていない作品では「遊べるが、どのキーが
 * 効くか分からない」状態になる。
 *
 * # 端末で出し分けない
 *
 * HTML に常に置く。タッチ端末では覆いが全画面を覆うので、**遊んでいるあいだは見えない**（3.9.4）。
 * **パッドの中には足さない**——押せる物（`<button>`）と押せない札を、同じ場所に並べない。
 *
 * # 札は押せない（チップ）
 *
 * `<span class="gf-chip">` を使う（仕様 2.5.5 の「チップ: 押せない札」）。パッドのキーが副のボタンの部品なのは
 * **押せるから**で、ここは読むだけである。**読み上げの名前（{@link padKeyAriaLabel}）も持たせない**——あれは
 * 押せる `<button>` の名前として要るものである。
 *
 * # 空なら何も出さない
 *
 * キーの記録が無い作品（行が無い・tombstone・壊れた JSON・マウスだけの作品）では 1 バイトも出さない
 * （{@link descriptionSection} と同じ判断。「操作: なし」を全作品に並べない）。
 *
 * @param view 表示に必要な値
 * @returns HTML（出すキーが 1 つも無ければ空文字）
 */
export function keyLegendSection(view: WorkPageView): string {
  const legend = keyLegendOf(view.inputKeyCodes);
  const keys = [...legend.directions, ...legend.buttons];
  if (keys.length === 0) {
    return '';
  }
  // **札の文字は許可表から決まる固定の文字列である**（`src/virtual-pad.ts` の `padKeyLabel`。UGC は 1 文字も
  // 混ざらない）。それでも `escapeHtml` を通すのは、`Backslash` → `\\`・`Quote` → `'` のように記号が入るためで、
  // **埋め込みの安全は埋め込む側で閉じる**（`src/work-play.ts` のパッドと同じ判断）。
  const chips = keys.map((key) => `<span class="gf-chip">${escapeHtml(key.label)}</span>`).join('');
  return `
<p class="gf-key-legend"><span class="gf-key-legend-label">操作</span>${chips}</p>`;
}

/**
 * 作者が書いた説明（#388）。**誰にでも出す**（公開済みの作品の本文の一部である）。
 *
 * # HTML として描かない
 *
 * **1 文字ずつ `escapeHtml` を通してから、改行だけを構造へ戻す。** 空行で段落を分け、
 * 段落の中の改行は `<br>` にする。**書式はそれだけである**（#388 の scope.out は
 * Markdown・リンク・改行以外の装飾を扱わない）。URL を書いてもリンクにならない
 * ——5.6 の外部リンクの緩和策（`rel` / スキームの制限）を、この欄へ持ち込まない。
 *
 * **エスケープの後で改行を置き換える**（順序に意味がある）。先に `<br>` を入れてから
 * エスケープすると `&lt;br&gt;` になり、エスケープの前に利用者の `<br>` を残す形は
 * 作らない。
 *
 * # 空なら何も出さない
 *
 * 「説明はありません」を全作品に並べない（`likeSection` が 0 件を出さないのと同じ判断）。
 *
 * @param view 表示に必要な値
 * @returns HTML（説明が無ければ空文字）
 */
function descriptionSection(view: WorkPageView): string {
  if (view.description === null || view.description === '') {
    return '';
  }
  const paragraphs = view.description
    .split(/\n\s*\n/u)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph !== '')
    .map((paragraph) => `<p>${escapeHtml(paragraph).replace(/\n/gu, '<br>\n')}</p>`)
    .join('\n');
  // **見出しと段落を 1 つの塊に包む**（#474。本文の列は塊どうしの間を `gap` で空けるので、見出しと段落を
  // 別の塊にすると、その間まで塊どうしの間隔になる）。
  //
  // **この塊は折りたたみ（{@link overviewSection}）の中に入る**（#627 / 仕様 5.4）。見出しを残すのは、
  // **開いたときに「何の文章か」が分かるようにする**ためで、`<summary>`（「遊び方を読む」）とは役割が違う
  // ——あちらは押す前の案内、こちらは開いた後の見出しである。
  return `
<div class="gf-work-description">
<h3>作品の説明</h3>
${paragraphs}
</div>`;
}


/**
 * いいねの数と、付け外しのボタン（5.8 / #340）。
 *
 * # 数は 0 のときに出さない
 *
 * 2.3.6 が `fork_count` について決めたのと同じ扱いである。**「いいね 0」が全作品に
 * 並ぶ状態は、区別を何も運ばない**うえに、押していないことを責める文字列になる。
 * 系統の「このゲームからの改造: 0 件」を消さないのとは判断が違う——あちらは親の
 * 1 行と対になっており、**片方だけが無いと「機能が無い」と読める**（{@link forkList}）。
 * いいねにはその対が無い。
 *
 * # 押せない人にはボタンを出さない（4.4）
 *
 * **未ログインの閲覧者と作者にはフォームが 1 バイトも出ない。** 判定は窓口が
 * 済ませてあり（{@link WorkPageView.likableId}）、ここでは `null` かどうかだけを見る。
 * **無効化した `<button disabled>` を出す形も採らない**——4.4 が無くそうとしている
 * のは「押しても動かないボタン」そのもので、無効化はその見た目を残す（1.2.38 の
 * #24 が同じ判断をしている）。
 *
 * # 二重送信を JavaScript で防がない
 *
 * 口は冪等である（5.8。既に押していれば何もしない）。**だから連打で壊れるものが無く、
 * ボタンを止める必要も無い。** POST-redirect-GET で戻ってきた画面は、押した側の
 * フォームだけを持つ。
 *
 * @param view 表示に必要な値
 * @returns HTML。数もボタンも無ければ空文字
 */
function likeSection(view: WorkPageView): string {
  // **いいねの数はボタンの隣に残す**（#340 / 5.8。数とボタンは対である）。**プレイ数は詳細情報パネル
  // （{@link detailsPanel}）へ移した**（#383。#377 まではここにあった）——プレイ数には押す操作が無く、
  // ボタンの隣に置く理由が無い。0 のときは出さない（2.3.6）。
  const count =
    view.likeCount > 0 ? `\n<p class="gf-likes">いいね ${view.likeCount}</p>` : '';

  // **2 つが同時に非 null になる経路は無い**（窓口は「押しているか」で振り分ける）。
  // それでも `else if` で書くのは、**含意に寄りかからない**ためである（両方が
  // 入ってきたときにフォームを 2 つ描くより、付ける側だけを出すほうが害が小さい）。
  const form =
    view.likableId !== null
      ? likeForm(LIKE_PATH, LIKE_GAME_ID_FIELD, view.likableId, 'いいね')
      : view.unlikableId !== null
        ? likeForm(
            LIKE_CANCEL_PATH,
            LIKE_CANCEL_GAME_ID_FIELD,
            view.unlikableId,
            'いいねを取り消す',
          )
        : '';

  // **数とボタンを 1 行に並べる**（#474。承認したモックアップの形。並びは数 → ボタンのまま）。どちらも無ければ何も出さない。
  const inner = `${count}${form}`;
  return inner === '' ? '' : `\n<div class="gf-work-like">${inner}\n</div>`;
}

/**
 * いいねのフォーム 1 つ（5.8）。
 *
 * **素の `<form method="post">` である**（このモジュール冒頭の「JavaScript を要求
 * しない」）。終わったら窓口が作品ページへ 303 で戻す。
 *
 * @param action 送り先（`src/like-paths.ts` の綴り）
 * @param field 作品 id を載せる項目名（**口ごとに別の定数**。5.8）
 * @param gameId 作品
 * @param label ボタンの文言
 * @returns HTML
 */
function likeForm(action: string, field: string, gameId: string, label: string): string {
  return `
<form class="gf-like" method="post" action="${action}">
  <input type="hidden" name="${field}" value="${gameId}">
  <button type="submit" class="${SECONDARY_BUTTON} gf-button-sm">${label}</button>
</form>`;
}

/**
 * 「このゲームからの改造: N 件」（5.5 / M5-3 / #34）。
 *
 * # 件数は必ず出す
 *
 * **0 件でも見出しを消さない。** 5.5 は親の 1 リンクと子の一覧を対で定めており、
 * 「元ゲーム: ありません（この作品がオリジナルです）」を出しているのに、下側だけ
 * 何も無いと**「まだ誰も改造していない」と「機能が無い」を読み手が区別できない**
 * （{@link watchSection} の「無いときは、無いことを言う固定文言へ倒す」と同じ規則）。
 *
 * # 枠の**下**に置く
 *
 * 3.4-5 の 4 要素は iframe より前に置くと決まっている（{@link watchSection}）。
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
  const heading = `<p class="gf-forks">このゲームからのフォーク: ${forks.total} 件</p>`;

  // **「もっと見る」も「前へ」も素のリンクである**（このモジュール冒頭の「JavaScript を
  // 要求しない」）。次が無ければ出さない——押しても何も起きない導線を出さない
  // （4.4。押しても何も起きない導線を出さない）。
  const more =
    forks.morePath === null
      ? ''
      : `\n<p class="gf-forks-more"><a class="${SECONDARY_BUTTON} gf-button-sm" href="${forks.morePath}">もっと見る</a></p>`;
  const back =
    forks.backPath === null
      ? ''
      : `\n<p class="gf-forks-back"><a class="${SECONDARY_BUTTON} gf-button-sm" href="${forks.backPath}">前へ</a></p>`;

  // **条件付きにしてよいのは `<ul>` だけである。** 一覧が空でも頁送りは落とさない
  // ——落とすと、空の頁を引いた読み手の戻る道が URL の手編集しか無くなる。
  // 通常この枝へ来るのは総数 0 のとき（どちらのパスも null）だが、**その含意に
  // 寄りかからない。**
  //
  // **#474: 塊を 1 つに包み、一覧はブロックの行、題名は文章の外のリンク、頁送りは小さい副のボタンにした**
  // （仕様 2.5.4 / 2.5.5）。
  if (forks.items.length === 0) {
    return `<div class="gf-work-forks">
${heading}${back}${more}
</div>`;
  }

  const items = forks.items
    .map(
      (child) =>
        `<li><a class="gf-link-quiet" href="${workPagePath(child.id)}">${escapeHtml(child.title)}</a></li>`,
    )
    .join('\n');
  return `<div class="gf-work-forks">
${heading}
<ul class="gf-fork-list gf-block gf-block-rows">
${items}
</ul>${back}${more}
</div>`;
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
 * 押しても何も起きないボタンを出さない（4.4。押しても何も起きない導線を出さない）。**押した結果を
 * 決めるのは `reclaimStaleOgpCapture` の SQL** で、ここは口を出すかだけを決める。
 *
 * @param view 表示に必要な値
 * @returns HTML
 */
export function recaptureSection(view: WorkPageView): string {
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
  <button type="submit" class="${SECONDARY_BUTTON}">スクリーンショットを撮り直す</button>
</form>`;
}

/**
 * 「改造する」の文言（2.2-4）。**仕様の言い回しをここで言い換えない。**
 */
const FORK_LABEL = 'フォークする';

/**
 * 作者名を組み立てる（#330 / 仕様 2.3.1）。
 *
 * # 名前そのものをリンクにする
 *
 * **作品カードと同じ形にする**（`src/work-card.ts` の `renderAuthor`）。**同じ操作に
 * 2 つの見せ方を作らない**——カードで名前が押せるのを覚えた利用者が、作品ページで
 * 押せない名前に当たる形にしない。
 *
 * **ラベル付きのリンク（「この作者の作品」）を別に置く案は採らなかった。** 名前が
 * 既にリンクなら、**同じ行き先が 1 行に 2 つ並ぶ**ことになる（読み上げでも同じ
 * 行き先が 2 度読まれる。`public/assets/app.css` の `.gf-card-link` が
 * 「画像と題名を別々のリンクにしない」と書いているのと同じ理由）。
 *
 * # `<a>` は `<strong>` の内側、印は両方の外に置く
 *
 * **#334 の印は `<strong>`（利用者が決めた名前）の外にある**（{@link operatorMark}）。
 * リンクを `<strong>` の内側へ入れることで、**印はリンクの外でもあり続ける**
 * ——押した先が作者ページになる印を作らない。名前は今までどおり `escapeHtml` を通り、
 * **リンクの中身は名前だけ**である。
 *
 * `<strong>` を `<a>` の内側へ入れ替えないのは、**印の位置を説明する軸を
 * 「`<strong>` の内か外か」から動かさない**ためである（5.9 が「名前の側から印の
 * 見え方を動かせてはいけない」と書いている行であり、構造の説明を増やさない）。
 *
 * # 名前が引けていなければリンクにしない
 *
 * {@link WorkPageView.authorPageId} の説明のとおり、404 へ送るリンクを出さない。
 *
 * @param view 表示に必要な値
 * @returns HTML（`<strong>` の中身）
 */
function authorLabel(view: WorkPageView): string {
  const name = escapeHtml(view.authorName ?? UNKNOWN_AUTHOR);
  if (view.authorPageId === null) {
    return name;
  }
  // **文章の外のリンクの見せ方にする**（#474 / 仕様 2.5.5）。下線はホバーと焦点だけで、太字は外側の `<strong>` が持つ。
  return `<a class="gf-author-link gf-link-quiet" href="${authorPagePathFor(view.authorPageId, view.authorHandle)}">${name}</a>`;
}

/**
 * 作者が運営であることを示す印の文言（#334）。
 *
 * **固定文言である。利用者の入力を 1 文字も混ぜない**——混ぜれば、印そのものが
 * 名乗りになる。テストが同じ綴りを見るために export している（書き写さない）。
 */
export const OPERATOR_MARK = '運営アカウント';

/**
 * 作者名の隣に置く、運営の印（#334）。運営でなければ空文字列を返す。
 *
 * # 名前の外に置く
 *
 * 印は `<strong>`（利用者が決めた名前）の**外**に置く。名前は `escapeHtml` を通るので、
 * 名前の入力からこの要素を作ることはできない。**名前に「運営」と書いた利用者の画面には、
 * この要素が 1 つも現れない。**
 *
 * **#330 で名前が作者ページへのリンクになったが、印の位置は動いていない。** リンクは
 * `<strong>` の内側に入れてあるので（{@link authorLabel}）、印は `<strong>` の外であり、
 * **リンクの外でもある**——押した先が作者ページになる印は作れない。
 *
 * # 見分けは見た目で付ける
 *
 * 表示名は利用者が自由に決められ、語の制限も無い（5.9）。**文字の並びは名前で真似
 * できる**ので、印の文言に括弧などの飾りを足しても見分けにはならない。見分けは
 * `public/assets/app.css` の `.gf-operator`（枠と地を持つバッジ）が付ける——クラスを
 * 持ち込めるのはこの関数だけで、名前の側からは持ち込めない。
 *
 * # 立っていない作者には 1 バイトも足さない
 *
 * 既定値 0 のままの作者（既存の作品すべて）では、この行は #334 の前と同じ文字列になる。
 *
 * @param view 表示に必要な値
 * @returns HTML
 */
function operatorMark(view: WorkPageView): string {
  if (!view.authorIsOperator) {
    return '';
  }
  // **見た目はチップ**（#474。仕様 2.5.5 の表「チップ: 押せない札」）。枠と地は `.gf-operator` も自分で持つ
  // （`@section work`。チップの部品の値が変わっても、名前の文字では作れない差を失わない）。
  return ` <span class="gf-chip gf-operator">${OPERATOR_MARK}</span>`;
}

// 作者名を引けなかったときの表示（**空欄にしない**）は `src/work-card.ts` が持つ。
// **一覧・トップ・作者ページと同じ名前を出す**ため、綴りを 2 つにしない（#328）。

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
    // **下書きのプレビュー（#664）では撮っていない**（撮るのは公開したとき。5.4）。準備中と言わない。
    if (view.draftPreview === true) {
      return DRAFT_PLAY_PANEL;
    }
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
  return `元ゲーム: ${parentValue(parent)}`;
}

/**
 * 「元ゲーム」の値の部分（{@link parentLine} と詳細情報パネルが共有する。#383）。
 *
 * **言い回しを 2 か所に持たない。** パネルの行とロード中画面の 1 行が別々の文言を持つと、
 * 同じ作品について 2 通りのことを言う。
 *
 * @param parent 親作品
 * @returns HTML
 */
function parentValue(parent: ParentWork): string {
  switch (parent.kind) {
    case 'none':
      return 'ありません（この作品がオリジナルです）';
    case 'published':
      return `<a href="${parent.path}">${escapeHtml(parent.title)}</a>`;
    case 'unlisted':
      return 'まだ公開されていない作品から派生';
    case 'removed':
      return '削除済みの作品から派生';
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
 * 「1 つも条件付きにしない」のが {@link watchSection} の規則であり、**枠の状態で
 * 要素そのものが消える形にしない。**
 *
 * @param view 表示に必要な値
 * @returns HTML
 */
function forkCta(view: WorkPageView): string {
  // **下書きのプレビュー（#664）では出さない**（2026-09-18 の利用者の決定。PR #671）。下書きはフォークの親になれない（5.3）。
  if (view.draftPreview === true) {
    return '';
  }
  // **この画面の主のボタンはここの 1 つだけである**（#474 / 仕様 2.5.5「1 画面に 1 つまで」）。未ログインは移動なので `<a>`、
  // ログイン済みは開くだけの `<summary>`（#665。押すまで入力欄は閉じている）。
  if (!view.signedIn) {
    return `<a class="gf-fork-link ${PRIMARY_BUTTON}" href="${signupPathFrom('fork-cta')}">${FORK_LABEL}</a>`;
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
  //
  // **送信のボタンは副にする**（#665）。主は開く側の「フォークする」で、1 画面に 1 つまで（2.5.5）。
  const form =
    view.forkableId === null || view.dailyRemaining === 0
      ? ''
      : `
<form method="post" action="${FORK_PATH}">
  <input type="hidden" name="${FORK_PARENT_ID_FIELD}" value="${view.forkableId}">
  <label for="fork-prompt">どう変えてフォークしますか</label>
  <textarea id="fork-prompt" name="${FORK_PROMPT_FIELD}" rows="3"
            maxlength="${MAX_PROMPT_LENGTH}" required
            placeholder="例: 玉の色を赤にして、敵を 2 体に増やす"></textarea>
  <button type="submit" class="${SECONDARY_BUTTON}">この内容でフォークする</button>
</form>`;

  // **押しても先へ進めないとき（本日の枠が尽きた）は、開く側も主にしない**（押せない主を置かない。4.4）。開けば理由と残数が読める。
  const strength = form === '' ? SECONDARY_BUTTON : PRIMARY_BUTTON;
  return `<details class="gf-fork-open">
<summary class="gf-fork ${strength}">${FORK_LABEL}</summary>
<div class="gf-fork-panel">
<p class="gf-fork-note">どう変えたいかを書くと、このゲームのソースをもとに新しい作品を作ります。
   <strong>1 回につき 1〜2 分かかり、生成枠を使います。${GENERATION_RETRY_QUOTA_NOTICE}</strong>元の作品はそのまま残ります。
   ${FORK_TIDY_QUOTA_NOTICE}</p>
${daily}${form}
</div>
</details>`;
}

/**
 * 作品が見つからないときの応答。
 *
 * **理由を分けない。** 「id の形が違う」「行が無い」「他人の作品だ」のどれであっても
 * 404 を返す。分けると、任意の id が存在するかを外から確かめられる手がかりになる
 * （`src/session-user.ts` が失敗の理由を返さないのと同じ考え方）。
 *
 * **ヘッダは出す。** 404 は行き止まりなので、**ここから出る道が要る**（2.3.7）——
 * ここは共有された URL を踏んだ人が着く 1 枚でもある。
 *
 * @param viewer いま見ている人の状態（2.3.7 のヘッダの出し分け）
 * @returns レスポンス
 */
function notFound(viewer: SiteViewer): Response {
  return html(
    `${siteHead({ title: '作品が見つかりません - Game Forge', noindex: true, viewer })}
<h1>作品が見つかりません</h1>
<p class="gf-block">URL が正しいかご確認ください。</p>
${siteFooter()}`,
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
 * D1 の `games.like_count` を、画面に出せる数へ落とす（5.8 / #340）。
 *
 * **列は `NOT NULL DEFAULT 0` だが、実行時の保証として扱わない**（1.2.50）。数でない値が
 * 来たときに `いいね undefined` と描くくらいなら、**0 に倒して何も出さない**ほうがよい
 * ——0 は「出さない」と同義なので、**倒した先の見た目が「いいねがまだ無い作品」と
 * 同じになる**（誤った数を出さない）。負の値も 0 へ倒す（同期は実数を上書きするので
 * 通常ありえないが、画面が「いいね -1」を描く余地を残さない）。
 *
 * @param value 引いた値
 * @returns 0 以上の整数
 */
export function storedLikeCount(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return 0;
  }
  return Math.floor(value);
}

/**
 * 索引から引いた Wasm のバイト数を、画面に出せる値へ落とす（#383）。
 *
 * **0 以下・数でない値は「出さない」（null）に倒す。** 「Wasm のサイズ 0 B」は嘘であり、
 * 分からないなら行ごと出さない（{@link storedLikeCount} が 0 へ倒すのと同じ考え方で、
 * 倒した先の見た目が「索引の無い作品」と同じになる）。
 *
 * @param value 引いた値
 * @returns 正の整数、または null
 */
export function storedWasmBytes(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return null;
  }
  return Math.floor(value);
}

/**
 * 作品の 1 行を、作品ページとエディットページのどちらのために組み立てるか（#664）。
 *
 * - `page` … 作品ページ（`/works/<id>`）。**作者にも作者以外と同じ画面を出す**——作者だけの値
 *   （版・リフォージ・改名・削除の口・失敗の分類・開示など）は引かず、渡さない。作者が下書きを開いたときだけ、
 *   公開後と同じ画面のプレビュー（{@link WorkPageView.draftPreview}）にする
 * - `edit` … エディットページ（`/works/<id>/edit`。`src/work-edit.ts`）。作者だけの値もすべて引く
 */
export type WorkViewMode = 'page' | 'edit';

/** {@link loadWorkView} の結果。 */
export type LoadedWork =
  /** 作品が無い（**id の綴りが違う・行が無い**。理由を分けない。{@link notFound}）。 */
  | { readonly kind: 'not-found'; readonly viewer: SiteViewer }
  | {
      readonly kind: 'found';
      /** 画面の入力。`page` なら作者にも作者以外と同じ値である（作者に足すのは `editPath` だけ）。 */
      readonly view: WorkPageView;
      /** 引いた行（エディットページが下書きの説明・タグ・試遊の鍵を読む）。 */
      readonly row: WorkRow;
      /** ログインした作者本人が見ているか。 */
      readonly owner: boolean;
      /** ヘッダの出し分け（2.3.7）。 */
      readonly viewer: SiteViewer;
    };

/**
 * 作品の 1 行を引き、画面の入力を組み立てる（#150 / #664）。
 *
 * **作品ページとエディットページが同じ 1 本を通る**（#664）。同じ行から同じ判定で組み立てるので、
 * 片方の画面だけが古い条件で口を出す、ということが起きない。違うのは {@link WorkViewMode} だけである。
 *
 * @param request 受信したリクエスト
 * @param env バインディングと環境変数
 * @param gameId 作品 id（綴りはここで確かめる）
 * @param mode どちらの画面のために組み立てるか
 * @returns 組み立てた入力、または見つからない
 */
export async function loadWorkView(
  request: Request,
  env: Env,
  gameId: string,
  mode: WorkViewMode,
): Promise<LoadedWork> {
  const url = new URL(request.url);
  const pathname = url.pathname;
  if (!GAME_ID_PATTERN.test(gameId)) {
    // **404 でもヘッダは出す**（{@link notFound}）。`resolveSiteViewer` は署名だけを見る
    // ので、**この経路で D1 は 1 行も読まない**（`resolveSessionUser` を前へ出すと読む）。
    return { kind: 'not-found', viewer: await resolveSiteViewer(request, env) };
  }

  // **1 回の問い合わせで引く。** 作者名も親作品も、ロード中画面（3.4-5）が
  // 必ず出す項目である。3 回に分けると、待ち時間を埋めるための画面が、それ自体
  // 3 往復ぶん遅くなる。
  //
  // **`users` は `left join` である。** `author_id` は NOT NULL の外部キーなので
  // 通常は必ず当たるが、当たらなかったときに**ページ全体を 404 にしない**
  // （作者名が引けないことと、作品が無いことは別である）。
  //
  // **`users` からは表示に要る 2 列だけを選ぶ**（表示名と運営の印。#334）。
  // `email` と `invited_by` は選ばない——前者は本人にしか出さない値で、後者は公開すると
  // 招待の連鎖が外から辿れる（仕様 2.3.6 の「出さないもの」）。選ばなければ、画面の側で
  // 書き間違えても漏れようがない。
  const row = await env.DB.prepare(WORK_ROW_SQL)
    .bind(gameId)
    .first<WorkRow>();
  if (row === null) {
    return { kind: 'not-found', viewer: await resolveSiteViewer(request, env) };
  }

  // **セッションは「本人か」を見るためだけに引く。** 未ログインでも 401 にしない
  // （状態は誰でも読める。モジュール冒頭の表）。
  const session = await resolveSessionUser(request, env);
  const owner = session.ok && session.userId === row.author_id;
  // **作者だけの値を引くのはエディットページのときだけである**（#664）。作品ページでは作者にも作者以外と
  // 同じものを出すので、版・リフォージの状態・遮断の分類を引く読み取りを増やさない（3.6 の読み取りがそのまま費用になる）。
  const ownerTools = owner && mode === 'edit';

  const now = Math.floor(Date.now() / 1000);
  const stalled = looksStalled(
    { createdAt: row.created_at, startedAt: row.generation_started_at },
    now,
  );
  const state = viewStateOf(row.generation_state, stalled);

  const published = row.status === PUBLISHED_STATUS;
  // **`!published` で代用しない**（5.3 / #35）。`draft` と `removed` は作者にできる
  // ことが正反対で、混ぜると取り下げた作品に「公開して共有」の口が出る。
  const removed = row.status === REMOVED_STATUS;
  // **作者が下書きを作品ページで開いたら、公開後と同じ画面のプレビューにする**（#664）。作者以外は
  // 未公開であることだけを読む（`unpublishedSection`。#690 から状態を言い分けない）。
  const previewing = mode === 'page' && owner && !published && !removed && state === 'ready';
  // **公開後の画面に出す値（作者名・元ゲーム・説明・数・詳細情報パネル）を渡すか。** プレビューでも渡す——
  // 公開すると誰にでも見えるものを、公開前に作者が確かめる画面だからである。**押せる口（フォーク・いいね・通報・
  // 計上）は `published` のまま**にする（下書きには押しても断られる）。
  const shown = published || previewing;

  // 5.7 の対象条件（自作・`draft`・完成済み）。**経路側と同じ条件をここで作り直して
  // いるように見えるが、判定の正本は `claimRevisionSlot` の SQL である**
  // （`src/revisions.ts`）。ここは「口を出すか」だけを決め、押した結果はあちらが決める。
  const revisableNow = ownerTools && !published && !removed && state === 'ready';

  // **引くのは遮断されたときの作者だけである**（8.2 / #37）。1 行の追加読み取りだが、
  // 遮断は例外的な出来事なので平常時は 1 度も起きない。**`generation_error` を見てから
  // 引く**——`moderation_blocks` を毎回 left join すると、遮断が無い日にも結合が走る。
  const blockedCategories =
    ownerTools && row.generation_error === 'prompt-blocked'
      ? await listBlockedCategories(env, gameId)
      : [];

  // **通報済みかは、通報できる立場の人にだけ引く**（8.4 / #40）。未ログイン・作者・
  // 未公開では読み取りが 1 件も増えない。
  const alreadyReported =
    published && !removed && session.ok && !owner
      ? await hasReported(env, gameId, session.userId)
      : false;

  // **作者のときだけ引く。** 公開作品のページは拡散の着地点であり、閲覧者ごとに
  // 版と枠を引く理由が無い（3.6 の読み取りがそのまま費用になる）。
  const revisions = ownerTools ? await listRevisions(env, gameId) : [];
  // **区切りは `looksStalled` と同じ `now` で測る**（#480）。
  const revisionQuota = ownerTools ? await revisionStatus(env, gameId, now) : null;

  // **枠を読むのは、その数を出す口が画面にあるときだけである**（3.6 の読み取りが
  // そのまま費用になる）。口は 2 つある——未公開の作者に出す推敲（5.7）と、公開済みの
  // 作品をログイン済みの誰かに出すフォーク（5.3）である。**後者は作者本人とは限らない**
  // ので、数えるのは行の作者ではなく**見ている人**の枠になる。
  //
  // **見ている人の枠を読む。** `revisableNow` は `owner`（＝ `session.userId` が
  // 作者）を含むので、推敲の場合もこの id は作者の id と同じ値になる。**行の
  // `author_id` を使わない**のは、フォークでは両者が違いうるためで、**同じ変数で
  // 両方を賄えることが「枠は 1 人あたり」（確定25）の裏返し**である。
  //
  // **下書きのプレビュー（#664）では読まない**——フォークの口を出さない（{@link forkCta}）。
  const forkableNow = published && session.ok;
  const dailyRemaining =
    session.ok && (revisableNow || forkableNow)
      ? await readDailyRemaining(env, session.userId)
      : null;

  // ── いいね（5.8 / #340）────────────────────────────────────────────────────
  //
  // **DO を呼ぶのはログイン中の公開作品のページだけである。** 未ログインの閲覧では
  // 1 度も呼ばず、上で既に引いてある `games.like_count` を読む（追加の問い合わせは
  // 0 件）。共有 URL を踏む閲覧者が大半であり、**閲覧数で DO の枠を減らさない**
  // （5.8「数の読み方と同期」。DO の枠は 1 日 10 万リクエストで、尽きれば止まるのは
  // いいねだけだが、尽くす必要が無い）。
  //
  // **取り下げた作品では呼ばない。** tombstone の画面に数もボタンも出さない——
  // 押せば窓口が 404 で断る（`PRESSABLE_GAME_SQL` は `status = 'published'`）。
  //
  // **届かなければ null が返る**（窓口が倒す。`src/likes.ts` の「読み取りが届かなくても、
  // 画面ごと落とさない」）。**未ログインと同じ枝に落ちる**——D1 の写しを出し、ボタンは
  // 出さない。**これは投げるより弱い扱いだが、正しい扱いである**: 5.8 は「DO の枠が
  // 尽きても止まるのはいいねだけである」と約束しており、**投げると、拡散の着地点が
  // ログイン中の利用者にだけ 500 になる**（止まるのがいいねだけでなくなる）。
  const likeViewer =
    published && !removed && session.ok
      ? await readLikeViewerState(env, session.userId, gameId)
      : null;

  // **押せるかどうかを画面で組み立てない。** 正本は窓口の SQL（`PRESSABLE_GAME_SQL`）で、
  // 公開済み・自作でない・8.4 の審査で止めていない、の 3 つを 1 本で見る。**同じ条件を
  // ここへ書き写すと、審査で止めた作品にボタンが出たまま口だけが 404 を返す**という
  // 食い違いになる（4.4 が無くそうとしているもの）。
  //
  // **読むのはログイン中の公開作品のときだけ**である（3.6 の読み取りがそのまま費用に
  // なる。未ログインでは押せる余地が無いので 1 行も引かない）。
  const pressable =
    published && !removed && session.ok
      ? await isPressableGame(env, session.userId, gameId)
      : false;

  // ── 削除の導線（#517 / M15-2）──────────────────────────────────────────────
  //
  // **作者本人にだけ出す。表示の条件は `deletionBlockOf` が持つ**（ここで `status` や `generation_state` を組み立てない）。
  // 消せるかどうかの正本は `deleteGame` の掴みの SQL で、押した先の口もそれに任せる。
  //
  // **リフォージは区切りの内側（`running`）と外側（`stalled`）の両方を「走っている」に数える。** `deleteGame` は
  // 経過時間で区切らないので、止まったジョブが残る作品に導線を出すと、押した先で必ず断られる。
  // **追加の問い合わせは 0 件**——`purged` は上の 1 行に、リフォージの状態は作者のときだけ引いた `revisionQuota` にある。
  const deletionBlock = ownerTools
    ? deletionBlockOf({
        status: row.status,
        generationState: row.generation_state,
        purged: row.purged === 1,
        revisionInFlight: revisionQuota !== null && (revisionQuota.running || revisionQuota.stalled),
      })
    : null;
  const deletable = ownerTools && deletionBlock === null;

  const view: WorkPageView = {
      state,
      // **作品ページでは作者にも偽を渡す**（#664）。作者だけの本文（失敗の分類・版・開示…）はエディットページが出す。
      owner: ownerTools,
      // **作者にだけ渡す。** 未ログインや他人には空配列を渡し、画面側で
      // `owner` を見直さなくても漏れない形にする（`errorCode` と同じ扱い）。
      ipNotice: ownerTools ? parseIpNotice(row.ip_notice) : [],
      blockedCategories,
      // 8.4 の通報（#40）。**押しても必ず断られるボタンを出さない**ので、条件を
      // ここで畳む（画面側で `owner && published && …` を組み立てない。5.7 の
      // 推敲欄が同じ形を避けている）。
      reportableId:
        published && !removed && session.ok && !owner && !alreadyReported ? gameId : null,
      alreadyReported,
      published,
      removed,
      // **中身を消した tombstone か**（#516 / #517）。取り下げ済みの表示の中で、作者本人に出す文だけを変える。
      purged: row.purged === 1,
      // **本人か、公開済みのときだけ出す。** 仮タイトルはプロンプト由来である
      // （モジュール冒頭）が、**公開そのものが「これを作品として出す」という
      // 作者の意思表示**である（5.4 は作者を唯一のフィルタとして使う）。
      // 未公開のあいだは、id を知っているだけの相手には見えないままにする。
      title: owner || published ? row.title : null,
      errorCode: ownerTools ? row.generation_error : null,
      // `ready` なら `preview_key` は必ず入っている（`src/games.ts` の不変条件）。
      // それでも null を扱えるようにしてあるのは、**不変条件を画面が前提にしない**ため。
      //
      // **公開後は id で引ける URL（`/g/`）へ切り替える。** プレビュー鍵は公開後も
      // 生きている（`/p/` は `removed` 以外を返す。5.4）が、**配る URL は 1 本でよい。**
      //
      // **取り下げた作品では試遊 URL も出さない**（#35）。`/p/` は
      // `status <> 'removed'` でしか引けない（`src/sandbox-delivery.ts`）ので、
      // 出せば作者本人が 404 を踏む。
      playUrl:
        published
          ? publishedUrl(request, env, gameId)
          : state === 'ready' && owner && !removed && row.preview_key !== null
            ? previewUrl(request, env, row.preview_key)
            : null,
      // **作品が読むキー（仕様 3.9.5 / 3.9.6 / #494）。許可表で絞ってから使う**（D1 の値を信じ切らない）。行が無い・
      // `source_key` が NULL・JSON が壊れているときは空で、パッドを出さない。追加の問い合わせは 0 件（上の 1 行の結合）。
      inputKeyCodes: readInputKeyCodes(row.input_codes),
      // **押し続けて読むキー（#528 / #530）。** 最初の形（スティック / 十字）を決める。版 1 の行・壊れた値は null で、十字で出す。
      inputHeldCodes: readHeldCodes(row.input_held_codes),
      // **同じ条件式で読むキーの組（#543）。** すでにボタンに出るキーと同じ働きの方向を、右のボタンに出さない。版 2 以下の行・壊れた値は null で、今のまま。
      inputAliasGroups: readAliasGroups(row.input_alias_groups),
      // **作品のおすすめの向き（#514）。** 論理解像度から決める。正方形・拾えなかった・版 3 以下の行（列が NULL）は null で、向きの操作をしない。
      playOrientation: playOrientationOf(row.input_layout_width, row.input_layout_height),
      workId: gameId,
      // 公開の操作を出すのは、**本人・完成済み・未公開**のときだけである。
      // （押せない・押しても何も起きないボタンを出さない。仕様 1.2.38 の #24 と同じ方針）
      //
      // **`removed` を除く**（#35）。押せば `publishGame` が `reason: 'removed'` で断る。
      //
      // **これは第 2 層である。** 画面側の第 1 層は `sectionFor` の tombstone 分岐で、
      // そちらが先に本文ごと差し替える。**したがってこの条件だけを外しても画面は
      // 変わらない**（変異を当てて確かめた）。**両方を外すと `test/work-page.test.ts`
      // が赤くなる**ので、層が 1 枚になった状態は残らない。
      publishableId: ownerTools && !published && !removed && state === 'ready' ? gameId : null,
      // フォークの親になれるのは**公開済みの作品だけ**である（5.3）。**作者かどうかは
      // 見ない**（5.7 の「公開後に手を入れたい作者はフォークする」）。押した結果を
      // 決めるのは `src/fork.ts` の `readParentSource` で、ここは口を出すかだけを決める。
      forkableId: published ? gameId : null,
      // **要求された URL をそのまま写さない。** 問い合わせ文字列（`?utm_source=` など）が
      // 付いた URL を `og:url` に出すと、同じ作品が別の URL として拡散する。
      // 正規の綴りを組み立て直す。
      shareUrl: shown ? new URL(workPagePath(gameId), request.url).toString() : null,
      // **`ready` のときだけ URL を出す。** 撮影中・失敗のときに URL を出すと、
      // クローラが 404 を引く（`src/ogp.ts` の配信は行と実体の両方を見る）。
      imageUrl: published && row.ogp_state === 'ready' ? ogpImageUrl(request, gameId) : null,
      // 画面に貼るほうは同一オリジンの絶対パスでよい（`WorkPageView.imagePath`）。
      // **条件はメタタグと同じものを使う。** 別々に書くと、片方だけが 404 を引く。
      imagePath: published && row.ogp_state === 'ready' ? ogpImagePath(gameId) : null,
      // **公開済みのときだけ出す。** 未公開の作品ページは作者のための状態画面で、
      // そこに作者名を出しても意味が無い（見ているのは本人か、id を知る誰かである）。
      authorName: shown ? row.author_name : null,
      // **作者ページへの導線（#330 / 2.3.1）。`authorName` と同じ条件で出す**
      // ——未公開の作品ページは作者のための状態画面で、名前を出さない画面に名前の
      // リンクだけを置く意味が無い（運営の印が同じ条件を採っているのと同じ理由）。
      //
      // **結合が空振りしたら出さない。** `author_id` は NOT NULL の外部キーなので
      // 行は常にあるはずだが、**無かったときにリンクだけが残ると 404 へ送る。**
      // 判定を `author_name` で行うのは、それが「`users` の行が引けたか」そのもの
      // だからである。
      authorPageId: shown && row.author_name !== null ? row.author_id : null,
      // いまのハンドル名（#381）。**`authorPageId` と同じ条件で渡す**（リンクを出さない画面に綴りだけを渡さない）。
      authorHandle: shown && row.author_name !== null ? row.author_handle : null,
      // **運営かどうかは列だけで決める**（#334）。`author_name` を見ない——表示名は
      // ログインのたびに Google の名前で上書きされ、5.9 以後は誰でも「運営」と名乗れる。
      // なぜ導出せず列で持つのかは `migrations/0021_users_operator.sql` にある。
      //
      // **`=== 1` で読む。** 結合が空振りした null を「運営」へ倒さない。0 と 1 以外は
      // CHECK が入れさせない。印は名前に付くものなので、名前を出さない未公開のときは
      // 出さない（`authorName` と同じ条件）。
      authorIsOperator: shown && row.author_is_operator === 1,
      parent: parentWorkOf(row),
      // **公開済みのときだけ引く**（3.6 の読み取りがそのまま費用になる）。フォークの
      // 親になれるのは公開済みの作品だけなので（5.3）、未公開の行に公開済みの子は
      // 現れない。**2 回の問い合わせは、子が 1 件も無ければ 1 回で終わる。**
      forks: shown ? await forkNeighborsOf(env, gameId, readForksOffset(url)) : NO_FORKS,
      signedIn: session.ok,
      // **走っているあいだは口を出さない。** 二重送信をボタンの無効化ではなく
      // 「フォームが無い」ことで防ぐ（JavaScript を要求しない）。
      revisable:
        revisableNow && revisionQuota !== null && !revisionQuota.running,
      dailyRemaining,
      revisionRunning: revisionQuota?.running ?? false,
      revisionStalled: revisionQuota?.stalled ?? false,
      revisionError: revisionQuota?.failed ?? null,
      revisions,
      // **撮影が中断したまま残ったときだけ、作者に口を出す**（5.4 / #235）。
      // 期限切れかどうかの判定は `src/ogp.ts` が持つ——ここで `now - x >= 900` と
      // 書くと、掴み直せるかを決める SQL と食い違いうる。
      recapturableId:
        ownerTools &&
        published &&
        ogpCaptureIsStale(
          { state: row.ogp_state, startedAt: row.ogp_started_at, publishedAt: row.published_at },
          now,
        )
          ? gameId
          : null,
      // **改名できるのは、本人・完成済み・取り下げていない作品である**（5.4 / #366）。
      // **公開の前後を問わない**（題名は未公開でも本人に見えており、公開後は
      // `og:title` として外へ出る）。押した結果を決めるのは `renameGame` の SQL で、
      // ここは口を出すかだけを決める。
      //
      // **`state === 'ready'` を条件に入れる。** 生成中の行にも仮の題は入っているが、
      // その画面は「生成中です」だけを出す場所で、**まだ何ができたかも分からない作品に
      // 名前を付け直させない**（推敲の口が同じ理由で `ready` を見ている）。
      renamableId: ownerTools && !removed && state === 'ready' ? gameId : null,
      // **説明は公開済みと、作者の下書きのプレビューのときだけ渡す**（#388 / #664）。**下書きの説明は作者にしか
      // 見せない**（#673 からはエディットページで下書きにも書ける）。取り下げた作品の画面は本文ごと差し替わる
      // （`shown` は `removed` を含まない）。
      description: shown ? (row.description ?? '') : null,
      // **書けるのは、本人・公開済み・完成済みの作品である**（#388）。押した結果を決めるのは
      // `describeGame` の SQL で、ここは口を出すかだけを決める。**未公開の作品に出さない**
      // ——5.4 の 1 タップの導線（公開までの画面）に入力欄を増やさない。
      //
      // **`published` は第 2 層である。** 描画側の第 1 層は、フォームを `watchSection`
      // にしか置いていないこと（#664 からは、説明の欄はエディットページにしか無い）。
      // **したがってここだけを外しても画面は変わらない**（変異を当てて確かめた）。経路の
      // 関門は `describeGame` の `status = 'published'` で、そちらを外すと
      // `test/work-description.test.ts` の「下書きの作品には書けない」が赤くなる。
      describableId: ownerTools && published && state === 'ready' ? gameId : null,
      // **tombstone 以外では渡す**（#376 / #637）。**公開をやめて下書きへ戻した作品はタグを持っており**、
      // 再公開のフォームがそれを選んだ状態で出す（#664 からはエディットページのタグの欄と、まとめて保存する口の公開。`src/work-save.ts`）——渡さないと、選び直さずに
      // 押した作者のタグが黙って消える（`src/games.ts` の `publishGame` の #637 注記）。一度も公開して
      // いない作品は 3 列とも NULL なので空配列になる。**tombstone の画面は本文ごと差し替わる**ので渡さない。
      tags: removed ? [] : workTagsOf(row),
      // **付け直せるのは、本人・公開済み・完成済みの作品である**（#376。説明と同じ条件）。押した
      // 結果を決めるのは `retagGame` の SQL で、ここは口を出すかだけを決める。
      retaggableId: ownerTools && published && state === 'ready' ? gameId : null,
      // **公開をやめられるのは、公開している作品だけである**（5.4 / 確定35 / #637）。
      // 押した結果を決めるのは `unpublishGame` の SQL で、ここは口を出すかだけを決める。
      unpublishableId: ownerTools && published ? gameId : null,
      // **削除の確認画面への導線（#517）は、表示の条件が null を返した本人にだけ出す**（上の `deletable`）。
      //
      // **公開中の作品に出さないことは 2 層で守る。** 第 1 層は描画側で、`watchSection` が `deleteSection` を
      // 呼ばない。第 2 層がここ（`deletionBlockOf` の `published`）。**片方だけを外しても作品ページは変わらない**
      // （変異を当てて確かめた。両方を外すと `test/work-delete.test.ts` の「公開中の作品には出さず」が赤になる）。
      deletableId: deletable ? gameId : null,
      // **止まったリフォージのせいで出せないときだけ、理由を 1 文出す**（{@link deleteSection}）。走っている最中は
      // 画面が「リフォージしています」を出して自動で更新するので、重ねて言わない。
      deletionStalledByRevision:
        ownerTools && deletionBlock === 'revising' && revisionQuota !== null && revisionQuota.stalled,
      // **ログイン中は DO が数えた実数、未ログインは D1 の写し**（5.8）。前者は
      // BAN された利用者の分を除いてあり、後者は最大 5 分遅れる。**未公開・取り下げ済みの
      // ページでは 0**（数を出さない）——`like_count` に値が残っていても、公開していない
      // 作品のいいねを画面に出す意味が無い。
      //
      // **`!removed` は第 2 層である。** 描画側の第 1 層は `sectionFor` の tombstone
      // 分岐で、そちらが先に本文ごと差し替える（`publishableId` と同じ関係）。
      // **したがってここだけを外しても画面は変わらない**（変異を当てて確かめた）。
      // 層が 1 枚になった状態を残さないために、`test/work-page.test.ts` が第 1 層
      // そのものを別の it で止めている。
      likeCount:
        published && !removed
          ? (likeViewer?.count ?? storedLikeCount(row.like_count))
          : previewing
            ? storedLikeCount(row.like_count)
            : 0,
      // **押している人には取り消しだけ、押していない人には付与だけを出す**（5.8）。
      // `pressable` は窓口の SQL が返した判定で、**未ログイン（`likeViewer === null`）と
      // 作者では必ず false** になる。押していないことを `likeViewer` の側から見るので、
      // 「押せるが状態が読めない」という組み合わせは現れない。
      // **プレイ数は D1 の写しだけを読む**（#377。ログイン中も DO を引かない）。条件は
      // `likeCount` と同じ（未公開・取り下げ済みでは 0。第 1 層は `sectionFor` の tombstone 分岐）。
      playCount: shown && !removed ? storedLikeCount(row.play_count) : 0,
      // **数えるのは公開済みの `/g/` の iframe だけである**（#377）。公開済みなら `playUrl` は
      // 必ず `/g/` を指す（上）。未公開のプレビュー（`/p/`）を開く作者の試遊は数えない。
      playCountableId: published && !removed ? gameId : null,
      likableId: pressable && likeViewer !== null && !likeViewer.liked ? gameId : null,
      unlikableId: pressable && likeViewer !== null && likeViewer.liked ? gameId : null,
      // **詳細情報パネル（2.3.12 / #383）は公開済み・取り下げていない作品にだけ出す**（第 1 層は
      // `sectionFor` の tombstone 分岐）。追加の問い合わせは 0 件——値はすべて上の 1 行にある。
      details:
        shown && !removed
          ? {
              gameId,
              createdAt: row.created_at,
              publishedAt: row.published_at,
              wasmBytes: storedWasmBytes(row.wasm_bytes),
              // **ソースへのリンクは、押して開けるときだけ出す。** 審査で新規露出を止めた作品では
              // `src/work-source.ts` が 404 を返すので出さない（4.4 の「押せないものを出さない」）。
              // `=== 1` で読む——結合も式も null を返しうる値を「見せてよい」へ倒さない。
              sourcePath:
                published && row.review_visible === 1 && row.has_source === 1 ? workSourcePath(gameId) : null,
            }
          : null,
      // **下書きのプレビュー（#664）。** 帯と「編集へ戻る」を出し、公開後の本文を描く。
      draftPreview: previewing,
      // **作者にだけ「編集する」の行き先を渡す**（#664）。作品ページが作者と作者以外で違うのはこの 1 つだけである。
      editPath: owner ? workEditPath(gameId) : null,
      // **関連作品（#665）は作品ページの公開後の画面にだけ引く**（エディットページでは使わない。1 往復の batch）。
      related:
        mode === 'page' && shown && !removed
          ? await listRelatedWorks(env, gameId, row.parent_ref, knownWorkTags(workTagsOf(row)).map((tag) => tag.id))
          : [],
      // **作者のアイコン（#665）は、作者名を出す画面にだけ渡す**（`authorName` と同じ条件）。
      authorAvatarUrl:
        shown && row.author_name !== null && typeof row.author_avatar_set_at === 'number'
          ? authorAvatarUrlOf(request, env, row.author_id, row.author_avatar_set_at)
          : null,
  };

  return {
    kind: 'found',
    view,
    row,
    owner,
    // **ヘッダの出し分けには、既に引いてあるセッションを使う**（2.3.7 / #331）。
    // **`owner` ではない**——他人の作品を見ているログイン済みの利用者にも、自分の作品と
    // 登録情報への導線が要る。**署名を 2 度検証しない**（`resolveSessionUser` が正本）。
    viewer: siteViewerAt(pathname, session.ok, session.ok ? headerAvatarUrl(request, env, session.userId) : null),
  };
}

/**
 * 作者のアイコンの URL を組み立てる（#665）。**サンドボックス用ホストの宣言が無ければ null**（`headerAvatarUrl` と同じ扱い）。
 *
 * @param request 受信したリクエスト（スキームとポートを借りる）
 * @param env バインディングと環境変数
 * @param authorId 作者の id
 * @param version アイコンの版（`users.avatar_set_at`）
 * @returns URL（組み立てられなければ null）
 */
function authorAvatarUrlOf(request: Request, env: Env, authorId: string, version: number): string | null {
  const host: unknown = env.SANDBOX_HOST;
  if (typeof host !== 'string' || host.trim() === '') {
    return null;
  }
  return avatarUrl(sandboxOriginOf(request, host.trim()), authorId, version);
}

/**
 * 作品ページを表示する（`GET /works/<id>`。#150 / #664）。
 *
 * **作者にも作者以外と同じ画面を出す**（#664）。違うのは「編集する」の 1 行だけで、下書きは公開後と同じ画面の
 * プレビュー（帯つき）になる。**作者が生成中・失敗・取り下げ済みの作品を開いたら、エディットページへ送る**
 * ——作者以外と同じ「状態だけ」の画面を出しても、作者にできることが何も無い（失敗の分類・削除の口は
 * エディットページにある）。完了メールのリンク（`src/mail/generation-notice.ts`）は #672 でエディットページ
 * （`/works/<id>/edit`）を直接指すようになった。**この 303 は、それより前に送られた古いメールのリンク
 * （`/works/<id>`）向けに残している**——そこから着いた作者も、これで作者の画面になる。
 *
 * @param request 受信したリクエスト
 * @param env バインディングと環境変数
 * @param gameId 作品 id（綴りは {@link loadWorkView} が確かめる）
 * @returns レスポンス
 */
export async function showWorkPage(request: Request, env: Env, gameId: string): Promise<Response> {
  const loaded = await loadWorkView(request, env, gameId, 'page');
  if (loaded.kind === 'not-found') {
    return notFound(loaded.viewer);
  }
  if (loaded.owner && !loaded.view.published && loaded.view.draftPreview !== true) {
    return seeOther(workEditPath(gameId));
  }
  return html(renderWorkPage(loaded.view, loaded.viewer));
}

/**
 * 公開をやめて下書きへ戻す（`POST /api/works/unpublish`。5.4 の「公開をやめて下書きへ戻せる」 / 確定35 / #637）。
 *
 * # 形は `src/publish.ts` / `src/ogp-recapture.ts` に揃える
 *
 * 素の `<form method="post">` と `fetch` の両方を受け、**判定はすべて `unpublishGame` の
 * SQL 1 本が持つ**（作者の一致も、いまの状態も、ここに `if` を置かない）。
 *
 * # CSRF について
 *
 * セッション cookie は `SameSite=Lax`（8.1 / `src/session.ts`）なので、他サイトからの
 * POST には cookie が乗らない。`src/publish.ts` と同じ理由でトークンを足していない。
 *
 * @param request 受信したリクエスト
 * @param env バインディングと環境変数
 * @returns レスポンス
 */
async function handleUnpublish(request: Request, env: Env): Promise<Response> {
  const asHtml = (request.headers.get('accept') ?? '').includes('text/html');

  const session = await resolveSessionUser(request, env);
  if (!session.ok) {
    return asHtml ? seeOther(LOGIN_PATH) : json({ error: 'unauthorized' }, 401);
  }

  const target = await readUnpublishTarget(request);
  if (!target.ok) {
    const refused = REMOVE_BODY_REFUSALS[target.reason];
    return asHtml
      ? removeRefusal('公開をやめられません', refused.body, refused.status)
      : json({ error: target.reason }, refused.status);
  }

  const outcome = await unpublishGame(env, target.gameId, session.userId);

  if (outcome.ok) {
    // POST-redirect-GET。**戻り先はエディットページで、そこに下書きの表示が出る**（#664。公開設定・
    // リフォージ・版の一覧・削除の導線が、下書きと同じ条件でそのまま並ぶ）。
    return asHtml
      ? seeOther(workEditPath(target.gameId))
      : json({ unpublished: true, firstTime: outcome.firstTime }, 200);
  }

  const refused = UNPUBLISH_OUTCOME_REFUSALS[outcome.reason];
  return asHtml
    ? removeRefusal(refused.heading, refused.body, refused.status)
    : json({ error: outcome.reason }, refused.status);
}

/**
 * エディットページ（`GET /works/<id>/edit`。#664）を開く関数の形。
 *
 * **実体は `src/work-edit.ts` にあり、このモジュールは import しない。** あちらはこのモジュールの描画の部品と
 * {@link loadWorkView} を借りるので、こちらから import すると循環参照になる。経路表を組み立てる側
 * （あちらの `workRoutes`）が {@link createWorkPageRoutes} へ渡す。
 */
export type WorkEditHandler = (request: Request, env: Env, gameId: string) => Promise<Response>;

/**
 * `/works/` の前方一致の経路の入口（#150 / #517 / #664）。
 *
 * **`/works/<id>/delete` を削除の確認画面へ、`/works/<id>/edit` をエディットページへ回し、それ以外は作品ページへ渡す。**
 * 経路表に前方一致の経路を足さない理由は `src/work-delete.ts` の `WORK_DELETE_SUFFIX` にある。**id の綴りが違えば
 * 作品ページへ渡す**——作品ページが同じ規則（{@link GAME_ID_PATTERN}）で 404 にする（`/works/x/delete` を別の断り方にしない）。
 *
 * **完全一致の経路（`/works/mine`・`/works/liked`）はここへ来ない**（`src/routes.ts` の `dispatch` が完全一致を先に見る）。
 *
 * @param edit エディットページを開く関数（無ければ `/edit` も作品ページへ渡し、綴りの誤りとして 404 になる）
 * @returns 経路のハンドラ
 */
function worksPrefixHandler(edit: WorkEditHandler | null): (request: Request, env: Env) => Promise<Response> {
  return async (request, env) => {
    const pathname = new URL(request.url).pathname;
    if (pathname.endsWith(WORK_DELETE_SUFFIX)) {
      const gameId = pathname.slice(WORK_PAGE_PREFIX.length, -WORK_DELETE_SUFFIX.length);
      if (GAME_ID_PATTERN.test(gameId)) {
        return await showDeleteConfirmation(request, env, gameId, pathname);
      }
    }
    if (edit !== null && pathname.endsWith(WORK_EDIT_SUFFIX)) {
      const gameId = pathname.slice(WORK_PAGE_PREFIX.length, -WORK_EDIT_SUFFIX.length);
      if (GAME_ID_PATTERN.test(gameId)) {
        return await edit(request, env, gameId);
      }
    }
    return await showWorkPage(request, env, pathname.slice(WORK_PAGE_PREFIX.length));
  };
}

/**
 * 削除の確認画面（`GET /works/<id>/delete`。#517 / M15-2）。
 *
 * # 作者本人でなければ「見つからない」
 *
 * **他人の作品と存在しない作品を同じ 404 に畳む**（区別すると、任意の id が実在するかを外から確かめられる）。
 * 確認画面は題名を出すので、作者本人でなければ本体を 1 文字も描かない。
 *
 * # 押しても断られるフォームを出さない
 *
 * 公開中・生成中・リフォージ中・中身を消した作品では、フォームの代わりに理由を出す。**条件は表示の条件
 * （`deletionBlockOf`）で、消せるかどうかを決めるのは POST の先の `deleteGame` である。**
 *
 * @param request 受信したリクエスト
 * @param env バインディングと環境変数
 * @param gameId 作品 id（綴りは確かめてある）
 * @param pathname 要求されたパス（ヘッダとパンくずの出し分け）
 * @returns レスポンス
 */
async function showDeleteConfirmation(
  request: Request,
  env: Env,
  gameId: string,
  pathname: string,
): Promise<Response> {
  const session = await resolveSessionUser(request, env);
  if (!session.ok) {
    // **戻り先は画面の定数だけを積む**（`loginRequiredRedirect` の冒頭。要求のパスを cookie へ入れない）。
    // ログインのあとは「あなたの作品」に着く。
    return await loginRequiredRedirect(env, WORK_DELETED_REDIRECT);
  }
  const viewer = siteViewerAt(pathname, true, headerAvatarUrl(request, env, session.userId));

  const row = await env.DB.prepare(DELETION_TARGET_SQL).bind(gameId).first<DeletionTargetRow>();
  if (row === null || row.author_id !== session.userId) {
    return notFound(viewer);
  }

  const block = deletionBlockOf(deletionStateOf(row));
  if (block !== null) {
    const refused = DELETE_REFUSALS[block];
    return html(renderDeleteRefusal(refused, gameId, viewer), refused.status);
  }
  return html(renderDeleteConfirmation({ gameId, title: row.title }, viewer));
}

/**
 * 作品を削除する（`POST /api/works/delete`。#517 / M15-2 / 仕様 5.3 の #516 節）。
 *
 * # 形は {@link handleUnpublish} に揃える
 *
 * 素の `<form method="post">` と `fetch` の両方を受け、`accept` で HTML と JSON を分ける。CSRF はセッション cookie の
 * `SameSite=Lax`（8.1）が受ける（`src/publish.ts` と同じ理由でトークンを足していない）。
 *
 * # 作者本人かだけを先に確かめ、状態の判定は `deleteGame` に任せる
 *
 * **`deleteGame` は id を受け取るだけで、権限を持たない。** 存在しない id にも `deleted` を返すので、作者を
 * 確かめずに呼ぶと、他人の id を送った人に成功の画面が出る（行が在れば、他人の作品が消える）。**作者でない・
 * 行が無いは、どちらも「見つからない」（404）に畳む。**
 *
 * **状態（公開中・生成中・リフォージ中）の `if` はここに置かない。** 断る理由は `deleteGame` が返し、
 * ここはそれを文言の表（`DELETE_REFUSALS`）で引くだけである。確認画面を経ずに POST しても、判定は同じ所を通る。
 *
 * # 成功したら「あなたの作品」へ戻す
 *
 * POST-redirect-GET。行ごと消えた作品のページは 404 に、行を残した作品のページは取り下げ済みの表示になる。
 *
 * @param request 受信したリクエスト
 * @param env バインディングと環境変数
 * @returns レスポンス
 */
async function handleDelete(request: Request, env: Env): Promise<Response> {
  const asHtml = (request.headers.get('accept') ?? '').includes('text/html');

  const session = await resolveSessionUser(request, env);
  if (!session.ok) {
    return asHtml ? seeOther(LOGIN_PATH) : json({ error: 'unauthorized' }, 401);
  }

  const target = await readGameIdTarget(request, WORK_DELETE_GAME_ID_FIELD);
  if (!target.ok) {
    const refused = REMOVE_BODY_REFUSALS[target.reason];
    return asHtml
      ? removeRefusal('削除できません', refused.body, refused.status)
      : json({ error: target.reason }, refused.status);
  }

  // **作者本人か**（上の「作者本人かだけを先に確かめ」）を確かめてから `deleteGame` を呼ぶ。本体は一括の口
  // （`src/works-bulk.ts`。#666）と共有する `deleteAuthoredGame`（`src/work-delete.ts`）である。
  const outcome = await deleteAuthoredGame(env, target.gameId, session.userId);
  if (!outcome.ok && outcome.reason === 'not-found') {
    return deleteRefused('not-found', null, asHtml);
  }
  if (outcome.ok) {
    return asHtml
      ? seeOther(WORK_DELETED_REDIRECT)
      : json({ deleted: true, result: outcome.result }, 200);
  }
  return deleteRefused(outcome.reason, target.gameId, asHtml);
}

/**
 * 削除の断りを返す（HTML なら画面、そうでなければ JSON）。
 *
 * @param reason 断った理由（`DELETE_REFUSALS` の鍵）
 * @param backGameId 断りの画面から戻る先の作品 id（見つからないときは null）
 * @param asHtml HTML で返すか
 * @returns レスポンス
 */
function deleteRefused(
  reason: keyof typeof DELETE_REFUSALS,
  backGameId: string | null,
  asHtml: boolean,
): Response {
  const refused: DeleteRefusal = DELETE_REFUSALS[reason];
  return asHtml
    ? html(renderDeleteRefusal(refused, backGameId), refused.status)
    : json({ error: reason }, refused.status);
}

/**
 * 通報を受け付ける（8.4 / #40）。
 *
 * **{@link handleUnpublish} と同じ形にしてある**（`accept` で HTML と JSON を分け、
 * 素の `<form>` でも動く）。違うのは、**理由の自由記述を 1 つ運ぶ**ことだけである。
 *
 * **押した結果を必ず返す。** 断った理由（自分の作品・通報済み）を黙って握り潰すと、
 * 押した人には「何も起きていない」ように見える。
 *
 * **キューへ入ったかどうかを利用者へ出さない。** 出すと**閾値を外から測れる**
 * ——何回押せば止まるかが分かると、8.4 が警戒している通報爆撃の設計図になる。
 * 返すのは「受け付けました」だけである。
 *
 * @param request 受信したリクエスト
 * @param env バインディングと環境変数
 * @returns レスポンス
 */
async function handleReport(request: Request, env: Env): Promise<Response> {
  const asHtml = (request.headers.get('accept') ?? '').includes('text/html');

  const session = await resolveSessionUser(request, env);
  if (!session.ok) {
    return asHtml ? seeOther(LOGIN_PATH) : json({ error: 'unauthorized' }, 401);
  }

  const target = await readReportTarget(request);
  if (!target.ok) {
    const refused = REMOVE_BODY_REFUSALS[target.reason];
    return asHtml
      ? removeRefusal('通報できません', refused.body, refused.status)
      : json({ error: target.reason }, refused.status);
  }

  const outcome = await recordReport(env, target.gameId, session.userId, target.reason);
  if (!outcome.ok) {
    const refused = REPORT_REFUSALS[outcome.reason];
    return asHtml
      ? removeRefusal('通報できません', refused.body, refused.status)
      : json({ error: outcome.reason }, refused.status);
  }

  // POST-redirect-GET。戻り先は作品ページで、そこに「通報済み」が出る。
  //
  // **`queued` を返さない**（上記）。
  return asHtml
    ? seeOther(workPagePath(target.gameId))
    : json({ reported: true }, 200);
}

/**
 * 題名を変える（`POST /api/works/rename`。5.4 / #366）。
 *
 * **形は {@link handleUnpublish} / {@link handleReport} に揃えてある**（`accept` で HTML と
 * JSON を分け、素の `<form>` でも動く。CSRF はセッション cookie の `SameSite=Lax` が
 * 受ける）。**判定はすべて `renameGame` が持つ**——作者の一致も、いまの状態も、
 * 8.3 の検査も、ここに `if` を置かない。
 *
 * # 落ちた理由を、語でも分類でも言わない
 *
 * 8.3 に当たったときに返すのは固定の 1 文だけである（{@link RENAME_OUTCOME_REFUSALS}）。
 * **当てては消しを繰り返せば表が復元できる**ので、8.2 が検出箇所を返さないのと同じ
 * 方針を採る（`src/games.ts` の `RenameRejection`）。
 *
 * @param request 受信したリクエスト
 * @param env バインディングと環境変数
 * @returns レスポンス
 */
async function handleRename(request: Request, env: Env): Promise<Response> {
  const asHtml = (request.headers.get('accept') ?? '').includes('text/html');

  const session = await resolveSessionUser(request, env);
  if (!session.ok) {
    return asHtml ? seeOther(LOGIN_PATH) : json({ error: 'unauthorized' }, 401);
  }

  const target = await readGameTextTarget(request, WORK_RENAME_TITLE_FIELD, RENAME_MAX_BODY_BYTES);
  if (!target.ok) {
    const refused = REMOVE_BODY_REFUSALS[target.reason];
    return asHtml
      ? removeRefusal('作品名を変えられません', refused.body, refused.status)
      : json({ error: target.reason }, refused.status);
  }

  const outcome = await renameGame(env, target.gameId, session.userId, target.text);
  if (!outcome.ok) {
    const refused = RENAME_OUTCOME_REFUSALS[outcome.reason];
    return asHtml
      ? removeRefusal(refused.heading, refused.body, refused.status)
      : json({ error: outcome.reason }, refused.status);
  }

  // POST-redirect-GET。戻り先はエディットページで、そこに新しい題名が出る（#664。作者の操作の戻り先は作品ページではなくなった）。
  //
  // **`changed` を利用者へ出し分けない**（画面に出るのは結果の題名である）。JSON では
  // 返す——`fetch` から叩く側が「同じ題名だった」を区別できると、二度押しの扱いを
  // 呼び出し側で決められる（{@link handleUnpublish} の `firstTime` と同じ扱い）。
  return asHtml
    ? seeOther(workEditPath(target.gameId))
    : json({ renamed: true, title: outcome.title, changed: outcome.changed }, 200);
}

/**
 * 改名を断ったときに出すもの。
 *
 * **鍵を `RenameRejection` で縛る**（{@link REPORT_REFUSALS} と同じ理由。`renameGame` が
 * 理由を 1 つ増やした日に、表へ足し忘れても型検査が通る形にしない）。
 */
export const RENAME_OUTCOME_REFUSALS: Readonly<
  Record<RenameRejection, { status: number; heading: string; body: string }>
> = {
  'not-found': {
    status: 404,
    heading: '作品が見つかりません',
    body: 'URL が正しいかご確認ください。',
  },
  removed: {
    status: 409,
    heading: '作品名を変えられません',
    body: 'この作品は公開を停止しています。公開を停止した作品の名前は変えられません。',
  },
  'not-ready': {
    status: 409,
    heading: '作品名を変えられません',
    body: 'この作品はまだできあがっていません。生成が終わってから名前を変えてください。',
  },
  // **語も分類も出さない**（上記）。言い直せる程度のことだけを伝える。
  'denied-term': {
    status: 400,
    heading: '作品名を変えられません',
    body: 'この作品名は使えません。別の名前にしてください。',
  },
};

/** 作品 id と自由文 1 つを運ぶ本文を読んだ結果（改名・説明）。 */
type GameTextTarget =
  | { readonly ok: true; readonly gameId: string; readonly text: string }
  | { readonly ok: false; readonly reason: RemoveRejection };

/**
 * 作品 id と自由文 1 つを運ぶ本文を読む（改名 #366 / 説明 #388）。
 *
 * **`readReportTarget` と同じ規律である**（媒体型を絞り、大きさを縛り、id の綴りを見る）。
 * **改名と説明で 1 つの読み方を共有する**——2 つに書き写すと、片方だけが媒体型や
 * 型の検査を緩めた形になる。違うのは項目名と本文の上限だけで、どちらも引数で受ける。
 *
 * **自由文の中身はここで検査しない。** 長さも制御文字も 8.3 の語も、`renameGame` /
 * `describeGame` が 1 か所で見る（**規則を 2 か所に置かない**）。ここが見るのは
 * 「文字列であること」までである。
 *
 * @param request 受信したリクエスト
 * @param textField 自由文を載せる項目名（フォームの `name` と JSON の鍵の両方）
 * @param maxBodyBytes 本文の最大バイト数
 * @returns 読めた対象、読めなければ理由
 */
async function readGameTextTarget(
  request: Request,
  textField: string,
  maxBodyBytes: number,
): Promise<GameTextTarget> {
  const mediaType = (request.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
  if (mediaType !== FORM_MEDIA_TYPE && mediaType !== JSON_MEDIA_TYPE) {
    return { ok: false, reason: 'unsupported-content-type' };
  }

  const read = await readLimitedText(request, maxBodyBytes);
  if (!read.ok) {
    return { ok: false, reason: read.reason };
  }

  // **作品 id の項目名は改名と説明で同じ綴りである**（`WORK_RENAME_GAME_ID_FIELD` /
  // `WORK_DESCRIBE_GAME_ID_FIELD`。取り下げ・通報とも同じ `game_id`）。
  let rawId: unknown;
  let rawText: unknown;
  if (mediaType === FORM_MEDIA_TYPE) {
    const form = new URLSearchParams(read.text);
    rawId = form.get(WORK_RENAME_GAME_ID_FIELD) ?? undefined;
    rawText = form.get(textField) ?? undefined;
  } else {
    try {
      const parsed: unknown = JSON.parse(read.text);
      const record =
        typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
      rawId = record[WORK_RENAME_GAME_ID_FIELD];
      rawText = record[textField];
    } catch {
      return { ok: false, reason: 'invalid-game-id' };
    }
  }

  if (typeof rawId !== 'string' || !GAME_ID_PATTERN.test(rawId)) {
    return { ok: false, reason: 'invalid-game-id' };
  }
  if (typeof rawText !== 'string') {
    return { ok: false, reason: 'invalid-game-id' };
  }
  return { ok: true, gameId: rawId, text: rawText };
}

/**
 * 改名で受け付ける本文の最大バイト数。
 *
 * **4096 バイト**（`src/account.ts` の表示名と同じ値・同じ理由）。題名は
 * {@link MAX_TITLE_LENGTH} 文字で切るが、**超えた分を 413 で断るのではなく切り詰める**
 * ので、上限は「本文を際限なく読まない」ためだけに置く。
 *
 * **フォーム符号化は 1 文字あたり最大 12 バイトになる**（UTF-8 の 4 バイト × `%XX`）
 * ので、40 文字の題名は最大 480 バイトである。4096 なら、貼り付けた長い文字列も
 * そのまま受けて切り詰められる。
 */
export const RENAME_MAX_BODY_BYTES = 4096;

/**
 * 説明を書く（`POST /api/works/describe`。#388）。
 *
 * **形は {@link handleRename} を写してある**（`accept` で HTML と JSON を分け、素の
 * `<form>` でも動く。CSRF はセッション cookie の `SameSite=Lax` が受ける）。**判定は
 * すべて `describeGame` が持つ**——作者の一致も、公開済みかも、長さ・文字・8.3 の語・
 * 変更の間隔も、ここに `if` を置かない。
 *
 * # 落ちた理由を、語でも分類でも言わない
 *
 * 8.3 に当たったときに返すのは固定の 1 文だけである（{@link DESCRIBE_OUTCOME_REFUSALS}）。
 *
 * @param request 受信したリクエスト
 * @param env バインディングと環境変数
 * @returns レスポンス
 */
async function handleDescribe(request: Request, env: Env): Promise<Response> {
  const asHtml = (request.headers.get('accept') ?? '').includes('text/html');

  const session = await resolveSessionUser(request, env);
  if (!session.ok) {
    return asHtml ? seeOther(LOGIN_PATH) : json({ error: 'unauthorized' }, 401);
  }

  const target = await readGameTextTarget(request, WORK_DESCRIBE_TEXT_FIELD, DESCRIBE_MAX_BODY_BYTES);
  if (!target.ok) {
    const refused = REMOVE_BODY_REFUSALS[target.reason];
    return asHtml
      ? removeRefusal('作品の説明を変えられません', refused.body, refused.status)
      : json({ error: target.reason }, refused.status);
  }

  const outcome = await describeGame(env, target.gameId, session.userId, target.text);
  if (!outcome.ok) {
    const refused = DESCRIBE_OUTCOME_REFUSALS[outcome.reason];
    return asHtml
      ? removeRefusal(refused.heading, refused.body, refused.status)
      : json({ error: outcome.reason }, refused.status);
  }

  // POST-redirect-GET。戻り先はエディットページで、そこに新しい説明が出る（#664）。
  return asHtml
    ? seeOther(workEditPath(target.gameId))
    : json({ described: true, description: outcome.description, changed: outcome.changed }, 200);
}

/**
 * タグを付け直す（`POST /api/works/retag`。#376）。
 *
 * **形は {@link handleDescribe} を写してある**（`accept` で HTML と JSON を分け、素の `<form>` でも
 * 動く。CSRF はセッション cookie の `SameSite=Lax` が受ける）。**判定はすべて `retagGame` が持つ**
 * ——作者の一致も、公開済みかも、語彙と個数も、変更の間隔も、ここに `if` を置かない。
 *
 * @param request 受信したリクエスト
 * @param env バインディングと環境変数
 * @returns レスポンス
 */
async function handleRetag(request: Request, env: Env): Promise<Response> {
  const asHtml = (request.headers.get('accept') ?? '').includes('text/html');

  const session = await resolveSessionUser(request, env);
  if (!session.ok) {
    return asHtml ? seeOther(LOGIN_PATH) : json({ error: 'unauthorized' }, 401);
  }

  const target = await readGameTagsTarget(request);
  if (!target.ok) {
    const refused = REMOVE_BODY_REFUSALS[target.reason];
    return asHtml
      ? removeRefusal('タグを付け直せません', refused.body, refused.status)
      : json({ error: target.reason }, refused.status);
  }

  const outcome = await retagGame(env, target.gameId, session.userId, target.tags);
  if (!outcome.ok) {
    const refused = RETAG_OUTCOME_REFUSALS[outcome.reason];
    return asHtml
      ? removeRefusal(refused.heading, refused.body, refused.status)
      : json({ error: outcome.reason }, refused.status);
  }

  // POST-redirect-GET。戻り先はエディットページで、そこに新しいタグが出る（#664）。
  return asHtml
    ? seeOther(workEditPath(target.gameId))
    : json({ retagged: true, tags: outcome.tags, changed: outcome.changed }, 200);
}

/**
 * 付け直しを断ったときに出すもの。
 *
 * **鍵を `RetagRejection` で縛る**（{@link RENAME_OUTCOME_REFUSALS} と同じ理由）。
 */
export const RETAG_OUTCOME_REFUSALS: Readonly<
  Record<RetagRejection, { status: number; heading: string; body: string }>
> = {
  'not-found': {
    status: 404,
    heading: '作品が見つかりません',
    body: 'URL が正しいかご確認ください。',
  },
  removed: {
    status: 409,
    heading: 'タグを付け直せません',
    body: 'この作品は公開を停止しています。公開を停止した作品のタグは変えられません。',
  },
  'not-published': {
    status: 409,
    heading: 'タグを付け直せません',
    body: 'この作品はまだ公開されていません。タグは公開するときに選べます。',
  },
  'too-soon': {
    status: 429,
    heading: 'タグを付け直せません',
    body: `タグの変更は ${WORK_TAGS_CHANGE_INTERVAL_SECONDS} 秒に 1 回までです。少し待ってからもう一度お試しください。`,
  },
  'too-many-tags': {
    status: 400,
    heading: 'タグを付け直せません',
    body: `タグは ${MAX_WORK_TAGS} 個まで選べます。選び直してからもう一度お試しください（タグは変わっていません）。`,
  },
  'unknown-tag': {
    status: 400,
    heading: 'タグを付け直せません',
    body: '選べないタグが含まれています。画面を開き直して、もう一度お試しください（タグは変わっていません）。',
  },
};

/** 作品 id とタグの並びを運ぶ本文を読んだ結果（付け直し）。 */
type GameTagsTarget =
  | { readonly ok: true; readonly gameId: string; readonly tags: readonly string[] }
  | { readonly ok: false; readonly reason: RemoveRejection };

/**
 * 付け直しの本文を読む（#376）。
 *
 * **{@link readGameTextTarget} と同じ規律である**（媒体型を絞り、大きさを縛り、id の綴りを見る）。
 * 違うのは、タグが**同じ名前の項目の並び**で来ること（フォームは `getAll`、JSON は文字列の配列。
 * **項目が無ければ空配列＝タグを外す**——チェックボックスを全部外して送ると項目ごと来ない）。
 *
 * **語彙と個数はここで検査しない**（`retagGame` が公開と同じ関数で見る）。
 *
 * @param request 受信したリクエスト
 * @returns 読めた対象、読めなければ理由
 */
async function readGameTagsTarget(request: Request): Promise<GameTagsTarget> {
  const mediaType = (request.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
  if (mediaType !== FORM_MEDIA_TYPE && mediaType !== JSON_MEDIA_TYPE) {
    return { ok: false, reason: 'unsupported-content-type' };
  }

  const read = await readLimitedText(request, REMOVE_MAX_BODY_BYTES);
  if (!read.ok) {
    return { ok: false, reason: read.reason };
  }

  let rawId: unknown;
  let rawTags: unknown;
  if (mediaType === FORM_MEDIA_TYPE) {
    const form = new URLSearchParams(read.text);
    rawId = form.get(WORK_RETAG_GAME_ID_FIELD) ?? undefined;
    rawTags = form.getAll(WORK_TAG_FIELD);
  } else {
    try {
      const parsed: unknown = JSON.parse(read.text);
      const record =
        typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
      rawId = record[WORK_RETAG_GAME_ID_FIELD];
      // **項目が無い（`undefined`）ときだけタグを外す。`null` は下で形の誤りとして断る**
      // （`src/publish.ts` と同じ。PR #419 の Copilot レビュー）。
      rawTags = record[WORK_TAG_FIELD] === undefined ? [] : record[WORK_TAG_FIELD];
    } catch {
      return { ok: false, reason: 'invalid-game-id' };
    }
  }

  if (typeof rawId !== 'string' || !GAME_ID_PATTERN.test(rawId)) {
    return { ok: false, reason: 'invalid-game-id' };
  }
  if (!Array.isArray(rawTags) || !rawTags.every((value) => typeof value === 'string')) {
    return { ok: false, reason: 'invalid-game-id' };
  }
  return { ok: true, gameId: rawId, tags: rawTags };
}

/**
 * 説明の変更を断ったときに出すもの。
 *
 * **鍵を `DescribeRejection` で縛る**（{@link RENAME_OUTCOME_REFUSALS} と同じ理由）。
 */
export const DESCRIBE_OUTCOME_REFUSALS: Readonly<
  Record<DescribeRejection, { status: number; heading: string; body: string }>
> = {
  'not-found': {
    status: 404,
    heading: '作品が見つかりません',
    body: 'URL が正しいかご確認ください。',
  },
  removed: {
    status: 409,
    heading: '作品の説明を変えられません',
    body: 'この作品は公開を停止しています。公開を停止した作品の説明は変えられません。',
  },
  'not-published': {
    status: 409,
    heading: '作品の説明を変えられません',
    body: 'この作品はまだ公開されていません。説明は公開してから書けます。',
  },
  'too-soon': {
    status: 429,
    heading: '作品の説明を変えられません',
    body: `説明の変更は ${DESCRIPTION_CHANGE_INTERVAL_SECONDS} 秒に 1 回までです。少し待ってからもう一度お試しください。`,
  },
  'too-long': {
    status: 400,
    heading: '作品の説明を変えられません',
    body: `説明が長すぎます（${MAX_DESCRIPTION_LENGTH} 文字まで）。短くしてからもう一度お試しください。`,
  },
  'forbidden-character': {
    status: 400,
    heading: '作品の説明を変えられません',
    body: '説明に使えない文字（改行以外の制御文字や、文字の向きを変える記号）が含まれています。',
  },
  // **語も分類も出さない**（{@link handleDescribe}）。言い直せる程度のことだけを伝える。
  'denied-term': {
    status: 400,
    heading: '作品の説明を変えられません',
    body: 'この説明には使えない表現が含まれています。書き直してください。',
  },
};

/**
 * 説明で受け付ける本文の最大バイト数（#388）。
 *
 * **16 KiB。** 説明は {@link MAX_DESCRIPTION_LENGTH} 文字で、フォーム符号化は 1 文字あたり
 * 最大 12 バイト（UTF-8 の 4 バイト × `%XX`）なので、上限いっぱいの説明が最大 12,000
 * バイトになる。**上限を超えた説明に 413 ではなく「長すぎます」を返す**ため、その上に
 * 余裕を取る（`src/account.ts` の表示名が同じ判断をしている）。上限そのものは、本文を
 * 際限なく読まないために置く。
 */
export const DESCRIBE_MAX_BODY_BYTES = 16 * 1024;

/** 通報を断ったときに出すもの。 */
// **鍵を `ReportRejection` で縛る。** `Record<string, …>` にすると、`recordReport` が
// 理由を 1 つ増やした日に**表へ足し忘れても型検査が通り、実行時に undefined を読む。**
const REPORT_REFUSALS: Readonly<Record<ReportRejection, { body: string; status: number }>> = {
  'game-not-found': { body: 'その作品は見つかりませんでした。', status: 404 },
  // **理由を分けて返す。** 「できません」だけだと、押した人は何度も押す。
  'own-work': {
    body: '自分の作品は通報できません。公開をやめたい場合は、作品ページの「公開をやめる」をお使いください。',
    status: 400,
  },
  'already-reported': { body: 'この作品はすでに通報済みです。', status: 409 },
  'reason-too-long': {
    body: `理由が長すぎます（${MAX_REASON_LENGTH} 文字まで）。`,
    status: 400,
  },
  'not-signed-in': { body: 'ログインが必要です。', status: 401 },
};

/** 通報の本文を読んだ結果。 */
type ReportTarget =
  | { readonly ok: true; readonly gameId: string; readonly reason: string }
  | { readonly ok: false; readonly reason: RemoveRejection };

/**
 * 通報の本文を読む。
 *
 * **`readUnpublishTarget` と同じ規律である**（媒体型を絞り、大きさを縛り、id の綴りを見る）。
 * **理由は空でもよい**——ワンタップ通報（8.4）なので、理由を必須にすると 1 タップで
 * 終わらない。長さだけは `recordReport` が見る。
 *
 * @param request 受信したリクエスト
 * @returns 読めた対象、読めなければ理由
 */
async function readReportTarget(request: Request): Promise<ReportTarget> {
  const mediaType = (request.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
  if (mediaType !== FORM_MEDIA_TYPE && mediaType !== JSON_MEDIA_TYPE) {
    return { ok: false, reason: 'unsupported-content-type' };
  }

  // **理由のぶんだけ広げる。** 取り下げは UUID 1 つで 1 KiB だが、こちらは自由記述が
  // 載る。`MAX_REASON_LENGTH` は文字数なので、UTF-8 の最大 4 バイト/文字を見込む。
  const read = await readLimitedText(request, REMOVE_MAX_BODY_BYTES + MAX_REASON_LENGTH * 4);
  if (!read.ok) {
    return { ok: false, reason: read.reason };
  }

  let rawId: unknown;
  let rawReason: unknown;
  if (mediaType === FORM_MEDIA_TYPE) {
    const form = new URLSearchParams(read.text);
    rawId = form.get(WORK_REPORT_GAME_ID_FIELD) ?? undefined;
    rawReason = form.get(WORK_REPORT_REASON_FIELD) ?? '';
  } else {
    try {
      const parsed: unknown = JSON.parse(read.text);
      const record =
        typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
      rawId = record[WORK_REPORT_GAME_ID_FIELD];
      rawReason = record[WORK_REPORT_REASON_FIELD] ?? '';
    } catch {
      return { ok: false, reason: 'invalid-game-id' };
    }
  }

  if (typeof rawId !== 'string' || !GAME_ID_PATTERN.test(rawId)) {
    return { ok: false, reason: 'invalid-game-id' };
  }
  if (typeof rawReason !== 'string') {
    return { ok: false, reason: 'invalid-game-id' };
  }
  return { ok: true, gameId: rawId, reason: rawReason };
}

/**
 * 受け付ける本文の最大バイト数。
 *
 * **1 KiB。** 載るのは UUID 1 つだけである（`src/publish.ts` と同じ値・同じ理由）。
 */
const REMOVE_MAX_BODY_BYTES = 1024;

/** 素の HTML フォームが送ってくる `Content-Type`。 */
const FORM_MEDIA_TYPE = 'application/x-www-form-urlencoded';

/** `fetch` から呼ぶときの `Content-Type`。 */
const JSON_MEDIA_TYPE = 'application/json';

/**
 * 取り下げの要求を受け付けられなかった理由。
 *
 * 綴りと分け方は `src/publish.ts` の `PublishRejection` に揃えてある。
 */
export type RemoveRejection =
  | 'unsupported-content-type'
  | 'body-too-large'
  | 'unreadable-body'
  | 'invalid-game-id';

/**
 * 断りの理由ごとのステータスと文言。
 *
 * **ステータスを分岐の式で書かない**（`src/publish.ts` の `BODY_REFUSALS` と同じ理由。
 * 理由を 1 つ足したときに既定の側へ黙って落ちる形にしない）。
 */
export const REMOVE_BODY_REFUSALS: Readonly<Record<RemoveRejection, { status: number; body: string }>> = {
  'unsupported-content-type': { status: 415, body: '要求の形式に対応していません。' },
  'body-too-large': { status: 413, body: '要求が大きすぎます。' },
  'unreadable-body': {
    status: 400,
    body: '要求を最後まで受け取れませんでした。もう一度お試しください。',
  },
  'invalid-game-id': { status: 400, body: '要求の形が正しくありません。' },
};

/**
 * 公開をやめる操作の結果ごとの、ステータスと文言。
 *
 * **成功はここに無い**（POST-redirect-GET で応答の作り方そのものが違う。
 * `src/ogp-recapture.ts` の `OUTCOME_REFUSALS` と同じ形）。
 *
 * `not-found` に他人の作品も含める（`unpublishGame` が区別しない）。
 */
export const UNPUBLISH_OUTCOME_REFUSALS: Readonly<
  Record<'not-found' | 'not-published', { status: number; heading: string; body: string }>
> = {
  'not-found': {
    status: 404,
    heading: '作品が見つかりません',
    body: 'URL が正しいかご確認ください。',
  },
  'not-published': {
    status: 409,
    heading: '公開をやめられません',
    body: 'この作品は公開されていません。公開していない作品には、やめるものがありません。',
  },
};

/**
 * 303 See Other を返す。
 *
 * @param location 遷移先
 * @returns レスポンス
 */
export function seeOther(location: string): Response {
  return new Response(null, { status: 303, headers: { location, 'cache-control': 'no-store' } });
}

/**
 * 断りの画面を返す。
 *
 * **作品ページへ 303 で戻さない。** 戻すと、取り下げられなかったことが URL にも
 * ステータスにも残らない（`src/publish.ts` の `refusal` と同じ判断）。
 *
 * @param heading 見出し
 * @param body 本文
 * @param status ステータスコード
 * @returns レスポンス
 */
export function removeRefusal(heading: string, body: string, status: number): Response {
  return html(
    `${siteHead({ title: `${heading} - Game Forge`, noindex: true })}
<h1>${heading}</h1>
<p>${body}</p>
${siteFooter()}`,
    status,
  );
}

/** 本文から取り出した対象。 */
type RemoveTarget =
  | { readonly ok: true; readonly gameId: string }
  | { readonly ok: false; readonly reason: RemoveRejection };

/**
 * 本文から取り下げる作品の id を取り出す。
 *
 * **形をここで確かめる**（`src/publish.ts` の `readGameId` と同じ方針）。
 *
 * @param request 受信したリクエスト
 * @returns 作品 id、または理由
 */
async function readUnpublishTarget(request: Request): Promise<RemoveTarget> {
  return await readGameIdTarget(request, WORK_UNPUBLISH_GAME_ID_FIELD);
}

/**
 * 本文から、指定した項目名の作品 id を取り出す（取り下げと削除が共有する。#517）。
 *
 * **形をここで確かめる**（媒体型を絞り、大きさを 1 KiB に縛り、id の綴りを見る）。
 *
 * @param request 受信したリクエスト
 * @param field 作品 id を運ぶ項目名
 * @returns 作品 id、または理由
 */
async function readGameIdTarget(request: Request, field: string): Promise<RemoveTarget> {
  const mediaType = (request.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
  if (mediaType !== FORM_MEDIA_TYPE && mediaType !== JSON_MEDIA_TYPE) {
    return { ok: false, reason: 'unsupported-content-type' };
  }

  const read = await readLimitedText(request, REMOVE_MAX_BODY_BYTES);
  if (!read.ok) {
    return { ok: false, reason: read.reason };
  }

  let raw: unknown;
  if (mediaType === FORM_MEDIA_TYPE) {
    raw = new URLSearchParams(read.text).get(field) ?? undefined;
  } else {
    try {
      const parsed: unknown = JSON.parse(read.text);
      raw =
        typeof parsed === 'object' && parsed !== null
          ? (parsed as Record<string, unknown>)[field]
          : undefined;
    } catch {
      return { ok: false, reason: 'invalid-game-id' };
    }
  }

  if (typeof raw !== 'string' || !GAME_ID_PATTERN.test(raw)) {
    return { ok: false, reason: 'invalid-game-id' };
  }
  return { ok: true, gameId: raw };
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

  // **範囲の外を指す位置は 1 頁目へ倒す。** `?forks=20` を控えたあとに改造が
  // 取り下げられれば、**同じ URL が空の頁になる**（総数は減る）。空の頁を出して
  // 戻る道を添えるより、**在るものを出す**ほうがよい。読み手が何かを間違えた
  // わけでもない。
  const start = offset < total ? offset : 0;

  const items = await listPublishedForks(env, gameId, FORKS_PER_PAGE, start);
  const nextOffset = start + items.length;
  const previousOffset = Math.max(start - FORKS_PER_PAGE, 0);

  return {
    total,
    items,
    morePath: nextOffset < total ? forksPagePath(gameId, nextOffset) : null,
    backPath: start > 0 ? forksPagePath(gameId, previousOffset) : null,
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
 * 作品ページの経路を組み立てる（#150 / #664）。
 *
 * **前方一致で登録する。** `/works/<game_id>` の id は 1 件ごとに違うので、完全一致の
 * 表では表現できない。`src/routes.ts` に `match: 'prefix'` を足したのはこのためで、
 * **既定は完全一致のままなので既存の経路は 1 つも影響を受けない。**
 *
 * @param edit エディットページを開く関数（#664。アプリの経路表は `src/work-edit.ts` の `workRoutes` が渡す）
 * @returns 経路表
 */
export function createWorkPageRoutes(edit: WorkEditHandler | null): readonly Route[] {
  return [
    // **削除の確認画面（`/works/<id>/delete`。#517）とエディットページ（`/works/<id>/edit`。#664）も同じ入口から開く**
    // （{@link worksPrefixHandler}）。
    { method: 'GET', path: WORK_PAGE_PREFIX, match: 'prefix', handler: worksPrefixHandler(edit) },
    // **取り下げ（#35）は完全一致である。** `/api/works/remove` は `/works/` の
    // 前方一致に当たらない綴りにしてある（当たると作品ページの id として解釈される）。
    { method: 'POST', path: WORK_UNPUBLISH_PATH, handler: handleUnpublish },
    // **削除（#517）も完全一致である**（取り下げと同じ規約。`/api/works/delete` は `/works/` の前方一致に当たらない）。
    { method: 'POST', path: WORK_DELETE_PATH, handler: handleDelete },
    { method: 'POST', path: WORK_REPORT_PATH, handler: handleReport },
    // **改名（#366）も完全一致である。** `/api/works/rename` は `/works/` の前方一致に
    // 当たらない綴りにしてある（取り下げ・通報と同じ規約）。
    { method: 'POST', path: WORK_RENAME_PATH, handler: handleRename },
    // **説明（#388）も完全一致である**（同じ規約）。
    { method: 'POST', path: WORK_DESCRIBE_PATH, handler: handleDescribe },
    // **タグの付け直し（#376）も完全一致である**（同じ規約）。
    { method: 'POST', path: WORK_RETAG_PATH, handler: handleRetag },
  ];
}

/**
 * エディットページを持たない作品ページの経路（#664 の前の形。**単体テストが作品ページと POST の口だけを見るため**に残す）。
 *
 * **アプリの経路表はこれを使わない**——`src/work-edit.ts` の `workRoutes`（エディットページを渡したもの）を使う。
 * 両方を連結すると同じ前方一致が 2 本になり、`findDuplicateRoutes` の検査が落ちる。
 */
export const workPageRoutes: readonly Route[] = createWorkPageRoutes(null);
