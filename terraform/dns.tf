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
