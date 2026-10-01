#!/usr/bin/env bash
# selftest.sh — dev（dev.sh）の自己試験。非対話で、本物の devcontainer / docker / tmux / aws /
# systemctl を 1 つも呼ばない。
#
# 偽の道具を一時ディレクトリに置き、PATH をその偽物と最小限の道具（sed など）だけにして
# dev.sh を回す。偽物は呼ばれた引数を 1 行ずつ記録し、試験はその記録を突き合わせる。
#
# ## 偽物を本物に合わせたところ（本物がしないことはさせない）
#
# - devcontainer（CLI 0.89.0 の dist を読んで合わせた）
#   - `up`: 結果を JSON 1 行で標準出力へ、経過を標準エラーへ出す。失敗の JSON
#     （outcome=error）でも 1 で抜ける。devcontainer.json が無いワークスペースは
#     `Dev container config (...) not found.` で失敗する
#   - `exec`: **最初のオプションでない語で引数の解析を止め**（halt-at-non-option）、それより
#     後をそのままコマンドに渡す。動いているコンテナが無ければ `Dev container not found.` で 1
# - docker: `ps -a` / `--filter label=k=v`（値の完全一致）/ `--format '{{.ID}} {{.State}}'`、
#   `wait <id>`（止まるまで待ち、終了コードを 1 行出して 0 で抜ける。無い ID は 1）。
#   **知らない形の呼び出しは黙って通さずに落とす**（dev.sh が想定外の形で呼んだら赤にする）
# - tmux: `has-session -t =<名前>`（無ければ 1）と `new-session -A -s <名前>`
# - aws: `sso login` はデバイスコードの案内を出して 0。`sts get-caller-identity` は
#   FAKE_AWS_VALID=1 のとき 0、それ以外は期限切れの文言で 255（本物の終了コード）
# - systemctl: `--user is-active <unit>` は状態の語を 1 行出し、active で 0、それ以外で 3
#
# 使い方:
#   bash tools/devhost/selftest.sh             同じディレクトリの dev.sh を試す
#   DEV_BIN=<path> bash tools/devhost/selftest.sh   別の dev.sh を試す（変異を当てるとき）
#   DEV_UNIT=<path> bash tools/devhost/selftest.sh  別のユニットを試す（同上）
#
# 終了コード: 0 = DEVHOST_SELFTEST_PASS / 1 = 期待と食い違った
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEV="${DEV_BIN:-$HERE/dev.sh}"
BASH_BIN="$(command -v bash)"

WORK="$(mktemp -d "${TMPDIR:-/tmp}/devhost-selftest.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

FAKEBIN="$WORK/fakebin"
TOOLBIN="$WORK/toolbin"
mkdir -p "$FAKEBIN" "$TOOLBIN" "$WORK/home"

# dev.sh と偽物が使う道具だけを置く。本物の docker などが入った環境でも PATH から見えない。
for t in sed tail head cat rm mkdir grep tr env; do
  p="$(command -v "$t")" || { echo "[devhost-selftest] $t が見つかりません" >&2; exit 1; }
  ln -s "$p" "$TOOLBIN/$t"
done

# ── 偽物 ──────────────────────────────────────────────────────────────────────
# 記録の書式: 道具の名前に続けて、引数を 1 つずつ [ ] で囲む（空白を含む引数を取り違えない）。
cat >"$FAKEBIN/_log" <<'EOF'
log_call() {
  local line="$1"
  shift
  local a
  for a in "$@"; do line="$line [$a]"; done
  printf '%s\n' "$line" >>"$FAKE_LOG"
}
# コンテナの状態: 1 行 1 つで「ワークスペースのパス<TAB>ID<TAB>状態」。
STATE_FILE="$FAKE_STATE/containers"
touch_state() { [[ -f "$STATE_FILE" ]] || : >"$STATE_FILE"; }
EOF

cat >"$FAKEBIN/devcontainer" <<EOF
#!$BASH_BIN
set -euo pipefail
. "$FAKEBIN/_log"
EOF
cat >>"$FAKEBIN/devcontainer" <<'EOF'
log_call devcontainer "$@"
touch_state
sub="${1:-}"
shift || true
wf=""
# オプションは --名前 値 の対で読む。最初のオプションでない語で止まる（exec の halt-at-non-option）。
while [[ $# -gt 0 && "$1" == --* ]]; do
  case "$1" in
    --workspace-folder) wf="$2"; shift 2 ;;
    *) echo "fake devcontainer: この試験が想定していないオプションです: $1" >&2; exit 2 ;;
  esac
