/**
 * 作品が読むキーを、完成を確定させた直後に保存する（仕様 3.9.5 / #493 / M14-4）。
 *
 * # 拾う箇所は 2 つあり、どちらも {@link recordSourceInputKeys} を呼ぶ
 *
 * | 経路 | 結線 | 何のあとか |
 * |---|---|---|
 * | 非同期実行（本番）: 完成のコールバック | `withSourceInputKeyRecording`（`src/source-input-keys-routes.ts`。`src/app.ts` が経路表で包む） | `handleCallback` の完成の分岐（`completeGameWithArtifacts` / `completeRevision`）。**戻り値によらない** |
 * | 同期実行 | {@link withInputKeyRecordingPipeline}（`src/generate.ts` の `runJobInline` が包む） | `pipeline.completeGame`。**戻り値によらない** |
 *
 * **「版に戻す」では何も書かない。** 行はソースに紐づくので、戻した先のソースの行がそのまま使える
 * （`migrations/0040_source_input_keys.sql`）。
 *
 * # なぜ `src/generate-callback.ts` の中に書かず、経路表で包むのか
 *
 * **オーケストレータ Lambda の束に入れないためである**（仕様 3.9.5「オーケストレータで拾わない理由」の ①）。
 * 束（`scripts/bundle-orchestrator.sh`）は `src/orchestrator/callbacks.ts` が
 * `GENERATE_CALLBACK_PATH` を import する経路で `src/generate-callback.ts` を丸ごと取り込み、
 * `handleCallback` の本体も `defaultPipeline` も出力に入っている。**そこへ 1 行足すと束の `CodeSha256` が
 * 変わり、配り直すまで main の deploy がすべて止まる**（`scripts/orchestrator-bundle-changed.sh`）。
 * 経路表を組み立てる `src/app.ts` と、束が参照しない `runJobInline` は出力に入らないので、
 * **そこで包めばエッジだけで閉じる。** 束が変わっていないことは PR ごとに
 * `scripts/orchestrator-bundle-changed.sh` で確かめる。
 *
 * # 失敗しても完成を失敗にしない
 *
 * **例外を外へ出さない。** 固定のタグ {@link SOURCE_INPUT_KEYS_LOG_TAG} でログに残し、その作品には
 * パッドが出ないだけである。欠けは、重複配信のコールバックと埋め戻しのスクリプト
 * （`scripts/input-keys-backfill.mjs`。欠けの点検を兼ねる）で回復する。
 */
import type { BuildOutcome } from './build-client.js';
import { artifactKeysOf } from './build-client.js';
import type { GenerationPipeline } from './generate.js';
import { INPUT_KEYS_RULE_VERSION, extractAliasGroups, extractHeldInputKeyCodes, extractInputKeyCodes, extractLayoutSize } from './input-keys.js';
import { readStoredSource } from './source-store.js';

/**
 * ログの固定のタグ。**運用はこの綴りで引く**（変えるなら `docs/usage-report.md` も直す）。
 *
 * # 行の形は固定である
 *
 * 次の 4 つの形の 1 行だけを出す。結果と理由は固定の語か例外のクラス名、キーは {@link isStoredSourceKey} に
 * 合ったものだけである。
 *
 * - `<タグ> source-unreadable source-missing|source-too-large <source_key>`
 * - `<タグ> failed <例外のクラス名> <source_key>`
 * - `<タグ> invalid-source-key`（**形の合わないキーは出さない**）
 * - `<タグ> callback-failed <例外のクラス名>`（経路表の側。`src/source-input-keys-routes.ts`）
 *
 * **例外の文面もソースの本文も出さない**——D1 の例外文には SQL の断片が載りうる。生成経路のログを「許した形だけを通す」で見る検査
 * （`test/mechanical-fix.test.ts`）は、この形を
 * `test/helpers/source-input-keys-log.ts` で許している。
 */
export const SOURCE_INPUT_KEYS_LOG_TAG = '[source-input-keys]';

/**
 * R2 のソースのキーの形（正規表現の本体。`^` と `$` を持たない）。
 *
 * **キーの綴りを決めているのはビルド関数である**（`docker/isolated-build/handler/r2.go`。内容のハッシュで
 * `builds/<source_sha256>/source.go`）。完成のコールバックの解析（`src/generate-callback.ts`）は「空でない文字列」
 * しか見ないので、**ここで形を確かめてから R2 と D1 に触る。** 改行を含む値でログの固定の形を崩させない。
 *
 * **写しを作らない。** {@link isStoredSourceKey} と、テストのログの許可パターン
 * （`test/helpers/source-input-keys-log.ts`）と、埋め戻し（`scripts/input-keys-backfill.mjs`）はここから組み立てる。
 */
export const SOURCE_KEY_PATTERN_BODY = 'builds/[0-9a-f]{64}/source\\.go';

