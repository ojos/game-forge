#!/usr/bin/env bash
# withdrawal-status.sh — 退会がどこまで進んだかを、D1 と R2 から**読むだけ**で確かめる
# （#518 / #586 / 仕様 3.7 / 5.10）
#
# 使い方:
#   bash scripts/withdrawal-status.sh                       # 終わっていない退会の一覧（手元の D1）
#   bash scripts/withdrawal-status.sh --remote              # 同じものを本番から
#   bash scripts/withdrawal-status.sh --remote <user_id>    # その利用者の 1 行ずつの判定
#
# 終了コード:
#   0 = WITHDRAWAL_COMPLETE（または一覧が空）
#   1 = WITHDRAWAL_PENDING（進行中。まだ終わっていない）
#   2 = 前提の不成立（未認証・道具が無い・応答の形が違う）
#   3 = WITHDRAWAL_BROKEN（**確定したのに消えていないものがある**。人が見る必要がある）
#
# ── なぜ要るのか ──────────────────────────────────────────────────────────
#
# **退会は押した要求の中で終わらない。** 作品の削除は 5 分ごとに起きる Worker
# （`game-forge-cleanup`）が進めるので、**「終わったか」を運営が確かめる手段が要る**
# （#518 の scope.in「終わったことを確かめる手段を運営に用意する」）。
#
# ## 書き込まない
#
# **本番へは select しか送らない**（`scripts/invite-stock.sh` と同じ規律）。止まった退会を
# 押し直す口はここに付けない——押し直すのは後続の処理の仕事で（10 分で代打する）、人が
# D1 を直接書くと、掴みと排他の規律（`src/withdrawal.ts` の段1）を外から破ることになる。
#
# ## 値を事前に埋めない
#
# **消えたはずのキーは、この場で D1 と接頭辞から組み立てる**（`docs/handoff.md` 4 章
# 「事前に読んだ値を埋めない」）。アイコンの接頭辞は `src/avatar-paths.ts` から取り出す
# ——書き写すと、接頭辞を変えた日にこの検査だけが古い場所を見る。
#
# ## 出さないもの
#
# **表示名・メールアドレス・指示文そのものを出さない。** 確かめたいのは「残っていないこと」で、
# 残っていた場合に中身まで端末のログへ写すと、匿名化の目的をこの手順が壊す。
#
# **GNU 拡張を使わない**（利用者の端末は macOS / bash 3.2。`docs/handoff.md` 3 章）。
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)" || exit 2
ROOT="$(dirname "$HERE")"
cd "$ROOT" || exit 2

PATHS_TS="src/avatar-paths.ts"
WITHDRAWAL_TS="src/withdrawal.ts"
WRANGLER_TOML="wrangler.toml"
SCOPE="--local"
USER_ID=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --remote)  SCOPE="--remote"; shift ;;
    --local)   SCOPE="--local"; shift ;;
    -h|--help) sed -n '2,20p' "${BASH_SOURCE[0]}" >&2; exit 0 ;;
    -*)        echo "[withdrawal-status] 不明な引数です: $1" >&2; exit 2 ;;
    *)
      if [[ -n "$USER_ID" ]]; then
        echo "[withdrawal-status] 利用者の id は 1 つだけ渡せます。" >&2
        exit 2
      fi
      USER_ID="$1"; shift ;;
  esac
done

command -v jq >/dev/null 2>&1 || { echo "[withdrawal-status] jq がありません。" >&2; exit 2; }
[[ -f "$PATHS_TS" ]] || { echo "[withdrawal-status] ${PATHS_TS} がありません。" >&2; exit 2; }
[[ -f "$WITHDRAWAL_TS" ]] || { echo "[withdrawal-status] ${WITHDRAWAL_TS} がありません。" >&2; exit 2; }
[[ -f "$WRANGLER_TOML" ]] || { echo "[withdrawal-status] ${WRANGLER_TOML} がありません。" >&2; exit 2; }

