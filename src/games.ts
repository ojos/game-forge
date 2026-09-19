/**
 * 作品行の作成・完成・失敗（3.3 / 5.1 / 5.4 / #21 / #150）。
 *
 * ## #150 で「1 回書く」から「先に作って後で完成させる」へ変わった
 *
 * **以前この関数は 3.3 の最後の段だった。** 成果物が R2 に入ってから 1 度だけ
 * `insert` し、行があること自体が「揃っている」ことを意味していた。
 *
 * #150 はそれを 2 つに割る。**LLM を呼ぶ前に行を作り、id と URL を先に返す。**
 * 91 秒のあいだブラウザのタブを開いたままにしてもらう設計そのものが問題であり、
 * 送信した瞬間に恒久的な URL が手に入れば、タブを閉じてよくなる（#150 の背景）。
 *
 *     createPendingGame  … クォータ判定の直後。id / URL / ジョブトークンが決まる
 *     claimGenerationJob … ジョブが走り始めた印。**重複実行を止める関門**
 *     completeGame       … 成果物が揃った。R2 のキーと preview_key がここで入る
 *     failGame           … もう成果物は来ない
 *
 * ## 題名はあとから変えられる（#366）
 *
 * **`title` に値が入るのは行を作る瞬間だけ、ではなくなった。** {@link renameGame} が
 * 作者の改名を書く（口は作品ページ。5.4）。**生成側の初期値（{@link
 * draftTitleFromPrompt}）と改名は、正規化の規則を {@link normalizeTitle} で共有する。**
 * 改名は履歴（`migrations/0027_title_changes.sql`）と同じ batch で書き、審査済み
 * （`cleared`）の作品は `NULL` へ戻る——**ただし `cleared` にしたあとの通報が届いていれば
 * `queued` へ入る**（#404。規則は {@link reviewStateAfterAuthorEditSql}）。
 *
 * ## 作者は公開後に説明を書ける（#388）
 *
 * **{@link describeGame} が改名と同じ形で書く**（口は作品ページ。履歴は
 * `migrations/0028_game_descriptions.sql`、同じ batch、審査状態の戻し方も改名と同じ
 * {@link reviewStateAfterAuthorEditSql}）。
 * 違いは、**公開済みの作品だけに書けること**と、**長すぎる説明を切らずに断ること**
 * （{@link validateDescription}）である。
 *
 * ## タグは公開時に選び、公開後に付け直せる（#376）
 *
 * **{@link publishGame} が公開の UPDATE と同じ 1 本でタグの枠を書き**（二度押しの 2 回目は
 * `status = 'draft'` の条件で 0 行になり、タグを上書きしない）、**{@link retagGame} が
 * 公開後の付け直しを書く。** どちらも {@link validateWorkTags} を通り、語彙に無い値と 4 個以上を
 * **1 行も書かずに**断る。語彙そのものは値だけの葉 `src/work-tags.ts` にある。
 *
 * ## 状態は `games.status` ではなく `generation_state` が持つ
 *
 * 5.4 は「生成 → 作者が試遊 → 「公開」操作で初めて URL が有効になる」と定める。
 * **生成の経路が `published` を作れてはならない。** これは #150 の後も変わらない。
 * `status` は生成中も完成後も `draft` のままで、進行状態は別の列が持つ。
 * 判断の根拠は `migrations/0007_games_generation_state.sql` にある。
 *
 * ## `preview_key` は完成時にしか書かない（#150。0006 の不変条件を上書きする）
 *
 * **これが「生成中の行が配信側の 500 に化ける」ことへの答えである。**
 * `src/sandbox-delivery.ts` の `resolveGame` は `where preview_key = ?` で引くため、
 * **キーの無い行はあの経路から原理的に引けない。** `status='draft'` なので
 * `/g/`（`status='published'` のみ）からも引けない。すなわち生成中の行は
 * **配信側のどの分岐にも到達しない。**
 *
 * 配信側へ「生成中を除外する条件」を足して回る形は採らない。足す形は、条件を書き
 * 忘れた経路が生まれても動作では気づけない。**到達しない構造のほうが堅い。**
 * 配信側の SQL は 1 文字も変えていない。
 *
 * ## R2 のオブジェクトは作品をまたいで共有される（確定26 / #116）
 *
 * **「作品 1 件 = オブジェクト 1 組」ではない。** 3.8 のビルド結果キャッシュは生成
 * ソースのコンテンツハッシュを鍵にするため、**同じキーを別の作品が既に指しうる。**
 * したがってこのモジュールは、
 *
 * - **キーを組み立てない。** 関数が返したもの（あるいは索引が覚えていたもの）を
 *   そのまま写す（`src/build-client.ts` の `artifactKeysOf`）。作品 id を混ぜた
 *   キーを作ると、ヒット時（＝関数を呼ばない）に作れないキーが生まれる。
 * - **キーが使われていないことを確かめない。** 共有は正常な状態である。
 * - **書き込みの前に R2 を消さない。** 削除側の規約は `src/build-cache.ts` の
 *   `deleteUnreferencedArtifacts` が持ち、そちらが `games` を引いて被参照を数える。
 *
 * ## 3.3-4（費用計上）との関係
 *
 * `generations.game_id` はここでは埋めない。**これは「後続の課題」ではなく、
 * 結び付けないという決定である**（確定27 / #124）。読む側が存在しないためで、
 * 根拠と、そのときの選択肢は仕様書 5.1 にある。
 */
import { authorHandleColumnSql } from './handle-sql.js';
import { ipNoticeOf } from './ip-substitution.js';
import {
  REVIEW_CLEARED,
  REVIEW_QUEUED,
  REVIEW_REPORTED_AFTER_CLEAR_SQL,
  REVIEW_STATE_COLUMN,
  TITLE_CHANGES_TABLE,
  reviewVisibleSql,
} from './reports.js';
import { inspectText } from './output-moderation.js';
import { MAX_WORK_TAGS, WORK_TAGS } from './work-tags.js';
import type { WorkTagId } from './work-tags.js';
import type { BuildOutcome } from './build-client.js';
import type { BuildCacheRecord } from './build-cache.js';
import { artifactKeysOf, buildCacheRecordOf } from './build-client.js';
import type { GenerateRequest } from './generate.js';
import { recordBuildCache } from './build-cache.js';

/** 生成直後の作品の状態（5.4）。**この経路はこれ以外を作らない。** */
export const DRAFT_STATUS = 'draft';

/**
 * 生成中の行を「もう返ってこない」と見なすまでの秒数（開始から数える）。
 *
 * **900 秒（15 分）。** 根拠は 3 つある。
 *
 * - 実測の待ち時間は #284 の前が 90.9 秒（1.2.38）、いまは**上限 64KB を出し切る想定で
 *   297 秒**（4.2）である。5.2-7 のリトライ（2 試行）とビルドを足した最悪ケースは
 *   **829 秒**で、オーケストレータの `timeout`（870 秒）がその外側にある。
 *   **正常な生成が誤って「中断」と表示されない**余裕が要る。
 *   **順序は 829 < 870 < 900 で、余裕は 30 秒しかない**（#284 の前は 60 秒）。
 *   `scripts/check-orchestrator-retry.sh` が不等式 2（timeout < この値）を機械で見る。
 *   **この 900 を下げると、まだ走っている生成を画面が「中断」と呼び、#455 の判定が
 *   走っている生成を「終わった」と見なして次の要求を通す。**
 * - AWS Lambda の実行時間の上限が 15 分である。オーケストレータがどれだけ粘っても、
 *   これを超えて走ることはない。**超えたなら、もう返ってこない。**
 * - **`pending` のまま（起動を待っている）行も同じ値で切ってよい。** 非同期呼び出しの
 *   イベントは `maximum_event_age_in_seconds`（300 秒。`terraform/orchestrator.tf`）を
 *   過ぎると配信されない。**作ってから 900 秒 `pending` の行は、もう `running` に
 *   ならない**（300 < 900）。
 *
 * # 読み手は 2 つある
 *
 * 1. **作品ページの表示**（`src/work-page.ts` の `looksStalled`。「中断した可能性」）
 * 2. **進行中の要求の判定**（#455。{@link inFlightGuardSql}）。止まったまま残った
 *    `pending` / `running` の行で、利用者を締め出さないための区切り
 *
 * **正本をここ（`src/games.ts`）に置く。** 以前は `src/work-page.ts` にあったが、
 * 2 の判定は `src/generate.ts` の `startGeneration` から呼ばれ、そこはオーケストレータの
 * 束に入る。束から画面を import すると `scripts/check-orchestrator-bundle.sh`（#290）が
 * 落ちる。**書き写すと 2 つの読み手の区切りが割れる**ので、束に入ってよい側へ移し、
 * `src/work-page.ts` は再 export で互換を保つ。
 *
 * **D1 は書き換えない。** GET が状態を書き換える形にすると、ページを開いた人が
 * 行を壊せることになる。表示の上でだけ「中断した可能性」と言う。
 *
 * **行を `failed` に畳むのは cron だけである**（#681。`src/stale-generation-sweep.ts`、
 * 起こすのは `game-forge-cleanup` の 5 分ごとの `scheduled`）。畳む区切りはこの値ではなく
 * `STALE_GENERATION_SWEEP_SECONDS`（1 時間）で、オーケストレータの `maximum_event_age` ＋
 * `timeout`（約 20 分）の外側に置く——表示は 900 秒で「中断した可能性」と言い始め、
 * 1 時間を過ぎた次の cron で行が `failed` になり、失敗の案内と削除の導線に変わる。
 *
 * > **旧記述（#681 より前）。** 「行は 3.7 の掃除（未公開のまま 14 日で自動削除。確定13）に
 * > 任せる（止まった行を `failed` にする掃除は #455 の scope.out）。」——その掃除は無く、
 * > 止まった行は削除（`deleteGame` は `pending` / `running` を断る）もできないまま残っていた。
 * > **14 日の自動削除そのものは、いまも無い。**
 */
export const STALE_AFTER_SECONDS = 900;

/**
 * 「その利用者に進行中の要求が無い」ことを表す SQL の条件（#455 / 3.3-2 / 4.3）。
 *
 * **生成・フォーク・推敲の 3 経路が、互いの進行中を見る。** 進行中とは次のどちらかで、
 * どちらも開始（`started_at`、まだ握られていなければ作成時刻）から
 * {@link STALE_AFTER_SECONDS} 秒以内のものに限る。
 *
 * - 自分の `games` の `generation_state` が `pending` / `running`（新規生成・フォーク）
 * - 自分の作品の `game_revision_jobs.state` が `pending` / `running`（推敲。作品は
 *   `ready` のまま。`src/revisions.ts`）
 *
 * # なぜ条件の断片として配るのか
 *
 * **判定と行の作成の間に窓を残さない**ためである（`invites.used_by` と同じ規約。
 * `migrations/0001_init.sql`）。先に select で確かめてから insert すると、その隙間で
 * 同時に届いた 2 本目が同じ「進行中は無い」を読んで通る。**この断片は行を作る文の
 * `where` に入り、条件を満たさなければ 1 行も入らない。** D1 は文を 1 本ずつ直列に
 * 走らせるので、先に入った 1 本が後の 1 本の `not exists` に見える。
 *
 * **往復は増えない。** 判定は行を作る文そのものの中にあり、別の問い合わせを投げない。
 * 引く行は既存の索引で利用者 1 人の作品に絞られる（`games(author_id, …)`（0008）から
 * 入り、推敲ジョブは主キーで突き合わせる。**マイグレーションは足していない**。
 * 全走査にならないことは `test/schema-in-flight.test.ts` が実行計画で見る）。
 *
 * 束縛する値は 4 つで、順に `userId, cutoff, userId, cutoff` である
 * （{@link inFlightGuardBindings}）。
 *
 * @returns `where` に `and` で連ねられる条件
 */
export function inFlightGuardSql(): string {
  return `not exists (
            select 1 from games inflight_g
             where inflight_g.author_id = ?
               and inflight_g.generation_state in ('pending', 'running')
               and coalesce(inflight_g.generation_started_at, inflight_g.created_at) > ?)
          and not exists (
            select 1 from game_revision_jobs inflight_j
              join games inflight_owner on inflight_owner.id = inflight_j.game_id
             where inflight_j.state in ('pending', 'running')
               and inflight_owner.author_id = ?
               and coalesce(inflight_j.started_at, inflight_j.created_at) > ?)`;
}

/**
 * 進行中と見なす開始時刻の下限（#455）。**この値より新しく始まった行だけが進行中である**
 * （`>`）。この値以下で始まった `pending` / `running` の行は「止まったまま残った行」で、
 * 次の要求を止めない。
 *
 * **区切りを使う側はここから取る。** `now - STALE_AFTER_SECONDS` を呼び出し側で組み立てると、
 * `>` と `>=` の向きや、どの時刻から引くかが場所ごとに割れる（{@link inFlightGuardBindings}
 * と、推敲ジョブの上書き条件（`src/revisions.ts` の `claimRevisionSlot`）が同じ値を読む）。
 *
 * @param now 判定時刻（UNIX 秒）
 * @returns 区切り（UNIX 秒）
 */
export function inFlightCutoff(now: number): number {
  return now - STALE_AFTER_SECONDS;
}

/**
 * {@link inFlightGuardSql} に束縛する値を並べる。
 *
 * **区切りは `now - STALE_AFTER_SECONDS` より新しい開始時刻である**（`>`）。
 * `src/work-page.ts` の `looksStalled` は `now - since >= STALE_AFTER_SECONDS` を
 * 止まっていると見なすので、**表示が「中断した可能性」と言い始める瞬間に、判定も
 * 進行中と見なさなくなる**（境界がずれない）。
 *
 * @param userId 要求した利用者
 * @param now 判定時刻（UNIX 秒）
 * @returns 束縛する値（4 つ）
 */
export function inFlightGuardBindings(
  userId: string,
  now: number,
): readonly [string, number, string, number] {
  const cutoff = inFlightCutoff(now);
  return [userId, cutoff, userId, cutoff];
}

/**
 * その利用者に進行中の要求があるかを読む（**断ったあとの分類にだけ使う**）。
 *
 * **判定には使わない。** 判定は行を作る文の中で {@link inFlightGuardSql} が行う。
 * これを先に呼んでから行を作る形にすると、窓が開く（#455 の constraints）。
 *
 * 推敲（`src/revise.ts`）は枠の取得（`claimRevisionSlot`）が複数の理由で 0 行になり、
 * **断った理由が「進行中」なのか「推敲できない作品」なのかを文の結果から区別できない。**
 * 断られた要求だけがこれを 1 回読み、文言を選ぶ。通った要求の読み取りは増えない。
 *
 * @param env バインディングと環境変数
 * @param userId 利用者
 * @param now 判定時刻（UNIX 秒。既定は現在時刻）
 * @returns 進行中の要求があれば true
 */
export async function hasInFlightRequest(
  env: Env,
  userId: string,
  now: number = Math.floor(Date.now() / 1000),
): Promise<boolean> {
  const row = await env.DB.prepare(
    `select case when ${inFlightGuardSql()} then 0 else 1 end as busy`,
  )
    .bind(...inFlightGuardBindings(userId, now))
    .first<{ busy: number }>();
  return row?.busy === 1;
}

/**
 * 生成の進行状態（`games.generation_state`）。
 *
 * 綴りの正本は `migrations/0007_games_generation_state.sql` の CHECK である。
 * **CHECK があるので、ここを増やしただけでは書けない**（マイグレーションが要る）。
 * 型と CHECK のどちらか一方だけを増やしても DB が受け取らないため、ずれは沈黙しない。
 */
export type GenerationState = 'pending' | 'running' | 'ready' | 'failed';

/**
 * 失敗の分類名（`games.generation_error`）。**8.3 の固定語彙である。**
 *
 * **生成物由来の文字列をここへ入れない。** 作品ページはこの値を「どの固定文言を
 * 出すか」の鍵として使うだけで、値そのものは画面へ出ない。
 *
 * 分類は、生成の経路が既に応答で返し分けているものと揃える。
 *
 * | 値 | いつ入るか |
 * |---|---|
 * | `source-rejected` | 5.2-5 の import ホワイトリスト違反（再生成に回さず即拒否） |
 * | `build-failed` | 5.2-7 の上限までビルドが通らなかった |
 * | `build-timeout` | ビルドが時間内に終わらなかった（#164） |
 * | `internal` | 上のどれでもない失敗（設定不足・関数障害・想定外の例外） |
 *
 * **`build-timeout` を `internal` から分けた理由（#164）。** `internal` の定義は
 * 「設定不足・関数障害・想定外の例外」であり、**どれも「直すべき不具合がある」と
 * 読める。** 時間切れはそのどれでもなく、**容量（vCPU）が足りなかった**という
 * 結果である。同じ箱に入れておくと、運用者は最初にコードと設定を見に行く——
 * 実際に見るべきなのはビルド時間の分布とメモリ配分のほうである
 * （`terraform/build-function.tf`）。
 *
 * **`build-failed` にも寄せない。** あちらは「生成されたコードが通らなかった」で、
 * 利用者へ出す文言が「作りたいものを簡単にしてください」になる。時間切れで
 * そう言うのは**嘘である**（コードは正しいかもしれない）。
 *
 * **クォータ超過はここに無い。** 3.3 の順序ではクォータ判定が行の作成より前にあり
 * （4.3）、超過した要求は**そもそも行を作らない。**
 *
 * **`prompt-blocked` を `source-rejected` に寄せない理由（#37）。** あちらは
 * **生成されたコード**が 5.2-5 の検査に落ちたもので、利用者へ出す文言は「作りたいものを
 * 変えてください」ではなく「作り直します」に近い。`prompt-blocked` は**入力そのもの**が
 * 8.2 に落ちたもので、**利用者にできることが違う**（言い直す）。同じ箱に入れると、
 * 片方の文言が必ず誤りになる（`build-timeout` を `build-failed` から分けたのと同じ理由）。
 *
 * **枠は消費しない。** 遮断はモデル呼び出しの前に起きるので `generations` の行が
 * 作られない（確定25 は枠を台帳の行数で数える）。**この行が残ることと枠が減ることは
 * 別である。**
 *
 * **この一覧に CHECK は無い**（`migrations/0007_games_generation_state.sql`。分類名は
 * アプリの語彙であり、増減のたびにマイグレーションを足すと表示の都合でスキーマが
 * 動く）。したがって値を足すのにマイグレーションは要らない。**代わりに
 * `src/generate-callback.ts` がこの配列で受け口を絞っている**ので、ここへ足さない
 * 値はコールバックから入って来られない。
 */
export const GENERATION_ERROR_CODES = [
  'source-rejected',
  'build-failed',
  'build-timeout',
  'prompt-blocked',
  'internal',
] as const;

/** 失敗の分類名。 */
export type GenerationErrorCode = (typeof GENERATION_ERROR_CODES)[number];

/**
 * 仮のタイトルの最大文字数。
 *
 * **バイト数ではなく文字数で数える**（`src/generate.ts` の `MAX_PROMPT_LENGTH` と
 * 同じ理由。UTF-8 のバイト数で切ると日本語だけが短くなる）。一覧（5.5）とタイム
 * ラインに並ぶ長さとして、40 文字あれば足りる。
 */
export const MAX_TITLE_LENGTH = 40;

/** プロンプトから何も取れなかったときのタイトル。 */
export const UNTITLED_TITLE = '無題の作品';

/**
 * `preview_key` の乱数のバイト数（#28 / 5.4）。
 *
 * **128 ビット。** この鍵は作者プレビュー URL の唯一の資格情報である（cookie による
 * 所有者確認がサンドボックス経路では原理的に成立しない。理由は
 * `migrations/0006_games_preview_key.sql`）。総当たりが問題にならない長さが要る。
 *
 * 128 ビットは UUID v4 の実効エントロピー（122 ビット）と同程度で、`games.id` と
 * 同じ桁である。**プレビュー URL は id より弱くてはいけない**という下限から決めた。
 */
export const PREVIEW_KEY_BYTES = 16;

