/**
 * オーケストレータ Lambda の**器を作るためだけの仮のコード**（#160）。
 *
 * ## なぜ仮のコードが要るのか
 *
 * `aws_lambda_function` は作成時にコードの実体を要求する。本物のコードは
 * TypeScript を束ねた成果物（`scripts/bundle-orchestrator.sh` が作る
 * `dist/orchestrator.zip`）で、**再生成できる成果物はコミットしない**
 * （shared-ai-rules 2 章）。宣言が追跡外のファイルを指すと、チェックアウト直後の
 * `terraform plan` が落ちる。
 *
 * したがって宣言が持つのは**この仮のコードだけ**で、本物は
 * `aws lambda update-function-code` が載せる（`docs/orchestrator.md`）。
 * `aws_lambda_function.orchestrator` は `filename` と `source_code_hash` を
 * `ignore_changes` に入れており、**配備のたびに plan へ差分が出ない**
 * （`terraform/build-function.tf` の `image_uri` と同じ形）。
 *
 * ## 成功しない
 *
 * **空の関数にしない。** 空にすると、まだ配備していない状態で投げられたジョブが
 * 「成功したが何も起きていない」形になり、`games` 行は `pending` のまま残る。
 * ここで投げれば、基盤のリトライは 0 なので**そのまま OnFailure destination（SQS）へ
 * 出る**——「まだ配備していない」ことが運用に見える。
 *
 * `src/generate.ts` 冒頭の「空実装を成功にしない」と同じ判断である。
 */

/**
 * まだ本物のコードが載っていないことを知らせる。
 *
 * @throws {Error} 常に
 */
export async function handler() {
  throw new Error(
    'orchestrator: placeholder code is deployed. Run scripts/deploy-orchestrator.sh (see docs/orchestrator.md).',
  );
}
