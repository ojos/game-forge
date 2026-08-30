#!/usr/bin/env bash
# check-aws-cli-usage.sh — スクリプトが書いた aws CLI の呼び出しが、CLI の契約に
# 合っているかを**実行せずに**確かめる（#160 / PR で本番が止まった件）。
#
# ## なぜ要るのか
#
# **scripts/deploy-orchestrator.sh は、書かれてから一度も実行できていなかった。**
# AI エージェントの実行環境は本番の AWS へ書けず、この層は「本番でしか通せない」
# ままリポジトリに入った。結果、`--publish false` という**引数の綴りの誤り 1 つ**で
# 配備が落ち、切り替え直後の本番が止まった。
#
#     aws: [ERROR]: Unknown options: false
#
# **AWS CLI の真偽値フラグは値を取らない**（`--publish` か `--no-publish`）。これは
# 実行しなくても分かる種類の誤りである。**分かる範囲は機械で見る**
# （shared-ai-rules 12 章）。
#
# ## 2 層に分かれる
#
# 1. **真偽値に値を渡していないか**（aws CLI が無くても走る。数十ミリ秒）。
#    `--flag true` / `--flag false` は、AWS CLI にはひとつも存在しない形である。
# 2. **フラグと待機子（waiter）が実在するか**（aws CLI がある環境だけ）。
#    `aws <service> <op> help` の SYNOPSIS と突き合わせる。**ネットワークも資格情報も
#    要らない**（help はローカルの文書である）。
#
# ## 何を見ないか
#
# **値は見ない。** 関数名もパスも変数で入るため、この検査は「引数の形」だけを見る。
# **API が実際に成功するか**（権限・存在・状態）は外部層
# （scripts/acceptance-remote.sh）と本番でしか分からない。
#
# ## 対象
#
# 既定は**配備スクリプト**である。理由は「他の経路で一度も実行されないから」で、
# scripts/acceptance-remote.sh や scripts/build-time-report.sh の呼び出しは、
# 外部層を回すたびに実物の AWS に対して実行され、そこで綴りごと検証される。
# `CHECK_AWS_ALL=1` を付けると scripts/ 配下すべてを見る。
#
# 使い方:
#   bash scripts/check-aws-cli-usage.sh
#   CHECK_AWS_ALL=1 bash scripts/check-aws-cli-usage.sh
#
# 終了コード: 0 = AWS_CLI_USAGE_PASS / 1 = 不一致
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$(dirname "$HERE")"

# help はローカルの文書だが、既定のページャを噛ませると非対話で止まりうる。
export AWS_PAGER=""

# エスケープ文字そのもの（GNU sed の `\x1B` に頼らないため。下記 synopsis_of）。
ESC="$(printf '\033')"

TARGETS=(scripts/deploy-orchestrator.sh)
if [[ "${CHECK_AWS_ALL:-}" == "1" ]]; then
  mapfile -t TARGETS < <(find scripts -maxdepth 1 -name '*.sh' | sort)
fi

failed=0
checked_invocations=0
checked_flags=0

# 一時ディレクトリに help の出力を溜める（同じ操作を何度も引かない）。
# テンプレートを明示する（BSD 系の mktemp は必須。予測可能な名前も避ける。
# scripts/acceptance-remote.sh と同じ規約）。
CACHE="$(mktemp -d "${TMPDIR:-/tmp}/aws-cli-usage.XXXXXX")" || {
  echo "[aws-usage] 一時ディレクトリを作成できませんでした。" >&2
  exit 1
}
trap 'rm -rf "$CACHE"' EXIT

have_aws=0
if command -v aws >/dev/null 2>&1; then
  have_aws=1
fi

##
# 1 つのスクリプトから aws の呼び出しを取り出す。
#
# 行継続（`\` 終わり）を畳み、コメント行と、文字列の中で aws に触れているだけの行
# （echo など）を落とす。取り出すのは `aws` から**コマンドの区切りまで**である。
#
# 標準出力に、1 呼び出し 1 行で出す。
##
extract_invocations() {
  local file="$1"
  # 1) 行継続を畳む 2) コメント行を落とす 3) 説明用の行を落とす
  sed -e ':a' -e '/\\$/{N;s/\\\n/ /;ba' -e '}' "$file" \
    | grep -vE '^[[:space:]]*#' \
    | grep -vE '^[[:space:]]*(echo|printf|warn|note|info)[[:space:]]' \
    | grep -oE '(^|[;&|(!]|\$\(|<\()[[:space:]]*aws[[:space:]]+[^|)>;&]*' \
    | sed -E 's/^[^a]*//' \
    | sed -E 's/[[:space:]]+$//'
}

##
# SYNOPSIS を引く（キャッシュ付き）。見出しの制御文字は col -b で落とす。
##
synopsis_of() {
  local key="$1"
  shift
  local path="$CACHE/$key"
  if [[ ! -f "$path" ]]; then
    # groff の出力は太字を ANSI エスケープで表す。落としてから見出しで切る。
    #
    # **`\x1B` と書かない。** あれは GNU sed の拡張で、BSD 系（macOS）の sed は
    # 「x」という文字として扱う。エスケープ文字は printf で作って渡す。
    aws "$@" help 2>/dev/null \
      | col -b \
      | sed -e "s/${ESC}\[[0-9;]*[A-Za-z]//g" \
      | sed -n '/SYNOPSIS/,/OPTIONS/p' >"$path" || : >"$path"
  fi
  cat "$path"
}

