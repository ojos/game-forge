#!/usr/bin/env bash
# check-devcontainer-dev01.sh — dev01 で devcontainer を立てるための分岐を、非対話で確かめる（#802）。
#
# 見るのは 3 つ（と 1 の付け足し）。
#
#   1. **UID/GID の既定が 1000 のままであること**（Mac の既存挙動を壊さない）と、dev01 の値
#      （1001）が `.devcontainer/.env` からも環境変数からもビルド引数へ届くこと。
#      `docker compose config` で compose.yaml を実際に展開して読む（文字列の grep ではない）。
#      デーモンは要らない。**`--env-file` を必ず渡す**——dev01 のワークスペースには
#      `.devcontainer/.env`（DEVCONTAINER_UID=1001）が在るので、渡さないと dev01 の上で
#      「既定が 1000」の確認が赤くなる。
#   1b. **AppArmor を外す宣言（`security_opt: apparmor=unconfined`）が展開後に残っていること**（#874）。
#      消えると dev01 で codex の bwrap が `docker-default` の `deny mount` に当たり、第二意見が取れなくなる。
#      **効くかどうか**（作り直した dev01 のコンテナで bwrap が通るか）はここでは見ない（docs/local-dev.md 7.4）。
#   2. **付け替えの判定**（.devcontainer/remap-vscode-user.sh）。既定の値では何も呼ばず、
#      違う値のときだけ groupmod / usermod / chown を呼び、番号の衝突と数値でない引数を落とす。
#      id / getent / groupmod / usermod / chown は仕込みに差し替える。仕込みの id は
#      ベースイメージの実際の値（vscode = 1000:1000）を返すだけで、本物がしないことはさせない。
#   3. **scripts/install-cloudflared.sh が dev01 の上では何もしないこと。**
#      DEVCONTAINER_HOST=dev01 のとき ~/.ssh/config を作らず、導入（curl / sudo）にも進まない。
#      それ以外（未設定・空・別の値）では従来どおり入口を書く。HOME を一時ディレクトリへ向け、
#      PATH は必要な道具だけを置いた一時ディレクトリにする（本物の cloudflared が入っている
#      環境でも「導入に進まない」ことを確かめられるように）。
#
# **確かめないこと。** イメージを実際にビルドして uid が 1001 になるか、dev01 のワークスペースへ
# 書き込めるかは、ネットワークと dev01 の実機が要るので、ここでは見ない（#802 の acceptance で
# 利用者の実機で確認する）。
#
# 終了コード: 0 = DEVCONTAINER_DEV01_PASS / 1 = 期待と食い違った・道具が無い
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(dirname "$HERE")"
COMPOSE="$ROOT/.devcontainer/compose.yaml"
DOCKERFILE="$ROOT/.devcontainer/Dockerfile"
REMAP="$ROOT/.devcontainer/remap-vscode-user.sh"
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

# ── 1. compose.yaml のビルド引数 ─────────────────────────────────────────────
# compose_args <env-file> [VAR=値 ...] → "UID GID HOST" を 1 行で出す。
# 呼び出し元の DEVCONTAINER_* は env -u で必ず外す（dev01 のシェルに export されていても結果を変えない）。
compose_args() {
  local envfile="$1"
  shift
  env -u DEVCONTAINER_UID -u DEVCONTAINER_GID -u DEVCONTAINER_HOST "$@" \
    docker compose -f "$COMPOSE" --env-file "$envfile" config --format json |
    jq -r '[.services.app.build.args.USER_UID, .services.app.build.args.USER_GID, (.services.app.environment.DEVCONTAINER_HOST // "")] | join(" ")'
}

expect_compose() {
  local name="$1" want="$2" got
  shift 2
  n=$((n + 1))
  got="$(compose_args "$@")" || { ng "$name: docker compose config が失敗しました"; return; }
  # 末尾の空白は DEVCONTAINER_HOST が空のとき。比べやすいように剥がす。
  got="${got% }"
  [[ "$got" == "$want" ]] || ng "$name: want '$want' got '$got'"
}

: >"$WORK/empty.env"
printf 'DEVCONTAINER_UID=1001\nDEVCONTAINER_GID=1001\nDEVCONTAINER_HOST=dev01\n' >"$WORK/dev01.env"

expect_compose "既定は 1000:1000 でホストの宣言は空" "1000 1000" "$WORK/empty.env"
expect_compose ".env から dev01 の値が届く" "1001 1001 dev01" "$WORK/dev01.env"
expect_compose "環境変数からも届く" "1001 1001 dev01" "$WORK/empty.env" \
  DEVCONTAINER_UID=1001 DEVCONTAINER_GID=1001 DEVCONTAINER_HOST=dev01
expect_compose "UID だけ渡せば GID は既定のまま" "1001 1000" "$WORK/empty.env" DEVCONTAINER_UID=1001

