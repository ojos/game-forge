#!/usr/bin/env bash
# check-r2-lifecycle.sh — R2 のライフサイクルが宣言どおりであることを検査する（3.7 / #31）
#
# **外部層の検査である**（`.github/project-ai-rules.md`「外部層の受け入れ検証」）。
# ネットワークと Cloudflare の API トークンを要するため、ローカルの反復には含めない。
#
# # 何を見るのか
#
#   1. **年齢だけで消すルールが 1 つも無いこと。** #31 の受け入れ条件
#      「公開済み作品が削除対象に含まれないこと」を、いちばん強い形で見る。
#      確定26 のとおり R2 のオブジェクトは作品をまたいで共有され、R2 のライフサイクルは
#      `games` を引けない（3.7 の削除規約 3）。このバケットには `delete` を置いてよい
#      接頭辞が 1 つも無いので、**1 つでも在れば不合格**でよい。
#      とくに `runtime/<版>/wasm_exec.js` は、消すとその版の作品すべてが配信 500 に
#      なる共有資材である（3.5 / #139）。
#   2. **宣言したルールが実在すること。** ルールの id と、打ち切りまでの秒数を
#      terraform の出力から読み、実状態と突き合わせる。**期待値をこのスクリプトへ
#      書き写さない**（shared-ai-rules.md 12 章「一覧の複製は機械照合で担保する」）。
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

expected_ids="$(terraform -chdir="$TF_DIR" output -json r2_lifecycle_rule_ids 2>/dev/null \
  | jq -r '.[]?' | sort)"
[[ -n "$expected_ids" ]] || fail "terraform の出力 r2_lifecycle_rule_ids を読めません。"

body="$(curl -sS --max-time 30 \
  -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" \
  "https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/r2/buckets/${bucket}/lifecycle" 2>&1)"
# Cloudflare は認証エラーでも HTTP 200 に success:false を載せることがある。終了コード
# だけで判定しない（scripts/acceptance-remote.sh の cf_api と同じ理由）。
jq -e '.success == true' <<<"$body" >/dev/null 2>&1 \
  || fail "Cloudflare API がライフサイクルを返しません（bucket=${bucket}）:" "  $(jq -c '.errors // .' <<<"$body" 2>/dev/null || printf '%s' "$body")"

echo "[check-r2-lifecycle] bucket=${bucket}"

failed=0

# ── 1. 年齢だけで消すルールが無いこと ────────────────────────────────────────
delete_ids="$(jq -r '[.result.rules[]? | select((.deleteObjectsTransition // .delete_objects_transition) != null) | .id] | .[]' <<<"$body")"
if [[ -n "$delete_ids" ]]; then
  echo "[check-r2-lifecycle] 年齢で消すルールが在ります（3.7 の削除規約 3 に反します）:" >&2
  sed 's/^/  /' <<<"$delete_ids" >&2
  echo "  R2 のライフサイクルは games を引けないため、共有されうるオブジェクトを載せられません。" >&2
  echo "  14 日の掃除は M5-4 のゴミ掃除が持ちます（確定13 / 確定26）。" >&2
  failed=$((failed + 1))
fi

# 綴りが変わっても気づけるようにする。上の jq は 2 つの綴りしか見ておらず、
# **見ていない綴りの削除ルールは黙って通る。** 生の JSON を走査して、delete を含む鍵が
# 現れたら（上で拾えていてもいなくても）人へ見せる。
suspicious="$(jq -r '.result.rules // [] | tostring' <<<"$body" | grep -oi 'delete[a-zA-Z]*' | sort -u)"
if [[ -n "$suspicious" && -z "$delete_ids" ]]; then
  echo "[check-r2-lifecycle] 削除に関わりうる未知の綴りが応答に在ります:" >&2
  sed 's/^/  /' <<<"$suspicious" >&2
  echo "  上の判定が拾えていない可能性があります。本スクリプトを直すこと。" >&2
  failed=$((failed + 1))
fi

# ── 2. 宣言したルールが実在すること ──────────────────────────────────────────
actual_ids="$(jq -r '[.result.rules[]?.id] | .[]' <<<"$body" | sort)"
if [[ "$actual_ids" != "$expected_ids" ]]; then
  echo "[check-r2-lifecycle] ルールの id が宣言と一致しません。" >&2
  echo "  宣言: $(tr '\n' ' ' <<<"$expected_ids")" >&2
  echo "  実状態: $(tr '\n' ' ' <<<"${actual_ids:-（無し）}")" >&2
  echo "  terraform -chdir=${TF_DIR} apply が未実施なら、それが原因です。" >&2
  failed=$((failed + 1))
fi

# ── 3. 打ち切りまでの秒数が宣言どおりであること ──────────────────────────────
while IFS= read -r rule_id; do
  [[ -z "$rule_id" ]] && continue
  actual_max_age="$(jq -r --arg id "$rule_id" \
    '.result.rules[]? | select(.id == $id)
     | (.abortMultipartUploadsTransition // .abort_multipart_uploads_transition).condition.maxAge // empty' <<<"$body")"
  if [[ -z "$actual_max_age" ]]; then
    echo "[check-r2-lifecycle] ルール ${rule_id} に打ち切りの条件がありません。" >&2
    failed=$((failed + 1))
    continue
  fi
  if [[ "$actual_max_age" != "$expected_max_age" ]]; then
    echo "[check-r2-lifecycle] ルール ${rule_id} の maxAge が宣言と違います: 宣言=${expected_max_age} 実状態=${actual_max_age}" >&2
    failed=$((failed + 1))
    continue
  fi
  enabled="$(jq -r --arg id "$rule_id" '.result.rules[]? | select(.id == $id) | .enabled' <<<"$body")"
  if [[ "$enabled" != "true" ]]; then
    echo "[check-r2-lifecycle] ルール ${rule_id} が有効になっていません。" >&2
    failed=$((failed + 1))
    continue
  fi
  # **ここで「削除ルールなし」と書かない。** 削除ルールの判定はバケット全体に対して
  # 上で済ませてあり、この行は 1 ルールぶんの照合結果である。混ぜると、別のルールに
  # 削除が在るのに「削除ルールなし」と読める行が出る。
  echo "[check-r2-lifecycle] OK ${rule_id}（有効 / maxAge=${actual_max_age} 秒）"
done <<<"$expected_ids"

if [[ "$failed" -gt 0 ]]; then
  echo "[check-r2-lifecycle] ${failed} 件の乖離があります。" >&2
  echo "R2_LIFECYCLE_FAIL"
  exit 1
fi

echo "R2_LIFECYCLE_PASS"
