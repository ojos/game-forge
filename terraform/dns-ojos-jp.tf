/**
 * ojos.jp のゾーン（Cloudflare・Free・フルセットアップ。#775 / M22-1）。
 *
 * # このファイルは組織のゾーンを預かっている
 *
 * **ojos.jp は game-forge だけのゾーンではない。** Google Workspace のメール（MX）、
 * OAuth の承認済みドメインの所有証明（TXT）、別プロジェクトの code-narrative への委譲が
 * 同居している。**ここを壊すと、game-forge と関係の無い組織のメールが止まる。**
 * それでも宣言をこの repo に置いたのは利用者の決定である（2026-09-22。#775）。
 * 実体は Pages の game-forge と同じ Cloudflare アカウントに置く。
 *
 * # なぜ Cloudflare へ移したのか
 *
 * 本番チャットの LLM を、Cloudflare Tunnel の公開ホスト名の先へ移すため（M22）。
 * Tunnel の公開ホスト名はゾーンが Cloudflare に在ることを要求し、Free で使える形は
 * フルセットアップだけである（パーシャルは Business 以上、サブドメイン単独のゾーンは
 * Enterprise 限定）。**登録事業者は JPRS（さくらが取次）のまま**で、変えたのはネーム
 * サーバだけである（Cloudflare Registrar は .jp を扱わない）。
 *
 * **さくら（dns.ne.jp）には DNS の API が無かった。** 移したことで、これまで宣言できずに
 * 手作業で残っていた OAuth の TXT とサブドメインの委譲が宣言に入った（dns.tf 冒頭の
 * 「さくら側に残る手動作業」は、ネームサーバの切り替え 1 回を除いて無くなった）。
 *
 * # 写したものと、写さなかったもの
 *
 * 正本は、さくらの管理画面の一覧（2026-09-14 13:31 版）である。**ゾーン転送は拒否され、
 * 公開 DNS から全件は数えられない。** 値は同画面と `dig` の答えの両方で照合した（#775）。
 *
 * **`www.ojos.jp` は写さない。** さくらが一覧に無いまま暗黙に返していた、レンタル
 * サーバの 403 ページ（219.94.128.193）である。
 *
 * **TTL はさくらと同じ 3600 に揃える。** 切り替えの前後で答えを変えないためで、
 * 伸ばすこと・縮めることは目的ではない。
 *
 * **すべて DNS only（proxied = false）。** プロキシにすると、`mail` の CNAME
 * （ghs.google.com）などの挙動が変わる。移行は答えを 1 つも変えないことを条件にしている。
 */
resource "cloudflare_zone" "ojos_jp" {
  account = { id = var.cloudflare_account_id }
  name    = "ojos.jp"
  type    = "full"

  # 組織のメールが乗っている。宣言の書き損じでゾーンごと消えないようにする。
  lifecycle {
    prevent_destroy = true
  }
}

locals {
  ojos_jp_ttl = 3600

  # Google Workspace の MX（優先度 → ホスト名）。Google の既定の 7 本そのまま。
  ojos_jp_mx = {
    "aspmx.l.google.com"      = 10
    "alt1.aspmx.l.google.com" = 20
    "alt2.aspmx.l.google.com" = 20
    "aspmx2.googlemail.com"   = 30
    "aspmx3.googlemail.com"   = 30
    "aspmx4.googlemail.com"   = 30
    "aspmx5.googlemail.com"   = 30
  }

  /**
   * code-narrative.ojos.jp の委譲先（別プロジェクトの Route 53 ゾーン）。
   *
   * **ここは写しで、正本はあちらの Route 53 である。** あちらがゾーンを作り直すと
   * ネームサーバが変わり、**ここを直すまで code-narrative が引けなくなる。**
   * game-forge の委譲（下）のように宣言から導けないのは、別の repo・別の state が
   * 持っているからである。
   */
  code_narrative_name_servers = [
    "ns-1408.awsdns-48.org",
    "ns-1610.awsdns-09.co.uk",
    "ns-170.awsdns-21.com",
    "ns-587.awsdns-09.net",
  ]
}

