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
  admin_host   = "admin.${aws_route53_zone.game_forge.name}"

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

/**
 * 運営の管理画面のホスト（仕様 2.4.1 / #356）。
 *
 * **同じ Pages プロジェクトを指す**（サンドボックス用ホストと同じ理由）。
 * src/index.ts が Host ヘッダで 3 つ目として振り分け、権限が無い要求には 404 を返す
 * （2.4.2。403 は画面の存在を教える）。
 *
 * **apex ではなく `admin.` を 1 ラベル足しているのは、app と同じ DNS の制約による**
 * （上の app_host の注記）。ゾーンの apex には CNAME を作れない。
 *
 * **このレコードだけでは開かない。** Cloudflare Pages 側のカスタムドメインの登録
 * （API。docs/admin-host.md）が要り、**片方だけでは `active` にならない。**
 * 順序はどちらからでもよいが、DNS が引けるまで証明書は発行されない。
 *
 * **`app` と同一サイトである**（登録可能ドメインがどちらも ojos.jp）。したがって
 * セッション cookie の `__Host-` 接頭辞は admin 側でも必須で、**`Domain` 属性を
 * 持てない以上、app のセッションは admin へ届かない**（2.4.1。独立にログインする）。
 */
resource "aws_route53_record" "admin" {
  zone_id = aws_route53_zone.game_forge.zone_id
  name    = local.admin_host
  type    = "CNAME"
  ttl     = 300
  records = [local.pages_hostname]
}

/**
 * ここから下はメール送信（Resend / 確定14 / #178）のためのレコードである。
 *
 * # なぜ上位ドメイン（ojos.jp）へ 1 本も置かないのか
 *
 * **`ojos.jp` は Google Workspace の MX が乗っている本番のメール経路**であり、確定17 で
 * Route53 へ委譲したのは `game-forge.ojos.jp` だけである。**そこへ触らずに送信を成立
 * させられる**ことを、2026-08-30 に実際の DNS を引いて確かめた。
 *
 *   - DKIM は `<selector>._domainkey.<domain>` と署名の `d=` で完結する。サブドメインで独立
 *   - SPF は封筒の送信者（Return-Path）のドメインを見る。Resend は `send.<domain>` を使う
 *   - **DMARC だけは、無ければ組織ドメイン（`ojos.jp`）を見に行く性質がある。**
 *     だから `_dmarc.game-forge.ojos.jp` を自分で置く。置けば `ojos.jp` に何が起きても
 *     このサブドメインの判定は変わらない（`_dmarc.ojos.jp` は現在未設定である）
 *
 * From が `@game-forge.ojos.jp`、DKIM の `d=` も同じなので**アラインメントは厳密一致で通る。**
 *
 * **Resend の画面は名前を `ojos.jp` からの相対で表示する**（`resend._domainkey.game-forge`
 * など）。**ここではフル名で書く。** 画面の表示をそのまま写すと、DMARC が `_dmarc.ojos.jp`
 * ＝上位ドメインに落ちる。
 *
 * **受信（Enable Receiving）は使わないので MX を置かない。**
 */

/**
 * DKIM の公開鍵（Resend が生成した 1024 ビット鍵）。
 *
 * **値は Resend の管理画面が正本である。** ここにあるのは写しで、鍵を再生成したら
 * 差し替える。**分割していないのは 218 バイトだからである**（Route53 の TXT は 1 つの
 * 文字列が 255 バイトを超えると分割が要る。2048 ビット鍵へ替えたら必要になる）。
 */
resource "aws_route53_record" "resend_dkim" {
  zone_id = aws_route53_zone.game_forge.zone_id
  name    = "resend._domainkey.${aws_route53_zone.game_forge.name}"
  type    = "TXT"
  ttl     = 300
  records = ["p=MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDE/CoOSLsw3zbIiRplRjmpH+DmMeI6mvbq58cNlrXNQj1RrDjycOoxfyKVmosUWqMryI58eAAuGNv91L3HZuiZwmqKZHE+P3ECqRJbjUEgVTjcLfHnrf8MJ/86OtxN1OtNbACsx2cZtKZ4tHjpR5pA5KjUGucIHyCQvyhvbZvvVwIDAQAB"]
}

