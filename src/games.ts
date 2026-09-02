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
import type { BuildOutcome } from './build-client.js';
import type { BuildCacheRecord } from './build-cache.js';
import { artifactKeysOf, buildCacheRecordOf } from './build-client.js';
import type { GenerateRequest } from './generate.js';
import { recordBuildCache } from './build-cache.js';

/** 生成直後の作品の状態（5.4）。**この経路はこれ以外を作らない。** */
export const DRAFT_STATUS = 'draft';

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
  return await insertPendingGame(env, userId, request, null, now);
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
  return await insertPendingGame(env, userId, request, parentId, now);
}

/**
 * `games` の行を 1 つ `pending` で挿入する。
 *
 * **SQL をこの 1 か所に置く。** 新規生成とフォークで文を書き分けると、列を足した日に
 * 片方だけが古くなる（shared-ai-rules 12 章「一覧の複製を作らない」）。違いは
 * `parent_id` に何を束ねるかだけである。
 *
 * @param env バインディングと環境変数
 * @param userId 作者
 * @param request 生成リクエスト（仮のタイトルに使う）
 * @param parentId 親の作品 id（オリジナルなら null）
 * @param now 作成時刻（UNIX 秒）
 * @returns 作品の id と、ジョブトークンの平文
 */
async function insertPendingGame(
  env: Env,
  userId: string,
  request: GenerateRequest,
  parentId: string | null,
  now: number,
): Promise<PendingGame> {
  const id = crypto.randomUUID();
  const jobToken = createJobToken();

  await env.DB.prepare(
    `insert into games
       (id, author_id, parent_id, status, title, go_version, source_key, wasm_key,
        fork_count, created_at, published_at, preview_key,
        generation_state, generation_error, job_token_hash, generation_started_at)
     values (?, ?, ?, ?, ?, ?, null, null, 0, ?, null, null, 'pending', null, ?, null)`,
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
    )
    .run();

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
 * 重複が止まらないと、1 回の送信につき約 16 円が二重・三重に出て、日次枠も同時に減る
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
    `update games
        set generation_state = 'failed', generation_error = ?, job_token_hash = null
      where id = ? and generation_state in ('pending', 'running')`,
  )
    .bind(code, gameId)
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
 * 取り下げ（tombstone 化）された作品の状態（5.3 / 5.4 / M5-4 / #35）。
 *
 * **書き込むのは {@link removeGame} だけである**（#35 で入った。それまでは読む側
 * ——系統の表示が「削除済みの作品から派生」を出し分けるため——だけが要っていた）。
 * {@link PUBLISHED_STATUS} と同じ形で、**書ける場所を 1 つに絞る。**
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
  | { readonly ok: false; readonly reason: 'not-found' | 'not-ready' | 'removed' };

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
 * @param env バインディングと環境変数
 * @param gameId 対象の作品 id
 * @param authorId 操作している利用者（**作者本人でなければ通らない**）
 * @param now 公開時刻（UNIX 秒。既定は現在時刻）
 * @returns 公開の結果
 */
