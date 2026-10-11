/**
 * 試用の録画を置く、非公開の R2 バケット（#978）。
 *
 * # なぜ専用のバケットにするのか
 *
 * **録画は、試用者の画面と声である。** 作品の成果物（`game-forge` バケット）と同じ場所に置くと、
 * 次の 2 つが崩れる。
 *
 *   1. **「90 日で消す」を年齢のライフサイクル 1 本で言い切れない。** `game-forge` は年齢で消せない
 *      共有の成果物を持つ（`terraform/r2-lifecycle.tf` の冒頭）。接頭辞で絞った規則を足すことはできるが、
 *      **専用のバケットなら、規則の接頭辞を空にして「このバケットに置いたものはすべて 90 日で消える」
 *      と言える。** 同意の文面（`src/trial-text.ts` の `TRIAL_CONSENT_HTML`）の「録画は受け取ってから
 *      90 日で消します」を、宣言 1 つが保証する。
 *   2. **公開の口が開く経路を、1 つのバケットに閉じられない。** `game-forge` は配信の経路を持つ。
 *      録画のバケットは配信をしない——**r2.dev の公開 URL も、独自ドメインも持たない**（下の
 *      `cloudflare_r2_managed_domain` と、外部層の検査 `scripts/check-trial-recordings-bucket.sh`）。
 *      読めるのは Pages の束縛 `TRIAL_RECORDINGS`（`wrangler.toml`）を通した Worker だけで、Worker の中で
 *      読む口は管理画面の 1 本だけである（`src/admin/trials.ts`）。
 *
 * # 名前は wrangler.toml から読む
 *
 * **正本は `wrangler.toml` の `[[env.production.r2_buckets]]` のうち、`binding = "TRIAL_RECORDINGS"` の
 * ブロックである**（Worker が実際に綴じられる先はそこにしかない）。`terraform/r2-lifecycle.tf` の
 * `r2_bucket_name` と同じ理由で、名前をここへ書き写さない。読めなければ `regex()` が plan で落ちる。
 *
 * # 置き場所（location）を宣言しない
 *
 * 位置の指定は作るときの「ヒント」で、作った後は変えられない。値の綴り（大文字・小文字）の扱いが
 * プロバイダと API で揃わないと、毎回の plan に差分が出る。**apply を回すのは利用者の Mac（日本）なので、
 * 指定しなくても近い地域に作られる。**
 *
 * # 消し方
 *
 * **`prevent_destroy` を置く。** 録画は試用の唯一の材料で、宣言を消した拍子にバケットごと消えると
 * 取り返しがつかない（中身があれば API も消させないが、空になった直後に消える道は塞ぐ）。
 * やめるときは、この宣言を外したうえで、中身が 90 日で消えてから手で消す。
 */

locals {
  /**
   * 録画のバケットの名前（`wrangler.toml` の `TRIAL_RECORDINGS` の束縛から読む）。
   *
   * ブロックの中の並びは `binding` → `bucket_name` に固定する（`wrangler.toml` の注記）。並びが変わると
   * ここが一致しなくなり、plan が落ちる——**黙って別の名前へ落ちない。**
   */
  trial_recordings_bucket_name = regex("\\[\\[env\\.production\\.r2_buckets\\]\\]\\s*\\nbinding\\s*=\\s*\"TRIAL_RECORDINGS\"\\s*\\nbucket_name\\s*=\\s*\"([^\"]+)\"", file("${path.module}/../wrangler.toml"))[0]

  /**
   * 録画を残す日数（**90 日**）。
   *
   * **`src/trial-store.ts` の `TRIAL_RETENTION_DAYS` と同じ値でなければならない。** 同意の文面と `/privacy` は
   * あちらを読む。突き合わせは `test/trial-recording.test.ts` が、この行を読んで行う（書き写しを機械で照合する）。
   * R2 のライフサイクルは期限を過ぎてから 24 時間ほどのうちに消すので、実際に消えるのは 90〜91 日目である。
   */
  trial_recordings_retention_days    = 90
  trial_recordings_retention_seconds = local.trial_recordings_retention_days * 24 * 60 * 60

  /**
   * 未完了のマルチパートアップロードを打ち切るまでの日数（1 日）。
   *
   * Worker は断片を `put` 1 回で書くので、マルチパートは使わない。**使わないものの断片が残らないこと**を
   * 宣言しておく（`terraform/r2-lifecycle.tf` と同じ考え方。あちらは 7 日だが、こちらは揃える理由が無い）。
   */
  trial_recordings_abort_multipart_days    = 1
  trial_recordings_abort_multipart_seconds = local.trial_recordings_abort_multipart_days * 24 * 60 * 60

  /** ライフサイクルの規則の id（外部層の検査が output から読む）。 */
  trial_recordings_delete_rule_id = "delete-trial-recordings-after-retention"
  trial_recordings_abort_rule_id  = "abort-incomplete-multipart-uploads"
}

