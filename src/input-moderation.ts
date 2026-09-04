/**
 * 入力側モデレーション（仕様 8.2 / #37）。
 *
 * **Amazon Bedrock Guardrails の `ApplyGuardrail` を、モデル呼び出しの直前に掛ける。**
 * 宣言（閾値・カテゴリ）は `terraform/moderation.tf` が持ち、ここは呼び出しと
 * 応答の読み取りだけを持つ。**閾値の値をここへ書き写さない。**
 *
 * ## なぜオーケストレータ側なのか
 *
 * エッジ（Cloudflare Pages）には Bedrock の資格情報が無い。`BEDROCK_AWS_*` は #160 で
 * Pages のシークレットから削除済みで、エッジで判定するには長命のアクセスキーを戻すことに
 * なる。**Lambda なら IAM ロールで済む**（`src/orchestrator/handler.ts` が Lambda の
 * 注入する `AWS_*` を `BEDROCK_AWS_*` へ写す）。
 *
 * **枠の消費は自動的に避けられる。** 枠は `generations` の行数で数え（確定25）、
 * その行を入れるのは LLM 呼び出しの**後**に走る `recordGenerationCost` である。
 * 呼び出しの前に落とせば行は最初から作られない。**「枠を消費しない」を別途実装しない。**
 *
 * ## 当てるのは利用者のプロンプト本文だけである
 *
 * **親ソースには当てない。** フォークのペイロードには親の `source.go` が最大 64KB
 * 載るが（5.3）、**ゲームのソースには `enemy` / `kill` / `shoot` / `damage` /
 * `bullet` が普通に現れる。丸ごと当てると暴力フィルタが構造的に誤爆する。**
 * 費用も 30 倍になる（1 TextUnit = 1,000 文字。プロンプトは 2,000 文字上限なので
 * 最大 2 ユニットに収まる）。
 *
 * ## 呼べないときは遮断側へ倒す（fail-closed）
 *
 * **通す側へ倒さない。** `src/denied-terms.ts` が書いているとおり、**確かめていない
 * 検査は、確かめた証拠として読まれるぶん赤より悪い。** ただし遮断の理由は分けて返す
 * ——利用者にできることが違うためである（下記）。
 *
 * | 起きたこと | 投げるもの | 分類名 | 利用者にできること |
 * |---|---|---|---|
 * | Guardrail が遮断した | {@link PromptBlocked} | `prompt-blocked` | **言い直す**（同じ内容では何度でも止まる） |
 * | 呼べなかった・応答が読めない | {@link ModerationUnavailable} | `internal` | **もう一度**（こちら側の問題で、内容は関係ない） |
 *
 * どちらもモデルへは到達しない。**混ぜると片方の文言が必ず誤りになる**
 * （`src/games.ts` が `build-timeout` を `build-failed` から分けたのと同じ理由）。
 */
import { AwsClient } from 'aws4fetch';
import { readBedrockCredentials } from './bedrock.js';
import type { GenerationResult } from './generation-models.js';

/**
 * `moderation_blocks.categories` の区切り文字（Unit Separator、U+001F）。
 *
 * **カテゴリ名に現れない文字を選ぶ。** 値の正本はここで、
 * `migrations/0016_moderation_blocks.sql` は**この定数を指しているだけ**である
 * （確定24 と同じ規約。書き写すと、変えた日に片方が古くなる）。
 */
export const MODERATION_CATEGORY_SEPARATOR = '\u001f';

/** 署名に使うサービス名。`src/bedrock.ts` と同じである。 */
const SIGNING_SERVICE = 'bedrock';

/** Guardrail の id と版を渡す環境変数。**正本は `terraform/moderation.tf` である。** */
export const MODERATION_ENV_NAMES = [
  'MODERATION_GUARDRAIL_ID',
  'MODERATION_GUARDRAIL_VERSION',
] as const;

/**
 * Guardrail のカテゴリ名を、利用者へ出す日本語へ写す。
 *
 * **8.2 が返す粒度はカテゴリ名までである**（検出箇所・スコア・閾値は返さない）。
 * ゲームという題材上、シューティング・格闘・ゾンビものが暴力フィルタに当たることが
 * 現実的な頻度で起きるので、**分類が分かれば言い直せる**必要がある。一方で検出箇所まで
 * 返すと回避の手がかりになる。
 *
 * **知らない鍵はそのまま出す。** AWS がカテゴリを増やしたときに、**分類名が消えて
 * 「何かに引っ掛かった」だけになる**ほうが困る。
 */
const CATEGORY_LABELS: Readonly<Record<string, string>> = {
  VIOLENCE: '暴力表現',
  HATE: '憎悪表現',
  INSULTS: '侮辱表現',
  SEXUAL: '性的表現',
  MISCONDUCT: '違法・危険な行為',
  PROMPT_ATTACK: '指示の乗っ取り',
};

