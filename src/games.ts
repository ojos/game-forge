/**
 * 作品行の作成（3.3-8 / 5.1 / 5.4 / #21）。
 *
 * 3.3 の書き込み経路の最後の段である。**ここが持つのは `games` へ 1 行書くことと、
 * ビルド結果キャッシュの索引（3.8）を書くことの 2 つだけ**で、R2 へは触らない
 * （成果物を書くのはビルド関数である。3.3-6）。
 *
 * ## 状態は必ず `draft` である
 *
 * 5.4 は「生成 → 作者が試遊 → 「公開」操作で初めて URL が有効になる」と定める。
 * **生成の経路が `published` を作れてはならない。** 状態を引数で受け取らないのは
 * そのためで、公開は M3 の別の経路が `status` を進める。
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
 *   ここが作る行は、まさにその「参照」になる。
 *
 * ## 3.3-4（費用計上）との関係
 *
 * `generations.game_id` はここでは埋めない。台帳の行はビルドより前に書かれており
 * （3.3-4）、その行の id は経路を通って来ていない（`GenerationPipeline.recordCost` は
 * 値を返さない）。ここで推測して UPDATE すると、リトライ（5.2-7）で複数行ある台帳の
 * どれを結ぶかを当てずっぽうで決めることになる。
 *
 * **これは「後続の課題」ではなく、結び付けないという決定である**（確定27 / #124）。
 * 読む側が存在しないためで（主 KPI のフォーク率は `games` の系統から出る。10 章）、
 * **消費者が現れてから作る。** 根拠と、そのときの選択肢は仕様書 5.1 にある。
 */
import type { BuildOutcome } from './build-client.js';
import { artifactKeysOf, buildCacheRecordOf } from './build-client.js';
import type { GenerateRequest } from './generate.js';
import { recordBuildCache } from './build-cache.js';

/** 生成直後の作品の状態（5.4）。**この経路はこれ以外を作らない。** */
export const DRAFT_STATUS = 'draft';

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
  const bytes = crypto.getRandomValues(new Uint8Array(PREVIEW_KEY_BYTES));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * プロンプトから仮のタイトルを作る。
 *
 * # なぜ仮のタイトルが要るのか
 *
 * `games.title` は `NOT NULL` である（5.1 / `migrations/0001_init.sql`）。**一方、
 * 3.3 の経路にタイトルを決める段は無い。** 空文字で埋めると「タイトルが無い」ことが
 * 表現できず、一覧に無地の行が並ぶ。**プロンプトの 1 行目を借りる**のが、追加の
 * 生成も追加の入力も要らずに意味のある文字列を得る唯一の手段である。
 *
 * **これは暫定である。** 作者がタイトルを付ける口は公開フロー（5.4 / M3）が持つ。
 * ここが決めるのは「その口ができるまでのあいだ、何が入っているか」だけである。
 *
 * # 生成物ではなく入力から取る
 *
 * LLM の出力（Go のソース）から取ると、8.3 の検査を通っていない文字列が表示面へ
 * 出る経路になる。プロンプトは利用者自身の入力で、`generations.prompt` として
 * すでに D1 に保存されている（5.1）。**新しい種類のデータを表示面へ持ち込まない。**
 *
 * @param prompt 利用者が入力した自然文プロンプト
 * @returns 仮のタイトル（空にならない）
 */
export function draftTitleFromPrompt(prompt: string): string {
  // 改行以降は落とす。**1 行目だけを使う**（複数行のプロンプトで一覧が崩れる）。
  const firstLine = prompt.split('\n')[0] ?? '';
  // 制御文字を空白へ潰す。プロンプトは利用者の自由入力で、表示面へそのまま出る。
  const cleaned = firstLine.replace(/[\u0000-\u001f\u007f]/gu, ' ').trim();
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
 * `games` 行を `status='draft'` で作り、ビルド結果キャッシュの索引を記録する（3.3-8）。
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
 * 先に `games` 行があれば、掃除の数え直し（2）はこの行を見つけて成果物を残す。
 *
 * **隙間が完全に無くなるわけではない**（掃除の 1 の直前にヒットした生成が、3 のあとで
 * 行を作る経路は残る。3.7 が「残る隙間を隠さない」と書いているとおりである）。
 * ここで選べるのは、**窓を広げないほうの順序**である。
 *
 * # ヒット時は索引を書き直さない
 *
 * 索引は既にあり、書き直すと `created_at` だけが若返る（`buildCacheRecordOf`）。
 *
 * # プレビュー用キーもここで作る（#28 / 5.4）
 *
 * `preview_key` は作者プレビュー URL（`/p/<preview_key>/`）の唯一の資格情報である。
 * **`games` 行と同時に作る**のは、後から埋める経路にすると「キーの無い draft」が
 * 存在しうる状態になり、配信側（`src/sandbox-delivery.ts`）が扱えない行を作るため。
 *
 * # 冪等ではない
 *
 * 同じ入力で 2 回呼べば 2 つの作品ができる。**それが正しい**（同じプロンプトから
 * 2 件作ることは利用者の自由で、確定26 のもとでは 2 件が同じ成果物を指すだけである）。
 *
 * @param env バインディングと環境変数
 * @param userId 作者
 * @param request 生成リクエスト（仮のタイトルに使う）
 * @param built ビルドの結果（ヒット・非ヒットのどちらでもよい）
 * @param now 作成時刻（UNIX 秒。既定は現在時刻）
 * @returns 作成した作品の id
 */
export async function createDraftGame(
  env: Env,
  userId: string,
  request: GenerateRequest,
  built: BuildOutcome,
  now: number = Math.floor(Date.now() / 1000),
): Promise<{ readonly id: string }> {
  const id = crypto.randomUUID();
  const keys = artifactKeysOf(built);

  await env.DB.prepare(
    `insert into games
       (id, author_id, parent_id, status, title, go_version, source_key, wasm_key,
        fork_count, created_at, published_at, preview_key)
     values (?, ?, null, ?, ?, ?, ?, ?, 0, ?, null, ?)`,
  )
    .bind(
      id,
      userId,
      // **状態は定数である。** 引数で受け取らないのは、生成の経路から
      // `published` を作れないようにするため（5.4）。
      DRAFT_STATUS,
      draftTitleFromPrompt(request.prompt),
      // 3.5 の `wasm_exec.js` 出し分けに要る。ヒット時は索引が覚えている版で、
      // **そのとき配られる成果物もその版でビルドされたもの**である。
      built.goVersion,
      keys.sourceKey,
      keys.wasmKey,
      now,
      // 5.4 の作者プレビュー URL（`/p/<preview_key>/`）。**行を作るたびに新しく引く。**
      // 同じソースからの 2 件目（確定26 でキーは共有される）でも、プレビュー URL は
      // 別でなければならない。片方の URL を止めたときに、もう片方まで止まってしまう。
      createPreviewKey(),
    )
    .run();

  // 3.8: 成果物は R2 に入っている（3.3-6 が書いた、あるいは索引が指していた）。
  const record = buildCacheRecordOf(built);
  if (record !== null) {
    await recordBuildCache(env, record, now);
  }

  return { id };
}
