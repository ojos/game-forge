#!/usr/bin/env bash
# trial-timeline.sh — 試用者 1 人の行動を、台帳から時系列で取り出す（#972 / docs/user-trial.md）
#
# ## なぜ要るのか
#
# **試用の録画は「何をしたか」を映すが、「何を頼んだか」は画面の端に小さく出るだけである。**
# 生成のお題・作った作品・フォーク・公開・版を、本番の D1 から時刻つきで並べ、録画と
# 突き合わせられるようにする（docs/user-trial.md「行動の記録を取り出す」）。
#
# 使い方:
#   bash scripts/trial-timeline.sh --handle <ハンドル>             # 手元の D1（既定）
#   bash scripts/trial-timeline.sh --remote --handle <ハンドル>    # 本番（読み取りのみ）
#   bash scripts/trial-timeline.sh --handle <ハンドル> --format json
#   bash scripts/trial-timeline.sh --persist-to <dir> --handle <h> # 使い捨ての手元 D1（自己検査用）
#
# 終了コード:
#   0 = TRIAL_TIMELINE_PASS（出力した。行が 0 件でも 0）
#   2 = 前提の不成立（未認証・道具が無い・応答の形が違う・引数が不正・ハンドルが見つからない）
#
# ── 出すもの・出せないもの ──────────────────────────────────────────────────
#
# 出すのは、登録・生成とチャットの呼び出し（お題の文面つき）・作品の作成とフォーク・公開・
# 版（推敲）の 5 種類である。
#
# **いいねは出せない。** いいねの正本は D1 ではなく Durable Objects にあり（docs/likes.md）、
# D1 には作品ごとの数しか写されない。誰がいつ付けたかは台帳に無い。**プレイ（他人の作品を
# 開いたか）も同じ**で、作品ごとの数しか無い。どちらも録画で見る。
#
# **生成の行は「LLM の呼び出し 1 回」である**（generations の 1 行。リトライも 1 行）。
# 同じお題が 2 行並んだら、リトライか、同じ文面で頼み直したかのどちらかである。
#
# ── 出力を持ち出さない ──────────────────────────────────────────────────────
#
# **出力には試用者のお題の文面が載る。** 試用者には docs/user-trial.md の同意の文面で
# 断ってあるが、**リポジトリは public なので、出力をリポジトリの中へ保存しない。**
# 試用の控えの置き場（リポジトリの外）へリダイレクトすること。
#
# ── 本番へは select しか送らない ────────────────────────────────────────────
#
# scripts/kpi-report.sh と同じ規律である。組み立てた SQL が select / with で始まり、
# 書き込みの語を含まないことを確かめてから送る。ハンドルは D1 の CHECK と同じ形
# （英小文字・数字・`_` の 3〜20 文字）だけを受け付けるので、SQL へそのまま置いてよい。
#
# **GNU 拡張を使わない**（利用者の端末は macOS / bash 3.2。docs/handoff.md 3 章）。
# 時刻の JST への変換は SQL の datetime で行い、`date` に頼らない。
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)" || exit 2
ROOT="$(dirname "$HERE")"
cd "$ROOT" || exit 2

SCOPE="--local"
PERSIST_TO=""
FORMAT="table"
HANDLE=""

##
# 値を取る引数に、値が付いていることを確かめる。**無ければ落とす。**
#
# `shift 2` は残りが 1 個のとき失敗し、同じ引数を読み続けて無限ループになる
# （scripts/kpi-report.sh の同名の関数と同じ理由）。
#
# @param $1 引数の綴り
# @param $2 残りの個数
##
require_value() {
  if [[ "$2" -lt 2 ]]; then
    echo "[trial-timeline] $1 には値が要ります。" >&2
    exit 2
  fi
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --remote)     SCOPE="--remote"; shift ;;
    --local)      SCOPE="--local"; shift ;;
    --persist-to) require_value "$1" "$#"; PERSIST_TO="$2"; shift 2 ;;
    --format)     require_value "$1" "$#"; FORMAT="$2"; shift 2 ;;
    --handle)     require_value "$1" "$#"; HANDLE="$2"; shift 2 ;;
    -h|--help)    sed -n '2,16p' "${BASH_SOURCE[0]}" >&2; exit 0 ;;
    *) echo "[trial-timeline] 不明な引数です: $1" >&2; exit 2 ;;
  esac
