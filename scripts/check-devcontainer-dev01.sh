#!/usr/bin/env bash
# check-devcontainer-dev01.sh — dev01 で devcontainer を立てるための分岐を、非対話で確かめる（#802）。
#
# 見るのは 3 つ。
#
#   1. **compose.yaml を展開した結果**（`docker compose config`。文字列の grep ではない。デーモンは要らない）。
#      - DEVCONTAINER_HOST の既定が空のままであること（Mac の既存挙動を壊さない）と、dev01 の値が
#        `.devcontainer/.env` からも環境変数からも届くこと。**`--env-file` を必ず渡す**——dev01 の
#        ワークスペースには `.devcontainer/.env`（DEVCONTAINER_HOST=dev01）が在るので、渡さないと
#        dev01 の上で「既定が空」の確認が赤くなる。
#      - **AppArmor を外す宣言（`security_opt: apparmor=unconfined`）が残っていること**（#874）。
#        消えると dev01 で codex の bwrap が `docker-default` の `deny mount` に当たり、第二意見が取れなくなる。
#        **効くかどうか**（作り直した dev01 のコンテナで bwrap が通るか）はここでは見ない（docs/local-dev.md 7.4）。
#      - ベースのイメージが浮動のタグでないこと（#802。理由は compose.yaml の image の上）。
#   2. **vscode の UID の付け替えを devcontainer CLI に任せていること**（#879）。devcontainer.json に
#      `"updateRemoteUserUID": true` が在ること。false にすると dev01（uid=1001）でワークスペースへ書き込めない。
#   3. **scripts/install-cloudflared.sh が dev01 の上では何もしないこと。**
#      DEVCONTAINER_HOST=dev01 のとき ~/.ssh/config を作らず、導入（curl / sudo）にも進まない。
#      それ以外（未設定・空・別の値）では従来どおり入口を書く。HOME を一時ディレクトリへ向け、
#      PATH は必要な道具だけを置いた一時ディレクトリにする（本物の cloudflared が入っている
#      環境でも「導入に進まない」ことを確かめられるように）。
#
# **確かめないこと。** CLI が実際に uid を 1001 へ付け替えるか、dev01 のワークスペースへ書き込めるかは、
# ネットワークと dev01 の実機が要るので、ここでは見ない（#879 で実測した。docs/local-dev.md 7.4 で利用者が確かめる）。
#
# 終了コード: 0 = DEVCONTAINER_DEV01_PASS / 1 = 期待と食い違った・道具が無い
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(dirname "$HERE")"
COMPOSE="$ROOT/.devcontainer/compose.yaml"
DEVCONTAINER_JSON="$ROOT/.devcontainer/devcontainer.json"
INSTALL="$ROOT/scripts/install-cloudflared.sh"
BASH_BIN="$(command -v bash)"

fail=0
n=0
ng() { echo "[devcontainer-dev01] FAIL: $*" >&2; fail=1; }

if ! { command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; }; then
  echo "[devcontainer-dev01] docker compose が見つかりません。compose.yaml を展開できないので検査が成立しません。" >&2
  exit 1
fi
command -v jq >/dev/null 2>&1 || {
  echo "[devcontainer-dev01] jq が見つかりません。" >&2
  exit 1
}

WORK="$(mktemp -d "${TMPDIR:-/tmp}/check-devcontainer-dev01.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

# ── 1. compose.yaml を展開した結果 ────────────────────────────────────────────
# compose_json <env-file> [VAR=値 ...] → 展開した compose を JSON で出す。
# 呼び出し元の DEVCONTAINER_HOST は env -u で必ず外す（dev01 のシェルに export されていても結果を変えない）。
compose_json() {
  local envfile="$1"
  shift
  env -u DEVCONTAINER_HOST "$@" docker compose -f "$COMPOSE" --env-file "$envfile" config --format json
}

expect_host() {
  local name="$1" want="$2" got
  shift 2
  n=$((n + 1))
  got="$(compose_json "$@" | jq -r '.services.app.environment.DEVCONTAINER_HOST // ""')" ||
    { ng "$name: docker compose config が失敗しました"; return; }
  [[ "$got" == "$want" ]] || ng "$name: want '$want' got '$got'"
}

: >"$WORK/empty.env"
printf 'DEVCONTAINER_HOST=dev01\n' >"$WORK/dev01.env"

expect_host "既定ではホストの宣言は空" "" "$WORK/empty.env"
expect_host ".env から dev01 の値が届く" "dev01" "$WORK/dev01.env"
expect_host "環境変数からも届く" "dev01" "$WORK/empty.env" DEVCONTAINER_HOST=dev01

# AppArmor を外す宣言（#874）。dev01 の値を渡しても渡さなくても同じであること。
for envfile in "$WORK/empty.env" "$WORK/dev01.env"; do
  n=$((n + 1))
  got="$(compose_json "$envfile" | jq -r '(.services.app.security_opt // []) | join(" ")')" ||
    { ng "security_opt: docker compose config が失敗しました"; continue; }
  [[ " $got " == *" apparmor=unconfined "* ]] \
    || ng "security_opt に apparmor=unconfined がありません（$(basename "$envfile")。dev01 で codex の bwrap が動かなくなります。#874）: '$got'"
done

# ベースが浮動のタグ（ubuntu / latest / タグ無し）でないこと。`base:ubuntu` は 26.04 へ移り、
# google-cloud-cli の feature が apt-key の不在で落ちた（#802。理由は compose.yaml の image の上）。
# **ビルドの段を足していないこと**も見る。足すとイメージは build の結果になり、image の固定を見ても意味が無い。
n=$((n + 1))
base="$(compose_json "$WORK/empty.env" | jq -r '.services.app.image // ""')"
has_build="$(compose_json "$WORK/empty.env" | jq -r 'if .services.app.build then "yes" else "no" end')"
tag="${base##*/}"
if [[ -z "$base" || "$tag" != *:* || "${tag##*:}" == ubuntu || "${tag##*:}" == latest ]]; then
  ng "compose.yaml のベースが浮動のタグです: '${base}'（noble のように版の名前で固定する）"