# ── 利用者の id の文法を確かめる ─────────────────────────────────────────────
#
# **`wrangler d1 execute` に束縛値を渡す口が無い**（受けるのは `--command` の SQL の文字列か
# `--file` だけである。`wrangler d1 execute --help` で確認）。つまり id は**綴りとして SQL へ
# 埋まる**ので、引用符を含む id を渡されると述語や UNION を足せる（PR #588 の Copilot の指摘）。
#
# **だから、埋める前に文法で弾く。** 利用者の id は `crypto.randomUUID()`
# （`src/auth/google.ts` の `insert into users`）なので、**正本の正規表現は
# `src/avatar-paths.ts` の `AVATAR_USER_ID_PATTERN`** である（アイコンの配信が同じ id を
# 受け取るために既に持っている）。**ここへ書き写さず、そこから取り出す。**
if [[ -n "$USER_ID" ]]; then
  # `/^…$/u` の中身だけを取り出し、`[[ =~ ]]` が読める ERE として使う。
  ID_PATTERN="$(sed -n "s|^export const AVATAR_USER_ID_PATTERN[[:space:]]*=[[:space:]]*/\(.*\)/u;.*|\1|p" "$PATHS_TS" | head -1)"
  if [[ -z "$ID_PATTERN" ]]; then
    echo "[withdrawal-status] ${PATHS_TS} から AVATAR_USER_ID_PATTERN を取り出せません。" >&2
    echo "[withdrawal-status] **取り出せないまま埋めない**（綴りが変わったなら、この sed も直してください）。" >&2
    exit 2
  fi
  if [[ ! "$USER_ID" =~ $ID_PATTERN ]]; then
    echo "[withdrawal-status] 利用者の id の形が違います: ${USER_ID}" >&2
    echo "[withdrawal-status] 期待する形（${PATHS_TS} の AVATAR_USER_ID_PATTERN）: ${ID_PATTERN}" >&2
    exit 2
  fi
fi

# **接頭辞と匿名化の値は正本から取り出す**（書き写さない）。
AVATAR_PREFIX="$(sed -n "s/^export const AVATAR_OBJECT_PREFIX[[:space:]]*=[[:space:]]*'\([^']*\)'.*/\1/p" "$PATHS_TS" | head -1)"
HISTORY_PREFIX="$(sed -n "s/^export const AVATAR_HISTORY_PREFIX[[:space:]]*=[[:space:]]*'\([^']*\)'.*/\1/p" "$PATHS_TS" | head -1)"
AVATAR_SUFFIX="$(sed -n "s/^export const AVATAR_FILE_SUFFIX[[:space:]]*=[[:space:]]*'\([^']*\)'.*/\1/p" "$PATHS_TS" | head -1)"
WITHDRAWN_NAME="$(sed -n "s/^export const WITHDRAWN_DISPLAY_NAME[[:space:]]*=[[:space:]]*'\([^']*\)'.*/\1/p" "$WITHDRAWAL_TS" | head -1)"
SUB_PREFIX="$(sed -n "s/^export const WITHDRAWN_GOOGLE_SUB_PREFIX[[:space:]]*=[[:space:]]*'\([^']*\)'.*/\1/p" "$WITHDRAWAL_TS" | head -1)"
for value in "$AVATAR_PREFIX" "$HISTORY_PREFIX" "$AVATAR_SUFFIX" "$WITHDRAWN_NAME" "$SUB_PREFIX"; do
  if [[ -z "$value" ]]; then
    echo "[withdrawal-status] 定数を取り出せません。綴りが変わったなら、このスクリプトの sed も直してください。" >&2
    exit 2
  fi
done

