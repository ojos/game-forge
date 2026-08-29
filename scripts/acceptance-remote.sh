#!/usr/bin/env bash
# acceptance-remote.sh — 外部層の受け入れ条件（プロジェクトが所有・編集する）
#
# 受け入れ条件はローカル層と外部層に分かれる。
#
#   ローカル層（scripts/acceptance.sh）  ネットワークも外部認証も要さない検査。
#                                        ループの接地信号。これが緑なら実装は前へ
#                                        進んでよい。
#   外部層（このファイル）               宣言（IaC 等）と実際の外部状態が一致して
#                                        いるかの検査。外部認証とネットワークを要する。
#
# 起動方法:
#   VERIFY_ACCEPTANCE=scripts/acceptance-remote.sh bash scripts/verify.sh
#
# scripts/loop-gate.sh へは含めない:
#   あちらは push / PR 前の単一入口だが、外部層をそこへ入れると、認証の失効や
#   オフラインでゲート全体が止まる。実装が正しいのにループが止まる状態を作らない。
#   単一入口の目的は「複数の検査を別々に思い出す運用は破綻する」ことを機構で塞ぐ
#   ことであって、外部の可用性をゲートの前提条件に持ち込むことではない。
#
# 通す契機:
#   外部状態の宣言を変更したとき。反復のたびに回す層ではない。
#
# 前提:
#   対象サービスへ認証済みであること。このスクリプトは認証を行わない（資格情報を
#   スクリプトへ書き写す経路を作らないため）。未認証やオフラインで回すと個々の検査が
#   失敗するが、それは「宣言と外部状態が食い違っている」ことを意味しない。前提の
#   不成立と実際の乖離を読み分けられるよう、前提の確認（ログイン状態の検査など）を
#   最初の検査として置くとよい。
#
# 終了コード: 0 = 合格 / 非0 = 不合格・未定義
#
# set -e は使わない。1 件目の失敗で止めず、全件を見てから落とすため。
set -uo pipefail

# 検証はプロジェクトルート基準で行う。scripts/ の 1 階層上がルート。
# 任意の作業ディレクトリから起動しても結果が不変になるよう、起動時 CWD に依存しない。
#
# set -e を使わないため、失敗しうる代入には個別にガードを置く。HERE の解決に失敗
# しても止めないと、空の HERE に対して dirname が "." を返し、続く cd が「成功」して
# ガードを素通りする（実測: dirname "" = "." で cd は 0）。ルートへ移れていないのに
# 検査を始めると、相対パスが別の場所を指したまま合否を出すことになる。
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)" || exit 1
cd "$(dirname "$HERE")" || exit 1

echo "[acceptance-remote] external state checks"

# 実際に検査を 1 つでも実行したか。1 つも実行できなければ「合格」ではなく失敗にする。
# 検証していないことを合格として報告するのが最悪であるため。
ran_any=0
# 失敗件数。外部状態の乖離は複数箇所へ同時に出ることが多く、1 件ずつ往復すると
# 回数だけ増える。
failed=0

# 各検査の出力を退避する一時ログ。mktemp のテンプレートで作り、$$ 由来の予測可能な
# 名前は使わない（同名を先に置かれると書き込み先を乗っ取られる）。
#
# ここも代入ガードを置く（set -e が無いため）。作成に失敗したまま進むと LOG が空になり、
# run の中の >"$LOG" が必ず失敗して、実行できていない検査が「失敗した検査」として
# 報告される（実測: 空の対象へのリダイレクトは rc=1）。原因の異なる赤を同じ形で
# 出さないよう、ここで落とす。
LOG="$(mktemp "${TMPDIR:-/tmp}/acceptance-remote.XXXXXX")" || exit 1

# **緑のときの出力は捨てられる**（`run` は成功したら $LOG を読まない）。そのため
# 「一致してはいるが、劣化した状態である」ことを検査の中から伝える手段が無かった。
# **通知はここへ溜め、最後にまとめて出す**（#103）。落とさないが、埋もれもしない。
WARNINGS="$(mktemp "${TMPDIR:-/tmp}/acceptance-remote-warn.XXXXXX")" || exit 1
trap 'rm -f "$LOG" "$WARNINGS"' EXIT

warn() { printf '%s\n' "$*" >>"$WARNINGS"; }

# ラベル付きで 1 件実行する。成功時は出力を捨て、失敗したときだけ出力を見せる。
# 正常な実行の出力で画面が埋まると、失敗の位置が読めなくなる。
#
#   run "<ラベル>" <コマンド> [引数...]
#
# サブシェル（パイプの構成要素・コマンド置換・( ) の中）から呼ばないこと。
# ran_any と failed の更新が親へ伝わらず、実行したのに「未定義」、失敗したのに
# 合格という報告になる。
run() {
  local label="$1"
  shift
  ran_any=1
  printf '[acceptance-remote] %s\n' "$label"
  if "$@" >"$LOG" 2>&1; then
    return 0
  fi
  failed=$((failed + 1))
  printf '[acceptance-remote] FAIL: %s\n' "$label" >&2
  sed 's/^/    /' "$LOG" >&2
  return 1
}

# ── 外部状態の検査 ──────────────────────────────────────────────────────────
#
# 対象は GitHub 上のリポジトリ状態で、宣言は terraform/ にある。
#
# 検査対象の識別子（owner/repo、既定ブランチ名、必須チェック名、可視性）は、すべて
# terraform の output から取る。ここへ書き写すと、宣言を変えたときに検査だけが古い
# 対象・古い期待値を見続ける（shared-ai-rules.md 12 章「一覧の複製は機械照合で担保する」）。

TF_DIR="terraform"

# 前提の確認を最初に置く。未認証やオフラインでの失敗は「宣言と外部状態の乖離」では
# ないため、乖離の検査より前に、前提の不成立として先に見えるようにする。
#
# AWS の確認も必ず terraform plan より前に置くこと。plan は AWS プロバイダを通るため、
# 資格情報が失効していると plan 側が先に落ちる。そのときのメッセージはプロバイダ由来で
# 読み解きにくく、「宣言と実状態が食い違っている」のか「単に SSO が切れている」のかを
# 切り分けられない。前提を先に見せることが、この並び順の目的である。

# ── Cloudflare の資格情報（#95）──────────────────────────────────────────────
#
# gh と aws は**ツール自身のログイン状態**を持つが、**Cloudflare は持たない。**
# `wrangler login` は OAuth のコールバックをブラウザで受けるため、ブラウザの無い
# devcontainer では完結しない（.env.example の CLOUDFLARE_API_TOKEN の項）。この
# 環境での供給元は `.env` だけである。
#
# **ここで .env を読むのは「認証を行う」ことではない。** このスクリプトの前提
# （冒頭）が禁じているのは、資格情報をスクリプトへ書き写す経路を作ることである。
# ローダー（scripts/load-project-env.sh）は、wrangler 自身が読むのと同じ名前・同じ
# 値を、追跡外の .env から環境へ移すだけで、値をここへは持ち込まない。同じ形は
# scripts/check-no-secrets.sh と scripts/verify-commit-identity.sh が既に採っている。
#
# **読まないと、同じリポジトリ状態が呼び出し方で違う答えを出す。** .env を読み込み
# 済みの対話シェルからは通り、非対話シェル（rc を読まない）からは「未認証」になる。
# 前提の不成立と実際の乖離を読み分けるという、このスクリプトの目的そのものが壊れる。
cf_load_credentials() {
  if [[ -n "${CLOUDFLARE_API_TOKEN:-}" && -n "${CLOUDFLARE_ACCOUNT_ID:-}" ]]; then
    return 0
  fi
  local loader="$HERE/load-project-env.sh"
  if [[ -f "$loader" ]]; then
    # shellcheck source=scripts/load-project-env.sh
    . "$loader"
  fi
}

##
# Cloudflare の API を叩き、応答の本体を標準出力へ返す。
#
# **診断は標準エラーへ書く。** 標準出力は呼び出し側が jq へ渡す本体そのもので、
# ここへ混ぜると壊れた JSON を解析させることになる（run は両方を拾って失敗時に
# 表示する）。
#
# **`.success` を見る。終了コードだけで判定しない。** Cloudflare は認証エラーでも
# HTTP 200 で `success: false` を返すことがあり、`curl -f` では拾えない。
#
# 引数: $1 = /client/v4/ 以降のパス
# 戻り値: 0 = 応答を取得できた / 1 = 到達できない・API がエラーを返した
##
cf_api() {
  local path="$1" body
  if ! body="$(curl -sS --max-time 30 \
    -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" \
    "https://api.cloudflare.com/client/v4/${path}" 2>&1)"; then
    echo "Cloudflare API へ到達できません（${path}）: ${body}" >&2
    return 1
  fi
  if ! jq -e '.success == true' <<<"$body" >/dev/null 2>&1; then
    echo "Cloudflare API がエラーを返しました（${path}）:" >&2
    jq -c '.errors // .' <<<"$body" >&2 2>/dev/null || printf '%s\n' "$body" >&2
    return 1
  fi
  printf '%s' "$body"
}

##
# Cloudflare の API トークンが有効であることを確認する（前提の確認）。
#
# 配備ずれの検査より前に置く。トークンが切れているだけの状態を「本番が古い」と
# 報告すると、取るべき行動（トークンの再発行 / 配備のやり直し）が読み違えられる。
#
# 戻り値: 0 = 有効 / 1 = 未設定・失効・到達不能
##
check_cloudflare_authenticated() {
  cf_load_credentials
  if [[ -z "${CLOUDFLARE_API_TOKEN:-}" || -z "${CLOUDFLARE_ACCOUNT_ID:-}" ]]; then
    echo "CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID が環境にも .env にもありません。"
    echo "  .env へ両方を設定すること（雛形と発行手順は .env.example / docs/pages-deploy.md）。"
    return 1
  fi

  local body status
  body="$(cf_api "user/tokens/verify")" || return 1
  status="$(jq -r '.result.status // ""' <<<"$body")"
  if [[ "$status" != "active" ]]; then
    echo "API トークンが有効ではありません（status=${status:-(不明)}）。"
    echo "  ダッシュボードの My Profile > API Tokens で再発行し、.env を差し替えること。"
    echo "  **期限は API から読めない**ため、確認はダッシュボードでのみ可能（docs/pages-deploy.md）。"
    return 1
  fi
  echo "cloudflare api token is active"
}

