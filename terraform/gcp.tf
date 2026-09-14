/**
 * GCP プロジェクト（M1-2 / #12 の P1）。
 *
 * Google OAuth ログイン（仕様書 8.1）に使う OAuth クライアントを置く器を宣言する。
 *
 * この宣言が持つのはプロジェクト（請求先アカウントの紐付けを含む）までで、OAuth
 * クライアントそのものは持たない。
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
  # プロバイダは false を「プロジェクトを作ってから既定ネットワークを削除する」手順で
  # 実装しており、その削除のために Compute Engine API の有効化を要求する。構築時は
  # 請求先アカウントを紐付けていなかったため、API の有効化が
  # Error 400 UREQ_PROJECT_BILLING_NOT_FOUND で失敗し、apply が落ちた。
  #
  # 下記のとおり今は請求先アカウントを紐付けているので、この失敗はもう歯止めに
  # ならない（有効化が通りうる）。それでも false にしない理由は変わらない。既定 VPC は
  # Compute Engine API を有効にしない限り実体化せず、この宣言は API を 1 つも有効に
  # しない（google_project_service を持たない）ため、既定のままでもネットワークは
  # 存在しない。false は「存在しないものを消すために、課金が発生しうる Compute Engine
  # API を有効にする」指定になり、逆効果である。Compute Engine を使う段階が来たら、
  # そのときに併せて扱う。

  # 請求先アカウントを紐付けている。2026-09-14 に利用者が Google OAuth のブランド確認の
  # ために Console で紐付け、後追いでこの宣言へ取り込んだ（#487）。ID は公開する必要が
  # 無いため、宣言へ直接書かず terraform.tfvars（追跡外）から受ける。
  #
  # 紐付けを外すと、ブランド確認に影響しうる。この行を消す・値を変える前に、Console で
  # OAuth 同意画面（ブランド）の確認状態を確かめること。変数に既定値を置かないのも
  # 同じ理由で、tfvars に値が無いまま plan して「紐付けを外す」差分を出させないため。
  #
  # 紐付けは課金が要る API を使い始めたことを意味しない。課金が要る API はいまも有効に
  # しておらず、OAuth クライアントの発行と利用にも課金は要らない。
  billing_account = var.gcp_billing_account

  # 誤った destroy でプロジェクトごと消えることを防ぐ。プロジェクトを消すと配下の
  # OAuth クライアントも消え、再発行した client_id は別の値になるため、実機の
  # ログインが黙って壊れる。意図して消すときはこの値を変えてから destroy する。
  deletion_policy = "PREVENT"
}