/**
 * ジョブトークンの乱数のバイト数（#150）。
 *
 * **256 ビット。`preview_key` より長くする。** プレビュー鍵は「未公開の作品を見られる」
 * だけだが、こちらは**作品行を完成・失敗させられる**（＝ R2 のキーと `go_version` を
 * 書き込める）。書き込みの資格情報を読み取りの資格情報と同じ長さにする理由が無い。
 *
 * 平文は D1 に残らない（保存するのは SHA-256 だけ）。
 */
export const JOB_TOKEN_BYTES = 32;

/**
 * バイト列を 16 進の小文字文字列にする。
 *
 * @param bytes 変換するバイト列
 * @returns 16 進の小文字文字列（`bytes.length * 2` 文字）
 */
function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * 乱数を 16 進の小文字文字列にする。
 *
 * @param byteLength 引くバイト数
 * @returns 16 進の小文字文字列（`byteLength * 2` 文字）
 */
function randomHex(byteLength: number): string {
  return toHex(crypto.getRandomValues(new Uint8Array(byteLength)));
}

/**
 * 推測不能なプレビュー用キーを 1 つ作る。
 *
 * # `crypto.randomUUID()` を使わない
 *
 * 長さは足りるが、UUID は `games.id` と**見分けが付かない**。プレビュー URL
 * （`/p/<preview_key>/`）と公開 URL（`/g/<game_id>/`）で綴りが同じだと、ログや問い合わせで
 * 取り違える。16 進 32 桁（区切りなし）なら一目で別物と分かる。
 *
 * # 16 進で出す
 *
 * URL とヘッダの両方へ埋め戻る値なので、どちらの文脈でも特別な意味を持たない文字だけで
 * 構成する（`src/sandbox-delivery.ts` の `PREVIEW_KEY_PATTERN` と対になる）。base64url は
 * 短くなるが、`-` と `_` を含む分だけ確かめることが増える。
 *
 * @returns 16 進 32 桁の小文字文字列
 */
export function createPreviewKey(): string {
  return randomHex(PREVIEW_KEY_BYTES);
}

/**
 * ジョブトークンを 1 本作る（#150）。
 *
 * **平文が存在するのは、この戻り値と、ジョブへ渡すペイロードの中だけである。**
 * D1 には {@link hashJobToken} の結果しか入らない。
 *
 * @returns 16 進 64 桁の小文字文字列
 */
export function createJobToken(): string {
  return randomHex(JOB_TOKEN_BYTES);
}

/**
 * ジョブトークンを SHA-256 で畳む。
 *
 * **平文を D1 へ保存しないための関数である。** D1 の内容が漏れたときに、そのまま
 * 使えるトークンが並んでいる状態を作らない。
 *
 * ソルトも反復も付けない。対象は 256 ビットの乱数であり、辞書攻撃も総当たりも
 * 成立しない（利用者が選んだ秘密ではないので、パスワードハッシュの前提が要らない）。
 *
 * @param token 平文のトークン
 * @returns SHA-256 の小文字 16 進表現（64 文字）
 */
export async function hashJobToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return toHex(new Uint8Array(digest));
}

/**
 * タイトルの宣言行を見分ける綴り（#365）。
 *
 * **行が丸ごと宣言のときだけ当たるように、両端を留めてある。** 本文の途中に
 * 書かれた「〜のタイトル: 〜」を拾わないためで、位置の規則は
 * {@link declaredTitleOf} が持つ（当てる対象を「先頭の空行を飛ばした最初の行」
 * 1 本に絞る）。
 *
 * - 見出しは `タイトル` / `題名` / `title`。`title` は大文字小文字を問わない
 *   （`i` フラグ。`Title` も `TITLE` も同じ宣言として扱う）。
 * - 区切りは半角 `:` と全角 `：` の両方。**日本語入力のまま打つと全角になる**ので、
 *   半角だけを認める形は「書いたのに効かない」を量産する。
 * - 見出しの前後と区切りのまわりの空白は無視する（`\s` は全角空白 U+3000 も含む）。
 *
 * 捕獲するのは区切りより後ろの全体で、**空でもよい**（`タイトル:` だけの行は
 * 「空の宣言」として扱い、{@link normalizeTitle} が {@link UNTITLED_TITLE} へ倒す）。
 */
const TITLE_DECLARATION_PATTERN = /^(?:タイトル|題名|title)\s*[:：]\s*(.*)$/iu;

/**
 * タイトルとして表示してよい形へ整える（#365）。
 *
 * # この関数が「正規化の規則」の唯一の置き場である
 *
 * **同じ規則を 2 か所に置かない。** 宣言の経路（{@link draftTitleFromPrompt} が
 * 宣言行から取った値）も、宣言が無いときのフォールバック（プロンプトの 1 行目）も、
 * **必ずこの関数を通す。** 片方だけに規則を足すと、宣言したときだけ 41 文字が
 * 通る、といった食い違いが黙って生まれる。
 *
 * **改名（#366）もこの関数を共有する。** 作者が入力した題名と、プロンプト由来の
 * 仮の題が、別の規則で切られてはならない。そのため引数は「プロンプト」ではなく
 * 「タイトルの候補文字列」にしてある。
 *
 * # 規則
 *
 * 1. **制御文字と行区切りを空白へ潰す。** 出どころは利用者の自由入力で、表示面へ
 *    そのまま出る。改行もこの範囲に入るため、複数行を渡しても 1 行に畳まれる
 *    （**行の選別はこの関数の責務ではない**。呼ぶ側が 1 行に絞ってから渡す）。
 *
 *    **範囲は表示名（5.9 / `src/account.ts` の `FORBIDDEN_CHARACTER`）と同じ組にする。**
 *    `\p{Cc}` は C0 と DEL に加えて **C1 制御文字（U+0085 NEL を含む）** を、
 *    `\p{Zl}` / `\p{Zp}` は Unicode 上の行区切り（U+2028 / U+2029）を拾う。
 *    **コードポイントの範囲を書き並べると C1 が落ちる**——実際 #365 の初版は
 *    `[\u0000-\u001f\u007f]` と書いており、NEL がタイトルへ残った（PR #385 の
 *    Copilot レビュー）。題名は作品カードで作者名の隣に並ぶので、**名前の側で
 *    禁じた文字が題名の側から入れる状態にしない。**
 * 2. **前後の空白を落とす。**
 * 3. **空なら {@link UNTITLED_TITLE}。** `games.title` は `NOT NULL` で、空文字で
 *    埋めると一覧に無地の行が並ぶ（5.1）。
 * 4. **{@link MAX_TITLE_LENGTH} 文字で切る。** バイト数ではなく文字数で数え、
 *    **サロゲートペアで割らない**（`slice` はコードユニット単位なので、絵文字を
 *    半分にした文字列が D1 へ入りうる）。
 *
 * @param candidate タイトルの候補文字列（宣言の値、またはプロンプトの 1 行目）
 * @returns 表示してよいタイトル（**空にならない**）
 */
export function normalizeTitle(candidate: string): string {
  // 制御文字と行区切りを空白へ潰す。出どころは利用者の自由入力で、表示面へそのまま
  // 出る。**範囲は `src/account.ts` の表示名と同じ組である**（上の「規則」1）。
  const cleaned = candidate.replace(/[\p{Cc}\p{Zl}\p{Zp}]/gu, ' ').trim();
  if (cleaned === '') {
    return UNTITLED_TITLE;
  }
  // **サロゲートペアで切らない。** `slice` はコードユニット単位なので、絵文字を
  // 半分に割った文字列が D1 へ入りうる。
  const characters = [...cleaned];
  if (characters.length <= MAX_TITLE_LENGTH) {
    return cleaned;
  }
  return characters.slice(0, MAX_TITLE_LENGTH).join('');
}

/**
 * プロンプトの先頭にあるタイトルの宣言を取り出す（#365）。
 *
 * # 位置の規則——「先頭の空行を飛ばした最初の行」だけを見る
 *
 * **見るのは 1 本の行だけである。** 全行を走査して宣言を探す形にすると、
 * 「操作説明のタイトル: の行を出してください」のような**本文中の指示**が題名として
 * 採られる。先頭の空行を飛ばすのは、貼り付けの都合で空行が入っただけの
 * プロンプトを取りこぼさないためで、**飛ばすのは宣言の判定にだけ効く**
 * （フォールバックの側は従来どおり素の 1 行目を使う。{@link draftTitleFromPrompt}）。
 *
 * **その行が丸ごと宣言のときだけ採る。** 判定は {@link TITLE_DECLARATION_PATTERN} が
 * 両端を留めて行う。
 *
 * @param prompt 利用者が入力した自然文プロンプト
 * @returns 宣言されたタイトルの値（**空文字もありうる**）。宣言が無ければ `null`
 */
function declaredTitleOf(prompt: string): string | null {
  // `\r\n` の `\r` は行ごとの `trim()` が落とす。
  const firstFilledLine = prompt.split('\n').find((line) => line.trim() !== '');
  if (firstFilledLine === undefined) {
    return null;
  }
  const matched = TITLE_DECLARATION_PATTERN.exec(firstFilledLine.trim());
  return matched === null ? null : (matched[1] ?? '');
}

/**
 * プロンプトからタイトルを決める。
 *
 * # なぜプロンプトから取るのか
 *
 * `games.title` は `NOT NULL` である（5.1 / `migrations/0001_init.sql`）。**一方、
 * 3.3 の経路にタイトルを決める段は無く、公開時に入力させる段も置かない**（5.4 の
 * 決定）。空文字で埋めると「タイトルが無い」ことが表現できず、一覧に無地の行が
 * 並ぶ。**プロンプトから借りる**のが、追加の生成も追加の画面も要らずに意味のある
 * 文字列を得る唯一の手段である。
 *
 * # #365 で「借りる」から「宣言できる」へ変わった
 *
 * **以前は 1 行目を 40 字で切った値しか入らなかった。** 作者が題名を決める経路が
 * どこにも無く、文の途中で切れた仮の題がそのまま作品名として公開されていた
 * （トップのカードと `og:title`）。
 *
 *     タイトル: 紙飛行機のたたかい      → 「紙飛行機のたたかい」（宣言）
 *     縦スクロールのシューティング。…   → 「縦スクロールのシューティング。…」（従来）
 *
 * **宣言が無いときの結果は 1 文字も変わらない。** 宣言は経路を 1 本増やすだけで、
 * 既存の入力の見え方を動かさない。
 *
 * **宣言行はプロンプトから削らない。** そのまま Bedrock へ渡し、
 * `generations.prompt`（5.1）にも利用者が入力した文面のまま残す。削る形にすると、
 * 切り出しの規則が `buildConverseRequest` 側にも要る——すなわち**同じ規則が 2 か所に
 * 増える**（`src/bedrock.ts`）。増える入力は 20〜40 トークンで、`cachePoint` は
 * システムプロンプトの末尾にあるためキャッシュも割れない（#365）。
 *
 * **あとから題名を変える口はここが持たない。** 改名は {@link renameGame} が持ち
 * （#366。口は作品ページの作者にだけ出る）、**正規化の規則だけを
 * {@link normalizeTitle} として共有する。** すなわちこの関数が入れるのは
 * **初期値**であって、作品名の最終形ではない。
 *
 * # 生成物ではなく入力から取る
 *
 * LLM の出力（Go のソース）から取ると、8.3 の検査を通っていない文字列が表示面へ
 * 出る経路になる。プロンプトは利用者自身の入力で、`generations.prompt` として
 * すでに D1 に保存されている（5.1）。**新しい種類のデータを表示面へ持ち込まない。**
 *
 * **#150 で読み手が増えた。** 作品ページ（`/works/<id>`）がこの値を出すが、
 * **出すのは作者本人にだけ**である（プロンプト由来の文字列なので、id を知っている
 * だけの相手には見せない。`src/work-page.ts`）。
 *
 * # フォークと推敲
 *
 * **フォークの差分プロンプトも同じ規則で動く。** 子の行を作るのは
 * `createForkedGame` で、新規生成と同じ挿入経路（`insertPendingGame`）を通るため、
 * 宣言もフォールバックも書き分けが無い（5.3）。推敲（5.7）は同じ行を置き換える
 * だけで題名を触らない。
 *
 * @param prompt 利用者が入力した自然文プロンプト
 * @returns タイトル（空にならない）
 */
export function draftTitleFromPrompt(prompt: string): string {
  const declared = declaredTitleOf(prompt);
  if (declared !== null) {
    // **空の宣言（`タイトル:` だけ）もここへ来る。** 本文の 1 行目へ落とさないのは、
    // 作者が「題名はここで決める」と表明した以上、文の途中で切れた仮の題を代わりに
    // 出すほうが驚きが大きいため。`normalizeTitle` が `UNTITLED_TITLE` へ倒す。
    return normalizeTitle(declared);
  }
  // 宣言が無ければ従来どおり。**改行以降は落とし、素の 1 行目だけを使う**
  // （複数行のプロンプトで一覧が崩れる）。**ここで空行を飛ばさない**のは、
  // 宣言を足したことで既存の入力の結果が動かないようにするためである。
  return normalizeTitle(prompt.split('\n')[0] ?? '');
}

/** 作った作品行と、そのジョブを動かすためのトークン。 */
export interface PendingGame {
  /** `games.id`。作品ページの URL に入る恒久的な識別子。 */
  readonly id: string;
  /** ジョブトークンの**平文**。D1 には入っていない（ハッシュだけが入る）。 */
  readonly jobToken: string;
}

/**
 * `go_version` に入れる、まだビルドしていないことを表す値。
 *
 * **`games.go_version` は `NOT NULL` である**（5.1）。行を先に作る以上、ビルドより前に
 * 何かを入れなければならない。**空文字にする。**
 *
 * 嘘の版（`go1.26.7` のような実在する綴り）を置かないのは、それが 3.5 の
 * `wasm_exec.js` 出し分けの入力になるためである。**間違った版で配信されるより、
 * どの版でもない値のほうが安全**で、実際この値は配信側へ届かない
 * （`preview_key` が NULL なので `resolveGame` が引けない。モジュール冒頭）。
 *
 * 列を NULL 許容へ変えるには `games` の再構築が要るので採らない
 * （`migrations/0007_games_generation_state.sql`）。
 */
export const UNBUILT_GO_VERSION = '';

/**
 * 作品行を `pending` で作る（3.3-2.5 / #150）。
 *
 * **クォータ判定の直後に呼ぶ。** 3.3 の順序で「判定より前に書く」ことにはならない
 * （4.3 の「上限の判定は 3.3-2 の 1 か所で行う」は保たれる）。**枠の意味も変わらない**
 * ——日次枠は `generations` の行数で数えており（確定25）、作品行を先に作っても
 * 台帳の数え方は 1 文字も変わらない。
 *
 * ここで決まるもの:
 *
 * - **`games.id`** … 作品ページ（`/works/<id>`）の恒久的な URL になる
 * - **ジョブトークン** … このジョブだけを完成・失敗させられる使い捨ての資格情報
 *
 * ここで**決まらない**もの（完成時に {@link completeGame} が入れる）:
 *
 * - `preview_key` … 書かないことが、生成中の行を配信側から隔離する仕組みである
 * - `go_version` / `source_key` / `wasm_key` … ビルドが終わるまで存在しない
 *
 * # 冪等ではない
 *
 * 同じ入力で 2 回呼べば 2 つの作品ができる。**それが正しい**（同じプロンプトから
 * 2 件作ることは利用者の自由で、確定26 のもとでは 2 件が同じ成果物を指すだけである）。
 * 二重実行を防ぐのはこの関数ではなく {@link claimGenerationJob} である。
 *
 * # フォークは親を指す（5.3 / #32）
 *
 * `parent_id` を張るのは {@link createForkedGame} だけである。**新規生成の経路が親を
 * 受け取らない形にしてある**のは、5.4 で `status` を引数にしなかったのと同じ理由で、
 * 系統（5.5）へ載るかどうかを**呼び出し側の値ではなく、呼んだ関数**で決めたいため。
 * 推敲（5.7）が `parent_id` を張らないことも、あちらがこの関数を 1 度も呼ばない
 * （同じ行を置き換える）という形で自然に守られる。
 *
 * @param env バインディングと環境変数
 * @param userId 作者
 * @param request 生成リクエスト（仮のタイトルに使う）
 * @param now 作成時刻（UNIX 秒。既定は現在時刻）
 * @returns 作品の id と、ジョブトークンの平文
 */
export async function createPendingGame(
  env: Env,
  userId: string,
  request: GenerateRequest,
  now: number = Math.floor(Date.now() / 1000),
): Promise<PendingGame> {
  const created = await insertPendingGame(env, userId, request, null, now, false);
  // 排他を掛けていないので必ず入る（null になるのは排他の枝だけである）。
  // **それでも黙って `!` で潰さない。** 来たら不具合なので投げる。
  if (created === null) {
    throw new Error('作品行を作れませんでした（排他を掛けていない挿入が 0 行でした）');
  }
  return created;
}

/**
 * フォークの子を `pending` で作る（5.3 / M5-1 / #32）。
 *
 * **{@link createPendingGame} との違いは `parent_id` を張ることだけである。**
 * 5.7 の表がフォークと推敲を分ける 2 点のうち、「**新しい作品行**が生まれる」と
 * 「`parent_id` が親を指す」の両方がこの 1 つの呼び出しに現れる。
 *
 * **`fork_count` はここで動かさない**（#32 が置いた境界を #34 も動かしていない）。
 * 親の被フォーク数は**公開された子の数**として意味を持つ値で、`pending` の行——
 * ビルドが通らずに終わるかもしれない行——を数えた瞬間に、5.5 の
 * 「このゲームからの改造: N 件」と食い違う。**動くのは子が公開された瞬間**で、
 * 置き場は {@link publishGame} である（#34 / {@link refreshParentForkCount}）。
 *
 * **親が公開済みであることをここでは確かめない。** 5.3 の対象条件は
 * `src/fork.ts` が親のソースを読む前に判定しており、**確かめる場所を 2 つ持たない**
 * （`claimRevisionSlot` が 5.7 の対象条件を 1 か所で持っているのと同じ形）。
 *
 * @param env バインディングと環境変数
 * @param userId 改造する利用者（**子の作者は親の作者ではない**）
 * @param request 生成リクエスト（差分プロンプト。仮のタイトルに使う）
 * @param parentId 親の作品 id
 * @param now 作成時刻（UNIX 秒。既定は現在時刻）
 * @returns 作品の id と、ジョブトークンの平文
 */
export async function createForkedGame(
  env: Env,
  userId: string,
  request: GenerateRequest,
  parentId: string,
  now: number = Math.floor(Date.now() / 1000),
): Promise<PendingGame> {
  const created = await insertPendingGame(env, userId, request, parentId, now, false);
  // 排他を掛けていないので必ず入る（null になるのは排他の枝だけである）。
  // **それでも黙って `!` で潰さない。** 来たら不具合なので投げる。
  if (created === null) {
    throw new Error('作品行を作れませんでした（排他を掛けていない挿入が 0 行でした）');
  }
  return created;
}

/**
 * 進行中の要求が無ければ、作品行を `pending` で作る（**3.3-2.5 の経路の入口**。#455）。
 *
 * **{@link createPendingGame} との違いは「進行中の要求があれば 1 行も作らない」ことだけ
 * である。** 判定は行を作る文そのものの `where` にある（{@link inFlightGuardSql}）ので、
 * **同時に届いた 2 本のうち通るのは 1 本だけ**になる。
 *
 * **経路（`src/generate.ts` の `startGeneration`）はこちらを呼ぶ。** 排他の無い
 * {@link createPendingGame} を残すのは、テストや運用の道具が 1 人に複数の生成中の行を
 * 用意する必要があるためで、**利用者の要求を受ける経路からは呼ばない。**
 *
 * @param env バインディングと環境変数
 * @param userId 作者
 * @param request 生成リクエスト（仮のタイトルに使う）
 * @param now 作成時刻（UNIX 秒。既定は現在時刻）
 * @returns 作品の id と、ジョブトークンの平文。進行中の要求があれば null
 */
