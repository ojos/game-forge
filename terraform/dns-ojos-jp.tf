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
 * 手作業で残っていた OAuth の TXT とサブドメインの委譲が宣言に入った（#906 で消した
 * dns.tf の冒頭にあった「さくら側に残る手動作業」は、ネームサーバの切り替え 1 回を除いて無くなった）。
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
 * これに依存する。`game-forge.ojos.jp` の Search Console の TXT（下の
 * `game_forge_search_console_verification`）とは別物である。
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
 * game-forge.ojos.jp の委譲は、段 C2 で外した（#775。2026-09-28）。委譲先だった Route 53 の
 * ゾーン（`aws_route53_zone.game_forge`）と、そこに載っていたレコードは #906 で消した。
 *
 * **戻すときは、#906 の 1 つ前のコミットの `terraform/dns.tf` と、この節を戻す。** 委譲の
 * NS（`cloudflare_dns_record.game_forge_delegation`）の綴りは、段 C2 の 1 つ前のコミットの
 * このファイルにある。どちらも `git log -- terraform/dns.tf terraform/dns-ojos-jp.tf` で辿れる。
 * ゾーンを作り直すとネームサーバは変わる。
 */

/**
 * ここから下は game-forge.ojos.jp の下のレコードである。
 *
 * # 値について
 *
 * **値と注記の正本はここである。** #906 までは Route 53 の宣言（dns.tf）から値を導いていた。
 * ゾーンを消すにあたって、値と注記をここへ移した（Cloudflare 側の答えは 1 文字も変えていない）。
 * TTL は Route 53 のときと同じ 300 にそろえている。
 */