done

if [[ "$FORMAT" != "table" && "$FORMAT" != "json" ]]; then
  echo "[trial-timeline] --format は table か json です: ${FORMAT}" >&2
  exit 2
fi
if [[ -n "$PERSIST_TO" && "$SCOPE" == "--remote" ]]; then
  echo "[trial-timeline] --persist-to は手元の D1 専用です（--remote とは併用できません）。" >&2
  exit 2
fi
# **D1 の CHECK と同じ形だけを通す**（migrations の handles 表）。先頭の `@` は付けない。
if [[ ! "$HANDLE" =~ ^[a-z0-9_]{3,20}$ ]]; then
  echo "[trial-timeline] --handle は英小文字・数字・_ の 3〜20 文字です（@ は付けません）: ${HANDLE}" >&2
  exit 2
fi
if ! command -v jq >/dev/null 2>&1; then
  echo "[trial-timeline] jq がありません（応答の形を確かめるのに要ります）。" >&2
  exit 2
fi

##
# 読み取りだけを送り、結果の行の配列（JSON）を標準出力へ出す。
#
# **select / with で始まらない文と、書き込みの語を含む文は送らない。**
# 応答の形を先に検査する——形が変わった日に「0 行」と読めてしまうのが、いちばん
# 気づけない壊れ方だからである（scripts/kpi-report.sh と同じ）。
#
# @param $1 SQL
# @return 0 = 送れた / 1 = 送れない・読めない
##
send_query() {
  local sql="$1"
  if [[ ! "$sql" =~ ^[[:space:]]*(select|with)[[:space:]] ]]; then
    echo "[trial-timeline] select / with で始まらない文は送りません（読み取りのみ）。" >&2
    return 1
  fi
  if printf '%s' "$sql" | tr 'A-Z' 'a-z' | grep -E '(^|[^a-z_])(insert|update|delete|drop|create|alter|replace)([^a-z_]|$)' >/dev/null; then
    echo "[trial-timeline] 書き込みを伴う語が含まれています（読み取りのみ）。" >&2
    return 1
  fi

  local args=(d1 execute DB --command "$sql" --json)
  if [[ "$SCOPE" == "--remote" ]]; then
    # 本番の D1 は [env.production] 側にしか宣言が無い（scripts/kpi-report.sh と同じ）。
    args+=(--remote --env production)
    if [[ -z "${CLOUDFLARE_API_TOKEN:-}" && -f "$HERE/load-project-env.sh" ]]; then
      # shellcheck source=scripts/load-project-env.sh
      . "$HERE/load-project-env.sh"
    fi
  else
    args+=(--local)
    if [[ -n "$PERSIST_TO" ]]; then
      args+=(--persist-to "$PERSIST_TO")
    fi
  fi

  local out
  if ! out="$(CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV=false npx wrangler "${args[@]}" 2>&1)"; then
    echo "[trial-timeline] D1 を読めません（${SCOPE}）:" >&2
    printf '%s\n' "$out" >&2
    return 1
  fi
  local json
  json="$(printf '%s' "$out" | sed -n '/^\[/,$p')"
  if [[ -z "$json" ]] || ! jq -e '(type == "array") and (.[0] | type == "object") and (.[0].results | type == "array")' \
       <<<"$json" >/dev/null 2>&1; then
    echo "[trial-timeline] D1 の応答の形が想定と違います（wrangler --json の形が変わった可能性があります）。" >&2
    printf '%s' "$out" | head -c 500 >&2
    echo >&2
    return 1
  fi
  jq -c '.[0].results' <<<"$json"
}

# ── 利用者を引く ────────────────────────────────────────────────────────────
#
# **いま使っているハンドル（released_at が NULL の行）だけを引く。** 改名で手放した
# ハンドルで引くと、予約中の旧名から同じ人へ届いてしまい、どの名前で頼んだかが曖昧になる。
SQL_USER="select user_id from handles where handle = '${HANDLE}' and released_at is null"
if ! USER_ROWS="$(send_query "$SQL_USER")"; then
  exit 2