/** 録画のバケット。 */
resource "cloudflare_r2_bucket" "trial_recordings" {
  account_id = var.cloudflare_account_id
  name       = local.trial_recordings_bucket_name

  lifecycle {
    prevent_destroy = true
  }
}

/**
 * r2.dev の公開 URL を**閉じたまま**にする。
 *
 * 新しいバケットは既定で閉じているが、**ダッシュボードで 1 回押せば開く。** 開いた状態を宣言との差分として
 * plan に出すために、閉じていることを宣言する（外部層の検査も実物を見る）。
 */
resource "cloudflare_r2_managed_domain" "trial_recordings" {
  account_id  = var.cloudflare_account_id
  bucket_name = cloudflare_r2_bucket.trial_recordings.name
  enabled     = false
}

/**
 * 録画のライフサイクル。**接頭辞を絞らず、置いたものをすべて 90 日で消す。**
 *
 * `terraform/r2-lifecycle.tf` が「接頭辞の空な削除規則」を禁じているのは、**`game-forge` バケットが
 * 共有の成果物を持つから**である。このバケットには録画の断片しか置かない（書くのは
 * `src/trial-recording.ts` の 1 か所だけ）ので、その理由が当たらない。
 */
resource "cloudflare_r2_bucket_lifecycle" "trial_recordings" {
  account_id  = var.cloudflare_account_id
  bucket_name = cloudflare_r2_bucket.trial_recordings.name

  rules = [
    {
      id      = local.trial_recordings_abort_rule_id
      enabled = true
      conditions = {
        prefix = ""
      }
      abort_multipart_uploads_transition = {
        condition = {
          type    = "Age"
          max_age = local.trial_recordings_abort_multipart_seconds
        }
      }
    },
    {
      id      = local.trial_recordings_delete_rule_id
      enabled = true
      conditions = {
        prefix = ""
      }
      delete_objects_transition = {
        condition = {
          type    = "Age"
          max_age = local.trial_recordings_retention_seconds
        }
      }
    },
  ]
}

output "trial_recordings_bucket_name" {
  description = <<-EOT
    試用の録画を置く R2 バケットの名前（#978）。値は wrangler.toml の TRIAL_RECORDINGS の束縛から読んでいる。
    外部層の検査（scripts/check-trial-recordings-bucket.sh）がこれを対象として実物を引く。
  EOT
  value       = cloudflare_r2_bucket.trial_recordings.name
}

output "trial_recordings_retention_seconds" {
  description = "録画を消すまでの秒数（90 日）。外部層の検査が実物の削除規則と突き合わせる。"
  value       = local.trial_recordings_retention_seconds
}

output "trial_recordings_abort_multipart_seconds" {
  description = "録画のバケットで、未完了のマルチパートアップロードを打ち切るまでの秒数。外部層の検査が突き合わせる。"
  value       = local.trial_recordings_abort_multipart_seconds
}

output "trial_recordings_delete_rule_id" {
  description = "録画を消す規則の id。外部層の検査は、この id の規則に接頭辞の空な Age の削除を求める。"
  value       = local.trial_recordings_delete_rule_id
}

output "trial_recordings_abort_rule_id" {
  description = "録画のバケットで、未完了のマルチパートアップロードを打ち切る規則の id。"
  value       = local.trial_recordings_abort_rule_id
}

output "trial_recordings_lifecycle_rule_ids" {
  description = "録画のバケットに宣言しているライフサイクルの規則の id の一覧。外部層の検査は、実物の id の集合がこれと一致することを見る。"
  value       = [for rule in cloudflare_r2_bucket_lifecycle.trial_recordings.rules : rule.id]
}
