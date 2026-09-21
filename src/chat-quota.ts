/**
 * チャットの枠（#695 / M18-2。仕様 5.16「枠——チャットの費用が生成の予算を食わないようにする」）。
 *
 * ## 2 段で、当たっても生成は止まらない
 *
 * **4.3 の役割分担（日次＝1 人あたりの蓋 / 月次＝総額）をそのまま写したものである**（利用者の決定）。
 *
 * | 段 | 値 | 当たったときに止まるもの |
 * |---|---|---|
 * | 1 人 1 日 | {@link CHAT_DAILY_COST_LIMIT_JPY} 円 | **その人のチャットだけ。** 生成は動く |
 * | チャットの当月累計 | {@link CHAT_MONTHLY_COST_LIMIT_JPY} 円 | **全員のチャットだけ。** 生成は動く |
 *
 * **確定25 の日次 10 回は 1 回も減らさない**（`src/quota.ts` の `dailyCallCount` が
 * `kind = 'generation'` で絞る）。5.7 がリフォージで日次枠を共有したのとは逆の判断で、
 * **理由は 1 往復の額が 1 桁小さいこと**（**実測 0.64 円 対 ¥22.41**。2026-09-20 の本番の 9 往復。5.16）である。
 *
 * ## 往復数でもトークン数でもなく、円で数える（#751）
 *
 * **ソースを渡すかどうかで 1 往復の重さが 5 倍以上変わる**（利用者の決定。5.16）ので、往復数では
 * 数えない——重い往復と軽い往復が同じ 1 になり、蓋が費用に対応しない。
 *
 * **#751 までは `usage` の 4 項目を重みなしで足したトークン数（1 日 30,000）で数えていた。**
 * 単価 1/10 のキャッシュ読みも新しい入力と同じだけ枠を減らすので、**履歴をキャッシュに乗せても
 * 利用者の足切りが減らない**（#749 の会話では 3 往復・1.93 円で 28,205 / 30,000 まで減った）。
 * **いまは台帳の `cost_jpy` を `kind = 'chat'` で 1 日合計して、{@link CHAT_DAILY_COST_LIMIT_JPY} と比べる。**
 * 単価の違いは台帳の円換算（`src/cost-ledger.ts` の `convertUsageToJpy`）が既に持っており、
 * **ここで重みを書き写さない。**
 *
 * ## 4.3 の月次 2 万円も、そのまま効く
 *
 * **チャットも 4.3 の内側にいる**（5.16）。サービス全体が止まっているときにチャットだけ動くと、
 * **止めた理由（総額）が守られない。** したがって判定は 3 つを順に見る。
 *
 * ## 判定は要求の手前で 1 回だけ行い、予約はしない
 *
 * **4.3 と同じ形である**（`src/quota.ts`「逐次でも 1 回だけはみ出す」）。台帳の行は Bedrock の
 * 応答が返ってから入るので、**判定を通った要求が、判定後に枠を使う。** 予約による厳密化は
 * 採らない（#455 の scope.out と同じ判断）。
 *
 * **ただし、上振れは 2 つに分けて縛る。**
 *
 * 1. **1 回の要求そのものが残りを超えないようにする**（{@link estimateChatCostJpy}）。**これが無いと、
 *    残りが 1 銭でも満額の往復が通る**——64 KiB のソースを渡す往復は短い発話でも見積もりが約 ¥17 で、
 *    会話が上限いっぱいなら **1 日の蓋（¥20）を単独で超える。** 見積もりは高い側へ倒す（4.3 の「迷う側は高い側へ倒す」）。
 * 2. **同時に判定を通った要求の上振れは、関数の予約同時実行数が縛る**（`terraform/chat-function.tf` の
 *    `chat_function_reserved_concurrency` ＝ 2）。枠を超えて走れるのは**同時に走れる本数まで**で、
 *    **あふれた要求は Lambda が 429 で断り、課金も台帳の行も出ない**（`src/chat-client.ts` の `ChatBusy`）。
 *    最大の往復 2 本ぶんで **約 38 円**、チャットの当月の取り分（2,000 円）の **1.9%** である。
 *    **締めたくなったら、増やすつまみではなく、この予約同時実行数を下げる。**
 *
 * ## 数えるのは台帳の行である（別の表を持たない）
 *
 * **上限を見る文そのもので数える**（`0048` が採った形。3.6 の「リクエストごとに書かない」）。
 * チャットは 1 往復につき `generations` へ 1 行を積むので、**数える対象は既にそこにある。**
 * 別のカウンタを置くと、台帳と数えている値が食い違う経路ができる。
 */
