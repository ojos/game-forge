/**
 * ソースサイズ 30KB 上限の境界と、そこでの振る舞いの判定（確定18 / 5.3 / 6.1 / M5-2 / #33）。
 *
 * # なぜ判定を独立したモジュールにするのか
 *
 * **上限そのものは `src/system-prompt.ts` の `MAX_SOURCE_BYTES` が正本である**
 * （6.1 がプロンプトへ数値を書き込むので、値はあそこに在るのが自然である）。
 * ここが持つのは**値ではなく境界の読み方**——「何バイトから警告するか」「超過を
 * どう数えるか」「作者の同意が要るのはどの帯か」——であり、値と読み方は別々に変わる。
 *
 * 読み方が 2 か所に散ると、片方だけが `>` と `>=` を取り違えたときに**どちらも
 * 落ちない**（shared-ai-rules 12 章）。実際 `src/source-store.ts` は同じ比較を 2 回
 * 書いており、そこもこのモジュールへ寄せた。
 *
 * # 確定18 の 4 条件のうち、ここが持つのは 1 と 2 の「問い」までである
 *
 * 5.3 は 30KB 超過時に「作者の選択で LLM に整理させる」と定め、4 条件を課している。
 *
 * | # | 条件 | いまどこに在るか |
 * |---|---|---|
 * | 1 | 24KB（上限の 80%）を超えていたら**入力段階で事前警告する** | **{@link decideForkSizeAction} の `warn`**（`src/fork.ts` が画面にする） |
 * | 2 | 整理は自動実行せず**作者が明示的に選ぶ** | 問いの手前まで。**整理そのものは動かせない**（下記） |
 * | 3 | **整理は 1 回まで。** 整理後も超えたら拒否 | **未実装**（下記） |
 * | 4 | 整理パスのコンパイル失敗で**自動リトライしない。元へ戻して拒否** | **未実装**（下記） |
 *
 * ## 整理パスがこの層で動かせない理由（#33 で判明した。2 つとも構造的である）
 *
 * 1. **エッジは Bedrock を呼べない。** 長命の AWS 鍵は `BUILD_AWS_*` の 1 組だけで、
 *    `BEDROCK_AWS_*` は #160 で削除された。**整理は「全文再出力の LLM 呼び出し」なので、
 *    オーケストレータ Lambda の中でしか走らない。**
 * 2. **オーケストレータへ渡す本文が、上限超のソースを断る。**
 *    `src/orchestrator/payload.ts` は `baseSource` が `MAX_SOURCE_BYTES` を超えていたら
 *    ペイロードごと拒否する。**整理の入力はまさに上限超のソースである**——上限を守る
 *    ための検査が、5.3 が定めた逃げ道の入口をふさいでいる。
 *
 * さらに条件 3 の「1 回まで」は、生成がコールバックで戻る非同期経路をまたいで残る必要が
 * あり、`games` の列（＝マイグレーション）を要求する。**この 3 点はいずれも本 issue の
 * 所有ファイルの外にあるため、ここでは継ぎ目も置かない**（「使われない段を先に作らない」。
 * 4.2 の #20 注記）。**空の関数を置くと、整理が実装されたと読める。**
 *
 * # 拒否だけにしてはいけない（5.3 の意図）
 *
 * 5.3 は「拒否のみは採らない」理由を、10.3 の撤退条件（「3 世代以上の系統が 1 本も
 * 出ていない」）に置いている。**システムが構造的に世代数を制限すると、自分で立てた
 * 撤退条件を自分の実装で不成立にしうる。** したがって条件 1 の事前警告は
 * 「フォークをやめさせる」ためのものではない——**枠を余分に使う可能性を、使う前に
 * 知らせる**ためのものである。文言と選択肢を作るときにここを取り違えないこと。
 */
import { MAX_SOURCE_BYTES } from './system-prompt.js';

export { MAX_SOURCE_BYTES };

/**
 * 事前警告を出す割合（確定18 の条件 1）。
 *
 * **5.3 が「24KB＝上限の 80%」と、値と導出の両方を書いている。** 24576 を直接書かず
 * 割合から導くのは、上限が動いた日に警告だけが取り残されないためである
 * （`test/source-size.test.ts` が 24 * 1024 と一致することを見る）。
 */
export const SOURCE_SIZE_WARNING_RATIO = 0.8;