export async function createPendingGameIfIdle(
  env: Env,
  userId: string,
  request: GenerateRequest,
  now: number = Math.floor(Date.now() / 1000),
): Promise<PendingGame | null> {
  return await insertPendingGame(env, userId, request, null, now, true);
}

/**
 * 進行中の要求が無ければ、フォークの子を `pending` で作る（5.3 の経路の入口。#455）。
 *
 * {@link createForkedGame} に、{@link createPendingGameIfIdle} と同じ排他を掛けたもの。
 * **経路（`src/fork.ts`）はこちらを呼ぶ。**
 *
 * @param env バインディングと環境変数
 * @param userId 改造する利用者
 * @param request 生成リクエスト（差分プロンプト。仮のタイトルに使う）
 * @param parentId 親の作品 id
 * @param now 作成時刻（UNIX 秒。既定は現在時刻）
 * @returns 作品の id と、ジョブトークンの平文。進行中の要求があれば null
 */
export async function createForkedGameIfIdle(
  env: Env,
  userId: string,
  request: GenerateRequest,
  parentId: string,
  now: number = Math.floor(Date.now() / 1000),
): Promise<PendingGame | null> {
  return await insertPendingGame(env, userId, request, parentId, now, true);
}

/**
 * `games` の行を 1 つ `pending` で挿入する。
 *
 * **SQL をこの 1 か所に置く。** 新規生成とフォークで文を書き分けると、列を足した日に
 * 片方だけが古くなる（shared-ai-rules 12 章「一覧の複製を作らない」）。違いは
 * `parent_id` に何を束ねるかと、進行中の要求を見るかどうかだけである。
 *
 * **排他は `insert ... select ... where` の 1 文で行う**（#455）。値の並びは排他の有無で
 * 変わらず、変わるのは末尾の `where` だけである。
 *
 * @param env バインディングと環境変数
 * @param userId 作者
 * @param request 生成リクエスト（仮のタイトルに使う）
 * @param parentId 親の作品 id（オリジナルなら null）
 * @param now 作成時刻（UNIX 秒）
 * @param exclusive true なら、進行中の要求があるとき 1 行も作らない
 * @returns 作品の id と、ジョブトークンの平文。排他で断られたら null
 */
async function insertPendingGame(
  env: Env,
  userId: string,
  request: GenerateRequest,
  parentId: string | null,
  now: number,
  exclusive: boolean,
): Promise<PendingGame | null> {
  const id = crypto.randomUUID();
  const jobToken = createJobToken();

  const result = await env.DB.prepare(
    `insert into games
       (id, author_id, parent_id, status, title, go_version, source_key, wasm_key,
        fork_count, created_at, published_at, preview_key,
        generation_state, generation_error, job_token_hash, generation_started_at,
        ip_notice, prompt)
     select ?, ?, ?, ?, ?, ?, null, null, 0, ?, null, null, 'pending', null, ?, null,
            ?, ?
      where ${exclusive ? inFlightGuardSql() : '1 = 1'}`,
  )
    .bind(
      id,
      userId,
      parentId,
      // **状態は定数である。** 引数で受け取らないのは、生成の経路から
      // `published` を作れないようにするため（5.4）。
      DRAFT_STATUS,
      draftTitleFromPrompt(request.prompt),
      UNBUILT_GO_VERSION,
      now,
      await hashJobToken(jobToken),
      // 6.2 の開示（#39）。**生成もフォークもここを通るので、1 か所で覆える**
      // （`createPendingGame` と `createForkedGame` の両方がこの関数を呼ぶ）。
      // **入るのはこちらの一覧が持つ正式名だけで、利用者が書いた文字列は入らない**
      // （`migrations/0015_games_ip_notice.sql`）。当たらなければ null。
      ipNoticeOf(request.prompt),
      // 最初の指示文（#694 / `migrations/0047_games_prompt.sql`）。**作者本人にしか返さない**
      // （`src/works-api.ts`）。入力の検査で止まったら {@link failGame} が NULL へ戻す。
      request.prompt,
      ...(exclusive ? inFlightGuardBindings(userId, now) : []),
    )
    .run();

  // **0 行なら進行中の要求があった**（排他の枝でしか起きない。条件はそれ 1 つだけ）。
  if ((result.meta.changes ?? 0) === 0) {
    return null;
  }
  return { id, jobToken };
}

/**
 * ジョブを 1 つだけ走らせるための関門（#150）。
 *
 * **ここが「LLM を 1 回しか呼ばない」ことを担保する唯一の場所である。**
 *
 * AWS Lambda の非同期呼び出しは、**関数がエラーを返さなくても同じイベントを複数回
 * 配信しうる**（キューが結果整合であるため。AWS 明文）。`MaximumRetryAttempts=0` の
 * 設定は既定の 2 回再試行を止めるだけで、この重複は止まらない。**設定は誰かが変えれば
 * 消えるが、この条件付き UPDATE はデータ側にあるので消えない。**
 *
 * 重複が止まらないと、1 回の送信につき 1 生成 ¥22.41（2026-09-04 / 本番の既定群 20 件の
 * 平均。4.2 の実測注記）が二重・三重に出て——**¥44.82 / ¥67.23**——日次枠も同時に減る
 * （確定25 は枠を台帳の行数で数える）。**#150 が再送案を退けたのと同じ害が、今度は
 * インフラ側から入ってくる。**
 *
 * `pending` からの遷移だけを許すので、2 通目以降は 0 行更新になり `false` が返る。
 * 呼び出し側は**そこで降りる**（LLM を呼ばない）。
 *
 * @param env バインディングと環境変数
 * @param gameId 対象の作品 id
 * @param jobTokenHash ジョブトークンのハッシュ
 * @param now 開始時刻（UNIX 秒。既定は現在時刻）
 * @returns このジョブを握れたら true。既に誰かが握っている・トークンが違うなら false
 */
export async function claimGenerationJob(
  env: Env,
  gameId: string,
  jobTokenHash: string,
  now: number = Math.floor(Date.now() / 1000),
): Promise<boolean> {
  const result = await env.DB.prepare(
    `update games
        set generation_state = 'running', generation_started_at = ?
      where id = ? and generation_state = 'pending' and job_token_hash = ?`,
  )
    .bind(now, gameId, jobTokenHash)
    .run();

  // D1 の `meta.changes` は実際に更新された行数。**存在検査と排他を 1 回の往復で行う。**
  // 先に select してから update する形にすると、その隙間で 2 通目が通りうる。
  return (result.meta.changes ?? 0) > 0;
}

/**
 * 成果物が揃ったことを記録する（3.3-8 / #150）。
 *
 * # 1 本の UPDATE で全部書く
 *
 * `go_version` / `source_key` / `wasm_key` / `preview_key` / `generation_state` を
 * **同時に**書く。「揃っている」ことが 1 つの原子的な事実になり、中途半端に見える
 * 瞬間が無い。**とくに `preview_key` と成果物のキーは同時でなければならない**
 * ——先に `preview_key` が入ると、成果物の無い行が配信側から引けてしまう
 * （モジュール冒頭の隔離が崩れる）。
 *
 * # 順序: `games` を先に、索引をあとに
 *
 * **入れ替えないこと。** 確定26 の削除規約（3.7 / `deleteUnreferencedArtifacts`）は
 *
 *   1. 消す対象を指す索引を先に落とし、
 *   2. **`games` を数え直してから** R2 を消す
 *
 * という順で走る。索引を先に書いて `games` を後にすると、その隙間に走った掃除が
 * 「参照ゼロ」と数えて成果物を消し、**こちらは消えたオブジェクトを指す行を作る。**
 *
 * **#150 で行の作成そのものは前倒しになったが、この順序は変わっていない。**
 * 掃除が数えるのは `source_key` / `wasm_key` であり、それを書くのはこの UPDATE だから
 * である（`pending` の行はキーが NULL なので、何も参照していない）。
 *
 * # ヒット時も索引を書き直さない
 *
 * 索引は既にあり、書き直すと `created_at` だけが若返る（`buildCacheRecordOf`）。
 *
 * @param env バインディングと環境変数
 * @param gameId 対象の作品 id
 * @param built ビルドの結果（ヒット・非ヒットのどちらでもよい）
 * @param now 完成時刻（UNIX 秒。既定は現在時刻）
 * @returns 更新できたら true（`running` でなければ false）
 */
export async function completeGame(
  env: Env,
  gameId: string,
  built: BuildOutcome,
  now: number = Math.floor(Date.now() / 1000),
): Promise<boolean> {
  const keys = artifactKeysOf(built);
  return await completeGameWithArtifacts(
    env,
    gameId,
    { goVersion: built.goVersion, sourceKey: keys.sourceKey, wasmKey: keys.wasmKey },
    buildCacheRecordOf(built),
    now,
  );
}

/** 完成した行へ書き込む成果物の在り処。 */
export interface CompletedArtifacts {
  /** ビルドに使った Go の版（3.5 の `wasm_exec.js` 出し分け）。 */
  readonly goVersion: string;
  /** `source.go` の R2 キー。 */
  readonly sourceKey: string;
  /** `.wasm.br` の R2 キー。 */
  readonly wasmKey: string;
}

/**
 * 成果物の在り処を明示して行を完成させる（#150）。
 *
 * **{@link completeGame} の下層である。** 分けてあるのは、生成の本体が Worker の外
 * （オーケストレータ Lambda）へ出ると、完成の通知が**コールバックの JSON**として
 * 届くためである。JSON から `BuildOutcome`（ヒットと非ヒットの直和型）を組み立て直すと、
 * **型の形を復元する作業そのものが検証の抜け道になる。** コールバック側は
 * 「この経路が実際に使う値」だけを検証して、ここへ渡す
 * （`src/generate-callback.ts`）。
 *
 * 順序（`games` を先に、索引をあとに）と原子性の根拠は {@link completeGame} にある。
 *
 * @param env バインディングと環境変数
 * @param gameId 対象の作品 id
 * @param artifacts 成果物の在り処
 * @param cacheRecord 3.8 の索引へ新しく記録する内容（ヒット時は null）
 * @param now 完成時刻（UNIX 秒。既定は現在時刻）
 * @returns 更新できたら true（`running` でなければ false）
 */
export async function completeGameWithArtifacts(
  env: Env,
  gameId: string,
  artifacts: CompletedArtifacts,
  cacheRecord: BuildCacheRecord | null,
  now: number = Math.floor(Date.now() / 1000),
): Promise<boolean> {
  const result = await env.DB.prepare(
    `update games
        set go_version = ?, source_key = ?, wasm_key = ?, preview_key = ?,
            generation_state = 'ready', generation_error = null, job_token_hash = null
      where id = ? and generation_state = 'running'`,
  )
    .bind(
      // 3.5 の `wasm_exec.js` 出し分けに要る。ヒット時は索引が覚えている版で、
      // **そのとき配られる成果物もその版でビルドされたもの**である。
      artifacts.goVersion,
      artifacts.sourceKey,
      artifacts.wasmKey,
      // 5.4 の作者プレビュー URL（`/p/<preview_key>/`）。**完成のたびに新しく引く。**
      // 同じソースからの 2 件目（確定26 でキーは共有される）でも、プレビュー URL は
      // 別でなければならない。片方の URL を止めたときに、もう片方まで止まってしまう。
      createPreviewKey(),
      gameId,
    )
    .run();

  if ((result.meta.changes ?? 0) === 0) {
    // 既に完成・失敗している、あるいは握られていない。**索引も書かない。**
    // ここで索引だけ書くと、参照していない行のために成果物が生き続ける。
    return false;
  }

  // 3.8: 成果物は R2 に入っている（3.3-6 が書いた、あるいは索引が指していた）。
  if (cacheRecord !== null) {
    await recordBuildCache(env, cacheRecord, now);
  }

  return true;
}

/**
 * もう成果物が来ないことを記録する（#150）。
 *
 * **行は消さない。** 3.7 の掃除（未公開のまま 14 日で自動削除。確定13）にそのまま
 * 乗るので、失敗用の新しい掃除の規約を作らない。`status` を `draft` のまま据え置く
 * 選択が、ここでも効いている。
 *
 * `pending` からも遷移できるようにしてある。ジョブが始まる前に諦めた場合
 * （呼び出し自体に失敗した等）にも、行を放置しないためである。
 *
 * @param env バインディングと環境変数
 * @param gameId 対象の作品 id
 * @param code 失敗の分類名（8.3 の固定語彙）
 * @returns 更新できたら true（既に完了していれば false）
 */
export async function failGame(
  env: Env,
  gameId: string,
  code: GenerationErrorCode,
): Promise<boolean> {
  const result = await env.DB.prepare(
    // **入力の検査で止めた指示文は作品の行に残さない**（#694 / `0047`）。止めた指示文を
    // 残すのは `moderation_blocks` の 90 日だけ、という `/privacy` の約束を守るため。
    `update games
        set generation_state = 'failed', generation_error = ?, job_token_hash = null,
            prompt = case when ? = 'prompt-blocked' then null else prompt end
      where id = ? and generation_state in ('pending', 'running')`,
  )
    .bind(code, code, gameId)
    .run();

  return (result.meta.changes ?? 0) > 0;
}


/**
 * 公開済みの作品の状態（5.4）。
 *
 * **この綴りを作れるのは {@link publishGame} だけである。** 生成の経路
 * （{@link createPendingGame}）は {@link DRAFT_STATUS} を定数として書き込んでおり、
 * 引数で状態を受け取らない。5.4 の「「公開」操作で初めて URL が有効になる」は、
 * **書ける場所を 1 つに絞ること**で担保している。
 */
export const PUBLISHED_STATUS = 'published';

/**
 * 取り下げ（tombstone 化）された作品の状態（5.3 / 5.4 / M5-4 / #35 / 確定35）。
 *
 * **作者の操作では書かない**（#637 / 確定35。2026-09-17）。作者が公開をやめると
 * {@link unpublishGame} が {@link DRAFT_STATUS} へ戻す。**この状態を書くのは、運営の措置
 * （8.4。管理画面に置かず D1 の直接 UPDATE で行う）と、退会（確定34。`src/withdrawal.ts`）と、
 * 作者の削除が中身を消した tombstone（`src/game-deletion.ts`）だけである。**
 *
 * > **#35 から #637 までは「書き込むのは `removeGame` だけである」だった。** 取り下げが作者の
 * > 口でもあった時期の記述で、その関数はもう無い。
 */
export const REMOVED_STATUS = 'removed';

/**
 * 公開の結果（5.4 / #26）。
 *
 * **「できなかった」を 1 つにまとめない。** 呼び出し側（`src/publish.ts`）が返す
 * ステータスと文言が理由ごとに違うためである。一方で**作者以外には理由を渡さない**
 * ——他人の作品に対する要求は、行が無いのと同じ `not-found` になる（下記）。
 */
export type PublishOutcome =
  | {
      readonly ok: true;
      /** **この呼び出しが実際に遷移させたか。** 二度押しの 2 回目は false。 */
      readonly firstTime: boolean;
      /** `games.published_at`（UNIX 秒）。 */
      readonly publishedAt: number;
    }
  | {
      readonly ok: false;
      readonly reason: 'not-found' | 'not-ready' | 'removed' | WorkTagsRejection;
    };

/**
 * 作品を公開する（5.4 / #26）。
 *
 * # 4 つの条件を 1 本の UPDATE の WHERE に置く
 *
 * ```sql
 * where id = ? and author_id = ? and status = 'draft' and generation_state = 'ready'
 * ```
 *
 * **引いてから判定する形にしない。** `claimGenerationJob` と同じ理由である——
 * select と update の隙間に 2 通目が通ると、二度公開できてしまう。ここでは
 * それが **OGP の二重撮影**（＝ Lambda の二重起動）に直結する。
 *
 * 4 つはそれぞれ別のことを守っている。
 *
 * | 条件 | 何を止めるか |
 * |---|---|
 * | `author_id = ?` | **他人が他人の作品を公開すること。** 5.4 が「作者を唯一のフィルタとして使う」と定めており、ここが破れると設計そのものが無効になる |
 * | `status = 'draft'` | **二度目の公開。** これが冪等性の関門である（2 通目は 0 行更新） |
 * | `generation_state = 'ready'` | **成果物の無い作品の公開。** `pending` / `running` / `failed` の行には `preview_key` も `wasm_key` も無く（{@link completeGameWithArtifacts}）、公開しても `/g/` は 404 にしかならない |
 * | `id = ?` | 対象の特定 |
 * | `deletion_started_at is null` | **削除を掴まれた行の公開**（#516）。R2 を消してから D1 を確定するあいだに公開されると、消しかけの成果物を指す公開作品ができる（`src/game-deletion.ts`） |
 *
 * # 0 行だったときだけ、理由を引きに行く
 *
 * 条件付き UPDATE は「なぜ 0 行だったか」を返さない。**成功経路では引かない**
 * （公開は 1 作品につき 1 回の操作で、成功時に追加の読み取りを増やす理由が無い）。
 *
 * **理由を引く SELECT にも `author_id = ?` を入れる。** 入れないと、他人の作品に
 * 対して `not-ready` と `not-found` を撃ち分けることになり、**任意の id が実在するかを
 * 外から確かめられる手がかり**になる（`src/work-page.ts` の `notFound` と同じ考え方）。
 *
 * # `published_at` は「最初に公開した時刻」である
 *
 * 二度目の呼び出しでは書き換えない（`status = 'draft'` の条件が先に外れる）。
 * 公開の日時が押し直しのたびに若返る形は、5.5 の一覧や 3.7 の掃除が読む値としても
 * 正しくない。
 *
 * # OGP の撮影はここでは起こさない
 *
 * **この関数は `games` の 1 行を進めるだけである。** 撮影の起動（と、その冪等性の
 * 関門）は `src/ogp.ts` の `startOgpCapture` が持つ。分けてあるのは、撮影の可否が
 * **`status='published'` であること**を条件に持つためで、順序（公開 → 撮影）が
 * SQL の条件として現れる形にしたいからである。
 *
 * # `fork_count` はここで動く（5.5 / M5-3 / #34）
 *
 * **フォークの起動（`src/fork.ts` → {@link createForkedGame}）では動かさない。**
 * あちらが作るのは `status='draft'` / `generation_state='pending'` の行で、ビルドが
 * 通らずに終わるかもしれない。数えた瞬間に、5.5 の「このゲームからの改造: N 件」
 * （`status='published'` のみ）と食い違う。**子が公開された瞬間が、親の被改造数が
 * 増える唯一の瞬間である。**
 *
 * 加算ではなく**数え直し**である（{@link refreshParentForkCount}）。理由はそちらに
 * ある。
 *
 * # 2 度目の公開では `published_at` を動かさない（#637 / 確定35）
 *
 * **`coalesce(published_at, ?)` で書く。** 作者は公開をやめて下書きへ戻せる
 * （{@link unpublishGame}）ので、**同じ作品が 2 度以上ここを通る。** そのたびに時刻を
 * 書き換えると、公開作品の一覧の既定（`published_at` の降順。2.3.2）で、
 * **下書きへ戻して公開し直すだけで新着の先頭へ戻せる。**
 *
 * **「公開した日」は、初めて公開した日を指す。** 作者が一度取り下げてから出し直したことは、
 * 閲覧者にとって新しい作品が現れたことを意味しない。
 *
 * # タグは同じ UPDATE で書く（#376）
 *
 * **公開の遷移と同じ 1 本に置く。** 別の UPDATE にすると、二度押しの 2 回目（`status` は既に
 * `published`）でタグだけが書き換わりうる——**2 回目が別のチェックボックスの組を運んでいれば、
 * 公開した瞬間の選択が黙って上書きされる。** 同じ WHERE に載せれば、2 回目は 0 行でタグにも
 * 触らない。公開した後に変えたい作者は {@link retagGame} を使う。
 *
 * **検査は行を引く前に行う**（{@link validateWorkTags}。{@link renameGame} が 8.3 を先に掛けるのと
 * 同じ形）。語彙に無い値や 4 個以上は、**公開もせず、1 行も書かずに**理由を返す。**タグ無し
 * （空配列）は通す**——公開の入力を必須にしない（#376 の constraints）。
 *
 * **`tags_set_at` は書かない。** あれは付け直しの間隔を数える起点で、公開した直後に付け間違いに
 * 気づいた作者を待たせない（`migrations/` の `games_tags`）。
 *
 * > **#637 注記。2 度目の公開では、タグはフォームが運んできた値で置き換わる。** 公開をやめても
 * > タグは消さない（{@link unpublishGame} は `tag1` 〜 `tag3` に触れない）ので、**再公開の
 * > フォームは、いま付いているタグを選んだ状態で出す**（`src/work-page.ts` の `publishForm`）。
 * > **そうしないと、選び直さずに押した作者のタグが黙って消える**——二度押しを止めていたのは
 * > `status = 'draft'` の条件で、それが正当な再公開になったためである。
 *
 * @param env バインディングと環境変数
 * @param gameId 対象の作品 id
 * @param authorId 操作している利用者（**作者本人でなければ通らない**）
 * @param now 公開時刻（UNIX 秒。既定は現在時刻）
 * > **#673 注記。`tags` に null を渡すと、タグの列に触れずに公開する。** まとめて保存する口
 * > （`src/work-save.ts`）の JSON で鍵を省いた公開がこれを使う（「省いた項目は変えない」）。#673 で
 * > 下書きにもタグを付けられるようになり、**呼び出し側が先に読んだタグを渡すと、読んでから公開する
 * > までのあいだに別の保存が付けたタグを古い値で上書きしうる。** 同じ UPDATE の中で `tag1` 〜 `tag3`
 * > を自分自身へ書く（`case when ? then tag1 else ? end`）ので、その時点の行の値がそのまま残る。
 * > **語彙と個数の検査は掛けない**——残るのは既に `validateWorkTags` を通って書かれた値である
 * > （公開・付け直しのどちらの口も、検査を通した値しか書かない）。
 *
 * @param env バインディングと環境変数
 * @param gameId 対象の作品 id
 * @param authorId 操作している利用者（**作者本人でなければ通らない**）
 * @param now 公開時刻（UNIX 秒。既定は現在時刻）
 * @param tags 公開フォームで選ばれたタグの識別子（**検査前**。既定はタグ無し。**null ならタグを変えない**。#673）
 * @returns 公開の結果
 */