fi
USER_ID="$(jq -r '.[0].user_id // empty' <<<"$USER_ROWS")"
if [[ -z "$USER_ID" ]]; then
  echo "[trial-timeline] ハンドル ${HANDLE} の利用者が見つかりません（いま使っているハンドルで指定してください）。" >&2
  exit 2
fi
# user_id は D1 から読んだ値だが、SQL へ戻す前に形を確かめる（引用符を含まないこと）。
if [[ ! "$USER_ID" =~ ^[A-Za-z0-9_-]+$ ]]; then
  echo "[trial-timeline] 利用者の id の形が想定と違います。" >&2
  exit 2
fi

# ── 出来事を 1 本の列に並べる ───────────────────────────────────────────────
#
# 同じ秒の出来事は、起きる順（登録 → 呼び出し → 作品 → 版 → 公開）で並べる（ord）。
# 版は seq 2 以上だけを数える（seq 1 は初回生成で、作品の行と重なる。migrations/0009）。
# 版のお題は、同じ呼び出しが generations にも載るので、ここでは版の番号だけを出す。
SQL_EVENTS="select ts, datetime(ts, 'unixepoch', '+9 hours') as at_jst, kind, game_id, detail from (
  select created_at as ts, 0 as ord, 'registered' as kind, null as game_id, '' as detail
    from users where id = '${USER_ID}'
  union all
  select created_at, 1,
         case when kind = 'chat' then 'chat' else 'generation' end,
         game_id,
         case when succeeded = 1 then '' else '[失敗] ' end || prompt
    from generations where user_id = '${USER_ID}'
  union all
  select created_at, 2,
         case when parent_id is null then 'game_created' else 'fork_created' end,
         id,
         title
           || case when parent_id is null then '' else '（親: ' || parent_id || '）' end
           || case when generation_state = 'failed' then ' [生成失敗]' else '' end
    from games where author_id = '${USER_ID}'
  union all
  select r.created_at, 3, 'revision', r.game_id, '版 ' || r.seq
    from game_revisions r join games g on g.id = r.game_id
   where g.author_id = '${USER_ID}' and r.seq >= 2
  union all
  select published_at, 4, 'published', id, title
    from games where author_id = '${USER_ID}' and published_at is not null
) order by ts, ord"

if ! EVENTS="$(send_query "$SQL_EVENTS")"; then
  exit 2
fi

if [[ "$FORMAT" == "json" ]]; then
  jq -n --arg handle "$HANDLE" --argjson events "$EVENTS" '{
    handle: $handle,
    unavailable: ["いいね（正本が Durable Objects にあり、誰がいつ付けたかは D1 に無い）",
                  "プレイ（作品ごとの数しか無い）"],
    events: [$events[] | {at: .ts, atJst: .at_jst, kind: .kind, gameId: .game_id, detail: .detail}]
  }' || { echo "[trial-timeline] 出来事を整形できません。" >&2; exit 2; }
  exit 0
fi

echo "[trial-timeline] ${HANDLE} の出来事（${SCOPE}。時刻は JST）"
echo "[trial-timeline] いいねとプレイは台帳に無いので出ません（録画で見ます）。"
echo
# 改行とタブは 1 行に畳む（お題は複数行でありうる）。
jq -r '
  def kind_ja: {
    registered: "登録", generation: "生成", chat: "チャット",
    game_created: "作品を作った", fork_created: "フォークした",
    revision: "版を作った", published: "公開した"
  }[.] // .;
  .[] | [.at_jst, (.kind | kind_ja), (.game_id // "-"),
         ((.detail // "") | gsub("[\r\n\t]+"; " ⏎ "))] | join("\t")
' <<<"$EVENTS" || { echo "[trial-timeline] 出来事を整形できません。" >&2; exit 2; }
echo
echo "TRIAL_TIMELINE_PASS"
exit 0