locals {
  game_forge_domain = "game-forge.${cloudflare_zone.ojos_jp.name}"
  game_forge_ttl    = 300

  /**
   * 公開ホスト名（#89）。
   *
   * **`app.` などのラベルを 1 つ足しているのは、Route 53 に委譲していたときの DNS の制約の
   * 名残りである。** 当時 game-forge.ojos.jp はゾーンの apex で、apex には CNAME を作れず、
   * Route 53 の ALIAS は *.pages.dev を指せなかった。いまはゾーンが ojos.jp で apex では
   * ないが、ホスト名は wrangler.toml・OAuth のリダイレクト URI・外部のリンクに載っているので
   * 変えない。
   *
   * **「別オリジン・同一サイト」は保たれる**（仕様 7.2。app と sandbox と admin は兄弟だが、
   * 登録可能ドメインはどれも ojos.jp である）。したがって __Host- cookie と CSP sandbox の
   * 必要性は変わらない。
   *
   * ホスト名はゾーン名から導く。ここへ完全修飾名を書き写すと、ゾーン名を変えたときに
   * 片方だけが古い名前を指す（shared-ai-rules.md 12 章）。wrangler.toml の
   * `[env.production.vars]` との一致は、外部層の検査（scripts/acceptance-remote.sh）が見る。
   *
   *   - app: アプリ用ホスト
   *   - sandbox: サンドボックス用ホスト（UGC の配信元。7.2）。**同じ Pages プロジェクトを
   *     指してよい。** 7.2 が要求するのは別オリジンであることで、別プロジェクトであることでは
   *     ない。src/index.ts が Host ヘッダで出し分け、サンドボックス側には CSP sandbox を付け、
   *     cookie を一切設定しない
   *   - admin: 運営の管理画面のホスト（仕様 2.4.1 / #356）。src/index.ts が Host ヘッダで
   *     3 つ目として振り分け、権限が無い要求には 404 を返す（2.4.2。403 は画面の存在を教える）。
   *     **`app` と同一サイトなので、セッション cookie の `__Host-` 接頭辞は admin 側でも必須で、
   *     `Domain` 属性を持てない以上、app のセッションは admin へ届かない**（2.4.1）
   *
   * **CNAME だけでは開かない。** Cloudflare Pages 側のカスタムドメインの登録（API。
   * docs/pages-deploy.md、docs/admin-host.md）が要り、片方だけでは `active` にならない。
   */
  app_host     = "app.${local.game_forge_domain}"
  sandbox_host = "sandbox.${local.game_forge_domain}"
  admin_host   = "admin.${local.game_forge_domain}"

  # Cloudflare Pages のカスタムドメインが要求する CNAME の向き先。
  # プロジェクト名は Cloudflare 側の識別子で、Terraform の管理対象ではない
  # （Pages プロジェクトそのものは wrangler で作る。docs/pages-deploy.md）。
  pages_hostname = "${var.cloudflare_pages_project}.pages.dev"

  /**
   * Pages のカスタムドメインへ向く CNAME をプロキシにするか（段 B の実測で決めた）。
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
   *
   * **#776 で true（プロキシ）にした**（2026-09-30）。WAF のマネージドルールと学習クローラの
   * 遮断（terraform/waf-ojos-jp.tf）は、プロキシを通る要求にしか効かない。**挙動を変えうる
   * ゾーンの設定は、切り替えの前に同じファイルで切ってある**（HTML を書き換える 4 つ・
   * Browser Integrity Check・Security Level）。**戻すときはここを false にするだけでよい**——
   * WAF の宣言は残しても、DNS only のホストには効かない。
   */
  game_forge_pages_proxied = true

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

/**
 * ここから下はメール送信（Resend / 確定14 / #178）のためのレコードである。
 *
 * # なぜ上位ドメイン（ojos.jp）へ 1 本も置かないのか
 *
 * **`ojos.jp` は Google Workspace の MX が乗っている本番のメール経路**である（上の
 * `ojos_jp_mx`）。**そこへ触らずに送信を成立させられる**ことを、2026-08-30 に実際の DNS を
 * 引いて確かめた。
 *
 *   - DKIM は `<selector>._domainkey.<domain>` と署名の `d=` で完結する。サブドメインで独立
 *   - SPF は封筒の送信者（Return-Path）のドメインを見る。Resend は `send.<domain>` を使う
 *   - **DMARC だけは、無ければ組織ドメイン（`ojos.jp`）を見に行く性質がある。**
 *     だから `_dmarc.game-forge.ojos.jp` を自分で置く。置けば `ojos.jp` に何が起きても
 *     このサブドメインの判定は変わらない
 *
 * From が `@game-forge.ojos.jp`、DKIM の `d=` も同じなので**アラインメントは厳密一致で通る。**
 *
 * **Resend の画面は名前を `ojos.jp` からの相対で表示する**（`resend._domainkey.game-forge`
 * など）。**ここではフル名で書く。** 画面の表示をそのまま写すと、DMARC が `_dmarc.ojos.jp`
 * ＝上位ドメインに落ちる。
 *
 * **受信（Enable Receiving）は使わないので MX を置かない。**
 *
 * **TXT の値は引用符で囲んで渡す**（上の `ojos_jp_google_site_verification` と同じ理由）。
 */

/**
 * DKIM の公開鍵（Resend が生成した 1024 ビット鍵）。
 *
 * **値は Resend の管理画面が正本である。** ここにあるのは写しで、鍵を再生成したら
 * 差し替える。**218 バイトなので 1 つの文字列に収まる**（TXT の 1 文字列は 255 バイトまで。
 * 2048 ビット鍵へ替えるときは、分割の扱いを確かめること）。
 */
resource "cloudflare_dns_record" "game_forge_resend_dkim" {
  zone_id = cloudflare_zone.ojos_jp.id
  name    = "resend._domainkey.${local.game_forge_domain}"
  type    = "TXT"
  content = "\"p=MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDE/CoOSLsw3zbIiRplRjmpH+DmMeI6mvbq58cNlrXNQj1RrDjycOoxfyKVmosUWqMryI58eAAuGNv91L3HZuiZwmqKZHE+P3ECqRJbjUEgVTjcLfHnrf8MJ/86OtxN1OtNbACsx2cZtKZ4tHjpR5pA5KjUGucIHyCQvyhvbZvvVwIDAQAB\""
  ttl     = local.game_forge_ttl
  proxied = false
}

/**
 * 送信経路（Resend の新しい方式では SPF を TXT ではなく CNAME で持つ）。
 *
 * **`rmta.net` は Resend の MTA である。** include ではなく委譲の形なので、
 * SPF の 10 回ルックアップ制限を消費しない。リージョンは Tokyo（`apne1`）。
 */
resource "cloudflare_dns_record" "game_forge_resend_spf_rsend" {
  zone_id = cloudflare_zone.ojos_jp.id
  name    = "rsend.${local.game_forge_domain}"
  type    = "CNAME"
  content = "rsend-apne1.forge.rmta.net"
  ttl     = local.game_forge_ttl
  proxied = false
}

# Return-Path（バウンスの戻り先）。
resource "cloudflare_dns_record" "game_forge_resend_spf_send" {
  zone_id = cloudflare_zone.ojos_jp.id
  name    = "send.${local.game_forge_domain}"
  type    = "CNAME"
  content = "send.forge.rmta.net"
  ttl     = local.game_forge_ttl
  proxied = false
}

/**
 * DMARC。**このサブドメインの判定を、上位ドメインから独立させるために置く。**
 *
 * **`p=none` から始める。** 到達性の実績が無いうちに `quarantine` / `reject` を出すと、
 * 設定の誤りが「届かない」ではなく「迷惑メール扱い」として現れ、切り分けが遅れる。
 * **締めるのは、実際に届くようになってからである**（#178 の acceptance）。
 *
 * 集計レポートの宛先（`rua=`）は置いていない。受け取る先を決めていないうちに書くと、
 * 誰も読まないレポートが毎日どこかへ送られる。
 */
resource "cloudflare_dns_record" "game_forge_resend_dmarc" {
  zone_id = cloudflare_zone.ojos_jp.id
  name    = "_dmarc.${local.game_forge_domain}"
  type    = "TXT"
  content = "\"v=DMARC1; p=none;\""
  ttl     = local.game_forge_ttl
  proxied = false
}

/**
 * Search Console の所有証明（`game-forge.ojos.jp` のドメインプロパティ。#610）。
 *
 * # なぜ game-forge.ojos.jp そのものに置くのか
 *
 * **`app.game-forge.ojos.jp` には置けない。** あちらは Pages へ向く CNAME を持っており、
 * **CNAME があるノードには他のレコードを置けない**（RFC 1034。実測で確認した）。
 * ドメインプロパティは DNS の確認が必須なので、`app.` を含む名前では検証できない。
 * `game-forge.ojos.jp` には CNAME が無いので衝突しない。
 *
 * # `ojos.jp` 側の所有証明とは別物である
 *
 * **消さないこと**で有名なもう 1 つの `google-site-verification`（上の
 * `ojos_jp_google_site_verification`。docs/gcp-oauth-setup.md 4.3）は **OAuth の承認済み
 * ドメインが依存している。** こちらは `game-forge.ojos.jp` の所有を Search Console へ示す
 * だけで、**OAuth とは無関係である。**
 *
 * # 値について
 *
 * **秘密ではない。** DNS に公開される値で、知られても所有権は移らない（所有権は「この値を
 * DNS へ置けること」で示される）。`game_forge_resend_dkim` と同じ扱いで直に書く。
 *
 * **正本は Search Console の「所有権の確認」の画面である。** ここはその写しで、プロパティを
 * 作り直したら差し替える。**消すと所有証明が外れ、サイトマップの送信とインデックスのレポートが
 * 見られなくなる**（OAuth と本番の同意画面には影響しない。上記のとおり別物である）。
 *
 * **サイト管理者アカウント `game-forge@ojos.jp` で作った**（2026-09-17）。個人アカウントで
 * 作ったプロパティから移すためで、**個人アカウントが使えなくなってもサービスの管理が続く**
 * ようにする。
 */
resource "cloudflare_dns_record" "game_forge_search_console_verification" {
  zone_id = cloudflare_zone.ojos_jp.id
  name    = local.game_forge_domain
  type    = "TXT"
  content = "\"google-site-verification=1mjJUM5QMby2hdiz3fuLVKA_ijum_yAIWuKxz7YMW1I\""
  ttl     = local.game_forge_ttl
  proxied = false
}
