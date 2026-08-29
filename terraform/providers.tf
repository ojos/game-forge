/**
 * GitHub プロバイダの設定。
 *
 * 認証トークンはこのファイルにも変数にも書かない。プロバイダが環境変数 GITHUB_TOKEN を
 * 直接読む（共通規範「機密の取り扱い」: 機密をコードにハードコードしない）。
 *
 *   export GITHUB_TOKEN="$(gh auth token)"
 *
 * トークンを Terraform 変数として受け取ると、値が tfstate や plan ファイルへ平文で
 * 落ちる経路ができる。環境変数経由なら宣言側に値が現れない。
 */
provider "github" {
  owner = var.github_owner
}

/**
 * AWS プロバイダの設定（本番アカウント）。
 *
 * 資格情報はこのファイルにも変数にも書かない。プロバイダが既定の資格情報チェーンを
 * 辿り、環境変数 AWS_PROFILE で選ばれたプロファイルを読む。
 *
 *   aws sso login --sso-session ojos     # 失効していたら
 *   export AWS_PROFILE=game-forge-prod
 *
 * GitHub プロバイダが GITHUB_TOKEN を直接読むのと同じ理由である。資格情報を
 * Terraform 変数として受け取ると、値が tfstate や plan ファイルへ平文で落ちる経路が
 * できる（共通規範「機密の取り扱い」）。
 *
 * allowed_account_ids は資格情報ではなく表明である。宣言が対象とするアカウントを
 * 明示し、実際に接続したアカウントが違えば apply を失敗させる。プロファイルの
 * 取り違え（dev のプロファイルで本番の宣言を適用する）を、注意ではなく機構で塞ぐ
 * ためのもの（shared-ai-rules.md 12 章「機構が結果そのものを生む」）。
 *
 * アカウント ID は宣言へ直接書かず変数から受ける。機密ではないが、このリポジトリは
 * 公開であり、公開する必要も無いため。値は terraform.tfvars（*.tfvars は追跡外）に置く。
 */
provider "aws" {
  region              = var.aws_region
  allowed_account_ids = [var.aws_account_id_prod]
}

/**
 * Google Cloud プロバイダの設定。
 *
 * 資格情報はこのファイルにも変数にも書かない。プロバイダが Application Default
 * Credentials（ADC）を読む。GitHub / AWS と同じ理由である（機密を Terraform 変数で
 * 受け取ると tfstate や plan ファイルへ平文で落ちる経路ができる）。
 *
 *   gcloud auth application-default login --no-launch-browser
 *
 * --no-launch-browser を付けるのは、devcontainer 内にブラウザが無いため。
 *
 * これは gcloud コマンド自身が使う認証（gcloud auth login）とは別の資格情報である。
 * Terraform が読むのは ADC だけで、gcloud auth login だけを済ませても apply は
 * 認証エラーになる。逆も同じで、両方を実行する必要がある。
 *
 * project は既定値を置かない。この宣言が作るのはプロジェクトそのもの（gcp.tf）で、
 * 適用の時点では既定にすべきプロジェクトが存在しないためである。プロジェクト配下の
 * リソースを足す段階で、リソース側に project を明示するか、ここへ既定を書く。
 */
provider "google" {
}

/**
 * AWS プロバイダ（開発アカウント）。
 *
 * Bedrock の開発用の枠のためだけに置く（#82）。本番の枠と混ぜると、仕様 4.3 の
 * 判定基準（プロバイダ層がアプリ層より先に発火したらアプリ層のバグ）が壊れるため、
 * 開発の実験は本番と別アカウントの枠で行う。
 *
 * **profile をここだけ明示する理由。** prod 側は環境変数 AWS_PROFILE で選ぶが、
 * 1 回の apply で 2 つのアカウントを触る以上、環境変数では両方を選べない。
 * profile は資格情報ではなく選択子で、実体は ~/.aws/config と SSO のキャッシュに
 * ある。この宣言に秘密は入らない。
 *
 * **なぜアカウントで分けるのか。** Bedrock のクォータは アカウント × リージョン ×
 * モデル で定義され、IAM プリンシパルの次元を持たない（実測）。1 アカウント内では
 * 開発と本番に別々のレート上限を張れず、4.3 の最外周で**即時に効く唯一の層**が
 * アカウントでしか割れない。仕様 9.2 / 確定21（v1.1）。
 */
provider "aws" {
  alias               = "dev"
  region              = var.aws_region
  profile             = var.aws_profile_dev
  allowed_account_ids = [var.aws_account_id_dev]
}

/**
 * Cloudflare プロバイダの設定。
 *
 * API トークンはこのファイルにも変数にも書かない。プロバイダが環境変数
 * CLOUDFLARE_API_TOKEN を直接読む（GitHub / AWS / GCP と同じ理由。トークンを Terraform
 * 変数として受け取ると、値が tfstate や plan ファイルへ平文で落ちる経路ができる）。
 *
 *   set -a; source scripts/load-project-env.sh; set +a
 *
 * **Cloudflare にはツール自身のログイン状態が無い**（`wrangler login` は OAuth の
 * コールバックをブラウザで受けるため devcontainer では完結しない）。この環境での
 * 供給元は追跡外の .env だけで、上のローダーがそれを環境へ移す。同じ形を
 * scripts/acceptance-remote.sh が既に採っている。
 *
 * account_id はプロバイダではなくリソース側の必須属性なので、変数から受ける
 * （var.cloudflare_account_id）。
 */
provider "cloudflare" {
}
