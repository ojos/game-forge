/**
 * チャットの枠（#695 / M18-2。仕様 5.16「枠——チャットの費用が生成の予算を食わないようにする」）。
 *
 * ## 2 段で、当たっても生成は止まらない
 *
 * **4.3 の役割分担（日次＝1 人あたりの蓋 / 月次＝総額）をそのまま写したものである**（利用者の決定）。
 *
 * | 段 | 値 | 当たったときに止まるもの |
 * |---|---|---|
 * | 1 人 1 日 | {@link CHAT_DAILY_TOKEN_LIMIT} トークン | **その人のチャットだけ。** 生成は動く |
 * | チャットの当月累計 | {@link CHAT_MONTHLY_COST_LIMIT_JPY} 円 | **全員のチャットだけ。** 生成は動く |
 *
 * **確定25 の日次 10 回は 1 回も減らさない**（`src/quota.ts` の `dailyCallCount` が
 * `kind = 'generation'` で絞る）。5.7 がリフォージで日次枠を共有したのとは逆の判断で、
 * **理由は 1 往復の額が 1 桁小さいこと**（**実測 0.64 円 対 ¥22.41**。2026-09-20 の本番の 9 往復。5.16）である。
 *
 * ## 往復数ではなくトークン数で数える
 *
 * **ソースを渡すかどうかで 1 往復の重さが 5 倍以上変わる**（利用者の決定。5.16）。ソースを渡さない
 * ソースを渡さない 1 往復は**実測 1,710 トークン**だが、64 KiB のソースを 1 回渡すと約 19,200 トークンになる。
 * **往復数で数えると、重い往復と軽い往復が同じ 1 になり、蓋が費用に対応しない。**
 *
 * 数えるのは **`usage` の 4 項目の合計**（入力・出力・キャッシュ読み・キャッシュ書き）である。
 * **単価の違う次元を足し合わせているので、トークン数と費用は比例しない**——それでよい。
 * 費用のほうは下の当月の取り分が縛っており、**この段の役割は「1 人が 1 日に使う量の蓋」**である
 * （4.3 の日次クォータが回数で数えていて、1 回の額が揃っていないのと同じ関係）。
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
 * 1. **1 回の要求そのものが蓋を超えないようにする**（{@link estimateChatTokens}）。**これが無いと、
 *    残りが 1 トークンでも満額の往復が通る**——ソースを渡す往復は最大 36,588 トークンで、
 *    **1 日の蓋（30,000）を単独で超える。** 見積もりは高い側へ倒す（4.3 の「迷う側は高い側へ倒す」）。
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
  jstMonthRange,
  monthlyCostTotals,
  type MonthlyCostTotals,
} from './cost-ledger.js';
import { MONTHLY_COST_LIMIT_JPY, MONTHLY_LIMIT_REASON, jstDayRange } from './quota.js';

/**
 * 1 人 1 日にチャットで使えるトークン数（仕様 5.16。利用者の決定）。
 *
 * **4.3 と同じ形で逆算した値である。** 引いたときはキャッシュが効かない安全側の単価
 * 0.675 円/1,000 トークン（入力 2,800・出力 400 の比に `sonnet-4-6` の単価と 150 円/ドルを
 * 当てた値）を使い、
 *
 *   30,000 × 0.675 ÷ 1,000 ＝ 約 ¥20/人・日 × **3 人**（4.3 と同じ想定）× 30 日 ＝ 約 ¥1,800
 *
 * として {@link CHAT_MONTHLY_COST_LIMIT_JPY} の内側に収めた。**2 つの値は独立ではない**
 * ——片方だけを動かすと逆算が合わなくなる。
 *
 * **本番の実測は 0.371 円/1,000 トークンだった**（2026-09-20。仕様 5.16 の「実測」）。
 * **同じ式で引き直すと 約 ¥11/人・日・月 約 ¥1,000** で、**蓋は引いたときより余裕がある。**
 * **値は変えていない**——枠の値は利用者の決定であり、実測が安い側へ出たことは緩める理由にならない。
 *
 * 仕様書側の記載との一致は `test/chat.test.ts` が {@link CHAT_DAILY_TOKEN_PATTERN} で
 * 機械照合する（`src/quota.ts` の `MONTHLY_LIMIT_PATTERN` と同じ理由——同じ数値が 2 か所に
 * ある以上、呼びかけでは守れない）。
 */
