/**
 * 入力変数。
 *
 * 機密は含めない。GitHub のトークンは環境変数 GITHUB_TOKEN で渡す（providers.tf 参照）。
 * 値の指定は terraform.tfvars（.gitignore で追跡除外）または TF_VAR_ 環境変数で行う。
 */

variable "github_owner" {
  description = "リポジトリの所有者（ユーザー名または Organization 名）。"
  type        = string
  default     = "ojos"

  validation {
    condition     = length(var.github_owner) > 0
    error_message = "github_owner を空にはできません。"
  }
}

variable "repository_name" {
  description = "作成するリポジトリ名。"
  type        = string
  default     = "game-forge"

  validation {
    condition     = can(regex("^[A-Za-z0-9._-]+$", var.repository_name))
    error_message = "repository_name には英数字と . _ - のみを使用できます。"
  }
}

variable "repository_description" {
  description = "リポジトリの説明文。"
  type        = string
  /**
   * **既定値を実態に合わせた**（#714。2026-09-20）。
   *
   * 既定は DCB の雛形の文面（「AI エージェント運用ルールとレビュー機構を備えた開発リポジトリ」）のままで、
   * **GitHub 側は画面から書き換えられていた。** そのため全体 apply が**実態を雛形の文面へ戻そうとしていた**
   * （`terraform plan` が `0 to add, 1 to change, 0 to destroy`）。
   *
   * **`terraform/main.tf` が「手動変更は宣言へ後追いで反映する」と定めている**ので、実態を消すのではなく
   * 宣言を合わせる。**`terraform.tfvars` ではなくここへ置く**——あちらは追跡外で、値がリポジトリから読めなくなる
   * （説明文は環境ごとに変える値でもない）。
   */
  default = "プロンプト 1 行からブラウザで遊べる 2D ゲームを生成し、作品を改造（フォーク）して公開し合う UGC コミュニティ。Go（Ebitengine）→ WebAssembly、Cloudflare Pages + AWS Lambda / Bedrock 構成。"
}

variable "default_branch" {
  description = "既定ブランチ名。ブランチ保護の対象パターンにも使う。"
  type        = string
  default     = "main"
}

variable "required_status_checks" {
  description = <<-EOT
    既定ブランチのマージに必須とするステータスチェック名（ワークフローのジョブ名）。

    review-gate は意図的に含めない。.github/workflows/review-gate.yml が
    「required check にはしない」と定めているため（レビュー機構側の遅延や障害で
    マージが止まる副作用を避ける）。
  EOT
  type        = list(string)
  default     = ["verify", "verify-commit-identity"]
}

variable "allowed_author_emails" {
  description = <<-EOT
    Actions 変数 ALLOWED_AUTHOR_EMAILS の値。カンマ区切りで複数指定できる。

    .github/workflows/identity-guard.yml と verify.yml が参照し、コミット author の
    email を照合する。固有の email をワークフローへ焼き込まないための変数。
    機密ではないが、リポジトリ固有の値なので既定値は置かない。
  EOT
  type        = string

  validation {
    condition     = length(trimspace(var.allowed_author_emails)) > 0
    error_message = "allowed_author_emails を空にはできません。ワークフローの照合が全件不一致になります。"
  }
}

variable "aws_region" {
  description = <<-EOT
    AWS プロバイダのリージョン。

    Route53 はグローバルサービスだがプロバイダはリージョンを要求する。SSO の
    設定（~/.aws/config）と揃えておくと、CLI から手で確認するときに食い違わない。
  EOT
  type        = string
  default     = "ap-northeast-1"
}

variable "aws_account_id_prod" {
  description = <<-EOT
    本番 AWS アカウント（game-forge-prod）のアカウント ID。

    provider "aws" の allowed_account_ids に渡し、別アカウントのプロファイルで
    この宣言を適用しようとしたときに apply を失敗させる。

    機密ではないが、このリポジトリは公開であり公開する必要も無いため、宣言へ
    直接書かず terraform.tfvars（*.tfvars は追跡外）から受ける。既定値は置かない。
  EOT
  type        = string

  validation {
    condition     = can(regex("^[0-9]{12}$", var.aws_account_id_prod))
    error_message = "aws_account_id_prod は 12 桁の数字である必要があります。"
  }
}

