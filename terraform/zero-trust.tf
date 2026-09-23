/**
 * Zero Trust の土台（#792 / M22-2）。
 *
 * ここが持つのはアカウント全体に効く 2 つだけである——**チームドメイン**（Access の
 * ログインが載る `<team>.cloudflareaccess.com`）と、**Google Workspace の ID プロバイダ**。
 * どちらも特定の機械やトンネルに属さないので、機械ごとの宣言（terraform/tunnel-dev01.tf）
 * とは別のファイルに置く。2 台目の機械を足してもこのファイルは増えない。
 *
 * # 一度きりの手作業が 2 つ残る（宣言化できない）
 *
 * 1. **API トークンの権限**。2026-09-23 の実測で、いまのトークンは `cfd_tunnel` /
 *    `access/apps` / `access/service_tokens` を読めるが、`access/organizations` が
 *    403 を返す。これは下の 2 つのリソースが使う権限グループ（Access: Organizations,
 *    Identity Providers, and Groups）そのものである。**足すまで apply は通らない。**
 * 2. **Google の OAuth クライアント**。GCP コンソールでの作成が要る（API で作れない。
 *    docs/gcp-oauth-setup.md が既存の 2 つで同じ手順を踏んでいる）。**リダイレクト URI に
 *    入れる値は下の output `zero_trust_google_redirect_url` が持つが、鶏と卵になるため、
 *    最初の 1 回は `https://<team>.cloudflareaccess.com/cdn-cgi/access/callback` を
 *    手で組み立てて先に登録する**（team はこの宣言が決める値で、後から変わらない）。
 *
 * # チームドメインは後から変えられないものとして扱う
 *
 * 変えると Access のログイン URL が全部変わり、`cloudflared access ssh` を書き写した
 * 手元の ~/.ssh/config と、ingress の `origin_request.access.team_name` が一斉にずれる。
 * 値は terraform.tfvars（追跡外）から受けるが、これは機密だからではなく、
 * 「このリポジトリは公開で、公開する必要が無い」という cloudflare_account_id と同じ理由である。
 */

/**
 * チームドメイン（Zero Trust の organization）。
 *
 * **これは新規作成ではなく取り込みである。** 2026-09-23 の実測で、このアカウントには
 * 既に organization があった（`auth_domain = ojos-jp.cloudflareaccess.com`、作成
 * 07:44:27Z）。**apply の前に import しておくこと**——しないと「既にある」で落ちる。
 *
 *   terraform -chdir=terraform import cloudflare_zero_trust_organization.ojos "<account_id>"
 *
 * **import ブロック（宣言）にしない理由。** import ブロックの id は文字列リテラルでしか
 * 書けず（変数を使えるのは Terraform 1.6 から。versions.tf の required_version は
 * >= 1.5.0）、ここへ書くべき id は**アカウント ID そのもの**である。このリポジトリは公開で、
 * アカウント ID は宣言へ書かないと決めてある（variables.tf の cloudflare_account_id）。
 * **terraform/gcp.tf が import ブロックを選んでいるのと結論が違うのは、あちらの id が
 * 公開しても構わないプロジェクト名だからである。**
 *
 * **取り込むと 2 つの差分が出る。どちらも意図したものである。**
 *   - `name`: `aged-recipe-19e0.cloudflareaccess.com`（Cloudflare が自動で付けた名前）→ `ojos`
 *   - `session_duration`: 未設定 → `24h`
 *
 * session_duration はアプリ側の既定値で、アプリごとに上書きする（SSH は 24h、
 * LLM の口は非 identity なのでセッションを持たない）。
 */
resource "cloudflare_zero_trust_organization" "ojos" {
  account_id       = var.cloudflare_account_id
  name             = "ojos"
  auth_domain      = "${var.cloudflare_zero_trust_team_name}.cloudflareaccess.com"
  session_duration = "24h"
}

/**
 * Google Workspace（ojos.jp）の ID プロバイダ。
 *
 * **`google-apps` であって `google` ではない。** 前者は Workspace のドメインに
 * 縛れる（`apps_domain`）。後者は任意の Google アカウントを受け入れ、ドメインの
 * 制限はポリシー側だけに頼ることになる。**入口で絞れるものを入口で絞る。**
 *
 * client_secret は変数で受ける。**プロバイダの資格情報（CLOUDFLARE_API_TOKEN）とは
 * 扱いが違う**——あれは「プロバイダ自身が環境変数から読むので宣言に現れない」が、
 * これはリソースの属性なので、どう渡しても tfstate には入る。tfstate は追跡外で、
 * 既に他の機密を持っている（terraform/versions.tf の backend の注記）。
 */
resource "cloudflare_zero_trust_access_identity_provider" "google_workspace" {
  account_id = var.cloudflare_account_id
  name       = "ojos.jp (Google Workspace)"
  type       = "google-apps"

  config = {
    client_id     = var.zero_trust_google_client_id
    client_secret = var.zero_trust_google_client_secret
    apps_domain   = "ojos.jp"
  }
}