/**
 * R2 のソースのキーとして正しい形か（行全体に合わせる。`m` フラグを付けない）。
 *
 * **正規表現を関数の中で組み立てる。** モジュールの最上位に `new RegExp(...)` を置くと、esbuild はそれを
 * 副作用のある文として残し、**このモジュールがオーケストレータの束へ入って束が変わる**
 * （`src/generate.ts` の `runJobInline` がこのモジュールを import しており、あちらは束のモジュールである。
 * 実測: PR #504 の修正の途中で `ORCHESTRATOR_BUNDLE_CHANGED` になった）。
 *
 * @param sourceKey 確かめる値
 * @returns 形に合えば true
 */
export function isStoredSourceKey(sourceKey: string): boolean {
  return new RegExp(`^${SOURCE_KEY_PATTERN_BODY}$`).test(sourceKey);
}

/**
 * 保存の 1 文（仕様 3.9.5 / 3.9.6 の「保存」）。**新しい版だけが上書きする**——同じ版の 2 回目は何も変えない。
 *
 * 束縛する値は `source_key` / `codes`（JSON 配列の文字列）/ `held_codes`（押し続けて読む `code` の JSON 配列の文字列）/
 * `alias_groups`（同じ条件式で読むキーの組の JSON 配列の文字列。#543）/ `layout_width` / `layout_height`（作品の論理解像度の整数。
 * 拾えなければ両方 NULL。#514）/ `rule_version` / `extracted_at` の順。
 * **`codes` と `held_codes` と `alias_groups` と論理解像度を同じ 1 文で書く**——一部だけが新しい行を作らない
 * （`held_codes` が NULL なのは版 1 の行だけ、`alias_groups` が NULL なのは版 2 以下の行だけ、を崩さない。
 * `migrations/0042_source_input_keys_held_codes.sql` / `migrations/0043_source_input_keys_alias_groups.sql`）。
 * **`layout_width` と `layout_height` は両方に値があるか両方 NULL** で、片方だけの値は書かない（{@link layoutColumnsOf}。
 * `migrations/0044_source_input_keys_layout.sql`）。
 * **埋め戻しのスクリプトも、この綴りを使う**（`scripts/input-keys-backfill.mjs` がソースから取り出す）。
 */
export const UPSERT_SOURCE_INPUT_KEYS_SQL = `insert into source_input_keys (source_key, codes, held_codes, alias_groups, layout_width, layout_height, rule_version, extracted_at)
values (?, ?, ?, ?, ?, ?, ?, ?)
on conflict(source_key) do update set
  codes = excluded.codes, held_codes = excluded.held_codes, alias_groups = excluded.alias_groups,
  layout_width = excluded.layout_width, layout_height = excluded.layout_height,
  rule_version = excluded.rule_version, extracted_at = excluded.extracted_at
where excluded.rule_version > source_input_keys.rule_version`;

/**
 * 埋め戻しの対象（仕様 3.9.5「既存作品への埋め戻し」）。束縛する値は今の規則の版 1 つ。
 *
 * **`games.source_key`（NULL を除く）と `game_revisions.source_key` の和集合のうち、行が無いか
 * `rule_version` が古いもの。** 版の表も含めるのは、「版に戻す」で昔のソースが現役に戻るからである。
 * **tombstone で NULL になった `games.source_key` は拾わない**（取り下げた作品は遊べない）。
 * **版 2 に上げたので、版 1 の行（`held_codes` が NULL）もすべて対象に入る**（仕様 3.9.6 の「保存」）。
 * **版 3 に上げたので、版 2 の行（`alias_groups` が NULL）もすべて対象に入る**（仕様 3.9.6 の #543 の「保存」）。
 * **版 4 に上げたので、版 3 の行（論理解像度がまだ拾われていない）もすべて対象に入る**（仕様 3.9.4 の #514 の「保存」）。
 *
 * **埋め戻しのスクリプトも、この綴りを使う**（上と同じ）。
 */
export const SOURCE_INPUT_KEYS_TARGETS_SQL = `select k.source_key as source_key
  from (
    select source_key from games where source_key is not null
    union
    select source_key from game_revisions where source_key is not null
  ) k
  left join source_input_keys s on s.source_key = k.source_key
 where s.source_key is null or s.rule_version < ?
 order by k.source_key`;

/** {@link recordSourceInputKeys} の結果。**呼ぶ側は分岐に使わない**（テストとログのためにある）。 */
export type SourceInputKeysOutcome =
  /** 今の版の行が既にあった。R2 を読んでいない。 */
  | 'present'
  /** 拾って書いた（あるいは、並行した別の完成が先に書いていた）。 */
  | 'recorded'
  /** R2 のソースを読めなかった（無い・空・大きすぎる）。 */
  | 'source-unreadable'
  /** D1 か R2 が例外を投げた。 */
  | 'failed'
  /** キーが {@link isStoredSourceKey} の形に合わない。R2 も D1 も触っていない。 */
  | 'invalid-source-key';