export async function publishGame(
  env: Env,
  gameId: string,
  authorId: string,
  now: number = Math.floor(Date.now() / 1000),
  tags: readonly string[] | null = [],
): Promise<PublishOutcome> {
  let slots: readonly [string | null, string | null, string | null] = [null, null, null];
  if (tags !== null) {
    const validated = validateWorkTags(tags);
    if (!validated.ok) {
      return { ok: false, reason: validated.reason };
    }
    slots = workTagSlots(validated.tags);
  }
  const [tag1, tag2, tag3] = slots;
  // **1 ならタグの列をいまの値のまま残す**（#673 注記。SQL の綴りを 1 つに保つため、分岐は束縛値で持つ）。
  const keepTags = tags === null ? 1 : 0;

  // **`returning` で公開時刻を持ち帰る**（#637）。`coalesce` を通すので、2 度目の公開で
  // 入っている値は `now` ではない。**行が返ったこと自体が「この呼び出しが遷移させた」**
  // でもある（0 行の UPDATE は 1 行も返さない）。
  const published = await env.DB.prepare(
    `update games
        set status = ?, published_at = coalesce(published_at, ?),
            tag1 = case when ? then tag1 else ? end,
            tag2 = case when ? then tag2 else ? end,
            tag3 = case when ? then tag3 else ? end
      where id = ? and author_id = ? and status = ? and generation_state = 'ready'
        and deletion_started_at is null
      returning published_at`,
  )
    .bind(
      PUBLISHED_STATUS,
      now,
      keepTags,
      tag1,
      keepTags,
      tag2,
      keepTags,
      tag3,
      gameId,
      authorId,
      DRAFT_STATUS,
    )
    .first<{ published_at: number | null }>();

  if (published !== null) {
    // **遷移が起きたときだけ数え直す。** 二度押しの 2 回目はここへ来ない
    // （`status = 'draft'` の条件が先に外れる）ので、押した回数では増えない。
    await refreshParentForkCount(env, gameId);
    // **`published_at` が NULL なのは 0001 以前の行だけ**だが、不変条件を呼び出し側が
    // 前提にしないため、読めなければ今の時刻を返す（下の二度押しの枝と同じ扱い）。
    return { ok: true, firstTime: true, publishedAt: published.published_at ?? now };
  }

  const row = await env.DB.prepare(
    'select status, published_at, deletion_started_at from games where id = ? and author_id = ?',
  )
    .bind(gameId, authorId)
    .first<{ status: string; published_at: number | null; deletion_started_at: number | null }>();

  if (row === null || (row.status !== PUBLISHED_STATUS && row.deletion_started_at !== null)) {
    // 行が無い、あるいは他人の作品。**区別しない。**
    // **削除を掴まれた行（#516）も同じ扱いにする**——消えていく途中の作品で、公開はさせない
    // （`src/game-deletion.ts`）。
    return { ok: false, reason: 'not-found' };
  }
  if (row.status === PUBLISHED_STATUS) {
    // **二度押し。** 公開そのものは成立している状態なので、失敗にしない。
    // `published_at` が NULL なのは 0001 以前の行だけだが、**不変条件を
    // 呼び出し側が前提にしない**ため、読めなければ今の時刻を返す。
    return { ok: true, firstTime: false, publishedAt: row.published_at ?? now };
  }
  if (row.status === 'removed') {
    // 8.4 の審査で落ちた作品。作者にも公開させない。
    return { ok: false, reason: 'removed' };
  }
  // `draft` のまま残ったということは、外れたのは `generation_state` の条件である。
  return { ok: false, reason: 'not-ready' };
}

/**
 * 公開をやめた結果（5.4 の「公開をやめて下書きへ戻せる」 / 確定35 / #637）。
 *
 * 形は {@link PublishOutcome} に揃えてある。**「できなかった」を 1 つにまとめない**
 * のも同じ理由で、呼び出し側が返すステータスと文言が理由ごとに違う。
 */
export type UnpublishOutcome =
  | {
      readonly ok: true;
      /** **この呼び出しが実際に遷移させたか。** 二度押しの 2 回目は false。 */
      readonly firstTime: boolean;
    }
  | { readonly ok: false; readonly reason: 'not-found' | 'not-published' };

/**
 * 作者が公開をやめる（`published → draft`。5.4 の「公開をやめて下書きへ戻せる」 / 確定35 / #637）。
 *
 * # `removed` にしない
 *
 * **`removed` は運営の措置（8.4）と退会（確定34）の専用状態である。** #35 まではここが作者の
 * 口でもあったが、**取り下げた作品は「あなたの作品」一覧（`status <> 'removed'`）にも検索にも
 * 出ないため、作品ページの URL を控えていない作者は、押した瞬間から削除も再公開もできなくなっていた。**
 * `draft` へ戻せば、下書きと同じ扱いになり、一覧から辿って再公開・リフォージ・削除ができる。
 *
 * # 4 つのことを同じ 1 本で守る
 *
 * | 守るもの | どこで守るか |
 * |---|---|
 * | **作者本人だけが公開をやめられる** | `where author_id = ?` |
 * | **公開中の作品にしか効かない** | 同 `where status = 'published'`（二度押しの 2 通目は 0 行更新） |
 * | **削除を掴まれた行は動かさない**（#516） | 同 `where deletion_started_at is null` |
 * | **配っていた試遊 URL を道連れに殺す** | `set preview_key = ?`（引き直す） |
 *
 * **`preview_key` を引き直すのは、意思表示を弱めないためである。** 試遊の配信は
 * `status <> 'removed'` で引く（`src/sandbox-delivery.ts`）ので、鍵をそのままにすると
 * **取り下げでは死んでいた `/p/` が、下書きでは生き続ける。** 作者は作品ページから新しい
 * 試遊 URL を取り直せる（リフォージの完了が同じことをしている。`src/revisions.ts`）。
 *
 * # 審査済み（`cleared`）は外し、審査待ち（`queued`）は残す
 *
 * **改名（{@link renameGame}）・説明の変更（{@link describeGame}）と同じ式を通す**
 * （{@link reviewStateAfterAuthorEditSql}）。**下書きのあいだに中身を入れ替えられる**ので、
 * `cleared` のまま再公開できると、一度審査を通した作品が通報の回路の外に出る（`cleared` は
 * 再び閾値に達しても戻らない）。`queued` を解かないのも同じ理由で、**新規露出を止めた状態を
 * 作者の操作で解けてはいけない。**
 *
 * # 紹介用の画像は撮り直させる
 *
 * **`ogp_state` を NULL へ戻す。** 撮影の関門は `ogp_state is null`（`src/ogp.ts` の
 * `claimOgpCapture`）で、**撮り終えた作品を撮り直す経路は無い**（#235 は中断した撮影の
 * 掴み直しで、別物である）。戻さないと、下書きのあいだにリフォージして再公開した作品の
 * 紹介画像が、前の中身のまま残る。**`ogp_key` は消さない**——鍵は作品ごとに 1 枚
 * （`ogp/<game_id>.png`）なので、次の撮影が上書きする。`ogp_state` が NULL のあいだは
 * 画像の配信も引けない（あちらは `ogp_state = 'ready'` で引く）。
 *
 * **走っている最中の撮影も落とす。** `ogp_token_hash` を消すので、遅れて届いた
 * コールバックはトークンの照合に落ちる（`ogp_started_at` も一緒に戻す）。
 *
 * # 親の被改造数は数え直す
 *
 * 5.5 の「このゲームからのフォーク: N 件」は `status='published'` のみを数えるので、
 * 下書きへ戻した作品が数に残ってはいけない。{@link refreshParentForkCount} は数え直しなので、
 * **増やす側と同じ 1 本で賄える**（#35 の取り下げが同じことをしていた）。
 *
 * # 連鎖しない
 *
 * **この関数は `games` の 1 行しか書き換えない。** 子の `status` に触れない——公開をやめても、
 * そこから派生した作品は公開されたままである（5.3 の「連鎖削除は荒れるため採らない」と同じ）。
 *
 * @param env バインディングと環境変数
 * @param gameId 対象の作品 id
 * @param authorId 操作している利用者（**作者本人でなければ通らない**）
 * @returns 公開をやめた結果
 */
export async function unpublishGame(
  env: Env,
  gameId: string,
  authorId: string,
): Promise<UnpublishOutcome> {
  // **別名 `g` は審査状態の式が求める**（{@link reviewStateAfterAuthorEditSql}。{@link renameGame} と同じ形）。
  const result = await env.DB.prepare(
    `update games as g
        set status = ?,
            preview_key = ?,
            ogp_state = null,
            ogp_token_hash = null,
            ogp_started_at = null,
            ${REVIEW_STATE_COLUMN} = ${reviewStateAfterAuthorEditSql()}
      where id = ? and author_id = ? and status = ? and deletion_started_at is null`,
  )
    .bind(DRAFT_STATUS, createPreviewKey(), gameId, authorId, PUBLISHED_STATUS)
    .run();

  if ((result.meta.changes ?? 0) > 0) {
    await refreshParentForkCount(env, gameId);
    return { ok: true, firstTime: true };
  }

  // **理由を引く SELECT にも `author_id = ?` を入れる**（{@link publishGame} と同じ理由。
  // 他人の作品に対して理由を撃ち分けると、任意の id が実在するかを外から確かめられる手がかりになる）。
  const row = await env.DB.prepare('select status from games where id = ? and author_id = ?')
    .bind(gameId, authorId)
    .first<{ status: string }>();

  if (row === null) {
    return { ok: false, reason: 'not-found' };
  }
  if (row.status === DRAFT_STATUS) {
    // **二度押し。** 公開をやめること自体は成立している状態なので、失敗にしない。
    return { ok: true, firstTime: false };
  }
  // `removed`（運営の措置・退会）と、削除を掴まれた行がここへ来る。**どちらも作者は動かせない。**
  return { ok: false, reason: 'not-published' };
}

/**
 * 改名の結果（5.4 / #366）。
 *
 * 形は {@link RemoveOutcome} に揃えてある。**「できなかった」を 1 つにまとめない**
 * のも同じ理由で、呼び出し側（`src/work-page.ts`）が返すステータスと文言が理由ごとに違う。
 */
export type RenameOutcome =
  | {
      readonly ok: true;
      /**
       * 保存されている題名（**正規化後**）。
       *
       * **同じ題名を入れ直したときは、いま入っている値がそのまま返る。**
       */
      readonly title: string;
      /** **この呼び出しが実際に題名を変えたか。** 同じ題名の入れ直しは false。 */
      readonly changed: boolean;
    }
  | { readonly ok: false; readonly reason: RenameRejection };

/**
 * 改名を受け付けなかった理由（#366）。
 *
 * **`denied-term` に語も分類も添えない。** 8.2 が検出箇所を返さないのと同じ方針で、
 * **当てては消しを繰り返せば表（`src/denied-terms.ts`）が 1 語ずつ復元できる**口を、
 * 利用者の自由入力に対して開かない。呼び出し側も分類を出さない。
 */
export type RenameRejection = 'not-found' | 'removed' | 'not-ready' | 'denied-term';

/**
 * 作者が題名や説明を変えたときの、審査状態の新しい値を表す SQL の式（8.4 / #366 / #388 / #404）。
 *
 * **{@link renameGame} と {@link describeGame} の UPDATE が、`set review_state = <この式>` として
 * 共有する。** 戻し方を 2 か所に書くと、片方だけが古くなる。
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * 規則（変更前の状態 → 変更後の状態）
 * ══════════════════════════════════════════════════════════════════════════════
 *
 *   - `cleared` で、**最後に `cleared` にした時刻以降の通報がある** → **`queued`**（#404）
 *   - `cleared` で、そういう通報が無い → `NULL`（#366。審査で見たのは変更前の題名・説明である）
 *   - `queued` → `queued` のまま（変更で審査待ちを解けてはいけない）
 *   - `NULL` → `NULL` のまま
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * なぜ `NULL` ではなく `queued` にする場合があるのか（#404）
 * ══════════════════════════════════════════════════════════════════════════════
 *
 * **`NULL` へ戻すだけだと、`cleared` のあとに届いていた通報が誰にも見えなくなる。**
 * その通報は {@link REVIEW_REPORTED_AFTER_CLEAR_SQL}（`cleared` を求める）で運営に出ていたが、
 * `NULL` になると条件から外れる。`recordReport` が `queued` へ上げるのは通報が届いた時点
 * だけで、同じ人は同じ作品を 2 度通報できない（`reports_game_reporter_uq`）——**届いていた
 * 通報は、作者の改名 1 回で埋もれた。** #366 が塞ごうとした「穏当な題名で公開 → 通報 →
 * `cleared` → 改名」の悪用が、形を変えて残っていた。
 *
 * **#366 の「`queued` にはしない」は、ここで覆していない。** あの決定の理由は「善意の改名で
 * 作品がトップから消える」だった。**この式が `queued` にするのは、運営がまだ見ていない
 * 通報が届いている作品だけ**で、通報の無い作品の善意の改名は、これまでどおり `NULL` へ
 * 戻るだけで露出を止めない。**止まるのは「通報を受けたあとに作者が題名や説明を変えた」
 * ときで、それは #366 が塞ごうとした形そのもの**である。しかも通報が閾値（1 人）に達して
 * いる以上、`NULL` の作品に同じ通報が届いていれば `recordReport` が `queued` にしていた
 * ——**`cleared` を解いた結果として、通報のある `NULL` の作品と同じ扱いに揃う**だけである。
 *
 * **審査キューの条件は変えない**（issue #404 の案 B を採らなかった）。案 B（キューの条件を
 * 「`cleared` または `NULL`」へ広げる）は、「閾値が 1 人である限り、通報のある `NULL` の作品は
 * この戻しの経路でしか生まれない」という前提に乗り、閾値を上げた日に意味が変わる。
 * **この式は状態を「未審査の通報がある」という実態に合わせるので、閾値に依らない。**
 *
 * **履歴の無い `cleared`（#361 より前に端末で `cleared` にした作品）は、通報が 1 件でも
 * あれば `queued` へ入る**（{@link REVIEW_REPORTED_AFTER_CLEAR_SQL} の `coalesce(…, 0)`。#394 の
 * 決定）。運営がその通報を端末で見終えていても、D1 はそれを区別できない——#394 が審査キューの
 * 節に出すと決めた作品と同じ集合で、**運営が画面から 1 度往復させれば外れる。** その前に作者が
 * 変更すると露出が止まるのが、この扱いの代償である（仕様書 5.4 の実装注記）。
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * 条件は {@link REVIEW_REPORTED_AFTER_CLEAR_SQL} をそのまま使う（書き直さない）
 * ══════════════════════════════════════════════════════════════════════════════
 *
 * **「最後に `cleared` にした時刻以降の通報がある」の定義を 2 か所に置かない。** 審査キューの
 * 節（`src/admin/review.ts`）・`scripts/report-queue.sh`・この式が同じ文字列を使うので、
 * #361 より前の `cleared` の扱いも、同じ秒を拾う側へ倒す `>=` も、ひとりでに揃う。
 * その条件が `cleared` を含んでいるので、`case` の側で状態を見直さない。
 *
 * **あちらは `games` の別名を `g` に固定している**（あちらの但し書き）。**この式を置く
 * UPDATE は `update games as g` で書くこと。**
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * 判定と書き込みを 1 つの式にする（読みと書きの隙間を作らない）
 * ══════════════════════════════════════════════════════════════════════════════
 *
 * **先に読んで分岐してから書く形にしない。** 読みと書きの間に運営が状態を動かしたり通報が
 * 届いたりすると、読んだ時点の状態で書いてしまう。**UPDATE の `set` の式として判定すれば、
 * SQLite は書き換える行を読んだその場で式を評価する**（D1 は文を 1 本ずつ直列に流し、
 * batch は 1 つのトランザクションである）。同じ batch で先に積む履歴の insert は
 * `reports` / `admin_actions` を触らないので、判定の結果を変えない。
 *
 * **通報がこの UPDATE の後に届いた場合**は、状態が既に `NULL` なので `recordReport` が
 * `queued` へ上げる（あちらの「読んだ状態で諦めない」但し書き）。**前に届いた場合**は
 * この式が拾う。どちらの順でも埋もれない。
 *
 * **定数だけから組み立てる**（利用者の入力は 1 文字も入らない）ので、束縛にしない
 * （`reviewVisibleSql` / `reviewAttentionSql` と同じ扱い）。
 *
 * **モジュールの定数にせず、関数にする。** 他のモジュールの定数を差し込むテンプレート
 * リテラルは、esbuild から見ると副作用を持ちうる式で、**オーケストレータが 1 度も呼ばない
 * この式のために束（CodeSha256）が変わりうる**（{@link containsDirectionCharacter} と同じ
 * 事情。PR #401）。関数に閉じれば、呼ばれない関数ごと束から落ちる。
 *
 * @returns `set review_state = ` の右辺に置ける式（**`games` の別名は `g`**）
 */
function reviewStateAfterAuthorEditSql(): string {
  return (
    `case when ${REVIEW_REPORTED_AFTER_CLEAR_SQL} then '${REVIEW_QUEUED}'` +
    ` else nullif(g.${REVIEW_STATE_COLUMN}, '${REVIEW_CLEARED}') end`
  );
}