# ── GCP の ADC（#99）────────────────────────────────────────────────────────
#
# terraform は google プロバイダを ADC（Application Default Credentials）で通す。
# ADC が失効していると plan が
#
#   Error: Error when reading or editing Project "...": oauth2: "invalid_grant"
#   "reauth related error (invalid_rapt)"
#
# で落ちる。**これは宣言と外部状態の乖離ではなく前提の不成立である**のに、メッセージは
# プロバイダ由来で、乖離と読み分けられない（2026-08-27 に 2 回、切り分けに手間取った）。
# AWS を plan より前に置いているのとまったく同じ理屈なので、GCP もここへ置く。
#
# **認証は行わない**（冒頭の前提）。ADC の作成はブラウザでのサインインを要するため、
# そもそもスクリプトからは行えない。ここで見るのは状態だけである。
#
# **アクセストークンを表示しない。** 取得できたトークンは変数に留め、出力へは載せない
# （run は失敗時に出力をそのまま見せるため、載せると資格情報がログへ落ちる）。
# 失効時に表示するのは gcloud のエラー文であって、トークンではない。
##
# ADC が使えること、かつ **CLI と同じアカウントで作られていること**を確認する。
#
# 2 つ目を見る理由。ADC のアカウントはブラウザでサインインしたアカウントになるため、
# 別のアカウントのままサインインすると**認証は成功する**。print-access-token も通る。
# 落ちるのは plan だけで、しかも 403（does not have permission）になるため、
# 「宣言が食い違っている」のか「別人として認証できている」のかが読み取れない
# （#89 で踏み、2026-08-26 / 08-27 にも再発した。docs/gcp-oauth-setup.md 2 章）。
# gcloud CLI の認証と ADC は別の資格情報で**両方が要る**と手順書が定めている以上、
# 両者のアカウントが食い違っている状態は、それ自体が前提の不成立である。
#
# 期待するアカウントをここへ書き写さない。書き写せば、担当者が変わったときに検査だけが
# 古い期待値を見続ける（shared-ai-rules.md 12 章）。**2 つの資格情報を互いに照合する**
# ことで、書き写しを増やさずに取り違えを捕まえる。
#
# 限界: 両方が同じ「別人」で作られていれば通る。それでも、実際に起きた事故
# （CLI は ido@ojos.jp のまま、ADC だけが別アカウントで作られる）はここで落ちる。
#
# 出力: 不成立の理由と対処を標準出力へ書く（run が失敗時のみ表示する）
# 戻り値: 0 = 前提が成立 / 1 = 未認証・失効・アカウントの取り違え
##
check_gcp_adc() {
  if ! command -v gcloud >/dev/null 2>&1; then
    echo "gcloud が見つかりません。devcontainer を再ビルドすること（google-cloud-cli feature）。"
    return 1
  fi

  local cli_account adc_token adc_email
  cli_account="$(gcloud auth list --filter=status:ACTIVE --format='value(account)' 2>/dev/null | head -1)"
  if [[ -z "$cli_account" ]]; then
    echo "gcloud CLI が未認証です（有効なアカウントがありません）。"
    echo "  gcloud auth login"
    return 1
  fi

  # 失敗時は標準エラーも掴む。gcloud は失効の理由（invalid_grant / reauth など）を
  # そちらへ書くため、捨てると「なぜ切れたのか」が読めなくなる。
  # **stderr をトークンへ混ぜない。** `2>&1` で受けると、gcloud が更新通知などを stderr へ
  # 出した瞬間にトークンが複数行になり、下の Authorization ヘッダが壊れる。**認証は通って
  # いるのに「アカウントを特定できません」で落ちる**という、原因の読めない赤になる
  # （この issue が塞ごうとしているものそのもの）。失敗時のメッセージは要るので、
  # stderr は捨てずに別ファイルへ受ける。
  local adc_stderr
  adc_stderr="$(mktemp "${TMPDIR:-/tmp}/gcp-adc.XXXXXX")" || return 1
  if ! adc_token="$(gcloud auth application-default print-access-token 2>"$adc_stderr")"; then
    echo "ADC が使えません（未作成、または失効）。terraform は ADC を読むため plan が落ちます。"
    echo "  対処: gcloud auth application-default login --no-launch-browser"
    echo "  gcloud auth login とは別の資格情報で、両方が要る（docs/gcp-oauth-setup.md 2 章）。"
    echo "  --no-launch-browser は devcontainer にブラウザが無いため（AWS SSO の --use-device-code と同じ事情）。"
    echo "  gcloud の出力:"
    # ここに入っているのはトークンではなく gcloud のエラー文である（取得に失敗している）。
    sed 's/^/    /' "$adc_stderr"
    rm -f "$adc_stderr"
    return 1
  fi
  rm -f "$adc_stderr"
  # 念のため 1 行であることを見る。トークンは 1 行で返るが、混ざったときに気づけるようにする。
  if [[ "$adc_token" == *$'\n'* ]]; then
    echo "ADC のトークンが複数行で返りました。gcloud の出力に想定外のものが混ざっています。"
    return 1
  fi

  # トークンの持ち主を Google に問い合わせる（docs/gcp-oauth-setup.md 2 章の確認コマンド）。
  # 手元のファイルではなく発行元に訊くので、「誰として認証できているか」が実際に分かる。
  adc_email="$(curl -sS --max-time 30 https://www.googleapis.com/oauth2/v3/userinfo \
    -H "Authorization: Bearer ${adc_token}" 2>/dev/null | jq -r '.email // ""' 2>/dev/null)"
  if [[ -z "$adc_email" ]]; then
    echo "ADC のトークンは取得できましたが、アカウントを特定できません。"
    echo "  https://www.googleapis.com/oauth2/v3/userinfo が email を返しませんでした（到達不能か、スコープ不足）。"
    echo "  対処: gcloud auth application-default login --no-launch-browser でやり直すこと。"
    return 1
  fi

  if [[ "$adc_email" != "$cli_account" ]]; then
    echo "ADC が gcloud CLI と別のアカウントで作られています（認証は成功していますが別人です）。"
    echo "  ADC（terraform が読む）: ${adc_email}"
    echo "  gcloud CLI:              ${cli_account}"
    echo "  この状態は認証としては通り、terraform plan だけが"
    echo "  'the user does not have permission to access Project ...' で落ちます。"
    echo "  対処: ブラウザで正しいアカウントへサインインし直してから"
    echo "        gcloud auth application-default login --no-launch-browser"
    return 1
  fi

  echo "gcp adc is active (${adc_email})"
}

run "prerequisite: gh authenticated" gh auth status
run "prerequisite: aws authenticated" aws sts get-caller-identity
run "prerequisite: cloudflare api token is active" check_cloudflare_authenticated
run "prerequisite: gcp adc is active" check_gcp_adc

# terraform 自身も外部（プロバイダレジストリ）へ出る。init 済みでなければ plan は
# 実行できないため、ここで冪等に通す。
run "terraform init" terraform -chdir="$TF_DIR" init -input=false -upgrade=false

# 宣言と実状態の一致。-detailed-exitcode は差分なしで 0、差分ありで 2、エラーで 1 を返す。
# 差分ありを合格にしないため、非0 をそのまま失敗として扱う。
run "terraform plan: no drift" terraform -chdir="$TF_DIR" plan -detailed-exitcode -input=false

# 以降の検査は output を期待値として使う。plan が通っていない状態では output も
# 信頼できないため、取得できなければ個々の検査を失敗させる。
tf_output() {
  terraform -chdir="$TF_DIR" output -raw "$1" 2>/dev/null
}

##
# 宣言したリポジトリが実在し、可視性が宣言と一致することを確認する。
#
# 出力: 不一致・取得失敗の内容を標準出力へ書く（run が失敗時のみ表示する）
# 戻り値: 0 = 一致 / 1 = 不一致または取得失敗
##
check_repository() {
  local full_name expected_visibility actual_visibility
  full_name="$(tf_output repository_full_name)" || return 1
  expected_visibility="$(tf_output repository_visibility)" || return 1
  if [[ -z "$full_name" || -z "$expected_visibility" ]]; then
    echo "terraform output からリポジトリ識別子を取得できません。apply 済みか確認すること。"
    return 1
  fi

  actual_visibility="$(gh api "repos/${full_name}" --jq '.visibility')" || return 1
  if [[ "$actual_visibility" != "$expected_visibility" ]]; then
    echo "可視性が宣言と一致しません: expected=${expected_visibility} actual=${actual_visibility}"
    return 1
  fi
  echo "repository ${full_name} exists (visibility=${actual_visibility})"
}

##
# 既定ブランチが宣言どおりであることを確認する。
#
# 戻り値: 0 = 一致 / 1 = 不一致または取得失敗
##
check_default_branch() {
  local full_name expected actual
  full_name="$(tf_output repository_full_name)" || return 1
  expected="$(tf_output default_branch)" || return 1
  actual="$(gh api "repos/${full_name}" --jq '.default_branch')" || return 1
  if [[ "$actual" != "$expected" ]]; then
    echo "既定ブランチが宣言と一致しません: expected=${expected} actual=${actual}"
    return 1
  fi
  echo "default branch = ${actual}"
}

