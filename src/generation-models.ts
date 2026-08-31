/**
 * 生成モデルの登録簿と選択機構（確定5 / 4.1 / 4.2 / #83）。
 *
 * **生成モデルは複数構成である**（確定5）。したがってモデル選択は「後から足す抽象化」
 * ではなく最初からの要件で、単価・試算・費用台帳のすべてがモデル軸を持つ（4.1）。
 * このモジュールが持つのは次の 3 つである。
 *
 * 1. **どのモデルがあるか**（`GENERATION_MODELS`）と、モデルごとの設定（単価・`effort`・
 *    出力上限・システムプロンプトの解決）。
 * 2. **どのモデルで生成するかを決める経路**（`selectGenerationModel`）。
 * 3. **生成結果の形**（`GenerationResult`）。**どのモデルで生成したかを必ず含む。**
 *
 * **トランスポートを持たない。** Bedrock の `Converse` を叩くのは `src/bedrock.ts` で、
 * ここは接続先を知らない。分ける理由は、モデルの追加（登録簿へ 1 要素）と接続方式の
 * 変更（確定19 は既に 3 度変わっている）が別々に起きるためである。
 *
 * ## 単価は仕様書 4.1 の表と機械照合する
 *
 * 単価は仕様書 4.1 にも表として載っている。**同じ数値が 2 か所にある**以上、片方だけが
 * 更新される経路が開く。費用台帳（#22）はこの数値で円換算するので、ずれると
 * 4.3 の月次上限が静かに狂う。`test/generation-models.test.ts` が仕様書の表を読んで
 * 照合する（shared-ai-rules 12 章「一覧の複製は機械照合で担保する」）。
 */

/** 仕様書側の単価表がある節の見出し（前方一致で探す）。テストが照合に使う。 */
export const PRICING_SECTION_HEADING = '### 4.1 接続先と単価';

/**
 * 推論プロファイルの接頭辞。
 *
 * **Bedrock 固有の差分のひとつ。** 新しい世代の Anthropic モデルは素のモデル ID を
 * オンデマンドで呼べず、`Invocation of model ID ... with on-demand throughput isn't
 * supported` になる（4.1 の実測）。地理スコープを表すこの接頭辞が付いた
 * **推論プロファイル ID** を使う必要がある。
 */
export const INFERENCE_PROFILE_PREFIXES: readonly string[] = ['jp.', 'global.', 'apac.'];

/**
 * 生成モデルを指す短い鍵。**環境変数と費用台帳（#22）がこの値で参照する。**
 *
 * **`effort` の A/B（#25）の 2 群も、この鍵で表す。** 理由は下の
 * {@link EFFORT_AB_ARMS} にある。
 */
export type GenerationModelKey =
  | 'sonnet-4-6'
  | 'deepseek-v3-2'
  | `sonnet-4-6-${(typeof EFFORT_AB_ARMS)[number]}`;

/**
 * 推論の深さ（`effort`）。
 *
 * 4.2 は「thinking トークンは出力として課金されるため、`effort` は実質そのまま
 * コスト倍率になる」とし、`high` と `medium` の A/B を最優先の実験項目に置いている
 * （#25）。**その実験の入り口がこの型である。**
 */
export type GenerationEffort = 'low' | 'medium' | 'high' | 'max';

/**
 * A/B で比べる 2 つの `effort`（4.2 / #25）。
 *
 * **群を「登録簿の要素」として表す。** `effort` 専用の環境変数を新しく作らないのは、
 * **どの群へ割り当てられたかが記録に残る経路が、既に 1 本だけ通っているから**である。
 *
 * ```
 * wrangler.toml の GENERATION_MODEL
 *   → selectGenerationModel（決定はここ 1 か所。既存のコメントが #25 を名指ししている）
 *   → src/orchestrator/start-job.ts が payload.modelKey へ載せる
 *   → Lambda の workerLikeEnv が同じ鍵で復元する
 *   → src/bedrock.ts が effort を送る
 *   → ledger コールバックが modelKey を運ぶ（src/generate-callback.ts の parseLedger）
 *   → generations.model / generations.effort
 * ```
 *
 * **`effort` を別の変数にすると、この 6 段すべてに項目を 1 つずつ足すことになる。**
 * 足し忘れた段があると、**エッジでは送れているのに本番（オーケストレータ経路）だけが
 * 既定へ落ちる**——A/B の片側が黙ってもう片側になる、という 4.2 の比較が成立しない
 * 壊れ方そのものである。鍵に載せれば、既に本番で動いている 1 本がそのまま運ぶ。
 *
 * **群を増やすときはここへ足す**（`low` / `max` を測るなら 1 要素）。**測らない値を
 * 登録簿へ置かない**——費用の出る経路の選択肢は、実験の対象だけに保つ。
 */