import { CHAT_MAX_OUTPUT_TOKENS } from './chat-payload.js';
import { renderChatPromptText } from './chat-prompt.js';
import {
  CHAT_KIND,
  convertUsageToJpy,
  jstMonthRange,
  monthlyCostTotals,
  type MonthlyCostTotals,
} from './cost-ledger.js';
import { DEFAULT_GENERATION_MODEL_KEY, findGenerationModel } from './generation-models.js';
import { MONTHLY_COST_LIMIT_JPY, MONTHLY_LIMIT_REASON, jstDayRange } from './quota.js';

/**
 * 1 人 1 日にチャットで使える額（円。仕様 5.16。利用者の決定。#751）。
 *
 * **4.3 と同じ形で逆算した値である。**
 *
 *   ¥20/人・日 × **3 人**（4.3 と同じ想定）× 30 日 ＝ ¥1,800
 *
 * として {@link CHAT_MONTHLY_COST_LIMIT_JPY}（¥2,000）の内側に収める。**2 つの値は独立ではない**
 * ——片方だけを動かすと逆算が合わなくなる。**関係は `test/chat.test.ts` が照合する**
 * （ここで式に書かない。#742 で、式で書いただけでオーケストレータの束が変わった）。
 *
 * **#751 までは 1 日 30,000 トークンだった**（トークンの重みなし合計。モジュール冒頭）。
 * 30,000 トークンはキャッシュが効かない単価で ¥20 に当たるように引いた値で、**額の蓋としては
 * 変えていない**——変わったのは数え方で、キャッシュ読みが単価どおり 1/10 で減るようになった。
 *
 * 仕様書側の記載との一致は `test/chat.test.ts` が {@link CHAT_DAILY_COST_PATTERN} で
 * 機械照合する（`src/quota.ts` の `MONTHLY_LIMIT_PATTERN` と同じ理由——同じ数値が 2 か所に
 * ある以上、呼びかけでは守れない）。
 */
export const CHAT_DAILY_COST_LIMIT_JPY = 20;

/**
 * チャットに割り当てた当月の取り分（円。仕様 5.16。利用者の決定）。
 *
 * **4.3 の月次上限 2 万円の 10% である。** 4.3 の判定は今までどおり台帳の全部を合算する
 * （総額にはチャットも効く）ので、**これはその内側にもう 1 枚だけ置く蓋**である。
 *
 * **当たっても生成は止まらない。** それが #695 の constraints（「チャットの費用が生成の予算を
 * 食わないよう、別枠で止まる」）に真っ向から答える唯一の形である。
 */
export const CHAT_MONTHLY_COST_LIMIT_JPY = 2_000;

/**
 * ソースの見積もりに使う「1 トークンあたりのバイト数」。
 *
 * **高い側へ倒した値である。** Go のソースは ASCII が主で実際は 1 トークン 3.5〜4 バイト前後だが、
 * **3 で割る**——見積もりが実測より小さいと、蓋を越えた要求が通る。**過大に見積もると断るだけ**で、
 * 断られた利用者はソースを外すか翌日に回せる（4.3 の「迷う側は必ず高い側へ倒す」と同じ向き）。
 */
export const CHAT_SOURCE_BYTES_PER_TOKEN = 3;

