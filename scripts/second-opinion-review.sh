#!/usr/bin/env bash
# second-opinion-review.sh — 別ベンダーのモデルによる第二意見（クロスモデル二段ゲートの ②段目）
#
# 規範: .ai-playbook/review-workflow.md
# 目的: 実装したモデル自身の自己レビューは盲点を共有するため、別ベンダーのモデルで
#       独立にクロスチェックする。push 前のローカル事前ゲートで使う。
#
# 使い方:
#   bash scripts/second-opinion-review.sh                      # ステージ済み差分をレビュー
#   bash scripts/second-opinion-review.sh --range main..HEAD
#   bash scripts/second-opinion-review.sh --engine antigravity
#   bash scripts/second-opinion-review.sh --engine codex
#   SECOND_OPINION_RUNS=3 bash scripts/second-opinion-review.sh
#
# エンジン:
#   認証手段の違う 3 つの CLI から選べる。判定ロジックは 1 か所に集約し、エンジン
#   ごとに複製しない。複製すると、判定の修正が片側にしか効かない状態が生まれる。
#   エンジンごとに違うのは「CLI の名前」「認証」「差分の渡し方」の 3 点だけである。
#
#   gemini       gemini CLI。API キー認証（GEMINI_API_KEY）。既定
#   antigravity  Antigravity CLI（agy）。Google アカウントの OAuth 認証。API キー非対応
#   codex        Codex CLI（codex exec）。ChatGPT アカウントの OAuth 認証（定額）
#
# 費用の形がエンジンで違う（#805）:
#   Copilot のレビューは PR 1 本あたりの固定費が支配的で、**本数に線形に増える**
#   （#654 の実測: 16.1 credits × PR 本数。超過 $164.60/月）。Codex Plus は定額で、
#   枠は 5 時間窓で回復する。antigravity（**Google AI Plus**。2026-09-29 に Pro から下げた）の枠は週ごとで、当たると
#   数日止まる。**危険な変更（ツール解禁など）は、回復の速い枠の上で試す。**
#
# 判定のぶれについて:
#   このレビューは非決定的で、同じ差分でも実行のたびに結果が変わる。どちらの CLI にも
#   temperature / seed に相当するオプションは無く、フラグでは決定化できない。
#   1 回だけ実行して LGTM を通過とみなすと、見落としをそのまま通す。
#
#   SECOND_OPINION_RUNS で実行回数を増やすと、指摘を報告した run が過半数
#   （floor(N/2)+1）に達したときだけ落とす。誤検出 1 回でゲートが止まるのを避けつつ、
#   繰り返し現れる指摘は拾う。既定は 1 で、この場合は閾値も 1 になり従来と同じ挙動。
#
#   限界: 少数回しか現れない指摘は通過する。これは意図した妥協で、レビューの
#   位置づけは「補助」であり、主レビューを省略してよい根拠にはならない。
#
#   回数では消えない故障もあった。モデルが回答の前に作業ナレーションを出す形は、
#   同じ差分なら毎回同じように出るため、run を増やしても全 run が同じように落ちた。
#   **#804 で構造化出力を強制し、この故障クラスは消えた**（下記「通過判定」）。
#
# 通過判定（#804 で作り直した）:
#   モデルには**判定を出させない。** 回答は JSON（`scripts/second-opinion-schema.json`）で、
#   中身は指摘の配列だけである。**落とすかどうかは `category` を見てこのスクリプトが決める**
#   ——`bug` / `vulnerability` / `type-error` / `edge-case` の 4 つだけが落とす。
#   `promise-mismatch` と `other` は報告に出るが判定を動かさない。
#   **JSON として読めない回答は落とす**（「読めなかった」を「指摘なし」に倒さない）。
#   **差分を読めなかったと答えた回答（`reviewed: false`）も落とし、記録も残させない**（#873）。
#   2026-10-01 に、devcontainer の codex がサンドボックスの失敗で `git diff` を叩けず、
#   「レビューを実施できませんでした」を `other` の指摘 1 件として返した。`other` は判定を
#   動かさないので **LGTM になり、loop-gate.sh が記録まで作った**。読んでいないものを
#   レビュー済みにしないため、読めたかどうかを回答の必須の項目として答えさせる。
#
# ツールの解禁（#804）:
#   **codex だけ**。`--sandbox read-only` が書き込みを止めることを実測してある。
#   agy は `--sandbox --mode plan --dangerously-skip-permissions` でも**書き込めた**ので
#   解禁しない（詳細は下の ENGINE_TOOLS の表）。
#   **解禁したエンジンにも、差分は標準入力で必ず渡す**（#880。2026-10-02 に #804 の
#   「差分は渡さず、モデル自身に `git diff` を叩かせる」を改めた）。ツールは差分の外を
#   確かめる補助にとどめる。読み取り専用のサンドボックスは、ユーザー名前空間を禁じた
#   コンテナでは起動せず、`git diff` も叩けない——差分の取得までツールに任せると、
#   その環境では差分を 1 行も読まないまま回答が返る（2026-10-01 に実際に起きた。#873）。
#
# 終了コード:
#   0 = LGTM（過半数の run が指摘なし。push 可）
#   1 = 重大な指摘あり、または実行不能
set -euo pipefail

# プロジェクト固有 .env を優先読み込み（ホスト env を上書き）。非対話実行でも効かせる。
# 隣接する load-project-env.sh を source する。無い構成（規範のみの単独導入等）でも壊さない。
#
# 既定値を読む前に通す。あとから読むと、.env に書いた SECOND_OPINION_RUNS /
# SECOND_OPINION_MODEL が既に確定した変数に負けて、設定したつもりで効かない。
# 検証もすり抜けるため、不正な値がそのまま走ることになる。
__SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [[ -f "$__SCRIPT_DIR/load-project-env.sh" ]]; then
  # shellcheck source=scripts/load-project-env.sh
  . "$__SCRIPT_DIR/load-project-env.sh"
fi

# 優先順位は CLI 引数 > .env > 既定。ここでは .env（読み込み済み）と既定を解決し、
# CLI 引数は後段の引数解析で上書きする。
#
# 環境変数は SECOND_OPINION_* を正とし、旧名 GEMINI_REVIEW_* も受理する。旧名は
# エンジン名を含むため、エンジンを選べるようになった時点で名前が事実と合わなくなる。
# ただし取り込み済みの利用側が .env を書き換えるまでゲートが止まるのは避ける。
RANGE=""
ENGINE="${SECOND_OPINION_ENGINE:-gemini}"
MODEL="${SECOND_OPINION_MODEL:-${GEMINI_REVIEW_MODEL:-}}"
RUNS="${SECOND_OPINION_RUNS:-${GEMINI_REVIEW_RUNS:-1}}"