##
# 1 つの呼び出しを検査する。
##
check_invocation() {
  local file="$1"
  local line="$2"
  # shellcheck disable=SC2206
  local tokens=($line)
  local index=1 # tokens[0] は aws

  # サービス名の手前にあるグローバルオプションを飛ばす（例: aws --profile X budgets ...）。
  while [[ $index -lt ${#tokens[@]} && "${tokens[$index]}" == --* ]]; do
    local flag="${tokens[$index]}"
    index=$((index + 1))
    if [[ "$flag" != --no-* && $index -lt ${#tokens[@]} && "${tokens[$index]}" != --* ]]; then
      index=$((index + 1))
    fi
  done

  local service="${tokens[$index]:-}"
  local operation="${tokens[$((index + 1))]:-}"
  [[ -n "$service" && -n "$operation" ]] || return 0
  # 変数で組み立てている呼び出しは、形を読み取れないので見ない。
  [[ "$service" == *'$'* || "$operation" == *'$'* ]] && return 0
  index=$((index + 2))

  local -a help_args=("$service" "$operation")
  local key="$service.$operation"

  # 待機子は 1 段深い（aws lambda wait function-updated-v2）。
  if [[ "$operation" == "wait" ]]; then
    local waiter="${tokens[$index]:-}"
    [[ -n "$waiter" && "$waiter" != --* ]] || return 0
    index=$((index + 1))
    if [[ $have_aws -eq 1 ]]; then
      if ! aws "$service" wait help 2>/dev/null | col -b | sed -e "s/${ESC}\[[0-9;]*[A-Za-z]//g" \
        | grep -qE "^[[:space:]]+o[[:space:]]+${waiter}[[:space:]]*$"; then
        echo "[aws-usage] $file: 待機子が実在しません: aws $service wait $waiter" >&2
        failed=1
        return 0
      fi
    fi
    help_args=("$service" wait "$waiter")
    key="$service.wait.$waiter"
  fi

  checked_invocations=$((checked_invocations + 1))

  local synopsis=""
  if [[ $have_aws -eq 1 ]]; then
    synopsis="$(synopsis_of "$key" "${help_args[@]}")"
    if [[ -z "$synopsis" ]]; then
      echo "[aws-usage] $file: 操作が実在しません: aws ${help_args[*]}" >&2
      failed=1
      return 0
    fi
  fi

  # SYNOPSIS からオプション名を**そのまま抜き出して**照合する。
  #
  # **正規表現で「前後の区切り」を書かない。** 括弧・縦棒・角括弧が入り混じる行を
  # 1 本の式で扱おうとすると、式そのものの誤りが「実在しないオプション」という
  # 誤検知になる（実際に一度そうなった）。名前の一覧に落として完全一致で見る。
  local valid_flags="" booleans=""
  if [[ -n "$synopsis" ]]; then
    # 一致が無いときも落とさない（`set -e` は代入の失敗でも効く）。
    valid_flags="$(grep -oE -- '--[a-z0-9-]+' <<<"$synopsis" | sort -u || true)"
    # 真偽値フラグ（[--x | --no-x] の形で現れるもの）。
    booleans="$(grep -oE -- '\[--[a-z0-9-]+ \| --no-[a-z0-9-]+\]' <<<"$synopsis" \
      | grep -oE -- '--no-[a-z0-9-]+' | sed 's/--no-/--/' | tr '\n' ' ' || true)"
  fi

  while [[ $index -lt ${#tokens[@]} ]]; do
    local token="${tokens[$index]}"
    index=$((index + 1))
    [[ "$token" == --* ]] || continue
    local flag="${token%%=*}"
    local next="${tokens[$index]:-}"
    checked_flags=$((checked_flags + 1))

    # 層 1: 真偽値に値を渡していないか。**aws CLI が無くても効く。**
    if [[ "$next" == "true" || "$next" == "false" ]]; then
      echo "[aws-usage] $file: 真偽値フラグに値を渡しています: $flag $next" >&2
      echo "[aws-usage]   AWS CLI の真偽値は値を取りません（$flag / ${flag/--/--no-}）。" >&2
      failed=1
      continue
    fi

    [[ -n "$synopsis" ]] || continue

    # 層 2: そのフラグが実在するか（名前の完全一致）。
    if ! grep -qxF -- "$flag" <<<"$valid_flags"; then
      echo "[aws-usage] $file: 実在しないオプションです: aws ${help_args[*]} $flag" >&2
      failed=1
      continue
    fi

    # 層 2': 真偽値フラグに値らしきものが続いていないか。
    if [[ " $booleans " == *" $flag "* && -n "$next" && "$next" != --* ]]; then
      echo "[aws-usage] $file: 真偽値フラグに値を渡しています: $flag $next" >&2
      failed=1
    fi
  done
}

for file in "${TARGETS[@]}"; do
  [[ -f "$file" ]] || continue
  while IFS= read -r invocation; do
    [[ -n "$invocation" ]] || continue
    check_invocation "$file" "$invocation"
  done < <(extract_invocations "$file")
done

if [[ $have_aws -eq 0 ]]; then
  echo "[aws-usage] aws CLI が無いため、フラグの実在検査は行っていません（真偽値の検査だけ実施）。"
fi

if [[ $failed -ne 0 ]]; then
  echo "[aws-usage] aws CLI の呼び出しに、実行せずに分かる誤りがあります。" >&2
  exit 1
fi

echo "[aws-usage] ${#TARGETS[@]} ファイル / ${checked_invocations} 呼び出し / ${checked_flags} オプションを照合しました"
echo "AWS_CLI_USAGE_PASS"