resource "cloudflare_dns_record" "ojos_jp_mx" {
  for_each = local.ojos_jp_mx

  zone_id  = cloudflare_zone.ojos_jp.id
  name     = cloudflare_zone.ojos_jp.name
  type     = "MX"
  content  = each.key
  priority = each.value
  ttl      = local.ojos_jp_ttl
  proxied  = false
}

/**
 * OAuth の承認済みドメイン（ojos.jp）の所有証明（docs/gcp-oauth-setup.md 4.3）。
 *
 * **消さないこと。** 本番の同意画面の承認済みドメインとブランド確認（2026-09-14 に提出）が
 * これに依存する。`game-forge.ojos.jp` の Search Console の TXT（dns.tf）とは別物である。
 *
 * **値を引用符で囲んで渡す。** Cloudflare は TXT の内容を引用符付きで持つことを推奨しており、
 * 囲まずに渡すと、保存された値との違いが plan の差分として出続けることがある。
 */
resource "cloudflare_dns_record" "ojos_jp_google_site_verification" {
  zone_id = cloudflare_zone.ojos_jp.id
  name    = cloudflare_zone.ojos_jp.name
  type    = "TXT"
  content = "\"google-site-verification=pyitMIoe3d6tA6Pu9dgfo933Bt77vfE11E-MxVOJHWg\""
  ttl     = local.ojos_jp_ttl
  proxied = false
}

# Google Workspace のメールの入口（ghs.google.com）。プロキシにしない（上の冒頭）。
resource "cloudflare_dns_record" "ojos_jp_mail" {
  zone_id = cloudflare_zone.ojos_jp.id
  name    = "mail.${cloudflare_zone.ojos_jp.name}"
  type    = "CNAME"
  content = "ghs.google.com"
  ttl     = local.ojos_jp_ttl
  proxied = false
}

resource "cloudflare_dns_record" "code_narrative_delegation" {
  for_each = toset(local.code_narrative_name_servers)

  zone_id = cloudflare_zone.ojos_jp.id
  name    = "code-narrative.${cloudflare_zone.ojos_jp.name}"
  type    = "NS"
  content = each.value
  ttl     = local.ojos_jp_ttl
}

/**
 * game-forge.ojos.jp の委譲（段 A。#775）。
 *
 * **Route 53 のゾーンの宣言から導く。** さくらのときは値を手で写していたが、ここでは
 * 写さない。**写し漏れると app / sandbox / admin とメール送信が全部引けなくなる**ためである。
 *
 * **段 C でこの委譲を外す**（レコードを Cloudflare のゾーンへ吸収した後）。戻すときは、
 * この宣言を戻せばよい。
 */
resource "cloudflare_dns_record" "game_forge_delegation" {
  for_each = toset([for ns in aws_route53_zone.game_forge.name_servers : trimsuffix(ns, ".")])

  zone_id = cloudflare_zone.ojos_jp.id
  name    = aws_route53_zone.game_forge.name
  type    = "NS"
  content = each.value
  ttl     = local.ojos_jp_ttl

  lifecycle {
    precondition {
      condition     = endswith(aws_route53_zone.game_forge.name, ".${cloudflare_zone.ojos_jp.name}")
      error_message = "委譲するゾーン（aws_route53_zone.game_forge）が ojos.jp の下にありません。"
    }
  }
}

/**
 * ここから下は game-forge.ojos.jp の下のレコード（段 C。Route 53 から吸収する。#775）。
 *
 * # 置く順序（段 C1 → C2）
 *
 * **C1: 委譲（上の game_forge_delegation）を残したまま、ここのレコードを置く。**
 * 委譲がある間、Cloudflare は game-forge.ojos.jp より下の問い合わせにリファラルを返すので、
 * ここに置いたものは外から見えない（委譲の NS と同名・その下にレコードを置けることは、
 * pending のゾーンで実測した。2026-09-22）。
 *
 * **C2: 委譲の NS を外す。** 切り替わるのはこの小さな apply だけで、戻すときは委譲を戻す。
 * キャッシュに残った委譲（TTL 3600）を辿ってくるリゾルバには、Route 53 が同じ答えを返し続ける
 * （Route 53 のゾーンは削除の別 issue まで残す。dns.tf）。
 *
 * # 値について
 *
 * **Route 53 の宣言（dns.tf）と同じ値を置く。** 意味と注記の正本は dns.tf の各レコードにある。
 * TTL も同じ 300 にそろえる。
 *
 * **値は Route 53 の宣言から導き、書き写さない。** 並んでいる間に片方だけが古くなるのを防ぐ。
 * **Route 53 のゾーンを消す issue では、先に値と注記をここへ移すこと。** 移さずに dns.tf の
 * レコードを消すと、ここは参照先を失って plan が通らなくなる。
 */
