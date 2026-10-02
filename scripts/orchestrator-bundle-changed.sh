#!/usr/bin/env bash
# orchestrator-bundle-changed.sh — オーケストレータの束が、この差分で変わったか
#
# Worker を配る直前の関門（#241）を起動するかどうかを決める。**起動しなければ
# AWS を 1 度も読まない**（外部の可用性を配備の前提条件へ持ち込まないため。
# .github/project-ai-rules.md「外部層を単一入口へ含めない理由」）。
#
# ## なぜファイル名の一覧で決めないのか（#263）
#
# 以前はここが `wrangler.toml` と `src/generation-models.ts` の 2 本を見ていた。
# 9/01 の事故（登録簿を知らない Lambda が Worker のペイロードを拒否し、本番の
# 生成が 12 分止まった）から採った一覧である。
#
# **2026-09-02 に、その一覧では捕まらない同じ形を踏んだ。** #258 が
# `src/orchestrator/payload.ts` を変えてペイロードの版 3 を足したが、一覧に無いので
# 関門は 1 度も起動せず、**送り側だけが版 3 を知っている窓が約 25 分開いた**
# （実害は 0 件だった。窓の間の生成が 0 行だったという偶然による）。
#
# **一覧を広げても同じことが起きる。** 束には `src/orchestrator/**` のほかに
# `src/bedrock.ts` や `src/generate.ts` が入っており、**次に増えた依存を書き忘れた日に
# 同じ窓がまた開く。** 関門が知りたいのは「動いている Lambda が、これから配る Worker の
# 話し相手として古いか」であって、それはファイル名では決まらない。
#
# **だから束そのものを 2 回作って比べる。** 一覧を維持する場所が消える。
# esbuild は 15ms で、`CodeSha256` は決定的である（配備済みとの比較に既に使っている値）。
#
# ## 比較元: 直前のコミットではなく「本番の Pages に居るコミット」（deploy ジョブの呼び方。#925）
#
# **直前のコミット（`HEAD^`）と比べると、照合が 1 度も行われない順序が 2 つある**（#903 の
# 第二意見がチャットの関門で見つけ、#925 でこちらにも入れた。止まるのが生成なので、チャットより重い）。
#
#   - 束を変えたコミット A の配備が、直後のマージ B に譲って何もしなかった（`deploy-head`。#427）。
#     B の配備は A と B を比べて「変わっていない」と読む
#   - A の配備がこの関門で落ちたまま、配り直す前に無関係な B がマージされた。B の配備は同じく
#     「変わっていない」と読み、**Lambda は古いまま Worker だけが先へ進む**（9/01 と同じ形）
#
# どちらも、比べたいのが「直前のコミット」ではなく**「最後にこの関門を通って配ったコミット」**
# だから起きる。deploy ジョブは、この関門の**後ろ**で Pages を `--commit-hash` 付きで配る
# （verify.yml。#95）ので、**本番の Pages に居るコミットは、最後にこの関門を通ったコミットである。**
# `--base-from-pages <Cloudflare の Pages プロジェクトの応答 JSON>` を渡すと、そのコミットを比較元にする。
#
#   - 応答を読めない・形が違う（`success` が true でない）  → **判定できない（終了コード 1）**
#   - 本番の配備が無い・コミットが記録されていない・汚れた作業ツリーから配られた・
#     そのコミットを取得できない                          → **ORCHESTRATOR_BUNDLE_CHANGED**
#     （比較元を決められないので、実物の `CodeSha256` との照合へ回す。終了コード 1 にすると、
#     手で配った Pages の記録が欠けた日から CI の配備が 1 本も通らなくなる——照合へ回せば、
#     束が同じなら通り、違えば配り直しを求める。どちらも正しい）
#
# ## チャットの判定（scripts/chat-bundle-changed.sh）とは写しで揃える（#925）
#
# 判定の部分は `scripts/chat-bundle-changed.sh` と**同じ作りの写し**である。違うのは束ねる
# スクリプト・zip の場所・合図の綴り・ログの接頭辞だけ。**scripts/lib/ へ共有していない**理由:
#
#   - チャットの自己検査は判定と束ねるスクリプトの 2 本だけを使い捨てのリポジトリへ写して回す。
#     共有にすると、自己検査の作りまで動かすことになる（#925 の範囲の外。チャットの関門は変えない）
#   - 2 本は**別の関数を守る別の関門**である（仕様 5.16）。共有部分の 1 つの誤りが、両方の関門を
#     同時に黙って外す形を作らない
#
# 写しのずれは、**2 本の自己検査が同じ観点を終了コードで確かめる**ことで捕まえる
# （scripts/orchestrator-bundle-changed-selftest.sh と scripts/chat-bundle-changed-selftest.sh）。
# 片方の判定を直したら、もう片方にも同じ直しが要るかを見ること。
#
# ## 使い方
#
#   bash scripts/orchestrator-bundle-changed.sh [<比較元。既定は HEAD^>]
#   bash scripts/orchestrator-bundle-changed.sh --base-from-pages <応答 JSON のファイル>
#
# 標準出力の最終行:
#   ORCHESTRATOR_BUNDLE_CHANGED    — 束が変わった（か、比較元を決められない）。関門を起動すること
#   ORCHESTRATOR_BUNDLE_UNCHANGED  — 変わっていない。AWS を読まなくてよい
#
# 終了コード: 0 = 判定できた / 1 = 判定できない（作業ツリーが汚れている・比較元を解決できない・
# 束を作れない・Pages の応答を読めない等）
#
# **判定できないことを「変わっていない」に倒さない。** 倒すと、判定できない日に
# 関門が黙って外れる。
#
# 自己検査: scripts/orchestrator-bundle-changed-selftest.sh（scripts/acceptance.sh が回す）
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$HERE"