/**
 * カテゴリ名を日本語へ写す。
 *
 * @param type Guardrail が返した鍵
 * @returns 表示名（知らない鍵はそのまま）
 */
export function categoryLabelOf(type: string): string {
  return Object.prototype.hasOwnProperty.call(CATEGORY_LABELS, type)
    ? CATEGORY_LABELS[type]!
    : type;
}

/** Guardrail が入力を遮断した（8.2）。 */
export class PromptBlocked extends Error {
  /** 遮断の理由になったカテゴリの表示名。**空にならない**（下記の読み取りが保証する）。 */
  readonly categories: readonly string[];

  /**
   * @param categories カテゴリの表示名
   */
  constructor(categories: readonly string[]) {
    // **本文をメッセージへ入れない。** ここはログへ出る（8.2 / 8.3 の「ログも外である」）。
    super(`prompt blocked: ${categories.join(', ')}`);
    this.name = 'PromptBlocked';
    this.categories = categories;
  }
}

/** Guardrail を呼べなかった。**遮断側へ倒すが、分類は `internal` である**（上記）。 */
export class ModerationUnavailable extends Error {
  /**
   * @param detail ログへ出してよい 1 行
   */
  constructor(detail: string) {
    super(`moderation unavailable: ${detail}`);
    this.name = 'ModerationUnavailable';
  }
}

/**
 * `ApplyGuardrail` のエンドポイントを組み立てる。
 *
 * **id と版は経路に現れる。** どちらも `encodeURIComponent` に通す——版は数字だが、
 * id は AWS が決める不透明な文字列である。
 *
 * @param region リージョン
 * @param guardrailId Guardrail の id
 * @param version 版
 * @returns URL
 */
export function applyGuardrailEndpoint(
  region: string,
  guardrailId: string,
  version: string,
): string {
  return (
    `https://bedrock-runtime.${region}.amazonaws.com/guardrail/` +
    `${encodeURIComponent(guardrailId)}/version/${encodeURIComponent(version)}/apply`
  );
}

/**
 * `ApplyGuardrail` の応答から、遮断されたカテゴリの表示名を取り出す。
 *
 * **形が読めなければ「遮断されていない」ではなく「読めない」を返す。** 静かに
 * 空を返すと、**応答の形が変わった日にモデレーションが黙って素通しになる**
 * （`src/denied-terms.ts` と `scripts/usage-report.sh` が繰り返し避けている形）。
 *
 * @param payload 応答の JSON
 * @returns 遮断されたなら表示名の配列、遮断されていなければ空配列
 * @throws {ModerationUnavailable} 応答の形が読めないとき
 */
export function readGuardrailBlocks(payload: unknown): readonly string[] {
  if (typeof payload !== 'object' || payload === null) {
    throw new ModerationUnavailable('応答が object ではありません');
  }
  const record = payload as Record<string, unknown>;
  const action = record['action'];
  if (typeof action !== 'string') {
    throw new ModerationUnavailable('応答に action がありません');
  }
  if (action !== 'GUARDRAIL_INTERVENED') {
    return [];
  }

  const assessments = record['assessments'];
  if (!Array.isArray(assessments)) {
    throw new ModerationUnavailable('遮断されたが assessments がありません');
  }

  const found: string[] = [];
  for (const assessment of assessments) {
    if (typeof assessment !== 'object' || assessment === null) {
      continue;
    }
    const policies = assessment as Record<string, unknown>;
    for (const key of ['contentPolicy', 'topicPolicy', 'wordPolicy']) {
      const policy = policies[key];
      if (typeof policy !== 'object' || policy === null) {
        continue;
      }
      const filters = (policy as Record<string, unknown>)['filters'];
      if (!Array.isArray(filters)) {
        continue;
      }
      for (const filter of filters) {
        if (typeof filter !== 'object' || filter === null) {
          continue;
        }
        const entry = filter as Record<string, unknown>;
        // **`action` を見る。** 検出されたが遮断していない（`NONE`）ものを混ぜると、
        // 止まっていない理由まで利用者へ出ることになる。
        if (entry['action'] !== 'BLOCKED') {
          continue;
        }
        const type = entry['type'];
        if (typeof type !== 'string') {
          continue;
        }
        const label = categoryLabelOf(type);
        if (!found.includes(label)) {
          found.push(label);
        }
      }
    }
  }

  if (found.length === 0) {
    // **遮断されたのに理由が読めない。** 「遮断されていない」に倒すと素通しになる。
    throw new ModerationUnavailable('遮断されたが、理由のカテゴリを読み取れません');
  }
  return found;
}

/** 差し替えられる依存（テスト用）。 */
export interface InputModerationDependencies {
  /**
   * 送信に使う `fetch`。既定はグローバル。
   *
   * **署名済みの `Request` を受け取る形にする**（`src/bedrock.ts` の
   * `BedrockDependencies` と同じ）。揃えておかないと、オーケストレータが
   * 1 つの stub を両方へ渡せない。
   */
  readonly fetch?: (request: Request) => Promise<Response>;
}