##
# 既定ブランチの保護が宣言どおりであることを確認する。
#
# 必須チェック名は集合として比較する（順序差で落とさない）。force push とブランチ削除の
# 禁止は、宣言側で緩めない前提の項目なので、実状態が有効になっていないことを失敗にする。
#
# 戻り値: 0 = 一致 / 1 = 不一致または取得失敗
##
check_branch_protection() {
  local full_name branch protection expected_contexts actual_contexts
  full_name="$(tf_output repository_full_name)" || return 1
  branch="$(tf_output default_branch)" || return 1

  protection="$(gh api "repos/${full_name}/branches/${branch}/protection")" || return 1

  expected_contexts="$(terraform -chdir="$TF_DIR" output -json required_status_checks | jq -S 'sort')" || return 1
  actual_contexts="$(jq -S '.required_status_checks.contexts | sort' <<<"$protection")" || return 1
  if [[ "$expected_contexts" != "$actual_contexts" ]]; then
    echo "必須ステータスチェックが宣言と一致しません: expected=${expected_contexts} actual=${actual_contexts}"
    return 1
  fi

  if [[ "$(jq -r '.allow_force_pushes.enabled' <<<"$protection")" != "false" ]]; then
    echo "force push が禁止されていません。"
    return 1
  fi
  if [[ "$(jq -r '.allow_deletions.enabled' <<<"$protection")" != "false" ]]; then
    echo "ブランチ削除が禁止されていません。"
    return 1
  fi
  if ! jq -e '.required_pull_request_reviews' <<<"$protection" >/dev/null; then
    echo "PR 必須の設定がありません。直接 push が通る状態です。"
    return 1
  fi
  echo "branch protection on ${branch} matches the declaration"
}

##
# Actions 変数 ALLOWED_AUTHOR_EMAILS が宣言どおりの値で存在することを確認する。
#
# この変数が欠けると identity-guard.yml の照合が全件不一致になるため、存在だけでなく
# 値まで突き合わせる。
#
# 戻り値: 0 = 一致 / 1 = 不一致または取得失敗
##
check_actions_variable() {
  local full_name expected actual
  full_name="$(tf_output repository_full_name)" || return 1
  expected="$(tf_output allowed_author_emails)" || return 1
  if [[ -z "$expected" ]]; then
    echo "宣言側から ALLOWED_AUTHOR_EMAILS の値を取得できません。"
    return 1
  fi

  actual="$(gh api "repos/${full_name}/actions/variables/ALLOWED_AUTHOR_EMAILS" --jq '.value')" || return 1
  if [[ "$actual" != "$expected" ]]; then
    echo "ALLOWED_AUTHOR_EMAILS が宣言と一致しません。"
    return 1
  fi
  echo "actions variable ALLOWED_AUTHOR_EMAILS matches the declaration"
}

##
# 宣言した Route53 ホストゾーンが実在し、ネームサーバが宣言と一致することを確認する。
#
# ゾーン ID と期待する NS は terraform output から取る。ここへ書き写すと、宣言を
# 変えたときに検査だけが古い値を見続ける（shared-ai-rules.md 12 章）。
#
# 戻り値: 0 = 一致 / 1 = 不一致または取得失敗
##
check_dns_zone() {
  local zone_id zone_name expected_ns actual_ns
  zone_id="$(tf_output dns_zone_id)" || return 1
  zone_name="$(tf_output dns_zone_name)" || return 1
  if [[ -z "$zone_id" || -z "$zone_name" ]]; then
    echo "terraform output から DNS ゾーンの識別子を取得できません。apply 済みか確認すること。"
    return 1
  fi

  expected_ns="$(terraform -chdir="$TF_DIR" output -json dns_zone_name_servers | jq -S 'map(ascii_downcase) | sort')" || return 1
  actual_ns="$(aws route53 get-hosted-zone --id "$zone_id" --query 'DelegationSet.NameServers' --output json | jq -S 'map(ascii_downcase) | sort')" || return 1
  if [[ "$expected_ns" != "$actual_ns" ]]; then
    echo "ホストゾーンのネームサーバが宣言と一致しません: expected=${expected_ns} actual=${actual_ns}"
    return 1
  fi
  echo "hosted zone ${zone_name} exists (${zone_id})"
}

##
# 委譲元（さくらの ojos.jp ゾーン）から Route53 へ NS 委譲が効いていることを確認する。
#
# これは terraform の宣言対象ではない。さくらのドメインは DNS の API を持たず、NS の
# 登録が手動になるためである（terraform/dns.tf 参照）。宣言できないものを検査だけは
# 置くのは、手動の 1 回が抜けたまま「宣言は正しいのに名前が引けない」状態を、
# 実装のバグと切り分けられるようにするため。
#
# 期待する NS は宣言から取り、親ゾーンの権威サーバへ直接問い合わせて委譲そのものを見る。
# ローカルリゾルバのキャッシュ越しに見ると、委譲前の応答を掴んで誤判定しうる。
#
# 委譲済みサブドメインの NS を親の権威サーバへ問い合わせると、応答はリファラルになり
# NS は ANSWER ではなく AUTHORITY セクションに入る（実測: ANSWER: 0, AUTHORITY: 4）。
# `dig +short` は ANSWER しか出さないため、正常な委譲を「未委譲」と誤判定する。
# +noall +authority +answer で両方を拾い、レコード型で絞る。
#
# 親ゾーン名はゾーン名の先頭ラベルを落として導く。ここへ ojos.jp と書き写すと、
# ゾーン名を変えたときに検査だけが古い親を見続ける（shared-ai-rules.md 12 章）。
#
# 戻り値: 0 = 委譲済み / 1 = 未委譲または取得失敗
##
check_dns_delegation() {
  local zone_name parent_zone parent_ns expected_ns actual_ns
  zone_name="$(tf_output dns_zone_name)" || return 1
  expected_ns="$(terraform -chdir="$TF_DIR" output -json dns_zone_name_servers | jq -r '.[]' | sed 's/\.$//' | tr 'A-Z' 'a-z' | sort)" || return 1

  parent_zone="${zone_name#*.}"
  if [[ -z "$parent_zone" || "$parent_zone" == "$zone_name" ]]; then
    echo "親ゾーン名を導けません: zone=${zone_name}"
    return 1
  fi

  # 親ゾーンの権威サーバは複数ある。1 台に固定すると、その 1 台が一時的に応答しない
  # だけで委譲が正しくても偽陰性になる。応答した最初の 1 台の結果で判定する。
  local -a parent_ns_list=()
  mapfile -t parent_ns_list < <(dig +short NS "$parent_zone" 2>/dev/null)
  if [[ "${#parent_ns_list[@]}" -eq 0 ]]; then
    echo "親ゾーン ${parent_zone} の権威サーバを取得できません。ネットワークを確認すること。"
    return 1
  fi

  # 「どのサーバも応答しなかった」と「応答したが委譲が無い」を区別する。前者は前提の
  # 不成立、後者は本当に未委譲であり、取るべき行動が違う。dig は応答があれば 0 を返し、
  # サーバから返事が無いときだけ 9 を返すので、終了コードで見分ける。
  local answered="" raw
  for parent_ns in "${parent_ns_list[@]}"; do
    if raw="$(dig +noall +authority +answer NS "$zone_name" @"$parent_ns" 2>/dev/null)"; then
      answered="$parent_ns"
      break
    fi
  done
  if [[ -z "$answered" ]]; then
    echo "親ゾーン ${parent_zone} のどの権威サーバからも応答がありません（${#parent_ns_list[@]} 台試行）。"
    echo "委譲の有無は判定できていません。ネットワークを確認すること。"
    return 1
  fi

  actual_ns="$(awk '$4 == "NS" { print $5 }' <<<"$raw" | sed 's/\.$//' | tr 'A-Z' 'a-z' | sort)"
  if [[ -z "$actual_ns" ]]; then
    echo "委譲がまだ効いていません（${answered} に ${zone_name} の NS がありません）。"
    echo "さくらの ${parent_zone} ゾーンへ NS レコードを登録してください。"
    echo "登録する値: terraform -chdir=terraform output dns_zone_name_servers"
    return 1
  fi
  if [[ "$expected_ns" != "$actual_ns" ]]; then
    echo "委譲先の NS が宣言と一致しません:"
    echo "  expected: $(tr '\n' ' ' <<<"$expected_ns")"
    echo "  actual:   $(tr '\n' ' ' <<<"$actual_ns")"
    return 1
  fi
  echo "delegation for ${zone_name} is in place"
}

##
# Pages のカスタムドメイン用 CNAME が、宣言どおりの名前と向き先で実在することを確認する。
#
# 名前も向き先も terraform output から取る。ここへ app.game-forge.ojos.jp と書き写すと、
# 宣言を変えたときに検査だけが古い名前を見続ける（shared-ai-rules.md 12 章）。
#
# ゾーン内のレコードは Route53 の API で直接読む。名前解決（dig）ではなく API を見るのは、
# ここで確かめたいのが「宣言と実状態の一致」であって「世界中から引けること」ではないため。
# キャッシュや委譲の遅れを、宣言の乖離として報告しない。
#
# 戻り値: 0 = 一致 / 1 = 不一致または取得失敗
##
check_pages_dns_records() {
  local zone_id target rc=0
  zone_id="$(tf_output dns_zone_id)" || return 1
  target="$(tf_output pages_hostname)" || return 1
  if [[ -z "$zone_id" || -z "$target" ]]; then
    echo "terraform output から DNS の宣言値を取得できません。apply 済みか確認すること。"
    return 1
  fi

  local output_name host actual
  for output_name in app_host sandbox_host; do
    host="$(tf_output "$output_name")" || return 1
    if [[ -z "$host" ]]; then
      echo "terraform output ${output_name} が空です。"
      rc=1
      continue
    fi
    # Route53 はレコード名を末尾ドット付きで返す。比較の前に両側から落とす。
    actual="$(aws route53 list-resource-record-sets --hosted-zone-id "$zone_id" \
      --query "ResourceRecordSets[?Name=='${host%.}.' && Type=='CNAME'].ResourceRecords[0].Value" \
      --output text 2>/dev/null)" || actual=""
    actual="${actual%.}"
    if [[ "$actual" != "${target%.}" ]]; then
      echo "${host%.} の CNAME が宣言と一致しません: expected=${target%.} actual=${actual:-(なし)}"
      rc=1
      continue
    fi
    echo "${host%.} CNAME -> ${actual}"
  done
  return "$rc"
}