variable "aws_account_id_dev" {
  description = <<-EOT
    開発 AWS アカウント（game-forge-dev）のアカウント ID。

    provider "aws.dev" の allowed_account_ids に渡す。用途は Bedrock の
    開発用の枠だけである（#82 / #81）。

    aws_account_id_prod と同じ理由で宣言へ直接書かず terraform.tfvars から受ける。
  EOT
  type        = string

  validation {
    condition     = can(regex("^[0-9]{12}$", var.aws_account_id_dev))
    error_message = "aws_account_id_dev は 12 桁の数字である必要があります。"
  }
}

variable "aws_profile_dev" {
  description = <<-EOT
    開発 AWS アカウントへ接続する SSO プロファイル名。

    **これは資格情報ではなく選択子である。** 実体は ~/.aws/config と SSO の
    キャッシュにあり、この宣言には秘密が入らない。providers.tf が避けているのは
    「資格情報を変数で受けて tfstate や plan へ平文で落とすこと」であって、
    どのプロファイルを使うかの表明ではない。

    prod 側は従来どおり環境変数 AWS_PROFILE で選ぶ。ここだけ明示するのは、
    1 回の apply で 2 つのアカウントを触るため、環境変数では両方を選べないからである。
  EOT
  type        = string
  default     = "game-forge-dev"
}

variable "dns_zone_name" {
  description = <<-EOT
    Route53 で管理する DNS ゾーン名（確定16 / 確定17）。

    さくらのドメイン（ojos.jp）からこのゾーンへ NS 委譲する。さくら側の NS 登録だけは
    API が無いため手動だが、委譲後の恒久的な状態は Route53 側＝この宣言が持つ。
  EOT
  type        = string
  default     = "game-forge.ojos.jp"
}

variable "gcp_org_id" {
  description = <<-EOT
    GCP 組織（ojos.jp）の ID。数字のみ。

    google_project の org_id に渡し、作成するプロジェクトを組織配下へ置く。組織を
    指定しないプロジェクトは所有者個人に紐づき、退職・アカウント削除で失われる。

    機密ではないが、このリポジトリは公開であり公開する必要も無いため、aws_account_id_prod
    と同じ扱いで宣言へ直接書かず terraform.tfvars（*.tfvars は追跡外）から受ける。

    確認方法: gcloud organizations list
  EOT
  type        = string

  validation {
    condition     = can(regex("^[0-9]+$", var.gcp_org_id))
    error_message = "gcp_org_id は数字のみである必要があります（組織名ではなく ID）。"
  }
}

variable "gcp_project_id" {
  description = <<-EOT
    GCP プロジェクト ID。全世界で一意、かつ作成後は変更できない。

    変更して apply すると、既存プロジェクトの改名ではなく別プロジェクトの新規作成に
    なる。配下の OAuth クライアントは移動しないため、実機のログインが壊れる。
  EOT
  type        = string
  default     = "ojos-game-forge"

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{4,28}[a-z0-9]$", var.gcp_project_id))
    error_message = "gcp_project_id は小文字英字で始まり、小文字英数字とハイフンのみ、6〜30 文字である必要があります。"
  }
}