usage() {
  cat <<'EOF'
usage: bash scripts/second-opinion-review.sh [options]

options:
  --range <git-range>   レビュー対象の差分範囲（既定: ステージ済み差分）
  --engine <name>       レビューを実行する CLI（gemini | antigravity | codex。既定: gemini。
                        SECOND_OPINION_ENGINE でも指定可）
  --model <name>        使用モデル（既定: 各 CLI の既定。SECOND_OPINION_MODEL でも指定可）
  --runs <n>            実行回数（既定: 1。SECOND_OPINION_RUNS でも指定可）
                        指摘を報告した run が過半数に達したときだけ非 0 で終わる
  -h, --help            ヘルプ

engines:
  gemini       gemini CLI。API キー認証（GEMINI_API_KEY）
  antigravity  Antigravity CLI（agy）。Google アカウントの OAuth 認証。API キー非対応
  codex        Codex CLI（codex exec）。ChatGPT アカウントの OAuth 認証（定額）。
               モデルの既定は gpt-6-sol（--model / SECOND_OPINION_MODEL で上書き可）
EOF
}

# 値を伴わないオプション指定（例: --runs で終わる）は set -u 下で $2 が
# unbound variable になり、使い方を示さないまま落ちる。何が足りないかを言う。
need_value() {
  [[ -n "${2-}" ]] || {
    echo "error: $1 には値が必要です" >&2
    usage >&2
    exit 1
  }
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --range)  need_value "$1" "${2-}"; RANGE="$2";  shift 2 ;;
    --engine) need_value "$1" "${2-}"; ENGINE="$2"; shift 2 ;;
    --model)  need_value "$1" "${2-}"; MODEL="$2";  shift 2 ;;
    --runs)   need_value "$1" "${2-}"; RUNS="$2";   shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "error: unknown option: $1" >&2; usage; exit 1 ;;
  esac
done

# 不正な回数で黙って 1 回に落とすと、増やしたつもりのゲートが実際には
# 効いていない状態になる。着手前に止める。
if [[ ! "$RUNS" =~ ^[0-9]+$ ]]; then
  echo "error: runs は 1 以上の整数で指定してください: $RUNS" >&2
  exit 1
fi

# 基数を 10 に固定する。bash の算術評価は先頭 0 を 8 進数として扱うため、
# 固定しないと 2 通りに壊れる。
#   08 / 09 -> 8 進数として無効。比較そのものがエラーになり、検証をすり抜ける
#   010     -> 8 と解釈され、10 回のつもりが 8 回になる（閾値も狂う）
RUNS=$((10#$RUNS))

if [[ "$RUNS" -lt 1 ]]; then
  echo "error: runs は 1 以上の整数で指定してください: $RUNS" >&2
  exit 1
fi

# **ツールを解禁するのは、サンドボックスが実測で保たれるエンジンだけ**（#804）。
#
# | エンジン | 旗 | 実測（2026-09-29） |
# |---|---|---|
# | codex | `--sandbox read-only` | **書き込みは `Read-only file system` で失敗**。`git diff` は通る |
# | antigravity | `--sandbox --mode plan --dangerously-skip-permissions` | **書き込めた**（`probe-write-test.txt` が実際にできた。**警告も出ない**） |
#
# **agy は旗の名前に反して止まりません。** 止まらないまま解禁すると、**レビュアーが
# レビュー対象の作業ツリーを書き換えられる**——「何をレビューしたか」が壊れる。
# したがって agy は従来どおり差分をプロンプトへ載せ、ツールは使わせない。
ENGINE_TOOLS=0

# **スキーマを CLI の旗で強制できるか。** できないエンジンには、プロンプトへ形を書いて渡す
# （第二意見の指摘。実在）——渡さないと、モデルは `what` / `why` などの必要な項目を知らず、
# **指摘の中身に関係なく後段の検証で落ちる**。gemini には `--json-schema` に当たる旗が無い
# （`gemini --help` で実測。2026-09-29）。
ENGINE_SCHEMA_FLAG=0

# スキーマの置き場所。**判定はモデルに出させず、category からこちらで決める**（#804）。
SCHEMA_FILE="$__SCRIPT_DIR/second-opinion-schema.json"

# エンジンの検査は CLI を呼ぶ前に済ませる。未知の値をそのまま先へ流すと、
# 「コマンドが無い」というエンジン不在のエラーに化けて、綴り間違いだと分からない。
case "$ENGINE" in
  gemini)
    command -v gemini >/dev/null 2>&1 || {
      echo "error: gemini CLI not found. gemini CLI を導入してから再実行してください（導入手段はプロジェクト層で定義します）" >&2
      exit 1
    }
    # gemini CLI は API キー認証。鍵が無ければモデルへ到達できない。
    [[ -n "${GEMINI_API_KEY:-}" ]] || {
      echo "error: GEMINI_API_KEY is not set" >&2
      exit 1
    }
    ;;
  antigravity)
    command -v agy >/dev/null 2>&1 || {
      echo "error: agy (Antigravity CLI) not found. agy を導入してログインしてから再実行してください（導入手段はプロジェクト層で定義します）" >&2
      exit 1
    }
    # agy は OAuth のみで API キーに対応しない。鍵の有無は検査しない。資格情報は
    # CLI が自身の保存先に持つため、このスクリプトからは可視でも制御対象でもない。
    ENGINE_SCHEMA_FLAG=1
    ;;
  codex)
    command -v codex >/dev/null 2>&1 || {
      echo "error: codex (Codex CLI) not found. codex を導入してログインしてから再実行してください（導入手段はプロジェクト層で定義します）" >&2
      exit 1
    }
    # **資格情報の有無をここで見る。** codex は OAuth（ChatGPT アカウント）と API キーの
    # 両方を受けるので、どちらで入っているかを知る必要はない。`codex login status` が
    # 有無だけを終了コードで返す（実測: 未ログインで "Not logged in" と終了コード 1）。
    #
    # **見ないと失敗が遅い。** 未ログインのまま exec へ進むと、CLI は 5 回の再接続を
    # 試してから 401 で落ちる（実測: `ERROR: Reconnecting... 1/5` 〜 `5/5` の後に
    # `unexpected status 401 Unauthorized`）。レビューの前段で数十秒を捨て、しかも
    # 出てくるのは「回答が空」に近い形なので、ログインしていないことが読み取りにくい。
    codex login status >/dev/null 2>&1 || {
      echo "error: codex にログインしていません。'codex login' を対話で 1 度通してから再実行してください" >&2
      exit 1
    }
    # **モデルの既定を CLI に任せない。** codex の既定は gpt-6-astra で、Plus の
    # 5 時間窓は 5〜45 通（複雑なタスクほど下限に寄る）——繁忙週の需要 38/日 を
    # 下限では賄えない（#805）。gpt-6-sol は同じ窓で 15〜150 通ある。
    # **既定のまま回すと、枠に当たって初めて分かる。**
    #
    # 綴りは `codex debug models` で実測した（認証不要で引ける。2026-09-28 /
    # codex-cli 0.157.1 で gpt-6-astra / gpt-6-sol / gpt-6-luna が実在）。
    if [[ -z "$MODEL" ]]; then
      MODEL="gpt-6-sol"
    fi
    # codex のサンドボックスは実測で書き込みを止める（上の表）。ツールを解禁する。
    ENGINE_TOOLS=1
    ENGINE_SCHEMA_FLAG=1
    ;;
  *)
    echo "error: unknown engine: $ENGINE（gemini | antigravity | codex）" >&2
    exit 1
    ;;
esac