/**
 * 1 往復にかかる額を、呼ぶ前に見積もる（円。#751 で `estimateChatTokens` から置き換えた）。
 *
 * **高い側へ倒す**（4.3 の「迷う側は必ず高い側へ倒す」）。過大に見積もると断るだけで、断られた
 * 利用者はソースを外すか翌日に回せる。**過小に見積もると、残りを超える往復が通る。**
 *
 * - **入力はキャッシュが効かない前提で数える。** 単価は入力とキャッシュ書き込みの**高いほう**である
 *   ——区切りの手前が初めて読まれる往復は、キャッシュ読みではなく書き込み（入力の 1.25 倍）で課金される。
 * - **日本語は 1 文字 1 トークンとして数える。** 実際の Claude のトークナイザは日本語で 1 文字あたり
 *   1 トークン前後で、ASCII ではもっと少ない。**少ないほうへ倒さない。**
 * - **出力は上限で数える**（{@link CHAT_MAX_OUTPUT_TOKENS}）。**呼ぶ前に分かるのは上限だけ**である。
 * - **単価はチャットのモデルの登録簿から引く**（数値を書き写さない。円換算も台帳と同じ
 *   `convertUsageToJpy` を通す）。チャットのモデルは生成の既定の鍵である（`src/chat/handler.ts` の
 *   `CHAT_MODEL_KEY`。Lambda の束をエッジから import しないので、同じ値を元から引く）。
 *
 * @param input 会話と、文脈に載せるソース
 * @returns 見積もった額（円）
 */
export function estimateChatCostJpy(input: {
  /** 会話の全文（文字数で数える。ルールを含む）。 */
  readonly messageCharacters: number;
  /** 文脈に載せるソースのバイト数（載せないなら 0）。 */
  readonly sourceBytes: number;
}): number {
  const model = findGenerationModel(DEFAULT_GENERATION_MODEL_KEY);
  if (model === null) {
    // 既定の鍵が登録簿から消えた状態。**0 円に倒さない**（倒すと蓋が黙って開く）。
    throw new Error(`[chat] 登録簿に既定の鍵がありません: ${DEFAULT_GENERATION_MODEL_KEY}`);
  }
  const inputTokens =
    // システムプロンプト（会話が伸びても変わらない）。**本文から数える**ので、
    // プロンプトを書き足した日に見積もりも動く。
    [...renderChatPromptText()].length +
    input.messageCharacters +
    Math.ceil(input.sourceBytes / CHAT_SOURCE_BYTES_PER_TOKEN);
  const pricing = model.pricing;
  return convertUsageToJpy(
    {
      ...pricing,
      inputUsdPerMillion: Math.max(pricing.inputUsdPerMillion, pricing.cacheWriteUsdPerMillion ?? 0),
    },
    {
      inputTokens,
      outputTokens: CHAT_MAX_OUTPUT_TOKENS,
      cacheReadInputTokens: 0,
      cacheWriteInputTokens: 0,
    },
  ).totalJpy;
}

/**
 * 残りの額を、画面に出す「今日の残り NN%」へ直す（#751）。
 *
 * **円もトークンも利用者に見せない**（利用者の決定）。**切り捨てる**——多く見せると、
 * 「まだ残っている」と見えた往復が見積もりで断られる。0〜100 に収める。
 *
 * @param remainingJpy 本日の残り（円。負でもよい）
 * @returns 残りの割合（整数の百分率）
 */
export function chatRemainingPercent(remainingJpy: number): number {
  const ratio = Math.max(0, Math.min(remainingJpy, CHAT_DAILY_COST_LIMIT_JPY)) / CHAT_DAILY_COST_LIMIT_JPY;
  return Math.floor(ratio * 100);
}

/**
 * 仕様書が 1 人 1 日の額を宣言している文の形（テストが照合に使う）。
 *
 * **表の形（`| **1 人 1 日** | **¥20** |`）も拾う。** 4.3 には生成の枠の試算で「1 人 1 日 ¥6,230」という
 * 別の話の文があるので、**テストは 5.16 の節の中だけへ当てる。** トークンで宣言する文が残っていない
 * ことは、別の形で照合する（`test/chat.test.ts`）。
 */
export const CHAT_DAILY_COST_PATTERN =
  /1 ?人 ?1 ?日 ?\*{0,2}(?: ?\| ?\*{0,2})? ?[¥￥]([0-9]{1,3}(?:,[0-9]{3})*)/gu;