##
# 読み取りだけを送る。**select で始まらない文は送らない。**
#
# @param $1 SQL
# @return 1 行目の結果を JSON で（複数行なら配列で）
##
send_query() {
  local sql="$1"
  if [[ ! "$sql" =~ ^[[:space:]]*select[[:space:]] ]]; then
    echo "[withdrawal-status] select で始まらない文は送りません（読み取りのみ）。" >&2
    return 1
  fi

  local args=(d1 execute DB --command "$sql" --json)
  if [[ "$SCOPE" == "--remote" ]]; then
    args+=(--remote --env production)
    if [[ -z "${CLOUDFLARE_API_TOKEN:-}" && -f "$HERE/load-project-env.sh" ]]; then
      # shellcheck source=scripts/load-project-env.sh
      . "$HERE/load-project-env.sh"
    fi
  else
    args+=(--local)
  fi

  local out
  if ! out="$(CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV=false npx wrangler "${args[@]}" 2>&1)"; then
    echo "[withdrawal-status] D1 を読めません（${SCOPE}）:" >&2
    printf '%s\n' "$out" >&2
    if printf '%s' "$out" | grep -q 'no such'; then
      echo "[withdrawal-status] 表や列がありません。0045 が未適用の可能性があります。" >&2
    fi
    return 1
  fi

  local json
  json="$(printf '%s' "$out" | sed -n '/^\[/,$p')"
  if [[ -z "$json" ]]; then
    echo "[withdrawal-status] wrangler の応答に JSON が含まれていません:" >&2
    printf '%s\n' "$out" >&2
    return 1
  fi
  if ! jq -e '(type == "array") and (.[0].results | type == "array")' <<<"$json" >/dev/null 2>&1; then
    echo "[withdrawal-status] D1 の応答の形が想定と違います:" >&2
    printf '%s' "$json" | head -c 500 >&2
    echo >&2
    return 1
  fi
  jq -c '.[0].results' <<<"$json"
}

##
# 1 行ずつ PASS / FAIL を出す。
#
# @param $1 PASS なら 0 以外の空でない "ok"、そうでなければ空
# @param $2 見出し
##
verdict() {
  if [[ "$1" == "ok" ]]; then
    printf '  PASS %s\n' "$2"
  else
    printf '  FAIL %s\n' "$2"
    BROKEN=1
  fi
}

# ── 引数なし: 終わっていない退会の一覧 ────────────────────────────────────────
if [[ -z "$USER_ID" ]]; then
  ROWS="$(send_query "select id,
      withdrawal_started_at as started,
      withdrawn_at as settled,
      withdrawal_completed_at as completed,
      (select count(*) from games g where g.author_id = users.id and g.purged_at is null) as remaining
    from users
   where withdrawal_started_at is not null and withdrawal_completed_at is null
   order by withdrawal_started_at")" || exit 2

  COUNT="$(jq 'length' <<<"$ROWS")"
  echo "[withdrawal-status] 対象: ${SCOPE}"
  if [[ "$COUNT" == "0" ]]; then
    echo "[withdrawal-status] 終わっていない退会はありません。"
    echo "WITHDRAWAL_COMPLETE"
    exit 0
  fi
  echo "[withdrawal-status] 終わっていない退会: ${COUNT} 件"
  jq -r '.[] | "  \(.id)  掴んだ: \(.started)  確定: \(.settled // "まだ")  残りの作品: \(.remaining)"' <<<"$ROWS"
  echo "[withdrawal-status] 詳しく見るには: bash scripts/withdrawal-status.sh ${SCOPE} <user_id>"
  echo "WITHDRAWAL_PENDING"
  exit 1
fi

# ── 利用者 1 人ぶんの判定 ────────────────────────────────────────────────────
BROKEN=0
ROWS="$(send_query "select
    (case when withdrawal_started_at is null then 0 else 1 end) as started,
    (case when withdrawn_at is null then 0 else 1 end) as settled,
    (case when withdrawal_completed_at is null then 0 else 1 end) as completed,
    (case when google_sub = '${SUB_PREFIX}' || id then 1 else 0 end) as sub_anonymized,
    (case when email = '' then 1 else 0 end) as email_cleared,
    (case when display_name = '${WITHDRAWN_NAME}' then 1 else 0 end) as name_replaced,
    (case when bio = '' and profile_links = '[]' and x_handle is null then 1 else 0 end) as profile_cleared,
    (case when avatar_sha256 is null and avatar_lock_token is null then 1 else 0 end) as avatar_cleared,
    (select count(*) from handles h where h.user_id = users.id and h.released_at is null) as live_handles,
    (select count(*) from display_name_changes c where c.user_id = users.id) as name_history,
    (select count(*) from profile_changes c where c.user_id = users.id) as profile_history,
    (select count(*) from avatar_changes c where c.user_id = users.id) as avatar_history,
    (select count(*) from handle_changes c where c.user_id = users.id) as handle_history,
    (select count(*) from generations g where g.user_id = users.id) as ledger_rows,
    (select count(*) from generations g where g.user_id = users.id and g.prompt <> '') as ledger_prompts,
    (select count(*) from games g where g.author_id = users.id) as games_total,
    (select count(*) from games g where g.author_id = users.id and g.purged_at is null) as games_left,
    (select count(*) from games g where g.author_id = users.id and g.status = 'published') as games_public,
    (select count(*) from waitlist w where w.email <> '' and w.email = users.email) as waitlist_rows,
    (exists (select 1 from admin_actions a where a.target_kind = 'user' and a.target_id = users.id)
     or exists (select 1 from reports r join games g on g.id = r.game_id where g.author_id = users.id)
     or exists (select 1 from takedown_requests t join games g on g.id = t.game_id where g.author_id = users.id))
      as has_records
  from users where id = '${USER_ID}'")" || exit 2