##
# wrangler.toml の本番ホストが、DNS の宣言と一致していることを確認する。
#
# 同じホスト名が 2 か所（terraform/dns.tf と wrangler.toml）にある。**片方だけを
# 変えると、DNS は張れているのに Worker が「unknown host」で 404 を返す**という、
# どちらの側を見ても正しく見える壊れ方をする（src/index.ts は APP_HOST /
# SANDBOX_HOST と一致しないホストを通さない）。文書での呼びかけではなく照合で塞ぐ
# （shared-ai-rules.md 12 章「一覧の複製は機械照合で担保する」）。
#
# 戻り値: 0 = 一致 / 1 = 不一致または取得失敗
##
check_wrangler_production_hosts() {
  local rc=0 output_name key declared actual
  for pair in "app_host:APP_HOST" "sandbox_host:SANDBOX_HOST"; do
    output_name="${pair%%:*}"
    key="${pair##*:}"
    declared="$(tf_output "$output_name")" || return 1
    declared="${declared%.}"
    # [env.production.vars] テーブルの中だけを見る。トップレベル（ローカル向けの値）を
    # 拾うと、本番の宣言を検査したことにならない。
    actual="$(awk -v key="$key" '
      /^\[/ { in_table = ($0 == "[env.production.vars]") ; next }
      in_table && $1 == key { gsub(/^[^"]*"|"[^"]*$/, "", $0); print $0; exit }
    ' wrangler.toml)"
    if [[ "$actual" != "$declared" ]]; then
      echo "wrangler.toml [env.production.vars] ${key} が DNS の宣言と一致しません: terraform=${declared} wrangler=${actual:-(なし)}"
      rc=1
      continue
    fi
    echo "${key} = ${actual}"
  done
  return "$rc"
}

##
# **本番が配っている配備コミットが、既定ブランチの HEAD と一致していることを確認する**（#95）。
#
# **「配備されたか」ではなく「一致しているか」を見る。** #95 で起きたのは、配備が
# 一度も走らないまま本番が 4 コミット古い状態で動き続け、**ローカルの verify も
# 外部層の検査も terraform plan もすべて緑だった**ことである。配備の有無を見る検査は
# 「1 回でも配備されていれば緑」になるため、この状態を拾えない。
#
# **自動化したうえで、なおこの検査が要る。** ワークフローは失敗しうる（Secrets の
# 失効、Cloudflare 側の障害、fork 判定の書き換え）。自動化は「配備し忘れ」を消すが、
# 「配備が失敗したまま気づかない」は残る。塞ぐのはそちらである。
#
# 期待値と実測の取り方:
#
#   期待値（既定ブランチの HEAD）— GitHub の API から取る。**手元の HEAD を使わない。**
#     この検査は「本番と既定ブランチの一致」を見るもので、手元の作業ブランチが何を
#     指しているかは関係ない。対象リポジトリ名と既定ブランチ名は terraform の
#     output から取る（他の検査と同じ流儀）。
#
#     **ブランチ名を main と書き写さない。** 実装は tf_output default_branch を読んで
#     おり、ここへ main と書くと、宣言側で既定ブランチを変えたときにコメントだけが
#     古い名前を語り続ける（共通規範 12 章）。
#
#   実測（本番の配備）— Cloudflare の `canonical_deployment` を読む。
#     **配備一覧の先頭ではない。** 一覧の先頭は「最後に作られた配備」であり、それが
#     失敗していれば本番はもっと古いものを配り続けている。canonical_deployment は
#     **いま本番ドメインが配っている配備**そのもので、見たいのはこちらである。
#
#   プロジェクト名 — terraform output の pages_hostname（`<project>.pages.dev`）から
#     先頭ラベルを取る。**ここへ game-forge と書き写さない**（共通規範 12 章）。
#     宣言側の変数（var.cloudflare_pages_project）を直接出す output は足していない。
#     output を 1 つ増やすと `terraform plan` に差分として現れ、**この検査を通すために
#     apply が要る**状態を作るためである。pages_hostname は同じ変数から組み立てられて
#     いるので、宣言側から取るという性質は変わらない。
#
#   アカウント ID — 環境変数 CLOUDFLARE_ACCOUNT_ID（前提の確認で読み込み済み）。
#     terraform は Cloudflare のプロバイダを持たない（Pages プロジェクトは wrangler で
#     作る。docs/pages-deploy.md）ため、宣言側に置き場所が無い。wrangler 自身が読むのと
#     同じ供給元を使う。
#
# 戻り値: 0 = 一致 / 1 = 乖離・取得失敗
##
check_pages_production_deployment() {
  local pages_hostname project full_name branch expected actual dirty
  pages_hostname="$(tf_output pages_hostname)" || return 1
  full_name="$(tf_output repository_full_name)" || return 1
  branch="$(tf_output default_branch)" || return 1
  project="${pages_hostname%%.*}"
  if [[ -z "$project" || -z "$full_name" || -z "$branch" ]]; then
    echo "terraform output から検査対象を取得できません。apply 済みか確認すること。"
    echo "  pages_hostname=${pages_hostname:-(なし)} repository=${full_name:-(なし)} branch=${branch:-(なし)}"
    return 1
  fi

  expected="$(gh api "repos/${full_name}/commits/${branch}" --jq '.sha')" || return 1
  if [[ -z "$expected" ]]; then
    echo "${full_name} の ${branch} の HEAD を取得できません。"
    return 1
  fi

  local body
  body="$(cf_api "accounts/${CLOUDFLARE_ACCOUNT_ID}/pages/projects/${project}")" || return 1

  # canonical_deployment が無い＝一度も配備されていない。**「一致しない」ではなく
  # 「まだ何も無い」ことを、そのまま書く。**
  if ! jq -e '.result.canonical_deployment != null' <<<"$body" >/dev/null; then
    echo "Pages プロジェクト ${project} に本番の配備がありません（一度も配備されていない）。"
    echo "  初回の配備手順は docs/pages-deploy.md にある。"
    return 1
  fi

  actual="$(jq -r '.result.canonical_deployment.deployment_trigger.metadata.commit_hash // ""' <<<"$body")"
  dirty="$(jq -r '.result.canonical_deployment.deployment_trigger.metadata.commit_dirty // false' <<<"$body")"

  if [[ -z "$actual" ]]; then
    # 手で `wrangler pages deploy` を打つとき --commit-hash を省くと、ここが空になる。
    # **どのコミットが本番に居るのかを、Cloudflare 側から辿れない状態**である。
    echo "本番の配備にコミットハッシュが記録されていません（${project}）。"
    echo "  --commit-hash を渡さずに配備された可能性がある。.github/workflows/verify.yml の deploy ジョブは必ず渡す。"
    return 1
  fi

  if [[ "$actual" != "$expected" ]]; then
    local created
    created="$(jq -r '.result.canonical_deployment.created_on // "?"' <<<"$body")"
    echo "本番の配備コミットが ${branch} の HEAD と一致しません。"
    echo "  ${branch} の HEAD: ${expected}"
    echo "  本番の配備:       ${actual}（${created}）"
    echo "  これは前提の不成立ではなく、実際の乖離である（ここまでの前提の確認は通っている）。"
    echo "  まず deploy ジョブの実行を見ること: gh run list --workflow verify.yml --branch ${branch}"
    echo "  緊急時の手動配備は docs/pages-deploy.md の「6. デプロイ（初回と緊急時のみ）」にある。"
    return 1
  fi

  if [[ "$dirty" == "true" ]]; then
    # ハッシュは合っているが、配備されたのは**そのコミットの内容ではない**。
    # 手元の未コミットの変更を含んだまま配備すると、この印が付く。
    echo "本番の配備がコミットと一致しない内容を含んでいます（commit_dirty=true / ${actual}）。"
    echo "  作業ツリーが汚れた状態で手動配備された可能性がある。${branch} の HEAD から配備し直すこと。"
    return 1
  fi

  echo "production deployment == ${branch} HEAD (${actual})"
}

##
# Workers 用プリンシパルの権限が、宣言どおりでかつ最小限であることを確認する（#82）。
#
# 見るのは 3 つ。
#
#   1. **インラインポリシーの Allow の総和が、宣言した動作集合と完全に一致すること。**
#      名前を決め打ちせず list-user-policies で全部を足すのは、宣言の外で 2 本目を
#      手で足されたときに気づくためである。1 本だけを名指しで見る検査は、増えた分を
#      見逃す。
#   2. **ワイルドカードが無いこと。** #82 の制約「bedrock:* を与えない」。1. の一致
#      比較で実質担保されるが、宣言側を緩めたときに独立に落ちる検査を残す。
#   3. **停止用の Deny ポリシーが誰にも付いていないこと。** 付いていれば、費用ガードが
#      発火した後まだ手で復旧していないということである。**4.3 は復旧を手動と定めて
#      いる**ので自動では戻らず、ここが気づく口になる。
#
# 期待値はすべて terraform output から取る（shared-ai-rules.md 12 章）。
#
# 戻り値: 0 = 一致 / 1 = 不一致・取得失敗・ガード発火中
##
check_bedrock_invoker_permissions() {
  local user halt_arn expected actual attached
  user="$(tf_output bedrock_invoker_user_name)"
  halt_arn="$(tf_output bedrock_halt_policy_arn)"
  if [[ -z "$user" || -z "$halt_arn" ]]; then
    echo "terraform output から Bedrock のプリンシパル識別子を取得できません。apply 済みか確認すること。"
    echo "  bedrock_invoker_user_name=${user:-(なし)} bedrock_halt_policy_arn=${halt_arn:-(なし)}"
    return 1
  fi

  expected="$(terraform -chdir="$TF_DIR" output -json bedrock_invoke_actions | jq -S 'unique')" || return 1

  local -a policy_names=()
  mapfile -t policy_names < <(aws iam list-user-policies --user-name "$user" --query 'PolicyNames[]' --output text | tr '\t' '\n')
  if [[ "${#policy_names[@]}" -eq 0 || -z "${policy_names[0]}" ]]; then
    echo "${user} にインラインポリシーがありません。Bedrock を呼べない状態です。"
    return 1
  fi

  # Action は文字列にも配列にもなりうる。Statement も同様に単体を取りうるため、
  # どちらの綴りでも同じ集合になるよう正規化してから比べる。
  local docs="" doc name
  for name in "${policy_names[@]}"; do
    doc="$(aws iam get-user-policy --user-name "$user" --policy-name "$name" --query 'PolicyDocument' --output json)" || return 1
    docs+="$doc"$'\n'
  done
  actual="$(jq -s '
    [ .[]
      | .Statement
      | if type == "array" then .[] else . end
      | select(.Effect == "Allow")
      | .Action
    ] | flatten | unique
  ' <<<"$docs")" || return 1

  if [[ "$expected" != "$actual" ]]; then
    echo "許可している Bedrock の動作が宣言と一致しません:"
    echo "  expected: $(jq -c . <<<"$expected")"
    echo "  actual:   $(jq -c . <<<"$actual")"
    return 1
  fi

  if jq -e 'map(select(test("\\*"))) | length > 0' <<<"$actual" >/dev/null; then
    echo "ワイルドカードを含む権限が付与されています: $(jq -c . <<<"$actual")"
    return 1
  fi

  attached="$(aws iam list-attached-user-policies --user-name "$user" --query 'AttachedPolicies[].PolicyArn' --output json)" || return 1
  if jq -e --arg arn "$halt_arn" 'index($arn) != null' <<<"$attached" >/dev/null; then
    echo "費用ガードが発火したままです（${halt_arn} が ${user} に付いています）。"
    echo "原因を調べたうえで docs/bedrock-access.md の復旧手順で外すこと。自動では戻りません（仕様 4.3）。"
    return 1
  fi
  if [[ "$(jq 'length' <<<"$attached")" != "0" ]]; then
    echo "宣言にない管理ポリシーが付与されています: $(jq -c . <<<"$attached")"
    return 1
  fi

  echo "${user} grants exactly $(jq -c . <<<"$actual") with no attached policy"
}

##
# 費用ガードの層 2（暴走検知）が、宣言どおりの形で実在することを確認する（#82 / 仕様 4.3）。
#
# **層 2 は平常時に一度も動かない機構である。** 動かないものは、壊れていても壊れて
# いることが分からない。しきい値・期間・メトリクス・通知先・呼び出し先を、宣言と
# 突き合わせられる限り全部見るのはそのためである。
#
# 経路は アラーム → SNS → Lambda の 3 段で、どこか 1 段が切れると黙って止まらなく
# なる。段ごとに検査する。
#
# 戻り値: 0 = 一致 / 1 = 不一致または取得失敗
##
check_bedrock_burst_alarm() {
  local alarm_name topic_arn func_name threshold period namespace alarm
  alarm_name="$(tf_output bedrock_burst_alarm_name)"
  topic_arn="$(tf_output bedrock_guard_topic_arn)"
  func_name="$(tf_output bedrock_guard_function_name)"
  threshold="$(tf_output bedrock_burst_threshold_tokens)"
  period="$(tf_output bedrock_burst_period_seconds)"
  namespace="$(tf_output bedrock_burst_namespace)"
  if [[ -z "$alarm_name" || -z "$topic_arn" || -z "$func_name" || -z "$threshold" || -z "$period" || -z "$namespace" ]]; then
    echo "terraform output から層 2 の識別子を取得できません。apply 済みか確認すること。"
    echo "  alarm=${alarm_name:-(なし)} topic=${topic_arn:-(なし)} function=${func_name:-(なし)}"
    echo "  threshold=${threshold:-(なし)} period=${period:-(なし)} namespace=${namespace:-(なし)}"
    return 1
  fi

  alarm="$(aws cloudwatch describe-alarms --alarm-names "$alarm_name" --output json)" || return 1
  if [[ "$(jq '.MetricAlarms | length' <<<"$alarm")" != "1" ]]; then
    echo "アラーム ${alarm_name} が存在しません。層 2 が丸ごと効いていません。"
    return 1
  fi

  local rc=0 actual

  # しきい値は数値で返る。文字列比較だと 300000 と 300000.0 が食い違うため、
  # 同じ書式へ揃えてから比べる。
  actual="$(jq -r '.MetricAlarms[0].Threshold' <<<"$alarm")"
  if [[ "$(printf '%.0f' "$actual")" != "$(printf '%.0f' "$threshold")" ]]; then
    echo "しきい値が宣言と一致しません: expected=${threshold} actual=${actual}"
    rc=1
  fi

  # 「1 データポイントで発火」（仕様 4.3）。複数期間を待つ設計に変わると、その分だけ
  # 上振れが増える。
  actual="$(jq -r '[.MetricAlarms[0].EvaluationPeriods, .MetricAlarms[0].DatapointsToAlarm] | @tsv' <<<"$alarm")"
  if [[ "$actual" != $'1\t1' ]]; then
    echo "評価期間が「300 秒 1 データポイントで発火」になっていません: ${actual}"
    rc=1
  fi

  if [[ "$(jq -r '.MetricAlarms[0].ActionsEnabled' <<<"$alarm")" != "true" ]]; then
    echo "アラームのアクションが無効化されています。発火しても何も起きません。"
    rc=1
  fi

  if ! jq -e --arg arn "$topic_arn" '.MetricAlarms[0].AlarmActions | index($arn) != null' <<<"$alarm" >/dev/null; then
    echo "アラームの通知先が宣言の SNS トピックではありません: expected=${topic_arn}"
    rc=1
  fi

  # 合算しているメトリクスの集合。**モデル別の dimension を持たないこと**まで見る。
  # 分けて張ると、複数モデルが同時に暴走したとき 1 本ずつはしきい値へ届かず、
  # 合計では大きく超えている、という取り逃がしが起きる（仕様 4.3 の上振れ見積もり）。
  local expected_metrics actual_metrics
  expected_metrics="$(terraform -chdir="$TF_DIR" output -json bedrock_burst_metric_names | jq -S 'sort')" || return 1
  actual_metrics="$(jq -S --arg ns "$namespace" --argjson p "$period" '
    [ .MetricAlarms[0].Metrics[]
      | select(has("MetricStat"))
      | select(.MetricStat.Metric.Namespace == $ns)
      | select(.MetricStat.Stat == "Sum")
      | select(.MetricStat.Period == $p)
      | select((.MetricStat.Metric.Dimensions | length) == 0)
      | .MetricStat.Metric.MetricName
    ] | sort
  ' <<<"$alarm")" || return 1
  if [[ "$expected_metrics" != "$actual_metrics" ]]; then
    echo "合算しているメトリクスが宣言と一致しません（名前空間 ${namespace} / Sum / ${period} 秒 / dimension なし で絞った結果）:"
    echo "  expected: $(jq -c . <<<"$expected_metrics")"
    echo "  actual:   $(jq -c . <<<"$actual_metrics")"
    rc=1
  fi

  # 2 段目: SNS から Lambda へ。購読が PendingConfirmation のままだと、アラームは
  # 発火するのに関数が呼ばれない。**その状態でもアラーム側は正常に見える。**
  local subs
  subs="$(aws sns list-subscriptions-by-topic --topic-arn "$topic_arn" --output json)" || return 1
  if ! jq -e --arg fn ":function:${func_name}" '
    [ .Subscriptions[]
      | select(.Protocol == "lambda")
      | select(.Endpoint | endswith($fn))
      | select(.SubscriptionArn | startswith("arn:"))
    ] | length == 1
  ' <<<"$subs" >/dev/null; then
    echo "SNS トピック ${topic_arn} から ${func_name} への購読が確立していません。"
    echo "アラームは発火しても関数が呼ばれない状態です。"
    rc=1
  fi

  # 3 段目: 関数が「誰に何を付けるか」を、宣言と同じ対象に向けているか。ここが
  # ずれると関数は成功したように動いて、実際には何も止めない。
  local env_vars
  env_vars="$(aws lambda get-function-configuration --function-name "$func_name" --query 'Environment.Variables' --output json)" || return 1
  local expected_user expected_policy
  expected_user="$(tf_output bedrock_invoker_user_name)"
  expected_policy="$(tf_output bedrock_halt_policy_arn)"
  if [[ "$(jq -r '.TARGET_USER_NAME // ""' <<<"$env_vars")" != "$expected_user" ]] ||
    [[ "$(jq -r '.HALT_POLICY_ARN // ""' <<<"$env_vars")" != "$expected_policy" ]]; then
    echo "${func_name} の対象が宣言と一致しません。発火しても別のものを見に行きます。"
    rc=1
  fi

  if [[ "$rc" -eq 0 ]]; then
    echo "layer 2: ${alarm_name} (${threshold} tokens / ${period}s) -> sns -> ${func_name}"
  fi
  return "$rc"
}

##
# 費用ガードの層 3（AWS Budgets）が、宣言どおりの予算と動作で実在することを確認する
# （#82 / 仕様 4.3）。
#
# **本番と開発の 2 アカウントを見る。** 開発側は別アカウントなので、プロファイルも
# アカウント ID も terraform output から取る（どちらもここへ書き写さない）。
# 開発アカウントの SSO が切れていれば失敗するが、それは terraform plan も同じ前提で
# あり（aws.dev プロバイダを通る）、この検査だけが新たな前提を足しているわけではない。
#
# **予算の実在だけでは足りない。** 100% の Budget Action が無い予算は「通知は来るが
# 止まらない」状態で、層 3 の役割を果たさない。動作の種類・しきい値・対象ポリシー・
# 対象ユーザーまで突き合わせる。
#
# 戻り値: 0 = 一致 / 1 = 不一致または取得失敗
##
check_bedrock_budgets() {
  local rc=0
  local prod_account dev_account dev_profile
  local prod_budget dev_budget prod_limit dev_limit halt_arn user halt_percent
  prod_account="$(tf_output aws_account_id_prod)"
  dev_account="$(tf_output aws_account_id_dev)"
  dev_profile="$(tf_output aws_profile_dev)"
  prod_budget="$(tf_output bedrock_budget_prod_name)"
  dev_budget="$(tf_output bedrock_budget_dev_name)"
  prod_limit="$(tf_output bedrock_budget_prod_limit_usd)"
  dev_limit="$(tf_output bedrock_budget_dev_limit_usd)"
  halt_arn="$(tf_output bedrock_halt_policy_arn)"
  user="$(tf_output bedrock_invoker_user_name)"
  halt_percent="$(tf_output bedrock_budget_halt_percent)"
  if [[ -z "$prod_account" || -z "$dev_account" || -z "$prod_budget" || -z "$dev_budget" ||
    -z "$prod_limit" || -z "$dev_limit" || -z "$halt_arn" || -z "$user" || -z "$halt_percent" || -z "$dev_profile" ]]; then
    echo "terraform output から層 3 の識別子を取得できません。apply 済みか確認すること。"
    echo "  prod=${prod_budget:-(なし)}/${prod_limit:-(なし)} dev=${dev_budget:-(なし)}/${dev_limit:-(なし)}"
    echo "  halt_policy=${halt_arn:-(なし)} halt_percent=${halt_percent:-(なし)} user=${user:-(なし)}"
    return 1
  fi

  # 予算額は "85" と "85.0" のどちらでも返りうる。書式を揃えてから比べる。
  local limit
  limit="$(aws budgets describe-budget --account-id "$prod_account" --budget-name "$prod_budget" \
    --query 'Budget.BudgetLimit.Amount' --output text 2>/dev/null)" || limit=""
  if [[ -z "$limit" ]] || [[ "$(printf '%.2f' "$limit")" != "$(printf '%.2f' "$prod_limit")" ]]; then
    echo "本番予算 ${prod_budget} が宣言と一致しません: expected=${prod_limit} USD actual=${limit:-(なし)}"
    rc=1
  fi

  local actions
  actions="$(aws budgets describe-budget-actions-for-budget --account-id "$prod_account" \
    --budget-name "$prod_budget" --output json 2>/dev/null)" || actions=""
  if [[ -z "$actions" ]]; then
    echo "本番予算 ${prod_budget} の Budget Action を取得できません。"
    rc=1
  elif ! jq -e --arg arn "$halt_arn" --arg user "$user" --argjson pct "$halt_percent" '
    [ .Actions[]
      | select(.ActionType == "APPLY_IAM_POLICY")
      | select(.ActionThreshold.ActionThresholdType == "PERCENTAGE")
      | select(.ActionThreshold.ActionThresholdValue == $pct)
      | select(.Definition.IamActionDefinition.PolicyArn == $arn)
      | select(.Definition.IamActionDefinition.Users | index($user) != null)
      | select(.ApprovalModel == "AUTOMATIC")
    ] | length == 1
  ' <<<"$actions" >/dev/null; then
    echo "本番予算 ${prod_budget} に、${halt_percent}% で ${user} へ ${halt_arn} を付ける自動動作がありません。"
    echo "通知は来ても止まらない状態です（層 3 の役割を果たしていません）。"
    rc=1
  fi

  # 開発アカウント。**動作は宣言していない**（Deny を付ける相手になる長命プリンシパルが
  # dev に無い。仕様 9.2）。ここでも動作の有無は問わず、予算額だけを見る。
  limit="$(aws --profile "$dev_profile" budgets describe-budget --account-id "$dev_account" \
    --budget-name "$dev_budget" --query 'Budget.BudgetLimit.Amount' --output text 2>/dev/null)" || limit=""
  if [[ -z "$limit" ]] || [[ "$(printf '%.2f' "$limit")" != "$(printf '%.2f' "$dev_limit")" ]]; then
    echo "開発予算 ${dev_budget} が宣言と一致しません: expected=${dev_limit} USD actual=${limit:-(なし)}"
    echo "開発アカウントの SSO が切れている場合もここで失敗する: aws sso login --profile ${dev_profile}"
    rc=1
  fi

  if [[ "$rc" -eq 0 ]]; then
    echo "layer 3: ${prod_budget} ${prod_limit} USD (halt at ${halt_percent}%) / ${dev_budget} ${dev_limit} USD"
  fi
  return "$rc"
}

##
# ビルド関数（確定24 / 仕様 3.8 / 7.1 / 9.3。#103）の検査。
#
# 期待値はすべて terraform output から取る。3538 や 10 をここへ書き写すと、宣言を
# 変えたときに検査だけが古い期待値を見続ける（共通規範 12 章）。
##

# output がリスト・数値のときは -raw が使えないため、JSON で取る。
tf_output_json() {
  terraform -chdir="$TF_DIR" output -json "$1" 2>/dev/null
}

##
# 関数の設定が宣言どおりか。
#
# **メモリは 2 vCPU を買うための値であり、下げると 3.8 の 10 秒に収まらなくなる**
# （実測 11.3 秒）。予約同時実行数は 3.8 の「Worker Pool による並列数制限」の
# 対応物で、外れるとアカウント既定（1,000）まで開く。
#
# 戻り値: 0 = 一致 / 1 = 不一致または取得失敗
##
check_build_function_config() {
  local rc=0 name config
  name="$(tf_output build_function_name)" || return 1
  if [[ -z "$name" ]]; then
    echo "terraform output からビルド関数名を取得できません。apply 済みか確認すること。"
    return 1
  fi

  config="$(aws lambda get-function-configuration --function-name "$name" --output json 2>/dev/null)" || config=""
  if [[ -z "$config" ]]; then
    echo "ビルド関数 ${name} を取得できません（未 apply / SCP による拒否を疑うこと）。"
    return 1
  fi

  local expected actual
  while read -r label query output_name; do
    expected="$(tf_output "$output_name")" || expected=""
    actual="$(jq -r "$query" <<<"$config")"
    if [[ -z "$expected" ]]; then
      echo "terraform output ${output_name} を取得できません。"
      rc=1
    elif [[ "$actual" != "$expected" ]]; then
      echo "${label} が宣言と一致しません: expected=${expected} actual=${actual}"
      rc=1
    fi
  done <<'EOF'
memory .MemorySize build_function_memory_mb
timeout .Timeout build_function_timeout_seconds
ephemeral_storage .EphemeralStorage.Size build_function_ephemeral_storage_mb
package_type .PackageType build_function_package_type
architecture .Architectures[0] build_function_architecture
brotli_quality .Environment.Variables.BROTLI_QUALITY build_brotli_quality
r2_parameter .Environment.Variables.R2_CREDENTIALS_PARAMETER r2_credentials_parameter_name
EOF

  # 予約同時実行数は get-function-configuration には現れない。別 API で引く。
  #
  # **「予約なし」の綴りが両側で違う。** terraform output は AWS プロバイダの表現で
  # `-1`、`get-function-concurrency` は `None` を返す。素で比べると**宣言どおりでも
  # 必ず落ちる**ので、どちらも `none` へ寄せてから比べる（#103）。
  local expected_concurrency actual_concurrency
  expected_concurrency="$(tf_output build_function_reserved_concurrency)" || expected_concurrency=""
  actual_concurrency="$(aws lambda get-function-concurrency --function-name "$name" \
    --query 'ReservedConcurrentExecutions' --output text 2>/dev/null)" || actual_concurrency=""
  normalize_concurrency() {
    case "$1" in
      -1 | None | null | "") echo none ;;
      *) echo "$1" ;;
    esac
  }
  if [[ -z "$expected_concurrency" ]]; then
    echo "terraform output build_function_reserved_concurrency を取得できません。"
    rc=1
  elif [[ "$(normalize_concurrency "$actual_concurrency")" != "$(normalize_concurrency "$expected_concurrency")" ]]; then
    echo "予約同時実行数が宣言と一致しません: expected=${expected_concurrency} actual=${actual_concurrency:-(なし)}"
    echo "外れているとアカウント既定（1,000）まで開き、3.8 の並列数制限が無くなります。"
    rc=1
  elif [[ "$(normalize_concurrency "$expected_concurrency")" == none ]]; then
    # **一致していても黙らない。** これは劣化した状態であり、引き上げが通ったら
    # 戻す約束がある（docs/build-function.md の「引き上げの申請」）。緑の中に
    # 埋めると、戻す機会が来たことに誰も気づかない。
    warn "予約同時実行数がありません。アカウントの同時実行総枠が 10 で、予約を付けると"
    warn "残りが最低値 10 を割るため設定できません（仕様 1.2.23 / #103）。上限は総枠 10"
    warn "という形で残りますが、下限は失われており、ビルドが 10 本走ると費用ガードの"
    warn "game-forge-bedrock-guard が枯渇し得ます。引き上げの申請は docs/build-function.md。"
  fi

  # **VPC に入っていないこと**（確定24 / v1.11）。入れると DNS の穴・実行ロールへの
  # EC2 権限・14 日アイドルでの初回失敗という 3 つの悪化を買い直すことになる。
  local vpc
  vpc="$(jq -r '.VpcConfig.VpcId // ""' <<<"$config")"
  if [[ -n "$vpc" ]]; then
    echo "ビルド関数が VPC (${vpc}) に入っています。確定24 は VPC を使わないと定めています。"
    rc=1
  fi

  if [[ "$rc" -eq 0 ]]; then
    echo "build function ${name}: $(jq -r '"\(.MemorySize)MB / \(.Timeout)s / \(.EphemeralStorage.Size)MB tmp"' <<<"$config"), concurrency=${actual_concurrency}, no vpc"
  fi
  return "$rc"
}

