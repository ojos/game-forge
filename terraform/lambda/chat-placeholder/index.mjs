/**
 * チャットの関数の**器を作るためだけの仮のコード**（#695 / 仕様 5.16）。
 *
 * `terraform/lambda/orchestrator-placeholder/index.mjs` と同じ理由で置く——`aws_lambda_function` は
 * 作成時にコードの実体を要求するが、本物（`scripts/bundle-chat.sh` が束ねた zip）は再生成できる
 * 成果物で、コミットしない。本物は `scripts/deploy-chat.sh` が載せる。
 *
 * ## 成功しない
 *
 * **返答を返さずに「断った」とも言わない。** 投げればエッジは `X-Amz-Function-Error` を受けて
 * 500 を返す（`src/chat-client.ts`）——「まだ配備していない」ことが利用者にも運用にも見える。
 * `{ ok: false, error: 'internal' }` を返すと、配備忘れと本番の一時的な失敗が同じ形になる。
 */

/**
 * まだ本物のコードが載っていないことを知らせる。
 *
 * @throws {Error} 常に
 */
export async function handler() {
  throw new Error('chat: placeholder code is deployed. Run scripts/deploy-chat.sh.');
}
