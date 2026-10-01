#!/usr/bin/env bash
# check-on-attach-gh-guidance.sh — on-attach の gh の認証の案内を確かめる（#869）
#
# gh が使えないとき、on-attach は **'gh auth login' を実行させる案内を出さない。**
# このプロジェクトは gh の認証を PAT（.env の GH_TOKEN）に揃えていて、'gh auth login' は
# OAuth トークンの上限の枠を消費し、上限に達していれば他環境の認証を 1 本失効させる
# （.github/project-ai-rules.md「GitHub 認証（gh）だけを例外にする理由」）。
#
# scripts/on-attach.sh を丸ごと動かすと git の identity の設定などの副作用があるので、
# gh の判定に使う関数の定義（gh_active_env_token_var / check_gh_auth）と定数だけを取り出し、
# 偽の gh を PATH の先頭に置いて呼ぶ。偽の gh は本物と同じく `gh auth status --active` の
# 成否を終了コードで返すだけで、出力は判定に使われない（本物の on-attach も出力を捨てている）。
#
# 終了コード: 0 = 期待どおり / 1 = 食い違い
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TARGET="$HERE/on-attach.sh"

WORK="$(mktemp -d "${TMPDIR:-/tmp}/check-on-attach-gh.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

# 関数の定義と定数だけを取り出す。取り出せなければ、試験が成立していないので落とす。
awk '
  /^GH_AUTH_TIMEOUT_SECS=/ { print; next }
  /^(gh_active_env_token_var|check_gh_auth)\(\) \{/ { f=1 }
  f { print }
  f && /^}/ { f=0 }
' "$TARGET" > "$WORK/fns.sh"
for fn in gh_active_env_token_var check_gh_auth; do
  grep -q "^${fn}() {" "$WORK/fns.sh" || { echo "[on-attach-gh] FAIL: ${fn} を取り出せませんでした" >&2; exit 1; }
done

mkdir -p "$WORK/bin"
# `gh auth status --active` の成否を FAKE_GH_AUTH_RC で返す。
cat > "$WORK/bin/gh" <<'STUB'
#!/usr/bin/env bash
exit "${FAKE_GH_AUTH_RC:-1}"
STUB
chmod +x "$WORK/bin/gh"

fail=0
n=0

# case_ <名前> <gh auth の終了コード> <GH_TOKEN の値> <期待: login を案内するか yes/no> <期待: GH_TOKEN を案内するか yes/no>
case_() {
  local name="$1" rc="$2" token="$3" want_login="$4" want_token="$5" out got_login=no got_token=no
  n=$((n + 1))
  out="$(env -u GITHUB_TOKEN GH_TOKEN="$token" FAKE_GH_AUTH_RC="$rc" PATH="$WORK/bin:$PATH" \
    bash -c ". '$WORK/fns.sh'; check_gh_auth" 2>&1 || true)"
  # 「実行してください」と促す形の案内だけを数える。「使いません」「実行しないでください」は案内ではない。
  if grep -qE "'gh auth login' を実行してください" <<<"$out"; then got_login=yes; fi
  if grep -q 'GH_TOKEN' <<<"$out"; then got_token=yes; fi
  if [[ "$got_login" != "$want_login" || "$got_token" != "$want_token" ]]; then
    echo "[on-attach-gh] FAIL: ${name}（login の案内 want=${want_login} got=${got_login} / GH_TOKEN の案内 want=${want_token} got=${got_token}）" >&2
    sed 's/^/    /' <<<"$out" >&2
    fail=1
  fi
}

case_ "未認証（GH_TOKEN 空）なら gh auth login を案内せず、GH_TOKEN を案内する" 1 "" no yes
case_ "GH_TOKEN があって通らないときも gh auth login を案内しない" 1 "github_pat_fake" no yes
case_ "GH_TOKEN で通れば、その旨だけを出す" 0 "github_pat_fake" no yes
case_ "保存済み認証で通れば、gh auth login も GH_TOKEN も案内しない" 0 "" no no

if [[ "$fail" -ne 0 ]]; then
  echo "[on-attach-gh] 期待と食い違いました（上記）" >&2
  exit 1
fi
echo "[on-attach-gh] ${n} 件すべて期待どおり"
echo "ON_ATTACH_GH_GUIDANCE_PASS"
