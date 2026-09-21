/**
 * チャット（#695 / M18-2。仕様 5.16）の、エッジと Lambda のあいだの契約。
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
 * **チャットは指示文を練る場**なので、練っている対象より長い発話を受ける理由が無い。
 */
export const CHAT_MAX_MESSAGE_LENGTH = 2_000;

/**
 * 1 回の要求に載せる往復の数（#742 / M21-5。仕様 5.16）。**直近 3 往復だけを送る。**
 *
 * ## 「1 回に載せてよい量」を「その会話で送れる回数」にしない
 *
 * **会話は毎回まるごと送り直す**（Bedrock の `Converse` にセッションは無い）。以前は画面が履歴の
 * 全部を載せ、上限（20 通）をそのまま当てていたので、**「1 回の要求に載せてよい量」が「その会話で
 * 送れる回数」に化けていた**——10 往復（ルールがあれば 9 往復）で、そのチャットでは二度と送れなくなった
 * （#742。本番で利用者が踏んだ）。**いまは窓で切る。** 古い往復は送らないだけで、表示と保存には残る
 * （保存の上限は {@link CHAT_MAX_STORED_MESSAGES} で、送る上限とは別の値である）。
 *
 * ## 窓から落ちた往復の内容は、最新の返答が持つ
 *
 * **システムプロンプトの版 3 で、下書きを 1 度出したら毎回【指示文】の全文を出させている**
 * （`src/chat-prompt.ts`）。**窓の中の最新の返答が、それまでの話の要約そのものになる**——
 * 要約による圧縮（別の LLM 呼び出し）を入れずに済むのは、この前提があるからである。
 *
 * ## 3 往復である理由（#742 の intake。2026-09-20 の実測から引いた）
 *
 * - **ルールの 2 通を足しても 9 通**で、#728 で踏んだ「ルールで 2 通あふれる」経路が原理的に起きない
 * - 1 往復の重さが頭打ちになる（キャッシュ読み 1,080 ＋ 窓 ＋ 出力で約 3,200 トークン）。**1 日の蓋でも
 *   最悪 9 往復は必ず回る**
 * - 4 往復目までは 1 通も落ちない（下書きへ着地するチャットの多くは 3〜4 往復で終わっている）
 * - **4 往復は採らなかった。** 下書き全文を毎回出させると AI の発話が 1 通 400〜500 トークンに増えるので、
 *   窓を 1 往復広げると 1 日に回せる往復が 1 割強減る
 */
export const CHAT_SEND_WINDOW_TURNS = 3;

/**
 * 1 回の要求に載せる発話の数（直近 {@link CHAT_SEND_WINDOW_TURNS} 往復 ＋ 新しい 1 通 ＝ **7 通**）。
 *
 * **奇数である。** 先頭と末尾が `user` で役割が交互、という不変条件（`Converse` の要件でもある）を、
 * 往復（2 通）単位で落とすだけで保てる。
 *
 * **式ではなく数字で書く**（`CHAT_SEND_WINDOW_TURNS * 2 + 1` にしない）。この葉は
 * `src/chat-conversation.ts` → `src/generate.ts` の経路で**オーケストレータの束にも入る**。esbuild は
 * 識別子どうしの式を「副作用があるかもしれない」とみなして束から落とさないので、**式で書くと、使っても
 * いないオーケストレータの束が変わり、配り直すまで main の配備が止まる**（#742 で実測した）。
 * 数字どうしが合っていることは `test/chat-lambda.test.ts` が見る。
 */
export const CHAT_MAX_SEND_MESSAGES = 7;

/**
 * 保存する往復の数（#742）。**超えたら最古の往復から落とす。**
 *
 * **送る上限とは別の値である。** 窓から落ちた往復も、画面の表示と次に開いたときの復元には残す
 * ——**残さないと、送れるようになっても「話したことが消えた」ように見える。**
 */
export const CHAT_MAX_STORED_TURNS = 30;

/**
 * 保存する発話の数（{@link CHAT_MAX_STORED_TURNS} 往復 ＝ **60 通**）。
 *
 * **受け取ってよい発話の数の天井も兼ねる**（エッジと Lambda の検証）。受け取った後で窓へ切るので、
 * **窓より長い会話を送ってくる古い画面や古いエッジも断らない**——断ると、配り替えのあいだ、
 * 長いチャットがまた行き止まりになる。
 *
 * **数字で書く理由は {@link CHAT_MAX_SEND_MESSAGES} と同じ**（オーケストレータの束を動かさない）。
 */