/**
 * 作者が作品の題名を変える（5.4 / #366）。
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * 正規化は {@link normalizeTitle} を通す（規則を 2 か所に置かない）
 * ══════════════════════════════════════════════════════════════════════════════
 *
 * **生成側と同じ関数である。** 制御文字・前後の空白・40 文字・空の既定（`無題の作品`）は
 * すべてあちらの規則で、**ここには 1 つも書かない。** 書き足すと「宣言したときだけ
 * 41 文字が通る」たぐいの食い違いが黙って生まれる（#365 が同じことを書いている）。
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * 8.3 の表を掛ける（8.2 は通せない）
 * ══════════════════════════════════════════════════════════════════════════════
 *
 * **現在の題名は必ず 8.2（Guardrail）を通ったプロンプト由来である**（遮断されれば
 * `games` の行すら作られない）。改名はその前提を崩すが、`withInputModeration` は
 * オーケストレータ Lambda の中だけにあり、**Worker から呼ぶ経路が無い**
 * （`src/orchestrator/pipeline.ts`）。そこで 8.3 の表（`src/denied-terms.ts`）を掛ける
 * ——同期の純粋関数で、エッジ側が既に借りている層である。**8.2 の代わりではない。**
 * 残りは 8.4 の通報が受ける（issue #366 の決定）。
 *
 * **検査するのは正規化した後の値である。** 40 文字で切った後を見るので、**保存される
 * 文字列そのもの**が検査に掛かる（切られて消える語で断らない／切った結果を素通ししない）。
 *
 * **行を引く前に検査する。** 表に当たる要求は、対象が誰の作品であっても 1 行も書かない
 * ——**成功経路の読み取りを 1 件も増やさない**ためでもある（3.6）。そのぶん、存在しない
 * 作品への要求が `not-found` ではなく `denied-term` で返りうるが、**どちらも「何も
 * 起きなかった」であり、作品の実在は漏れない**（むしろ表に当たった時点で id を見に
 * 行かないほうが漏れが少ない）。
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * 改名と履歴を 1 つの batch で書く（履歴の無い改名を作らない）
 * ══════════════════════════════════════════════════════════════════════════════
 *
 * **順序に意味がある。履歴を先に積む。** 旧題名は `games` の行から取るので、
 * UPDATE の後では読めない（`src/admin/actions.ts` が「先に状態を動かす」のと逆なのは、
 * あちらの履歴が**動いた後の状態**を `exists` で見るためである）。
 *
 * **2 文の WHERE は同じである。** `src/revisions.ts` の `claimRevisionSlot` と同じ形で、
 * 条件がそろっていなければ**どちらも 0 行**になる（断られた要求で履歴だけが積まれない）。
 * そして履歴の insert が落ちれば（0027 の CHECK・D1 の障害）**batch ごと巻き戻り、
 * 題名も変わらない。**
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * `cleared` は解く。届いていた通報があれば `queued`、無ければ `NULL`
 * ══════════════════════════════════════════════════════════════════════════════
 *
 * **審査で見たのは改名前の題名である。** 別の題名になった作品について「見た結果、
 * 問題なし」と言い続けることはできないので、終端（`REVIEW_CLEARED`）を解く。
 *
 * **通報の無い作品は `NULL` へ戻し、`queued` にはしない**（#366）。`queued` は新規露出を
 * 止める状態なので（`reviewVisibleSql`）、**善意の改名で作品がトップから消える。** `NULL`
 * へ戻せば、以後の通報は 8.4 の閾値を通って普通にキューへ入る。
 *
 * **`cleared` にしたあとの通報が届いていれば `queued` にする**（#404）。`NULL` へ戻すと
 * その通報が埋もれるためで、理由と #366 との関係は {@link reviewStateAfterAuthorEditSql}。
 * `queued` の作品は `queued` のまま（審査待ちのまま題名だけが変わる）、`NULL` の作品は
 * `NULL` のままである。
 *
 * **分岐をアプリ側に持たない**（UPDATE の式で判定する）——先に読んでから決める形にすると、
 * 読みと書きの隙間に通報や運営の操作が入ったときに、読んだ時点の状態で書いてしまう。
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * 取り下げた作品と、まだ完成していない作品は改名できない
 * ══════════════════════════════════════════════════════════════════════════════
 *
 * tombstone は「もう見せない」という意思表示で（運営の措置・退会・作者の削除。{@link REMOVED_STATUS}）、
 * 題名はどの画面にも出ない。**押せば断られる操作を口だけ開けておかない**
 * （`src/work-page.ts` は同じ条件でフォームを出さない）。
 *
 * **`generation_state = 'ready'` も SQL の条件に置く**（PR #391 の Copilot レビュー）。
 * 画面側は `state === 'ready'` のときしかフォームを出さないが、**画面の条件は経路の
 * 関門ではない**——`POST` を直接投げれば `pending` / `running` / `failed` の行も改名
 * できてしまい、5.4 の「生成が完了している作品だけ」と食い違う。{@link publishGame} が
 * 同じ条件を 1 本の UPDATE の WHERE に置いているのと同じ形にする。
 *
 * @param env バインディングと環境変数
 * @param gameId 対象の作品 id
 * @param authorId 操作している利用者（**作者本人でなければ通らない**）
 * @param candidate 作者が入力した題名（**正規化前**）
 * @param now 改名時刻（UNIX 秒。既定は現在時刻）
 * @returns 改名の結果
 */
export async function renameGame(
  env: Env,
  gameId: string,
  authorId: string,
  candidate: string,
  now: number = Math.floor(Date.now() / 1000),
): Promise<RenameOutcome> {
  const title = normalizeTitle(candidate);

  // **語も分類も外へ出さない**（{@link RenameRejection}）。
  if (!inspectText(title).ok) {
    return { ok: false, reason: 'denied-term' };
  }

  // **条件の綴りを 1 つにする。** 2 文へ書き分けると、片方だけを直した日に
  // 「断られた要求で履歴だけが積まれる」形ができる。**別名を付けない**ので、
  // どちらの文へもそのまま置ける（`insert ... select` 側は `from games` が
  // 1 つしかなく、列の解決に曖昧さが無い）。
  // **削除を掴まれた行は改名しない**（#516。確定の batch の直前に履歴が積まれると、行ごと消す
  // ときに履歴の外部キーが残る。`src/game-deletion.ts`）。
  const conditions =
    "id = ? and author_id = ? and status <> ? and generation_state = 'ready' and title <> ?" +
    ' and deletion_started_at is null';
  const bindings = [gameId, authorId, REMOVED_STATUS, title] as const;

  const results = await env.DB.batch([
    // **履歴を先に積む。** 旧題名は UPDATE の前の行からしか取れない（上記）。
    env.DB.prepare(
      `insert into ${TITLE_CHANGES_TABLE} (id, game_id, old_title, new_title, changed_at)
       select ?, id, title, ?, ?
         from games
        where ${conditions}`,
    ).bind(crypto.randomUUID(), title, now, ...bindings),
    // **別名 `g` は審査状態の式が求める**（{@link reviewStateAfterAuthorEditSql}）。
    // `conditions` は別名を付けずに書いてあり、`g` の列としてそのまま解決される。
    env.DB.prepare(
      `update games as g
          set title = ?, ${REVIEW_STATE_COLUMN} = ${reviewStateAfterAuthorEditSql()}
        where ${conditions}`,
    ).bind(title, ...bindings),
  ]);

  // **添字で読む**（`noUncheckedIndexedAccess`。`src/admin/actions.ts` と同じ形）。
  const historyRows = results[0]?.meta.changes ?? 0;
  const renamedRows = results[1]?.meta.changes ?? 0;

  if (renamedRows > 0) {
    // **履歴の無い改名は構造上ありえない**（同じ条件・同じ batch）。ありえない形を
    // 黙って通さない（`src/admin/actions.ts` と同じ扱い）。出るとすれば D1 の意味が
    // 変わったときで、それは気づきたい。
    if (historyRows === 0) {
      console.error('[games] 履歴の無い改名が入りました（batch の意味が変わっています）');
    }
    return { ok: true, title, changed: true };
  }

  // **0 行だったときだけ、理由を引きに行く**（{@link publishGame} と同じ方針。
  // 理由を引く SELECT にも `author_id = ?` を入れる——他人の作品に対して理由を
  // 撃ち分けると、任意の id が実在するかを外から確かめられる手がかりになる）。
  const row = await env.DB.prepare(
    'select status, generation_state, title, deletion_started_at from games where id = ? and author_id = ?',
  )
    .bind(gameId, authorId)
    .first<{ status: string; generation_state: string; title: string; deletion_started_at: number | null }>();

  if (row === null || (row.status !== REMOVED_STATUS && row.deletion_started_at !== null)) {
    // 削除を掴まれた行（#516）は、行が無いのと同じ扱いにする（{@link publishGame} と同じ）。
    return { ok: false, reason: 'not-found' };
  }
  if (row.status === REMOVED_STATUS) {
    return { ok: false, reason: 'removed' };
  }
  if (row.generation_state !== 'ready') {
    // まだ成果物が無い（`pending` / `running` / `failed`）。**題名だけ先に付けさせない**
    // ——失敗した行の題名を変えても出る場所が無く、生成中の行は完成時に何ができるかも
    // 決まっていない。
    return { ok: false, reason: 'not-ready' };
  }
  // 残る理由は「同じ題名だった」である。**失敗にしない**（二度押しと、正規化の結果が
  // いまの題名と一致した場合の両方がここへ来る。{@link unpublishGame} の二度押しと同じ扱い）。
  return { ok: true, title: row.title, changed: false };
}

/**
 * 作品の説明の最大の長さ（**コードポイントで数える**。#388）。
 *
 * **1000 文字。** 説明に入れたいのは、遊び方の数行と、5.6 のクレジット表記（原作・素材・
 * 二次利用の条件）である。参照元の AivisHub のモデル説明もこの範囲に収まる。**長さを
 * 利用者の文章量の上限としてではなく、D1 の 1 行と作品ページの 1 画面を守る値として置く**
 * ——履歴（`description_changes`）は変更のたびに旧い説明と新しい説明の両方を持つので、
 * 1 回の変更で最大 2 倍の文字列が積まれる（3.6）。
 *
 * **数え方は表示名（`src/account.ts` の `DISPLAY_NAME_MAX_LENGTH`）と同じである**
 * ——UTF-16 の長さでも書記素でもなく、コードポイント。**改行は 1 文字に数える**
 * （`\r\n` は {@link validateDescription} が `\n` へ畳んでから数える。ブラウザは
 * `<textarea>` の改行を `\r\n` で送るので、畳まずに数えると改行が 2 文字になる）。
 */
export const MAX_DESCRIPTION_LENGTH = 1000;

/**
 * 説明を変えてから、次の変更を受け付けるまでの秒数（#388 / 3.6）。
 *
 * **表示名の `DISPLAY_NAME_CHANGE_INTERVAL_SECONDS` と同じ考え方・同じ値である。** 連打で
 * D1 の書き込みを増やさない。説明の変更は 1 回で 2 行（履歴と `games`）を書くので、
 * 60 秒に 1 回なら 1 作品に 1 日張り付いても 2,880 行（無料枠 10 万行/日 の 2.9%）に収まる。
 *
 * **数え方は作品ごとである**（`games.description_set_at`）。作者ごとにすると、ある作品の
 * 説明を直した直後に別の作品のクレジットを書けない——止めたいのは連打であって、
 * 作品を並べて手入れすることではない。
 */
export const DESCRIPTION_CHANGE_INTERVAL_SECONDS = 60;

/**
 * 説明とタグを書ける作品の範囲（#673）。{@link describeGame} と {@link retagGame} の最後の引数。
 *
 * **既定は公開済みの作品だけである**（1 件ずつの口 `/api/works/describe`・`/api/works/retag` の挙動を変えない。
 * #673 の scope.out）。**`allowDraft: true` を渡すのはエディットページのまとめて保存する口だけ**
 * （`src/work-save.ts`）——Studio の「動画の詳細」と同じく、下書きのまま説明とタグを整えてから公開できるようにする。
 *
 * **下書きに書いても、作者以外には見えない。** 作品ページ・検索・タグの一覧・作者ページ・sitemap は
 * `status = 'published'` の行しか引かず、下書きの作品ページは作者以外に 404 を返す（`src/work-page.ts`）。
 * `og:description` は固定の文言で、説明を載せない。
 *
 * **変更の間隔と履歴は公開済みと同じ規則である**（`description_set_at` / `tags_set_at` と `description_changes`。
 * 同じ SQL を通る）。したがって、下書きで説明を書いた直後に公開して書き直すと、間隔の内側では断られる。
 */
export interface WorkDetailsEditOptions {
  /** 下書き（`status = 'draft'`）の作品にも書くか。既定は false（公開済みだけ）。 */
  readonly allowDraft?: boolean;
}

/**
 * 書ける作品の状態を、SQL の `status in (?, ?)` へ渡す 2 つの値にする（#673）。
 *
 * **SQL の綴りを 1 つに保つために、常に 2 つ渡す**（公開済みだけのときは同じ値を 2 度渡す）。綴りを分岐させると、
 * 片方だけを直した日に「1 件ずつの口とまとめて保存する口で条件が食い違う」形ができる。
 *
 * @param options 書ける範囲
 * @returns `status in (?, ?)` の 2 つの値
 */
function editableStatuses(options: WorkDetailsEditOptions): readonly [string, string] {
  return [PUBLISHED_STATUS, options.allowDraft === true ? DRAFT_STATUS : PUBLISHED_STATUS];
}

/**
 * 説明の変更の履歴を持つ表の名前（`migrations/0028_game_descriptions.sql`）。
 *
 * **`TITLE_CHANGES_TABLE` と違い、このモジュールが持つ。** あちらが `src/reports.ts` に
 * あるのは #366 の条件（`REVIEW_RENAMED_SQL`。#394 で `REVIEW_REPORTED_AFTER_CLEAR_SQL` へ
 * 置き換わった）が引いていた名残で（循環参照を避けた）、この表を引く審査の条件は無い
 * （説明の変更は、改名と同じ {@link reviewStateAfterAuthorEditSql} で審査状態を決める。#404）。
 *
 * **#405 で引く側ができた**（審査キューが通報の時点の説明を復元する。`src/admin/report-evidence.ts`）
 * **が、ここに残す。** 引く側は admin の画面のモジュールで、このモジュールがそこから import
 * すると、**オーケストレータの束（このモジュールが入る）に admin のコードが載る。**
 * admin の側がここから import する向きなら、束に余計なものは入らない。
 */
export const DESCRIPTION_CHANGES_TABLE = 'description_changes';

/**
 * 説明に含めてはいけない文字（#388）。**改行（LF）だけを除いた、表示名と同じ組である。**
 *
 * - **`\p{Cc}`（制御文字）から LF を除いたもの。** タブ・NUL・DEL・C1 制御文字（NEL を
 *   含む）を弾く。CR は {@link validateDescription} が先に LF へ畳むので、ここへは来ない
 * - **`\p{Zl}` / `\p{Zp}`（U+2028 / U+2029）。** Unicode 上の行区切りで、改行として
 *   扱う経路（LF）と別の綴りを残すと、表示する側によって段落の割れ方が変わる
 *
 * **範囲は `src/account.ts` の `FORBIDDEN_CHARACTER` と同じ組にする**（題名の
 * {@link normalizeTitle} が同じ組を持つのと同じ理由——名前の側で禁じた文字を別の欄から
 * 入れさせない）。**あちらを import しない**のは、このモジュールがオーケストレータの束に
 * 入っており（`scripts/bundle-orchestrator.sh`）、`src/account.ts` を辿ると画面の外枠まで
 * 束へ連れてくるためである。**組が一致していることは `test/work-description.test.ts` が
 * 表示名の検査と文字ごとに突き合わせる**（書き写した組は必ず腐る。shared-ai-rules 12 章）。
 *
 * **LF だけを許すのは、説明が複数行の文章だからである**（#388 の scope.out は「改行以外の
 * 装飾」を扱わないと書いており、改行は持つ）。**クレジット表記は行を分けて書くのが普通**で、
 * 1 行に畳ませると読めない。
 */
const DESCRIPTION_FORBIDDEN_CHARACTER = /(?!\n)[\p{Cc}\p{Zl}\p{Zp}]/u;

/**
 * 説明に含めてはいけない、文字の向きを変える書式文字（#388）。
 *
 * **`src/account.ts` の `DIRECTION_FORMATTING_CHARACTER` と同じ特性（`Bidi_Control`）で
 * 引く。** 説明は作者名・運営の印と同じ画面に並ぶので、表示名が弾く理由（5.9「名前の
 * 側から印の見え方を動かせてはいけない」）がそのまま当てはまる。
 *
 * **モジュールの定数にせず、関数の中に置く。** esbuild は `\p{Bidi_Control}` を
 * `new RegExp(...)` へ書き換え、**例外を投げうる式として束から落とさない**——定数に
 * すると、オーケストレータが 1 度も呼ばない説明の検査のために束（CodeSha256）が変わる
 * （`scripts/bundle-orchestrator.sh`。PR #401 で実測した）。関数に閉じれば、呼ばれない
 * 関数ごと束から落ちる。
 *
 * @param value 検査する文字列
 * @returns 向きを変える書式文字を含めば true
 */
function containsDirectionCharacter(value: string): boolean {
  return /\p{Bidi_Control}/u.test(value);
}

/** 説明の形を受け付けなかった理由（#388）。 */
export type DescriptionFormRejection = 'too-long' | 'forbidden-character';

/** 説明の形の検査の結果。 */
export type DescriptionValidation =
  | { readonly ok: true; readonly value: string }
  | { readonly ok: false; readonly reason: DescriptionFormRejection };

/**
 * 説明を検査し、保存する形へ落とす（#388）。
 *
 * # 題名の {@link normalizeTitle} と性質が違う（切らずに断る）
 *
 * **長すぎる説明は断る。黙って切らない。** `normalizeTitle` が切るのは、あれが
 * プロンプトから**仮の題を作る**関数でもあるからで（生成側の初期値と改名が同じ規則を
 * 通る）、説明にはその事情が無い。**文章の末尾を黙って落とすと、クレジットの最後の
 * 1 行が消えたまま公開される。**
 *
 * **禁じた文字も空白へ潰さずに断る。** 題名は 1 行に畳む関数なので改行を空白へ潰すが、
 * 説明は改行を持ち、しかも作者が貼り付けた文章をそのまま出す欄である。**見えない文字を
 * 黙って置き換えると、作者が見ている文章と保存された文章が食い違う。**
 *
 * # 規則
 *
 * 1. **`\r\n` と `\r` を `\n` へ畳む。** ブラウザは `<textarea>` の改行を `\r\n` で送る
 * 2. **禁じた文字を含めば断る**（{@link DESCRIPTION_FORBIDDEN_CHARACTER} /
 *    {@link containsDirectionCharacter}）。**前後の空白を除く前に見る**——`trim` は
 *    U+2028 / U+2029 とタブも除くので、後に見ると端の禁じた文字が黙って消えて通る
 * 3. **前後の空白（改行を含む）を除く**（空白だけなら空文字＝説明なし）
 * 4. **{@link MAX_DESCRIPTION_LENGTH} を超えれば断る**（コードポイントで数える）
 *
 * **空文字は通す。** 説明を消すのは正当な操作である。
 *
 * **HTML に効く文字（`<` `"` など）は通す。** 防ぐのは出力側のエスケープである
 * （5.9「保存時の制約は XSS を防がない」）。
 *
 * @param raw 作者が入力した説明（**正規化前**）
 * @returns 保存する値、または断る理由
 */
export function validateDescription(raw: string): DescriptionValidation {
  const unified = raw.replace(/\r\n?/gu, '\n');
  // **禁じた文字は `trim` の前に見る**（PR #401 の Copilot レビュー）。`String#trim` は
  // ECMAScript の行終端として U+2028 / U+2029 も、空白としてタブも除くので、後に見ると
  // **先頭や末尾に置かれた禁じた文字が黙って削られて通る**——「置き換えずに断る」と
  // 食い違う。
  if (
    DESCRIPTION_FORBIDDEN_CHARACTER.test(unified) ||
    containsDirectionCharacter(unified)
  ) {
    return { ok: false, reason: 'forbidden-character' };
  }
  const value = unified.trim();
  if ([...value].length > MAX_DESCRIPTION_LENGTH) {
    return { ok: false, reason: 'too-long' };
  }
  return { ok: true, value };
}