variable "gcp_billing_account" {
  description = <<-EOT
    本番の GCP プロジェクト（gcp_project_id）に紐付ける請求先アカウントの ID（#487）。
    Google の形式どおり、大文字英数字 6 桁をハイフンで 3 つつないだもの。
    "billingAccounts/" の接頭辞は付けない。

    google_project の billing_account に渡す。2026-09-14 に利用者が Google OAuth の
    ブランド確認のために Console で紐付けたものを、宣言へ取り込んだ（gcp.tf の注記）。

    **既定値は置かない。** 値の無い環境で plan / apply すると、紐付けを外す差分になり、
    ブランド確認に影響しうるためである。必須にしておけば、値が無いときは差分を出す前に
    変数の不足で止まる。

    機密ではないが、このリポジトリは公開であり公開する必要も無いため、aws_account_id_prod
    と同じ扱いで宣言へ直接書かず terraform.tfvars（*.tfvars は追跡外）から受ける。
  EOT
  type        = string

  validation {
    condition     = can(regex("^[0-9A-Z]{6}-[0-9A-Z]{6}-[0-9A-Z]{6}$", var.gcp_billing_account))
    error_message = "gcp_billing_account は大文字英数字 6 桁をハイフンで 3 つつないだ形式である必要があります（billingAccounts/ の接頭辞は付けない）。"
  }
}

variable "gcp_project_name" {
  description = "GCP プロジェクトの表示名。ID と違い後から変更できる。"
  type        = string
  default     = "game-forge"
}

variable "gcp_dev_project_id" {
  description = <<-EOT
    開発用の GCP プロジェクト ID（#479）。ローカル開発のログインに使う OAuth クライアントの発行先。

    gcp_project_id と同じく、全世界で一意、かつ作成後は変更できない。2026-09-14 に
    Console で手作成したものを取り込んだので、既定値は実在するプロジェクトの ID である。
    **変えると、取り込みではなく別プロジェクトの新規作成（置き換え）の差分になる。**
    gcp.tf の import ブロックの id も同じ値を文字列で持っているので、変えるときは両方を変える。
  EOT
  type        = string
  default     = "ojos-game-forge-dev"

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{4,28}[a-z0-9]$", var.gcp_dev_project_id))
    error_message = "gcp_dev_project_id は小文字英字で始まり、小文字英数字とハイフンのみ、6〜30 文字である必要があります。"
  }
}

variable "gcp_dev_project_name" {
  description = <<-EOT
    開発用の GCP プロジェクトの表示名（#479）。ID と違い後から変更できる。

    既定値は Console で手作成したときの表示名（2026-09-14 に Resource Manager API で読んだ値）。
    違う値にすると、取り込みの plan に表示名を変える in-place の差分が出る。
  EOT
  type        = string
  default     = "game-forge-dev"
}

variable "gcp_dev_billing_account" {
  description = <<-EOT
    開発用の GCP プロジェクト（gcp_dev_project_id）に紐付いている請求先アカウントの ID（#479）。
    形式は gcp_billing_account と同じ（大文字英数字 6 桁をハイフンで 3 つ。"billingAccounts/" は付けない）。

    google_project.game_forge_dev の billing_account に渡す。2026-09-14 に Console で
    プロジェクトを作成したときに自動で紐付いたもので、利用者の判断で残し、宣言を実物に合わせた
    （gcp.tf の注記）。

    **本番と同じアカウントかどうかは宣言で決め打ちしない。** いまは同じ値だが、本番の
    gcp_billing_account を流用すると、片方だけを付け替えたときに黙ってもう片方の差分になる。

    **既定値は置かない。** 値の無い環境で plan / apply すると、紐付けを外す差分になるためである。
    必須にしておけば、値が無いときは差分を出す前に変数の不足で止まる。

    機密ではないが、このリポジトリは公開であり公開する必要も無いため、gcp_billing_account と
    同じ扱いで宣言へ直接書かず terraform.tfvars（*.tfvars は追跡外）から受ける。
  EOT
  type        = string

  validation {
    condition     = can(regex("^[0-9A-Z]{6}-[0-9A-Z]{6}-[0-9A-Z]{6}$", var.gcp_dev_billing_account))
    error_message = "gcp_dev_billing_account は大文字英数字 6 桁をハイフンで 3 つつないだ形式である必要があります（billingAccounts/ の接頭辞は付けない）。"
  }
}

