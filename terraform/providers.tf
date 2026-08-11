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
