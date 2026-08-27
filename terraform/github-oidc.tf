/**
 * GitHub Actions から AWS を触るための OIDC 連携（9.3 / #103）。
 *
 * ## なぜアクセスキーではないのか
 *
 * 9.3 は `deploy-compiler.yml` から ECR へ push し、関数のイメージを更新すると定める。
 * そのために Actions は AWS の資格情報を要る。**長命のアクセスキーを GitHub の
 * Secrets へ置く形は採らない。**
 *
 *   - terraform/bedrock.tf が `aws_iam_access_key` を宣言しないのと**同じ論法**である。
 *     宣言すれば秘密鍵が tfstate へ平文で落ち、宣言しなければ「宣言に無い長命の鍵が
 *     どこかにある」状態になる。どちらも避けたい。
 *   - OIDC は**鍵を作らない。** 交換されるのは 1 回の実行だけ有効な一時資格情報で、
 *     tfstate にも GitHub の Secrets にも秘密が残らない。**宣言だけで完結する。**
 *
 * これは `.github/project-ai-rules.md`「トークンをファイルへ書き写さず、ツール自身の
 * ログイン状態に持たせる」を、CI 側で成立させる形でもある。
 *
 * ## Control Tower 配下であることの留意
 *
 * SCP が `iam:CreateOpenIDConnectProvider` を拒否しうる。apply が AccessDenied で
 * 落ちたときは権限不足ではなく SCP を先に疑うこと（terraform/bedrock-guard.tf）。
 */

locals {
  github_oidc_url = "https://token.actions.githubusercontent.com"

  /**
   * 引き受けを許す GitHub の実行主体（OIDC トークンの `sub`）。
   *
   * **既定ブランチ上の実行に限る。** ここを `repo:owner/repo:*` にすると、
   * **フォークからの pull request やタグからの実行でも本番へ配れる。**
   * 綴りは宣言済みの変数から組み立て、ワークフロー側と食い違わせない。
   *
   * `workflow_dispatch` を手で回した場合も、対象が既定ブランチなら同じ `sub` になる
   * ので、`deploy-compiler.yml` の手動実行はこの条件を満たす。
   */
  github_deploy_subject = "repo:${var.github_owner}/${var.repository_name}:ref:refs/heads/${var.default_branch}"

  deploy_compiler_role_name = "game-forge-deploy-compiler"
}

/**
 * GitHub Actions の OIDC プロバイダ。
 *
 * **thumbprint_list を宣言しない。** 2023 年 7 月以降、AWS は
 * `token.actions.githubusercontent.com` の証明書チェーンを信頼済みルート CA で検証し、
 * **thumbprint を参照しない**。書くと、GitHub 側の中間証明書が更新された日に
 * 「宣言にある古い指紋」と実際が食い違い、**更新の必要が無いのに更新が必要に見える**
 * 状態を作る。
 *
 * client_id_list（`aud`）は `sts.amazonaws.com` の 1 つだけにする。
 * aws-actions/configure-aws-credentials が既定で要求する値である。
 */
resource "aws_iam_openid_connect_provider" "github" {
  url             = local.github_oidc_url
  client_id_list  = ["sts.amazonaws.com"]
  thumbprint_list = []

  tags = {
    Project   = "game-forge"
    ManagedBy = "terraform"
    Purpose   = "OIDC trust for GitHub Actions - spec 9.3"
  }
}

data "aws_iam_policy_document" "deploy_compiler_assume" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRoleWithWebIdentity"]

    principals {
      type        = "Federated"
      identifiers = [aws_iam_openid_connect_provider.github.arn]
    }

    # **aud と sub の両方を見る。** aud だけだと、この OIDC プロバイダを信頼する
    # 限りどのリポジトリの実行でも引き受けられる。
    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:aud"
      values   = ["sts.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:sub"
      values   = [local.github_deploy_subject]
    }
  }
}

/**
 * 配備用ロール。**できることは 2 つだけである。**
 *
 *   1. ビルドイメージのリポジトリへ push する
 *   2. ビルド関数のイメージを差し替える
 *
 * `ecr:GetAuthorizationToken` だけは resources を絞れない（AWS がアカウント単位の
 * 動作として定義しているため）。**それ以外はすべて対象を 1 つに固定する。**
 * とくに `lambda:UpdateFunctionCode` を `*` にすると、**費用ガードの層 2 の関数
 * （bedrock-guard）を CI から差し替えられる**ことになる（4.3）。
 *
 * `lambda:GetFunction` を含めるのは、ワークフローが更新後の実物を読んで、
 * 配ったダイジェストが載ったことを確かめるためである（9.3 の「配備の対象は
 * イメージのダイジェストである」）。
 */
data "aws_iam_policy_document" "deploy_compiler" {
  statement {
    sid       = "AuthenticateToEcr"
    effect    = "Allow"
    actions   = ["ecr:GetAuthorizationToken"]
    resources = ["*"]
  }

  statement {
    sid    = "PushTheBuildImage"
    effect = "Allow"

    actions = [
      "ecr:BatchCheckLayerAvailability",
      "ecr:BatchGetImage",
      "ecr:CompleteLayerUpload",
      "ecr:DescribeImages",
      "ecr:GetDownloadUrlForLayer",
      "ecr:InitiateLayerUpload",
      "ecr:PutImage",
      "ecr:UploadLayerPart",
    ]

    resources = [aws_ecr_repository.isolated_build.arn]
  }

  statement {
    sid    = "UpdateTheBuildFunction"
    effect = "Allow"

    actions = [
      "lambda:GetFunction",
      # 更新は非同期に完了する。`aws lambda wait function-updated` がこれを呼ぶ。
      # 待たずに次へ進むと「配ったが載る前に緑になった」状態を作れる。
      "lambda:GetFunctionConfiguration",
      "lambda:UpdateFunctionCode",
    ]

    resources = [aws_lambda_function.build.arn]
  }
}

resource "aws_iam_role" "deploy_compiler" {
  name               = local.deploy_compiler_role_name
  path               = "/service/"
  assume_role_policy = data.aws_iam_policy_document.deploy_compiler_assume.json

  tags = {
    Project   = "game-forge"
    ManagedBy = "terraform"
    Purpose   = "GitHub Actions deploys the build image - spec 9.3 / issue 103"
  }
}

resource "aws_iam_role_policy" "deploy_compiler" {
  name   = "deploy-compiler"
  role   = aws_iam_role.deploy_compiler.id
  policy = data.aws_iam_policy_document.deploy_compiler.json
}