export async function publishGame(
  env: Env,
  gameId: string,
  authorId: string,
  now: number = Math.floor(Date.now() / 1000),
): Promise<PublishOutcome> {
  const result = await env.DB.prepare(
    `update games
        set status = ?, published_at = ?
      where id = ? and author_id = ? and status = ? and generation_state = 'ready'`,
  )
    .bind(PUBLISHED_STATUS, now, gameId, authorId, DRAFT_STATUS)
    .run();

  if ((result.meta.changes ?? 0) > 0) {
    // **遷移が起きたときだけ数え直す。** 二度押しの 2 回目はここへ来ない
    // （`status = 'draft'` の条件が先に外れる）ので、押した回数では増えない。
    await refreshParentForkCount(env, gameId);
    return { ok: true, firstTime: true, publishedAt: now };
  }

  const row = await env.DB.prepare(
    'select status, published_at from games where id = ? and author_id = ?',
  )
    .bind(gameId, authorId)
    .first<{ status: string; published_at: number | null }>();

  if (row === null) {
    // 行が無い、あるいは他人の作品。**区別しない。**
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
 * 取り下げの結果（5.3 / M5-4 / #35）。
 *
 * 形は {@link PublishOutcome} に揃えてある。**「できなかった」を 1 つにまとめない**
 * のも同じ理由で、呼び出し側が返すステータスと文言が理由ごとに違う。
 */
export type RemoveOutcome =
  | {
      readonly ok: true;
      /** **この呼び出しが実際に遷移させたか。** 二度押しの 2 回目は false。 */
      readonly firstTime: boolean;
    }
  | { readonly ok: false; readonly reason: 'not-found' | 'not-published' };

/**
 * 作品を取り下げる（tombstone 化。5.3 / M5-4 / #35）。
 *
 * # 物理削除しない
 *
 * 5.3 は「**親の削除は物理削除せず tombstone 化**し、子は残して「削除済みの作品から
 * 派生」と表示する」と定める。`delete from games` にできない理由は 3 つある。
 *
 * 1. **子の `parent_id` が親を指している。** 消すと外部キーが宙に浮くか、
 *    連鎖削除で子まで消える。**どちらも 5.3 が明示的に採らないと言っている形**である
 *    （「連鎖削除は荒れるため採らない」）。
 * 2. **子の画面が「削除済みの作品から派生」と言えなくなる。** 行が無いと、
 *    `parentWorkOf` から見て「親が居ない（オリジナル）」と区別できない
 *    （`src/work-page.ts` は結合の空振りも `removed` へ倒すが、**それは保険であって
 *    設計ではない**）。
 * 3. **R2 の成果物は作品をまたいで共有される**（確定26）。行を消すと、確定26 の
 *    削除規約 ① が「参照ゼロ」と判定する対象が変わる。**参照する側の行が失われる**
 *    のは #202 / #203 が踏んだ事故そのものである。
 *
 * # 連鎖しない
 *
 * **この関数は `games` の 1 行しか書き換えない。** 子の `status` に触れない
 * （子が `published` のまま残ることが #35 の acceptance である）。**子を巻き込む
 * 条件を「書かない」ことで守る**——`where` に子を含める余地のある SQL を置いてから
 * 「含めないように気をつける」形にしない。
 *
 * # `published` からしか遷移しない
 *
 * 取り下げるものがあるのは、公開してしまった作品だけである。`draft` は
 * **そもそも公開 URL を持たない**（5.4）ので、取り下げるべきものが無い
 * （未公開の行は 3.7 の掃除に任せる。確定13）。**条件を狭くしておくほうが、
 * 広げる日に判断を残せる。**
 *
 * # 親の `fork_count` は数え直す
 *
 * 取り下げた作品が誰かの子であれば、**その親の被改造数は 1 件減る。** 5.5 の
 * 「このゲームからの改造: N 件」は `status='published'` のみを数えるので、
 * 取り下げた作品が数に残ってはいけない。{@link refreshParentForkCount} は
 * 数え直しなので、**増やす側と同じ 1 本で賄える。**
 *
 * @param env バインディングと環境変数
 * @param gameId 対象の作品 id
 * @param authorId 操作している利用者（**作者本人でなければ通らない**）
 * @returns 取り下げの結果
 */
export async function removeGame(
  env: Env,
  gameId: string,
  authorId: string,
): Promise<RemoveOutcome> {
  const result = await env.DB.prepare(
    'update games set status = ? where id = ? and author_id = ? and status = ?',
  )
    .bind(REMOVED_STATUS, gameId, authorId, PUBLISHED_STATUS)
    .run();

  if ((result.meta.changes ?? 0) > 0) {
    await refreshParentForkCount(env, gameId);
    return { ok: true, firstTime: true };
  }

  // **理由を引く SELECT にも `author_id = ?` を入れる**（{@link publishGame} と
  // 同じ理由。他人の作品に対して理由を撃ち分けると、任意の id が実在するかを外から
  // 確かめられる手がかりになる）。
  const row = await env.DB.prepare('select status from games where id = ? and author_id = ?')
    .bind(gameId, authorId)
    .first<{ status: string }>();

  if (row === null) {
    return { ok: false, reason: 'not-found' };
  }
  if (row.status === REMOVED_STATUS) {
    // **二度押し。** 取り下げそのものは成立している状態なので、失敗にしない。
    return { ok: true, firstTime: false };
  }
  return { ok: false, reason: 'not-published' };
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
 *    {@link removeGame}）の関門が壊れても、**数が壊れるところまでは伝播しない。**
 * 3. **増減の両方を 1 つの綴りで賄える。** tombstone 化（5.3 / M5-4 / #35）は子を
 *    1 件減らす操作だが、`- 1` を別に書く必要が無い（{@link removeGame} が同じ
 *    関数を呼ぶ）。
 *
 * 代償は、親の子を毎回数え直すことである。**`games_parent_id_idx`（0001）がある**ので
 * 索引の範囲走査で済み、しかも走るのは公開・取り下げのときだけ（閲覧では走らない）。
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
    `select count(*) as n from games where parent_id = ? and status = ?`,
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
    `select id, title, published_at
       from games
      where parent_id = ? and status = ?
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
 * いけない。** 生成直後の作品はすべて `status='draft'` で（`src/games.ts` 冒頭）、
 * 現時点では公開の操作そのものが未実装（M4-1 / #26）なので、**この関数が返す行は
 * 実質すべて draft である。** したがって「他人の行を 1 行も返さない」ことは、
 * この一覧における 5.4 の担保そのものになる。
 *
 * **絞り込みを呼び出し側へ出さない。** 画面側で `filter` する形にすると、条件を
 * 書き忘れた呼び出しが生まれても**動作では気づけない**（自分の作品は正しく出る）。
 * 引く時点で SQL の `where` に入れておけば、書き忘れようがない。
 *
 * # `removed` を除く
 *
 * `status='removed'` は 8.4 の削除申請と 5.3 の tombstone 化が作る状態で、**作者が
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
 * `src/my-works.ts` の `MAX_LISTED_WORKS` にある。
 *
 * @param env バインディングと環境変数
 * @param authorId 作者の利用者 id
 * @param limit 引く最大件数（0 以上の整数）
 * @returns 新しい順（同時刻は id の降順）の作品
 * @throws `limit` が 0 以上の整数でない場合
 */
export async function listAuthoredGames(
  env: Env,
  authorId: string,
  limit: number,
): Promise<readonly AuthoredGame[]> {
  assertLimit(limit);

  // 並べ替えの 2 列目に `id` を置くのは、`created_at` が UNIX 秒で**同じ秒に作られた
  // 2 件の順序が決まらない**ためである（`migrations/0008_games_author_id_idx.sql`）。
  // 索引の列順もこの並びに合わせてある。
  const result = await env.DB.prepare(
    `select id, title, generation_state, created_at, generation_started_at
       from games
      where author_id = ? and status <> 'removed'
      order by created_at desc, id desc
      limit ?`,
  )
    .bind(authorId, limit)
    .all<{
      id: string;
      title: string;
      generation_state: string;
      created_at: number;
      generation_started_at: number | null;
    }>();

  return result.results.map((row) => ({
    id: row.id,
    title: row.title,
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
