#!/usr/bin/env bash
# lib/r2-lifecycle-judge.sh — R2 のライフサイクルの「宣言」と「実物」を突き合わせる判定だけを持つ（#31 / #380）
#
# 読み込むと `r2_lifecycle_judge` が使える。**ネットワークにも terraform にも触らない**——期待値と
# 実物の JSON を 2 つ受け取って、合否を返すだけである。
#
# ══════════════════════════════════════════════════════════════════════════════
# なぜ判定を分けたのか
# ══════════════════════════════════════════════════════════════════════════════
#
# **#380 で、判定の中身が「削除規則が 1 つも無いこと」から「宣言した接頭辞に限った削除規則だけが
# 在ること」へ変わった。** 条件が 1 行の `jq` から、id・接頭辞・秒数の突き合わせに増えた。
#
# `scripts/check-r2-lifecycle.sh` は外部層の検査で、**Cloudflare の API と apply 済みの state が無いと
# 回らない**（ローカルの反復にも CI にも載らない）。判定をあちらに書いたままだと、**判定の誤り
# （緩すぎて全体の削除規則を通す・厳しすぎて正しい宣言を落とす）は、本番で回すまで分からない。**
# 判定だけをここへ出せば、**作った JSON を食わせて機械で確かめられる**
# （`scripts/report-selftest.sh` の 15 節）。**本番の検査の側に、JSON を差し替える口は作らない**
# ——差し替えられる外部層の検査は、差し替えたまま緑になりうる。
#
# ══════════════════════════════════════════════════════════════════════════════
# 期待値の形（呼び出し側が terraform の output から組み立てる）
# ══════════════════════════════════════════════════════════════════════════════
#
#   {
#     "rule_ids":      ["abort-incomplete-multipart-uploads", "delete-replaced-avatars"],  … r2_lifecycle_rule_ids
#     "abort_rule_id": "abort-incomplete-multipart-uploads",                               … r2_abort_multipart_rule_id
#     "abort_max_age": 604800,                                                             … r2_abort_multipart_max_age_seconds
#     "delete_rules":  [{"id": "...", "prefix": "avatars/history/", "max_age_seconds": 2592000}]  … r2_lifecycle_delete_rules
#   }
#
# 実物は `GET /accounts/<id>/r2/buckets/<bucket>/lifecycle` の応答そのもの（`.result.rules[]`）。
#
# ══════════════════════════════════════════════════════════════════════════════
# 何を不合格にするか
# ══════════════════════════════════════════════════════════════════════════════
#
#   1. **宣言が、接頭辞の空な（バケット全体の）削除規則を持つ。** 宣言の側の誤りでも落とす
#      （確定26 / 3.7 の削除規約 3。共有されるオブジェクトが年齢で消える）
#   2. **実物の削除規則のうち、宣言のどれとも id・接頭辞・秒数・種別（Age）まで一致しないもの**
#      ——宣言の外の接頭辞・バケット全体・ダッシュボードで足した規則・秒数を縮めた規則
#   3. **宣言した削除規則が、実物に（一致する形で）無いもの**（apply していない・誰かが消した）
#   4. **削除に関わる未知の綴り**（上の判定が見ていない綴りの削除規則は黙って通るので、人へ見せる）
#   5. **規則の id の集合が宣言と違う**
#   6. **打ち切りの規則の秒数が違う・有効でない**
#
# 使い方（読み込んでから呼ぶ）:
#   . scripts/lib/r2-lifecycle-judge.sh
#   r2_lifecycle_judge "$expected_json" "$actual_json"   # 0 = 一致 / 1 = 乖離（理由は標準エラー）
#
# **bash 3.2 と BSD の道具で動かす**（利用者の端末は macOS。docs/handoff.md 3 章）。