/**
 * 上限から事前警告の閾値を導く。
 *
 * **切り下げる。** バイト数は整数であり、しかも**作者の画面へそのまま出る値**である
 * （`src/fork.ts` の警告画面）。`* 0.8` は二進小数なので、上限によっては
 * `25395.2` のような端数を作る——いまの 30,720 では割り切れるが、**上限が動いた日に
 * 画面へ小数が出る**（#255 のレビュー指摘。指摘そのものは正しく、ただし挙げられた
 * 例（現在値が端数になる）は外れていた。実測して確かめた）。
 *
 * **端数は警告を早める側へ倒す。** 条件 1 は「知らせる」ためのもので、1 バイト早く
 * 知らせても失うものが無い。
 *
 * @param limitBytes 上限のバイト数
 * @returns 警告を始めるバイト数（**これを超えたら**警告する）
 */
export function warningBytesFor(limitBytes: number): number {
  return Math.floor(limitBytes * SOURCE_SIZE_WARNING_RATIO);
}

/** 事前警告を出すバイト数（**これを超えたら**警告する。24KB）。 */
export const SOURCE_SIZE_WARNING_BYTES = warningBytesFor(MAX_SOURCE_BYTES);

/**
 * ソースのバイト数を測る。
 *
 * **文字数ではなくバイト数である。** 上限の出どころ（6.1 のプロンプト、
 * `src/orchestrator/payload.ts` のペイロード上限）がどちらもバイトで、日本語の
 * コメントが入ると 1 文字 3 バイトになる。
 *
 * @param source Go のソース
 * @returns UTF-8 でのバイト数
 */
export function measureSourceBytes(source: string): number {
  return new TextEncoder().encode(source).length;
}

/**
 * サイズの帯。
 *
 * - `within` … 24KB 以下。何も言わない
 * - `near-limit` … 24KB 超 30KB 以下。**改造はできるが、事前警告する**（条件 1）
 * - `over-limit` … 30KB 超。**そのままでは改造できない**
 */
export type SourceSizeVerdict = 'within' | 'near-limit' | 'over-limit';

/**
 * バイト数を帯へ落とす。
 *
 * **境界はどちらも「超えたら」である**（`>`。`>=` ではない）。5.3 は上限を
 * 「30KB 以内に収める」、警告を「24KB を超えていたら」と書いており、**ちょうどの値は
 * どちらも収まっている側**である。`src/source-store.ts` が上限ちょうどのソースを
 * 読むこと（`test/source-store.test.ts`）と、同じ 1 つの判断になる。
 *
 * @param bytes 測ったバイト数
 * @returns 帯
 */
export function classifySourceBytes(bytes: number): SourceSizeVerdict {
  if (bytes > MAX_SOURCE_BYTES) {
    return 'over-limit';
  }
  if (bytes > SOURCE_SIZE_WARNING_BYTES) {
    return 'near-limit';
  }
  return 'within';
}

/**
 * 作者が事前警告に対して示した同意（確定18 の条件 1・2）。
 *
 * - `none` … まだ何も示していない（最初の要求）
 * - `proceed` … 警告を読んだうえで「このまま改造する」を選んだ
 *
 * **`tidy`（整理する）という値をまだ持たない。** 条件 2 は「作者が明示的に選ぶ」ことを
 * 求めるが、選ばせた先の整理が動かせない以上（モジュール冒頭）、**押せるが何も起きない
 * 選択肢を作らない。** 値を先に足しておくと、判定だけが「整理を選べる」形になり、
 * 実装されたと読める。
 */
export type SizeConsent = 'none' | 'proceed';

/**
 * フォークの入力段階での振る舞い（確定18 の条件 1）。
 *
 * - `proceed` … そのまま改造してよい
 * - `warn` … **事前警告して、作者の同意を取る**（枠はまだ使わない）
 * - `refuse` … 上限超。そのままでは改造できない
 */
export type ForkSizeAction = 'proceed' | 'warn' | 'refuse';

/**
 * 親ソースの大きさから、フォークの入力段階の振る舞いを決める（確定18 の条件 1）。
 *
 * **同意は `near-limit` の帯にしか効かない。** `over-limit` は作者が何を選んでも
 * 通らない——通してしまうと `src/orchestrator/payload.ts` がペイロードごと拒否し、
 * **作品行だけが `pending` で残る**（`src/fork.ts` が「行を作るのはソースを読み切った
 * あと」と書いているのは、まさにこの形を避けるためである）。
 *
 * **警告は 1 度でよい。** 同意を持って戻ってきた要求を再び警告すると、作者は同じ画面を
 * 往復するだけで先へ進めない。
 *
 * @param input 測ったバイト数と、作者が示した同意
 * @returns 入力段階の振る舞い
 */
export function decideForkSizeAction(input: {
  readonly bytes: number;
  readonly consent: SizeConsent;
}): ForkSizeAction {
  const verdict = classifySourceBytes(input.bytes);
  if (verdict === 'over-limit') {
    return 'refuse';
  }
  if (verdict === 'near-limit' && input.consent !== 'proceed') {
    return 'warn';
  }
  return 'proceed';
}
