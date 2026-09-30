/**
 * game-forge の 3 ホストの入口の守り（WAF とゾーンの設定。#776）。
 *
 * **#594 で「AI の学習クローラは拒否し、検索用・回答用は許可する」と決めた。** 手段は
 * `robots.txt` と Content Signals（`ai-train=no`）の自主規制だけで、**従わないクローラは
 * 止められていなかった。** #775 でゾーンが Cloudflare へ移り、入口で止められるようになった。
 *
 * # 効くのはプロキシ（オレンジ雲）を通る要求だけ
 *
 * WAF もゾーンの設定も、**DNS only のホストには 1 つも効かない。** 3 ホストのプロキシは
 * `local.game_forge_pages_proxied`（dns-ojos-jp.tf）が決める。**このファイルの宣言を先に
 * 入れ、プロキシは最後に切り替える**（#776 の constraints）。切り替えで何か壊れたら、
 * proxied を false に戻せば元に戻る。
 *
 * # 対象は 3 ホストに絞る
 *
 * ゾーン（ojos.jp）には、トンネルの 2 本（llm01 / dev01-ssh。tunnel-dev01.tf）も載っている。
 * **マネージドルールを LLM の口にかけると、コードを含むプロンプトを攻撃と誤判定しうる。**
 * ルールの式は game-forge の 3 ホストだけに当てる（`local.game_forge_waf_hosts_expression`）。
 *
 * # 入れないもの（利用者の決定。2026-09-22 / 2026-09-30）
 *
 * - **Bot Fight Mode。** データセンターの IP から来るブラウザ以外の通信を止めにかかり、
 *   **AWS の Lambda からのコールバックと MCP の接続を止める恐れがある。Free では例外を作れない。**
 *   宣言しない（`cloudflare_bot_management` は Edit 権限が要る）。**切れていることは外部層の
 *   check_zone_bot_protection_off が見る。**
 * - **レート制限。** 別 issue（#699 の論点）。
 * - **AI Crawl Control のダッシュボードでの遮断。** 操作すると WAF のカスタムルールが自動で
 *   作られ、宣言の外に状態ができる。同じ内容をここで直接宣言する。
 */

