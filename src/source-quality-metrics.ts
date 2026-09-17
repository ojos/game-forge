/**
 * 生成物の質の指標を D1 へ保存する（#605 / マイグレーション `0046`）。
 *
 * **測る規則は持たない。** 純粋関数は `src/source-quality.ts`、完成の経路への結線は
 * `src/source-quality-routes.ts` にある（`src/input-keys.ts` / `src/source-input-keys.ts` /
 * `src/source-input-keys-routes.ts` の 3 分割に合わせた）。
 *
 * ## 書く契機は 2 か所
 *
 * | 経路 | 包む場所 | 契機 |
 * |---|---|---|
 * | 非同期実行（本番） | `withSourceQualityRecording`（`src/source-quality-routes.ts`） | 完成のコールバックが 200 を返した後 |
 * | 同期実行（手元） | {@link withQualityRecordingPipeline} | `completeGame` の後 |
 *
 * **どちらもオーケストレータの束の外である。** `src/generate-callback.ts` の中に書くと
 * 束が変わり、**配り直すまで main の deploy が全部止まる**（#241 の関門）。
 * `src/source-input-keys.ts` が同じ理由で同じ形を採っている。
 *
 * ## 完成を失敗にしない
 *
 * **測れなくても生成は成功である。** 例外は握り、ログへ残して先へ進む。指標は後から
 * 埋め戻せる（{@link SOURCE_QUALITY_TARGETS_SQL}）が、**失敗にした生成は戻らない。**
 */
import type { BuildOutcome } from './build-client.js';
import { artifactKeysOf } from './build-client.js';
import type { GenerationPipeline } from './generate.js';
import { SOURCE_QUALITY_RULE_VERSION, measureSourceQuality } from './source-quality.js';
import { errorNameOf, isStoredSourceKey } from './source-input-keys.js';
import { readStoredSource } from './source-store.js';

/** ログの接頭辞。 */
export const SOURCE_QUALITY_LOG_TAG = '[source-quality]';

/**
 * 1 行を書く（新しい版だけが上書きする）。
 *
 * **`where excluded.rule_version > rule_version` を外さない**（0040 と同じ）。
 * 並行した 2 回の完成でも、古い版が新しい版を踏み潰さない。
 */
export const UPSERT_SOURCE_QUALITY_SQL = `insert into source_quality_metrics
  (source_key, has_win_text, has_lose_text, color_count, sprite_count, state_count, rule_version, extracted_at)
values (?, ?, ?, ?, ?, ?, ?, ?)
on conflict(source_key) do update set
  has_win_text = excluded.has_win_text, has_lose_text = excluded.has_lose_text,
  color_count = excluded.color_count, sprite_count = excluded.sprite_count,
  state_count = excluded.state_count,
  rule_version = excluded.rule_version, extracted_at = excluded.extracted_at
where excluded.rule_version > source_quality_metrics.rule_version`;

/**
 * 埋め戻しの対象（まだ測っていない、または規則が古いもの）。
 *
 * **版の表も含める。** 「版に戻す」で昔のソースが現役に戻るため（0040 と同じ）。
 */
export const SOURCE_QUALITY_TARGETS_SQL = `select k.source_key as source_key
  from (
    select source_key from games where source_key is not null
    union
    select source_key from game_revisions where source_key is not null
  ) k
  left join source_quality_metrics q on q.source_key = k.source_key
 where q.source_key is null or q.rule_version < ?
 order by k.source_key`;

/** {@link recordSourceQuality} の結果。 */
export type SourceQualityOutcome =
  /** 既に今の版で測ってある（R2 を読んでいない）。 */
  | 'present'
  /** 測って書いた。 */
  | 'recorded'
  /** R2 から読めなかった。 */
  | 'source-unreadable'
  /** 読めたが字句解析が通らなかった。 */
  | 'unparsable'
  /** 例外。完成は失敗にしない。 */
  | 'failed'
  /** キーの形が違う（R2 も D1 も触っていない）。 */
  | 'invalid-source-key';

/**
 * ソース 1 本を測って書く。
 *
 * @param env 実行環境
 * @param sourceKey R2 のソースのキー
 * @param now 記録する時刻（UNIX 秒）
 * @returns 何が起きたか
 */
export async function recordSourceQuality(
  env: Env,
  sourceKey: string,
  now: number = Math.floor(Date.now() / 1000),
): Promise<SourceQualityOutcome> {
  // **形を先に確かめる**（0040 と同じ）。合わなければ R2 も D1 も触らず、キーを出さない。
  if (!isStoredSourceKey(sourceKey)) {
    console.error(`${SOURCE_QUALITY_LOG_TAG} invalid-source-key`);
    return 'invalid-source-key';
  }
  try {
    // **行が今の版なら R2 を読まない。** `>=` にしてあるのは、新しい版の Worker を戻したときに
    // 新しい版の行を測り直しに行かないため（0040 と同じ）。
    const row = await env.DB.prepare('select rule_version from source_quality_metrics where source_key = ?')
      .bind(sourceKey)
      .first<{ rule_version: number }>();
    if (row !== null && row.rule_version >= SOURCE_QUALITY_RULE_VERSION) {
      return 'present';
    }

    const read = await readStoredSource(env, sourceKey);
    if (!read.ok) {
      console.error(`${SOURCE_QUALITY_LOG_TAG} source-unreadable ${read.reason} ${sourceKey}`);
      return 'source-unreadable';
    }

    const measured = measureSourceQuality(read.source);
    if (!measured.ok) {
      // **測れなかったことを 0 として書かない。** 行が無いことが「測れていない」を表す
      // （`src/source-quality.ts` の「読み取れなければ落とす」）。
      console.error(`${SOURCE_QUALITY_LOG_TAG} unparsable ${sourceKey}`);
      return 'unparsable';
    }

    const m = measured.metrics;
    await env.DB.prepare(UPSERT_SOURCE_QUALITY_SQL)
      .bind(
        sourceKey,
        m.hasWinText ? 1 : 0,
        m.hasLoseText ? 1 : 0,
        m.colorCount,
        m.spriteCount,
        m.stateCount,
        SOURCE_QUALITY_RULE_VERSION,
        now,
      )
      .run();
    return 'recorded';
  } catch (error) {
    // **完成を失敗にしない。** メッセージは出さない——D1 の例外文に SQL の断片が載りうる。
    console.error(`${SOURCE_QUALITY_LOG_TAG} failed ${errorNameOf(error)} ${sourceKey}`);
    return 'failed';
  }
}

/**
 * 同期実行の経路（手元）で、完成の直後に測る段を足す。
 *
 * **この関数はオーケストレータの束が参照しない**（`src/generate.ts` の `runJobInline` は
 * エッジだけで動く）。`withInputKeyRecordingPipeline` と同じ位置づけである。
 *
 * @param pipeline 包むパイプライン
 * @returns 測る段を足したパイプライン
 */
export function withQualityRecordingPipeline(pipeline: GenerationPipeline): GenerationPipeline {
  return {
    ...pipeline,
    completeGame: async (env: Env, gameId: string, built: BuildOutcome): Promise<boolean> => {
      const completed = await pipeline.completeGame(env, gameId, built);
      await recordSourceQuality(env, artifactKeysOf(built).sourceKey);
      return completed;
    },
  };
}