export const CHAT_MAX_STORED_MESSAGES = 60;

/**
 * 大きさで断られたときに、最古の往復を落として投げ直す回数の上限（#742）。
 *
 * **投げ直してよいのは「課金される前に断られた」と分かるものだけである**——Bedrock の
 * `ValidationException`（モデルが走る前の 400）。**混雑（429 / 503）は投げ直さない**
 * （`src/chat-client.ts` の `ChatBusy`。既存の決定）。**2 度課金する経路を作らない。**
 */
export const CHAT_SIZE_RETRY_LIMIT = 2;

/**
 * 1 回の要求に載せてよい発話の合計（文字数）。
 *
 * **上限どうしを掛けた値より小さい。** #695 では {@link CHAT_MAX_MESSAGE_LENGTH} × 20 通 ＝
 * 40,000 文字を許すと 1 回で 1 日の蓋の大半を使えるので、この値を置いた。**掛け算にしない**のは
 * `src/orchestrator/handler.ts` が基盤のリトライを 0 にしているのと同じ判断である。
 *
 * **窓（{@link CHAT_MAX_SEND_MESSAGES}）の最悪は 7 × 2,000 ＝ 14,000 文字で、この値を 1 段はみ出す。**
 * **わざとである**（#742 の intake）——**超えた分は最古の往復を落として収める**（{@link chatSendWindow}）
 * ので、その仕組みが必ず踏まれ、**1 度も通らない経路にならない。** 1 往復落とせば 5 × 2,000 ＝ 10,000 で、
 * ルール（{@link CHAT_RULE_MAX_LENGTH}）を足しても収まる。
 */
export const CHAT_MAX_TOTAL_MESSAGE_LENGTH = 12_000;

/**
 * 発話の文字数の合計（**コードポイントで数える**。エッジと Lambda の検証と同じ数え方）。
 *
 * @param messages 発話の列
 * @returns 文字数の合計
 */
export function chatCharacters(messages: readonly ChatMessage[]): number {
  return messages.reduce((total, message) => total + [...message.text].length, 0);
}

/** {@link chatSendWindow} の上限（省けば既定値）。 */
export interface ChatSendWindowLimits {
  /** 載せてよい発話の数（既定 {@link CHAT_MAX_SEND_MESSAGES}）。 */
  readonly maxMessages?: number;
  /** 載せてよい文字数の合計（既定 {@link CHAT_MAX_TOTAL_MESSAGE_LENGTH}）。 */
  readonly maxCharacters?: number;
  /**
   * 会話の外で先に使う文字数（**作者のルール**。{@link withChatRule} が足す 2 通ぶん）。
   * **ルールも同じ要求に載る**ので、その分だけ会話に使える文字数が減る。
   */
  readonly reservedCharacters?: number;
}

/**
 * 1 回の要求に載せる範囲を切り出す（#742。**送る窓の正本**）。
 *
 * **最古の往復（2 通）から落とす。** 先頭と末尾が `user` で役割が交互、という不変条件は
 * 2 通ずつ落とすだけで保たれる。**最新の 1 通は必ず残す**——それでも上限を超えるなら、
 * 呼ぶ側が「送れない」と判断する（{@link chatCharacters} で数え直す）。
 *
 * **落とす条件は 2 つ**——発話の数が {@link ChatSendWindowLimits.maxMessages} を超えている、
 * または文字数の合計（ルールの分を含む）が {@link ChatSendWindowLimits.maxCharacters} を超えている。
 *
 * **エッジと Lambda と画面が同じ規則で切る**（二重の検査。送り側と受け側は別々に配られる）。
 * 画面のスクリプトは import できないので、発話の数だけを {@link CHAT_MAX_SEND_MESSAGES} から
 * 埋め込んで切る（`src/chat-section.ts`）。**大きさで断られたときのやり直し**
 * （{@link CHAT_SIZE_RETRY_LIMIT}）も、`maxMessages` を 2 つずつ減らしてこの関数を呼び直す。
 *
 * @param messages 会話（末尾は新しい `user` の発話）
 * @param limits 上限（省けば既定値）
 * @returns 載せる発話の列（切る必要が無ければ同じ配列）
 */