##
# 関数に載っているイメージが、ECR の `latest` と同じダイジェストか（9.3）。
#
# **タグではなくダイジェストで見る。** タグは打ち直せるので、「`latest` が付いている」
# ことは「同じ中身が載っている」ことを意味しない。9.3 が Pages 側で「配備されたか」
# ではなく「一致しているか」を見ると定めているのと同じ形である。
#
# 戻り値: 0 = 一致 / 1 = 不一致または取得失敗
##
check_build_function_image() {
  local name repository resolved deployed expected
  name="$(tf_output build_function_name)" || return 1
  repository="$(tf_output build_image_repository_name)" || return 1
  if [[ -z "$name" || -z "$repository" ]]; then
    echo "terraform output からビルド関数 / ECR リポジトリの識別子を取得できません。"
    return 1
  fi

  resolved="$(aws lambda get-function --function-name "$name" \
    --query 'Code.ResolvedImageUri' --output text 2>/dev/null)" || resolved=""
  if [[ -z "$resolved" || "$resolved" == "None" ]]; then
    echo "ビルド関数 ${name} に載っているイメージを取得できません。"
    return 1
  fi
  deployed="${resolved##*@}"

  expected="$(aws ecr describe-images --repository-name "$repository" \
    --image-ids imageTag=latest --query 'imageDetails[0].imageDigest' --output text 2>/dev/null)" || expected=""
  if [[ -z "$expected" || "$expected" == "None" ]]; then
    echo "ECR ${repository} の latest タグを取得できません（イメージがまだ push されていない可能性）。"
    return 1
  fi

  if [[ "$deployed" != "$expected" ]]; then
    echo "関数に載っているイメージが ECR の latest と一致しません。"
    echo "  function=${deployed}"
    echo "  ecr:latest=${expected}"
    echo "deploy-compiler ワークフローが失敗したまま気づいていない可能性があります（9.3）。"
    return 1
  fi
  echo "build image ${repository}@${deployed:0:19}… is deployed"
}

