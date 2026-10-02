#!/usr/bin/env bash
# dev-auth-aws.selftest.sh — dev-auth-aws（dev-auth-aws.sh）の自己試験。非対話で、本物の
# devcontainer / docker / aws を 1 つも呼ばない。
#
# 偽の道具を一時ディレクトリに置き、PATH をその偽物と最小限の道具（sed など）だけにして
# dev-auth-aws.sh を回す。偽物は呼ばれた引数を 1 行ずつ記録し、試験はその記録を突き合わせる。
# 判定はすべて終了コードと呼び出しの記録で行う。
#
# ## 偽物を本物に合わせたところ（本物がしないことはさせない）
#
# - devcontainer（CLI 0.89.0 の `exec`）: **最初のオプションでない語で引数の解析を止め**
#   （halt-at-non-option）、それより後をそのままコマンドに渡す。動いているコンテナが無ければ
#   `Dev container not found.` で 1。`exec` 以外のサブコマンドは呼ばれない想定なので落とす
# - docker: `ps -a` / `--filter label=devcontainer.local_folder=<パス>`（値の完全一致）/
#   `--format '{{.ID}} {{.State}}'` だけを受ける。**知らない形の呼び出しは黙って通さずに落とす**
# - aws: `sso login` はデバイスコードの案内を出して 0（FAKE_AWS_FAIL=1 のときは 255）。
#   それ以外の呼び出しは落とす
#
# 使い方:
#   bash tools/devhost/dev-auth-aws.selftest.sh                        同じディレクトリの dev-auth-aws.sh を試す
#   DEV_AUTH_AWS_BIN=<path> bash tools/devhost/dev-auth-aws.selftest.sh   別のものを試す（変異を当てるとき）
#
# 終了コード: 0 = DEV_AUTH_AWS_SELFTEST_PASS / 1 = 期待と食い違った
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TARGET="${DEV_AUTH_AWS_BIN:-$HERE/dev-auth-aws.sh}"
BASH_BIN="$(command -v bash)"

WORK="$(mktemp -d "${TMPDIR:-/tmp}/dev-auth-aws-selftest.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

FAKEBIN="$WORK/fakebin"
TOOLBIN="$WORK/toolbin"
mkdir -p "$FAKEBIN" "$TOOLBIN" "$WORK/home"

# 対象と偽物が使う道具だけを置く。本物の docker などが入った環境でも PATH から見えない。
for t in sed cat grep; do
  p="$(command -v "$t")" || { echo "[dev-auth-aws-selftest] $t が見つかりません" >&2; exit 1; }
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
# 動いているコンテナ: 1 行 1 つで「ワークスペースのパス<TAB>ID<TAB>状態」。
STATE_FILE="$FAKE_STATE"
EOF

cat >"$FAKEBIN/devcontainer" <<EOF
#!$BASH_BIN
set -euo pipefail
. "$FAKEBIN/_log"
EOF
cat >>"$FAKEBIN/devcontainer" <<'EOF'
log_call devcontainer "$@"
sub="${1:-}"
shift || true
[[ "$sub" == "exec" ]] || { echo "fake devcontainer: この試験が想定していないサブコマンドです: $sub" >&2; exit 2; }
wf=""
while [[ $# -gt 0 && "$1" == --* ]]; do
  case "$1" in
    --workspace-folder) wf="$2"; shift 2 ;;
    *) echo "fake devcontainer: この試験が想定していないオプションです: $1" >&2; exit 2 ;;
  esac
