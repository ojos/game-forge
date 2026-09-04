/**
 * 3.8 の degrade の発火信号（#140 / 確定24）。
 *
 * **このモジュールが持つのは「ビルド経路が止まっているか」だけである。** 何を出すかは
 * 生成画面（`src/generate-page.ts`）が、いつ書くかはコールバック経路
 * （`src/generate-callback.ts`）が持つ。
 *
 * ## 何を停止事象と数えるか（確定24）
 *
 * 確定24 は停止事象を**関数の失敗・スロットリング・リージョン障害**と定義し直した。
 * `src/build-client.ts` はこの 3 つを**まとめて `kind === 'function'`** として上げる
 * （`BuildFunctionFailed` は「関数を呼べなかった」＝送信失敗・権限・404・429 の
 * スロットリングと、「関数が障害として失敗した」＝`x-amz-function-error` の両方を運ぶ。
 * `BuildResponseUnreadable` も同じ `kind` を名乗る）。**判定はその 1 語で足りる。**
 *
 * 数えないものを、数えない理由とともに挙げる。
 *
 * | 種別 | 数えない理由 |
 * |---|---|
 * | `kind='build'`（{@link BuildRejected}） | 生成コードがコンパイルを通らなかった**平常の結果**である。経路は生きている |
 * | `kind='timeout'`（{@link BuildTimedOut}） | **3.8 の #164 注記が明示的に除外している。** 「止まった」のではなく「間に合わなかった」で、経路は生きている |
 * | `kind='config'`（{@link BuildNotConfigured}） | 資格情報が揃っていない配備の誤りで、AWS へ 1 度も届いていない。**窓と閾値で測るものではない**（1 件目から全件が同じ理由で落ちる） |
 * | ビルド以外の失敗（D1 の不調・想定外の例外） | {@link BuildFailure} ですらない。**ここを緩めると issue #140 がいちばん恐れている誤爆になる** |
 *
 * **最後の行がこのモジュールの核である。** D1 の不調は `BuildFailure` を作らないので、
 * {@link isBuildPathFailure} は**型として** false を返す。「気をつけて分類する」ので
 * はなく、**分類できる形になっていない**（shared-ai-rules 12 章）。
 *
 * ## 窓と閾値（誤爆のコストは見逃しより高い）
 *
 * #140 の constraints は「停止の判定が誤ると『生成できるのにボタンが無い』状態を作る。
 * 4.4 が無くそうとしている『押しても動かないボタン』の裏返しであり、**誤爆のコストは
 * 見逃しより高い**」と定める。値はこの非対称性から決めた。根拠は
 * {@link BUILD_STOP_FAILURE_THRESHOLD} と {@link BUILD_STOP_WINDOW_SECONDS} にある。
 *
 * ## D1 の書き込みを増やさない（3.6）
 *
 * 生成 1 回あたりの書き込みは **1 行も増えない。** 形と、その形を選んだ理由は
 * `migrations/0010_build_health.sql` にある。**「増えないはず」を言葉で担保しない**
 * ——{@link clearBuildPathFailures} が返す行書き込み数を `test/build-health.test.ts`
 * が読む。
 *
 * ## プレイ側に触らない（3.8 の degrade 設計の核）
 *
 * この表を読むのは生成画面だけである。配信側（`src/sandbox-delivery.ts`）と作品ページは
 * この信号を知らない。**知らないことが、3.8 の「プレイ側には一切影響を出さない」の
 * 実装である。**
 */
import { BuildFailure } from './build-client.js';

