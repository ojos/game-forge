/**
 * 機械 dev01 の Cloudflare Tunnel（#792 / M22-2）。
 *
 * dev01 は手元に置く Ubuntu の 1 台で、**game-forge 専用の機械ではない**。いまは
 * Ollama（ローカル LLM）を載せ、後に GitHub Actions のセルフホステッドランナーも載る。
 * だから**機械の名前に役割を入れない**（役割は増える）。
 *
 * # 口は 2 つ、トンネルは 1 本
 *
 * | 公開ホスト名 | 向き先 | 誰が通るか |
 * |---|---|---|
 * | llm.ojos.jp | http://localhost:11434（Ollama） | エッジ（サービストークン。人ではない） |
 * | ssh.dev01.ojos.jp | ssh://localhost:22 | 運営（Google Workspace の本人） |
 *
 * **1 本にまとめた理由**（2026-09-23 の決定。#792 の経緯 2）。分離の主目的である認証は
 * Access のアプリ（ホスト名単位）で達成でき、トンネルの本数では変わらない。残る差の
 * 「トークンが漏れたときの影響範囲」は、**どちらの口も終端が同じ 1 台**である以上小さい。
 * 一方で「常駐プロセスを手で 2 つ維持する」負担は宣言で消せない。
 * **後から 2 本へ無停止で分けられることを確かめてある**——2 本目を立て、DNS の向き先を
 * 1 行変え、旧 ingress を外す。公開側の答え（Cloudflare の anycast IP）は変わらないので
 * クライアントの TTL 待ちが無い。
 *
 * # 名前の規則
 *
 * - **製品の口には機械名を入れない**（`llm.ojos.jp`）。機械を替えたときに、呼ぶ側を
 *   書き換えずに済ませるため。
 * - **機械の口は機械ごとの部分木に置く**（`ssh.dev01.ojos.jp`）。同じ機械に口を足すときは
 *   `<口>.dev01.ojos.jp` として同じ木へ下げる。2 台目は `ssh.dev02.ojos.jp` になる。
 * - **`llm` は段 C2（#775）の後に `llm.game-forge.ojos.jp` へ寄せる予定**（別 issue）。
 *   いま `game-forge.ojos.jp` の下に置けないのは、その部分木が Route 53 へ委譲中で
 *   外から引けないためである。**チャットをつなぐのは M22-3（計測の後）なので、
 *   寄せる時点で利用者はいない。**
 */

locals {
  # 機械の名前。ホスト名の部分木の根になる。
  dev01_machine_name = "dev01"

  # ゾーン名から導く（dns.tf の app_host と同じ理由。書き写すと片方だけ古くなる）。
  llm_host       = "llm.${cloudflare_zone.ojos_jp.name}"
  dev01_ssh_host = "ssh.${local.dev01_machine_name}.${cloudflare_zone.ojos_jp.name}"

  # dev01 の中での向き先。cloudflared は同じ機械の中から繋ぐので localhost でよい
  # （**ここが外から見えないことが、この構成の眼目である**。dev01 はポートを 1 つも開けない）。
  dev01_ollama_origin = "http://localhost:11434"
  dev01_ssh_origin    = "ssh://localhost:22"
}

/**
 * トンネルそのもの。
 *
 * **config_src = "cloudflare"（遠隔管理）にする。** dev01 側に ingress の設定ファイルを
 * 置く形（"local"）だと、口の一覧が宣言ではなく機械の中のファイルに宿り、
 * 共通規範「外部サービスの状態管理」の「恒久的な状態変更は宣言側を通す」から外れる。
 * 遠隔管理なら、下の ingress が正本になり、dev01 が持つのはトークン 1 本だけになる。
 *
 * tunnel_secret を宣言しないので、Cloudflare が生成する。値は
 * data.cloudflare_zero_trust_tunnel_cloudflared_token から取り出す（下の output）。
 */
resource "cloudflare_zero_trust_tunnel_cloudflared" "dev01" {
  account_id = var.cloudflare_account_id
  name       = local.dev01_machine_name
  config_src = "cloudflare"
}

/**
 * dev01 で cloudflared に渡す接続トークン。
 *
 * **これは機密である。** 持っている者は、このトンネルのコネクタとして名乗り出られる。
 * output に sensitive で出し、terraform output -raw で取り出して dev01 へ運ぶ
 * （手順は docs/local-llm-tunnel.md）。
 */
