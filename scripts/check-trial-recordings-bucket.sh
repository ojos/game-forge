#!/usr/bin/env bash
# check-trial-recordings-bucket.sh — 試用の録画のバケットが宣言どおり在り、閉じていて、90 日で消えることを確かめる（#978）
#
# **外部層の検査である**（`.github/project-ai-rules.md`「外部層の受け入れ検証」）。ネットワークと Cloudflare の
# API トークンを要するため、ローカルの反復には含めない。`scripts/acceptance-remote.sh` から呼ばれる。
#
# # 何を見るのか
#
#   1. **バケットが在ること**（`terraform/trial-recordings.tf` の `cloudflare_r2_bucket.trial_recordings`）。
#      無いまま Pages を配ると、束縛 `TRIAL_RECORDINGS` が解決できない。
#   2. **r2.dev の公開 URL が閉じていること。** 録画は試用者の画面と声である。ダッシュボードで 1 回押せば開く。
#   3. **独自ドメインが 1 つも付いていないこと。** 付けば、その名前で誰でも読める。
#   4. **ライフサイクルが宣言どおりであること**——規則の id の集合が一致し、削除の規則が「接頭辞を絞らず
#      （バケット全体を）宣言の秒数で消す」形で有効に在り、打ち切りの規則の秒数が一致すること。
#      **秒数を縮めた規則も、延ばした規則も落とす**（同意の文面の「90 日で消します」が嘘になる・
#      録画が早く消える、のどちらも乖離である）。
#
# **期待値はすべて terraform の出力から読む**（名前・秒数・規則の id。このスクリプトへ書き写さない。
# shared-ai-rules 12 章）。読めなければ「一致」ではなく「検査が成立していない」として落とす。
#
# 使い方:
#   bash scripts/check-trial-recordings-bucket.sh
#   ACCEPTANCE_TF_DIR=/path/to/primary/terraform bash scripts/check-trial-recordings-bucket.sh
#
# 前提: CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID（無ければ .env から読む）と、terraform の init 済み・
#       apply 済みの state（state はプライマリにしかない）。**このスクリプトは認証を行わない。**
#
# 終了コード: 0 = 一致（標準出力 TRIAL_RECORDINGS_BUCKET_PASS）/ 1 = 乖離・前提の不成立
#
# **bash 3.2 と BSD の道具で動かす**（利用者の端末は macOS）。
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)" || exit 1
ROOT="$(dirname "$HERE")" || exit 1
cd "$ROOT" || exit 1

# 宣言を読む場所。既定値は scripts/lib/tf-dir.sh の 1 か所だけに置く（scripts/check-r2-lifecycle.sh と同じ）。
# shellcheck source=scripts/lib/tf-dir.sh
. "$HERE/lib/tf-dir.sh"

fail() {
  printf '[check-trial-recordings-bucket] %s\n' "$@" >&2
  echo "TRIAL_RECORDINGS_BUCKET_FAIL"
  exit 1
}

for tool in jq terraform curl; do
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
# terraform の出力を 1 つ読む（読めなければ 1 を返す）。
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

bucket="$(tf_output trial_recordings_bucket_name)" \
  || fail "terraform の出力 trial_recordings_bucket_name を読めません。" \
          "  terraform -chdir=${TF_DIR} init / apply を先に通すこと。"
retention="$(tf_output trial_recordings_retention_seconds)" \
  || fail "terraform の出力 trial_recordings_retention_seconds を読めません。"
abort_max="$(tf_output trial_recordings_abort_multipart_seconds)" \
  || fail "terraform の出力 trial_recordings_abort_multipart_seconds を読めません。"
delete_id="$(tf_output trial_recordings_delete_rule_id)" \
  || fail "terraform の出力 trial_recordings_delete_rule_id を読めません。"
abort_id="$(tf_output trial_recordings_abort_rule_id)" \
  || fail "terraform の出力 trial_recordings_abort_rule_id を読めません。"
ids_json="$(terraform -chdir="$TF_DIR" output -json trial_recordings_lifecycle_rule_ids 2>/dev/null)"
jq -e 'type == "array" and length > 0' <<<"$ids_json" >/dev/null 2>&1 \
  || fail "terraform の出力 trial_recordings_lifecycle_rule_ids を読めません。"

API="https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/r2/buckets/${bucket}"

##
# Cloudflare の API を 1 回 GET し、成功した応答の本文を標準出力へ出す。
#
# **認証エラーでも HTTP 200 に success:false が載ることがある**ので、本文の success で判定する
# （scripts/check-r2-lifecycle.sh と同じ理由）。
#
# 引数: $1 = API の接尾辞（空ならバケットそのもの）/ $2 = 何を読むか（失敗の文に使う）
##
cf_get() {
  local suffix="$1" what="$2" body
  body="$(curl -sS --max-time 30 -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" "${API}${suffix}" 2>&1)"
  if ! jq -e '.success == true' <<<"$body" >/dev/null 2>&1; then
    printf '[check-trial-recordings-bucket] Cloudflare API が %s を返しません（bucket=%s）:\n  %s\n' \
      "$what" "$bucket" "$(jq -c '.errors // .' <<<"$body" 2>/dev/null || printf '%s' "$body")" >&2
    return 1
  fi
  printf '%s' "$body"
}