/**
 * 説明の変更の結果（#388）。形は {@link RenameOutcome} に揃えてある。
 */
export type DescribeOutcome =
  | {
      readonly ok: true;
      /** 保存されている説明（**正規化後**。空文字なら説明なし）。 */
      readonly description: string;
      /** **この呼び出しが実際に説明を変えたか。** 同じ説明の入れ直しは false。 */
      readonly changed: boolean;
    }
  | { readonly ok: false; readonly reason: DescribeRejection };

/**
 * 説明の変更を受け付けなかった理由（#388）。
 *
 * - `not-found` … 作品が無い、または**他人の作品**（撃ち分けない。{@link renameGame} と同じ）
 * - `removed` … 取り下げた作品
 * - `not-published` … まだ公開していない作品（**1 件ずつの口では、説明は公開後に書くもの**。#388。
 *   エディットページのまとめて保存する口は下書きにも書ける——{@link WorkDetailsEditOptions}。#673）
 * - `too-soon` … 前回の変更から {@link DESCRIPTION_CHANGE_INTERVAL_SECONDS} 秒経っていない
 * - `denied-term` … 8.3 の表に当たった。**語も分類も添えない**（{@link RenameRejection} と
 *   同じ理由——当てては消しを繰り返せば表が 1 語ずつ復元できる）
 * - {@link DescriptionFormRejection} … 長すぎる・禁じた文字を含む
 */
export type DescribeRejection =
  | 'not-found'
  | 'removed'
  | 'not-published'
  | 'too-soon'
  | 'denied-term'
  | DescriptionFormRejection;

/**
 * 作者が公開済みの作品に説明を書く（#388）。**`allowDraft` を渡せば下書きにも書く**（#673。
 * {@link WorkDetailsEditOptions}）。
 *
 * **形は {@link renameGame} を写してある。** 違うのは次の 4 点だけで、それ以外の判断
 * （行を引く前に 8.3 を掛ける・履歴を先に積む・2 文の WHERE を同じ綴りにする・0 行の
 * ときだけ理由を引く・理由を引く SELECT にも `author_id` を入れる）は向こうの説明が
 * そのまま当てはまる。
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * 1. 正規化は {@link validateDescription} で、切らずに断る
 * ══════════════════════════════════════════════════════════════════════════════
 *
 * 理由はあちらに書いた（説明は仮の題を作る関数ではない）。**8.3 に掛けるのは保存される
 * 値そのもの**（改行を畳み、前後の空白を除いた後）である。
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * 2. 書けるのは公開済みの作品だけである（`status = 'published'`。**#673 からは既定の範囲**）
 * ══════════════════════════════════════════════════════════════════════════════
 *
 * > **#673 注記。** エディットページ（#664）で作品名・説明・タグ・公開設定をまとめて保存するようになり、
 * > 「下書きのまま説明とタグを整えてから公開する」流れ（Studio の「動画の詳細」）が要るようになった。
 * > **まとめて保存する口だけが `allowDraft: true` を渡し、`status in (?, ?)` を `published` と `draft` にする。**
 * > 1 件ずつの口は既定のまま（同じ値を 2 度渡す）で、下の #388 の判断はそちらに残る。下書きでは
 * > **削除を掴まれた行（#516）に履歴を積まない**よう、`deletion_started_at is null` も条件に置く
 * > （公開済みの行は掴まれない——`src/game-deletion.ts` の `claimDeletion`——ので、1 件ずつの口には効かない）。
 *
 * **5.4 の 1 タップの導線を変えない**（#388）。公開の前に説明の欄を置くと、公開までの
 * 画面に入力欄が 1 つ増える。改名が公開の前後を問わないのと違うのは、**未公開の作品には
 * 説明を読む人が作者しかいない**からである（題名は未公開でも作者の一覧に出る）。
 * `status = 'published'` は `removed` も `draft` も除く。`generation_state = 'ready'` も
 * 置く——公開は `ready` の行にしか起きない（{@link publishGame}）ので冗長だが、
 * **画面の条件と経路の関門を、改名と同じ綴りで読めるようにしておく。**
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * 3. 変更の間隔を WHERE に置く（断った要求は 1 行も書かない）
 * ══════════════════════════════════════════════════════════════════════════════
 *
 * `src/account.ts` の `changeDisplayName` と同じ形である。**時刻は `games` の行に持つ**
 * （`description_set_at`）。履歴の表から引くと、同じ batch で先に積んだ履歴の行に
 * UPDATE の側が当たって必ず 0 行になる（`migrations/0028_game_descriptions.sql`）。
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * 4. `cleared` は改名と同じ規則で解く（{@link reviewStateAfterAuthorEditSql} を共有する）
 * ══════════════════════════════════════════════════════════════════════════════
 *
 * **審査で見たのは変更前の説明である。** 穏当な説明で公開し、通報されて `cleared` に
 * なった後で書き換える、という経路を改名と同じ扱いで塞ぐ。通報の無い作品は `NULL` へ
 * 戻り（善意の変更で作品がトップから消えない）、**`cleared` にしたあとの通報が届いて
 * いれば `queued` へ入る**（#404）。`queued` の作品は `queued` のまま残る。
 *
 * @param env バインディングと環境変数
 * @param gameId 対象の作品 id
 * @param authorId 操作している利用者（**作者本人でなければ通らない**）
 * @param candidate 作者が入力した説明（**正規化前**）
 * @param now 変更時刻（UNIX 秒。既定は現在時刻）
 * @returns 変更の結果
 */
export async function describeGame(
  env: Env,
  gameId: string,
  authorId: string,
  candidate: string,
  now: number = Math.floor(Date.now() / 1000),
  options: WorkDetailsEditOptions = {},
): Promise<DescribeOutcome> {
  const validated = validateDescription(candidate);
  if (!validated.ok) {
    return { ok: false, reason: validated.reason };
  }
  const description = validated.value;

  // **語も分類も外へ出さない**（{@link DescribeRejection}）。**空文字は掛けない**
  // ——当たる語が無く、説明を消す操作を 8.3 の都合で断る余地を残さない。
  if (description !== '' && !inspectText(description).ok) {
    return { ok: false, reason: 'denied-term' };
  }

  // **条件の綴りを 1 つにする**（{@link renameGame} と同じ理由）。
  const conditions =
    "id = ? and author_id = ? and status in (?, ?) and generation_state = 'ready' and description <> ?" +
    ' and deletion_started_at is null and (description_set_at is null or description_set_at <= ?)';
  const statuses = editableStatuses(options);
  const bindings = [
    gameId,
    authorId,
    ...statuses,
    description,
    now - DESCRIPTION_CHANGE_INTERVAL_SECONDS,
  ] as const;

  const results = await env.DB.batch([
    // **履歴を先に積む。** 旧い説明は UPDATE の前の行からしか取れない。
    env.DB.prepare(
      `insert into ${DESCRIPTION_CHANGES_TABLE}
              (id, game_id, old_description, new_description, changed_at)
       select ?, id, description, ?, ?
         from games
        where ${conditions}`,
    ).bind(crypto.randomUUID(), description, now, ...bindings),
    // 審査状態の式と別名 `g` は {@link renameGame} と同じ（{@link reviewStateAfterAuthorEditSql}）。
    env.DB.prepare(
      `update games as g
          set description = ?, description_set_at = ?,
              ${REVIEW_STATE_COLUMN} = ${reviewStateAfterAuthorEditSql()}
        where ${conditions}`,
    ).bind(description, now, ...bindings),
  ]);

  const historyRows = results[0]?.meta.changes ?? 0;
  const describedRows = results[1]?.meta.changes ?? 0;

  if (describedRows > 0) {
    // **履歴の無い変更は構造上ありえない**（同じ条件・同じ batch）。{@link renameGame} と同じ扱い。
    if (historyRows === 0) {
      console.error('[games] 履歴の無い説明の変更が入りました（batch の意味が変わっています）');
    }
    return { ok: true, description, changed: true };
  }

  // **0 行だったときだけ、理由を引きに行く。** `author_id = ?` を入れる理由は {@link renameGame}。
  const row = await env.DB.prepare(
    'select status, generation_state, description, deletion_started_at from games where id = ? and author_id = ?',
  )
    .bind(gameId, authorId)
    .first<{ status: string; generation_state: string; description: string; deletion_started_at: number | null }>();

  if (row === null) {
    return { ok: false, reason: 'not-found' };
  }
  if (row.status === REMOVED_STATUS) {
    return { ok: false, reason: 'removed' };
  }
  if (!statuses.includes(row.status) || row.generation_state !== 'ready') {
    return { ok: false, reason: 'not-published' };
  }
  if (row.deletion_started_at !== null) {
    // 削除を掴まれた下書き（#516。`allowDraft` のときだけここへ来る——公開済みの行は掴まれない）は、行が無いのと
    // 同じ扱いにする（{@link renameGame} と同じ）。**理由の順を 1 件ずつの口から変えないため、状態の判定の後に置く。**
    return { ok: false, reason: 'not-found' };
  }
  if (row.description === description) {
    // **同じ説明の入れ直しは失敗にしない**（二度押し。改名と同じ扱い）。**間隔の内側でも
    // こちらを先に見る**——同じ文章を 2 度送った人に「待ってください」と言う理由が無い。
    return { ok: true, description: row.description, changed: false };
  }
  // 残る理由は「前回の変更から間隔が空いていない」である。
  return { ok: false, reason: 'too-soon' };
}

/**
 * タグの検査で断る理由（#376）。
 *
 * - `unknown-tag` … 語彙（`src/work-tags.ts` の `WORK_TAGS`）に無い値を含む
 * - `too-many-tags` … 異なるタグが {@link MAX_WORK_TAGS} 個を超える
 */
export type WorkTagsRejection = 'unknown-tag' | 'too-many-tags';

/** タグの検査の結果。 */
export type WorkTagsValidation =
  | {
      readonly ok: true;
      /** 保存する形（**語彙の順に並び、重複しない**。0〜{@link MAX_WORK_TAGS} 個）。 */
      readonly tags: readonly WorkTagId[];
    }
  | { readonly ok: false; readonly reason: WorkTagsRejection };

/**
 * タグを検査し、保存する形へ落とす（#376）。**公開と付け直しの 2 つの口が、この 1 つを通る。**
 *
 * # 規則
 *
 * 1. **語彙に無い値を 1 つでも含めば断る。** 空文字も語彙に無い。**黙って読み飛ばさない**
 *    ——作者が選んだつもりのタグが保存されないまま「公開しました」と戻ると、作者から見て
 *    理由の見えない欠けになる（チェックボックスから来る限り起きないので、起きたら要求の
 *    作り方がおかしい）
 * 2. **同じ値の重複は 1 つに畳む**（`tag=puzzle&tag=puzzle`）。数えるのは畳んだ後である
 * 3. **{@link MAX_WORK_TAGS} 個を超えれば断る。** 先頭の 3 個を採る形にしない——どれを
 *    捨てたかが作者に見えない（説明を切らずに断る {@link validateDescription} と同じ判断）
 * 4. **語彙の順に並べ直す。** 枠は tag1 から詰めるので、並べ直しておけば「同じ組か」を
 *    枠ごとの比較で判定でき（{@link retagGame}）、**同じ組が枠の並びだけ違う 2 つの行に
 *    ならない**
 *
 * **0 個は通す**（タグ無しを許す。#376 の決定）。
 *
 * **語彙を `Set` にしない。** `WORK_TAGS` は 8 行で、`includes` の線形探索で足りる。
 * 最上位に `new Set` を置くと、このモジュールが入るオーケストレータの束に副作用を持ちうる
 * 式が残る（`src/work-tags.ts` の冒頭）。
 *
 * @param raw 要求から取り出した値（**検査前**）
 * @returns 保存する形、または断る理由
 */
export function validateWorkTags(raw: readonly string[]): WorkTagsValidation {
  const vocabulary: readonly string[] = WORK_TAGS.map((tag) => tag.id);
  if (raw.some((value) => !vocabulary.includes(value))) {
    return { ok: false, reason: 'unknown-tag' };
  }
  const tags = WORK_TAGS.map((tag) => tag.id).filter((id) => raw.includes(id));
  if (tags.length > MAX_WORK_TAGS) {
    return { ok: false, reason: 'too-many-tags' };
  }
  return { ok: true, tags };
}

/**
 * 検査済みのタグを `games` の 3 つの枠へ詰める（**tag1 から詰め、空きは NULL**）。
 *
 * @param tags {@link validateWorkTags} が返した形
 * @returns `[tag1, tag2, tag3]`
 */
function workTagSlots(tags: readonly WorkTagId[]): readonly [string | null, string | null, string | null] {
  return [tags[0] ?? null, tags[1] ?? null, tags[2] ?? null];
}

/**
 * `games` の行からタグを読む（**枠の順に、空でない文字列だけ**。#376）。
 *
 * **語彙に照らさない。** ここは D1 の値を運ぶだけで、画面に出すかは描く側が語彙で決める
 * （`src/work-card.ts` の `knownWorkTags`）。**キャッシュを経由した行も同じ関数で描く**ので、
 * 判断を 1 か所に置く。
 *
 * **型ではなく実際の値を見る。** 行はキャッシュ（JSON）を経由しうる。
 *
 * @param row `tag1` / `tag2` / `tag3` を選んだ行
 * @returns タグの識別子（0〜3 個）
 */
export function workTagsOf(row: {
  readonly tag1?: unknown;
  readonly tag2?: unknown;
  readonly tag3?: unknown;
}): readonly string[] {
  return [row.tag1, row.tag2, row.tag3].filter(
    (value): value is string => typeof value === 'string' && value !== '',
  );
}

/**
 * 付け直してから、次の付け直しを受け付けるまでの秒数（#376 / 3.6）。
 *
 * **説明の変更（{@link DESCRIPTION_CHANGE_INTERVAL_SECONDS}）と同じ考え方・同じ値である。**
 * 改名は間隔を持たないが、**タグは改名より書き込みが重い**——付け直し 1 回で、6 本の部分索引の
 * 項目が最大 6 行抜けて 6 行入る（`migrations/` の `games_tags`）。60 秒に 1 回なら、1 作品に
 * 1 日張り付いても約 18,700 行（無料枠 10 万行/日 の 19%）で止まる。**数え方は作品ごと**
 * （`games.tags_set_at`）で、理由は説明と同じである（止めたいのは連打であって、作品を並べて
 * 手入れすることではない）。
 */
export const WORK_TAGS_CHANGE_INTERVAL_SECONDS = 60;

/** 付け直しの結果（#376）。形は {@link DescribeOutcome} に揃えてある。 */
export type RetagOutcome =
  | {
      readonly ok: true;
      /** 保存されているタグ（語彙の順）。 */
      readonly tags: readonly string[];
      /** **この呼び出しが実際に変えたか。** 同じ組の入れ直しは false。 */
      readonly changed: boolean;
    }
  | { readonly ok: false; readonly reason: RetagRejection };

/**
 * 付け直しを受け付けなかった理由（#376）。
 *
 * - `not-found` … 作品が無い、または**他人の作品**（撃ち分けない。{@link renameGame} と同じ）
 * - `removed` … 取り下げた作品
 * - `not-published` … まだ公開していない作品（**1 件ずつの口では、タグは公開フォームで選ぶ**。5.4 の導線を
 *   変えない。エディットページのまとめて保存する口は下書きにも付けられる——{@link WorkDetailsEditOptions}。#673）
 * - `too-soon` … 前回の付け直しから {@link WORK_TAGS_CHANGE_INTERVAL_SECONDS} 秒経っていない
 * - {@link WorkTagsRejection} … 語彙に無い値・4 個以上
 */
export type RetagRejection =
  | 'not-found'
  | 'removed'
  | 'not-published'
  | 'too-soon'
  | WorkTagsRejection;

/**
 * 作者が公開済みの作品のタグを付け直す（#376）。**`allowDraft` を渡せば下書きにも付ける**（#673。
 * {@link WorkDetailsEditOptions}。下書きの判断と、削除を掴まれた行を除く理由は {@link describeGame} の #673 注記）。
 *
 * **形は {@link describeGame} を写してある**（検査を行の前に置く・0 行のときだけ理由を引く・
 * 理由を引く SELECT にも `author_id` を入れる・同じ値の入れ直しを成功にする・間隔を WHERE に
 * 置く）。違うのは次の 3 点だけである。
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * 1. 履歴を持たない（1 本の UPDATE で書く）
 * ══════════════════════════════════════════════════════════════════════════════
 *
 * **語彙が固定で、利用者の自由文が 1 文字も入らない**（#376 の利用者の決定）。題名と説明の
 * 履歴は、8.4 の審査が「通報された時点の値」を復元するために要る（#405）が、タグはどの値でも
 * 8 個の語彙のどれかであり、モデレーションの対象にならない。**batch にしない**のもそのためで、
 * 書く文が 1 本なので原子性は UPDATE そのものが持つ。
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * 2. 審査状態を戻さない
 * ══════════════════════════════════════════════════════════════════════════════
 *
 * **{@link reviewStateAfterAuthorEditSql} を通さない。** あれは「審査で見たのは変更前の題名・
 * 説明である」ことを理由に `cleared` を解く式で、タグを変えても作品の中身も、利用者が読む
 * 文章も変わらない。**付け直しで審査待ちが解けることも無い**（`review_state` に触れない）。
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * 3. 「同じ組か」は枠ごとに `is` で比べる
 * ══════════════════════════════════════════════════════════════════════════════
 *
 * **NULL を含む比較なので `=` ではなく `is` を使う**（`NULL = NULL` は真にならず、タグ無しの
 * 作品にタグ無しを入れ直すたびに書き込みと間隔の消費が起きる）。検査が語彙の順に並べ直して
 * いるので、枠ごとの比較が組の比較になる。
 *
 * @param env バインディングと環境変数
 * @param gameId 対象の作品 id
 * @param authorId 操作している利用者（**作者本人でなければ通らない**）
 * @param rawTags 作者が選んだタグ（**検査前**。空ならタグをすべて外す）
 * @param now 付け直しの時刻（UNIX 秒。既定は現在時刻）
 * @returns 付け直しの結果
 */
export async function retagGame(
  env: Env,
  gameId: string,
  authorId: string,
  rawTags: readonly string[],
  now: number = Math.floor(Date.now() / 1000),
  options: WorkDetailsEditOptions = {},
): Promise<RetagOutcome> {
  const validated = validateWorkTags(rawTags);
  if (!validated.ok) {
    return { ok: false, reason: validated.reason };
  }
  const slots = workTagSlots(validated.tags);
  const statuses = editableStatuses(options);

  const result = await env.DB.prepare(
    `update games
        set tag1 = ?, tag2 = ?, tag3 = ?, tags_set_at = ?
      where id = ? and author_id = ? and status in (?, ?) and generation_state = 'ready'
        and deletion_started_at is null
        and (tags_set_at is null or tags_set_at <= ?)
        and not (tag1 is ? and tag2 is ? and tag3 is ?)`,
  )
    .bind(
      ...slots,
      now,
      gameId,
      authorId,
      ...statuses,
      now - WORK_TAGS_CHANGE_INTERVAL_SECONDS,
      ...slots,
    )
    .run();

  if ((result.meta.changes ?? 0) > 0) {
    return { ok: true, tags: validated.tags, changed: true };
  }

  // **0 行だったときだけ、理由を引きに行く。** `author_id = ?` を入れる理由は {@link renameGame}。
  const row = await env.DB.prepare(
    'select status, generation_state, tag1, tag2, tag3, deletion_started_at from games where id = ? and author_id = ?',
  )
    .bind(gameId, authorId)
    .first<{
      status: string;
      generation_state: string;
      tag1: string | null;
      tag2: string | null;
      tag3: string | null;
      deletion_started_at: number | null;
    }>();

  if (row === null) {
    return { ok: false, reason: 'not-found' };
  }
  if (row.status === REMOVED_STATUS) {
    return { ok: false, reason: 'removed' };
  }
  if (!statuses.includes(row.status) || row.generation_state !== 'ready') {
    return { ok: false, reason: 'not-published' };
  }
  if (row.deletion_started_at !== null) {
    // 削除を掴まれた下書き（#516。`allowDraft` のときだけここへ来る——公開済みの行は掴まれない）は、行が無いのと
    // 同じ扱いにする（{@link renameGame} と同じ）。**理由の順を 1 件ずつの口から変えないため、状態の判定の後に置く。**
    return { ok: false, reason: 'not-found' };
  }
  if (row.tag1 === slots[0] && row.tag2 === slots[1] && row.tag3 === slots[2]) {
    // **同じ組の入れ直しは失敗にしない**（二度押し。説明と同じ扱いで、間隔の内側でも先に見る）。
    return { ok: true, tags: workTagsOf(row), changed: false };
  }
  // 残る理由は「前回の付け直しから間隔が空いていない」である。
  return { ok: false, reason: 'too-soon' };
}

