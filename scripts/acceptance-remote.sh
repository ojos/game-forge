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
trap 'rm -f "$LOG"' EXIT

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
run "prerequisite: gh authenticated" gh auth status
run "prerequisite: aws authenticated" aws sts get-caller-identity

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

run "repository exists and visibility matches" check_repository
run "default branch matches" check_default_branch
run "branch protection matches" check_branch_protection
run "actions variable matches" check_actions_variable
run "dns hosted zone matches" check_dns_zone
run "dns delegation from sakura is in place" check_dns_delegation
run "pages custom domain records match" check_pages_dns_records
run "wrangler production hosts match dns" check_wrangler_production_hosts

if [[ "$ran_any" -eq 0 ]]; then
  echo "[acceptance-remote] 外部層の受け入れ条件が未定義です。検査を 1 つも実行していません。" >&2
  echo "[acceptance-remote] 宣言と実際の外部状態を照合する検査を scripts/acceptance-remote.sh へ定義してください。" >&2
  exit 1
fi

if [[ "$failed" -gt 0 ]]; then
  echo "[acceptance-remote] $failed 件の検査が失敗しました。" >&2
  echo "[acceptance-remote] 対象サービスへ認証済みか、ネットワークへ到達できるかを先に確認すること。" >&2
  exit 1
fi

echo "[acceptance-remote] OK"