export const EFFORT_AB_ARMS = ['high', 'medium'] as const;

/**
 * 台帳へ「`effort` を送らなかった」を残すときの綴り（`generations.effort`）。
 *
 * **`null` と区別する。** 列の `NULL` は「**この行は `effort` を記録していない**」
 * （`migrations/0011_generations_effort.sql` より前に入った行）で、`'none'` は
 * 「**記録した結果、送っていなかった**」である。混ぜると、A/B の集計が
 * 「古い行」と「対照群」を同じものとして数える。
 *
 * 4.1 のキャッシュ単価を `0` ではなく `null` にしているのと同じ線である。
 */
export const EFFORT_NOT_SENT = 'none';

/** モデル別の単価（$/100 万トークン。4.1 の表が正本）。 */
export interface ModelPricing {
  readonly inputUsdPerMillion: number;
  readonly outputUsdPerMillion: number;
  /** キャッシュ読み。**課金次元を持たないモデルでは `null`**（`0` ではない）。 */
  readonly cacheReadUsdPerMillion: number | null;
  /** キャッシュ書き（5 分 TTL）。同上。 */
  readonly cacheWriteUsdPerMillion: number | null;
}

/** 1 つの生成モデルと、その設定。 */
export interface GenerationModel {
  /** 短い鍵。環境変数の値と、費用台帳へ残す識別子。 */
  readonly key: GenerationModelKey;
  /** Bedrock へ渡すモデル ID（Anthropic 系は推論プロファイル ID）。 */
  readonly modelId: string;
  /** 4.1 が「API ではなくモデルの差である」とする挙動の出所。 */
  readonly provider: 'anthropic' | 'deepseek';
  /** 単価。4.1 の表と機械照合する。 */
  readonly pricing: ModelPricing;
  /** 推論の深さ。**`null` は「指定しない」**（下記）。 */
  readonly effort: GenerationEffort | null;
  /** 1 回の生成で受け取る出力トークンの上限。 */
  readonly maxTokens: number;
}

/**
 * 使える生成モデル（確定5 / 4.1）。
 *
 * **`Sonnet 5` はこのアカウントで開放されていない**（12 章 #2 / 1.2.9）。開放されたら
 * ここへ 1 要素足し、4.1 の表も更新する（照合テストが片方だけの更新を落とす）。
 */
const SONNET_4_6: Omit<GenerationModel, 'key' | 'effort'> = {
  // `jp.` は東京（ap-northeast-1）を含む地理スコープの推論プロファイル。素の
  // `anthropic.claude-sonnet-4-6` はオンデマンドで呼べない（4.1 の実測）。
  modelId: 'jp.anthropic.claude-sonnet-4-6',
  provider: 'anthropic',
  pricing: {
    inputUsdPerMillion: 3,
    outputUsdPerMillion: 15,
    cacheReadUsdPerMillion: 0.3,
    cacheWriteUsdPerMillion: 3.75,
  },
  // 4.2 の実測は平均 4,171 トークン。5.3 がソースを 30KB（おおよそ 1 万トークン）に
  // 制限しており、thinking が出力として乗ることを見込んでもこの値で収まる。
  // **上限は費用の天井でもある**ので、必要より大きくしない。
  //
  // **A/B の 2 群も同じ値を使う**（下記）。片方だけ広げると、`max_tokens` で切れた
  // 回数の差が `effort` の効果に見える。
  maxTokens: 16_000,
};