##
# 比較元を決められないので、実物との照合へ回す（上の「比較元」の節）。
#
# @param $1 理由
##
changed_without_base() {
  echo "[orchestrator-bundle-changed] $1 比較元を決められないので、変わったものとして扱います（照合へ回します）。"
  echo "ORCHESTRATOR_BUNDLE_CHANGED"
  exit 0
}

if [ "${1:-}" = "--base-from-pages" ]; then
  PAGES_JSON="${2:-}"
  if [ -z "$PAGES_JSON" ] || [ ! -r "$PAGES_JSON" ]; then
    echo "[orchestrator-bundle-changed] Pages の応答のファイルを読めません: ${PAGES_JSON:-（未指定）}" >&2
    exit 1
  fi
  command -v jq >/dev/null 2>&1 || {
    echo "[orchestrator-bundle-changed] jq がありません（Pages の応答を読むのに要ります）。" >&2
    exit 1
  }
  if ! jq -e '.success == true' "$PAGES_JSON" >/dev/null 2>&1; then
    echo "[orchestrator-bundle-changed] Pages の応答が成功を示していません（読めない・形が違う）: $PAGES_JSON" >&2
    exit 1
  fi
  if ! jq -e '.result.canonical_deployment != null' "$PAGES_JSON" >/dev/null; then
    changed_without_base "本番の Pages に配備がありません。"
  fi
  pages_commit="$(jq -r '.result.canonical_deployment.deployment_trigger.metadata.commit_hash // ""' "$PAGES_JSON")"
  pages_dirty="$(jq -r '.result.canonical_deployment.deployment_trigger.metadata.commit_dirty // false' "$PAGES_JSON")"
  if ! printf '%s\n' "$pages_commit" | grep -Eq '^[0-9a-f]{40}$'; then
    changed_without_base "本番の Pages の配備にコミットが記録されていません（${pages_commit:-空}）。"
  fi
  if [ "$pages_dirty" = "true" ]; then
    changed_without_base "本番の Pages は汚れた作業ツリーから配られています（${pages_commit}）。"
  fi
  # **ツリーだけあれば比べられる**ので、浅く 1 コミットだけ取る（deploy ジョブの checkout は 2 コミット）。
  if ! git cat-file -e "${pages_commit}^{commit}" 2>/dev/null; then
    git fetch --quiet --no-tags --depth=1 origin "$pages_commit" >/dev/null 2>&1 || true
  fi
  if ! git cat-file -e "${pages_commit}^{commit}" 2>/dev/null; then
    changed_without_base "本番の Pages に居るコミット（${pages_commit}）を取得できません。"
  fi
  echo "[orchestrator-bundle-changed] 比較元は本番の Pages に居るコミットです: ${pages_commit}"
  BASE_REF="$pages_commit"
else
  BASE_REF="${1:-HEAD^}"
fi

if ! git rev-parse --verify --quiet "$BASE_REF" >/dev/null; then
  echo "[orchestrator-bundle-changed] 比較元を解決できません: $BASE_REF" >&2
  exit 1