/**
 * プロンプトを Guardrail に掛ける。**通れば何も返さない。**
 *
 * @param env バインディングと環境変数
 * @param prompt 利用者が書いたプロンプト（**親ソースを混ぜないこと**）
 * @param deps 差し替えられる依存
 * @throws {PromptBlocked} 遮断されたとき
 * @throws {ModerationUnavailable} 呼べない・応答が読めないとき
 */
export async function applyInputModeration(
  env: Env,
  prompt: string,
  deps: InputModerationDependencies = {},
): Promise<void> {
  const values = env as unknown as Record<string, string | undefined>;
  const missing = MODERATION_ENV_NAMES.filter((name) => {
    const value = values[name];
    return typeof value !== 'string' || value.trim() === '';
  });
  if (missing.length > 0) {
    // **素通しにしない。** 設定が抜けている状態は「検査していない」であって
    // 「検査して通った」ではない（冒頭の表）。
    throw new ModerationUnavailable(`環境変数が足りません: ${missing.join(', ')}`);
  }

  let credentials;
  try {
    credentials = readBedrockCredentials(env);
  } catch (error) {
    throw new ModerationUnavailable(
      error instanceof Error ? `${error.name}: ${error.message}` : String(error),
    );
  }

  const aws = new AwsClient({
    accessKeyId: credentials.accessKeyId,
    secretAccessKey: credentials.secretAccessKey,
    sessionToken: credentials.sessionToken,
    service: SIGNING_SERVICE,
    region: credentials.region,
  });

  const url = applyGuardrailEndpoint(
    credentials.region,
    values['MODERATION_GUARDRAIL_ID']!.trim(),
    values['MODERATION_GUARDRAIL_VERSION']!.trim(),
  );
  const body = JSON.stringify({
    source: 'INPUT',
    content: [{ text: { text: prompt } }],
  });

  const send = deps.fetch ?? ((request: Request) => fetch(request));
  let response: Response;
  try {
    const signed = await aws.sign(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body,
    });
    response = await send(signed);
  } catch (error) {
    throw new ModerationUnavailable(
      error instanceof Error ? `${error.name}: ${error.message}` : String(error),
    );
  }

  if (!response.ok) {
    // **本文を持ち出さない。** 状態コードだけをログへ出す（8.3 の「ログも外である」）。
    throw new ModerationUnavailable(`HTTP ${response.status}`);
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch (error) {
    throw new ModerationUnavailable(
      error instanceof Error ? `${error.name}: ${error.message}` : String(error),
    );
  }

  const blocked = readGuardrailBlocks(payload);
  if (blocked.length > 0) {
    throw new PromptBlocked(blocked);
  }
}

/**
 * 生成の段を、入力側モデレーションで包む（8.2 / #37）。
 *
 * **`withBuildDiagnostics` / `withTidyInstruction` と同じ形の継ぎ目である**
 * （`src/generate.ts`）。トランスポート（`src/bedrock.ts`）はモデレーションの存在を
 * 知らないままでよく、包む側が手前で止める。
 *
 * **いちばん外側に置く。** 内側に置くと、整理パスの指示や再試行の診断が織り込まれた
 * **後**のプロンプトを検査することになる——**利用者が書いていない文字列で遮断が
 * 起きうる。** 検査するのは 5.1 の入力そのものである。
 *
 * **`request.baseSource` には当てない**（冒頭の但し書き）。ここが `request.prompt`
 * だけを渡していることが、その保証そのものである。
 *
 * @param generate 包まれる生成の段
 * @param options 遮断したときの記録先と、差し替えられる依存
 * @returns 包んだ生成の段
 */
export function withInputModeration(
  generate: (
    env: Env,
    request: { readonly prompt: string; readonly baseSource?: string },
  ) => Promise<GenerationResult>,
  options: {
    /**
     * 遮断を記録する。**失敗しても遮断は続行する**——記録が書けないことを理由に
     * 素通しにしない（`src/denied-terms.ts` の規律）。
     */
    readonly record?: (categories: readonly string[], prompt: string) => Promise<unknown>;
  } & InputModerationDependencies = {},
): (
  env: Env,
  request: { readonly prompt: string; readonly baseSource?: string },
) => Promise<GenerationResult> {
  return async (env, request) => {
    try {
      await applyInputModeration(env, request.prompt, options);
    } catch (error) {
      if (error instanceof PromptBlocked && options.record !== undefined) {
        try {
          await options.record(error.categories, request.prompt);
        } catch (recordError) {
          // **記録の失敗で遮断を取り下げない。** ログだけ残して、そのまま投げ直す。
          console.warn(
            `[input-moderation] 遮断の記録に失敗しました: ${
              recordError instanceof Error
                ? `${recordError.name}: ${recordError.message}`
                : String(recordError)
            }`,
          );
        }
      }
      throw error;
    }
    return await generate(env, request);
  };
}
