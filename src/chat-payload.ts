/**
 * 相談（#695 / M18-2。仕様 5.16）の、エッジと Lambda のあいだの契約。
 *
 * **値と形だけを持つ葉である**（`src/public-works-api-paths.ts` と同じ役割）。ここには
 * トランスポートも D1 も無い——**同じ形を 2 か所に書き写さない**ためだけに在る。
 *
 * ## 文脈を組み立てるのはエッジである
 *
 * **Lambda は「見せてよいもの」を判断しない。** 自作かどうかの判定（`author_id`）も、
 * ソースを読むかどうかも、エッジが済ませてからここへ載せる。**利用者の端末から届いた値を
 * そのまま文脈にしない**——「他の作者の作品を情報源にしない」（5.16）を守れるのは、
 * 作品を引く側が呼び出し元の id で絞っているときだけである。
 *
 * ## 版を持つ
 *
 * オーケストレータのペイロード（`src/orchestrator/payload.ts`）と同じ理由による。
 * **送り側と受け側は別々に配られる**ので、片方だけが新しい形を知っている窓が必ず開く。
 */

/** ペイロードの版。**形を変えたら上げる。** */
export const CHAT_PAYLOAD_VERSION = 1;

/** 会話の 1 往復ぶんの発話。 */
export interface ChatMessage {
  /** 誰の発話か。`assistant` は前の応答をそのまま戻したものである。 */
  readonly role: 'user' | 'assistant';
  /** 本文。 */
  readonly text: string;
}

/**
 * 1 通の発話の上限（文字数）。
 *
 * **生成の指示文と同じ 2,000 文字にする**（`src/generate.ts` の `MAX_PROMPT_LENGTH`）。
 * **相談は指示文を練る場**なので、練っている対象より長い発話を受ける理由が無い。
 */
export const CHAT_MAX_MESSAGE_LENGTH = 2_000;

/**
 * 1 回の要求に載せてよい発話の数。
 *
 * **会話が伸びるほど 1 往復が重くなる**（毎回まるごと送るため）。1 日 30,000 トークンの
 * 蓋（`src/chat-quota.ts`）は**使い切るまで止めない**ので、**1 回の要求の重さは別に縛る。**
 * 20 通は、ソースを渡さない往復（約 3,200 トークン）を 10 回ぶん積み上げた長さにあたる。
 */
export const CHAT_MAX_MESSAGES = 20;

/**
 * 1 回の要求に載せてよい発話の合計（文字数）。
 *
 * **{@link CHAT_MAX_MESSAGE_LENGTH} × {@link CHAT_MAX_MESSAGES} より小さい。** 上限どうしを
 * 掛けた値（40,000 文字）を許すと、1 回で 1 日の蓋の大半を使える。**掛け算にしない**のは
 * `src/orchestrator/handler.ts` が基盤のリトライを 0 にしているのと同じ判断である。
 */
export const CHAT_MAX_TOTAL_MESSAGE_LENGTH = 12_000;

/**
 * 1 回の応答で受け取る出力トークンの上限。
 *
 * **登録簿の `maxTokens`（生成用）を使わない。** あちらは Go のソース全文を受け取るための
 * 値で、**相談が返すのは指示文の下書きだけである**（5.16。コードは返さない）。
 * 出力トークンは単価がいちばん高い次元（入力の 5 倍。4.1）なので、返すものの大きさに
 * 合った値を置く。
 */
export const CHAT_MAX_OUTPUT_TOKENS = 1_500;

/** 相談の文脈に載せる、作者自身の作品（5.16「見せる情報」）。 */
export interface ChatWorkContext {
  /** 題名。 */
  readonly title: string;
  /** 最初の指示文（`games.prompt`。無ければ null）。 */
  readonly prompt: string | null;
  /**
   * Go のソース。**作者がその会話で明示的に求めたときだけ載る**（5.16 / 利用者の決定）。
   *
   * 載せないときは `null` である。**既定で載せない**のは、64 KiB で 1 往復が約 19,200
   * トークン（1 日分の 3 分の 2）になり、相談がコードの話へ寄るためである。
   */
  readonly source: string | null;
}

/** Lambda へ送るペイロード。 */
export interface ChatRequestPayload {
  readonly version: typeof CHAT_PAYLOAD_VERSION;
  /** 会話。**末尾は必ず `user`** である（エッジが確かめる）。 */
  readonly messages: readonly ChatMessage[];
  /** 作者自身の作品の文脈。選んでいなければ載らない。 */
  readonly work?: ChatWorkContext;
}

/** Lambda が返す本文。 */
export type ChatResponsePayload =
  | {
      readonly ok: true;
      /** 相談の返答（指示文の下書きを含む日本語）。 */
      readonly text: string;
      /** 使ったモデルの登録簿の鍵（台帳へそのまま入る）。 */
      readonly modelKey: string;
      /** 相談のシステムプロンプトの版。 */
      readonly promptVersion: number;
      /**
       * 生成が止まった理由（`end_turn` / `max_tokens` など）。
       *
       * **台帳の `succeeded` はこれで決まる**（4.3「`stopReason` が `end_turn` のときだけ 1」）。
       * **切れた返答でも課金は出ている**ので、成功として記録しないだけで、行は作る。
       */
      readonly stopReason: string;
      /** `Converse` の `usage`。**エッジが台帳へ積む。** */
      readonly usage: {
        readonly inputTokens: number;
        readonly outputTokens: number;
        readonly cacheReadInputTokens: number | null;
        readonly cacheWriteInputTokens: number | null;
      };
    }
  | {
      readonly ok: false;
      /**
       * 断った分類名。
       *
       * - `prompt-blocked` … 8.2 の Guardrail が遮断した（**LLM は呼んでいない**ので台帳の行は無い）
       * - `internal` … 呼べなかった・応答が読めない（`src/input-moderation.ts` の表と同じ 2 分法）
       */
      readonly error: 'prompt-blocked' | 'internal';
      /** 遮断したカテゴリ（`prompt-blocked` のときだけ）。 */
      readonly categories?: readonly string[];
    };