/**
 * ある作品の**親**の `fork_count` を、実件数で置き直す（5.1 / 5.5 / M5-3 / #34）。
 *
 * # 加算しない。数え直す
 *
 * `fork_count = fork_count + 1` にしない。理由は 3 つある。
 *
 * 1. **実装より前に完成した行は、この経路を 1 度も通っていない。** `fork_count` は
 *    `migrations/0001_init.sql` からある列だが、これを動かす経路は #34 で初めてできた。
 *    本番には既に公開済みの行があり、**3 世代の系統が 1 本できている**（引き継ぎ 1 章）。
 *    加算なら、それらの親の値は永久に 0 のままである。数え直しなら、**その系統で次に
 *    1 件公開された時点で正しい値へ収束する。** 同じ形の事故が #202 / #203 で起きている
 *    （版が 1 つも無い作品を推敲すると元の版が消えた）。
 * 2. **冪等である。** 2 回呼んでも値が動かない。呼び出し側（{@link publishGame} /
 *    {@link unpublishGame}）の関門が壊れても、**数が壊れるところまでは伝播しない。**
 * 3. **増減の両方を 1 つの綴りで賄える。** 公開をやめる操作（5.4 / #637）は子を
 *    1 件減らす操作だが、`- 1` を別に書く必要が無い（{@link unpublishGame} が同じ
 *    関数を呼ぶ）。
 *
 * 代償は、親の子を毎回数え直すことである。**`games_parent_id_idx`（0001）がある**ので
 * 索引の範囲走査で済み、しかも走るのは公開・公開をやめるときだけ（閲覧では走らない）。
 *
 * # 親を引いてから更新しない
 *
 * `parent_id` を読む SELECT を挟まず、1 本の UPDATE の `where` に副問い合わせとして
 * 置く。**オリジナル（`parent_id is null`）なら `id = null` はどの行にも一致しない**ので、
 * 「親が居るか」の分岐をこちら側に書かずに済む。
 *
 * @param env バインディングと環境変数
 * @param childId 状態が変わった**子**の作品 id（この親を数え直す）
 */
async function refreshParentForkCount(env: Env, childId: string): Promise<void> {
  await env.DB.prepare(
    `update games
        set fork_count = (select count(*)
                            from games c
                           where c.parent_id = games.id and c.status = ?)
      where id = (select parent_id from games where id = ?)`,
  )
    .bind(PUBLISHED_STATUS, childId)
    .run();
}

/** 系統の近傍に出す子作品 1 件（5.5 / M5-3 / #34）。 */
export interface ForkChild {
  /** `games.id`。作品ページ（`/works/<id>`）の URL に入る。 */
  readonly id: string;
  /**
   * 題名。
   *
   * **公開済みの行しか返さないので、そのまま誰にでも出してよい**（`src/work-page.ts`
   * が親の題名を `published` のときだけ出すのと同じ規則）。UGC 由来なので
   * 表示側で `escapeHtml` を通すこと。
   */
  readonly title: string;
  /** 公開した時刻（UNIX 秒）。0001 以前の行では null になりうる。 */
  readonly publishedAt: number | null;
}

/**
 * ある作品の、公開されている子の件数を数える（5.5 / M5-3 / #34）。
 *
 * # なぜ `fork_count` を読まないのか
 *
 * **画面に出す数は、その場で数えた実件数である。** `fork_count` は 5.1 が
 * 「一覧を軽くするための非正規化列」と定めた値で、**この画面の数の出どころではない。**
 *
 * 理由は {@link refreshParentForkCount} と同じ根である——**本番には、非正規化の経路を
 * 1 度も通っていない公開済みの行がある。** 列を読むと、この画面は**初日から嘘の数を
 * 出す**（3 世代の系統の親が「改造: 0 件」と言う）。しかも下に並ぶ一覧は実件数から
 * 引くので、**数と一覧が食い違う**という、いちばん読み解きにくい形の嘘になる。
 *
 * 数えるのは 1 作品ぶんで、`games_parent_id_idx`（0001）が効く。
 *
 * @param env バインディングと環境変数
 * @param parentId 親の作品 id
 * @returns 公開されている子の件数
 */
export async function countPublishedForks(env: Env, parentId: string): Promise<number> {
  const row = await env.DB.prepare(
    // **審査待ちの子を数えない**（8.4 / #40）。5.5 の「このゲームからの改造: N 件」は
    // 新規露出そのものなので、止めるのはここである。**条件は `src/reports.ts` が持つ**
    // ——書き写すと、次に露出する場所を足した日に片方だけが古くなる。
    `select count(*) as n from games
      where parent_id = ? and status = ? and ${reviewVisibleSql()}`,
  )
    .bind(parentId, PUBLISHED_STATUS)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

/**
 * ある作品の、公開されている子を新しい順に引く（5.5 / M5-3 / #34）。
 *
 * # `published` だけを返すことが、この関数の唯一の責務である
 *
 * **絞り込みを呼び出し側へ出さない**（{@link listAuthoredGames} と同じ方針）。
 * 画面側で `filter` する形にすると、条件を書き忘れた呼び出しが生まれても
 * **動作では気づけない**——公開済みの子は正しく出るので、見た目は正しい。
 *
 * ここで漏れるのは他人の `draft` の題名（プロンプト由来）である。5.4 は「「公開」操作で
 * 初めて URL が有効になる」と定めており、**系統の一覧がその抜け道になってはいけない。**
 *
 * # 並びは `published_at` の降順である
 *
 * 5.5 が「新しい順」と定めるのは**改造として現れた順**であって、行ができた順ではない。
 * `created_at` で並べると、**生成に 91 秒かかり公開までに何日か置かれた作品**が、
 * あとから作られて先に公開された作品より上に来る。
 *
 * 2 列目に `id` を置くのは、`published_at` が UNIX 秒で**同じ秒に公開された 2 件の
 * 順序が決まらない**ためである（{@link listAuthoredGames} と同じ理由）。
 * `published_at` が NULL の行（0001 以前）は SQLite の DESC で末尾へ落ちる。
 *
 * # 続きは位置（offset）で取る
 *
 * 5.5 の「20 件＋もっと見る」は**続きを一度だけ辿れれば足りる**ので、`limit` /
 * `offset` の素朴な形にする。取っているあいだに新しい改造が公開されると境目が 1 件
 * ずれうるが、**この一覧は近傍を見せるためのもので、全件の走査を約束していない**
 * （家系図 UI は MVP 対象外。11 章）。
 *
 * @param env バインディングと環境変数
 * @param parentId 親の作品 id
 * @param limit 引く最大件数（0 以上の整数）
 * @param offset 読み飛ばす件数（0 以上の整数）
 * @returns 新しい順（同時刻は id の降順）の子作品
 * @throws `limit` / `offset` が 0 以上の整数でない場合
 */
export async function listPublishedForks(
  env: Env,
  parentId: string,
  limit: number,
  offset = 0,
): Promise<readonly ForkChild[]> {
  assertLimit(limit);
  // **`OFFSET` にも同じ検査が要る。** SQLite は `OFFSET -1` を 0 として黙って受け入れる
  // ので、負の位置を渡した呼び出しは 1 頁目を返して「動いて」しまう。
  assertLimit(offset, '読み飛ばし件数');

  const result = await env.DB.prepare(
    // **審査待ちの子を出さない**（8.4 / #40）。数える側（{@link countPublishedForks}）と
    // **同じ断片を借りる**ので、件数と一覧がずれない。
    `select id, title, published_at
       from games
      where parent_id = ? and status = ? and ${reviewVisibleSql()}
      order by published_at desc, id desc
      limit ? offset ?`,
  )
    .bind(parentId, PUBLISHED_STATUS, limit, offset)
    .all<{ id: string; title: string; published_at: number | null }>();

  return result.results.map((row) => ({
    id: row.id,
    title: row.title,
    publishedAt: row.published_at,
  }));
}

/** 一覧に出す作品 1 件（`src/my-works.ts` が読む）。 */
export interface AuthoredGame {
  /** `games.id`。作品ページ（`/works/<id>`）の URL に入る。 */
  readonly id: string;
  /** 仮のタイトル（プロンプト由来。{@link draftTitleFromPrompt}）。 */
  readonly title: string;
  /** 生成の進行状態。**D1 の綴りのまま返す**（画面の状態へ落とすのは読む側の仕事）。 */
  readonly generationState: string;
  /**
   * 公開状態（`games.status`。#641）。**D1 の綴りのまま返す**（`generationState` と同じ扱いで、
   * 画面の文言へ落とすのは読む側の仕事である。`src/my-works.ts` の `publicationLabelOf`）。
   *
   * **入るのは `draft` か `published` だけである**——この関数は `removed` を引かない。
   * それでも画面は知らない値を受け取れる形にしてある（不変条件を画面が前提にしない）。
   */
  readonly status: string;
  /** 行を作った時刻（UNIX 秒）。 */
  readonly createdAt: number;
  /** ジョブが走り始めた時刻（UNIX 秒）。まだ握られていなければ null。 */
  readonly startedAt: number | null;
}

/**
 * ある作者の作品を新しい順に引く（5.5 / #152）。
 *
 * # `author_id` で絞ることが、この関数の唯一の責務である
 *
 * **5.4 は「公開前の URL は有効にしない」と定めており、一覧がその抜け道になっては
 * いけない。** したがって「他人の行を 1 行も返さない」ことが、この一覧における 5.4 の
 * 担保そのものになる。
 *
 * > **#152 の時点の本文は「公開の操作そのものが未実装（M4-1 / #26）なので、この関数が
 * > 返す行は実質すべて draft である」と書いていた。** #26 で公開が、#637 で公開をやめる
 * > 操作が入り、**いまは公開中と下書きが混ざる**（PR #642 の Copilot の指摘）。**混ざることを
 * > 前提にしない呼び出しを書かないこと**——行が公開中かどうかは下の `status` が言う。
 *
 * **絞り込みを呼び出し側へ出さない。** 画面側で `filter` する形にすると、条件を
 * 書き忘れた呼び出しが生まれても**動作では気づけない**（自分の作品は正しく出る）。
 * 引く時点で SQL の `where` に入れておけば、書き忘れようがない。
 *
 * # 公開状態も返す（#641）
 *
 * **`status` を 1 列足した**（索引は変えていない。`where` と `order by` はそのまま）。
 * #637 で作者が公開をやめて下書きへ戻せるようになり、**この一覧に公開中と下書きが混ざる**
 * ようになった。**混ざるのに行が見分けられないと、戻した作品を作者が探せない**——2026-09-17 の
 * 本番の確認で、15 行がすべて「できました」（`generation_state` の札）としか出ず、
 * どれを下書きへ戻したのかが読めなかった（#641）。
 *
 * **統計（`src/my-works-stats.ts`）は最初から `status` を数えている。** 足りていなかったのは
 * 行の側だけである。
 *
 * # `removed` を除く
 *
 * `status='removed'` は 8.4 の削除依頼と 5.3 の tombstone 化が作る状態で、**作者が
 * 戻るための作品ではない。** 出しても辿れる先は無い（`/p/` は `status <> 'removed'`
 * でしか引けず、`/g/` は `published` でしか引けない）。**行き先の無いリンクを一覧に
 * 並べない。**
 *
 * # 生成中の行も返す
 *
 * `generation_state` で絞らない。#152 が明示的に「生成中のものも出す」と定めており、
 * **91 秒待っている最中の作品こそ、戻る道が要る。**
 *
 * # 件数の上限は呼び出し側が決める
 *
 * ここで既定値を持たない。**一覧は開くたびに引く**ので、上限は表示側の都合
 * （何件並べるか、次があることをどう示すか）と一体で決まる。値と根拠は
 * `src/my-works.ts` の `MY_WORKS_PER_PAGE` / `MAX_MY_WORKS_PAGE` にある。
 *
 * # 続きは位置（offset）で取る（#552）
 *
 * 「あなたの作品」の頁送り（1 頁 20 件）のために `offset` を足した。**省略でき、既定は 0
 * （先頭から引く）**なので、`offset` を渡さない呼び出しの結果は変わらない。
 * {@link listPublishedForks} と同じ素朴な `limit` / `offset` の形で、**頁数の上限は
 * 呼び出し側が置く**（`OFFSET` は読み飛ばした行も数えるため）。
 * 読み飛ばしも作者の索引（`games_author_id_created_at_idx`）の上で行う。
 *
 * @param env バインディングと環境変数
 * @param authorId 作者の利用者 id
 * @param limit 引く最大件数（0 以上の整数）
 * @param offset 読み飛ばす件数（0 以上の整数。既定は 0）
 * @returns 新しい順（同時刻は id の降順）の作品
 * @throws `limit` / `offset` が 0 以上の整数でない場合
 */
export async function listAuthoredGames(
  env: Env,
  authorId: string,
  limit: number,
  offset = 0,
): Promise<readonly AuthoredGame[]> {
  assertLimit(limit);
  // **`OFFSET` にも同じ検査が要る**（{@link listPublishedForks} と同じ理由。SQLite は
  // `OFFSET -1` を 0 として黙って受け入れる）。
  assertLimit(offset, '読み飛ばし件数');

  // 並べ替えの 2 列目に `id` を置くのは、`created_at` が UNIX 秒で**同じ秒に作られた
  // 2 件の順序が決まらない**ためである（`migrations/0008_games_author_id_idx.sql`）。
  // 索引の列順もこの並びに合わせてある。
  const result = await env.DB.prepare(
    `select id, title, status, generation_state, created_at, generation_started_at
       from games
      where author_id = ? and status <> 'removed'
      order by created_at desc, id desc
      limit ? offset ?`,
  )
    .bind(authorId, limit, offset)
    .all<{
      id: string;
      title: string;
      status: string;
      generation_state: string;
      created_at: number;
      generation_started_at: number | null;
    }>();

  return result.results.map((row) => ({
    id: row.id,
    title: row.title,
    status: row.status,
    generationState: row.generation_state,
    createdAt: row.created_at,
    startedAt: row.generation_started_at,
  }));
}

/**
 * 一覧の取得件数として受け取れる値かを検査する。
 *
 * **SQLite は `LIMIT -1` を「無制限」と解釈する。** すなわち負の値を渡すと、上限を
 * 掛けたつもりの問い合わせが**その作者の全行の読み取り**に化ける。`NaN` や小数も
 * 意図した件数にはならない。**どれも例外を投げずに「動いて」しまう**ため、動作では
 * 気づけない（一覧は正しく見える。増えるのは読み取り行数だけである）。
 *
 * 3.6 は読み取りの単価が安いと言っているが、**静かに全件を読む経路を開いてよいとは
 * 言っていない。** 呼び出し側の誤りを、無料枠の消費として先送りしない。
 *
 * 形は `src/invites.ts` の `assertQuota` に揃えてある（同じ種類の検査を、同じ書き方で
 * 置く。読む側が 2 つの流儀を覚えなくて済む）。
 *
 * @param limit 検査する値
 * @param what 値の呼び名（例外の文言に入る。既定は取得件数）
 * @throws 0 以上の整数でない場合
 */
function assertLimit(limit: number, what = '取得件数'): void {
  if (!Number.isSafeInteger(limit) || limit < 0) {
    throw new Error(`一覧の${what}が不正です: ${limit}`);
  }
}

/**
 * 公開作品の一覧の並べ替え軸（仕様 2.3.4 / #328 / #339）。
 *
 * **3 つである**（v1.51）。AivisHub の `download` / `like` / `recent` に対して、
 * `download` に相当するのは `fork_count` である——**10.1 の主 KPI はフォーク率であり、
 * よく改造された作品を並べることは主 KPI をそのまま可視化する。** `like` に相当する
 * `liked` は、v1.50 まで「持たない」としていたが、利用者がいいねを求めたため足した
 * （2.3.5 / 5.8）。**値は `games.like_count`（Durable Objects から 5 分おきに写した数）を
 * 読むので、並び順は最大 5 分遅れる。**
 *
 * **綴りの正本はここである。** URL のクエリ（`?sort=`）も索引の名前
 * （`migrations/0019_games_public_list_idx.sql` / `0020_games_like_count.sql`）もこの 3 語に
 * 揃える。
 *
 * > **#377 注記。4 つになった**（仕様 2.3.4 の v1.57）。`played` は `games.play_count`
 * > （Durable Objects `PlayHub` から 5 分おきに写した数。`migrations/` の `games_play_count`）を
 * > 読み、`liked` とまったく同じ形で並ぶ——**並び順は最大 5 分遅れる。** **タグで絞り込んでいる
 * > 間は出さない**（{@link TAGGED_WORK_SORTS} は変えていない。#376 の決定）。
 */
export const PUBLIC_WORK_SORTS = ['recent', 'forked', 'liked', 'played'] as const;

/** 並べ替え軸。 */
export type PublicWorkSort = (typeof PUBLIC_WORK_SORTS)[number];

/**
 * 未知の綴りを既定の軸へ落とす。
 *
 * **落とすのであって、失敗させない。** `?sort=` は利用者が手で書き換えられる場所で、
 * 綴りを間違えた URL が 400 を返すより、既定の並びで一覧が出るほうがよい
 * （一覧の仕事は作品を見つけさせることである）。
 *
 * @param value クエリから来た値（未指定なら null）
 * @returns 既知の軸。未知なら `recent`
 */
export function toPublicWorkSort(value: string | null): PublicWorkSort {
  return (PUBLIC_WORK_SORTS as readonly string[]).includes(value ?? '')
    ? (value as PublicWorkSort)
    : 'recent';
}

/**
 * タグで絞り込んでいる間の並べ替え軸（#376 の利用者の決定）。
 *
 * **「新着」と「改造された数」の 2 つだけである。** `liked`（`like_count`）を絞り込みの索引に
 * 載せると、5 分おきの同期が書く列が 3 本の枠の索引へも伸びる（`migrations/` の `games_tags`）。
 * 4 軸すべてを索引で保証すると、最悪で書き込みの無料枠を超える見積もりになった。
 *
 * **{@link PUBLIC_WORK_SORTS} の部分集合である**（`PublicWorkSort` へそのまま渡せる）。
 */
export const TAGGED_WORK_SORTS = ['recent', 'forked'] as const;

/** 絞り込み中の並べ替え軸。 */
export type TaggedWorkSort = (typeof TAGGED_WORK_SORTS)[number];

/**
 * 絞り込み中の `?sort=` を軸へ落とす。**未知の綴りも `liked` も新着へ落とす**（#376）。
 *
 * **落とすのであって、失敗させない**（{@link toPublicWorkSort} と同じ理由）。いいね順で
 * 並べている一覧からタグを選んだ人は、新着の並びで絞り込みの結果を見る。
 *
 * @param value クエリから来た値（未指定なら null）
 * @returns 絞り込み中に使える軸。それ以外は `recent`
 */
export function toTaggedWorkSort(value: string | null): TaggedWorkSort {
  return (TAGGED_WORK_SORTS as readonly string[]).includes(value ?? '')
    ? (value as TaggedWorkSort)
    : 'recent';
}

/** 公開作品の一覧に出す 1 件（仕様 2.3.6）。 */
export interface PublicWork {
  /** `games.id`。作品ページ（`/works/<id>`）の URL に入る。 */
  readonly id: string;
  /** 題名。**公開済みの行しか返さないのでそのまま出してよい**（UGC なので表示側で escape する）。 */
  readonly title: string;
  /** 作者の表示名。行が壊れている場合に備えて null を許す。 */
  readonly authorName: string | null;
  /**
   * 作者の `users.id`。**作者ページ（`/users/<user_id>`）へのリンクにだけ使う**（#330）。
   *
   * # なぜ省略可なのか
   *
   * **型の上で必須にできない。** 一覧の行は Cache API に載っており、鍵に行の形の版が
   * 無い（`src/list-cache.ts`。TTL は 60 秒）。配備の直後、最大 60 秒は `author_id` を
   * 選んでいなかった頃の行が返りうる——`likeCount` が #340 で踏んだ穴と同じものである
   * （仕様 5.8 の v1.52 / 1.2.50）。
   *
   * **`PublicWork` を組み立てる経路は 4 つある**（ここ・`src/home-feed.ts` の公式サンプル・
   * `src/liked-works.ts`・`src/users-page.ts`）。**#330 の時点では 4 つとも `author_id` を
   * 選んでいる**（PR #350 の Copilot code review の指摘で、公式サンプルと自分のいいね一覧を
   * 同じ PR で揃えた）。それでも必須にしないのは、上のキャッシュの窓のためである
   * ——**型を必須にしても、実行時に欠けている行は来る。**
   *
   * 欠けているときにカードがどうするかは `src/work-card.ts` の `cardAuthorId` が決める
   * （**リンクにせず、名前を文字のまま出す**）。
   *
   * **`users` を行ごと持ってこないという規律は崩していない**（仕様 2.3.6）。増えたのは
   * `games.author_id` 1 列で、`users` 側から選んでいるのは今までどおり `display_name`
   * だけである——`email` と `invited_by` がカードへ届く経路は 1 本も増えていない。
   */
  readonly authorId?: string | null;
  /**
   * 作者のアイコンの版（`users.avatar_set_at`。**アイコンを設定していなければ null**。#380 / 仕様 2.3.6）。
   *
   * **カードは `?v=<この値>` を付けた URL で画像を出す**（`src/work-card.ts`。配信は版が一致すれば
   * `immutable`。仕様 2.3.8）。**選ぶのは SQL の `case` で、`avatar_sha256` が NULL なら NULL に倒す**
   * ——外した後も `avatar_set_at` は進むので、列をそのまま選ぶと「無い画像の版」になる。
   *
   * **{@link authorId} と同じ理由で省略可である**（一覧の行は Cache API に載っており、配備の直後の
   * 最大 60 秒はこの列を選んでいなかった頃の行が返りうる）。欠けていれば、カードは画像を出さない
   * だけである。**`users` から選ぶ列は、表示名とこの 1 つ（と画像の有無）だけ**で、`email` と
   * `invited_by` がカードへ届く経路は増えていない。
   */
  readonly authorAvatarSetAt?: number | null;
  /**
   * 作者がいま使っているハンドル名（`handles`。**決めていなければ null**。#381 / 仕様 5.10）。
   *
   * **カードは、これがあれば作者名のリンクを `/@handle` へ向ける**（`src/users-page-paths.ts` の
   * `authorPagePathFor`）。**予約中の旧ハンドル名は選ばない**（`src/handle-sql.ts`）。
   *
   * **{@link authorId} と同じ理由で省略可である**（一覧の行は Cache API に載っており、配備の直後と改名の直後の
   * 最大 60 秒は古い値か欠けた行が返りうる）。欠けていれば `/users/<user_id>` へリンクし、そちらがハンドル名へ
   * 301 で送る。古い値なら旧ハンドル名の `/@` が 90 日のあいだ新しいハンドル名へ 302 で送る。
   */
  readonly authorHandle?: string | null;
  /**
   * 作者が書いた説明（`games.description`。**空文字が「説明が無い」**。`migrations/0028_game_descriptions.sql`）。
   *
   * **カードは出さない。** 選ぶのは公開作品の一覧の口（`GET /api/works`。#699 / 仕様 5.13）が返すためで、
   * 画面と口が同じ問い合わせとキャッシュを通る（`src/works-list.ts` の `loadWorksListPage`）。
   *
   * **{@link authorId} と同じ理由で省略可である**（一覧の行は Cache API に載っており、配備の直後の
   * 最大 60 秒はこの列を選んでいなかった頃の行が返りうる）。
   */
  readonly description?: string;
  /** 公開した時刻（UNIX 秒）。0001 以前の行では null になりうる。 */
  readonly publishedAt: number | null;
  /** この作品から生まれた公開済みのフォークの数（非正規化列。5.1）。 */
  readonly forkCount: number;
  /**
   * いいねの数（`games.like_count`。5.8）。**Durable Objects から写した数で、最大 5 分
   * 遅れる。** 正本は DO にあり、ずれたら DO の側が正しい（5.1）。
   */
  readonly likeCount: number;
  /**
   * プレイ数（`games.play_count`。#377 / 仕様 2.3.6）。**Durable Objects（`PlayHub`）から写した数で、
   * 最大 5 分遅れる。**
   *
   * **{@link authorId} と同じ理由で省略可である**——一覧の行は Cache API に載っており、配備の
   * 直後の最大 60 秒は `play_count` を選んでいなかった頃の行が返りうる。**型を必須にしても、
   * 実行時に欠けている行は来る。** 欠けていれば、カードは数を出さないだけである
   * （`src/work-card.ts` の `cardPlayCount`）。
   */
  readonly playCount?: number;
  /** 親を持つか（改造された作品か）。系統の詳細は作品ページが持つ（5.5）。 */
  readonly hasParent: boolean;
  /** スクリーンショットが撮れているか。撮れていなければカードは代替表示にする。 */
  readonly hasShot: boolean;
  /**
   * タグの識別子（`games.tag1` / `tag2` / `tag3` の枠の順。#376 / 仕様 2.3.6）。タグ無しなら空配列。
   *
   * **{@link authorId} と同じ理由で省略可である**——一覧の行は Cache API に載っており、配備の
   * 直後の最大 60 秒は、タグの列を選んでいなかった頃の行が返りうる。**語彙に照らして描くのは
   * カードの側**（`src/work-card.ts` の `knownWorkTags`）で、欠けていても語彙に無い値でも、
   * タグを出さないだけで壊れない。
   */
  readonly tags?: readonly string[];
}

/**
 * 並べ替え軸ごとの `order by`。
 *
 * **軸を足したときに、既定の並びへ黙って落ちる形にしない。** 三項演算子で書くと、
 * 足した軸が「どれでもない」側（新着順）へ落ち、索引の検査だけが赤くなる。表にすると
 * 書き忘れは型の検査で落ちる。
 *
 * 列順は索引と揃えてある（`migrations/0019_games_public_list_idx.sql` の 2 本と、
 * `liked` は `migrations/0020_games_like_count.sql` の部分索引）。
 */
const PUBLIC_WORK_ORDER_BY: Readonly<Record<PublicWorkSort, string>> = {
  recent: 'g.published_at desc, g.id desc',
  forked: 'g.fork_count desc, g.published_at desc, g.id desc',
  liked: 'g.like_count desc, g.published_at desc, g.id desc',
  // `migrations/` の `games_play_count` の部分索引（#377。`liked` と同じ形）。
  played: 'g.play_count desc, g.published_at desc, g.id desc',
};

/**
 * 公開作品を引く SQL を組み立てる。
 *
 * **関数として出しているのは、実行計画を検査できるようにするためである。**
 * 仕様 2.3.3 の条件 2（索引を張る）は、**索引が実際に使われて初めて意味を持つ。**
 * SQL をここへ閉じ込めず `listPublishedGames` の中に書いたままだと、検査は同じ SQL を
 * **書き写す**ことになり、片方だけが古くなる（`.ai-playbook/shared-ai-rules.md` 12 章）。
 * `test/works-list.test.ts` はここが返す文字列に `EXPLAIN QUERY PLAN` を付けて実行する。
 *
 * **文字列を組み立てるが、材料は `PublicWorkSort` の 4 値だけである。** 利用者の入力は
 * {@link toPublicWorkSort} が既に既知の 4 語へ落としており、SQL へ届く経路が無い。
 *
 * 並び順の末尾に `id desc` を置くのは、同値の行の順序を決めるためである
 * （`migrations/0019_games_public_list_idx.sql`。索引の列順もこれに合わせてある）。
 *
 * @param sort 並べ替え軸
 * @returns 束縛パラメータが 3 つ（status / limit / offset）の SELECT 文
 */
export function publishedGamesSql(sort: PublicWorkSort): string {
  const orderBy = PUBLIC_WORK_ORDER_BY[sort];

  // `users` を join するのは表示名 1 列のためである。**行ごと持ってこない**
  // （`email` と `invited_by` は公開してはいけない。仕様 2.3.6）。
  //
  // **`g.author_id` を選ぶのは作者ページへのリンクのためである**（#330）。`users` 側から
  // 選ぶ列は増やしていない——増えたのは `games` の列 1 つで、これは既にこの表の中で
  // 誰にでも見える値である（作品ページが同じ列を引いて作者名を出している）。
  //
  // **タグの枠を選ぶのはカードに出すためである**（#376 / 2.3.6）。**絞り込まない一覧は枠で
  // 絞らない**——タグ無しの作品もここに並ぶ（#376 の constraints）。
  //
  // **`g.play_count` を選ぶのはカードに出すためである**（#377 / 2.3.6）。
  //
  // **`g.description` を選ぶのは公開作品の一覧の口が返すためである**（#699 / 5.13。カードは出さない）。
  return `select g.id, g.title, g.description, g.published_at, g.fork_count, g.like_count, g.play_count, g.parent_id,
            g.ogp_state, g.author_id, g.tag1, g.tag2, g.tag3, u.display_name as author_name,
            case when u.avatar_sha256 is null then null else u.avatar_set_at end as author_avatar_set_at,
            ${authorHandleColumnSql('g.author_id')}
       from games g
       left join users u on u.id = g.author_id
      where g.status = ? and ${reviewVisibleSql('g')}
      order by ${orderBy}
      limit ? offset ?`;
}

/** 一覧の問い合わせ（{@link publishedGamesSql} / {@link taggedGamesSql}）が返す行の形。 */
interface PublicWorkRow {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly published_at: number | null;
  readonly fork_count: number;
  readonly like_count: number;
  readonly play_count: number;
  readonly parent_id: string | null;
  readonly ogp_state: string | null;
  readonly author_id: string | null;
  readonly tag1: string | null;
  readonly tag2: string | null;
  readonly tag3: string | null;
  readonly author_name: string | null;
  readonly author_avatar_set_at: number | null;
  readonly author_handle: string | null;
}

/**
 * 一覧の行をカードの入力へ落とす。**絞り込む一覧と絞り込まない一覧が同じ 1 つを使う。**
 *
 * @param row D1 の行
 * @returns 作品カードの入力
 */
function toPublicWork(row: PublicWorkRow): PublicWork {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    authorName: row.author_name,
    authorId: row.author_id,
    authorAvatarSetAt: row.author_avatar_set_at,
    authorHandle: row.author_handle,
    publishedAt: row.published_at,
    forkCount: row.fork_count,
    likeCount: row.like_count,
    playCount: row.play_count,
    hasParent: row.parent_id !== null,
    hasShot: row.ogp_state === 'ready',
    tags: workTagsOf(row),
  };
}

