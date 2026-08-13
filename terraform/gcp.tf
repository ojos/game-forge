/**
 * GCP プロジェクト（M1-2 / #12 の P1）。
 *
 * Google OAuth ログイン（仕様書 8.1）に使う OAuth クライアントを置く器を宣言する。
 *
 * この宣言が持つのはプロジェクトまでで、OAuth クライアントそのものは持たない。
 * Web アプリ用の OAuth クライアント ID は Google Cloud Console でしか発行できず、
 * google プロバイダにも gcloud にも対応するリソース・コマンドが無いためである
 * （google_iap_client は IAP ブランド配下の内部向けクライアント専用で、
 * 一般公開のコンシューマ向けアプリには使えない）。発行手順は docs/ に残す。
 *
 * 共通規範「外部サービスの状態管理」は宣言できる範囲を宣言側へ寄せることを求める。
 * OAuth クライアントが宣言できないことは、プロジェクトまで手作業にする理由には
 * ならないため、ここで線を引いている。
 */
resource "google_project" "game_forge" {
  project_id = var.gcp_project_id
  name       = var.gcp_project_name
  org_id     = var.gcp_org_id

  # auto_create_network は既定の true のままにする（明示しない）。
  #
  # false にすると apply が落ちる。プロバイダは false を「プロジェクトを作ってから
  # 既定ネットワークを削除する」手順で実装しており、その削除のために Compute Engine
  # API の有効化を要求する。API の有効化には請求先アカウントの紐付けが要るため、
  # 課金を紐付けない上記の方針と衝突する（実際に Error 400 UREQ_PROJECT_BILLING_NOT_FOUND
  # で失敗した）。
  #
  # そして既定 VPC は、Compute Engine API を有効にしない限り実体化しない。この宣言は
  # API を有効にせず課金も紐付けないため、既定のままでもネットワークは存在しない。
  # false は「存在しないものを消すために課金を有効にする」指定になり、逆効果である。
  # Compute Engine を使う段階が来たら、そのときに課金と併せて扱う。

  # 請求先アカウントは紐付けない。OAuth クライアントの発行と利用に課金は要らず、
  # 紐付ければ意図しない課金の経路を先に作ることになる。課金が要る API を使う段階で
  # billing_account を足す（roles/billing.admin は取得済みのため、その時点で足せる）。

  # 誤った destroy でプロジェクトごと消えることを防ぐ。プロジェクトを消すと配下の
  # OAuth クライアントも消え、再発行した client_id は別の値になるため、実機の
  # ログインが黙って壊れる。意図して消すときはこの値を変えてから destroy する。
  deletion_policy = "PREVENT"
}
