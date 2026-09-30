#!/usr/bin/env bash
# acceptance-remote-aws-failure-selftest.sh — 外部層の IAM インラインポリシーの検査 3 本が、
# aws の一覧取得に失敗したとき**緑にならず**、**前提の不成立の文面で**落ちることを、偽物の
# aws で確かめる（#843）。
#
# ## なぜ要るのか
#
# **3 本とも `mapfile -t x < <(aws iam list-*-policies ...)` の形で一覧を読んでいた。** プロセス
# 置換の中の aws が失敗しても mapfile は拾わない。一覧が空になり、
#
# - `edge no longer holds bedrock credentials` は「Bedrock の権限を 1 つも持たない」＝期待どおり
#   として**緑になった**（AWS の SSO が切れたままの実行で実測。統制の検査が黙って通る形）
# - 残りの 2 本は赤にはなるが、「インラインポリシーがありません」という**乖離の文面**で
#   報告した（前提の不成立と乖離を読み分けられない）
#
# **外部層は認証済みの環境で本物の AWS に対してしか回らず、本物の AWS は一覧を返す。**
# 失敗したときの形は、外部層を何度回しても 1 度も見えない。そこで、外部層の入口
# （`--only` で検査を絞る）を、PATH の先頭に置いた偽物の aws / terraform / curl で回す。
#
# ## 何を見るか
#
# - aws が認証切れで失敗する: 3 本とも赤になり、文面が「前提の不成立」で、
#   「インラインポリシーがありません」（乖離の文面）を出さない
# - aws が成功して一覧が 0 件（対照）: 2 本は乖離の文面で赤、エッジの検査は緑。
#   **失敗と 0 件を区別できていること**を、同じ偽物で逆向きから見る
# - `--only` に実在しないラベルを渡すと赤（綴りの誤りで「何も回さずに緑」にしない）
#
# **偽物は本物がしないことをしない。** 認証切れの aws は標準エラーに理由を書いて 255 で
# 終わる（AWS CLI の実際の終了コード）。0 件の aws は `--output text` で何も出さずに 0 で終わる。
#
# 使い方:
#   bash scripts/acceptance-remote-aws-failure-selftest.sh
#
# 終了コード: 0 = ACCEPTANCE_REMOTE_AWS_FAILURE_SELFTEST_PASS / 1 = どれかの場合が期待と違う
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$(dirname "$HERE")"

tmp="$(mktemp -d "${TMPDIR:-/tmp}/acceptance-remote-aws-failure-selftest.XXXXXX")"
cleanup() { rm -rf "$tmp"; }
trap cleanup EXIT

mkdir -p "$tmp/bin"

# 偽物の aws。FAKE_AWS_MODE で振る舞いを切り替える。
cat >"$tmp/bin/aws" <<'EOF'
#!/usr/bin/env bash
case "${FAKE_AWS_MODE:-expired}" in
  expired)
    echo "Error when retrieving token from sso: Token has expired and refresh failed" >&2
    exit 255
    ;;
  empty)
    # 一覧は 0 件（--output text は何も出さない）。他の呼び出しも空で成功させる。
    exit 0
    ;;
esac
echo "fake aws: unknown FAKE_AWS_MODE=${FAKE_AWS_MODE}" >&2
exit 2
EOF

# 偽物の terraform。検査が読む output だけに答える（state も認証も要らない）。
cat >"$tmp/bin/terraform" <<'EOF'
#!/usr/bin/env bash
mode="" name=""
for arg in "$@"; do
  case "$arg" in
    -raw | -json) mode="$arg" ;;
    -chdir=* | output) ;;
    *) name="$arg" ;;
  esac
done
case "$mode:$name" in
  -raw:pages_hostname) echo "game-forge.pages.dev" ;;
  -raw:bedrock_halt_policy_arn) echo "arn:aws:iam::000000000000:policy/selftest-halt" ;;
  -raw:*) echo "selftest-${name}" ;;
  -json:*) echo '["selftest:Action"]' ;;
  *)
    echo "fake terraform: unsupported: $*" >&2
    exit 2
    ;;
esac
EOF

# 偽物の curl。Pages のプロジェクトに BEDROCK_AWS_* が残っていない応答を返す
# （エッジの検査を aws の呼び出しまで進めるため）。
cat >"$tmp/bin/curl" <<'EOF'
#!/usr/bin/env bash
echo '{"success":true,"result":{"deployment_configs":{"production":{"env_vars":{}},"preview":{"env_vars":{}}}}}'
EOF

