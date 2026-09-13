#!/usr/bin/env bash
# check-r2-lifecycle.sh — R2 のライフサイクルが宣言どおりであることを検査する（3.7 / #31）
#
# **外部層の検査である**（`.github/project-ai-rules.md`「外部層の受け入れ検証」）。
# ネットワークと Cloudflare の API トークンを要するため、ローカルの反復には含めない。
#
# # 何を見るのか
#
#   1. **年齢で消すルールが、宣言した接頭辞の外に 1 つも無いこと。** #31 の受け入れ条件
#      「公開済み作品が削除対象に含まれないこと」を見る。確定26 のとおり R2 のオブジェクトは
#      作品をまたいで共有され、R2 のライフサイクルは `games` を引けない（3.7 の削除規約 3）。
#      とくに `runtime/<版>/wasm_exec.js` は、消すとその版の作品すべてが配信 500 に
#      なる共有資材である（3.5 / #139）。
#
#      > **#380 で「1 つでも在れば不合格」から変えた。** 差し替え前のアイコンの写し
#      > （`avatars/history/`）は 30 日で消えなければならず（利用者の決定・`/privacy`）、
#      > **写ししか置かない接頭辞なので削除規約 3 を満たす**（`terraform/r2-lifecycle.tf`）。
#      > **許すのは、宣言（`local.r2_age_delete_rules`）に書いた接頭辞・秒数と id まで一致する規則だけ**で、
#      > それ以外の接頭辞・バケット全体（接頭辞が空）・秒数を変えた規則は不合格である。
#      > **許す接頭辞は terraform の出力（`r2_lifecycle_delete_rules`）から読み、ここへ書き写さない。**
#   2. **宣言したルールが実在すること。** ルールの id・打ち切りまでの秒数・削除規則の接頭辞と秒数を
#      terraform の出力から読み、実状態と突き合わせる。**期待値をこのスクリプトへ
#      書き写さない**（shared-ai-rules.md 12 章「一覧の複製は機械照合で担保する」）。
#
#   **判定そのものは `scripts/lib/r2-lifecycle-judge.sh` にある。** このスクリプトは期待値（terraform の
#   出力）と実物（Cloudflare の API）を集めて渡すだけである。判定は `scripts/report-selftest.sh` の 15 節が
#   作った JSON を食わせて確かめる（宣言の外の削除規則・全体の削除規則・秒数の違いが赤になること）。
#   **このスクリプトに JSON を差し替える口は作らない**——差し替えられる外部層の検査は、差し替えたまま緑になる。
#
# # なぜ terraform plan だけでは足りないのか
#
# plan は宣言と tfstate の差を見るが、**ダッシュボードで足された削除ルールは
# `cloudflare_r2_bucket_lifecycle` の管理下に入るので plan でも出る。** それでもここを
# 置くのは、**この 1 リソースがバケットのライフサイクル全体を持つ**という前提そのものを
# 実物で確かめるためである。前提が崩れれば（別リソース経由、API の仕様変更）、plan は
# 緑のまま削除ルールが在りうる。
#
# 使い方:
#   bash scripts/check-r2-lifecycle.sh
#
# 宣言と state を読む場所は `ACCEPTANCE_TF_DIR` で差し替えられる（#318。既定は
# `terraform`）。**state はローカル backend で、apply を通したツリーにしかない**ため、
# 別の worktree から回すときは apply 済みのツリーを指すこと。
#
#   ACCEPTANCE_TF_DIR=/path/to/primary/terraform bash scripts/check-r2-lifecycle.sh
#
# 変異させた写しを指せば、宣言を汚さずに「この検査が空振りしていない」ことも確かめられる
# （写しへ age ベースの削除規則を足すと赤くなる）。
#
# 前提: CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID（無ければ .env から読む）と、
#       terraform の init 済み・apply 済みの state。**このスクリプトは認証を行わない。**
#
# 終了コード: 0 = 一致（標準出力 R2_LIFECYCLE_PASS）/ 1 = 乖離・前提の不成立
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)" || exit 1
ROOT="$(dirname "$HERE")" || exit 1
cd "$ROOT" || exit 1

# 宣言を読む場所（TF_DIR）。**既定値をここへ書かない。**
#
# この検査は単独でも、`scripts/acceptance-remote.sh` からも起動される。両方の入口が
# `ACCEPTANCE_TF_DIR` を尊重する必要がある（#318）が、既定値の綴りを両方へ書くと
# 「片方だけ直した日に、既定で読む場所が入口ごとに違う」状態になる。**既定値は
# `scripts/lib/tf-dir.sh` の 1 か所だけに置き、両方がそこを読む**（理由の全文は同ファイル）。
#
# ルートへ cd した後に読み込むこと（既定値が相対パスのため）。
# shellcheck source=scripts/lib/tf-dir.sh
. "$HERE/lib/tf-dir.sh"
# shellcheck source=scripts/lib/r2-lifecycle-judge.sh
. "$HERE/lib/r2-lifecycle-judge.sh"