export function chatSendWindow(
  messages: readonly ChatMessage[],
  limits: ChatSendWindowLimits = {},
): readonly ChatMessage[] {
  const maxMessages = limits.maxMessages ?? CHAT_MAX_SEND_MESSAGES;
  const budget = (limits.maxCharacters ?? CHAT_MAX_TOTAL_MESSAGE_LENGTH) - (limits.reservedCharacters ?? 0);
  let start = 0;
  let total = chatCharacters(messages);
  // **3 通以上残っているときだけ落とす**（2 通落としても最新の 1 通が残る）。
  while (messages.length - start >= 3 && (messages.length - start > maxMessages || total > budget)) {
    total -= [...messages[start]!.text].length + [...messages[start + 1]!.text].length;
    start += 2;
  }
  return start === 0 ? messages : messages.slice(start);
}

/**
 * 1 回の応答で受け取る出力トークンの上限。
 *
 * **登録簿の `maxTokens`（生成用）を使わない。** あちらは Go のソース全文を受け取るための
 * 値で、**チャットが返すのは指示文の下書きだけである**（5.16。コードは返さない）。
 * 出力トークンは単価がいちばん高い次元（入力の 5 倍。4.1）なので、返すものの大きさに
 * 合った値を置く。
 */
export const CHAT_MAX_OUTPUT_TOKENS = 1_500;

/**
 * 作者ごとのルールの上限（文字数。#728 / 確定38）。
 *
 * **自己紹介（`BIO_MAX_LENGTH`）と同じ 500 である。** 同じ値であることは
 * `test/chat-rule.test.ts` が機械照合する——**ここから `src/profile.ts` を import しない**
 * （この葉はチャットの Lambda の束に入るので、画面側のモジュールを引き込ませない）。
 *
 * **枠の側からも見ておく。** ルールは**1 往復ごとに文脈へ乗る**ので、見積もり
 * （1 文字 1 トークンで数える）では 1 往復あたり最大 500 トークンになる。**キャッシュでは安くならない**
 * （#742 で直した。以前は「共有プレフィックスに乗る」と書いていたが、誤りだった）——
 * `src/chat/handler.ts` の `buildChatConverseRequest` が置く区切り（`cachePoint`）は、
 * **システムプロンプトの末尾と、作品の文脈の直後の 2 つだけ**である。ルールは会話の先頭の発話として
 * 入るので、**作品を選んだチャットでは文脈の区切りの後ろ**（同じ発話の中で、区切りの次のブロック）に、
 * **作品を選んでいないチャットでは `messages` に区切りが 1 つも無い**ので、**どちらでも毎往復、
 * 満額の入力として読まれる。** 見積もりが 1 文字 1 トークンで数えているのは、その意味で正しい。
 * 並びは `test/chat-lambda.test.ts` が組み立てた要求で確かめる。
 */
export const CHAT_RULE_MAX_LENGTH = 500;

/**
 * 作者のルールを置くときの前置き。
 *
 * **これが何であるかを名乗る。** 名乗らずにルールだけを置くと、**AI はそれを「いまのチャットの
 * 依頼」として読む**——「短いゲームが好きです」とだけ書いた人が、毎回その話から始められる。
 */
export const CHAT_RULE_PREAMBLE =
  'これは、わたしがいつも守ってほしいことです。このあとのチャットすべてに当てはめてください。';

/**
 * 前置きに対する、AI 側の受け答え。
 *
 * **役割が交互であることは、エッジもこの Lambda も確かめている。** 作者の発話を 1 つ足すだけでは
 * `user` が 2 つ続くので、**受け答えを 1 つ足して並びを保つ。**
 *
 * **ルールの本文を復唱させない**——復唱させると、そのぶんの文脈が毎回積まれる。
 */
export const CHAT_RULE_ACKNOWLEDGEMENT = '承知しました。以降のチャットでそのとおりにします。';

/**
 * ルールが使う発話の数（前置きと受け答えで 2 つ）。
 *
 * **以前はエッジがこのぶんを空けてから受けていた**（上限ちょうどの会話がルールで 2 通あふれるため。#728）。
 * **#742 で送る窓（{@link CHAT_MAX_SEND_MESSAGES}）へ切るようになり、ルールを足しても 9 通なので、
 * あふれる経路そのものが無くなった。** 文字数だけは {@link ChatSendWindowLimits.reservedCharacters} で空ける。
 */
export const CHAT_RULE_TURNS = 2;