/**
 * そのソースが読むキーを保存する。**例外を投げない。**
 *
 * @param env バインディングと環境変数
 * @param sourceKey R2 のソースのキー
 * @param now 拾った時刻（UNIX 秒。既定は現在時刻）
 * @returns 何をしたか
 */
export async function recordSourceInputKeys(
  env: Env,
  sourceKey: string,
  now: number = Math.floor(Date.now() / 1000),
): Promise<SourceInputKeysOutcome> {
  // **形を先に確かめる。** 合わなければ R2 も D1 も触らず、キーを出さない固定の行だけを残す。
  if (!isStoredSourceKey(sourceKey)) {
    console.error(`${SOURCE_INPUT_KEYS_LOG_TAG} invalid-source-key`);
    return 'invalid-source-key';
  }
  try {
    // **行が今の版なら R2 を読まない**（キャッシュのヒット＝同じソースでは普通そうなる）。
    // `>=` にしてあるのは、新しい版の Worker を戻したときに、新しい版の行を読み直しに行かないため。
    // **版 1 の行（`held_codes` が NULL）と版 2 の行（`alias_groups` が NULL）と版 3 の行（論理解像度がまだ無い）は版が古いので、
    // ここを抜けて拾い直す**（仕様 3.9.6 の「保存」、3.9.4 の #514 の「保存」）。
    const row = await env.DB.prepare('select rule_version from source_input_keys where source_key = ?')
      .bind(sourceKey)
      .first<{ rule_version: number }>();
    if (row !== null && row.rule_version >= INPUT_KEYS_RULE_VERSION) {
      return 'present';
    }

    const read = await readStoredSource(env, sourceKey);
    if (!read.ok) {
      console.error(`${SOURCE_INPUT_KEYS_LOG_TAG} source-unreadable ${read.reason} ${sourceKey}`);
      return 'source-unreadable';
    }

    const codes = extractInputKeyCodes(read.source);
    const heldCodes = extractHeldInputKeyCodes(read.source);
    const aliasGroups = extractAliasGroups(read.source);
    const [layoutWidth, layoutHeight] = layoutColumnsOf(read.source);
    await env.DB.prepare(UPSERT_SOURCE_INPUT_KEYS_SQL)
      .bind(
        sourceKey,
        JSON.stringify(codes),
        JSON.stringify(heldCodes),
        JSON.stringify(aliasGroups),
        layoutWidth,
        layoutHeight,
        INPUT_KEYS_RULE_VERSION,
        now,
      )
      .run();
    return 'recorded';
  } catch (error) {
    // **完成を失敗にしない**（仕様 3.9.5）。メッセージは出さない——D1 の例外文に SQL の断片が載りうる。
    console.error(`${SOURCE_INPUT_KEYS_LOG_TAG} failed ${errorNameOf(error)} ${sourceKey}`);
    return 'failed';
  }
}

/**
 * ソースから、列 `layout_width` / `layout_height` に書く値の組を作る（仕様 3.9.4。規則の版 4）。
 *
 * **2 つの列は、両方に値があるか両方 NULL のどちらかにする**（`migrations/0044_source_input_keys_layout.sql`）。
 * 拾えなかった（`extractLayoutSize` が null）なら両方 NULL で、「版 4 の行で NULL＝拾えなかった」になる。
 * **埋め戻しのスクリプトも、この関数を使う**（`scripts/input-keys-backfill.mjs`。組み立て方を 2 か所に書かない）。
 *
 * @param source Go のソース本文
 * @returns `[layout_width, layout_height]`
 */
export function layoutColumnsOf(source: string): readonly [number, number] | readonly [null, null] {
  const size = extractLayoutSize(source);
  return size === null ? [null, null] : [size.width, size.height];
}

/**
 * 同期実行の `completeGame` の後で拾うように、段を包む（仕様 3.9.5 の「拾う箇所」の 2）。
 *
 * **戻り値によらず拾う。** false（その行はもう `running` ではない）でも、成果物は R2 に在る。
 * **戻り値はそのまま返す**——`runGenerationJob` が false を `GenerationNotCompletable` にする振る舞いを変えない。
 *
 * @param pipeline 包む段
 * @returns `completeGame` だけを差し替えた段
 */
export function withInputKeyRecordingPipeline(pipeline: GenerationPipeline): GenerationPipeline {
  return {
    ...pipeline,
    completeGame: async (env: Env, gameId: string, built: BuildOutcome): Promise<boolean> => {
      const completed = await pipeline.completeGame(env, gameId, built);
      await recordSourceInputKeys(env, artifactKeysOf(built).sourceKey);
      return completed;
    },
  };
}

/**
 * ログへ出す例外の名前。**クラス名だけを出す**（文面は出さない。英字以外が混じれば `unknown`）。
 *
 * @param error catch した値
 * @returns 例外のクラス名
 */
export function errorNameOf(error: unknown): string {
  return error instanceof Error && /^[A-Za-z]+$/.test(error.name) ? error.name : 'unknown';
}