fail() {
  printf '[check-r2-lifecycle] %s\n' "$@" >&2
  echo "R2_LIFECYCLE_FAIL"
  exit 1
}

# **使う道具はすべて確認する。** 一部だけ確認すると、確認していない道具が無いときに
# 「API が返さない」「JSON を解釈できない」として報告され、**前提の不成立と実際の乖離が
# 読み分けられなくなる**（scripts/acceptance-remote.sh の冒頭がまさにその読み分けを
# 求めている）。curl と grep はどちらもこの検査の判定に直接使っている。
for tool in jq terraform curl grep; do
  command -v "$tool" >/dev/null 2>&1 \
    || fail "${tool} がありません。" \
            "  前提の不成立であって、宣言と外部状態の乖離ではありません。"
done

if [[ -z "${CLOUDFLARE_API_TOKEN:-}" || -z "${CLOUDFLARE_ACCOUNT_ID:-}" ]]; then
  if [[ -f "$HERE/load-project-env.sh" ]]; then
    # shellcheck source=scripts/load-project-env.sh
    . "$HERE/load-project-env.sh"
  fi
fi
if [[ -z "${CLOUDFLARE_API_TOKEN:-}" || -z "${CLOUDFLARE_ACCOUNT_ID:-}" ]]; then
  fail "CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID が環境にも .env にもありません。" \
       "  前提の不成立であって、宣言と外部状態の乖離ではありません（.env.example / docs/pages-deploy.md）。"
fi

##
# terraform の出力を 1 つ読む。
#
# **期待値をスクリプトへ書き写さないための入口である。** 読めなければ「一致」ではなく
# 「検査が成立していない」として落とす。
#
# 引数: $1 = 出力名
##
tf_output() {
  local name="$1" value
  if ! value="$(terraform -chdir="$TF_DIR" output -raw "$name" 2>/dev/null)" || [[ -z "$value" ]]; then
    return 1
  fi
  printf '%s' "$value"
}

bucket="$(tf_output r2_bucket_name)" \
  || fail "terraform の出力 r2_bucket_name を読めません。" \
          "  terraform -chdir=${TF_DIR} init / apply を先に通すこと。"
expected_max_age="$(tf_output r2_abort_multipart_max_age_seconds)" \
  || fail "terraform の出力 r2_abort_multipart_max_age_seconds を読めません。"

abort_rule_id="$(tf_output r2_abort_multipart_rule_id)" \
  || fail "terraform の出力 r2_abort_multipart_rule_id を読めません。"

expected_ids_json="$(terraform -chdir="$TF_DIR" output -json r2_lifecycle_rule_ids 2>/dev/null)"
jq -e 'type == "array" and length > 0' <<<"$expected_ids_json" >/dev/null 2>&1 \
  || fail "terraform の出力 r2_lifecycle_rule_ids を読めません。"

# **許す削除規則の一覧も terraform の出力から読む**（#380。接頭辞をこのスクリプトへ書き写さない）。
# **空の配列は「読めた」として扱う**（削除規則を 1 つも宣言しない形も正しい宣言である）。
# 読めない（出力が無い・配列でない）ときだけ落とす——読めないことを「削除規則なし」に倒さない。
delete_rules_json="$(terraform -chdir="$TF_DIR" output -json r2_lifecycle_delete_rules 2>/dev/null)"
jq -e 'type == "array"' <<<"$delete_rules_json" >/dev/null 2>&1 \
  || fail "terraform の出力 r2_lifecycle_delete_rules を読めません。"

expected_json="$(jq -n \
  --argjson ids "$expected_ids_json" \
  --arg abort_id "$abort_rule_id" \
  --argjson abort_max "$expected_max_age" \
  --argjson deletes "$delete_rules_json" \
  '{rule_ids: $ids, abort_rule_id: $abort_id, abort_max_age: $abort_max, delete_rules: $deletes}')" \
  || fail "期待値を組み立てられません（r2_abort_multipart_max_age_seconds が数でない可能性があります）。"

body="$(curl -sS --max-time 30 \
  -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" \
  "https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/r2/buckets/${bucket}/lifecycle" 2>&1)"
# Cloudflare は認証エラーでも HTTP 200 に success:false を載せることがある。終了コード
# だけで判定しない（scripts/acceptance-remote.sh の cf_api と同じ理由）。
jq -e '.success == true' <<<"$body" >/dev/null 2>&1 \
  || fail "Cloudflare API がライフサイクルを返しません（bucket=${bucket}）:" "  $(jq -c '.errors // .' <<<"$body" 2>/dev/null || printf '%s' "$body")"

echo "[check-r2-lifecycle] bucket=${bucket}"

failed=0

# ── 判定（scripts/lib/r2-lifecycle-judge.sh）────────────────────────────────
if ! r2_lifecycle_judge "$expected_json" "$body"; then
  failed=1
fi

if [[ "$failed" -gt 0 ]]; then
  echo "[check-r2-lifecycle] 乖離があります（理由は上）。" >&2
  echo "R2_LIFECYCLE_FAIL"
  exit 1
fi

echo "R2_LIFECYCLE_PASS"