locals {
  game_forge_domain = "game-forge.${cloudflare_zone.ojos_jp.name}"
  game_forge_ttl    = 300

  /**
   * Pages のカスタムドメインへ向く CNAME をプロキシにするか（段 B で実測して決める）。
   *
   * **false（DNS only）にする。段 B で実測して決めた**（2026-09-22）。外部 DNS から CNAME を
   * 張っていたときと同じ形で、挙動を何も変えないためである。
   *
   * 実測: 使い捨てのホスト（gf-canary.ojos.jp）に DNS only の CNAME を置き、Pages のカスタム
   * ドメインに登録した。**約 1 分 20 秒で active になり、HTTPS でアプリの応答（404。知らない
   * ホスト）が 3 回続いた。** 証明書は本番の app と同じ Google Trust Services（WE1）だった。
   * 確かめた後にホストとカスタムドメインは消した。
   *
   * **プロキシにすると、ゾーンの WAF などが効くようになる代わりに挙動が変わる。** 変えるのは
   * 別 issue（WAF / AI Crawler Control を有効にするとき）。
   */
  game_forge_pages_proxied = false

  game_forge_pages_hosts = {
    app     = local.app_host
    sandbox = local.sandbox_host
    admin   = local.admin_host
  }
}

resource "cloudflare_dns_record" "game_forge_pages" {
  for_each = local.game_forge_pages_hosts

  zone_id = cloudflare_zone.ojos_jp.id
  name    = each.value
  type    = "CNAME"
  content = local.pages_hostname
  ttl     = local.game_forge_pages_proxied ? 1 : local.game_forge_ttl
  proxied = local.game_forge_pages_proxied
}

resource "cloudflare_dns_record" "game_forge_resend_dkim" {
  zone_id = cloudflare_zone.ojos_jp.id
  name    = aws_route53_record.resend_dkim.name
  type    = "TXT"
  content = "\"${one(aws_route53_record.resend_dkim.records)}\""
  ttl     = local.game_forge_ttl
  proxied = false
}

resource "cloudflare_dns_record" "game_forge_resend_spf_rsend" {
  zone_id = cloudflare_zone.ojos_jp.id
  name    = aws_route53_record.resend_spf_rsend.name
  type    = "CNAME"
  content = one(aws_route53_record.resend_spf_rsend.records)
  ttl     = local.game_forge_ttl
  proxied = false
}

resource "cloudflare_dns_record" "game_forge_resend_spf_send" {
  zone_id = cloudflare_zone.ojos_jp.id
  name    = aws_route53_record.resend_spf_send.name
  type    = "CNAME"
  content = one(aws_route53_record.resend_spf_send.records)
  ttl     = local.game_forge_ttl
  proxied = false
}

resource "cloudflare_dns_record" "game_forge_resend_dmarc" {
  zone_id = cloudflare_zone.ojos_jp.id
  name    = aws_route53_record.resend_dmarc.name
  type    = "TXT"
  content = "\"${one(aws_route53_record.resend_dmarc.records)}\""
  ttl     = local.game_forge_ttl
  proxied = false
}

resource "cloudflare_dns_record" "game_forge_search_console_verification" {
  zone_id = cloudflare_zone.ojos_jp.id
  name    = local.game_forge_domain
  type    = "TXT"
  content = "\"${one(aws_route53_record.search_console_verification.records)}\""
  ttl     = local.game_forge_ttl
  proxied = false
}
