/**
 * アイコンの再エンコード関数の**器を作るためだけの仮のコード**（#380）。
 *
 * `terraform/lambda/orchestrator-placeholder/index.mjs` と同じ理由で置く——`aws_lambda_function` は作成時に
 * コードの実体を要求するが、本物（`lambda/avatar-encode/` に sharp を入れた zip）は再生成できる成果物で、
 * コミットしない。本物は `scripts/deploy-avatar.sh` が載せる。
 *
 * ## 成功しない
 *
 * **画像を返さずに「断った」とも言わない。** 投げれば Worker は `X-Amz-Function-Error` を受けて
 * 「保存できませんでした」と出す（`src/avatar-client.ts`）——「まだ配備していない」ことが利用者にも
 * 運用にも見える。
 */

/**
 * まだ本物のコードが載っていないことを知らせる。
 *
 * @throws {Error} 常に
 */
export async function handler() {
  throw new Error('avatar-encode: placeholder code is deployed. Run scripts/deploy-avatar.sh.');
}