if [[ "$(jq 'length' <<<"$ROWS")" == "0" ]]; then
  echo "[withdrawal-status] その id の利用者は居ません: ${USER_ID}"
  echo "WITHDRAWAL_BROKEN"
  exit 3
fi
ROW="$(jq -c '.[0]' <<<"$ROWS")"

##
# JSON から数を取り出す。
#
# @param $1 鍵
##
field() {
  jq -r --arg key "$1" '.[$key]' <<<"$ROW"
}

STARTED="$(field started)"
SETTLED="$(field settled)"
COMPLETED="$(field completed)"
HAS_RECORDS="$(field has_records)"

echo "[withdrawal-status] 対象: ${SCOPE} / 利用者: ${USER_ID}"
if [[ "$STARTED" != "1" ]]; then
  echo "[withdrawal-status] この利用者は退会していません（3 列とも空）。"
  echo "WITHDRAWAL_COMPLETE"
  exit 0
fi

echo "[withdrawal-status] 押した要求の中の処理"
[[ "$SETTLED" == "1" ]] && verdict ok "確定している（withdrawn_at）" || verdict '' "確定していない（退会処理中）"
if [[ "$SETTLED" == "1" ]]; then
  [[ "$(field sub_anonymized)" == "1" ]] && verdict ok "識別子が匿名化されている" || verdict '' "識別子が匿名化されていない"
  [[ "$(field email_cleared)" == "1" ]] && verdict ok "メールアドレスが空" || verdict '' "メールアドレスが残っている"
  [[ "$(field name_replaced)" == "1" ]] && verdict ok "表示名が置き換わっている" || verdict '' "表示名が置き換わっていない"
  [[ "$(field profile_cleared)" == "1" ]] && verdict ok "自己紹介・リンク・X が空" || verdict '' "プロフィールが残っている"
  [[ "$(field avatar_cleared)" == "1" ]] && verdict ok "アイコンの列と排他が空" || verdict '' "アイコンの列が残っている"
  [[ "$(field live_handles)" == "0" ]] && verdict ok "ハンドル名を手放している（90 日の予約へ）" || verdict '' "ハンドル名を持ったままである"
  [[ "$(field ledger_prompts)" == "0" ]] && verdict ok "台帳の指示文が空（行は $(field ledger_rows) 件のまま）" || verdict '' "台帳に指示文が $(field ledger_prompts) 件残っている"
  [[ "$(field waitlist_rows)" == "0" ]] && verdict ok "待機リストに行が無い" || verdict '' "待機リストに行が残っている"
  [[ "$(field games_public)" == "0" ]] && verdict ok "公開中の作品が無い" || verdict '' "公開中の作品が $(field games_public) 件ある"
fi

echo "[withdrawal-status] 変更履歴（運営の記録: $([[ "$HAS_RECORDS" == "1" ]] && echo あり || echo なし)）"
HISTORY_TOTAL=$(( $(field name_history) + $(field profile_history) + $(field avatar_history) + $(field handle_history) ))
if [[ "$HAS_RECORDS" == "1" ]]; then
  echo "  SKIP 記録があるので履歴は残す（合計 ${HISTORY_TOTAL} 行）"