echo "[check-trial-recordings-bucket] bucket=${bucket}"
failed=0

# ── 1. バケットが在る ──────────────────────────────────────────────────────────
if cf_get "" "バケット" >/dev/null; then
  echo "[check-trial-recordings-bucket] OK バケットが在る"
else
  echo "[check-trial-recordings-bucket] バケットがありません。terraform apply が未実施なら、それが原因です。" >&2
  fail "バケットが無いので、以降の検査が成立しません。"
fi

# ── 2. r2.dev の公開 URL が閉じている ─────────────────────────────────────────
if managed="$(cf_get "/domains/managed" "r2.dev の公開 URL の状態")"; then
  if jq -e '.result.enabled == false' <<<"$managed" >/dev/null 2>&1; then
    echo "[check-trial-recordings-bucket] OK r2.dev の公開 URL は閉じている"
  else
    echo "[check-trial-recordings-bucket] r2.dev の公開 URL が開いています（$(jq -c '.result' <<<"$managed")）。録画を誰でも読めます。" >&2
    failed=1
  fi
else
  failed=1
fi

# ── 3. 独自ドメインが無い ──────────────────────────────────────────────────────
if custom="$(cf_get "/domains/custom" "独自ドメインの一覧")"; then
  count="$(jq -r '(.result.domains // []) | length' <<<"$custom" 2>/dev/null)"
  if [[ "$count" == "0" ]]; then
    echo "[check-trial-recordings-bucket] OK 独自ドメインは 1 つも無い"
  else
    echo "[check-trial-recordings-bucket] 独自ドメインが付いています（$(jq -c '[.result.domains[]?.domain]' <<<"$custom")）。録画を誰でも読めます。" >&2
    failed=1
  fi
else
  failed=1
fi

# ── 4. ライフサイクル ─────────────────────────────────────────────────────────
if lifecycle="$(cf_get "/lifecycle" "ライフサイクル")"; then
  want_ids="$(jq -r '.[]' <<<"$ids_json" | LC_ALL=C sort | tr '\n' ' ')"
  have_ids="$(jq -r '.result.rules[]?.id' <<<"$lifecycle" | LC_ALL=C sort | tr '\n' ' ')"
  if [[ "$want_ids" != "$have_ids" ]]; then
    echo "[check-trial-recordings-bucket] ライフサイクルの規則の id が宣言と一致しません。" >&2
    echo "  宣言: ${want_ids}" >&2
    echo "  実状態: ${have_ids:-（無し）}" >&2
    failed=1
  fi

  # 削除の規則: 接頭辞が空（バケット全体）・Age・宣言の秒数・有効。
  if jq -e --arg id "$delete_id" --argjson age "$retention" '
       [.result.rules[]? | select(.id == $id)
        | (.deleteObjectsTransition // .delete_objects_transition) as $d
        | select($d != null and (.conditions.prefix // "") == "" and $d.condition.type == "Age"
                 and ($d.condition.maxAge // $d.condition.max_age) == $age and .enabled == true)]
       | length == 1' <<<"$lifecycle" >/dev/null 2>&1; then
    echo "[check-trial-recordings-bucket] OK ${delete_id}（バケット全体を ${retention} 秒で削除）"
  else
    echo "[check-trial-recordings-bucket] 削除の規則 ${delete_id} が宣言の形（接頭辞なし・Age・${retention} 秒・有効）で在りません:" >&2
    jq -c --arg id "$delete_id" '[.result.rules[]? | select(.id == $id)]' <<<"$lifecycle" >&2
    echo "  **同意の文面と /privacy の「90 日で消します」が守られていない状態です。**" >&2
    failed=1
  fi

  # ほかの削除の規則が無い（秒数の違う規則が並んでいると、早く消える）。
  others="$(jq -r --arg id "$delete_id" '
    .result.rules[]? | select(.id != $id)
    | select((.deleteObjectsTransition // .delete_objects_transition) != null) | .id' <<<"$lifecycle")"
  if [[ -n "$others" ]]; then
    echo "[check-trial-recordings-bucket] 宣言の外の削除の規則があります:" >&2
    sed 's/^/  /' <<<"$others" >&2
    failed=1
  fi

  # 打ち切りの規則。
  if jq -e --arg id "$abort_id" --argjson age "$abort_max" '
       [.result.rules[]? | select(.id == $id)
        | (.abortMultipartUploadsTransition // .abort_multipart_uploads_transition) as $a
        | select($a != null and ($a.condition.maxAge // $a.condition.max_age) == $age and .enabled == true)]
       | length == 1' <<<"$lifecycle" >/dev/null 2>&1; then
    echo "[check-trial-recordings-bucket] OK ${abort_id}（有効 / maxAge=${abort_max} 秒）"
  else
    echo "[check-trial-recordings-bucket] 打ち切りの規則 ${abort_id} が宣言の形（${abort_max} 秒・有効）で在りません。" >&2
    failed=1
  fi
else
  failed=1
fi

if [[ "$failed" -gt 0 ]]; then
  echo "[check-trial-recordings-bucket] 乖離があります（理由は上）。" >&2
  echo "TRIAL_RECORDINGS_BUCKET_FAIL"
  exit 1
fi

echo "TRIAL_RECORDINGS_BUCKET_PASS"