if [[ ! -f "$SCHEMA_FILE" ]]; then
  echo "error: 回答のスキーマが見つかりません: $SCHEMA_FILE" >&2
  exit 1
fi

if ! command -v jq >/dev/null 2>&1; then
  echo "error: jq が無いため回答（JSON）を読めません。jq を導入してから再実行してください" >&2
  exit 1
fi

if [[ -n "$RANGE" ]]; then
  diff_text="$(git diff "$RANGE")"
  scope="$RANGE"
else
  diff_text="$(git diff --cached)"
  scope="staged"
fi

if [[ -z "${diff_text//[[:space:]]/}" ]]; then
  echo "[second-opinion] no diff to review ($scope)"
  exit 0
fi

# レビューの文脈（#804）。**ブランチ名から issue 番号を取り、scope と acceptance を
# プロンプトへ載せる。** これが無いと、第二意見は「この変更が何を約束したか」を知らないまま
# 差分だけを読むことになり、**Copilot が拾う「自分が破った約束」を原理的に拾えない**
# （`docs/handoff.md` の「Copilot は自分が破った約束を拾う」）。
#
# **ゲートではないので、取れなくても止めません。** 取れなかったことは出力に出します
# （黙って「文脈つきでレビューした」ことにしない）。
issue_context=""
branch_issue_num=""
resolve_issue_context() {
  local branch num body
  branch="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || true)"
  # feat/804-... / fix/795-... / docs/writeback-... のような形から数字を取る。
  # **枝の名前に数字が無ければ何もしない**（推測で別の issue を引かない）。
  num="$(printf '%s' "$branch" | sed -n 's|^[a-z]*/\([0-9][0-9]*\)-.*|\1|p')"
  branch_issue_num="$num"
  if [[ -z "$num" ]]; then
    echo "[second-opinion] 枝の名前から issue 番号を取れませんでした（文脈なしでレビューします）: $branch" >&2
    return 0
  fi
  if ! command -v gh >/dev/null 2>&1; then
    echo "[second-opinion] gh が無いため issue #$num を引けません（文脈なしでレビューします）" >&2
    return 0
  fi
  if ! body="$(gh issue view "$num" --json title,body --jq '"# issue #" + (.title) + "\n\n" + .body' 2>/dev/null)"; then
    echo "[second-opinion] issue #$num を引けませんでした（文脈なしでレビューします）" >&2
    return 0
  fi
  issue_context="$body"
  echo "[second-opinion] issue #$num の scope と acceptance を文脈に載せます"
}
resolve_issue_context

# 差分とコミットメッセージが参照している issue / PR の文脈（#828）。
#
# **Copilot が拾い、第二意見が拾えなかった指摘の約半分は「他の issue / PR の状態」を
# 知らないと出せない種類だった**（#816〜#824 の 11 件中 5 件。「#812 は未マージ」
# 「#776 の制約だと 1 日早い」など）。codex のサンドボックスはネットワークも止める
# （実測: `gh` は `error connecting to api.github.com`）ので、**モデルには引けない。
# サンドボックスの外にいるこのスクリプトが引いて載せる。**
#
# 絞り方（#828 のデメリットの表）:
#   - 拾うのは**差分の追加行とコミットメッセージだけ**。削除行や文脈行の番号は、
#     この変更が主張していることではない
#   - **作成者がリポジトリの持ち主のものだけ**。public なので部外者の文がプロンプトへ
#     入りうる（持ち主はリポジトリの URL から取る。呼び出しを 1 本増やさない）
#   - issue は「状態・タイトル・acceptance の節」、PR は「状態・タイトル」だけ。本文全体は
#     載せない（消費と、古い本文による誤検出を抑える）
#   - **上限は REFERENCED_LIMIT 本。超えた分は捨てたと出す**
#   - 引けなくても止めない（ゲートではない）。引けなかったことは出す
REFERENCED_LIMIT=10
referenced_context=""