# 1b. AppArmor を外す宣言（#874）。dev01 の値を渡しても渡さなくても同じであること。
for envfile in "$WORK/empty.env" "$WORK/dev01.env"; do
  n=$((n + 1))
  got="$(env -u DEVCONTAINER_UID -u DEVCONTAINER_GID -u DEVCONTAINER_HOST \
    docker compose -f "$COMPOSE" --env-file "$envfile" config --format json |
    jq -r '(.services.app.security_opt // []) | join(" ")')" || { ng "security_opt: docker compose config が失敗しました"; continue; }
  [[ " $got " == *" apparmor=unconfined "* ]] \
    || ng "security_opt に apparmor=unconfined がありません（$(basename "$envfile")。dev01 で codex の bwrap が動かなくなります。#874）: '$got'"
done

# ビルド引数が Dockerfile に ARG として宣言され、付け替えへ渡っていること。
# 名前がずれると引数は黙って捨てられ、付け替えが空の値で呼ばれる。
n=$((n + 1))
for arg in USER_UID USER_GID; do
  grep -qE "^ARG ${arg}\$" "$DOCKERFILE" || ng "Dockerfile に 'ARG ${arg}' がありません（既定値を持たせない。写しを作らないため）"
done
grep -qE '^RUN bash /tmp/remap-vscode-user\.sh "\$\{USER_UID\}" "\$\{USER_GID\}"' "$DOCKERFILE" ||
  ng "Dockerfile が remap-vscode-user.sh へ USER_UID / USER_GID を渡していません"

# ベースが浮動のタグ（ubuntu / latest / タグ無し）でないこと。`base:ubuntu` は 26.04 へ移り、
# google-cloud-cli の feature が apt-key の不在で落ちた（#802。理由は Dockerfile の FROM の上）。
n=$((n + 1))
base="$(awk '$1 == "FROM" { print $2; exit }' "$DOCKERFILE")"
tag="${base##*/}"
if [[ "$tag" != *:* || "${tag##*:}" == ubuntu || "${tag##*:}" == latest ]]; then
  ng "Dockerfile のベースが浮動のタグです: '${base}'（noble のように版の名前で固定する）"
fi

# ── 2. 付け替えの判定 ─────────────────────────────────────────────────────────
FAKE="$WORK/fakebin"
mkdir -p "$FAKE"
cat >"$FAKE/id" <<'EOF'
#!/usr/bin/env bash
case "$1" in
  -u) echo "${FAKE_CUR_UID:-1000}" ;;
  -g) echo "${FAKE_CUR_GID:-1000}" ;;
  *) exit 2 ;;
esac
EOF
cat >"$FAKE/getent" <<'EOF'
#!/usr/bin/env bash
# 仕込みの表: FAKE_TAKEN_GROUP / FAKE_TAKEN_USER に番号があれば、その番号は別の名前が使っている。
if [[ "$1" == "group" && "$2" == "${FAKE_TAKEN_GROUP:-}" ]]; then echo "other:x:$2:"; exit 0; fi
if [[ "$1" == "passwd" && "$2" == "${FAKE_TAKEN_USER:-}" ]]; then echo "other:x:$2:$2::/home/other:/bin/sh"; exit 0; fi
exit 2
EOF
for cmd in groupmod usermod chown; do
  # shellcheck disable=SC2016  # $* と $FAKE_LOG は仕込みが動くときに展開させる
  printf '#!/usr/bin/env bash\necho "%s $*" >>"$FAKE_LOG"\n' "$cmd" >"$FAKE/$cmd"
done
chmod +x "$FAKE"/*

# expect_remap <名前> <期待する終了コード> <期待する呼び出し（| 区切り）> <UID> <GID> [VAR=値 ...]
expect_remap() {
  local name="$1" want_rc="$2" want_calls="$3" uid="$4" gid="$5" got_rc=0 got_calls
  shift 5
  n=$((n + 1))
  : >"$WORK/remap.log"
  env "$@" FAKE_LOG="$WORK/remap.log" PATH="$FAKE:$PATH" \
    "$BASH_BIN" "$REMAP" "$uid" "$gid" >/dev/null 2>&1 || got_rc=$?
  got_calls="$(tr '\n' '|' <"$WORK/remap.log")"
  got_calls="${got_calls%|}"
  if [[ "$got_rc" != "$want_rc" || "$got_calls" != "$want_calls" ]]; then
    ng "$name: want rc=$want_rc calls='$want_calls' got rc=$got_rc calls='$got_calls'"
  fi
}

expect_remap "既定の 1000:1000 では何も呼ばない" 0 "" 1000 1000
expect_remap "dev01 の 1001:1001 へ付け替える" 0 \
  "groupmod --gid 1001 vscode|usermod --uid 1001 --gid 1001 vscode|chown -R 1001:1001 /home/vscode" 1001 1001
expect_remap "UID だけ違えば groupmod は呼ばない" 0 \
  "usermod --uid 1001 --gid 1000 vscode|chown -R 1001:1000 /home/vscode" 1001 1000
expect_remap "GID が使用中なら何も変えずに落ちる" 1 "" 1001 1001 FAKE_TAKEN_GROUP=1001
expect_remap "UID が使用中なら何も変えずに落ちる" 1 "" 1001 1001 FAKE_TAKEN_USER=1001
expect_remap "UID が空なら落ちる（ARG の渡し忘れ）" 1 "" "" 1000
expect_remap "数値でなければ落ちる" 1 "" 1001x 1001

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