/**
 * 作者のルールを、会話の先頭へ 2 通の発話として足す。
 *
 * **展開するのは Lambda である**（エッジではない）。**8.2 の Guardrail はこの Lambda の中に
 * あり、検査するのは「この往復で新しく届いたもの」だけ**なので、**エッジで展開して送ると、
 * ルールが検査を 1 度も通らないまま Bedrock へ届く**（#728 の Copilot の指摘）。
 * **置く場所と検査する場所を同じ側に寄せる。**
 *
 * **空なら何も足さない**（確定38「空のときは今までどおり動く」）。
 *
 * @param rule 作者のルール（空なら何もしない）
 * @param messages 会話
 * @returns モデルへ渡す会話
 */
export function withChatRule(
  rule: string,
  messages: readonly ChatMessage[],
): readonly ChatMessage[] {
  if (rule === '') {
    return messages;
  }
  return [
    { role: 'user', text: `${CHAT_RULE_PREAMBLE}\n\n${rule}` },
    { role: 'assistant', text: CHAT_RULE_ACKNOWLEDGEMENT },
    ...messages,
  ];
}

/** チャットの文脈に載せる、作者自身の作品（5.16「見せる情報」）。 */
export interface ChatWorkContext {
  /** 題名。 */
  readonly title: string;
  /**
   * 最初の指示文（`games.prompt`。無ければ null）。
   *
   * **フォーク元では必ず null である**（#727 / 確定38。1.2.54——指示文は作者本人にしか出さない）。
   * 載るのは**自分の作品を対象にしたチャット**のときだけである。
   */
  readonly prompt: string | null;
  /**
   * 説明（`games.description`。#727 / 確定38）。
   *
   * **フォーク元にだけ載る。** 自分の作品を対象にしたチャットでは null である——あちらは
   * 最初の指示文が読めるので、説明を重ねて送る理由が無い。
   */
  readonly description: string | null;
  /** タグ（#727 / 確定38）。**フォーク元にだけ載る**（自分の作品では空）。 */
  readonly tags: readonly string[];
  /**
   * Go のソース。**作者がその会話で明示的に求めたときだけ載る**（5.16 / 利用者の決定）。
   *
   * 載せないときは `null` である。**既定で載せない**のは、64 KiB で 1 往復が約 19,200
   * トークン（1 日分の 3 分の 2）になり、チャットがコードの話へ寄るためである。
   */
  readonly source: string | null;
}

/** Lambda へ送るペイロード。 */
export interface ChatRequestPayload {
  readonly version: typeof CHAT_PAYLOAD_VERSION;
  /**
   * 会話。**末尾は必ず `user`** である（エッジが確かめる）。
   *
   * **送る窓で切ったものである**（{@link chatSendWindow}。#742）。受け取った側も同じ規則で切り直す
   * ——**古いエッジは窓で切らずに送ってくる**ので、受け取る数の天井は {@link CHAT_MAX_STORED_MESSAGES} に置く。
   */
  readonly messages: readonly ChatMessage[];
  /** 作者自身の作品の文脈。選んでいなければ載らない。 */
  readonly work?: ChatWorkContext;
  /**
   * 作者ごとのルール（#728 / 確定38）。**空か、設定していなければ載らない。**
   *
   * **展開するのは受け取った側である**（{@link withChatRule}）。**8.2 の検査と同じ側に置く**
   * ——エッジで会話へ混ぜて送ると、ルールが検査を通らないまま Bedrock へ届く。
   *
   * **この項目を足しても版は上げない。** 版を上げると「新しいエッジ ＋ 古い Lambda」と
   * 「古いエッジ ＋ 新しい Lambda」の**どちらか一方が必ず断られる**——2 つは別々に配られるので、
   * 入れ替えのあいだチャットが止まる。**古い Lambda はこの項目を読み飛ばすだけ**（ルールが効かない
   * 窓が開くが、断られはしない）で、**古いエッジは載せないだけ**である。
   */
  readonly rule?: string;
}

/** Lambda が返す本文。 */
export type ChatResponsePayload =
  | {
      readonly ok: true;
      /** チャットの返答（指示文の下書きを含む日本語）。 */
      readonly text: string;
      /** 使ったモデルの登録簿の鍵（台帳へそのまま入る）。 */
      readonly modelKey: string;
      /** チャットのシステムプロンプトの版。 */
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