export const CHAT_DAILY_TOKEN_LIMIT = 30_000;

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
 * 1 往復が使うトークンを、呼ぶ前に見積もる。
 *
 * **日本語は 1 文字 1 トークンとして数える。** 実際の Claude のトークナイザは日本語で
 * 1 文字あたり 1 トークン前後で、ASCII ではもっと少ない。**少ないほうへ倒さない。**
 *
 * **出力は上限で数える**（{@link CHAT_MAX_OUTPUT_TOKENS}）。実際には短いことが多いが、
 * **呼ぶ前に分かるのは上限だけ**である。
 *
 * **キャッシュ読みも数に入る**（`usage` の 4 項目の合計を数えているため。モジュール冒頭）。
 * したがって 2 往復目以降の見積もりは実測より小さくならない。
 *
 * @param input 会話と、文脈に載せるソース
 * @returns 見積もったトークン数
 */
export function estimateChatTokens(input: {
  /** 会話の全文（文字数で数える）。 */
  readonly messageCharacters: number;
  /** 文脈に載せるソースのバイト数（載せないなら 0）。 */
  readonly sourceBytes: number;
}): number {
  return (
    // システムプロンプト（会話が伸びても変わらない）。**本文から数える**ので、
    // プロンプトを書き足した日に見積もりも動く。
    [...renderChatPromptText()].length +
    input.messageCharacters +
    Math.ceil(input.sourceBytes / CHAT_SOURCE_BYTES_PER_TOKEN) +
    CHAT_MAX_OUTPUT_TOKENS
  );
}

/** 仕様書が 1 人 1 日のトークン数を宣言している文の形（テストが照合に使う）。 */
export const CHAT_DAILY_TOKEN_PATTERN =
  /1 ?人 ?1 ?日 ?\*{0,2}([0-9]{1,3}(?:,[0-9]{3})*) ?トークン/gu;

/** 仕様書がチャットの当月の取り分を宣言している文の形（テストが照合に使う）。 */
export const CHAT_MONTHLY_LIMIT_PATTERN =
  /(?:当月)?(?:累計|取り分) ?\*{0,2}([0-9]{1,3}(?:,[0-9]{3})*) ?円/gu;

/**
 * 1 人 1 日のトークンで止まったことを表す分類名。**利用者への文言ではない。**
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
      /** 本日（JST）の残りトークン。**必ず 1 以上**である。 */
      readonly remainingTokens: number;
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
 * ある利用者が、その暦日（JST）にチャットで使ったトークン数を数える。
 *
 * **成否を問わない**（4.3 の「成否で絞らない」と同じ）。断られた返答にも `usage` は出ており、
 * 課金は発生している。**Guardrail で止めた回だけは LLM を呼んでいないので行が無い**（5.16）。
 *
 * 索引は `generations(user_id, created_at)`（`migrations/0005_*`）。`kind` は絞った残りを
 * 弾くだけなので、索引を足していない（`migrations/0049_chat.sql`）。
 *
 * @param env バインディングと環境変数
 * @param userId 数える利用者
 * @param at 基準時刻（UNIX 秒）
 * @returns 当日（JST）のトークン数と、枠が戻る時刻
 */
export async function chatDailyTokens(
  env: Env,
  userId: string,
  at: number,
): Promise<{ readonly tokens: number; readonly resetsAt: number }> {
  const day = jstDayRange(at);
  // **`sum` は行が無いと NULL を返す。** `coalesce` を SQL 側で被せる（`monthlyCostTotals`
  // と同じ理由——JS 側で `?? 0` にすると、行が無い経路と列が NULL の経路が同じ形になる）。
  const row = await env.DB.prepare(
    `select coalesce(sum(
              input_tokens + output_tokens
              + cache_creation_input_tokens + cache_read_input_tokens
            ), 0) as tokens
       from generations
      where user_id = ? and created_at >= ? and created_at < ? and kind = ?`,
  )
    .bind(userId, day.fromSeconds, day.toSeconds, CHAT_KIND)
    .first<{ tokens: number }>();
  return { tokens: row?.tokens ?? 0, resetsAt: day.toSeconds };
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
 * 3. **1 人 1 日のトークン**（その人のチャットだけが止まる）
 *
 * **全体の月次は写さず、`monthlyCostTotals` をそのまま呼ぶ。** チャット用にもう 1 本 SQL を
 * 書けば読み取りは 1 回減るが、**「4.3 の総額とは何か」の定義が 2 か所になる**——
 * 数える対象を変えた日に、チャットの経路だけが古い定義で動く。
 *
 * @param env バインディングと環境変数
 * @param userId 対象の利用者
 * @param at 判定時刻（UNIX 秒。既定は現在時刻）
 * @returns 枠の状態。チャットできるときは残りトークンを伴う
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

  const daily = await chatDailyTokens(env, userId, at);
  const remainingTokens = CHAT_DAILY_TOKEN_LIMIT - daily.tokens;
  if (remainingTokens <= 0) {
    return { kind: CHAT_DAILY_TOKENS_REASON, resetsAt: daily.resetsAt };
  }

  return { kind: 'available', remainingTokens, resetsAt: daily.resetsAt };
}