data "cloudflare_zero_trust_tunnel_cloudflared_token" "dev01" {
  account_id = var.cloudflare_account_id
  tunnel_id  = cloudflare_zero_trust_tunnel_cloudflared.dev01.id
}

/**
 * ingress（口の一覧）。**上から順に照合し、最初に一致した規則が使われる。**
 *
 * 末尾の `http_status:404` は cloudflared が要求する「受け皿」である。これが無いと
 * 設定が不正になる。**知らないホスト名で来た要求をここで落とす**（トンネルには
 * 公開ホスト名以外の名前でも到達し得るため、既定を「通す」にしない）。
 */
resource "cloudflare_zero_trust_tunnel_cloudflared_config" "dev01" {
  account_id = var.cloudflare_account_id
  tunnel_id  = cloudflare_zero_trust_tunnel_cloudflared.dev01.id

  config = {
    ingress = [
      {
        hostname = local.llm_host
        service  = local.dev01_ollama_origin

        origin_request = {
          /**
           * **コネクタ自身にも Access の検査をさせる（二重化）。**
           *
           * エッジの Access で止まるのが一次で、ここは二次である。`required = true` に
           * すると、cloudflared が各要求の Cf-Access-Jwt-Assertion を自分で検証し、
           * 通っていない要求を Ollama へ渡さない。**エッジを迂回してトンネルへ
           * 直接到達する経路（cfargotunnel の名前を知っている者）を塞ぐ。**
           *
           * aud_tag はアプリの識別子で、アプリを作り直すと変わる。**書き写さず
           * 宣言から導く。**
           */
          access = {
            required  = true
            team_name = var.cloudflare_zero_trust_team_name
            aud_tag   = [cloudflare_zero_trust_access_application.llm.aud]
          }

          /**
           * **Ollama は Host ヘッダを見て、localhost 以外を 403 で断る。**
           * 公開ホスト名のまま渡すと、Access を通った要求まで Ollama 自身に
           * 拒まれる。ここで localhost に書き換えて渡す。
           * （Ollama 側で OLLAMA_ORIGINS を緩める方法は採らない——**緩めるのは
           * dev01 の設定で、宣言の外に状態が増える**。）
           */
          http_host_header = "localhost:11434"
        }
      },
      {
        hostname = local.dev01_ssh_host
        service  = local.dev01_ssh_origin
        /**
         * **SSH 側に origin_request.access は置かない。** あれは L7 の HTTP 要求に
         * 対して JWT を検べる仕組みで、ssh:// の流れには効かない。SSH の認可は
         * エッジの Access（下の dev01_ssh アプリ）と、sshd 自身の公開鍵認証の 2 層で持つ。
         */
      },
      {
        service = "http_status:404"
      },
    ]
  }
}

/**
 * エッジ → LLM のサービストークン（人ではない呼び出し元）。
 *
 * **client_secret は作成時にしか返らない。** 失くしたら作り直し（＝ローテーション）になる。
 * 値は tfstate に入り、output から取り出して Pages のシークレットへ写す（M22-3）。
 *
 * duration は既定（8760h ＝ 1 年）に任せない。**期限を宣言に書いておかないと、
 * 切れたときに「なぜ止まったか」が宣言のどこにも無い。**
 */
resource "cloudflare_zero_trust_access_service_token" "edge_to_llm" {
  account_id = var.cloudflare_account_id
  name       = "game-forge edge -> llm"
  duration   = "8760h"
}

/**
 * LLM の口のポリシー。**decision = "non_identity"** ——人のログインを求めず、
 * サービストークンだけを通す。
 */
resource "cloudflare_zero_trust_access_policy" "llm_service_token" {
  account_id = var.cloudflare_account_id
  name       = "llm: game-forge のエッジのサービストークンだけ"
  decision   = "non_identity"

  include = [
    {
      service_token = {
        token_id = cloudflare_zero_trust_access_service_token.edge_to_llm.id
      }
    },
  ]
}