const DEEPSEEK_V3_2: Omit<GenerationModel, 'key' | 'effort'> = {
  // **こちらは推論プロファイルではない。** `deepseek.` は提供者の接頭辞で、素の ID の
  // まま東京で実生成できることを実測している（4.1 / #79）。同じ「接頭辞つき」でも
  // 意味が違うため、一律の規則で組み立てず ID を直接書く。
  modelId: 'deepseek.v3.2',
  provider: 'deepseek',
  // **キャッシュの課金次元を持たない**（4.1）。`0` ではなく `null` を置く。`0` は
  // 「無料でキャッシュできる」の意味になり、`cachePoint` を置く判断が変わる。
  pricing: {
    inputUsdPerMillion: 0.74,
    outputUsdPerMillion: 2.22,
    cacheReadUsdPerMillion: null,
    cacheWriteUsdPerMillion: null,
  },
  // 4.2 の実測は平均 2,159 トークン。Bedrock 上でこのモデルが受け付ける上限を
  // 確かめていないため、実測の 4 倍程度に留める。
  maxTokens: 8_192,
};

export const GENERATION_MODELS: readonly GenerationModel[] = [
  {
    key: 'sonnet-4-6',
    ...SONNET_4_6,
    // **既定では指定しない。** 綴り（`output_config.effort`）が受理されることは
    // 実呼び出しで確かめたが（2026-08-31 / `scripts/verify-effort-spelling.sh`）、
    // **どの値を採るかは決まっていない**（#25 の A/B が測る。4.2）。既定で送ると、
    // 採用値を決める前に全生成が片方の群になる。値を入れれば送る経路は
    // `src/bedrock.ts` にあり、テストで固定してある。
    effort: null,
  },
  {
    key: 'deepseek-v3-2',
    ...DEEPSEEK_V3_2,
    // `effort` は Claude のみの概念（4.2）。
    effort: null,
  },
  // **A/B の 2 群**（4.2 / #25。{@link EFFORT_AB_ARMS}）。
  //
  // **素の `sonnet-4-6` との差は `effort` だけである。** 単価・モデル ID・出力上限は
  // 同じ実体を展開しているので、**片方だけ古くなる経路が無い。** 1.2.43 の実測が
  // 示したとおり費用は出力トークンにほぼ比例するため、**単価が 1 桁でも違えば
  // 費用差は `effort` の効果に見えなくなる。**
  //
  // ここが「切り替え機構」の全体である。`wrangler.toml` の `GENERATION_MODEL` を
  // この鍵にすれば、決定（`selectGenerationModel`）→ ペイロード → Lambda → 台帳まで
  // **既に本番で動いている 1 本**がそのまま群を運ぶ。
  ...EFFORT_AB_ARMS.map(
    (effort): GenerationModel => ({
      key: `sonnet-4-6-${effort}`,
      ...SONNET_4_6,
      effort,
    }),
  ),
];

/**
 * A/B の 2 群を指す鍵（`wrangler.toml` の `GENERATION_MODEL` へ置く値）。
 *
 * **一覧をここで作る。** 手で書き写すと、{@link EFFORT_AB_ARMS} へ群を足したときに
 * 片方だけが古くなる（shared-ai-rules 12 章）。
 */
export const EFFORT_AB_MODEL_KEYS: readonly GenerationModelKey[] = EFFORT_AB_ARMS.map(
  (effort) => `sonnet-4-6-${effort}` as const,
);

/**
 * 既定のモデル。
 *
 * **Sonnet 4.6 を既定にする。** 4.2 の実測で 1 生成あたりは DeepSeek の約 12 倍だが、
 * 初回コンパイル成功率が 5/6 対 1/6 で、**1 本の遊べるゲームあたりでは差が 7 倍**へ
 * 縮む。失敗の質も違い、Sonnet の失敗は存在しない API の捏造で機械修正が効かないが、
 * DeepSeek は 6 本中 5 本が落ちる。**体験の下限を決めるのは成功率の側**である。
 */
export const DEFAULT_GENERATION_MODEL_KEY: GenerationModelKey = 'sonnet-4-6';