##
# 実行ロールの権限が最小限であること（#103 の受け入れ条件）。
#
# **この関数は攻撃者が制御しうるコードをコンパイルする**（7.1）。ロールに付いた権限は
# 実質そのコードの権限だと考えて絞る。managed policy が 1 枚でも付いていれば失敗に
# する（`AWSLambdaBasicExecutionRole` は `logs:CreateLogGroup` を含み、書ける先を
# `*` に広げる）。
#
# 戻り値: 0 = 宣言どおり / 1 = 逸脱または取得失敗
##
check_build_function_role() {
  local rc=0 role expected attached policies actual
  role="$(tf_output build_function_role_name)" || return 1
  expected="$(tf_output_json build_function_role_actions)" || expected=""
  if [[ -z "$role" || -z "$expected" ]]; then
    echo "terraform output からビルド関数の実行ロールを取得できません。"
    return 1
  fi

  attached="$(aws iam list-attached-role-policies --role-name "$role" \
    --query 'AttachedPolicies[].PolicyArn' --output json 2>/dev/null)" || attached=""
  if [[ -z "$attached" ]]; then
    echo "実行ロール ${role} を取得できません。"
    return 1
  fi
  if [[ "$(jq 'length' <<<"$attached")" != "0" ]]; then
    echo "実行ロールに managed policy が付いています: $(jq -c . <<<"$attached")"
    echo "宣言はインラインポリシー 1 本だけを与えています（terraform/build-function.tf）。"
    rc=1
  fi

  policies="$(aws iam list-role-policies --role-name "$role" --query 'PolicyNames' --output json 2>/dev/null)" || policies=""
  if [[ -z "$policies" ]]; then
    echo "実行ロール ${role} のインラインポリシーを取得できません。"
    return 1
  fi

  local doc all='[]' policy_name
  for policy_name in $(jq -r '.[]' <<<"$policies"); do
    doc="$(aws iam get-role-policy --role-name "$role" --policy-name "$policy_name" \
      --query 'PolicyDocument' --output json 2>/dev/null)" || doc=""
    if [[ -z "$doc" ]]; then
      echo "インラインポリシー ${policy_name} を取得できません。"
      return 1
    fi
    all="$(jq -s '.[0] + ([.[1].Statement[] | .Action] | flatten)' <<<"$all"$'\n'"$doc")"
  done

  actual="$(jq -c 'unique' <<<"$all")"
  if [[ "$actual" != "$(jq -c 'unique' <<<"$expected")" ]]; then
    echo "実行ロールの動作が宣言と一致しません。"
    echo "  expected=$(jq -c 'unique' <<<"$expected")"
    echo "  actual  =${actual}"
    return 1
  fi

  if [[ "$rc" -eq 0 ]]; then
    echo "build function role ${role}: ${actual}"
  fi
  return "$rc"
}