/**
 * 送信経路（Resend の新しい方式では SPF を TXT ではなく CNAME で持つ）。
 *
 * **`rmta.net` は Resend の MTA である。** include ではなく委譲の形なので、
 * SPF の 10 回ルックアップ制限を消費しない。リージョンは Tokyo（`apne1`）。
 */
resource "aws_route53_record" "resend_spf_rsend" {
  zone_id = aws_route53_zone.game_forge.zone_id
  name    = "rsend.${aws_route53_zone.game_forge.name}"
  type    = "CNAME"
  ttl     = 300
  records = ["rsend-apne1.forge.rmta.net"]
}

/**
 * Return-Path（バウンスの戻り先）。
 */
resource "aws_route53_record" "resend_spf_send" {
  zone_id = aws_route53_zone.game_forge.zone_id
  name    = "send.${aws_route53_zone.game_forge.name}"
  type    = "CNAME"
  ttl     = 300
  records = ["send.forge.rmta.net"]
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
resource "aws_route53_record" "resend_dmarc" {
  zone_id = aws_route53_zone.game_forge.zone_id
  name    = "_dmarc.${aws_route53_zone.game_forge.name}"
  type    = "TXT"
  ttl     = 300
  records = ["v=DMARC1; p=none;"]
}

/**
 * Search Console の所有証明（`game-forge.ojos.jp` のドメインプロパティ。#610）。
 *
 * # なぜ apex に置くのか
 *
 * **`app.game-forge.ojos.jp` には置けない。** あちらは Pages へ向く CNAME を持っており、
 * **CNAME があるノードには他のレコードを置けない**（RFC 1034。実測で確認した）。
 * ドメインプロパティは DNS の確認が必須なので、`app.` を含む名前では検証できない。
 *
 * **apex なら衝突しない。** ここは Route53 のゾーンの頂点で CNAME を張れず（`dns.tf` 冒頭）、
 * TXT も置かれていなかった。
 *
 * # `ojos.jp` 側の所有証明とは別物である
 *
 * **消さないこと**で有名なもう 1 つの `google-site-verification`（`docs/gcp-oauth-setup.md` 4.3）は
 * **`ojos.jp` の DNS（さくら側）にあり、OAuth の承認済みドメインが依存している。**
 * こちらは `game-forge.ojos.jp` の所有を Search Console へ示すだけで、**OAuth とは無関係である。**
 *
 * **こちらは terraform で宣言できる。** あちらができないのは、承認済みドメインが eTLD+1
 * （`ojos.jp`）でなければならず、そのゾーンがさくら側で API を持たないためである（同 4.3）。
 * **同じ種類の値なのに置き場所が違う理由は、そこにしかない。**
 *
 * # 値について
 *
 * **秘密ではない。** DNS に公開される値で、知られても所有権は移らない（所有権は「この値を
 * DNS へ置けること」で示される）。`resend_dkim` と同じ扱いで直に書く。
 *
 * **正本は Search Console の「所有権の確認」の画面である。** ここはその写しで、プロパティを
 * 作り直したら差し替える。**消すと所有証明が外れ、サイトマップの送信とインデックスのレポートが
 * 見られなくなる**（OAuth と本番の同意画面には影響しない。上記のとおり別物である）。
 *
 * **サイト管理者アカウント `game-forge@ojos.jp` で作った**（2026-09-17）。個人アカウントで
 * 作ったプロパティから移すためで、**個人アカウントが使えなくなってもサービスの管理が続く**
 * ようにする。
 */
resource "aws_route53_record" "search_console_verification" {
  zone_id = aws_route53_zone.game_forge.zone_id
  name    = aws_route53_zone.game_forge.name
  type    = "TXT"
  ttl     = 300
  records = ["google-site-verification=1mjJUM5QMby2hdiz3fuLVKA_ijum_yAIWuKxz7YMW1I"]
}