/**
 * 絞り込み中の軸ごとの並びの列（**すべて降順**。列順は `games_tags` の部分索引と揃えてある）。
 *
 * `Record` にしてあるので、軸を足して列を書き忘れると型の検査で落ちる（{@link PUBLIC_WORK_ORDER_BY}
 * と同じ理由）。**別名を付けない**——`UNION ALL` の `order by` は結果の列名で書き、外側の
 * 並べ直しは `t.` を付けて同じ列を指す。
 */
const TAGGED_WORK_ORDER_COLUMNS: Readonly<Record<TaggedWorkSort, readonly string[]>> = {
  recent: ['published_at', 'id'],
  forked: ['fork_count', 'published_at', 'id'],
};

/**
 * タグで絞り込んだ公開作品を引く SQL を組み立てる（#376 / 仕様 2.3.3 の条件 2）。
 *
 * # 3 つの枠を `UNION ALL` で束ねる
 *
 * タグは `games.tag1` / `tag2` / `tag3` のどれにでも入りうる。`(tag1 = ? or tag2 = ? or tag3 = ?)`
 * と 1 本に書くと、SQLite は絞り込まない一覧の索引（`status, published_at`）を新しい順に読み、
 * **1 行ずつタグを見て捨てる**（手元の `EXPLAIN QUERY PLAN` で確かめた）。20 件を集めるまでに
 * 読む行が「そのタグの無い新しい作品の数」だけ増え、珍しいタグでは**公開作品の総数に比例する。**
 * 枠ごとに 1 本ずつ引いて `UNION ALL` で
 * 束ねると、**どの枠も部分索引（`games_tags`）を並びの順に読み、SQLite が 3 本を併合する**
 * （`MERGE (UNION ALL)`）。読む行は枠ごとに高々「読み飛ばし＋件数」で、**タグの付いた作品の
 * 総数には比例しない。**
 *
 * **同じ作品が 2 度並ばない。** 枠は重複しないように書いてある（{@link validateWorkTags}）ので、
 * 1 つの作品が 2 つの枠で同じタグに当たることは無い。`UNION`（重複除去）にしないのは、除去の
 * ための一時 B-tree が入るからである。
 *
 * # `users` の結合は `UNION ALL` の外に置く
 *
 * **枠ごとの問い合わせの中で結合すると、読み飛ばす行（`OFFSET`）の分まで `users` を引く**
 * （併合は結合した後の行で行われる）。外で結合すれば、引くのは頁に載る件数だけである。外側の `order by` は併合した順を言い直す
 * だけで、実行計画に一時 B-tree は出ない（`test/works-list.test.ts` が見る）。**SQL の結果の順を
 * 保証するのは `order by` だけなので、省かない。**
 *
 * # 条件は枠ごとに同じ綴りで書く
 *
 * `status = ?` と {@link reviewVisibleSql} は部分索引の条件と同じ綴りである（索引が使われる
 * 前提）。**文字列を組み立てるが、材料は枠の番号と {@link TaggedWorkSort} の 2 値だけ**で、
 * タグの値は束縛で渡す。
 *
 * @param sort 並べ替え軸（新着か改造された数）
 * @returns 束縛パラメータが 8 つ（tag / status を枠ごとに 3 組、limit / offset）の SELECT 文
 */
export function taggedGamesSql(sort: TaggedWorkSort): string {
  const columns = TAGGED_WORK_ORDER_COLUMNS[sort];
  const branches = [1, 2, 3].map(
    (slot) => `select g.id, g.title, g.description, g.published_at, g.fork_count, g.like_count, g.play_count, g.parent_id,
                g.ogp_state, g.author_id, g.tag1, g.tag2, g.tag3
           from games g
          where g.tag${slot} = ? and g.status = ? and ${reviewVisibleSql('g')}`,
  );
  return `select t.id, t.title, t.description, t.published_at, t.fork_count, t.like_count, t.play_count, t.parent_id,
            t.ogp_state, t.author_id, t.tag1, t.tag2, t.tag3, u.display_name as author_name,
            case when u.avatar_sha256 is null then null else u.avatar_set_at end as author_avatar_set_at,
            ${authorHandleColumnSql('t.author_id')}
       from (${branches.join(' union all ')}
         order by ${columns.map((column) => `${column} desc`).join(', ')}
         limit ? offset ?) t
       left join users u on u.id = t.author_id
      order by ${columns.map((column) => `t.${column} desc`).join(', ')}`;
}

/**
 * タグで絞り込んだ公開作品を一覧で引く（#376）。
 *
 * **絞り込みの条件（公開済み・審査の可視条件）は {@link listPublishedGames} と同じで、引く時点で
 * 行う**（#152 の規律）。違うのはタグで絞ることと、並べ替えが 2 軸であることだけである。
 *
 * **タグの値は呼び出し側が語彙へ落としてから渡す**（`src/works-list.ts`）。型で縛るのは、
 * 語彙に無い値で問い合わせを 1 本も起こさないためである。
 *
 * @param env バインディングと環境変数
 * @param tag 絞り込むタグ（語彙の識別子）
 * @param sort 並べ替え軸
 * @param limit 引く最大件数（0 以上の整数）
 * @param offset 読み飛ばす件数（0 以上の整数）
 * @returns 指定した軸の順に並んだ、そのタグの公開作品
 * @throws `limit` / `offset` が 0 以上の整数でない場合
 */
export async function listTaggedGames(
  env: Env,
  tag: WorkTagId,
  sort: TaggedWorkSort,
  limit: number,
  offset = 0,
): Promise<readonly PublicWork[]> {
  assertLimit(limit);
  assertLimit(offset, '読み飛ばし件数');

  const result = await env.DB.prepare(taggedGamesSql(sort))
    .bind(tag, PUBLISHED_STATUS, tag, PUBLISHED_STATUS, tag, PUBLISHED_STATUS, limit, offset)
    .all<PublicWorkRow>();
  return result.results.map(toPublicWork);
}

/**
 * 公開作品を一覧で引く（仕様 2.3 / #328 / M9-2）。
 *
 * # 絞り込みは引く時点で行う
 *
 * **`status = 'published'` と審査の可視条件を SQL に置く。** 画面側で `filter` する形は
 * #152 が `/works` について退けたものと同じで、**書き忘れても「それらしく」動く**
 * （公開作品は正しく出る）。5.4 の「「公開」操作で初めて URL が有効になる」を、
 * 一覧が抜け道にしてはいけない。
 *
 * **審査待ちの子を出さない条件（{@link reviewVisibleSql}）は、系統の一覧
 * （{@link listPublishedForks}）と同じ断片を借りる。** 8.4 の通報が効く範囲を
 * 画面ごとに書き分けると、足した画面だけが素通しになる。
 *
 * # BAN された作者の作品を、ここでは落とさない
 *
 * `users.banned_at` を条件に足さない。**BAN は生成と招待を止めるもの**（7.3）で、
 * 公開済みの作品を取り下げるのは 8.4 の削除（`status='removed'`）が持つ。ここで
 * 落とすと、**同じ作品が作品ページでは見えて一覧では消える**という食い違いになる。
 *
 * **#330（M9-4）が作者ページについて同じ判断をした**ので、この段は見直さずに残す。
 * 判断と 4 つの根拠は `src/users-page.ts` の「BAN 済みの利用者をどう扱うか」にある
 * ——**露出を止める単位は利用者ではなく作品である**（8.4）。したがって公開一覧・
 * トップ・作品ページ・作者ページの 4 枚が、BAN について同じことを言う状態になった。
 *
 * # 件数の上限は呼び出し側が決める
 *
 * {@link listAuthoredGames} と同じ理由でここに既定値を持たない。値と根拠は
 * `src/works-list.ts` の `WORKS_PER_PAGE` にある（仕様 2.3.3 の条件 1）。
 *
 * @param env バインディングと環境変数
 * @param sort 並べ替え軸
 * @param limit 引く最大件数（0 以上の整数）
 * @param offset 読み飛ばす件数（0 以上の整数）
 * @returns 指定した軸の順に並んだ公開作品
 * @throws `limit` / `offset` が 0 以上の整数でない場合
 */
export async function listPublishedGames(
  env: Env,
  sort: PublicWorkSort,
  limit: number,
  offset = 0,
): Promise<readonly PublicWork[]> {
  assertLimit(limit);
  assertLimit(offset, '読み飛ばし件数');

  const result = await env.DB.prepare(publishedGamesSql(sort))
    .bind(PUBLISHED_STATUS, limit, offset)
    .all<PublicWorkRow>();

  return result.results.map(toPublicWork);
}