/** 仕様書がチャットの当月の取り分を宣言している文の形（テストが照合に使う）。 */
export const CHAT_MONTHLY_LIMIT_PATTERN =
  /(?:当月)?(?:累計|取り分) ?\*{0,2}([0-9]{1,3}(?:,[0-9]{3})*) ?円/gu;

/**
 * 1 人 1 日の枠で止まったことを表す分類名。**利用者への文言ではない。**
 *
 * **綴りは「トークン」のままである**（#751 で枠を円へ移したが、変えない）。開いたままの古い画面が
 * この綴りで文言を引くので、変えると枠切れが「チャットできませんでした」に化ける。
 *
 * **`daily-quota`（確定25）と分ける。** あちらは生成の枠で、**こちらが当たっても生成はできる。**
 * 混ぜると、画面が「本日の生成枠は終了しました」と誤って言う。
 */
export const CHAT_DAILY_TOKENS_REASON = 'chat-daily-tokens' as const;

/**
 * チャットの当月の取り分で止まったことを表す分類名。**利用者への文言ではない。**
 *
 * **`monthly-limit`（4.3）と分ける。** あちらはサービス全体の停止で、生成も止まっている。
 * こちらは**チャットだけが止まっていて、生成はできる。**
 */
export const CHAT_MONTHLY_LIMIT_REASON = 'chat-monthly-limit' as const;

/** チャットを断る分類名。 */
export type ChatQuotaRejectionReason =
  | typeof CHAT_DAILY_TOKENS_REASON
  | typeof CHAT_MONTHLY_LIMIT_REASON
  | typeof MONTHLY_LIMIT_REASON;

/**
 * 応答へ載せてよい分類名の全体。
 *
 * **画面の文言表は、この一覧に対する網羅を機械で検査する**（`src/quota.ts` の
 * `QUOTA_REJECTION_REASONS` と同じ形）。理由を増やして文言を足し忘れると落ちる。
 */
export const CHAT_QUOTA_REJECTION_REASONS: readonly ChatQuotaRejectionReason[] = [
  MONTHLY_LIMIT_REASON,
  CHAT_MONTHLY_LIMIT_REASON,
  CHAT_DAILY_TOKENS_REASON,
];

/** いまのチャットの枠の状態。 */
export type ChatQuotaStatus =
  | {
      readonly kind: 'available';
      /** 本日（JST）の残り（円）。**必ず 0 より大きい。** */
      readonly remainingJpy: number;
      /** 枠が戻る時刻（UNIX 秒）。JST の翌 0 時。 */
      readonly resetsAt: number;
    }
  | {
      readonly kind: typeof CHAT_DAILY_TOKENS_REASON;
      /** 枠が戻る時刻（UNIX 秒）。JST の翌 0 時。 */
      readonly resetsAt: number;
    }
  | { readonly kind: typeof CHAT_MONTHLY_LIMIT_REASON }
  | { readonly kind: typeof MONTHLY_LIMIT_REASON };

/**
 * ある利用者が、その暦日（JST）にチャットで使った額を数える（円。#751）。
 *
 * **成否を問わない**（4.3 の「成否で絞らない」と同じ）。断られた返答にも `usage` は出ており、
 * 課金は発生している。**Guardrail で止めた回だけは LLM を呼んでいないので行が無い**（5.16）。
 *
 * **数えるのは台帳の `cost_jpy` である**（単価の重みは台帳の円換算が持つ。モジュール冒頭）。
 *
 * 索引は `generations(user_id, created_at)`（`migrations/0005_*`）。`kind` は絞った残りを
 * 弾くだけなので、索引を足していない（`migrations/0049_chat.sql`）。
 *
 * @param env バインディングと環境変数
 * @param userId 数える利用者
 * @param at 基準時刻（UNIX 秒）
 * @returns 当日（JST）の額と、枠が戻る時刻
 */