fi
[[ "$has_build" == no ]] || ng "compose.yaml に build があります（ベースの固定を見る場所が image でなくなります。#879 で外した）"

# ── 2. UID の付け替えを CLI に任せていること（#879）──────────────────────────
# devcontainer.json は JSONC（注記あり）なので jq では読まない。キーの行を見る。
n=$((n + 1))
grep -qE '^[[:space:]]*"updateRemoteUserUID":[[:space:]]*true,?[[:space:]]*$' "$DEVCONTAINER_JSON" ||
  ng "devcontainer.json に \"updateRemoteUserUID\": true がありません（dev01 でワークスペースへ書き込めなくなります。#879）"

# ── 3. install-cloudflared.sh の dev01 分岐 ─────────────────────────────────
# PATH は必要な道具だけにする。curl / sudo は呼ばれたら記録して失敗する仕込み
# （導入へ進んだことを見逃さないため）。cloudflared は導入済みの状態を表す仕込み。
MINI="$WORK/minibin"
mkdir -p "$MINI"
for tool in grep cat mkdir chmod; do
  ln -s "$(command -v "$tool")" "$MINI/$tool"
done
for cmd in curl sudo; do
  # shellcheck disable=SC2016  # $* と $FAKE_LOG は仕込みが動くときに展開させる
  printf '#!%s\necho "%s $*" >>"$FAKE_LOG"\nexit 1\n' "$BASH_BIN" "$cmd" >"$MINI/$cmd"
done
chmod +x "$MINI/curl" "$MINI/sudo"
WITH_CF="$WORK/with-cf"
mkdir -p "$WITH_CF"
printf '#!%s\necho "cloudflared version 0.0.0 (fake)"\n' "$BASH_BIN" >"$WITH_CF/cloudflared"
chmod +x "$WITH_CF/cloudflared"

# run_install <HOME> <cloudflared の有無: with|without> [VAR=値 ...] → 終了コードを返す
run_install() {
  local home="$1" cf="$2" path="$MINI"
  shift 2
  [[ "$cf" == "with" ]] && path="$WITH_CF:$MINI"
  env -i HOME="$home" PATH="$path" FAKE_LOG="$WORK/install.log" "$@" \
    "$BASH_BIN" "$INSTALL" >/dev/null 2>&1
}

has_entry() { [[ -f "$1/.ssh/config" ]] && grep -qE '^Host dev01-ssh\.ojos\.jp dev01$' "$1/.ssh/config"; }

# expect_install <名前> <cloudflared: with|without> <期待: entry|none> <期待する終了コード> [VAR=値 ...]
expect_install() {
  local name="$1" cf="$2" want="$3" want_rc="$4" home got_rc=0
  shift 4
  n=$((n + 1))
  home="$WORK/home-$n"
  mkdir -p "$home"
  : >"$WORK/install.log"
  run_install "$home" "$cf" "$@" || got_rc=$?
  [[ "$got_rc" == "$want_rc" ]] || ng "$name: want rc=$want_rc got rc=$got_rc"
  case "$want" in
    entry) has_entry "$home" || ng "$name: ~/.ssh/config に dev01 の入口がありません" ;;
    none)
      [[ ! -e "$home/.ssh/config" ]] || ng "$name: ~/.ssh/config を書いています（自己参照の入口）"
      [[ ! -s "$WORK/install.log" ]] || ng "$name: 導入へ進んでいます: $(tr '\n' '|' <"$WORK/install.log")"
      ;;
  esac
}

expect_install "未設定（Mac）なら入口を書く" with entry 0
expect_install "空（Mac の compose が渡す値）なら入口を書く" with entry 0 DEVCONTAINER_HOST=
expect_install "別のホストなら入口を書く" with entry 0 DEVCONTAINER_HOST=mac
expect_install "dev01 なら何も書かない" with none 0 DEVCONTAINER_HOST=dev01
expect_install "dev01 なら cloudflared が無くても導入へ進まない" without none 0 DEVCONTAINER_HOST=dev01
# 仕込みの確かさ: 同じ PATH で dev01 でなければ導入へ進む（curl が呼ばれて落ちる）。
# これが通らないなら、上の「導入へ進まない」は仕込みのせいで緑になっている。
n=$((n + 1))
: >"$WORK/install.log"
mkdir -p "$WORK/home-probe"
if run_install "$WORK/home-probe" without; then
  ng "仕込みの確かさ: cloudflared が無いのに導入が成功しました"
elif ! grep -q '^curl ' "$WORK/install.log"; then
  ng "仕込みの確かさ: 導入の経路で curl が呼ばれていません（仕込みが導入を観測できていない）"
fi

# 既存の入口は二度書かない（従来の挙動。分岐を足しても崩れていないこと）。
n=$((n + 1))
mkdir -p "$WORK/home-twice"
run_install "$WORK/home-twice" with || true
run_install "$WORK/home-twice" with || true
count="$(grep -c '^Host dev01-ssh\.ojos\.jp dev01$' "$WORK/home-twice/.ssh/config" || true)"
[[ "$count" == "1" ]] || ng "2 回回すと入口が ${count} 個になりました（1 個であるべき）"

if [[ "$fail" -ne 0 ]]; then
  echo "[devcontainer-dev01] 期待と食い違いました（上記）" >&2
  exit 1
fi
echo "[devcontainer-dev01] ${n} 件すべて期待どおり"
echo "DEVCONTAINER_DEV01_PASS"