# 1 行ずつ読み、`#123` の番号だけを出す。`&#123;`（HTML の実体参照）、`#fff`、
# URL の断片（`/#12`）、6 桁以上（色の `#000000`）は拾わない。
# **GNU 拡張を使わない**（利用者の端末は macOS。grep の `\b` や `-P` に頼らない）。
extract_issue_refs() {
  awk '{
    s = $0; lastc = ""
    while (match(s, /#[0-9]+/)) {
      b = (RSTART > 1) ? substr(s, RSTART - 1, 1) : lastc
      a = substr(s, RSTART + RLENGTH, 1)
      n = substr(s, RSTART + 1, RLENGTH - 1)
      if (b !~ /[0-9A-Za-z_&\/#]/ && a !~ /[0-9A-Za-z_]/ && length(n) <= 5 && n + 0 > 0) print n + 0
      lastc = substr(s, RSTART + RLENGTH - 1, 1)
      s = substr(s, RSTART + RLENGTH)
    }
  }'
}

# issue の本文から acceptance の節（intake の YAML の `acceptance:` から次のキーまで）を出す。
extract_acceptance() {
  tr -d '\r' | awk '
    /^acceptance:/ { on = 1; print; next }
    on && (/^[A-Za-z_.]+:/ || /^```/) { exit }
    on { print }
  '
}

resolve_referenced_context() {
  local refs nums n kept dropped rejected unreadable json owner author kind state title acc
  # コミットメッセージを先に置く。「(#804)」のように、変更が名指しした番号が先頭に来る。
  # **範囲（A..B）のときだけ**ログを読む。単独のリビジョンに git log を当てると
  # 履歴の全部を読むことになる。
  refs=""
  if [[ "$RANGE" == *..* ]]; then
    refs="$(git log --format=%B "$RANGE" 2>/dev/null | extract_issue_refs || true)"
  fi
  refs="$refs
$(printf '%s\n' "$diff_text" | awk '/^\+/ && !/^\+\+\+ / { print substr($0, 2) }' | extract_issue_refs || true)"
  # 出てきた順に重複を落とし、枝の issue（上で全文を載せた）を除く。
  nums="$(printf '%s\n' "$refs" | awk -v skip="$branch_issue_num" 'NF && $0 != skip && !seen[$0]++')"
  if [[ -z "$nums" ]]; then
    return 0
  fi
  if ! command -v gh >/dev/null 2>&1; then
    echo "[second-opinion] gh が無いため、参照された issue / PR を引けません（文脈なしで続けます）" >&2
    return 0
  fi

  dropped="$(printf '%s\n' "$nums" | awk -v lim="$REFERENCED_LIMIT" 'NR > lim { printf "#%s ", $0 }')"
  nums="$(printf '%s\n' "$nums" | awk -v lim="$REFERENCED_LIMIT" 'NR <= lim')"
  kept=""; rejected=""; unreadable=""
  for n in $nums; do
    # issues の API は PR も返す（`.pull_request` の有無で分かれる）。1 番号 1 呼び出し。
    # **`.pull_request.merged_at` は issues の API にも入っている**——pulls の API を
    # 呼び直す必要はない（実測 2026-09-30: `gh api repos/{owner}/{repo}/issues/824` の
    # `.pull_request.merged_at` が `2026-09-30T01:14:08Z`。第二意見が「入っていない」と
    # 誤って指摘したので、ここに根拠を残す）。
    if ! json="$(gh api "repos/{owner}/{repo}/issues/$n" 2>/dev/null)" \
        || ! owner="$(printf '%s' "$json" | jq -er '.repository_url | split("/") | .[-2]' 2>/dev/null)"; then
      unreadable="$unreadable#$n "
      continue
    fi
    author="$(printf '%s' "$json" | jq -r '.user.login // ""')"
    if [[ "$author" != "$owner" ]]; then
      rejected="$rejected#$n "
      continue
    fi
    title="$(printf '%s' "$json" | jq -r '.title // ""')"
    if printf '%s' "$json" | jq -e '.pull_request' >/dev/null 2>&1; then
      state="$(printf '%s' "$json" | jq -r 'if .pull_request.merged_at then "merged" else .state end')"
      referenced_context="$referenced_context
- #$n（PR・$state）$title"
    else
      state="$(printf '%s' "$json" | jq -r '.state + (if .state_reason then "・" + .state_reason else "" end)')"
      acc="$(printf '%s' "$json" | jq -r '.body // ""' | extract_acceptance)"
      referenced_context="$referenced_context
- #$n（issue・$state）$title"
      if [[ -n "$acc" ]]; then
        referenced_context="$referenced_context
$(printf '%s\n' "$acc" | sed 's/^/    /')"
      else
        referenced_context="$referenced_context
    （acceptance の節なし）"
      fi
    fi
    kept="$kept#$n "
  done

  if [[ -n "$kept" ]]; then
    echo "[second-opinion] 参照された issue / PR を文脈に載せます: ${kept% }"
  fi
  if [[ -n "$dropped" ]]; then
    echo "[second-opinion] 上限 $REFERENCED_LIMIT 本を超えたため載せません: ${dropped% }"
  fi
  if [[ -n "$rejected" ]]; then
    echo "[second-opinion] 作成者がリポジトリの持ち主でないため載せません: ${rejected% }"
  fi
  if [[ -n "$unreadable" ]]; then
    echo "[second-opinion] 引けなかったため載せません: ${unreadable% }" >&2
  fi
}
resolve_referenced_context

# 文脈（枝の issue の全文と、参照された issue / PR の要約）をプロンプトの末尾へ足す。
# ツールの有無でプロンプトの本文は分かれるが、文脈の足し方は分けない。
append_context() {
  if [[ -n "$issue_context" ]]; then
    PROMPT="$PROMPT

この変更が満たすべき約束（issue の本文。**scope と acceptance に注目**してください）:

$issue_context"
  fi
  if [[ -n "$referenced_context" ]]; then
    PROMPT="$PROMPT

差分とコミットメッセージが参照している issue / PR（取得時点の状態と、issue の acceptance の節だけ。本文の全文ではありません）。
**変更の記述（未マージ・完了・日付・acceptance の番号など）がこれと食い違っていないか**を確かめてください。
食い違いは \`promise-mismatch\` で報告してください:
$referenced_context"
  fi
}

# 報告の規則は 1 か所にまとめる（ツールの有無で本文が分かれても、規則は分けない）。
read -r -d '' REPORT_RULES <<'EOF' || true
報告してよいもの（`category` の値）:
- `bug`（致命バグ） / `vulnerability`（脆弱性） / `type-error`（型エラー） / `edge-case`（エッジケースの見落とし）
  … **この 4 つだけがゲートを落とします。**
- `promise-mismatch` … issue の scope や acceptance と、実際の変更が食い違う点（**報告のみ**）
- `other` … 上記以外で、次に読む人へ伝える価値があるもの（**報告のみ**）

報告しないもの:
- 好みのリファクタリング
- 命名や可読性の軽微な提案
- 差分と関係のない既存コードの問題

出力:
- **JSON だけを返してください。** 形はスキーマのとおりで、指摘が無ければ `findings` は空の配列です。
- **通す / 落とすの判定は書かないでください。** `category` を見てこちらで決めます。
- `reviewed` には、渡した差分を実際に読んでレビューできたかを書いてください。差分が空だった・
  途中で切れていたなどで**読めなかったときは `false`** にし、読めなかった理由を `other` の指摘で書いてください。
  読めなかったのに `true` にしたり、指摘を空にして済ませたりしないでください。
  差分の外を確かめるためのコマンドが失敗しただけなら、渡した差分を読めていれば `true` です。
- 前置きや作業の説明は書かないでください。
EOF

# **旗で強制できないエンジンには、形をプロンプトへ書いて渡す。** 正本はスキーマの
# ファイルそのもので、ここでは中身を貼るだけ——2 か所に書かない。
append_schema_to_rules() {
  if [[ "$ENGINE_SCHEMA_FLAG" -eq 1 ]]; then
    return 0
  fi
  REPORT_RULES="$REPORT_RULES

回答の形（JSON Schema。**このエンジンは形を強制できないので、ここに載せます**）:

$(cat "$SCHEMA_FILE")"
}

# ツールを解禁したときのプロンプト（#804 / #880）。**差分は標準入力で、このプロンプトの前に
# 渡す**（codex の case の注記）。ツールは差分の外を確かめる補助で、差分の取得には使わせない
# ——サンドボックスが起動しない環境でも、差分そのものは必ず読まれる（ヘッダ「ツールの解禁」）。
build_prompt_with_tools() {
  PROMPT="上記はこのリポジトリの git の差分です（\`$diff_cmd\` の出力）。コードレビューを行ってください。

**レビューする差分は、上に渡したものを読んでください。** 差分を取り直す必要はありません。
**読み取りのコマンドとファイル読み取りは、差分の外を確かめるために使ってよい**です。差分の外の
ファイル・テスト・宣言・ドキュメントも読み、**事実を確かめてから**報告してください（推測で書かない）。
**書き込みはできません**（サンドボックスが読み取り専用です）。
**コマンドが実行できない環境でも、上の差分だけでレビューを完結させてください。** その場合、
差分の外を確かめられなかったことを理由に指摘を作らないでください。

$REPORT_RULES"
  append_context
}

# ツールを使えないエンジンのプロンプト。差分は本文へ載せる（従来どおり）。
build_prompt_without_tools() {
  PROMPT="
上記は git の差分です。コードレビューを行ってください。

レビューに必要な情報はこのプロンプトに含まれています。**ファイル読み取りやコマンド実行のツールを使わないでください。** ツールの実行は非対話実行では承認できず、拒否されると回答そのものが返らなくなります。

$REPORT_RULES"
  append_context
}

if [[ -n "$RANGE" ]]; then
  diff_cmd="git diff $RANGE"
else
  diff_cmd="git diff --cached"
fi

append_schema_to_rules

if [[ "$ENGINE_TOOLS" -eq 1 ]]; then
  build_prompt_with_tools
else
  build_prompt_without_tools
fi

echo "[second-opinion] reviewing $scope (engine=$ENGINE, runs=$RUNS)"

# 一時領域は両エンジンで使う。gemini は差分の受け渡しに、両者とも stderr の退避に。
# テンプレートを明示する。BSD 系（macOS）の mktemp はテンプレート無しの呼び出しを
# 受け付けず、この雛形は Linux 以外へ配布されうる。
work_dir="$(mktemp -d "${TMPDIR:-/tmp}/second-opinion.XXXXXX")"
diff_file="$work_dir/review.diff"
stderr_file="$work_dir/stderr"
trap 'rm -rf "$work_dir"' EXIT
printf '%s\n' "$diff_text" > "$diff_file"

# 単一引数に載せられるバイト数の上限。
#
# **`getconf ARG_MAX` ではない。** ARG_MAX は「引数と環境変数の合計」の上限で、
# Linux にはそれとは別に **1 引数あたり `MAX_ARG_STRLEN` = 32 ページ = 131,072 バイト**
# という固定の上限がある。差分をまるごと 1 つの `-p` 引数へ載せる以上、効くのは後者。
#
# 実測（Linux 6.10 / bash 5）: 単一引数 131,000 バイトは通り、131,073 バイトは E2BIG。
# 一方、10 万バイトの引数を 20 個（合計 200 万バイト）並べても通る。合計ではなく
# 1 引数あたりが制約であることの裏づけ。
#
# ARG_MAX と比較していた版では、190KB の差分がガードを素通りしてから
# `Argument list too long` で落ち、原因が読めないまま赤になった。
SINGLE_ARG_LIMIT=131072

# バイト数を数える。`${#var}` は**文字数**であり、ロケールによってはバイト数と一致
# しない。日本語を含む差分では 1 文字 3 バイトになり、上限判定が最大 3 倍甘くなる。
byte_len() {
  printf '%s' "$1" | wc -c | tr -d '[:space:]'
}

# 差分を、1 回の呼び出しで渡せる大きさの断片（チャンク）へ分ける。
#
# 上限超過を「範囲を分けてください」と拒否するだけでは、生成物（ロックファイル等）を
# 含む差分が永久にレビューできない。分割して全体を見る。
#
# 単位はファイル単位を基本とし、1 ファイルの差分だけで上限を超える場合に限り
# ハンク（`@@` で始まる塊）単位へ落とす。ハンク単位にしたときはファイルヘッダを
# 毎回付け直す。付けないと、モデルはどのファイルの変更かを判断できない。
#
# 1 ハンクだけで上限を超える場合は分割できない。**黙って切り詰めない**
# （レビューされていない部分を緑として報告することになる）。名指しして失敗させる。
split_diff_into_chunks() {
  local src="$1" outdir="$2" limit="$3"

  LC_ALL=C awk -v limit="$limit" -v outdir="$outdir" '
    function write_chunk() {
      if (curlen > 0) {
        n++
        f = sprintf("%s/%04d.diff", outdir, n)
        printf "%s", cur > f
        close(f)
        cur = ""
        curlen = 0
      }
    }
    function add_unit(u,   ulen, where) {
      ulen = length(u)
      if (ulen > limit) {
        where = (fname != "" ? fname : "(最初の diff --git より前の行)")
        printf "error: これ以上分割できない単位が上限を超えています: %s (%d > %d バイト)\n", \
          where, ulen, limit > "/dev/stderr"
        failed = 1
        return
      }
      if (curlen + ulen > limit) write_chunk()
      cur = cur u
      curlen += ulen
    }
    function flush_file(   whole, i) {
      # 判定は fname ではなく中身で行う。最初の `diff --git` より前に行があると
      # （git diff では通常出ないが）fname が空のまま捨てられ、黙って欠落する。
      if (hdr == "" && nhunks == 0) return
      whole = hdr
      for (i = 1; i <= nhunks; i++) whole = whole hunks[i]
      if (length(whole) <= limit || nhunks == 0) {
        # ハンクが無い差分（バイナリ、モード変更のみ等）は分割しようがない。
        # 上限を超えていても add_unit へ渡す。else 側の for は nhunks == 0 だと
        # 一度も回らず、**上限超過の検出も行われないまま黙って落ちる**。
        add_unit(whole)
      } else {
        # ファイル単位で入らないので、ヘッダを付け直しつつハンク単位へ落とす。
        for (i = 1; i <= nhunks; i++) add_unit(hdr hunks[i])
      }
      fname = ""; hdr = ""; nhunks = 0; inhunk = 0
    }
    /^diff --git / {
      flush_file()
      fname = $0
      hdr = $0 "\n"
      nhunks = 0
      inhunk = 0
      next
    }
    /^@@ / {
      nhunks++
      hunks[nhunks] = $0 "\n"
      inhunk = 1
      next
    }
    {
      if (inhunk) hunks[nhunks] = hunks[nhunks] $0 "\n"
      else hdr = hdr $0 "\n"
    }
    END {
      flush_file()
      write_chunk()
      if (failed) exit 3
      if (n == 0) {
        print "error: 差分からチャンクを 1 つも生成できませんでした" > "/dev/stderr"
        exit 4
      }
    }
  ' "$src"
}

# チャンク 1 件分の CLI 引数を組み立てる。$args を設定する。
#
# 末尾を `[[ -n "$MODEL" ]] && args=(...)` の形にしないこと。MODEL が空だと関数の
# 戻り値が 1 になり、`set -e` の下では**呼び出し元ごと無音で終了する**
# （実測: 分割の告知だけを出して exit 1。どのチャンクで何が起きたのか一切出ない）。
# 明示的に if で書き、最後に return 0 を置く。
# 標準入力の渡し先。**codex だけがここを使う**（他の 2 つは差分を引数で渡すので
# /dev/null のまま）。空にしない——run のループが `<"$stdin_file"` で開くため、
# 空だとリダイレクトそのものが失敗する。
stdin_file="/dev/null"

# codex の「最後のメッセージ」の置き場所。**消すのは run のループの側**である
# （build_args は 1 チャンクに 1 回しか走らないので、ここで消すだけでは足りない）。
answer_file=""

build_args() {
  local chunk="$1"
  case "$ENGINE" in
    gemini)
      args=(--skip-trust --include-directories "$work_dir" -p "@$chunk
$PROMPT")
      if [[ -n "$MODEL" ]]; then
        args=(-m "$MODEL" "${args[@]}")
      fi
      ;;
    antigravity)
      # **構造化出力は強制できる**（`--json-schema`）。ただし `--output-format json` が
      # 要る（実測: 付けないと `--json-schema can only be used when --output-format is
      # 'json' or 'stream-json'` で落ちる）。回答は包みの `.structured_output` に入る。
      #
      # **ツールは解禁しない**（上の表。サンドボックスが書き込みを止めないため）。
      # 差分は従来どおりプロンプトへ載せるので、分割もそのまま要る。
      args=(-p "$(cat "$chunk")
$PROMPT" --output-format json --json-schema "$SCHEMA_FILE")
      if [[ -n "$MODEL" ]]; then
        args=(--model "$MODEL" "${args[@]}")
      fi
      ;;
    codex)
      # 判定に使う入力を `-o`（最後のメッセージ）へ固定する。**stdout の形に頼らない**
      # ——codex exec は見出し・設定・受け取ったプロンプトの復唱を stderr へ出すが
      # （実測）、回答を stdout のどこへ何行で書くかは CLI の版で変わりうる。
      # `-o` は「エージェントの最後のメッセージ」を書く明示の口なので、ここを読む。
      #
      # **失敗すればファイルは作られない**（実測: 401 で落ちた回は -o のファイルが
      # 存在しなかった）。run のループは終了コードで先に落ちるため、無いファイルを
      # 読んで「回答が空」と報告する経路には入らない。
      answer_file="$work_dir/codex-answer.json"

      # `exec -` は指示文を標準入力から読む。標準入力には「差分が先・プロンプトが後」を
      # まとめて渡す（#880。組み立ては下の codex の case）。引数の上限を受けないので
      # 分割も要らない。
      #
      # --sandbox read-only: **ツールの解禁はここが担保する。** 実測で読み取りは通り、
      #   書き込みは `Read-only file system` で失敗する（2026-09-29）。
      # --output-schema: 回答の形を強制する。**これで「出力の最後の行の判定トークン」を
      #   解析する仕組みが要らなくなり、ナレーション 1 行で誤分類する故障クラスが消える**
      #   （`.ai-playbook/review-workflow.md` が「回数を増やしても消えない故障」と
      #   名指ししていたもの。実測: 前置きを書かせても -o は純粋な JSON だった）。
      # --color never: ANSI のエスケープが JSON に混じらないようにする。
      # --ephemeral: 会話の保存を止める。ゲートは 1 日 20〜38 回回るので、保存すると
      #   ~/.codex（rebuild をまたぐ named volume）が毎日育つ。生の出力は #806 の記録が
      #   PR に残すので、失う情報は無い。
      args=(exec - --sandbox read-only --color never --ephemeral \
            --output-schema "$SCHEMA_FILE" -o "$answer_file")
      if [[ -n "$MODEL" ]]; then
        args+=(--model "$MODEL")
      fi
      stdin_file="$chunk"
      ;;
  esac
  return 0
}

# 差分の渡し方はエンジンごとに違う。**どちらも「差分が加工されずモデルへ届くこと」を
# 実測で確かめたうえで選んでいる。** 片方の作法をもう片方へ流用しない。
chunk_files=()

case "$ENGINE" in
  gemini)
    # 差分を CLI の解釈対象へ載せない。stdin や -p へ差分本文を混ぜると、gemini CLI が
    # 本文中の @ をファイル参照（@ メンション）として展開し、モデルには壊れたテキストが
    # 渡る。実測では `noreply@github.com` が `noreply @github.com` に、`*@*` の `@*` が
    # リポジトリ内の実在パスに化けた。モデルは壊れた側を読んで実在しない誤りを致命バグ
    # として報告する。同じ差分なら同じ化け方をするため、多数決でも落とせない。
    # 該当するのは @ を含む差分すべて（メールアドレス、`${arr[@]}`、デコレータ等）。
    #
    # 一時ファイルへ書き、@<パス> で参照させる。@ で注入されたファイルの中身は再展開
    # されないため、差分は素通しでモデルへ渡る（実測済み）。一時ディレクトリは
    # --include-directories で workspace へ加える。加えないと CLI は応答を返さない。
    #
    # モデルにツール実行は不要。信頼済みフォルダの確認は対話を要求するため、
    # 非対話実行では明示的に読み取り専用として扱う。
    CLI="gemini"
    # ファイル参照で渡すため引数長の制限を受けない。分割せず 1 チャンクで扱う。
    chunk_files=("$diff_file")
    ;;
  antigravity)
    # agy は @<パス> をファイル参照として展開しない（実測: `@scripts/verify.sh` /
    # `noreply@github.com` / `${ARR[@]}` を逐語で往復した）。加えて print モードでは
    # 標準入力を読まない（実測: stdin に置いたテキストへ到達できず NO-STDIN を返した）。
    # したがって差分はプロンプトへ直接載せる。gemini 側の「一時ファイル + @ 参照」を
    # 流用すると、agy にはファイル参照の手段が無いためモデルは差分を見ないまま
    # 「差分が空だ」と答える。
    #
    # 引数へ載せる以上、差分の大きさが実行可能性に直結する。上限を超える分は
    # 拒否せず分割してすべてレビューする（SINGLE_ARG_LIMIT の注記）。
    CLI="agy"

    # プロンプトも同じ引数へ載る。差分に使える分はその残り。余裕を 1KB 見る。
    prompt_bytes="$(byte_len "$PROMPT")"
    chunk_limit=$((SINGLE_ARG_LIMIT - prompt_bytes - 1024))
    if [[ "$chunk_limit" -le 0 ]]; then
      echo "error: プロンプトだけで単一引数の上限（$SINGLE_ARG_LIMIT バイト）を超えます" >&2
      exit 1
    fi

    chunk_dir="$work_dir/chunks"
    mkdir -p "$chunk_dir"
    if ! split_diff_into_chunks "$diff_file" "$chunk_dir" "$chunk_limit"; then
      echo "error: 差分を $ENGINE へ渡せる大きさへ分割できませんでした" >&2
      exit 1
    fi
    while IFS= read -r chunk_path; do
      chunk_files+=("$chunk_path")
    done < <(find "$chunk_dir" -maxdepth 1 -name '*.diff' | sort)

    if [[ "${#chunk_files[@]}" -eq 0 ]]; then
      echo "error: 分割結果が空です。検査が成立しないため失敗させます。" >&2
      exit 1
    fi
    ;;
  codex)
    # codex exec は `-` を置くと**指示文そのものを標準入力から読む**（実測:
    # `codex exec - < 入力` で、読んだ本文が復唱された）。
    #
    # **差分は必ず流す**（#880。2026-10-02 に、#804 の「差分は流さず、モデル自身に
    # `git diff` を叩かせる」を改めた）。読み取り専用のサンドボックスが起動しない環境
    # （ユーザー名前空間を禁じたコンテナ）では、ツールの `git diff` が失敗し、差分を
    # 読まないまま回答が返る。差分を先に渡しておけば、ツールが使えなくても差分は読まれる。
    # 並びは「差分が先・プロンプトが後」——プロンプト冒頭の「上記は git の差分です」が
    # 指す先を保つ（上流 ojos/ai-packages-dev#381 と同じ形）。
    #
    # **分割はしない**（1 チャンク）。標準入力なので引数の上限（SINGLE_ARG_LIMIT）を
    # 受けない。効くのはモデルの文脈の上限で、`codex debug models` の context_window は
    # 272,000 トークン（gpt-6-sol。codex-cli 0.159.3 で 2026-10-02 に実測）。main の直近
    # 300 コミットの差分は最大 408,140 バイト・p90 177,768 バイトで、収まる見込み
    # （バイトからトークンへの換算は未実測）。超えたときは CLI が失敗で終わり、run の
    # ループが終了コードで落とす想定（黙って通さない。この経路も未実測）。
    # agy 用の分割を流用しないのは、チャンクごとの過半数で判定が変わり、差分の外を
    # 読める codex にはチャンクの境界が意味を持たないため。
    CLI="codex"
    codex_input="$work_dir/codex-input.txt"
    printf '%s\n\n%s\n' "$diff_text" "$PROMPT" > "$codex_input"
    chunk_files=("$codex_input")
    ;;
esac

# 通過判定は「回答の JSON の `category`」で行う（#804）。
#
# **判定をモデルに出させない。** 以前は「出力の最後の行に置かれた判定トークン」を解析して
# いたが、`.ai-playbook/review-workflow.md` が「**回数を増やしても消えない故障**」と名指しした
# 形——モデルが回答の前に作業ナレーションを 1 行出し、**指摘が 0 件でも 3 回すべてが
# 「指摘あり」に化けた**——は、その解析そのものに起因していた。**構造化出力を強制すれば、
# 仕組みごと消える**（実測: 前置きを書かせても codex の回答は純粋な JSON だった）。
#
# **落とすのは 4 点だけ**（review-workflow.md の限定）。それ以外の category は報告に出すが、
# 判定は動かさない。**規則はここ 1 か所に置く**——プロンプトへ書き写すと、片方だけ直る。
BLOCKING_CATEGORIES='bug vulnerability type-error edge-case'

# **許容する category はスキーマを正本にする。** 2 か所に書くと、片方だけ直る
# （`.ai-playbook/shared-ai-rules.md` 12 章）。スキーマはモデルへ渡す物でもあるので、
# ここから読めば「モデルに許した値」と「こちらが受け付ける値」が必ず一致する。
ALL_CATEGORIES="$(jq -r '.properties.findings.items.properties.category.enum[]' "$SCHEMA_FILE" 2>/dev/null || true)"
if [[ -z "${ALL_CATEGORIES//[[:space:]]/}" ]]; then
  echo "error: スキーマから category の一覧を読めませんでした: $SCHEMA_FILE" >&2
  exit 1
fi

# **落とす 4 つがスキーマに無ければ止める。** 綴りを変えたときに、どちらか片方だけが
# 変わると「落とすはずの指摘が 1 件も一致しない」形で静かに緑になる。
for __category in $BLOCKING_CATEGORIES; do
  if ! printf '%s\n' "$ALL_CATEGORIES" | grep -qx -- "$__category"; then
    echo "error: 落とす category '$__category' がスキーマの enum にありません（規則とスキーマがずれています）" >&2
    exit 1
  fi
done

# 回答から JSON を取り出す。エンジンごとに包みが違うのはここだけ。
#
#   codex        `-o` のファイルがそのまま JSON（スキーマで強制済み）
#   antigravity  stdout が包みで、回答は `.structured_output`（スキーマで強制済み）
#   gemini       **強制する旗が無い**（`--json-schema` に当たるものが `gemini --help` に無い。
#                2026-09-29 に実測）。本文から JSON を取り出す。読めなければ落とす
extract_answer_json() {
  local raw="$1" candidate
  case "$ENGINE" in
    codex)
      printf '%s' "$raw"
      return 0
      ;;
    antigravity)
      printf '%s' "$raw" | jq -c '.structured_output' 2>/dev/null || true
      return 0
      ;;
  esac

  # **スキーマを強制できないエンジンは、前置きを付けて返すことがある**（第二意見の指摘。
  # 実在）。`これから確認します。` の 1 行が先に付くだけで、回答全体を jq へ渡す形だと
  # 解析に失敗し、**指摘が 0 件でもゲートが落ちる**——acceptance が消したかった
  # 「ナレーションによる誤分類」が、この経路にだけ残ることになる。
  #
  # **3 通りを順に試し、最初に JSON として読めたものを採る。** 3 番目は「最初の `{` から
  # 最後の `}` まで」で、awk の貪欲一致で取る（mawk / BSD awk とも `.` が改行に当たることを
  # 実測済み）。**「読めた」の判定は 1 か所（answer_is_valid）に任せる**——ここで別の
  # 判定を書くと、通す条件が 2 か所になる。
  for candidate in \
    "$raw" \
    "$(printf '%s' "$raw" | sed -n '/^[[:space:]]*```/,/^[[:space:]]*```/p' | sed '1d;$d')" \
    "$(printf '%s' "$raw" | awk 'BEGIN{RS="\0"} { if (match($0, /\{.*\}/)) print substr($0, RSTART, RLENGTH) }')"
  do
    if [[ -n "${candidate//[[:space:]]/}" ]] && answer_is_valid "$candidate"; then
      printf '%s' "$candidate"
      return 0
    fi
  done

  # どれも読めなければ、生のまま返す（呼び出し元が落として、生の出力を見せる）。
  printf '%s' "$raw"
}


