#!/usr/bin/env bash
# trial-timeline-selftest.sh — scripts/trial-timeline.sh を既知の行で確かめる（#972）
#
# 使い捨ての手元 D1（--persist-to）へマイグレーションを当て、試用者 1 人ぶんの行を入れて、
# 出来事の並びと種類・取り違えやすい境目を見る。本番にもネットワークにも触れない。
#
# 見ること:
#   - 時刻の順に並び、同じ秒は「登録 → 呼び出し → 作品 → 版 → 公開」の順になる
#   - 新規とフォーク、生成とチャット、成功と失敗を取り違えない
#   - 版は seq 2 以上だけを出す（seq 1 は初回生成で、作品の行と重なる）
#   - **ほかの利用者の行が混ざらない**
#   - **改名で手放したハンドルでは引けない**（いま使っている名前だけ）
#   - 引数の誤り・見つからないハンドルは 2 で落ちる
#
# 終了コード: 0 = TRIAL_TIMELINE_SELFTEST_PASS / 1 = 失敗
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)" || exit 1
ROOT="$(dirname "$HERE")"
cd "$ROOT" || exit 1

failed=0

##
# 2 つの値が等しいことを確かめる。違えば失敗を記録する。
#
# @param $1 見ているものの名前
# @param $2 期待する値
# @param $3 実際の値
##
expect_eq() {
  if [[ "$2" == "$3" ]]; then
    echo "  ok   $1"
  else
    echo "  FAIL $1" >&2
    echo "       期待: $2" >&2
    echo "       実際: $3" >&2
    failed=1
  fi
}

SANDBOX="$(mktemp -d "${TMPDIR:-/tmp}/trial-timeline-selftest.XXXXXX")" || exit 1
trap 'rm -rf "$SANDBOX"' EXIT

d1() {
  CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV=false \
    npx wrangler d1 execute DB --local --persist-to "$SANDBOX" "$@"
}

echo "[trial-timeline-selftest] 使い捨ての D1 を作る"
if ! CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV=false \
     npx wrangler d1 migrations apply DB --local --persist-to "$SANDBOX" >/dev/null 2>&1; then
  echo "  FAIL 使い捨ての D1 へマイグレーションを適用できません" >&2
  echo "TRIAL_TIMELINE_SELFTEST_FAIL"
  exit 1
fi

# 試用者 t1（いまのハンドル trial_now、旧名 trial_old）と、無関係の利用者 o1。
# 時刻: 100 登録 / 200 生成（作品 g1）/ 200 作品 g1（同じ秒。呼び出しが先）/
#       300 失敗した生成 / 400 チャット / 500 g1 の版 2 / 600 g1 を公開 /
#       700 o1 の作品 og1 をフォークした g2（生成失敗）。o1 の行は 150 と 650 に置く。
if ! d1 --command "
insert into users (id, google_sub, email, display_name, created_at) values
  ('t1','ts1','t1@example.invalid','T1',100), ('o1','os1','o1@example.invalid','O1',50);
insert into handles (handle, user_id, claimed_at, released_at) values
  ('trial_old','t1',100,150), ('trial_now','t1',150,null), ('other_one','o1',50,null);
insert into games (id, author_id, parent_id, status, title, go_version, fork_count, created_at, published_at, generation_state) values
  ('g1','t1',null,'published','ねこジャンプ','1.23',0,200,600,'ready'),
  ('og1','o1',null,'published','よそのゲーム','1.23',1,150,150,'ready'),
  ('g2','t1','og1','draft','よそのゲームの改造','1.23',0,700,null,'failed');
insert into generations (id, game_id, user_id, prompt, model, input_tokens, output_tokens,
  cache_creation_input_tokens, cache_read_input_tokens, cost_jpy, succeeded, created_at, kind) values
  ('n1','g1','t1','ねこが跳ぶゲーム','m',1,1,0,0,1,1,200,'generation'),
  ('n2',null,'t1','壊れる指示','m',1,1,0,0,1,0,300,'generation'),
  ('n3','g1','t1','どう直せばいい？','m',1,1,0,0,1,1,400,'chat'),
  ('n4','og1','o1','よその指示','m',1,1,0,0,1,1,650,'generation');
