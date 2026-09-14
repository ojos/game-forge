/**
 * GCP プロジェクト（M1-2 / #12 の P1）。
 *
 * Google OAuth ログイン（仕様書 8.1）に使う OAuth クライアントを置く器を宣言する。
 * 器は本番用（game_forge）と開発用（game_forge_dev。#479）の 2 つで、2 つの対照は
 * docs/gcp-oauth-setup.md 1 章にある。
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

/**
 * 開発用の GCP プロジェクト（#479）。
 *
 * ローカル開発のログインに使う OAuth クライアント（game-forge-dev）を置く器。
 * 2026-09-14 に利用者が Console で手作成し、後追いでこの宣言へ取り込んだ
 * （共通規範 4 章「手動で変更した場合は、後追いで宣言側へ反映する」）。
 *
 * 本番と分けた理由: 本番の同意画面を外部・本番環境へ切り替え、ブランド確認に出すには、
 * 承認済みドメインをすべて Search Console で所有証明する必要がある。他人のドメインである
 * localtest.me は証明できないため、ローカル用のリダイレクト URI を本番のクライアントに
 * 置けなくなった（docs/gcp-oauth-setup.md 1 章）。
 *
 * 本番（google_project.game_forge）と同じく請求先アカウントが紐付いている（下の注記）。
 * 同意画面（内部）と OAuth クライアントは、本番と同じく宣言できないので手順書が持つ。
 */
resource "google_project" "game_forge_dev" {
  project_id = var.gcp_dev_project_id
  name       = var.gcp_dev_project_name
  org_id     = var.gcp_org_id

  # auto_create_network は、本番と同じく既定の true のままにする（明示しない）。
  #
  # 理由は本番の注記と同じで、false はネットワークを消すためだけに、課金が発生しうる
  # Compute Engine API の有効化を要求する。このプロジェクトは下記のとおり請求先アカウントが
  # 紐付いているので、UREQ_PROJECT_BILLING_NOT_FOUND（本番の構築時に踏んだ失敗）は
  # 歯止めにならない。取り込み（import）でもプロバイダは state に true を入れるため、
  # 明示しなければ取り込みの直後に差分が出ない。
  #
  # 実測した現状（2026-09-14、読み取りのみ）: compute/v1/projects/<project_id>/global/networks
  # は PERMISSION_DENIED / accessNotConfigured を返した。Compute Engine API は無効で、
  # 既定ネットワークは無い。Console が作成時に有効にした API（BigQuery など）は残っているが、
  # その整理は #479 の範囲外である。

  # 請求先アカウントが紐付いている。**2026-09-14 に Console でプロジェクトを作成したときに
  # 自動で紐付いた**とみられる。本番の gcp_billing_account と同じ値を gcp_dev_billing_account に
  # 入れた plan で billing_account に差分が出なかったので、本番と同じアカウントである（PR #497）。
  # 利用者の判断で残し、この宣言を実物に合わせた（#479）。ID は公開する必要が無いため、
  # 宣言へ直接書かず terraform.tfvars（追跡外）の gcp_dev_billing_account から受ける。
  # 本番と同じアカウントかどうかは宣言で決め打ちせず、本番とは別の変数にしてある。
  #
  # 紐付けは課金が要る API を使っていることを意味しない。このサービスが開発用プロジェクトで
  # 使うのは OAuth クライアントだけで、課金は要らない。Console が作成時に既定で有効にした
  # API（BigQuery など）は残っているが、その整理は #479 の範囲外である。
  #
  # 外すときは、この行と変数 gcp_dev_billing_account を消し、plan で billing_account を外す
  # in-place の差分だけが出ることを確かめてから apply する（docs/gcp-oauth-setup.md 3.3）。
  billing_account = var.gcp_dev_billing_account

  # 本番と同じく、誤った destroy でプロジェクトごと消えることを防ぐ。消すと配下の
  # OAuth クライアントも消え、ローカルのログインが黙って壊れる。
  deletion_policy = "PREVENT"
}

# 開発用プロジェクトの取り込み（#479）。
#
# CLI の terraform import ではなく import ブロックにした理由: CLI の import は plan を
# 見せずに state を書き換える。import ブロックなら、取り込みも plan に並ぶので、置き換えや
# 削除の差分が無いことを、state を 1 行も書き換える前に確かめられる。
#
# **取り込んだ後も消さずに残す。** state に既にあるリソースへの import ブロックは何もしない
# （Terraform 1.5 以降）。残しておけば、state を作り直したときも「作成」ではなく「取り込み」
# の plan になり、手作成が起点であるという経緯も宣言に残る。
#
# id は文字列リテラルで書く。import ブロックの id に変数を使えるのは Terraform 1.6
# からで、versions.tf の required_version は >= 1.5.0 のためである。
# **var.gcp_dev_project_id の既定値を変えるときは、ここも合わせて変えること。** 合わない
# まま plan すると project_id が変わる置き換えの差分になる（apply しないで止める。
# deletion_policy = "PREVENT" により destroy の段でも失敗する）。
import {
  to = google_project.game_forge_dev
  id = "projects/ojos-game-forge-dev"
}