done
[[ -n "$wf" ]] || { echo "fake devcontainer: --workspace-folder がありません" >&2; exit 2; }
if [[ ! -f "$wf/.devcontainer/devcontainer.json" && ! -f "$wf/.devcontainer.json" ]]; then
  echo "Dev container config ($wf/.devcontainer/devcontainer.json) not found." >&2
  [[ "$sub" == "up" ]] && printf '{"outcome":"error","message":"Dev container config (%s/.devcontainer/devcontainer.json) not found.","description":"Dev container config (%s/.devcontainer/devcontainer.json) not found."}\n' "$wf" "$wf"
  exit 1
fi
find_row() { grep -F "$wf	" "$STATE_FILE" | head -n 1 || true; }
case "$sub" in
  up)
    [[ $# -eq 0 ]] || { echo "fake devcontainer: up に余分な引数があります: $*" >&2; exit 2; }
    if [[ "${FAKE_UP_FAIL:-0}" == "1" ]]; then
      echo "[fake] Error: docker compose up が失敗しました" >&2
      printf '{"outcome":"error","message":"Command failed: docker compose up -d","description":"An error occurred starting Docker Compose up."}\n'
      exit 1
    fi
    row="$(find_row)"
    if [[ -n "$row" ]]; then
      id="$(printf '%s\n' "$row" | cut -f 2)"
      grep -vF "$wf	" "$STATE_FILE" >"$STATE_FILE.new" || true
      mv "$STATE_FILE.new" "$STATE_FILE"
    else
      id="$(printf '%s' "$wf" | cksum | cut -d ' ' -f 1)"
      id="c0ffee${id}"
    fi
    printf '%s\t%s\trunning\n' "$wf" "$id" >>"$STATE_FILE"
    echo "[fake] Start: Run: docker compose up -d" >&2
    printf '{"outcome":"success","containerId":"%s","composeProjectName":"x_devcontainer","remoteUser":"vscode","remoteWorkspaceFolder":"/workspaces/x"}\n' "$id"
    ;;
  exec)
    [[ $# -gt 0 ]] || { echo "Not enough non-option arguments: got 0, need at least 1" >&2; exit 1; }
    row="$(find_row)"
    if [[ -z "$row" || "$(printf '%s\n' "$row" | cut -f 3)" != "running" ]]; then
      echo "Dev container not found." >&2
      exit 1
    fi
    exec "$@"
    ;;
  *) echo "fake devcontainer: この試験が想定していないサブコマンドです: $sub" >&2; exit 2 ;;
esac
EOF

cat >"$FAKEBIN/docker" <<EOF
#!$BASH_BIN
set -euo pipefail
. "$FAKEBIN/_log"
EOF
cat >>"$FAKEBIN/docker" <<'EOF'
log_call docker "$@"
touch_state
sub="${1:-}"
shift || true
case "$sub" in
  ps)
    all=0 filter="" format=""
    while [[ $# -gt 0 ]]; do
      case "$1" in
        -a) all=1; shift ;;
        --filter) filter="$2"; shift 2 ;;
        --format) format="$2"; shift 2 ;;
        *) echo "fake docker: この試験が想定していない ps の引数です: $1" >&2; exit 2 ;;
      esac
    done
    [[ "$filter" == label=devcontainer.local_folder=* ]] || { echo "fake docker: 想定外の filter: $filter" >&2; exit 2; }
    [[ "$format" == '{{.ID}} {{.State}}' ]] || { echo "fake docker: 想定外の format: $format" >&2; exit 2; }
    want="${filter#label=devcontainer.local_folder=}"
    while IFS='	' read -r path id state; do
      [[ "$path" == "$want" ]] || continue
      [[ "$all" == 1 || "$state" == "running" ]] || continue
      printf '%s %s\n' "$id" "$state"
    done <"$STATE_FILE"
    ;;
  wait)
    [[ $# -eq 1 ]] || { echo "fake docker: wait の引数は 1 つだけを想定しています" >&2; exit 2; }
    if ! grep -qF "	$1	" "$STATE_FILE"; then
      echo "Error response from daemon: No such container: $1" >&2
      exit 1
    fi
    # 止まったことにする（本物はここで止まるまで待つ）。
    sed "s/	$1	running\$/	$1	exited/" "$STATE_FILE" >"$STATE_FILE.new"
    mv "$STATE_FILE.new" "$STATE_FILE"
    echo "${FAKE_WAIT_CODE:-137}"
    ;;
  *) echo "fake docker: この試験が想定していないサブコマンドです: $sub" >&2; exit 2 ;;
esac
EOF

cat >"$FAKEBIN/tmux" <<EOF
#!$BASH_BIN
set -euo pipefail
. "$FAKEBIN/_log"
EOF
cat >>"$FAKEBIN/tmux" <<'EOF'
log_call tmux "$@"
case "${1:-}" in
  has-session)
    [[ "${2:-}" == "-t" ]] || exit 2
    name="${3#=}"
    for s in ${FAKE_TMUX_SESSIONS:-}; do [[ "$s" == "$name" ]] && exit 0; done
    echo "can't find session: $name" >&2
    exit 1
    ;;
  new-session) exit 0 ;;
  *) echo "fake tmux: この試験が想定していない呼び出しです: $*" >&2; exit 2 ;;