fi

# **作業ツリーを一時的に比較元へ戻すので、汚れていたら断る。** 戻す前の状態を
# 復元できないまま終わると、利用者の変更を失う。
if [ -n "$(git status --porcelain)" ]; then
  echo "[orchestrator-bundle-changed] 作業ツリーが汚れています。commit か stash をしてから実行してください。" >&2
  exit 1
fi

# **依存（`package.json` / `package-lock.json`）が変わったら、束を作らずに CHANGED とする。**
# 下の比較は比較元の側も**いまの `node_modules`** で束ねるので、`aws4fetch`（束に入る）や
# esbuild（束を作る）の版だけが変わった差分では、両方が同じ版で束ねられて UNCHANGED に化ける。
# 依存の差分は広めに拾う（束に効かない更新でも AWS を 1 回読むだけで、照合は実物の値で行うので
# 束が同じなら関門は通る）。**逆向きの取りこぼし（依存の更新で本番だけ古いまま）は拾えない
# 誤りなので、広いほうへ倒す。**
dep_rc=0
git diff --quiet "$BASE_REF" HEAD -- package.json package-lock.json || dep_rc=$?
if [ "$dep_rc" -eq 1 ]; then
  echo "[orchestrator-bundle-changed] 依存（package.json / package-lock.json）が変わりました。束は作り比べず、変わったものとして扱います。"
  echo "ORCHESTRATOR_BUNDLE_CHANGED"
  exit 0
elif [ "$dep_rc" -ne 0 ]; then
  echo "[orchestrator-bundle-changed] 依存の差分を読めません（git diff の終了コード ${dep_rc}）。" >&2
  exit 1
fi

# **束を作れなければ失敗で返す。** `$(...)` の中では `set -e` が引き継がれないので、
# 明示的に受ける（受けないと、壊れた束の古い zip や空の値を比べてしまう）。
bundle_sha() {
  bash scripts/bundle-orchestrator.sh >/dev/null || return 1
  [ -f dist/orchestrator.zip ] || return 1
  openssl dgst -sha256 -binary dist/orchestrator.zip | base64
}

# **比較元にあって HEAD に無いファイル**を先に数えておく。`git checkout <ref> -- .` は
# それらを復元するが、`git checkout HEAD -- .` は**HEAD に無いものを消さない**ので、
# 数えずに戻すと残骸として作業ツリーに残る。
#
# **`--no-renames` を外さない。** 既定の `git diff` は改名を検出し、改名の旧パスは `D` ではなく
# `R` として出る。旧パスがここから漏れると、比較元から復元されたまま残骸として作業ツリーに残る。
EXTRA_FILES="$(git diff --no-renames --name-only --diff-filter=D "$BASE_REF" HEAD)"

# **必ず戻す。** 途中で落ちても比較元のまま放置しない。
restore() {
  # 索引を先に戻す。`git checkout <ref> -- .` は索引も書き換えるので、作業ツリーだけ
  # 戻しても復元されたファイルが staged のまま残る。
  git reset --quiet HEAD -- . >/dev/null 2>&1 || true
  git checkout --quiet HEAD -- . >/dev/null 2>&1 || true
  if [ -n "$EXTRA_FILES" ]; then
    printf '%s\n' "$EXTRA_FILES" | while IFS= read -r f; do
      [ -n "$f" ] && rm -f -- "$f"
    done
  fi
  return 0
}
trap restore EXIT

head_sha="$(bundle_sha)"

# **`git checkout <ref> -- .` は HEAD を動かさない。** 追跡外（node_modules）は
# そのまま残るので、比較元でも束を作れる。
#
# **この差分で足されたファイルは消えずに残るが、束には入らない。** esbuild は
# `src/orchestrator/handler.ts` からの import を辿るだけで、比較元の handler.ts は
# 新しいファイルを import しないためである。
git checkout --quiet "$BASE_REF" -- .
base_sha="$(bundle_sha)"

restore
trap - EXIT

echo "[orchestrator-bundle-changed] $BASE_REF: ${base_sha}"
echo "[orchestrator-bundle-changed] HEAD:      ${head_sha}"

if [ "$head_sha" != "$base_sha" ]; then
  echo "ORCHESTRATOR_BUNDLE_CHANGED"
else
  echo "ORCHESTRATOR_BUNDLE_UNCHANGED"
fi