# 形が満たされているかを見る。**「読めなかった」を「指摘なし」にしない**——
# 読めないまま通すと、レビューしていないものを緑として報告することになる。
#
# **category の値まで見る**（第二意見の指摘。実在）。配列であることしか見ないと、
# **スキーマを強制できないエンジン**（gemini には `--json-schema` に当たる旗が無い）で
# `category: "bugs"` のような綴り違いが来たときに、**検証を通ったうえで「落とす指摘 0 件」と
# 数えられ、ゲートが緑になる。** 知らない category は「重さが分からない」ということなので、
# 指摘なしへ倒さず、読めなかったものとして落とす。
answer_is_valid() {
  local allowed
  allowed="$(printf '%s\n' "$ALL_CATEGORIES" | jq -R . | jq -s -c .)"
  printf '%s' "$1" | jq -e --argjson allowed "$allowed" '
    type == "object"
    and (.reviewed | type == "boolean")
    and (.findings | type == "array")
    and (all(.findings[]; type == "object"
             and (.category | type == "string")
             and (.category as $c | $allowed | index($c) != null)
             and (.what | type == "string")
             and (.why | type == "string")
             and (.file | type == "string")
             and (.line | type == "number")))
  ' >/dev/null 2>&1
}

# 落とす指摘の数。
#
# **`paste -sd ' or '` で連結しない。** `-d` は「区切り文字の並び」を 1 文字ずつ循環して
# 使う指定なので、`' or '` を渡すと空白・空白・`o`・`r`・空白 が順に使われ、
# `... "type-error"o.category ...` のような壊れたフィルタになる（実測。仕込みの検査で
# jq が構文エラーになり、全ケースが exit 3 で落ちて気づいた）。
blocking_count() {
  local filter="" category
  for category in $BLOCKING_CATEGORIES; do
    if [[ -n "$filter" ]]; then
      filter="$filter or "
    fi
    filter="$filter.category == \"$category\""
  done
  printf '%s' "$1" | jq "[.findings[] | select($filter)] | length"
}