##
# R2 の資格情報が「宣言の外に、暗号化されて」存在すること（#103 の受け入れ条件）。
#
# 検査するのは 2 つ。
#
#   1. 宣言した名前の SecureString が実在する。**値は読まない。**
#      読めば検査の出力とシェルの履歴へ秘密が写る。ここで確かめたいのは
#      「置き場所が用意されているか」であって値そのものではない。
#   2. **tfstate に `aws_ssm_parameter` が 1 件も無い。** 宣言すると Terraform が
#      refresh のたびに復号済みの値を state へ書き込む（`aws_iam_access_key` を
#      宣言しない理由と同じ経路。terraform/bedrock.tf）。**「宣言していないこと」
#      そのものが要件なので、機械で押さえる。**
#
# 戻り値: 0 = 宣言どおり / 1 = 逸脱または取得失敗
##
check_r2_credentials_placement() {
  local rc=0 name type
  name="$(tf_output r2_credentials_parameter_name)" || return 1
  if [[ -z "$name" ]]; then
    echo "terraform output から R2 資格情報のパラメータ名を取得できません。"
    return 1
  fi

  type="$(aws ssm describe-parameters \
    --parameter-filters "Key=Name,Values=${name}" \
    --query 'Parameters[0].Type' --output text 2>/dev/null)" || type=""
  if [[ "$type" != "SecureString" ]]; then
    echo "${name} が SecureString として存在しません（実測: ${type:-(なし)}）。"
    echo "投入手順は docs/build-function.md にある（宣言は値を持たない）。"
    rc=1
  fi

  # tfstate は追跡外だが、適用者の手元には必ずある。無ければ検査は成立しない。
  local state="${TF_DIR}/terraform.tfstate"
  if [[ ! -f "$state" ]]; then
    echo "${state} が見つかりません。apply 済みの環境で実行すること。"
    return 1
  fi
  local declared
  declared="$(jq '[.resources[]? | select(.type == "aws_ssm_parameter")] | length' <"$state" 2>/dev/null)" || declared=""
  if [[ -z "$declared" ]]; then
    echo "${state} を読めません。"
    rc=1
  elif [[ "$declared" != "0" ]]; then
    echo "tfstate に aws_ssm_parameter が ${declared} 件あります。"
    echo "**復号済みの値が state へ平文で落ちます。** 宣言から外すこと（#103 の受け入れ条件）。"
    rc=1
  fi

  if [[ "$rc" -eq 0 ]]; then
    echo "r2 credentials: ${name} is a SecureString, and no aws_ssm_parameter is declared"
  fi
  return "$rc"
}

##
# Workers がビルド関数を呼ぶプリンシパルが、宣言どおりでかつ最小権限であること
# （#115 / 仕様 3.3-5 / 4.1 / 9.2）。
#
# **この鍵は Cloudflare Pages のシークレットに長命で置かれる**（Workers は AWS の外で
# 動くのでロールを引き受けられない。4.1）。漏れたときに何ができるかは、そのままこの
# ポリシーの広さである。見るのは 5 つ。
#
#   1. **インラインポリシーの Allow の「動作」の総和が、宣言した集合と完全に一致すること。**
#      ポリシー名を決め打ちせず list-user-policies で全部を足すのは、宣言の外で 2 本目を
#      手で足されたときに気づくためである（bedrock 側の検査と同じ理由）。
#   2. **Allow の「対象」の総和が、宣言した ARN と完全に一致すること。** 動作だけを見る
#      検査は、**`Resource` を `*` へ緩めた変更を素通りさせる。** 仕様 9.2 が禁じている
#      のはそちらで、`lambda:InvokeFunction` on `*` は「このアカウントの全部の関数を
#      呼べる鍵」である。
#   3. **動作にも対象にもワイルドカードが無いこと。** 1. と 2. の一致比較で実質担保
#      されるが、宣言側を緩めたときに独立に落ちる検査を残す。
#   4. **管理ポリシーが 1 枚も付いていないこと。** 1. と 2. はインラインしか読まない
#      ので、`AWSLambda_FullAccess` を手で attach された状態はここでしか拾えない。
#   5. **tfstate に `aws_iam_access_key` が 1 件も無いこと。** 宣言すると Terraform が
#      生成した秘密鍵を state へ平文で書く（R2 の資格情報を `aws_ssm_parameter` で
#      宣言しない理由と同じ経路）。**「宣言していないこと」そのものが要件なので、
#      機械で押さえる**（terraform/build-invoker.tf）。
#
# 期待値はすべて terraform output から取る（shared-ai-rules.md 12 章）。ユーザー名や
# 動作名をここへ書き写すと、宣言を緩めたときに検査だけが古い期待値で緑になる。
#
# **鍵そのものの有無は落とさず warn にする。** 鍵の発行は apply の後の手作業で
# （docs/build-invocation.md 3 章）、未発行は「宣言と外部状態の乖離」ではなく
# 手順の途中である。ただし黙って通すと `BuildNotConfigured` の原因が見えないので残す。
#
# 戻り値: 0 = 宣言どおり / 1 = 逸脱・取得失敗
##
check_build_invoker_permissions() {
  local rc=0 user expected_actions expected_resources
  user="$(tf_output build_invoker_user_name)" || return 1
  expected_actions="$(tf_output_json build_invoke_actions)" || expected_actions=""
  expected_resources="$(tf_output_json build_invoke_resources)" || expected_resources=""
  if [[ -z "$user" || -z "$expected_actions" || -z "$expected_resources" ]]; then
    echo "terraform output からビルド関数の呼び出しプリンシパルを取得できません。apply 済みか確認すること。"
    echo "  build_invoker_user_name=${user:-(なし)}"
    echo "  build_invoke_actions=${expected_actions:-(なし)} build_invoke_resources=${expected_resources:-(なし)}"
    return 1
  fi

  local -a policy_names=()
  mapfile -t policy_names < <(aws iam list-user-policies --user-name "$user" \
    --query 'PolicyNames[]' --output text 2>/dev/null | tr '\t' '\n')
  if [[ "${#policy_names[@]}" -eq 0 || -z "${policy_names[0]}" ]]; then
    echo "${user} にインラインポリシーがありません。ビルド関数を呼べない状態です。"
    return 1
  fi

  local docs="" doc name
  for name in "${policy_names[@]}"; do
    doc="$(aws iam get-user-policy --user-name "$user" --policy-name "$name" \
      --query 'PolicyDocument' --output json 2>/dev/null)" || doc=""
    if [[ -z "$doc" ]]; then
      echo "インラインポリシー ${name} を取得できません。"
      return 1
    fi
    docs+="$doc"$'\n'
  done

  # Action も Resource も文字列と配列の両方を取りうる。Statement も単体を取りうるため、
  # どちらの綴りでも同じ集合になるよう正規化してから比べる。
  local actual_actions actual_resources
  actual_actions="$(jq -cs '
    [ .[] | .Statement | if type == "array" then .[] else . end
      | select(.Effect == "Allow") | .Action ] | flatten | unique
  ' <<<"$docs")" || return 1
  actual_resources="$(jq -cs '
    [ .[] | .Statement | if type == "array" then .[] else . end
      | select(.Effect == "Allow") | .Resource ] | flatten | unique
  ' <<<"$docs")" || return 1

  local want_actions want_resources
  want_actions="$(jq -cS 'unique' <<<"$expected_actions")" || return 1
  want_resources="$(jq -cS 'unique' <<<"$expected_resources")" || return 1

  if [[ "$want_actions" != "$actual_actions" ]]; then
    echo "許可している動作が宣言と一致しません:"
    echo "  expected: ${want_actions}"
    echo "  actual:   ${actual_actions}"
    rc=1
  fi

  if [[ "$want_resources" != "$actual_resources" ]]; then
    echo "許可している対象が宣言と一致しません:"
    echo "  expected: ${want_resources}"
    echo "  actual:   ${actual_resources}"
    echo "**Resource を広げると、この鍵はアカウント内の他の関数も呼べます**（仕様 9.2）。"
    rc=1
  fi

  if jq -e 'map(select(test("\\*"))) | length > 0' <<<"$actual_actions" >/dev/null; then
    echo "ワイルドカードを含む動作が付与されています: ${actual_actions}"
    rc=1
  fi
  if jq -e 'map(select(test("\\*"))) | length > 0' <<<"$actual_resources" >/dev/null; then
    echo "ワイルドカードを含む対象が付与されています: ${actual_resources}"
    rc=1
  fi

  local attached
  attached="$(aws iam list-attached-user-policies --user-name "$user" \
    --query 'AttachedPolicies[].PolicyArn' --output json 2>/dev/null)" || attached=""
  if [[ -z "$attached" ]]; then
    echo "${user} に付いている管理ポリシーを取得できません。"
    return 1
  fi
  if [[ "$(jq 'length' <<<"$attached")" != "0" ]]; then
    echo "宣言にない管理ポリシーが付与されています: $(jq -c . <<<"$attached")"
    echo "宣言はインラインポリシー 1 本だけを与えています（terraform/build-invoker.tf）。"
    rc=1
  fi

  # tfstate は追跡外だが、適用者の手元には必ずある。無ければ検査は成立しない。
  local state="${TF_DIR}/terraform.tfstate"
  if [[ ! -f "$state" ]]; then
    echo "${state} が見つかりません。apply 済みの環境で実行すること。"
    return 1
  fi
  local declared_keys
  declared_keys="$(jq '[.resources[]? | select(.type == "aws_iam_access_key")] | length' <"$state" 2>/dev/null)" || declared_keys=""
  if [[ -z "$declared_keys" ]]; then
    echo "${state} を読めません。"
    rc=1
  elif [[ "$declared_keys" != "0" ]]; then
    echo "tfstate に aws_iam_access_key が ${declared_keys} 件あります。"
    echo "**生成された秘密鍵が state へ平文で落ちます。** 宣言から外すこと（#115 の制約）。"
    echo "鍵の発行は docs/build-invocation.md 3 章の手作業が持ちます。"
    rc=1
  fi

  # 鍵の有無は落とさない（未発行は乖離ではなく手順の途中）。ただし黙らせない。
  local keys
  keys="$(aws iam list-access-keys --user-name "$user" \
    --query 'AccessKeyMetadata[?Status==`Active`].AccessKeyId' --output json 2>/dev/null)" || keys=""
  if [[ -n "$keys" ]] && [[ "$(jq 'length' <<<"$keys")" == "0" ]]; then
    warn "${user} に有効なアクセスキーがありません。宣言は正しいが、Workers からは呼べません"
    warn "  （BuildNotConfigured / kind='config'）。発行と投入は docs/build-invocation.md 3 章。"
  fi

  if [[ "$rc" -eq 0 ]]; then
    echo "${user} grants exactly ${actual_actions} on ${actual_resources} with no attached policy"
  fi
  return "$rc"
}