##
# 宣言と実物を突き合わせる。
#
# 引数: $1 = 期待値の JSON / $2 = API の応答の JSON
# 標準出力: 一致した規則の 1 行ずつ / 標準エラー: 乖離の理由
# 戻り値: 0 = 一致 / 1 = 乖離あり・判定できない
##
r2_lifecycle_judge() {
  local expected="$1" actual="$2" failed=0 lines

  if ! jq -e '(.rule_ids | type == "array") and (.abort_rule_id | type == "string")
              and (.abort_max_age | type == "number") and (.delete_rules | type == "array")' \
       <<<"$expected" >/dev/null 2>&1; then
    echo "[r2-lifecycle-judge] 期待値の形が読めません（判定が成立しません）。" >&2
    return 1
  fi
  if ! jq -e '.result.rules | type == "array"' <<<"$actual" >/dev/null 2>&1; then
    echo "[r2-lifecycle-judge] 応答に .result.rules がありません（判定が成立しません）。" >&2
    return 1
  fi

  # ── 1. 宣言が、全体を対象にした削除規則を持たないこと ─────────────────────────
  lines="$(jq -r '.delete_rules[] | select((.prefix // "") == "") | .id' <<<"$expected")"
  if [[ -n "$lines" ]]; then
    echo "[r2-lifecycle-judge] 宣言に、接頭辞の無い（バケット全体の）削除規則があります:" >&2
    sed 's/^/  /' <<<"$lines" >&2
    failed=1
  fi

  # ── 2. 実物の削除規則が、すべて宣言のどれかと一致すること ────────────────────
  lines="$(jq -r --argjson want "$(jq -c '.delete_rules' <<<"$expected")" '
    .result.rules[]
    | (.deleteObjectsTransition // .delete_objects_transition) as $delete
    | select($delete != null)
    | . as $rule
    | ($rule.conditions.prefix // "") as $prefix
    | ($delete.condition.maxAge // $delete.condition.max_age) as $age
    | ($delete.condition.type) as $type
    | select(
        $prefix == ""
        or ([ $want[] | select(.id == $rule.id and .prefix == $prefix and .max_age_seconds == $age and .prefix != "") ] | length) == 0
        or $type != "Age"
        or $rule.enabled != true
      )
    | "\($rule.id)（接頭辞=\(if $prefix == "" then "（全体）" else $prefix end) / maxAge=\($age) / type=\($type) / enabled=\($rule.enabled)）"
  ' <<<"$actual")"
  if [[ -n "$lines" ]]; then
    echo "[r2-lifecycle-judge] 宣言した接頭辞・秒数と一致しない削除規則があります（3.7 の削除規約 3 に反します）:" >&2
    sed 's/^/  /' <<<"$lines" >&2
    echo "  許すのは terraform/r2-lifecycle.tf の local.r2_age_delete_rules に書いた接頭辞だけです。" >&2
    failed=1
  fi

  # ── 3. 宣言した削除規則が、実物に一致する形で在ること ────────────────────────
  lines="$(jq -r --argjson rules "$(jq -c '.result.rules' <<<"$actual")" '
    .delete_rules[]
    | . as $want
    | select(([ $rules[]
        | (.deleteObjectsTransition // .delete_objects_transition) as $delete
        | select($delete != null and .id == $want.id and (.conditions.prefix // "") == $want.prefix
                 and ($delete.condition.maxAge // $delete.condition.max_age) == $want.max_age_seconds
                 and $delete.condition.type == "Age" and .enabled == true)
      ] | length) == 0)
    | "\(.id)（接頭辞=\(.prefix) / maxAge=\(.max_age_seconds)）"
  ' <<<"$expected")"
  if [[ -n "$lines" ]]; then
    echo "[r2-lifecycle-judge] 宣言した削除規則が、実状態に同じ形でありません:" >&2
    sed 's/^/  /' <<<"$lines" >&2
    echo "  terraform apply が未実施なら、それが原因です。**/privacy の保存期間が守られていない状態です。**" >&2
    failed=1
  fi

  # ── 4. 削除に関わる未知の綴りが無いこと ─────────────────────────────────────
  # 上の jq は 2 つの綴りしか見ておらず、**見ていない綴りの削除規則は黙って通る。** 知っている鍵を
  # 取り除いてから、delete を含む**鍵**が残っていないかを見る（値は見ない——規則の id
  # `delete-replaced-avatars` に当たってしまう）。
  lines="$(jq -r '[.result.rules // [] | .[] | del(.deleteObjectsTransition, .delete_objects_transition)
                   | paths | .[] | strings | select(test("delete"; "i"))] | unique | .[]' <<<"$actual")"
  if [[ -n "$lines" ]]; then
    echo "[r2-lifecycle-judge] 削除に関わりうる未知の綴りが応答に在ります:" >&2
    sed 's/^/  /' <<<"$lines" >&2
    echo "  上の判定が拾えていない可能性があります。scripts/lib/r2-lifecycle-judge.sh を直すこと。" >&2
    failed=1
  fi

  # ── 5. 規則の id の集合が宣言と一致すること ─────────────────────────────────
  local want_ids have_ids
  want_ids="$(jq -r '.rule_ids[]' <<<"$expected" | LC_ALL=C sort | tr '\n' ' ')"
  have_ids="$(jq -r '.result.rules[]?.id' <<<"$actual" | LC_ALL=C sort | tr '\n' ' ')"
  if [[ "$want_ids" != "$have_ids" ]]; then
    echo "[r2-lifecycle-judge] ルールの id が宣言と一致しません。" >&2
    echo "  宣言: ${want_ids}" >&2
    echo "  実状態: ${have_ids:-（無し）}" >&2
    failed=1
  fi

  # ── 6. 打ち切りの規則の秒数と有効 ───────────────────────────────────────────
  local abort_id abort_want abort_have abort_enabled
  abort_id="$(jq -r '.abort_rule_id' <<<"$expected")"
  abort_want="$(jq -r '.abort_max_age' <<<"$expected")"
  abort_have="$(jq -r --arg id "$abort_id" '
    .result.rules[]? | select(.id == $id)
    | (.abortMultipartUploadsTransition // .abort_multipart_uploads_transition).condition.maxAge // empty' <<<"$actual")"
  abort_enabled="$(jq -r --arg id "$abort_id" '.result.rules[]? | select(.id == $id) | .enabled' <<<"$actual")"
  if [[ -z "$abort_have" ]]; then
    echo "[r2-lifecycle-judge] ルール ${abort_id} に打ち切りの条件がありません。" >&2
    failed=1
  elif [[ "$abort_have" != "$abort_want" ]]; then
    echo "[r2-lifecycle-judge] ルール ${abort_id} の maxAge が宣言と違います: 宣言=${abort_want} 実状態=${abort_have}" >&2
    failed=1
  elif [[ "$abort_enabled" != "true" ]]; then
    echo "[r2-lifecycle-judge] ルール ${abort_id} が有効になっていません。" >&2
    failed=1
  else
    echo "[r2-lifecycle-judge] OK ${abort_id}（有効 / maxAge=${abort_have} 秒）"
  fi

  if [[ "$failed" -eq 0 ]]; then
    # **削除規則の OK は、宣言した規則ごとに出す**（「削除規則なし」とは書かない。在るのが正しい）。
    jq -r '.delete_rules[] | "[r2-lifecycle-judge] OK \(.id)（接頭辞=\(.prefix) だけを \(.max_age_seconds) 秒で削除）"' <<<"$expected"
  fi
  return "$failed"
}