/**
 * どのモデルで生成するかを宣言する変数の名前（`wrangler.toml` の `[vars]`）。
 *
 * **シークレットではない。** モデルの選択は秘密ではなく構成であり、`.dev.vars` へ
 * 置くと本番の値が宣言から読めなくなる。環境ごとに宣言することで、開発で安い
 * モデルを、本番で成功率の高いモデルを、という使い分けが宣言だけで効く。
 */
export const GENERATION_MODEL_VAR = 'GENERATION_MODEL';

/** 宣言されたモデル名が登録簿に無い。**既定へ落とさず落とす**（下記）。 */
export class UnknownGenerationModel extends Error {
  constructor(readonly requested: string) {
    super(
      `未知の生成モデルです: ${requested}（使えるのは ${GENERATION_MODELS.map((model) => model.key).join(' / ')}）`,
    );
    this.name = 'UnknownGenerationModel';
  }
}

/**
 * 鍵からモデルを引く。
 *
 * @param key モデルの鍵
 * @returns 見つかったモデル。無ければ `null`
 */
export function findGenerationModel(key: string): GenerationModel | null {
  return GENERATION_MODELS.find((model) => model.key === key) ?? null;
}

/**
 * このリクエストをどのモデルで生成するかを決める。
 *
 * **決定の経路はここ 1 か所である。** 呼び出し側（`src/bedrock.ts`）はモデルを選ばない。
 * 将来 #25 の A/B や利用者ごとの出し分けを入れるとしても、入り口はこの関数のままにして、
 * 「どこでモデルが決まるのか」を探す作業を二度と発生させない。
 *
 * **#25 の A/B もそのとおりに入った。** 群は登録簿の要素（`sonnet-4-6-high` /
 * `sonnet-4-6-medium`。{@link EFFORT_AB_ARMS}）で、この関数は 1 行も変わっていない。
 * **群の切り替えは `GENERATION_MODEL` の値を変えて配備すること**で行う。
 * 1 度の配備の中で群が混ざらないので、**同じ依頼のリトライが群をまたがない**
 * （この関数は LLM 呼び出しごとに呼ばれる。乱択をここへ置くと、2 回目の試行だけ
 * もう片方の群になり、台帳の行と実際の割り当てが依頼の中でずれる）。
 *
 * **未知の値は既定へ落とさずに落とす。** 綴り違いを既定で拾うと、A/B の片側が黙って
 * もう片側になり、4.2 の比較（成功率と単価）が成立しない。**費用の出る経路で、
 * 曖昧な指定を推測で受け取らない**（`src/generate.ts` の未知項目の扱いと同じ方針）。
 *
 * 未宣言（`undefined` や空）のときだけ既定を使う。`wrangler.toml` は全環境で宣言して
 * いるが、値を持たない env（テストや骨組みだけの経路）でも決定が成立する必要がある。
 *
 * @param env バインディングと環境変数
 * @returns 使うモデル
 * @throws {UnknownGenerationModel} 宣言された名前が登録簿に無いとき
 */
export function selectGenerationModel(env: Env): GenerationModel {
  const requested = (env as unknown as Record<string, unknown>)[GENERATION_MODEL_VAR];
  if (typeof requested !== 'string' || requested.trim() === '') {
    return findGenerationModel(DEFAULT_GENERATION_MODEL_KEY)!;
  }
  const model = findGenerationModel(requested.trim());
  if (model === null) {
    throw new UnknownGenerationModel(requested);
  }
  return model;
}

/**
 * このモデルが prompt caching の課金次元を持つか。
 *
 * **`pricing` から導く。** 別のフラグを持たせると、単価表を直したときに片方だけが
 * 残る。キャッシュ次元を持たないモデルへ `cachePoint` を送っても意味が無く、
 * 送れば `Converse` に拒否されうる（4.1: これは API ではなくモデルの性質である）。
 *
 * @param model 対象のモデル
 * @returns 手動キャッシュを置けるなら true
 */
export function supportsPromptCaching(model: GenerationModel): boolean {
  return model.pricing.cacheReadUsdPerMillion !== null;
}