/**
 * LLM の口の Access アプリ。
 *
 * **service_auth_401_redirect = true。** 既定では未認証の要求を ID プロバイダの
 * ログイン画面へ 302 で送る。呼ぶのは人ではなくエッジの fetch なので、
 * **リダイレクトを返しても意味が無く、失敗が「HTML が返ってきた」という形で遅れて現れる。**
 * 401 を返させて、呼ぶ側が即座に失敗と分かるようにする。
 *
 * session_duration は置かない（非 identity のアプリはセッションを持たない）。
 */
resource "cloudflare_zero_trust_access_application" "llm" {
  account_id                = var.cloudflare_account_id
  name                      = "llm (Ollama on ${local.dev01_machine_name})"
  type                      = "self_hosted"
  domain                    = local.llm_host
  service_auth_401_redirect = true
  app_launcher_visible      = false

  policies = [
    {
      id         = cloudflare_zero_trust_access_policy.llm_service_token.id
      precedence = 1
    },
  ]
}

/**
 * SSH の口のポリシー。**Google Workspace の、名指しした本人だけ**を通す。
 *
 * `email_domain = ojos.jp` で足りるように見えるが採らない。**Workspace の
 * ドメインに属する誰か**ではなく、**この機械へ入ってよい人**を宣言したいためである
 * （いまは 1 人でも、増えるときに宣言が増えることに意味がある）。
 */
resource "cloudflare_zero_trust_access_policy" "dev01_ssh_operator" {
  account_id       = var.cloudflare_account_id
  name             = "${local.dev01_machine_name} ssh: 名指しした運営の Google アカウントだけ"
  decision         = "allow"
  session_duration = "24h"

  include = [
    for email in var.zero_trust_operator_emails : {
      gsuite = {
        email                = email
        identity_provider_id = cloudflare_zero_trust_access_identity_provider.google_workspace.id
      }
    }
  ]
}

/**
 * SSH の口の Access アプリ。
 *
 * **allowed_idps を Google だけに絞る。** 後で別の ID プロバイダ（メールの
 * ワンタイム PIN を含む）が足されても、この口の入口は増えない。
 *
 * **auto_redirect_to_identity = true。** ID プロバイダが 1 つなので選択画面に意味が無く、
 * `cloudflared access ssh` から開くブラウザの手数を 1 つ減らせる。
 */
resource "cloudflare_zero_trust_access_application" "dev01_ssh" {
  account_id                = var.cloudflare_account_id
  name                      = "${local.dev01_machine_name} ssh"
  type                      = "self_hosted"
  domain                    = local.dev01_ssh_host
  session_duration          = "24h"
  allowed_idps              = [cloudflare_zero_trust_access_identity_provider.google_workspace.id]
  auto_redirect_to_identity = true
  app_launcher_visible      = false

  policies = [
    {
      id         = cloudflare_zero_trust_access_policy.dev01_ssh_operator.id
      precedence = 1
    },
  ]
}

/**
 * 公開ホスト名の DNS（2 本）。
 *
 * **どちらもプロキシ有りが必須である。** `<tunnel-id>.cfargotunnel.com` は
 * Cloudflare のエッジの中でしか解決されない名前で、DNS only にすると外から引けない
 * （**dns-ojos-jp.tf の「すべて DNS only」はゾーン移行の条件であって、
 * この 2 本には当てはまらない**）。
 *
 * **プロキシ有りのレコードの TTL は 1（automatic）にする。** 公開側の答えは
 * Cloudflare の anycast IP で、向き先を変えても答えが変わらないためである。
 * ここが `local.ojos_jp_ttl`（3600）と揃っていないのは、揃えられないからである。
 */
resource "cloudflare_dns_record" "llm" {
  zone_id = cloudflare_zone.ojos_jp.id
  name    = local.llm_host
  type    = "CNAME"
  content = "${cloudflare_zero_trust_tunnel_cloudflared.dev01.id}.cfargotunnel.com"
  ttl     = 1
  proxied = true
  comment = "Cloudflare Tunnel -> dev01 (Ollama). Managed by Terraform (#792)."
}

resource "cloudflare_dns_record" "dev01_ssh" {
  zone_id = cloudflare_zone.ojos_jp.id
  name    = local.dev01_ssh_host
  type    = "CNAME"
  content = "${cloudflare_zero_trust_tunnel_cloudflared.dev01.id}.cfargotunnel.com"
  ttl     = 1
  proxied = true
  comment = "Cloudflare Tunnel -> dev01 (sshd). Managed by Terraform (#792)."
}