export async function chatDailyCostJpy(
  env: Env,
  userId: string,
  at: number,
): Promise<{ readonly costJpy: number; readonly resetsAt: number }> {
  const day = jstDayRange(at);
  // **`sum` は行が無いと NULL を返す。** `coalesce` を SQL 側で被せる（`monthlyCostTotals`
  // と同じ理由——JS 側で `?? 0` にすると、行が無い経路と列が NULL の経路が同じ形になる）。
  const row = await env.DB.prepare(
    `select coalesce(sum(cost_jpy), 0) as cost_jpy
       from generations
      where user_id = ? and created_at >= ? and created_at < ? and kind = ?`,
  )
    .bind(userId, day.fromSeconds, day.toSeconds, CHAT_KIND)
    .first<{ cost_jpy: number }>();
  return { costJpy: row?.cost_jpy ?? 0, resetsAt: day.toSeconds };
}

/**
 * チャットが当月（JST）に使った費用の累計。
 *
 * **範囲の定義は {@link jstMonthRange} から取る**（`monthlyCostTotals` と同じ「当月」である
 * ことを、写しではなく共有で担保する。`src/quota.ts` の「累計はここで数え直さない」と同じ規律）。
 *
 * @param env バインディングと環境変数
 * @param at 基準時刻（UNIX 秒）
 * @returns 当月のチャットの費用（円）
 */
export async function chatMonthlyCostJpy(env: Env, at: number): Promise<number> {
  const range = jstMonthRange(at);
  const row = await env.DB.prepare(
    `select coalesce(sum(cost_jpy), 0) as cost_jpy
       from generations
      where created_at >= ? and created_at < ? and kind = ?`,
  )
    .bind(range.fromSeconds, range.toSeconds, CHAT_KIND)
    .first<{ cost_jpy: number }>();
  return row?.cost_jpy ?? 0;
}

/**
 * いまのチャットの枠の状態を求める。**判定と表示の両方がここから読む。**
 *
 * **止まったら先を読まない**（`src/quota.ts` の `generationQuotaStatus` と同じ規律。
 * **D1 は読み取りも従量である**——止まっている間ほど無駄な読み取りが積み上がる）。
 * 順序は「広い停止から先に」である。
 *
 * 1. **4.3 の月次 2 万円**（サービス全体。生成も止まっている）
 * 2. **チャットの当月の取り分**（チャットだけが止まる）
 * 3. **1 人 1 日の額**（その人のチャットだけが止まる）
 *
 * **全体の月次は写さず、`monthlyCostTotals` をそのまま呼ぶ。** チャット用にもう 1 本 SQL を
 * 書けば読み取りは 1 回減るが、**「4.3 の総額とは何か」の定義が 2 か所になる**——
 * 数える対象を変えた日に、チャットの経路だけが古い定義で動く。
 *
 * @param env バインディングと環境変数
 * @param userId 対象の利用者
 * @param at 判定時刻（UNIX 秒。既定は現在時刻）
 * @returns 枠の状態。チャットできるときは残りの額を伴う
 * @throws 集計を読めなかったとき（握りつぶさない。`src/quota.ts` の `readForDecision` と同じ判断）
 */
export async function chatQuotaStatus(
  env: Env,
  userId: string,
  at: number = Math.floor(Date.now() / 1000),
): Promise<ChatQuotaStatus> {
  const monthly: MonthlyCostTotals = await monthlyCostTotals(env, at);
  if (monthly.costJpy >= MONTHLY_COST_LIMIT_JPY) {
    return { kind: MONTHLY_LIMIT_REASON };
  }

  const chatMonthly = await chatMonthlyCostJpy(env, at);
  if (chatMonthly >= CHAT_MONTHLY_COST_LIMIT_JPY) {
    return { kind: CHAT_MONTHLY_LIMIT_REASON };
  }

  const daily = await chatDailyCostJpy(env, userId, at);
  const remainingJpy = CHAT_DAILY_COST_LIMIT_JPY - daily.costJpy;
  if (remainingJpy <= 0) {
    return { kind: CHAT_DAILY_TOKENS_REASON, resetsAt: daily.resetsAt };
  }

  return { kind: 'available', remainingJpy, resetsAt: daily.resetsAt };
}