chmod +x "$tmp/bin/aws" "$tmp/bin/terraform" "$tmp/bin/curl"

readonly LABEL_INVOKER="bedrock invoker permissions are minimal"
readonly LABEL_EDGE="edge no longer holds bedrock credentials"
readonly LABEL_BUILD="build invoker permissions are minimal"
readonly PRECONDITION="前提の不成立"
readonly DRIFT="インラインポリシーがありません"

failed=0

# $1 = 名前 / $2 = FAKE_AWS_MODE / $3 = 期待する終了コード（0 か 非0 を 1 で表す）
# $4 = 出力に現れるべき語（空なら見ない） / $5 = 出力に現れてはいけない語（空なら見ない）
# $6... = --only に渡すラベル
expect() {
  local name="$1" mode="$2" want="$3" needle="$4" forbidden="$5" out got=0
  shift 5
  local -a args=()
  local label
  for label in "$@"; do
    args+=(--only "$label")
  done
  # Cloudflare の資格情報は偽の値を渡す（.env を読みに行かせず、curl も偽物）。
  out="$(PATH="$tmp/bin:$PATH" FAKE_AWS_MODE="$mode" \
    CLOUDFLARE_API_TOKEN=selftest CLOUDFLARE_ACCOUNT_ID=selftest \
    bash scripts/acceptance-remote.sh "${args[@]}" 2>&1)" || got=$?
  if [[ "$want" -eq 0 && "$got" -ne 0 ]] || [[ "$want" -ne 0 && "$got" -eq 0 ]]; then
    echo "[acceptance-remote-aws-failure-selftest] FAIL: ${name}: 終了コード ${got}（期待 ${want}）"
    printf '%s\n' "$out" | sed 's/^/    /'
    failed=1
    return
  fi
  if [[ -n "$needle" ]] && ! grep -qF -- "$needle" <<<"$out"; then
    echo "[acceptance-remote-aws-failure-selftest] FAIL: ${name}: 出力に「${needle}」がありません"
    printf '%s\n' "$out" | sed 's/^/    /'
    failed=1
    return
  fi
  if [[ -n "$forbidden" ]] && grep -qF -- "$forbidden" <<<"$out"; then
    echo "[acceptance-remote-aws-failure-selftest] FAIL: ${name}: 出力に「${forbidden}」が出ています"
    printf '%s\n' "$out" | sed 's/^/    /'
    failed=1
    return
  fi
  echo "[acceptance-remote-aws-failure-selftest] ok: ${name}"
}

# ── aws が認証切れで失敗する: どれも緑にならず、前提の不成立として読める ──────────
expect "認証切れ: ${LABEL_EDGE} が赤になる（#843 の穴）" expired 1 "$PRECONDITION" "$DRIFT" "$LABEL_EDGE"
expect "認証切れ: ${LABEL_INVOKER} が前提の不成立の文面で赤" expired 1 "$PRECONDITION" "$DRIFT" "$LABEL_INVOKER"
expect "認証切れ: ${LABEL_BUILD} が前提の不成立の文面で赤" expired 1 "$PRECONDITION" "$DRIFT" "$LABEL_BUILD"
expect "認証切れ: 3 本を一緒に回すと 3 件とも赤" expired 1 "3 件の検査が失敗しました" "" \
  "$LABEL_INVOKER" "$LABEL_EDGE" "$LABEL_BUILD"

# ── 対照: aws は成功し、一覧が 0 件。失敗とは別の読み方になる ─────────────────────
expect "0 件: ${LABEL_EDGE} は緑（Bedrock の権限を持たない）" empty 0 "" "" "$LABEL_EDGE"
expect "0 件: ${LABEL_INVOKER} は乖離の文面で赤" empty 1 "$DRIFT" "$PRECONDITION" "$LABEL_INVOKER"
expect "0 件: ${LABEL_BUILD} は乖離の文面で赤" empty 1 "$DRIFT" "$PRECONDITION" "$LABEL_BUILD"

# ── 入口: 実在しないラベルで「何も回さずに緑」にしない ─────────────────────────
expect "--only に実在しないラベルを渡すと赤" empty 1 "--only で指定した検査がありません" "" \
  "$LABEL_EDGE" "no such check (selftest)"

if [[ "$failed" -ne 0 ]]; then
  exit 1
fi
echo "ACCEPTANCE_REMOTE_AWS_FAILURE_SELFTEST_PASS"