esac
EOF

cat >"$FAKEBIN/aws" <<EOF
#!$BASH_BIN
set -euo pipefail
. "$FAKEBIN/_log"
EOF
cat >>"$FAKEBIN/aws" <<'EOF'
log_call aws "$@"
case "${1:-} ${2:-}" in
  "sso login")
    printf 'Browser will not be automatically opened.\nPlease visit the following URL:\n\nhttps://device.sso.example.amazonaws.com/\n\nThen enter the code:\n\nABCD-EFGH\n'
    ;;
  "sts get-caller-identity")
    if [[ "${FAKE_AWS_VALID:-0}" == "1" ]]; then
      printf '{"UserId":"X","Account":"000000000000","Arn":"arn:aws:sts::000000000000:assumed-role/x/y"}\n'
    else
      echo "Error when retrieving token from sso: Token has expired and refresh failed" >&2
      exit 255
    fi
    ;;
  *) echo "fake aws: この試験が想定していない呼び出しです: $*" >&2; exit 2 ;;
esac
EOF

cat >"$FAKEBIN/systemctl" <<EOF
#!$BASH_BIN
set -euo pipefail
. "$FAKEBIN/_log"
EOF
cat >>"$FAKEBIN/systemctl" <<'EOF'
log_call systemctl "$@"
[[ "${1:-}" == "--user" && "${2:-}" == "is-active" && $# -eq 3 ]] || { echo "fake systemctl: 想定外の呼び出し: $*" >&2; exit 2; }
for u in ${FAKE_ACTIVE_UNITS:-}; do
  [[ "$u" == "$3" ]] && { echo active; exit 0; }
done
echo inactive
exit 3
EOF
chmod +x "$FAKEBIN/devcontainer" "$FAKEBIN/docker" "$FAKEBIN/tmux" "$FAKEBIN/aws" "$FAKEBIN/systemctl"
for t in cut cksum mv; do
  p="$(command -v "$t")" || { echo "[devhost-selftest] $t が見つかりません" >&2; exit 1; }
  ln -s "$p" "$TOOLBIN/$t"
done

# ── 仕込み ────────────────────────────────────────────────────────────────────
PROJ="$WORK/projects"
mkdir -p "$PROJ/alpha/.devcontainer" "$PROJ/beta"
echo '{}' >"$PROJ/alpha/.devcontainer/devcontainer.json"
echo '{}' >"$PROJ/beta/.devcontainer.json"
CONF="$WORK/conf/projects"
mkdir -p "$WORK/conf"
cat >"$CONF" <<EOF
# 試験の設定
alpha  $PROJ/alpha   aws_sso_session=sess-a aws_profile=prof-a   # 行末のコメント

beta   $PROJ/beta    tmux_session=work
EOF

# ── 回し方 ────────────────────────────────────────────────────────────────────
fail=0
n=0
ng() { echo "[devhost-selftest] FAIL: $*" >&2; fail=1; }

OUT="$WORK/out" ERR="$WORK/err" LOG="$WORK/calls"
STATE="$WORK/state"

reset_state() {
  rm -rf "$STATE"
  mkdir -p "$STATE"
  : >"$STATE/containers"
}

# run <期待する終了コード> <試験の名前> -- [VAR=値 ...] -- dev の引数 ...
# 呼び出しの記録は毎回空にしてから回す（コンテナの状態は reset_state までは持ち越す）。
run() {
  local want="$1" name="$2" code=0
  shift 2
  [[ "$1" == "--" ]] && shift
  local envs=()
  while [[ $# -gt 0 && "$1" != "--" ]]; do envs+=("$1"); shift; done
  [[ $# -gt 0 ]] && shift
  : >"$LOG"
  n=$((n + 1))
  CUR="$name"
  env -i HOME="$WORK/home" PATH="$FAKEBIN:$TOOLBIN" \
    DEV_PROJECTS_FILE="${T_CONF:-$CONF}" FAKE_LOG="$LOG" FAKE_STATE="$STATE" \
    ${envs[@]+"${envs[@]}"} \
    "$BASH_BIN" "$DEV" "$@" >"$OUT" 2>"$ERR" </dev/null || code=$?
  if [[ "$code" != "$want" ]]; then
    ng "$name: 終了コード want $want got $code"
    sed 's/^/    stderr: /' "$ERR" >&2
  fi
}

# 記録がこの並びと完全に一致すること。
expect_calls() {
  local want got
  want="$(printf '%s\n' "$@")"
  got="$(cat "$LOG")"
  if [[ "$got" != "$want" ]]; then
    ng "$CUR: 呼び出しの記録が違います"
    printf '    want:\n%s\n    got:\n%s\n' "$want" "$got" >&2
  fi
}

expect_no_calls() {
  if [[ -s "$LOG" ]]; then
    ng "$CUR: 下の道具を呼ばないはずが呼んでいます"
    sed 's/^/    /' "$LOG" >&2
  fi
}

expect_err() {
  grep -qF -- "$1" "$ERR" || { ng "$CUR: 標準エラーに「$1」がありません"; sed 's/^/    stderr: /' "$ERR" >&2; }
}

expect_out_line() {
  grep -qE -- "$1" "$OUT" || { ng "$CUR: 標準出力に /$1/ の行がありません"; sed 's/^/    stdout: /' "$OUT" >&2; }
}

A="$PROJ/alpha"
B="$PROJ/beta"

# ── 1. 設定ファイル ───────────────────────────────────────────────────────────
reset_state
T_CONF="$WORK/conf/none" run 2 "設定ファイルが無い" -- -- ls
expect_err "設定ファイルがありません: $WORK/conf/none"
expect_no_calls

bad() {
  local name="$1" body="$2" msg="$3"
  printf '%s\n' "$body" >"$WORK/conf/bad"
  T_CONF="$WORK/conf/bad" run 2 "壊れた設定: $name" -- -- up alpha
  expect_err "$msg"
  expect_no_calls
}
bad "パスが無い" "alpha" "$WORK/conf/bad:1: 「名前 絶対パス」の 2 つが要ります"
bad "相対パス" "alpha projects/alpha" "$WORK/conf/bad:1: パスは絶対パスで書きます"
bad "チルダ" "alpha ~/alpha" "$WORK/conf/bad:1: パスは絶対パスで書きます"
bad "知らないキー" "alpha $A aws_sso=x" "$WORK/conf/bad:1: 知らないキーです"
bad "キー=値でない" "alpha $A extra" "$WORK/conf/bad:1: 3 つ目以降は キー=値 で書きます"
bad "空の値" "alpha $A aws_profile=" "$WORK/conf/bad:1: 値が空です"
bad "名前の文字" "al/pha $A" "$WORK/conf/bad:1: 名前に使えるのは"
bad "重複" "$(printf '# c\nalpha %s\nalpha %s' "$A" "$B")" "$WORK/conf/bad:3: 名前が重複しています: alpha"
bad "空" "# だけ" "プロジェクトが 1 つもありません"

# CRLF で保存した設定でも読める（行末の CR がパスに混ざらない）。
printf 'alpha %s\r\n' "$A" >"$WORK/conf/crlf"
reset_state
T_CONF="$WORK/conf/crlf" run 0 "CRLF の設定" -- -- up alpha
expect_calls "devcontainer [up] [--workspace-folder] [$A]"

# ── 2. 未登録のプロジェクトを拒む ─────────────────────────────────────────────
for sub in up attach supervise; do
  reset_state
  run 2 "未登録: $sub" -- -- "$sub" gamma
  expect_err "登録されていないプロジェクトです: gamma（登録済み: alpha beta）"
  expect_no_calls
done
run 2 "未登録: auth aws" -- -- auth aws gamma --sso-session s
expect_err "登録されていないプロジェクトです: gamma"
expect_no_calls

# ── 3. up ─────────────────────────────────────────────────────────────────────
reset_state
run 0 "up alpha" -- -- up alpha
expect_calls "devcontainer [up] [--workspace-folder] [$A]"
expect_out_line '"outcome":"success"'
run 0 "up beta（.devcontainer.json の形）" -- -- up beta
expect_calls "devcontainer [up] [--workspace-folder] [$B]"
run 1 "up が失敗したら 1" -- FAKE_UP_FAIL=1 -- up alpha
expect_calls "devcontainer [up] [--workspace-folder] [$A]"
printf 'ghost %s/ghost\n' "$PROJ" >"$WORK/conf/ghost"
T_CONF="$WORK/conf/ghost" run 1 "ディレクトリが無いプロジェクト" -- -- up ghost
expect_err "プロジェクトのディレクトリがありません: $PROJ/ghost"
expect_no_calls
run 2 "up の引数が多い" -- -- up alpha beta
expect_no_calls

# ── 4. attach ─────────────────────────────────────────────────────────────────
reset_state
run 1 "attach: 止まっていたら入らない" -- -- attach alpha
expect_err "alpha のコンテナが動いていません。dev up alpha"
expect_calls "docker [ps] [-a] [--filter] [label=devcontainer.local_folder=$A] [--format] [{{.ID}} {{.State}}]"
run 0 "up してから" -- -- up alpha
run 0 "attach alpha" -- -- attach alpha
expect_calls \
  "docker [ps] [-a] [--filter] [label=devcontainer.local_folder=$A] [--format] [{{.ID}} {{.State}}]" \
  "devcontainer [exec] [--workspace-folder] [$A] [tmux] [new-session] [-A] [-s] [main]" \
  "tmux [new-session] [-A] [-s] [main]"
run 0 "up beta" -- -- up beta
run 0 "attach beta（tmux_session=work）" -- -- attach beta
expect_calls \
  "docker [ps] [-a] [--filter] [label=devcontainer.local_folder=$B] [--format] [{{.ID}} {{.State}}]" \
  "devcontainer [exec] [--workspace-folder] [$B] [tmux] [new-session] [-A] [-s] [work]" \
  "tmux [new-session] [-A] [-s] [work]"

# ── 5. auth aws ───────────────────────────────────────────────────────────────
run 0 "auth aws alpha（設定のセッション名）" -- -- auth aws alpha
expect_calls \
  "docker [ps] [-a] [--filter] [label=devcontainer.local_folder=$A] [--format] [{{.ID}} {{.State}}]" \
  "devcontainer [exec] [--workspace-folder] [$A] [aws] [sso] [login] [--sso-session] [sess-a] [--no-browser] [--use-device-code]" \
  "aws [sso] [login] [--sso-session] [sess-a] [--no-browser] [--use-device-code]"
expect_out_line 'ABCD-EFGH'
run 0 "auth aws alpha --sso-session で上書き" -- -- auth aws alpha --sso-session other
expect_calls \
  "docker [ps] [-a] [--filter] [label=devcontainer.local_folder=$A] [--format] [{{.ID}} {{.State}}]" \
  "devcontainer [exec] [--workspace-folder] [$A] [aws] [sso] [login] [--sso-session] [other] [--no-browser] [--use-device-code]" \
  "aws [sso] [login] [--sso-session] [other] [--no-browser] [--use-device-code]"
run 2 "auth aws beta（セッション名が無い）" -- -- auth aws beta
expect_err "SSO のセッション名がありません"
expect_no_calls
run 2 "auth gcp は受け付けない" -- -- auth gcp alpha
expect_no_calls
run 2 "auth の知らない引数" -- -- auth aws alpha --profile x
expect_no_calls
run 2 "--sso-session の値が無い" -- -- auth aws alpha --sso-session
expect_no_calls
reset_state
run 1 "auth: 止まっていたら認証しない" -- -- auth aws alpha
expect_err "alpha のコンテナが動いていません"
expect_calls "docker [ps] [-a] [--filter] [label=devcontainer.local_folder=$A] [--format] [{{.ID}} {{.State}}]"

# ── 6. ls ─────────────────────────────────────────────────────────────────────
reset_state
run 0 "up alpha（ls の仕込み）" -- -- up alpha
run 0 "ls" -- FAKE_ACTIVE_UNITS=dev-up@alpha.service FAKE_TMUX_SESSIONS=main FAKE_AWS_VALID=1 -- ls
expect_out_line '^NAME +CONTAINER +UNIT +TMUX +AWS$'
expect_out_line '^alpha +running +active +main +ok$'
expect_out_line '^beta +none +inactive +- +-$'
expect_calls \
  "docker [ps] [-a] [--filter] [label=devcontainer.local_folder=$A] [--format] [{{.ID}} {{.State}}]" \
  "systemctl [--user] [is-active] [dev-up@alpha.service]" \
  "devcontainer [exec] [--workspace-folder] [$A] [tmux] [has-session] [-t] [=main]" \
  "tmux [has-session] [-t] [=main]" \
  "devcontainer [exec] [--workspace-folder] [$A] [aws] [sts] [get-caller-identity] [--profile] [prof-a]" \
  "aws [sts] [get-caller-identity] [--profile] [prof-a]" \
  "docker [ps] [-a] [--filter] [label=devcontainer.local_folder=$B] [--format] [{{.ID}} {{.State}}]" \
  "systemctl [--user] [is-active] [dev-up@beta.service]"
run 0 "ls（tmux 無し・認証切れ）" -- -- ls
expect_out_line '^alpha +running +inactive +none +expired$'
# systemctl の無いホスト（ユニットを使わない）では UNIT を - にする。
rm "$FAKEBIN/systemctl"
run 0 "ls（systemctl が無い）" -- -- ls
expect_out_line '^alpha +running +- +none +expired$'
run 2 "ls に余分な引数" -- -- ls alpha

# ── 7. supervise（ユニットの ExecStart）─────────────────────────────────────
reset_state
run 1 "supervise: 起こして、止まったら 0 以外で抜ける" -- FAKE_WAIT_CODE=0 -- supervise alpha
id_a="$(grep -F "$A	" "$STATE/containers" | cut -f 2)"
expect_calls \
  "devcontainer [up] [--workspace-folder] [$A]" \
  "docker [wait] [$id_a]"
expect_err "コンテナ $id_a が止まりました（終了コード 0）"
grep -qF "$A	$id_a	exited" "$STATE/containers" || ng "supervise: 待った後のコンテナが exited になっていません"
run 1 "supervise: 2 回目（止まったコンテナを同じ ID で起こし直す）" -- -- supervise alpha
expect_calls \
  "devcontainer [up] [--workspace-folder] [$A]" \
  "docker [wait] [$id_a]"
expect_err "（終了コード 137）"
run 1 "supervise: up が失敗したら待たない" -- FAKE_UP_FAIL=1 -- supervise alpha
expect_calls "devcontainer [up] [--workspace-folder] [$A]"
expect_err "devcontainer up が失敗しました"

# ── 8. 使い方 ─────────────────────────────────────────────────────────────────
run 2 "引数なし" -- --
expect_no_calls
run 2 "知らないサブコマンド" -- -- start alpha
expect_no_calls

# ── 9. ユニット（dev-up@.service）の要の行 ───────────────────────────────────
# systemd はこの環境に無いので読み込みは試せない。崩すと「戻らない」につながる行だけを綴りで見る。
UNIT="${DEV_UNIT:-$HERE/dev-up@.service}"
CUR="ユニット"
unit_has() { grep -qxF -- "$1" "$UNIT" || ng "ユニットに「$1」の行がありません（$2）"; }
unit_has 'ExecStart=%h/.local/bin/dev supervise %i' "起こして止まるまで待つ口。%I は - を / へ戻すので使わない"
unit_has 'Restart=always' "止まった理由を問わず起こし直す"
unit_has 'StartLimitIntervalSec=0' "起動の直後に Docker が遅れても諦めない"
unit_has 'WantedBy=default.target' "ユーザーのマネージャの起動（linger で起動時）に付く"
if grep -qE '^[^#]*%I' "$UNIT"; then ng "ユニットが %I を使っています（名前の - が / に化ける）"; fi

if [[ "$fail" -ne 0 ]]; then
  echo "DEVHOST_SELFTEST_FAIL" >&2
  exit 1
fi
echo "[devhost-selftest] $n 件の呼び出しを確かめました"
echo "DEVHOST_SELFTEST_PASS"