variable "cloudflare_pages_project" {
  description = <<-EOT
    Cloudflare Pages のプロジェクト名（#89）。

    Pages プロジェクトそのものは Terraform の管理対象ではない（wrangler で作る。
    docs/pages-deploy.md）。ここで受けるのは、カスタムドメインが要求する CNAME の
    向き先 "<project>.pages.dev" を組み立てるための識別子だけである。

    機密ではない。値を変えるとアプリの向き先が変わるため、既定値を置いて宣言の中で
    完結させる（tfvars を書き忘れた環境が、黙って別の向き先を作らないようにする）。
  EOT
  type        = string
  default     = "game-forge"

  validation {
    condition     = can(regex("^[a-z0-9][a-z0-9-]*$", var.cloudflare_pages_project))
    error_message = "cloudflare_pages_project には英小文字・数字・ハイフンのみを使用できます。"
  }
}

variable "budget_notification_email" {
  description = <<-EOT
    費用ガードの層 3（AWS Budgets）が通知を送る宛先（#82 / 仕様 4.3）。

    **AWS Budgets Actions は subscriber を必須項目としている**ため、省略できない。
    80% の警告も 100% の停止（Deny の付与）も、この 1 か所へ届く。

    **機密ではないが宣言へ直接書かない。** aws_account_id_prod と同じ理由で、
    このリポジトリは公開であり、個人のメールアドレスを公開する必要が無いため。
    値は terraform.tfvars（*.tfvars は追跡外）に置く。既定値は置かない。

    **SNS を挟まない理由。** SNS のメール購読は購読者本人の確認クリックを要し、
    宣言しても確認が済むまで届かない。「宣言は緑なのに通知だけ来ない」状態を作らない
    ため、Budgets が直接メールを送る経路にしてある。
  EOT
  type        = string

  validation {
    condition     = can(regex("^[^@[:space:]]+@[^@[:space:]]+\\.[^@[:space:]]+$", var.budget_notification_email))
    error_message = "budget_notification_email はメールアドレスの形式である必要があります。"
  }
}

variable "cloudflare_account_id" {
  description = <<-EOT
    Cloudflare のアカウント ID。

    R2 のライフサイクル宣言（terraform/r2-lifecycle.tf）が要求する。API トークンは
    プロバイダが環境変数 CLOUDFLARE_API_TOKEN から読むため、ここには**資格情報を
    置かない**（providers.tf の注記）。

    aws_account_id_prod と同じ理由で宣言へ直接書かず terraform.tfvars から受ける。
    値は .env の CLOUDFLARE_ACCOUNT_ID と同じもので、機密ではないが公開する必要も無い。
  EOT
  type        = string

  validation {
    condition     = can(regex("^[0-9a-f]{32}$", var.cloudflare_account_id))
    error_message = "cloudflare_account_id は 16 進 32 桁である必要があります。"
  }
}

variable "cloudflare_zero_trust_team_name" {
  description = <<-EOT
    Cloudflare Zero Trust のチーム名（#792 / M22-2）。

    Access のログインが載る `<team>.cloudflareaccess.com` の左端である。
    terraform/zero-trust.tf の auth_domain と、terraform/tunnel-dev01.tf の
    ingress の origin_request.access.team_name の両方がこの 1 か所から導かれる。

    **後から変えられないものとして扱う。** 変えると Access のログイン URL が全部変わり、
    手元の ~/.ssh/config へ書き写した `cloudflared access ssh --hostname` の設定と、
    コネクタ側の検査（team_name）が一斉にずれる。

    cloudflare_account_id と同じ理由で宣言へ直接書かず terraform.tfvars から受ける
    （機密ではないが、このリポジトリは公開であり、公開する必要が無い）。
  EOT
  type        = string

  validation {
    condition     = can(regex("^[a-z0-9][a-z0-9-]*$", var.cloudflare_zero_trust_team_name))
    error_message = "cloudflare_zero_trust_team_name には英小文字・数字・ハイフンのみを使用できます。"
  }
}

