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
  # false にしない理由: プロバイダは false を「プロジェクトを作ってから既定ネットワークを
  # 削除する」手順で実装しており、その削除のために Compute Engine API の有効化を要求する。
  # 構築時は請求先アカウントを紐付けていなかったため、API の有効化が
  # Error 400 UREQ_PROJECT_BILLING_NOT_FOUND で失敗し、apply が落ちた。下記のとおり今は
  # 請求先アカウントを紐付けているので、この失敗はもう歯止めにならない（有効化が
  # 通りうる）。それでも、ネットワークを消すためだけに、課金が発生しうる Compute Engine
  # API を有効にする指定になることは変わらないため、false にしない。
  #
  # (a) 実測した現状（2026-09-14、読み取りのみ）: このプロジェクトの
  # compute.googleapis.com/compute/v1/projects/<project_id>/global/networks を読むと
  # PERMISSION_DENIED / accessNotConfigured（Compute Engine API が無効）が返った。
  # Compute Engine API は無効で、既定ネットワークは存在しない。
  #
  # (b) 新規作成・API 有効化時の挙動: プロバイダのドキュメントは、true なら既定
  # ネットワークが作られ、false でも一度作られてから Terraform が削除する、としている。
  # GCP の既定ネットワークは、Compute Engine API を有効にした時点で作られうる。
  # この宣言は API を有効にしない（google_project_service を持たない）ので、(a) のとおり
  # 今はネットワークが無い。ただし (a) は既存のこのプロジェクトの実測であり、新規作成時に
  # 既定ネットワークが作られないことを確かめたものではない。Compute Engine API を有効に
  # する段階では、既定ネットワークの扱い（auto_create_network を含む）を併せて決め直す。

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