done
[[ -n "$wf" ]] || { echo "fake devcontainer: --workspace-folder がありません" >&2; exit 2; }
[[ $# -gt 0 ]] || { echo "Not enough non-option arguments: got 0, need at least 1" >&2; exit 1; }
state=""
while IFS='	' read -r path id st; do
  [[ "$path" == "$wf" ]] && { state="$st"; break; }
done <"$STATE_FILE"
if [[ "$state" != "running" ]]; then
  echo "Dev container not found." >&2
  exit 1
fi
exec "$@"
EOF

cat >"$FAKEBIN/docker" <<EOF
#!$BASH_BIN
set -euo pipefail
. "$FAKEBIN/_log"
EOF
cat >>"$FAKEBIN/docker" <<'EOF'
log_call docker "$@"
[[ "${1:-}" == "ps" ]] || { echo "fake docker: この試験が想定していないサブコマンドです: ${1:-}" >&2; exit 2; }
shift
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
    if [[ "${FAKE_AWS_FAIL:-0}" == "1" ]]; then
      echo "Error when retrieving token from sso: Token has expired and refresh failed" >&2
      exit 255
    fi
    printf 'Browser will not be automatically opened.\nPlease visit the following URL:\n\nhttps://device.sso.example.amazonaws.com/\n\nThen enter the code:\n\nABCD-EFGH\n'
    ;;
  *) echo "fake aws: この試験が想定していない呼び出しです: $*" >&2; exit 2 ;;
esac
EOF
chmod +x "$FAKEBIN/devcontainer" "$FAKEBIN/docker" "$FAKEBIN/aws"

# ── 仕込み ────────────────────────────────────────────────────────────────────
PROJ="$WORK/projects"
A="$PROJ/alpha"
B="$PROJ/beta"
mkdir -p "$A" "$B" "$WORK/conf"
CONF="$WORK/conf/aws-sso"
cat >"$CONF" <<EOF
# 試験の設定
alpha  $A   sess-a   # 行末のコメント

beta   $B/  sess-b
EOF
STATE="$WORK/containers"

fail=0
n=0
ng() { echo "[dev-auth-aws-selftest] FAIL: $*" >&2; fail=1; }

OUT="$WORK/out" ERR="$WORK/err" LOG="$WORK/calls"

# containers <パス> <状態> ...: 偽の docker が見るコンテナの一覧を置き直す。
containers() {
  : >"$STATE"
  local i=1
  while [[ $# -ge 2 ]]; do
    printf '%s\tc0ffee%s\t%s\n' "$1" "$i" "$2" >>"$STATE"
    i=$((i + 1))
    shift 2
  done
}

# run <期待する終了コード> <試験の名前> -- [VAR=値 ...] -- 引数 ...
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
    DEV_AUTH_AWS_FILE="${T_CONF:-$CONF}" FAKE_LOG="$LOG" FAKE_STATE="$STATE" \
    ${envs[@]+"${envs[@]}"} \
    "$BASH_BIN" "$TARGET" "$@" >"$OUT" 2>"$ERR" </dev/null || code=$?
  if [[ "$code" != "$want" ]]; then
    ng "$name: 終了コード want $want got $code"
    sed 's/^/    stderr: /' "$ERR" >&2
  fi
}

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

expect_out() {
  grep -qF -- "$1" "$OUT" || { ng "$CUR: 標準出力に「$1」がありません"; sed 's/^/    stdout: /' "$OUT" >&2; }
}

PS_A="docker [ps] [-a] [--filter] [label=devcontainer.local_folder=$A] [--format] [{{.ID}} {{.State}}]"
PS_B="docker [ps] [-a] [--filter] [label=devcontainer.local_folder=$B] [--format] [{{.ID}} {{.State}}]"
# expect_login <ps の記録> <パス> <セッション名>: コンテナの有無を見てから、コンテナの中で
# aws sso login を正しい引数で呼んだこと（記録がこの 3 行と完全に一致すること）。
expect_login() {
  expect_calls "$1" \
    "devcontainer [exec] [--workspace-folder] [$2] [aws] [sso] [login] [--sso-session] [$3] [--no-browser] [--use-device-code]" \
    "aws [sso] [login] [--sso-session] [$3] [--no-browser] [--use-device-code]"
}

# ── 1. コンテナの中で aws sso login を正しい引数で呼ぶ ────────────────────────
containers "$A" running "$B" running
run 0 "設定の行で入る" -- -- alpha
expect_login "$PS_A" "$A" sess-a
expect_out "ABCD-EFGH"

run 0 "--sso-session で上書き" -- -- alpha --sso-session other
expect_login "$PS_A" "$A" other

run 0 "設定のパスの末尾の / を外す" -- -- beta
expect_login "$PS_B" "$B" sess-b

T_CONF="$WORK/conf/none" run 0 "設定ファイルなしで --workspace と --sso-session" -- -- --workspace "$A/" --sso-session s1
expect_login "$PS_A" "$A" s1

# aws sso login が失敗したら、その終了コード（本物は 255）をそのまま返す（成功と取り違えない）。
run 255 "aws sso login の失敗を 0 にしない" -- FAKE_AWS_FAIL=1 -- alpha
expect_login "$PS_A" "$A" sess-a

# ── 2. コンテナが止まっていれば打たずに止まる ─────────────────────────────────
containers "$A" exited "$B" running
run 1 "止まっていたら認証しない" -- -- alpha
expect_err "コンテナが動いていません: $A"
expect_calls "$PS_A"

containers "$B" running
run 1 "コンテナが無ければ認証しない" -- -- alpha
expect_err "コンテナが動いていません: $A"
expect_calls "$PS_A"

# ── 3. 使い方と設定の誤りは何も呼ばずに 2 ────────────────────────────────────
containers "$A" running
run 2 "引数なし" -- --
expect_no_calls
run 2 "未登録の名前" -- -- gamma
expect_err "登録されていないプロジェクトです: gamma（登録済み: alpha beta。"
expect_no_calls
T_CONF="$WORK/conf/none" run 2 "設定ファイルが無い" -- -- alpha
expect_err "設定ファイルがありません: $WORK/conf/none"
expect_no_calls
run 2 "--workspace だけでセッション名が無い" -- -- --workspace "$A"
expect_err "SSO のセッション名がありません"
expect_no_calls
run 2 "相対の --workspace" -- -- --workspace projects/alpha --sso-session s
expect_no_calls
run 2 "名前と --workspace を両方" -- -- alpha --workspace "$A"
expect_no_calls
run 2 "名前が 2 つ" -- -- alpha beta
expect_no_calls
run 2 "知らない引数" -- -- alpha --profile x
expect_no_calls
run 2 "--sso-session の値が無い" -- -- alpha --sso-session
expect_no_calls

bad() {
  local name="$1" body="$2" msg="$3"
  printf '%s\n' "$body" >"$WORK/conf/bad"
  T_CONF="$WORK/conf/bad" run 2 "壊れた設定: $name" -- -- alpha
  expect_err "$msg"
  expect_no_calls
}
bad "列が足りない" "alpha $A" "$WORK/conf/bad:1: 「名前 絶対パス セッション名」の 3 つで書きます"
bad "列が多い" "alpha $A s extra" "$WORK/conf/bad:1: 「名前 絶対パス セッション名」の 3 つで書きます"
bad "相対パス" "alpha projects/alpha s" "$WORK/conf/bad:1: パスは絶対パスで書きます"
bad "チルダ" "alpha ~/alpha s" "$WORK/conf/bad:1: パスは絶対パスで書きます"

# CRLF で保存した設定でも読める（行末の CR がセッション名に混ざらない）。
printf 'alpha %s sess-a\r\n' "$A" >"$WORK/conf/crlf"
T_CONF="$WORK/conf/crlf" run 0 "CRLF の設定" -- -- alpha
expect_login "$PS_A" "$A" sess-a

T_CONF="$WORK/conf/crlf" run 1 "ワークスペースのディレクトリが無い" -- -- --workspace "$PROJ/ghost" --sso-session s
expect_err "ワークスペースのディレクトリがありません: $PROJ/ghost"
expect_no_calls

if [[ "$fail" -ne 0 ]]; then
  echo "DEV_AUTH_AWS_SELFTEST_FAIL" >&2
  exit 1
fi
echo "[dev-auth-aws-selftest] $n 件を確かめました"
echo "DEV_AUTH_AWS_SELFTEST_PASS"
