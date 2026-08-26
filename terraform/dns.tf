/**
 * DNS の宣言（確定17）。
 *
 * game-forge.ojos.jp を本番 AWS アカウントの Route53 ホストゾーンとして持ち、
 * さくらのドメイン（ojos.jp）からこのゾーンへ NS 委譲する。
 *
 * なぜ委譲するのか:
 *   さくらのドメインは DNS の API を持たない。委譲しなければレコードの追加・変更が
 *   コントロールパネルでの手作業になり、共通規範「外部サービスの状態管理」の
 *   「UI やアドホックな CLI での直接作成・変更を、恒久的な状態変更の手段にしない」
 *   に反する。委譲は、この規範を満たすための手段である。
 *
 * さくら側に残る手動作業:
 *   ojos.jp ゾーンへ game-forge の NS レコードを 1 組登録する初回の 1 回のみ。
 *   値は output "dns_zone_name_servers" から取る。この 1 回だけは API が無いため
 *   宣言化できない。委譲が済んだ後の恒久的な状態は、すべてこの宣言が持つ。
 *
 * Cloudflare へ委譲しない理由:
 *   Cloudflare のサブドメイン委譲（subdomain setup）は Enterprise プラン限定である。
 *
 * レコードをここに置いていない理由:
 *   Cloudflare Pages / Workers を向く CNAME 等は、それらの実体が出来てから足す
 *   （M2-1 / M4-3）。存在しない向き先を先に宣言しても検証できない。
 */
resource "aws_route53_zone" "game_forge" {
  name    = var.dns_zone_name
  comment = "Game Forge. Delegated from ojos.jp (Sakura). Managed by Terraform."

  tags = {
    Project   = "game-forge"
    ManagedBy = "terraform"
  }
}

/**
 * 公開ホスト名（#89）。
 *
 * アプリ用ホストに `app.` を足しているのは DNS の制約による。
 *
 *   - このゾーンの名前は game-forge.ojos.jp そのものなので、game-forge.ojos.jp は
 *     **ゾーンの apex** にあたる。**Route53 は apex に CNAME を作れない**（apex には
 *     SOA と NS が必ず在り、CNAME は他のレコードと同居できない）。
 *   - Route53 の ALIAS は CloudFront / ELB などの AWS リソースと同一ゾーン内の
 *     レコードしか指せず、*.pages.dev のような外部ホスト名を指せない。
 *   - Cloudflare Pages 側も、外部 DNS のままの apex は対象外としている（apex へ
 *     配備するならドメインごと Cloudflare のゾーンにしてネームサーバを向けよ、と
 *     文書が明記している）。
 *   - Cloudflare のサブドメイン単独ゾーン（game-forge.ojos.jp だけを Cloudflare に
 *     置く）は、親が外部 DNS の場合 Business / Enterprise プラン限定である。
 *
 * ラベルを 1 つ足すと、ゾーンも委譲もそのままで CNAME 1 本で張れる。**7.2 が要求する
 * 「別オリジン・同一サイト」は保たれる**（app と sandbox は兄弟だが、登録可能ドメインは
 * どちらも ojos.jp である）。したがって __Host- cookie と CSP sandbox の必要性は変わらない。
 *
 * ホスト名はゾーン名から導く。ここへ完全修飾名を書き写すと、ゾーン名を変えたときに
 * 片方だけが古い名前を指す（shared-ai-rules.md 12 章）。
 */
locals {
  app_host     = "app.${aws_route53_zone.game_forge.name}"
  sandbox_host = "sandbox.${aws_route53_zone.game_forge.name}"

  # Cloudflare Pages のカスタムドメインが要求する CNAME の向き先。
  # プロジェクト名は Cloudflare 側の識別子で、Terraform の管理対象ではない
  # （Pages プロジェクトそのものは wrangler で作る。docs/pages-deploy.md）。
  pages_hostname = "${var.cloudflare_pages_project}.pages.dev"
}

/**
 * アプリ用ホスト。
 *
 * TTL を 300 にしているのは、公開直後に向き先を変える可能性が残るためである。
 * 落ち着いたら伸ばしてよいが、伸ばすこと自体が目的ではない。
 */
resource "aws_route53_record" "app" {
  zone_id = aws_route53_zone.game_forge.zone_id
  name    = local.app_host
  type    = "CNAME"
  ttl     = 300
  records = [local.pages_hostname]
}

/**
 * サンドボックス用ホスト（UGC の配信元。7.2）。
 *
 * **同じ Pages プロジェクトを指してよい。** 7.2 が要求するのは別オリジンであることで、
 * 別プロジェクトであることではない。src/index.ts が Host ヘッダで出し分け、
 * サンドボックス側には CSP sandbox を付け、cookie を一切設定しない。
 */
resource "aws_route53_record" "sandbox" {
  zone_id = aws_route53_zone.game_forge.zone_id
  name    = local.sandbox_host
  type    = "CNAME"
  ttl     = 300
  records = [local.pages_hostname]
}