##
# GitHub OIDC の `sub` の綴りが、宣言と GitHub 側の事実で一致すること（#103）。
#
# **#103 では、ここが食い違ったことに「配備の失敗」で初めて気づいた。**
# 信頼ポリシーは `repo:ojos/game-forge:...` を期待していたが、実際に届く `sub` は
# `repo:ojos@76836/game-forge@1330337925:...` だった。**誰かが設定を変えたのではなく、
# GitHub の既定の綴りが ID 入りへ移っていた**（`use_default` は true のまま）。
#
# エラーは `Not authorized to perform sts:AssumeRoleWithWebIdentity` としか言わない。
# **権限の問題に見えて、実際は綴りの問題である。** 原因へ辿るには CloudTrail の
# `principalId` を読むしかなかった。
#
# **期待値は GitHub の API が返す `sub_claim_prefix` そのものである。** ここへ綴りを
# 書き写すと、GitHub 側が再び変えたときに検査だけが古い綴りで緑になる。
##
check_oidc_subject() {
  local declared prefix expected_prefix
  declared="$(tf_output github_deploy_subject)" || return 1
  if [[ -z "$declared" ]]; then
    echo "terraform output github_deploy_subject を取得できません。"
    return 1
  fi

  # 宣言の `:ref:` より前が、GitHub の言う prefix にあたる。
  prefix="${declared%%:ref:*}"
  if [[ "$prefix" == "$declared" ]]; then
    echo "宣言された sub に :ref: が含まれません: ${declared}"
    return 1
  fi

  local repo
  repo="$(tf_output repository_full_name)" || return 1
  expected_prefix="$(gh api "repos/${repo}/actions/oidc/customization/sub" \
    --jq '.sub_claim_prefix' 2>/dev/null)" || expected_prefix=""
  if [[ -z "$expected_prefix" ]]; then
    echo "GitHub から ${repo} の sub_claim_prefix を取得できません。"
    return 1
  fi

  if [[ "$prefix" != "$expected_prefix" ]]; then
    echo "OIDC の sub の綴りが GitHub 側と一致しません。"
    echo "  宣言 : ${prefix}"
    echo "  実際 : ${expected_prefix}"
    echo "このままでは deploy-compiler.yml の OIDC が"
    echo "Not authorized to perform sts:AssumeRoleWithWebIdentity で落ちます。"
    echo "terraform/github-oidc.tf の github_deploy_subject を実際の綴りへ合わせること。"
    return 1
  fi

  echo "oidc subject: ${declared}"
  return 0
}

run "repository exists and visibility matches" check_repository
run "default branch matches" check_default_branch
run "branch protection matches" check_branch_protection
run "actions variable matches" check_actions_variable
run "github oidc subject spelling matches" check_oidc_subject
run "dns hosted zone matches" check_dns_zone
run "dns delegation from sakura is in place" check_dns_delegation
run "pages custom domain records match" check_pages_dns_records
run "wrangler production hosts match dns" check_wrangler_production_hosts
run "production deployment matches default branch HEAD" check_pages_production_deployment
run "bedrock invoker permissions are minimal" check_bedrock_invoker_permissions
run "cost guard layer 2 (burst alarm) matches" check_bedrock_burst_alarm
run "cost guard layer 3 (budgets) matches" check_bedrock_budgets
run "build function configuration matches" check_build_function_config
run "build function image matches the ecr latest digest" check_build_function_image
run "build function execution role is minimal" check_build_function_role
run "build invoker permissions are minimal" check_build_invoker_permissions
run "r2 credentials are outside the declaration" check_r2_credentials_placement

# ── 配信の共有資材と R2 のライフサイクル（#139 / #31）────────────────────────
#
# **この 2 本は、宣言（および手順）が実状態より先に居る間は赤になる。** それは故障では
# なく、この層が見るべきものそのものである（冒頭「宣言と実際の外部状態が一致している
# かの検査」/「通す契機: 外部状態の宣言を変更したとき」）。**赤の意味が読めないと
# 「壊れている」と読まれる**ので、何をすれば緑になるかを書いておく。
#
#   wasm_exec objects …  本番 R2 へ `runtime/<版>/wasm_exec.js` を置くと緑になる。
#                        `bash scripts/put-wasm-exec.sh --remote`
#                        （docs/pages-deploy.md「wasm_exec.js を本番 R2 へ置く」）
#                        **置くまで、その版の作品のプレイ経路は 500 である。**
#   r2 lifecycle …       `terraform -chdir=terraform apply` を通すと緑になる。
#                        初回は terraform.tfvars へ cloudflare_account_id が要る
#                        （docs/pages-deploy.md「R2 のライフサイクルを適用する」）。
#
# **前提の不成立（未認証・オフライン）と乖離は、どちらのスクリプトも自分で読み分けて
# 報告する。** 資格情報が無いときは「乖離」ではなく前提として落ちる。
#
# 判定はスクリプト側が持つ。ここへ検査の中身を書き写さない（shared-ai-rules 12 章）。
run "wasm_exec objects exist for every delivered go_version" bash scripts/check-wasm-exec-objects.sh --remote
run "r2 lifecycle has no age-based delete rules" bash scripts/check-r2-lifecycle.sh

if [[ "$ran_any" -eq 0 ]]; then
  echo "[acceptance-remote] 外部層の受け入れ条件が未定義です。検査を 1 つも実行していません。" >&2
  echo "[acceptance-remote] 宣言と実際の外部状態を照合する検査を scripts/acceptance-remote.sh へ定義してください。" >&2
  exit 1
fi

if [[ -s "$WARNINGS" ]]; then
  echo "[acceptance-remote] 注意（検査は通っていますが、劣化した状態です）:" >&2
  sed 's/^/    /' "$WARNINGS" >&2
fi

if [[ "$failed" -gt 0 ]]; then
  echo "[acceptance-remote] $failed 件の検査が失敗しました。" >&2
  echo "[acceptance-remote] 対象サービスへ認証済みか、ネットワークへ到達できるかを先に確認すること。" >&2
  exit 1
fi

echo "[acceptance-remote] OK"