elif [[ "$SETTLED" == "1" ]]; then
  [[ "$HISTORY_TOTAL" == "0" ]] && verdict ok "4 表とも 0 行" || verdict '' "履歴が ${HISTORY_TOTAL} 行残っている"
fi

echo "[withdrawal-status] 後続の処理"
echo "  ---- 作品: 全 $(field games_total) 件 / 中身を消していない $(field games_left) 件"
[[ "$(field games_left)" == "0" ]] && verdict ok "作品を消し終えている" || verdict '' "作品が $(field games_left) 件残っている"

# ── R2（読み取りだけ） ────────────────────────────────────────────────────────
#
# **バケットは scope ごとに違う**（ローカルは `game-forge-local`、本番は `game-forge`）。
# **`wrangler.toml` から取り出す**——書き写すと、バケット名を変えた日に、この検査だけが
# 存在しないバケットを引いて「無い」と言う（PR #588 の Copilot の指摘）。
echo "[withdrawal-status] アイコン（R2）"
if [[ "$SCOPE" == "--remote" ]]; then
  # `[[env.production.r2_buckets]]` の `bucket_name`（宣言の最後の 1 つ）。
  BUCKET="$(awk '/^\[\[env\.production\.r2_buckets\]\]/{f=1;next} f&&/^bucket_name[[:space:]]*=/{gsub(/^bucket_name[[:space:]]*=[[:space:]]*"|"[[:space:]]*$/,"");print;exit}' "$WRANGLER_TOML")"
else
  # トップレベル（ローカル）の `[[r2_buckets]]`。
  BUCKET="$(awk '/^\[\[r2_buckets\]\]/{f=1;next} f&&/^bucket_name[[:space:]]*=/{gsub(/^bucket_name[[:space:]]*=[[:space:]]*"|"[[:space:]]*$/,"");print;exit}' "$WRANGLER_TOML")"
fi
if [[ -z "$BUCKET" ]]; then
  echo "[withdrawal-status] ${WRANGLER_TOML} からバケット名を取り出せません（${SCOPE}）。" >&2
  echo "[withdrawal-status] **取り出せないまま「無い」と言わない。**" >&2
  exit 2
fi

AVATAR_KEY="${AVATAR_PREFIX}${USER_ID}${AVATAR_SUFFIX}"
r2_args=(r2 object get "${BUCKET}/${AVATAR_KEY}" --pipe)
if [[ "$SCOPE" == "--remote" ]]; then
  r2_args+=(--remote)
else
  r2_args+=(--local)
fi
if r2_out="$(CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV=false npx wrangler "${r2_args[@]}" 2>&1 >/dev/null)"; then
  verdict '' "現行のアイコンが R2 に残っている（${BUCKET}/${AVATAR_KEY}）"
# **「見つからない」だけを不在として扱う。** 認証・ネットワーク・権限の失敗まで「無い」に
# 倒すと、**確かめていないものを PASS にする**（読み取りに失敗した日に、退会が終わったと言う）。
elif printf '%s' "$r2_out" | grep -q 'The specified key does not exist'; then
  verdict ok "現行のアイコンが R2 に無い（${BUCKET}）"
else
  echo "[withdrawal-status] R2 を読めません（${BUCKET}/${AVATAR_KEY}）:" >&2
  printf '%s\n' "$r2_out" | head -5 >&2
  echo "[withdrawal-status] **読めなかったことを「無い」と扱いません。**" >&2
  exit 2
fi
echo "  ---- 差し替え前の写しは接頭辞で確かめる: ${BUCKET}/${HISTORY_PREFIX}${USER_ID}/"
echo '  ---- （wrangler r2 に一覧のコマンドが無いので、ダッシュボードか API で見る。docs/cleanup-worker.md）'

# ── 判定 ─────────────────────────────────────────────────────────────────────
if [[ "$BROKEN" == "1" && "$COMPLETED" == "1" ]]; then
  # **完了の印が立っているのに FAIL がある**——人が見る必要がある。
  echo "WITHDRAWAL_BROKEN"
  exit 3
fi
if [[ "$COMPLETED" == "1" ]]; then
  echo "WITHDRAWAL_COMPLETE"
  exit 0
fi
echo "WITHDRAWAL_PENDING"
exit 1