/**
 * 停止とみなすのに要る、**失敗した生成依頼の件数**（1 依頼 1 件）。
 *
 * # なぜ 2 なのか
 *
 * **1 にしない。** 確定24 の停止事象は「1 人の要求からは読み取れないもの」であり、
 * 1 件で発火する信号は #24 の近似（自分の要求の 5xx を見る）と同じ観測力しか持たない。
 * それでいて**影響範囲だけがサービス全体へ広がる**——1 人が踏んだ一過性の失敗で、
 * 他の全員から送信フォームが消える。**誤爆のコストが見逃しより高い以上、ここは
 * 最初に締める場所である。**
 *
 * **3 以上にしない。** 4.3 の逆算どおり、サービス全体の生成は 1 日あたり約 29.7 回
 * （#284 で 34 回から引き直した）、すなわち **1 時間に 1.2 回**である。窓を
 * {@link BUILD_STOP_WINDOW_SECONDS}（15 分）に取ると、その窓に入る依頼はそもそも
 * 平均 **0.31 件**しかない。3 件を求める信号は**障害が起きても発火しない**
 * ——「誤爆しない」ではなく「何も検知しない」であり、見逃しの側へ倒し切ることになる。
 * **#284 で母数が減ったぶん、この理由はむしろ強くなった**（0.35 → 0.31 件）。
 *
 * **ただし 1 依頼の所要時間は #284 で大きく伸びた。** 最悪ケースは 583 秒（9.7 分。
 * 窓の 65%）から **829 秒（13.8 分。窓の 92%）** になっている
 * （`scripts/check-orchestrator-retry.sh` が計算する値。生成 297 秒 × 2 試行 ＋ ビルド
 * ＋ 余裕）。**しきい値 2 の根拠は「窓に入る依頼の数」なので変わらない**が、
 * **1 人が順に 2 回踏んで発火させるには、もう 1 つの窓へまたぐ**——下の「残る隙間」は
 * その分だけ狭まっている。**逆に、窓を縮めると 1 依頼すら収まらなくなる。**
 *
 * **2 は「1 要求からは読み取れない」を満たす最小の値である。** 最小にしたのは、
 * 大きくすることで買えるのが確度ではなく**沈黙**だからである。
 *
 * # 残る隙間を隠さない
 *
 * 2 件は**同じ利用者の 2 回の依頼**でも成立する。したがって「特定の入力でだけ関数が
 * 落ちる」不具合（たとえばソースの大きさに依る OOM）を、その人が 2 回踏むと発火する。
 * **利用者を跨ぐことまで求めれば塞げるが、上の traffic では発火しなくなる。**
 * この隙間は次の 2 つで受けている。
 *
 *   - 発火しても**プレイと共有は一切変わらない**（3.8）。失うのは 15 分の生成だけである
 *   - 窓が切れれば自動で戻る（下記）
 */
export const BUILD_STOP_FAILURE_THRESHOLD = 2;

/**
 * 失敗を数える窓（秒）。**15 分。**
 *
 * # 窓は「事実を確かめ直す間隔」でもある
 *
 * 停止を出すと生成画面は送信フォームを描かない（`src/generate-page.ts` の `canSubmit`）。
 * **つまり停止中は新しいビルド依頼が発生しないので、成功で信号がほどけることは無い。**
 * {@link clearBuildPathFailures} は本当の復帰を早めるが、**停止中の唯一の復帰経路は
 * 窓が切れることである。**
 *
 * したがって窓は**誤爆が続く最大時間**そのものであり、短いほどよい。15 分は
 * 「誤って出した停止が最大 15 分で自動的に解ける」ことを意味する。
 *
 * # それでも短すぎない
 *
 * 窓を短くしすぎると閾値へ届かない。**障害中の 2 件目は他人を待つとは限らない**
 * ——生成の実測は 1 回 90 秒台で（1.2.38）、失敗は作品ページとメールで作者へ届く
 * （#153）。踏んだ人が投げ直すまでの現実的な間隔（数分）に対して、15 分は 2 件目を
 * 拾える幅がある。
 *
 * # 長い障害では点滅する。それでよい
 *
 * 障害が 15 分より長く続くと、窓が切れる → フォームが戻る → 誰かが踏む →
 * また 2 件たまる、という周期になる。**これは欠陥ではなく、値を選んだ理由そのもの
 * である**——画面は現実を推定し続けるのではなく、**実際の依頼で確かめ直す。**
 * 代償は障害 15 分あたり最大 2 件（約 32〜38 円）で、**その代償を払わない設計は
 * 「復帰したことを永久に知れない設計」と同じものである。**
 */
export const BUILD_STOP_WINDOW_SECONDS = 15 * 60;

/**
 * その失敗を「ビルド依頼そのものの失敗」と数えるか（確定24）。
 *
 * **`kind` で見る。** `instanceof BuildFunctionFailed` を並べても同じことになるが、
 * 種別で分岐する形は `src/build-client.ts` が `kind` を用意した理由そのものであり、
 * 種別が増えたときに**ここを直し忘れても分類が壊れない**（新しい `kind='function'` は
 * 自動的に数えられ、それ以外は自動的に数えられない）。
 *
 * **例外の綴りを見ない。** メッセージや `name` で判定する形にすると、8.3 の対象である
 * 生成物由来の文字列が判定へ混ざる経路ができる。
 *
 * @param error catch した値（型は unknown）
 * @returns ビルド依頼そのものが失敗していれば true
 */
export function isBuildPathFailure(error: unknown): boolean {
  return error instanceof BuildFailure && error.kind === 'function';
}