locals {
  /**
   * ルールの式が当たるホスト（Cloudflare の Rules 言語の集合）。値は dns-ojos-jp.tf の
   * `local.game_forge_pages_hosts` から導く（書き写さない）。
   */
  game_forge_waf_hosts_expression = format(
    "(http.host in {%s})",
    join(" ", [for h in values(local.game_forge_pages_hosts) : format("\"%s\"", h)])
  )

  /**
   * 入口で止める学習クローラ（User-Agent に含まれる名前）。
   *
   * **一覧の正本は `src/robots.ts` の `AI_TRAINING_CRAWLERS` である。** ここは写しで、
   * **scripts/check-ai-crawler-copies.sh（acceptance.sh から回る）が両者の一致を機械で照合する。**
   * robots.txt で拒否している相手と、入口で止める相手がずれないようにするため。
   *
   * **`Google-Extended` と `Applebot-Extended` は要求の User-Agent に現れない**（robots.txt の
   * 中でだけ使う名前。学習の可否の表明を読むための制御の印で、取りに来るのは `Googlebot` /
   * `Applebot` そのもの）。**止めても何も起きないが、一覧を正本と同じに保つために残す。**
   * 検索用の `Googlebot` / `Applebot` を止めないこと（#594 の決定）。
   */
  ai_training_crawlers = [
    "GPTBot",
    "ClaudeBot",
    "anthropic-ai",
    "CCBot",
    "Google-Extended",
    "Applebot-Extended",
    "meta-externalagent",
    "Bytespider",
  ]

  /**
   * 学習クローラを止めるルールの式。**大小文字を無視して部分一致で見る**（User-Agent は
   * `Mozilla/5.0 ... GPTBot/1.2 ...` の形で来る）。
   *
   * **部分一致が検索用・回答用を巻き込まないこと**は、一覧の名前が互いの部分文字列でないことで
   * 保たれる——`GPTBot` は `OAI-SearchBot` / `ChatGPT-User` に、`ClaudeBot` は `Claude-User` /
   * `Claude-SearchBot` に含まれない。
   */
  ai_training_block_expression = format(
    "%s and (%s)",
    local.game_forge_waf_hosts_expression,
    join(" or ", [for c in local.ai_training_crawlers : format("lower(http.user_agent) contains \"%s\"", lower(c))])
  )

  /**
   * Cloudflare Managed Free Ruleset の ID。**Cloudflare が全ゾーン共通で配っているルールセット**で、
   * このゾーンの一覧（`GET zones/<id>/rulesets`）にも `kind = managed` で載っている
   * （2026-09-30 の実測）。**機密ではない**——Cloudflare の文書に載っている固定値である。
   * 外部層の check_game_forge_waf が、この ID が名前どおりのルールセットであることを照らす。
   */
  cloudflare_free_managed_ruleset_id = "77454fe2d30c4220b5701f6fdfb893ba"

  /**
   * ゾーンの設定（HTML を書き換えるものと、ブラウザ以外を止めうるもの）。
   *
   * **HTML を書き換えるもの**は、CSP と sandbox のヘッダ（src/html.ts / 作品の配信）が前提に
   * している中身を変える。**2026-09-30 の実測で 4 つが on だった**（email_obfuscation /
   * server_side_exclude / automatic_https_rewrites / replace_insecure_js）。rocket_loader は off
   * だったが、切れていることを宣言で固定する。
   *
   * **ブラウザ以外を止めうるもの**（browser_check / security_level）は、プロキシを通った瞬間に
   * AWS の Lambda からのコールバックと MCP の接続へ「確認」を挟みうる。ブラウザでない相手には
   * 403 に見える。**利用者の決定で両方切る（2026-09-30）**——DNS only の今の挙動にいちばん近く、
   * 止めるのは学習クローラのルールとマネージドルールだけになる。ゾーン全体の設定なので
   * トンネルの 2 本にも効くが、あちらは Access が守っている。
   */
  ojos_jp_zone_settings = {
    email_obfuscation        = "off"
    server_side_exclude      = "off"
    automatic_https_rewrites = "off"
    replace_insecure_js      = "off"
    rocket_loader            = "off"
    browser_check            = "off"
    security_level           = "essentially_off"
  }
}

resource "cloudflare_zone_setting" "ojos_jp" {
  for_each = local.ojos_jp_zone_settings

  zone_id    = cloudflare_zone.ojos_jp.id
  setting_id = each.key
  value      = each.value
}

/**
 * マネージドルール（Cloudflare Managed Free Ruleset）を 3 ホストに当てる。
 *
 * **誤判定（Go のソースを含む要求など）が出たら、その経路だけをスキップするルールで扱い、
 * マネージドルールを丸ごと外さない**（#776 の constraints）。
 */
resource "cloudflare_ruleset" "game_forge_managed" {
  zone_id     = cloudflare_zone.ojos_jp.id
  name        = "game-forge managed WAF"
  description = "Cloudflare Managed Free Ruleset for the game-forge hosts (#776)"
  kind        = "zone"
  phase       = "http_request_firewall_managed"

  rules = [
    {
      description = "Execute Cloudflare Managed Free Ruleset on game-forge hosts"
      expression  = local.game_forge_waf_hosts_expression
      action      = "execute"
      action_parameters = {
        id = local.cloudflare_free_managed_ruleset_id
      }
      enabled = true
    },
  ]
}

/**
 * 名乗って来る学習クローラを 403 で止める。**名乗らないものは止められない**（/faq の ai-training）。
 */
resource "cloudflare_ruleset" "game_forge_custom" {
  zone_id     = cloudflare_zone.ojos_jp.id
  name        = "game-forge custom WAF"
  description = "Block self-identified AI training crawlers on the game-forge hosts (#776 / #594)"
  kind        = "zone"
  phase       = "http_request_firewall_custom"

  rules = [
    {
      description = "Block AI training crawlers (list mirrors src/robots.ts AI_TRAINING_CRAWLERS)"
      expression  = local.ai_training_block_expression
      action      = "block"
      enabled     = true
    },
  ]
}