insert into game_revisions (game_id, seq, source_key, wasm_key, go_version, prompt, created_at) values
  ('g1',1,'s','w','1.23',null,200), ('g1',2,'s','w','1.23','もっと速く',500);
" >/dev/null 2>&1; then
  echo "  FAIL 既知の行を入れられません" >&2
  echo "TRIAL_TIMELINE_SELFTEST_FAIL"
  exit 1
fi

echo "[trial-timeline-selftest] 出来事の並びと種類"
JSON="$(bash scripts/trial-timeline.sh --persist-to "$SANDBOX" --handle trial_now --format json 2>/dev/null)"
expect_eq "JSON を返す" "object" "$(jq -r 'type' <<<"$JSON" 2>/dev/null)"
expect_eq "種類の並び（同じ秒は呼び出しが先・版は seq 2 だけ）" \
  "registered,generation,game_created,generation,chat,revision,published,fork_created" \
  "$(jq -r '[.events[].kind] | join(",")' <<<"$JSON" 2>/dev/null)"
expect_eq "時刻の並び" "100,200,200,300,400,500,600,700" \
  "$(jq -r '[.events[].at] | map(tostring) | join(",")' <<<"$JSON" 2>/dev/null)"
expect_eq "JST に直した時刻" "1970-01-01 09:01:40" "$(jq -r '.events[0].atJst' <<<"$JSON" 2>/dev/null)"
expect_eq "失敗した生成に印が付く" "[失敗] 壊れる指示" \
  "$(jq -r '.events[] | select(.at == 300) | .detail' <<<"$JSON" 2>/dev/null)"
expect_eq "フォークに親と生成失敗の印が付く" "よそのゲームの改造（親: og1） [生成失敗]" \
  "$(jq -r '.events[] | select(.kind == "fork_created") | .detail' <<<"$JSON" 2>/dev/null)"
expect_eq "版は番号だけ（お題は生成の行に出る）" "版 2" \
  "$(jq -r '.events[] | select(.kind == "revision") | .detail' <<<"$JSON" 2>/dev/null)"
expect_eq "ほかの利用者の行が混ざらない" "0" \
  "$(jq -r '[.events[] | select(.detail == "よその指示" or .gameId == "og1")] | length' <<<"$JSON" 2>/dev/null)"
expect_eq "出せないものを明示する" "2" "$(jq -r '.unavailable | length' <<<"$JSON" 2>/dev/null)"

echo "[trial-timeline-selftest] 表の形"
TABLE="$(bash scripts/trial-timeline.sh --persist-to "$SANDBOX" --handle trial_now 2>/dev/null)"
expect_eq "合図の行で終わる" "TRIAL_TIMELINE_PASS" "$(printf '%s\n' "$TABLE" | tail -1)"
expect_eq "種類を日本語で出す" "フォークした" \
  "$(printf '%s\n' "$TABLE" | awk -F '\t' '$3 == "g2" { print $2 }')"

echo "[trial-timeline-selftest] 引けないもの・引数の誤り"
bash scripts/trial-timeline.sh --persist-to "$SANDBOX" --handle trial_old >/dev/null 2>&1
expect_eq "改名で手放したハンドルでは引けない（2）" "2" "$?"
bash scripts/trial-timeline.sh --persist-to "$SANDBOX" --handle nobody_here >/dev/null 2>&1
expect_eq "見つからないハンドルは 2" "2" "$?"
bash scripts/trial-timeline.sh --persist-to "$SANDBOX" --handle "x'; --" >/dev/null 2>&1
expect_eq "形の違うハンドルは 2" "2" "$?"
bash scripts/trial-timeline.sh --persist-to "$SANDBOX" --handle >/dev/null 2>&1
expect_eq "値の無い --handle は 2（無限ループにしない）" "2" "$?"
bash scripts/trial-timeline.sh --remote --persist-to "$SANDBOX" --handle trial_now >/dev/null 2>&1
expect_eq "--remote と --persist-to の併用は 2" "2" "$?"

if [[ "$failed" -ne 0 ]]; then
  echo "TRIAL_TIMELINE_SELFTEST_FAIL"
  exit 1
fi
echo "TRIAL_TIMELINE_SELFTEST_PASS"
exit 0