/**
 * ビルド依頼の失敗を 1 件記録する。
 *
 * **投げない。** これは信号であって結末の記録ではない。ここで投げると `finish`
 * コールバックが 500 になり、オーケストレータが**同じ結末をもう一度届けにくる**
 * （`src/orchestrator/callbacks.ts` は 5xx を再送する）。**利用者から見える状態
 * （`games` 行）は既に確定しているので、それを信号のために巻き戻さない。**
 *
 * **古い行はここで落とす。** 掃除のためだけに別の書き込み経路を作らないためで、
 * この関数はもともと「失敗したときにしか呼ばれない」（＝平常時は 1 度も走らない）。
 *
 * @param env バインディングと環境変数
 * @param gameId 失敗した生成依頼（`games.id`）
 * @param at 記録する時刻（UNIX 秒）
 */
export async function recordBuildPathFailure(env: Env, gameId: string, at: number): Promise<void> {
  try {
    await env.DB.batch([
      // 窓から出た行を落とす。**信号は「いま」しか意味を持たない。**
      env.DB.prepare('delete from build_health where failed_at < ?').bind(
        at - BUILD_STOP_WINDOW_SECONDS,
      ),
      // **`or ignore` にする。** 重複配信で同じ `finish` が 2 回届いても、件数も
      // 時刻も動かさない（最初に失敗した時刻が正しい）。
      env.DB.prepare('insert or ignore into build_health (game_id, failed_at) values (?, ?)').bind(
        gameId,
        at,
      ),
    ]);
  } catch (error) {
    // **種別だけを出す。** 利用者のプロンプトも生成物もここには無い（`src/quota.ts` の
    // `readForDecision` と同じ方針）。
    console.error(
      `[build-health] 停止信号を記録できませんでした: ${
        error instanceof Error ? error.name : typeof error
      }`,
    );
  }
}

/**
 * 記録済みの失敗をすべて捨てる（＝ビルド経路が生きていることが分かった）。
 *
 * **呼ぶのは「ビルド関数を実際に呼んで成功した」ときだけである。** キャッシュヒットは
 * 関数を呼ばないので、経路が生きている証拠にならない（判定の材料は
 * `src/generate-callback.ts` にある）。
 *
 * **平常時は表が空なので、削除は 0 行である。** D1 が数える行書き込みも 0 で、
 * 3.6 が避けよと言う「リクエスト毎の書き込み」にならない。戻り値はその事実を
 * テストから読むためにある。
 *
 * **投げない**（{@link recordBuildPathFailure} と同じ理由。信号のために結末の記録を
 * 巻き戻さない）。
 *
 * @param env バインディングと環境変数
 * @returns D1 が数えた行書き込み数（読めなければ null）
 */
export async function clearBuildPathFailures(env: Env): Promise<number | null> {
  try {
    const result = await env.DB.prepare('delete from build_health').run();
    const written = result.meta.rows_written;
    return typeof written === 'number' ? written : null;
  } catch (error) {
    console.error(
      `[build-health] 停止信号を消せませんでした: ${
        error instanceof Error ? error.name : typeof error
      }`,
    );
    return null;
  }
}

/**
 * いまビルド経路が止まっているとみなすか（3.8）。
 *
 * **読めなかったら「止まっていない」を返す。** #140 の acceptance が明示的に求めて
 * いるのは「**D1 の不調では出ない**」ことであり、その D1 にはこの表自身も含まれる。
 * 読めないことを停止の証拠にすると、**degrade の信号そのものが D1 障害の増幅器**に
 * なる（4.4 が無くそうとしている「生成できるのにボタンが無い」状態を、D1 が 1 回
 * 揺れるたびに作る）。
 *
 * **`src/quota.ts` の `readForDecision` と逆に倒している。** あちらは費用の出る
 * 判断なので「迷ったら止まる側」だが、ここは**止めるかどうかの判断**であり、迷った
 * ときに止めるのは安全側ではない。
 *
 * @param env バインディングと環境変数
 * @param at 判定する時刻（UNIX 秒）
 * @returns 停止とみなすなら true
 */
export async function buildPathStopped(env: Env, at: number): Promise<boolean> {
  try {
    const row = await env.DB.prepare(
      'select count(*) as failures from build_health where failed_at >= ?',
    )
      .bind(at - BUILD_STOP_WINDOW_SECONDS)
      .first<{ failures: number }>();
    const failures = row?.failures ?? 0;
    return failures >= BUILD_STOP_FAILURE_THRESHOLD;
  } catch (error) {
    console.error(
      `[build-health] 停止信号を読めませんでした: ${
        error instanceof Error ? error.name : typeof error
      }`,
    );
    return false;
  }
}