variable "zero_trust_google_client_id" {
  description = <<-EOT
    Zero Trust の ID プロバイダ（Google Workspace）が使う OAuth クライアント ID（#792）。

    **GCP コンソールで作る。** API では作れないため、docs/gcp-oauth-setup.md の既存の
    2 つ（本番・開発）と同じく手作業になる。**この 3 つ目は用途が違う**——前 2 つは
    アプリのログイン、これは運営が機械へ入るための認証である。

    機密ではない（クライアント ID は公開される値）が、宣言へ書かず tfvars から受ける。
  EOT
  type        = string

  validation {
    condition     = can(regex("\\.apps\\.googleusercontent\\.com$", var.zero_trust_google_client_id))
    error_message = "zero_trust_google_client_id は .apps.googleusercontent.com で終わる必要があります。"
  }
}

variable "zero_trust_google_client_secret" {
  description = <<-EOT
    上のクライアントのシークレット（#792）。**機密である。**

    値は terraform.tfvars（追跡外）に置く。**リソースの属性なので、どう渡しても
    tfstate には平文で入る**（terraform/providers.tf が CLOUDFLARE_API_TOKEN を
    変数で受けないのとは事情が違う。あれはプロバイダ自身が環境変数を読むので
    宣言に現れないが、これは宣言が持つ値である）。tfstate は .gitignore で
    追跡から外れており、既に他の機密を持っている。
  EOT
  type        = string
  sensitive   = true
}

variable "zero_trust_operator_emails" {
  description = <<-EOT
    SSH の口（dev01-ssh.ojos.jp）へ入れる人のメールアドレス（#792）。
    ojos.jp の Google Workspace のアカウントであること。

    **ドメインで括らず名指しにしている理由**は terraform/tunnel-dev01.tf の
    dev01_ssh_operator の注記にある。いまは 1 人でも、増えるときに宣言が増えることに
    意味がある。

    budget_notification_email と同じ理由で宣言へ直接書かない（個人のメールアドレスを
    公開する必要が無い）。
  EOT
  type        = list(string)

  validation {
    condition     = length(var.zero_trust_operator_emails) > 0
    error_message = "zero_trust_operator_emails には少なくとも 1 件が必要です（空だと誰も入れません）。"
  }

  validation {
    condition     = alltrue([for e in var.zero_trust_operator_emails : can(regex("^[^@[:space:]]+@ojos\\.jp$", e))])
    error_message = "zero_trust_operator_emails は ojos.jp のメールアドレスである必要があります。"
  }
}

variable "gcp_ops_project_id" {
  description = <<-EOT
    運用向けの GCP プロジェクトの ID（#792 / M22-2）。

    Cloudflare Zero Trust の ID プロバイダが使う OAuth クライアントを置く入れ物で、
    **game-forge のアプリとは関わらない**（理由は terraform/gcp.tf の注記）。

    **プロジェクト ID は GCP 全体で一意である。** 既に誰かが使っていると apply が
    「already in use」で落ちる。そのときは別の ID を tfvars で与えること。
  EOT
  type        = string
  default     = "ojos-ops"

  # GCP の規則（英小文字で始まり、英小文字・数字・ハイフンで 6〜30 文字、末尾はハイフン不可）。
  # **plan の前に落とすためにある。** 形式違反は apply の途中で GCP が拒むので、
  # そこまで行くと「何件か作った後で止まる」状態になる。
  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{4,28}[a-z0-9]$", var.gcp_ops_project_id))
    error_message = "gcp_ops_project_id は英小文字で始まり、英小文字・数字・ハイフンのみの 6〜30 文字で、末尾をハイフンにできません。"
  }
}

variable "gcp_ops_project_name" {
  description = <<-EOT
    運用向けの GCP プロジェクトの表示名（#792）。
  EOT
  type        = string
  default     = "ojos-ops"
}