# 人が読む形にする。**報告は 4 点の外も出す**（#804 の「報告の範囲を広げる」）。
print_findings() {
  printf '%s' "$1" | jq -r '.findings[] |
    "  [" + .category + "] " + (if .file == "" then "(場所の特定なし)" else .file + ":" + (.line | tostring) end) + "\n" +
    "    何が: " + .what + "\n" +
    "    なぜ: " + .why'
}


threshold=$((RUNS / 2 + 1))

chunk_total="${#chunk_files[@]}"
chunk_index=0
chunks_with_findings=0
minority_findings=0

if [[ "$chunk_total" -gt 1 ]]; then
  echo "[second-opinion] 差分が単一引数の上限を超えるため $chunk_total 個へ分割してレビューします"
fi

for chunk_file in "${chunk_files[@]}"; do
  chunk_index=$((chunk_index + 1))
  build_args "$chunk_file"

  # 分割していないときは従来どおりの表示にする。無条件に「1/1」を出すと、
  # 分割が起きたかどうかがログから読み取れなくなる。
  if [[ "$chunk_total" -gt 1 ]]; then
    chunk_label=" chunk $chunk_index/$chunk_total"
  else
    chunk_label=""
  fi

  findings=0
  run=0
  while [[ "$run" -lt "$RUNS" ]]; do
    run=$((run + 1))

    # CLI の警告や進捗表示は「回答」ではない。判定へ混ぜると、警告が 1 行出ただけで
    # LGTM が指摘ありに化け、ゲートが常に赤くなる（実測: 端末の色数や ripgrep 不在の
    # 警告が stderr に出る）。判定はモデルの回答（stdout）だけで行い、stderr は失敗
    # したときの診断に回す。標準入力は codex にだけ渡す（$stdin_file の注記）。
    # **回答のファイルは呼び出しの直前に消す。** build_args は 1 チャンクに 1 回しか
    # 走らないので、そこで消すだけでは `--runs 2` 以上のときに 2 回目が 1 回目の回答を
    # 読む——**0 で終わりながら -o を書かなかった回が、前の回の判定で通る**（下の
    # 「回答が無ければ失敗させる」を素通りする。Copilot の指摘。実在）。
    if [[ "$ENGINE" == "codex" ]]; then
      rm -f "$answer_file"
    fi

    output="$($CLI "${args[@]}" <"$stdin_file" 2>"$stderr_file")" || {
      echo "error: second opinion failed (engine=$ENGINE,$chunk_label run $run/$RUNS)" >&2
      cat "$stderr_file" >&2
      printf '%s\n' "$output" >&2
      exit 1
    }

    # codex は回答を stdout ではなく -o のファイルへ取る（build_args の注記）。
    # **無ければ失敗させる。** 0 で終わったのにファイルが無いのは、判定の入力が
    # 無いということで、「回答が空」として指摘あり側へ倒すと理由が読めなくなる。
    if [[ "$ENGINE" == "codex" ]]; then
      if [[ ! -f "$answer_file" ]]; then
        echo "error: codex が最後のメッセージを書きませんでした（-o のファイルが無い。engine=$ENGINE,$chunk_label run $run/$RUNS）" >&2
        cat "$stderr_file" >&2
        exit 1
      fi
      output="$(cat "$answer_file")"
    fi

    # 回答が空でも終了コードが 0 になる経路がある。実測では、agy がツールの実行許可を
    # 求めて非対話では承認できず自動拒否し、「回答なし」を stderr へ書いて 0 で終えた。
    # **いまは空の回答は JSON として読めないので下で落ちる**が、原因（CLI の診断）は
    # ここで見せておく。落ちた理由が「形が違う」だけに見えると、原因を追えない。
    if [[ -z "${output//[[:space:]]/}" && -s "$stderr_file" ]]; then
      echo "[second-opinion]$chunk_label run $run/$RUNS: モデルの回答が空です。CLI の診断:" >&2
      cat "$stderr_file" >&2
    fi

    # 回答（JSON）を取り出して判定する。**形が満たされていなければ落とす**
    # ——「読めなかった」を「指摘なし」に倒すと、レビューしていないものが緑になる。
    answer_json="$(extract_answer_json "$output")"
    if ! answer_is_valid "$answer_json"; then
      echo "error: 回答を JSON として読めませんでした（engine=$ENGINE,$chunk_label run $run/$RUNS）。生の出力:" >&2
      printf '%s\n' "$output" >&2
      if [[ -s "$stderr_file" ]]; then
        echo "--- CLI の診断 ---" >&2
        cat "$stderr_file" >&2
      fi
      exit 1
    fi

    # **差分を読めなかった回答は、指摘の中身によらず落とす**（#873）。`other` の指摘
    # だけを返して LGTM になると、読んでいないものがレビュー済みとして記録される。
    # **LGTM / findings の行を出さない。** loop-gate.sh はその行が無い出力を「判定に
    # 到達しなかった」として記録しないので、確認側（second-opinion-gate.yml）が赤を出せる。
    if [[ "$(printf '%s' "$answer_json" | jq -r '.reviewed')" != "true" ]]; then
      echo "error: 第二意見が差分を読めなかったと答えました（engine=$ENGINE,$chunk_label run $run/$RUNS）。レビューは成立していません:" >&2
      print_findings "$answer_json" >&2
      if [[ -s "$stderr_file" ]]; then
        echo "--- CLI の診断 ---" >&2
        cat "$stderr_file" >&2
      fi
      exit 1
    fi

    # どの run が何を報告したかを追えるようにする。集約結果だけを出すと、
    # 過半数に届かなかった指摘が消えて確認できなくなる。
    #
    # **報告は 4 点の外も出し、判定は 4 点だけで行う**（#804）。
    blocking="$(blocking_count "$answer_json")"
    total="$(printf '%s' "$answer_json" | jq '.findings | length')"
    if [[ "$blocking" -eq 0 ]]; then
      if [[ "$total" -eq 0 ]]; then
        echo "[second-opinion]$chunk_label run $run/$RUNS: LGTM"
      else
        # 落とさない指摘（promise-mismatch / other）は、通したうえで見せる。
        echo "[second-opinion]$chunk_label run $run/$RUNS: LGTM（落とさない指摘が $total 件）"
        print_findings "$answer_json"
      fi
    else
      findings=$((findings + 1))
      echo "[second-opinion]$chunk_label run $run/$RUNS: findings（落とす $blocking 件 / 全 $total 件）"
      print_findings "$answer_json"
    fi
  done

  # 判定はチャンクごとに過半数で行い、1 つでも指摘ありなら全体を指摘ありとする。
  # 全チャンクの run を合算して過半数を取ると、片方のチャンクだけが確実に指摘を
  # 出していても、他方の LGTM に薄められて通過しうる。
  if [[ "$findings" -ge "$threshold" ]]; then
    chunks_with_findings=$((chunks_with_findings + 1))
  elif [[ "$findings" -gt 0 ]]; then
    minority_findings=$((minority_findings + 1))
  fi
done

if [[ "$chunks_with_findings" -eq 0 ]]; then
  if [[ "$chunk_total" -gt 1 ]]; then
    echo "[second-opinion] LGTM ($chunk_total チャンクすべてが閾値 $threshold/$RUNS 未満)"
  else
    echo "[second-opinion] LGTM ($findings/$RUNS runs reported findings; threshold $threshold)"
  fi
  # 過半数に届かなくても、指摘があった事実は伏せない。誤検出とは限らない。
  if [[ "$minority_findings" -gt 0 ]]; then
    echo "[second-opinion] note: 少数の run が指摘しています。内容は上に出ています。" >&2
  fi
  exit 0
fi

echo "[second-opinion] findings reported in $chunks_with_findings/$chunk_total chunk(s) (threshold $threshold/$RUNS runs)." >&2
echo "[second-opinion] fix them in a single iteration before push." >&2
exit 1