/**
 * このモデルで生成したとき、台帳の `effort` 列へ残す値（#25 / 4.2）。
 *
 * **`null`（送らない）を `'none'` へ落とす。** 列の `NULL` は「記録していない」を
 * 表すため（{@link EFFORT_NOT_SENT}）、値として書くときは必ず綴りを持たせる。
 *
 * @param model 使ったモデル
 * @returns `generations.effort` へ入れる値
 */
export function ledgerEffortOf(model: GenerationModel): string {
  return model.effort ?? EFFORT_NOT_SENT;
}

/**
 * モデル ID の推論プロファイル接頭辞を返す。
 *
 * @param modelId Bedrock のモデル ID
 * @returns 接頭辞（`jp.` など）。無ければ `null`
 */
export function inferenceProfilePrefix(modelId: string): string | null {
  return INFERENCE_PROFILE_PREFIXES.find((prefix) => modelId.startsWith(prefix)) ?? null;
}

/**
 * システムプロンプトを構成する 1 ブロック。
 *
 * **`cachePoint` の配置を #16 が決められる形にしてある。** Bedrock では自動 prompt
 * caching が使えず、手動で区切りを置く必要がある（4.1 / 4.5）。区切りの位置は
 * プロンプト本文の構造で決まる（どこまでが全生成で共有されるプレフィックスか）ので、
 * 本文を持つ側（#16）が決める。**トランスポートは配置を決めない。**
 */
export type SystemBlock = { readonly text: string } | { readonly cachePoint: true };

/**
 * モデルごとのシステムプロンプトを返す関数。
 *
 * **本文は #16 が持つ**（本 issue はプロンプト本文を持たない）。6.1 が
 * 「システムプロンプトはモデルごとに持つ（確定5）」と定めるため、**モデルを引数に取る。**
 * 同じ制約文でもモデルによって出力が変わり、4.2 の実測でも失敗の質が違う。
 */
export type SystemPromptResolver = (model: GenerationModel) => readonly SystemBlock[];

/**
 * `usage` の 4 種（4.1 / 4.5）。
 *
 * **モデルによって欠ける項目がある。** DeepSeek はキャッシュの 2 項目を返さない
 * （4.1: API ではなくモデルの差）。欠けた項目は `null` にする。**`0` にしない**のは、
 * 「キャッシュを使ったが 0 トークンだった」と「そもそもキャッシュの概念が無い」を
 * 費用台帳（#22）が区別できなくなるためで、後者を `0` にすると
 * 「キャッシュヒットが 0 のまま推移している」（4.5 の異常検知）と見分けが付かない。
 */
export interface GenerationUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadInputTokens: number | null;
  readonly cacheWriteInputTokens: number | null;
}

/**
 * 生成の結果（3.3-3 の産物）。
 *
 * **どのモデルで生成したかを必ず含む。** #22 がモデル別単価で円換算し、モデルごとの
 * コンパイル失敗率を分析する（4.2）ため、後段が推測で埋められる情報ではない。
 * 型として必須にしてあるので、モデルを落とした実装はコンパイルが通らない。
 */
export interface GenerationResult {
  /** 使ったモデルの鍵。費用台帳が単価を引くのに使う。 */
  readonly modelKey: GenerationModelKey;
  /** 実際に Bedrock へ送ったモデル ID。鍵と併せて残す（推論プロファイルの取り違えが後から追える）。 */
  readonly modelId: string;
  /** モデルが返した本文。Go ソースとして扱うのは後段（5.2-5 の検査、3.3-5 のビルド）。 */
  readonly source: string;
  /** `usage` 4 種。 */
  readonly usage: GenerationUsage;
  /**
   * 生成が止まった理由（`end_turn` / `max_tokens` など）。
   *
   * **`max_tokens` で切れたソースはコンパイルできない。** ここで例外にせず値として
   * 返すのは、**費用が既に発生している**ためで、3.3 の順序では費用計上（3.3-4）が
   * この後に来る。判断は #20（リトライ）が持つ。
   */
  readonly stopReason: string;
}
