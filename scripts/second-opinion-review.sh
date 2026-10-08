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
#
#   gemini       gemini CLI。API キー認証（GEMINI_API_KEY）。既定。構造化出力を
#                強制する旗を持たないため、従来どおり「出力の最後の行の判定
#                トークン」方式で判定する（下記「通過判定」）。ツールは解禁しない
#   antigravity  Antigravity CLI（agy）。Google アカウントの OAuth 認証。API キー
#                非対応。構造化出力を `--json-schema` で強制できるため、判定は
#                JSON（下記「通過判定（JSON スキーマ方式）」）で行う。ツールは
#                解禁しない（下記「ツールの解禁」）
#   codex        Codex CLI（codex exec）。ChatGPT アカウントの OAuth 認証（または
#                API キー）。`--output-schema` で構造化出力を強制できるため、
#                判定は JSON で行う。**読み取り専用サンドボックスでツールを解禁する**
#                唯一のエンジン（下記「ツールの解禁」）
#
# ツールの解禁:
#   ツールを解禁するのは、読み取り専用サンドボックスが実際に書き込みを止めることを
#   確かめられたエンジンだけに限る。旗の名前（「plan」「read-only」等）だけでは
#   実際に止まるかどうかは分からない——名前から読み取れることと実際の動作は別である。
#
#   codex は `--sandbox read-only` を使う。書き込み系のシステムコールを拒否し、
#   読み取り系（`git diff` 等）だけを許可するサンドボックスで、ユーザー名前空間
#   （Linux）や Seatbelt（macOS）といった OS 機構に依存する。ユーザー名前空間の
#   作成を禁止する環境（コンテナの seccomp 制限等）では、サンドボックスの初期化
#   自体が失敗し、**読み取りを含めてコマンドが一切実行できない**（fail-closed。
#   認証不要の `codex sandbox` サブコマンドで直接確認した）。書き込みが素通りする
#   形には振れず、動かないか止まるかのどちらかである。
#
#   antigravity には対応する旗が無い。`--mode plan` は名前が「計画のみ」を示すが、
#   `--dangerously-skip-permissions` と併せて使うと実際にファイルへ書き込めた
#   （確認用の書き込みが実際に成立した）。**止めない旗をツール解禁の根拠にはしない。**
#   したがって antigravity は差分をプロンプトへ埋め込む従来の形を保ち、ツールは
#   解禁しない。
#
#   ツールを解禁したエンジン（codex）にも、差分は標準入力で必ず渡す。ツールは
#   差分の外のファイル・テスト・宣言を読むための補助にとどめる。読み取り専用の
#   サンドボックスは、ユーザー名前空間を禁じたコンテナでは起動せず、読み取りの
#   コマンドも含めて一切実行できない（実測）。差分の取得までツールに任せると、
#   その環境では差分を見ないまま回答が返る。標準入力なので引数の上限は受けず、
#   チャンク分割は要らない。
#
# 判定のぶれについて:
#   このレビューは非決定的で、同じ差分でも実行のたびに結果が変わる。いずれの CLI にも
#   temperature / seed に相当するオプションは無く、フラグでは決定化できない。
#   1 回だけ実行して通過とみなすと、見落としをそのまま通す。
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
#   **構造化出力を強制できるエンジン（antigravity / codex）では、判定トークンを
#   解析する工程そのものが無いため、この故障クラスは構造的に起きない。** 強制する
#   旗を持たない gemini では、従来どおり判定側で受ける（下記「通過判定」）。
#
# 分割について:
#   antigravity は差分をコマンドライン引数へ直接載せる（gemini は一時ファイルを
#   @<パス> で参照させるため、引数へ載るのはパス文字列だけで対象外。codex は
#   ツールを解禁したため差分そのものを渡さない）。引数 1 個あたりには Linux の
#   MAX_ARG_STRLEN（カーネル定数: PAGE_SIZE * 32。既定は 131,072 バイト）という
#   固定上限があり、これは合計を制限する ARG_MAX とは別物。実測でも「10 万バイトの
#   引数を 20 個渡す（合計 200 万バイト）」は通り、「単一引数が 131,073 バイト」は
#   E2BIG で落ちた。合計ではなく 1 引数が基準。
#
#   上限を超える差分は、範囲を分けるようユーザーへ求めて終わらせない。生成物
#   （ロックファイル等）を含む差分は、範囲を分けても 1 ファイルの差分自体が
#   上限を超えることがあり、それだと永久にレビューできない。ファイル単位を基本に
#   複数ファイルを 1 チャンクへ詰め、1 ファイルの差分だけで上限を超える場合に
#   限りハンク単位へ落とす（ハンクごとにファイルヘッダを付け直す。付けないと
#   モデルがどのファイルの変更か判断できない）。
#
#   分割できない単位（1 ハンクだけで上限を超える、ハンクを持たない二値・モード
#   変更のみの差分）は黙って切り詰めない。切り詰めると、レビューしていない
#   部分を緑として報告することになる。該当ファイル名を添えて失敗させる。
#
#   チャンクが複数あるときは、全チャンクの run を合算して過半数を取らない。
#   片方のチャンクが確実に指摘していても、他方の LGTM に薄められて通過しうる。
#   チャンクごとに過半数を取り、1 つでも指摘ありなら全体を指摘ありとする。
#
# 通過判定（出力の最後の行の判定トークン方式。gemini）:
#   出力の最後の行に置かれた判定トークン `VERDICT: LGTM` を通過とみなす。
#   出力全体の一致では判定しない（前置きが 1 行出ただけで偽の赤になる）。
#   行の存在でも判定しない（指摘と併記された LGTM で偽の緑になる）。
#   理由の詳細は is_lgtm のコメントに置く。
#
# 通過判定（JSON スキーマ方式。antigravity / codex）:
#   モデルには**通過・不通過の判定そのものを出させない。** 回答は
#   `scripts/second-opinion-schema.json` が強制する JSON で、中身は指摘の配列
#   だけである。**どの指摘を落とすかは、指摘の種別（category）を見てこのスクリプト
#   が決める。** category が `bug` / `vulnerability` / `type-error` / `edge-case`
#   のいずれかの指摘が 1 件以上あれば落とす。この 4 点は両エンジン・両方式を通じて
#   「両段に共通する制約」（review-workflow.md）と同じである。
#
#   **報告の範囲は判定の範囲より広い。** `promise-mismatch`（参照した issue / PR の
#   状態と実際の変更の食い違い）と `other`（その他、次に読む人へ伝える価値がある
#   指摘）は出力に表示するが、通過判定は動かさない。報告を広げても、落とす基準は
#   4 点のまま据え置く。
#
#   **JSON として読めない回答、スキーマの形を満たさない回答、スキーマに無い
#   category の回答は、いずれも「指摘なし」ではなく失敗として扱う。** 読めなかった
#   ものを緑として報告すると、レビューしていないものを通すことになる。
#
#   **差分を読めなかったと答えた回答（`reviewed: false`）も、指摘の中身によらず
#   同じ扱いにする。** `git diff` などの失敗を `other` の指摘 1 件で報告しただけの
#   回答は、category だけを見ると判定を動かさないため LGTM になり、読んでいない
#   ものがレビュー済みとして記録されてしまう（game-forge #873）。このときは
#   完了の行（`[second-opinion] LGTM (...)` 等）を出さない。loop-gate.sh の記録は
#   その行の有無で「判定に到達したか」を見るため、出さなければ記録も残らない。
#
# issue / PR の文脈:
#   ブランチ名が issue 番号を含む形（`feat/123-...` 等）なら、その issue の本文
#   （scope・acceptance を含む）をプロンプトへ載せる。加えて、差分の追加行と
#   コミットメッセージが参照する `#番号`（リポジトリへの書き込み権を持つ人が作成したものに限り、
#   上限件数まで）についても、状態と（issue なら）acceptance の節を取得して載せる。
#   いずれも `gh` 経由で、取得できなくても止めない（ゲートではないため）。
#
# 終了コード:
#   0 = 通過（過半数の run が指摘なし。push 可）
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
  codex        Codex CLI（codex exec）。ChatGPT アカウントの OAuth 認証（または API キー）。
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

# エンジンの能力フラグ。「ツールを解禁するか」「判定を JSON スキーマ方式で
# 行うか」はエンジンごとに固定で、利用者が選べる値ではない（上記ヘッダ「ツールの
# 解禁」参照）。既定は両方 0（従来どおり、差分を渡し判定トークンで判定する）。
ENGINE_TOOLS=0
ENGINE_JSON=0

# 判定を JSON で行うエンジンが強制する回答の形。判定そのものはモデルに出させず、
# category から下の BLOCKING_CATEGORIES を見てこのスクリプトが決める。
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
    #
    # ツールは解禁しない（`--mode plan` は書き込みを止めないことを確認済み。上記
    # ヘッダ「ツールの解禁」）。構造化出力は `--json-schema` で強制できる。
    ENGINE_JSON=1
    ;;
  codex)
    command -v codex >/dev/null 2>&1 || {
      echo "error: codex (Codex CLI) not found. codex を導入してログインしてから再実行してください（導入手段はプロジェクト層で定義します）" >&2
      exit 1
    }
    # codex は OAuth（ChatGPT アカウント）と API キーの両方を受けるため、どちらで
    # 入っているかを問わず、資格情報の有無だけを見る。`codex login status` が
    # 有無を終了コードで返す。
    #
    # ここで見ないと失敗が遅い。未ログインのまま exec へ進むと、CLI は再接続を
    # 試したうえで認証エラーで落ちる。レビューの前段で時間を捨て、しかも
    # 出てくるのは「回答が空」に近い形なので、ログインしていないことが読み取りにくい。
    codex login status >/dev/null 2>&1 || {
      echo "error: codex にログインしていません。'codex login' を対話で 1 度通してから再実行してください" >&2
      exit 1
    }
    # モデルの既定を CLI に任せない。CLI 既定のモデルは Plus 等の低い枠に当たりやすく、
    # 既定のまま回すと、枠に当たって初めて分かる。gpt-6-sol は同じ契約でも枠が広い
    # （プロジェクト層で確かめた既定値）。
    if [[ -z "$MODEL" ]]; then
      MODEL="gpt-6-sol"
    fi
    # サンドボックスが実際に書き込みを止めることを確認済みのエンジンなので
    # ツールを解禁する（上記ヘッダ「ツールの解禁」）。構造化出力は
    # `--output-schema` で強制できる。
    ENGINE_TOOLS=1
    ENGINE_JSON=1
    ;;
  *)
    echo "error: unknown engine: $ENGINE（gemini | antigravity | codex）" >&2
    exit 1
    ;;
esac

# JSON スキーマ方式のエンジンだけが、スキーマファイルと jq を要る。gemini だけを
# 使う導入では jq も second-opinion-schema.json も要らないため、ここで無条件に
# 要求しない。
if [[ "$ENGINE_JSON" -eq 1 ]]; then
  [[ -f "$SCHEMA_FILE" ]] || {
    echo "error: 回答のスキーマが見つかりません: $SCHEMA_FILE" >&2
    exit 1
  }
  command -v jq >/dev/null 2>&1 || {
    echo "error: jq が無いため回答（JSON）を読めません。jq を導入してから再実行してください" >&2
    exit 1
  }

  # **落とす 4 点はこのスクリプトが決め、スキーマは「モデルに許す category」を
  # 決める。** 2 か所に書くと片方だけ直る（shared-ai-rules.md「正本は 1 つ」）ので、
  # 許す側の一覧はスキーマから読み、落とす側の 4 点がそこに含まれることを確かめる。
  BLOCKING_CATEGORIES='bug vulnerability type-error edge-case'
  ALL_CATEGORIES="$(jq -r '.properties.findings.items.properties.category.enum[]' "$SCHEMA_FILE" 2>/dev/null || true)"
  if [[ -z "${ALL_CATEGORIES//[[:space:]]/}" ]]; then
    echo "error: スキーマから category の一覧を読めませんでした: $SCHEMA_FILE" >&2
    exit 1
  fi
  for __category in $BLOCKING_CATEGORIES; do
    if ! printf '%s\n' "$ALL_CATEGORIES" | grep -x -- "$__category" >/dev/null; then
      echo "error: 落とす category '$__category' がスキーマの enum にありません（規則とスキーマがずれています）" >&2
      exit 1
    fi
  done
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

# レビューの文脈。ブランチ名から issue 番号を取り、scope と acceptance を
# プロンプトへ載せる。これが無いと、第二意見は「この変更が何を約束したか」を
# 知らないまま差分だけを読むことになり、約束と食い違う変更を原理的に拾えない。
#
# **ゲートではないので、取れなくても止めない。** 取れなかったことは出力に出す
# （黙って「文脈つきでレビューした」ことにしない）。
issue_context=""
branch_issue_num=""
resolve_issue_context() {
  local branch num body
  branch="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || true)"
  # feat/123-... / fix/456-... のような形から数字を取る。枝の名前に数字が無ければ
  # 何もしない（推測で別の issue を引かない）。
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
  if ! body="$(gh issue view "$num" --json title,body --jq '"# issue #'"$num"' " + (.title // "") + "\n\n" + (.body // "")' 2>/dev/null)"; then
    echo "[second-opinion] issue #$num を引けませんでした（文脈なしでレビューします）" >&2
    return 0
  fi
  issue_context="$body"
  echo "[second-opinion] issue #$num の scope と acceptance を文脈に載せます"
}
resolve_issue_context

# 差分とコミットメッセージが参照している issue / PR の文脈。他の issue / PR の
# 状態（未マージ・完了・日付等）を知らないと出せない指摘があり、`gh` はこのスクリプト
# の外（ネットワークを遮断するサンドボックスの外）で読む必要があるため、ここで
# 引いてプロンプトへ載せる。
#
# 絞り方:
#   - 拾うのは**差分の追加行とコミットメッセージだけ**。削除行や文脈行の番号は、
#     この変更が主張していることではない
#   - **作成者の author_association が OWNER / MEMBER / COLLABORATOR のものだけ**。
#     public なので部外者の文がプロンプトへ入りうる。「リポジトリの持ち主の login と
#     一致するか」で絞らない——組織所有のリポジトリでは持ち主は組織名で、個人の
#     login と一致することがなく、すべての参照が除外される
#   - issue は「状態・タイトル・acceptance の節」、PR は「状態・タイトル」だけ。
#     本文全体は載せない（消費と、古い本文による誤検出を抑える）
#   - **上限は REFERENCED_LIMIT 本。超えた分は捨てたと出す**
#   - 引けなくても止めない（ゲートではない）。引けなかったことは出す
REFERENCED_LIMIT=10
referenced_context=""

# 1 行ずつ読み、`#123` の番号だけを出す。`&#123;`（HTML の実体参照）、`#fff`、
# URL の断片（`/#12`）、6 桁以上（色の `#000000`）は拾わない。GNU 拡張は使わない
# （grep の `\b` や `-P` に頼らない。配布先の端末が macOS であることがある）。
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

# issue の本文から acceptance の節（intake の YAML の `acceptance:` から次のキーまで）
# を出す。
extract_acceptance() {
  tr -d '\r' | awk '
    /^acceptance:/ { on = 1; print; next }
    on && (/^[A-Za-z_.]+:/ || /^```/) { exit }
    on { print }
  '
}

resolve_referenced_context() {
  local refs nums n kept dropped rejected unreadable json association title state acc
  # コミットメッセージを先に置く。「(#123)」のように、変更が名指しした番号が
  # 先頭に来る。**範囲（A..B）のときだけ**ログを読む。単独のリビジョンに git log を
  # 当てると履歴の全部を読むことになる。
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
    # issues の API は PR も返す（`.pull_request` の有無で分かれる。`merged_at` も
    # 同じ API に入っている）。1 番号 1 呼び出し。
    if ! json="$(gh api "repos/{owner}/{repo}/issues/$n" 2>/dev/null)" \
        || ! association="$(printf '%s' "$json" | jq -er '.author_association' 2>/dev/null)"; then
      unreadable="$unreadable#$n "
      continue
    fi
    # 書き込み権を持つ人（持ち主・組織のメンバー・共同編集者）が書いたものだけを載せる。
    case "$association" in
      OWNER|MEMBER|COLLABORATOR) ;;
      *) association="" ;;
    esac
    if [[ -z "$association" ]]; then
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
    echo "[second-opinion] 作成者がリポジトリへの書き込み権を持たないため載せません: ${rejected% }"
  fi
  if [[ -n "$unreadable" ]]; then
    echo "[second-opinion] 引けなかったため載せません: ${unreadable% }" >&2
  fi
}
resolve_referenced_context

# 文脈（枝の issue の全文と、参照された issue / PR の要約）をプロンプトの末尾へ
# 足す。エンジンによって本文は分かれるが、文脈の足し方は分けない。
append_context() {
  if [[ -n "$issue_context" ]]; then
    PROMPT="$PROMPT

この変更が満たすべき約束（issue の本文。**scope と acceptance に注目**してください）:

$issue_context"
  fi
  if [[ -n "$referenced_context" ]]; then
    PROMPT="$PROMPT

差分とコミットメッセージが参照している issue / PR（取得時点の状態と、issue の
acceptance の節だけ。本文の全文ではありません）。**変更の記述（未マージ・完了・
日付・acceptance の番号など）がこれと食い違っていないか**を確かめてください:
$referenced_context"
    if [[ "$ENGINE_JSON" -eq 1 ]]; then
      PROMPT="$PROMPT

食い違いは \`promise-mismatch\` で報告してください。"
    fi
  fi
}

# JSON スキーマ方式（antigravity / codex）が共有する報告の規則。判定トークン
# 方式（gemini）とはここで分ける——判定をモデルに出させず、報告の範囲も広げるため、
# 本文そのものが違う。
read -r -d '' REPORT_RULES_JSON <<'EOF' || true
報告してよいもの（`category` の値）:
- `bug`（致命バグ） / `vulnerability`（脆弱性） / `type-error`（型エラー） / `edge-case`（エッジケースの見落とし）
  … **この 4 つだけがゲートを落とします。**
- `promise-mismatch` … 文脈（issue の scope / acceptance、参照された issue・PR の状態）と、実際の変更が食い違う点（**報告のみ**）
- `other` … 上記以外で、次に読む人へ伝える価値があるもの（**報告のみ**）

報告しないもの:
- 好みのリファクタリング
- 命名や可読性の軽微な提案
- 差分と関係のない既存コードの問題

出力:
- **JSON だけを返してください。** 指摘が無ければ `findings` は空の配列です。
- **通す / 落とすの判定は書かないでください。** `category` を見てこちらで決めます。
- `reviewed` には、差分を実際に読んでレビューできたかを書いてください。コマンドが失敗した・
  差分が空だったなどで**読めなかったときは `false`** にし、読めなかった理由を `other` の指摘で書いてください。
  読めなかったのに `true` にしたり、指摘を空にして済ませたりしないでください。
- 前置きや作業の説明は書かないでください。
EOF

if [[ -n "$RANGE" ]]; then
  diff_cmd="git diff $RANGE"
else
  diff_cmd="git diff --cached"
fi

# ゲート対象は review-workflow.md の限定に合わせる。本文を分けるのは
# ENGINE_JSON（判定トークン方式か JSON スキーマ方式か）と ENGINE_TOOLS
# （ツールを解禁しているか）の 2 つの能力フラグで、エンジン名そのものでは分けない
# ——能力が増減したらフラグ側を直せば、本文の分岐はそのまま追随する。
if [[ "$ENGINE_JSON" -eq 0 ]]; then
  # 判定トークン方式（gemini）。差分はプロンプトへ埋め込み、ツールは使わせない。
  #
  # 先頭に空行を置かない。かつては `read -r -d '' PROMPT <<'EOF'` で読んでおり、
  # read は単一変数への読み込みで前後の IFS 空白（改行を含む）を落とす。この
  # 代入へ変えたとき先頭に空行を残すと、$PROMPT の実体にだけ改行 1 個が増え、
  # バイト数で境界を扱う処理（antigravity の分割）や、差分と $PROMPT の区切りを
  # 1 個の改行に固定している箇所の前提と食い違う。
  PROMPT="上記は git の差分です。コードレビューを行ってください。

指摘対象は次の 4 点に限定します。それ以外は報告しないでください。
- 致命バグ
- 脆弱性
- 型エラー
- エッジケースの見落とし

報告しないもの:
- 好みのリファクタリング
- 命名や可読性の軽微な提案
- 差分の範囲外にある既存コードの問題

レビューに必要な情報はこのプロンプトに含まれています。**ファイル読み取りやコマンド実行のツールを使わないでください。** ツールの実行は非対話実行では承認できず、拒否されると回答そのものが返らなくなります。

出力形式:
- **出力の最後の行**に、次のいずれかの判定トークンを必ず 1 行で書いてください。
  - 上記 4 点に該当する指摘が 1 件もない場合: \`VERDICT: LGTM\`
  - 指摘がある場合: \`VERDICT: FINDINGS\`
- 指摘がある場合は、判定トークンより前に、各指摘について「該当ファイルと行」「何が問題か」「なぜ問題か（再現条件や影響）」を簡潔に記述してください。
- 通過判定は最後の行だけで行います。判定トークンの無い出力は指摘ありとして扱います。"
elif [[ "$ENGINE_TOOLS" -eq 0 ]]; then
  # JSON スキーマ方式だがツールは解禁しない（antigravity）。差分はプロンプトへ
  # 埋め込む（従来どおり分割の対象になる）。先頭に空行を置かない理由は
  # gemini の分岐と同じ（$PROMPT の実体に不要な改行を増やさない）。
  PROMPT="上記は git の差分です。コードレビューを行ってください。

レビューに必要な情報はこのプロンプトに含まれています。**ファイル読み取りやコマンド実行のツールを使わないでください。** ツールの実行は非対話実行では承認できず、拒否されると回答そのものが返らなくなります。

$REPORT_RULES_JSON"
else
  # JSON スキーマ方式で、かつツールを解禁する（codex）。
  #
  # **差分は標準入力で必ず渡す。ツールは差分の外を読むための補助にとどめる。**
  # 読み取り専用のサンドボックスは、実行環境によって起動しない（ユーザー名前空間の
  # 作成を禁じたコンテナでは、サンドボックス自体が立ち上がらず、読み取りのコマンドも
  # 含めて一切実行できない。実測）。差分の取得までモデルのツールに任せると、その
  # 環境では差分を 1 行も見ないまま回答が返り、中身の無いレビューが通る。差分を
  # 先に渡しておけば、ツールが使えない環境でも差分そのものは必ずレビューされる。
  # 標準入力なので引数の上限は受けず、分割は要らない。
  PROMPT="上記はこのリポジトリの git の差分です（\`$diff_cmd\` の出力）。コードレビューを行ってください。

**読み取りのコマンドとファイル読み取りを使ってよい**です。差分の外のファイル・テスト・
宣言・ドキュメントも読み、**事実を確かめてから**報告してください（推測で書かない）。
**書き込みはできません**（サンドボックスが読み取り専用です）。
**コマンドが実行できない環境でも、上の差分だけでレビューを完結させてください。**
その場合、差分の外を確かめられなかったことを理由に指摘を作らないでください。

$REPORT_RULES_JSON"
fi
append_context

echo "[second-opinion] reviewing $scope (engine=$ENGINE, runs=$RUNS)"

# 一時領域は全エンジンで使う。gemini は差分の受け渡しに、antigravity は分割した
# チャンクの置き場に、codex は標準入力へ流すファイルと -o の回答先に、全エンジンとも
# stderr の退避に。テンプレートを明示する。BSD 系（macOS）の mktemp はテンプレート
# 無しの呼び出しを受け付けず、この雛形は Linux 以外へ配布されうる。
work_dir="$(mktemp -d "${TMPDIR:-/tmp}/second-opinion.XXXXXX")"
diff_file="$work_dir/review.diff"
stderr_file="$work_dir/stderr"
trap 'rm -rf "$work_dir"' EXIT
printf '%s\n' "$diff_text" > "$diff_file"

# codex 専用の受け渡し口。他の 2 エンジンは使わないため /dev/null のまま残す。
#
# stdin_file: codex exec へ渡す標準入力の指し先。run のループが
#   `<"$stdin_file"` で開くため、空にしない（空だとリダイレクトそのものが失敗する）。
# answer_file: codex の「最後のメッセージ」（-o の出力）の置き場所。空なら未使用。
#   消すのは run のループの側（build_args 相当の組み立ては 1 チャンクに 1 回しか
#   走らないため、ここで消すだけでは --runs 2 以上のときに前の回の回答を読む）。
stdin_file="/dev/null"
answer_file=""

# 差分の渡し方はエンジンごとに違う。**いずれも「差分が加工されずモデルへ届くこと」を
# 実測で確かめたうえで選んでいる。** 1 つの作法を他へ流用しない。
#
# chunk_paths は「1 回の CLI 呼び出しへ渡す差分の単位」の一覧。gemini と codex は
# 常に 1 要素（差分全体を指す一時ファイル）で、分割の対象外（gemini はファイル参照、
# codex は標準入力で渡すため、どちらも引数長の制限を受けない）。antigravity だけが
# 複数要素になりうる。
chunk_paths=()
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
    chunk_paths=("$diff_file")
    ;;
  antigravity)
    # agy は @<パス> をファイル参照として展開しない（実測: `@scripts/verify.sh` /
    # `noreply@github.com` / `${ARR[@]}` を逐語で往復した）。加えて print モードでは
    # 標準入力を読まない（実測: stdin に置いたテキストへ到達できず NO-STDIN を返した）。
    # したがって差分はプロンプトへ直接載せる。gemini 側の「一時ファイル + @ 参照」を
    # 流用すると、agy にはファイル参照の手段が無いためモデルは差分を見ないまま
    # 「差分が空だ」と答える。
    #
    # 引数へ載せる以上、差分の大きさが実行可能性に直結する。E2BIG は
    # 「Argument list too long」としか出ず、原因が読み取れないまま赤になる。
    #
    # 効くのは ARG_MAX（合計）ではなく、Linux の MAX_ARG_STRLEN（1 引数あたりの
    # 固定上限。カーネル定数: PAGE_SIZE * 32）。diff 全体を 1 つの -p 引数へ
    # 載せる以上、ここが実際のボトルネックになる。ページサイズを動的に取り、
    # 取得できない環境では Linux の既定値 4096 を仮定する。
    #
    # MAX_ARG_STRLEN は終端 NUL を含めて評価される（カーネル fs/exec.c の
    # strnlen_user(str, MAX_ARG_STRLEN)）。渡せる実文字数はその 1 バイト少ない。
    # 実測（Linux 6.10）: 131,070 / 131,071 バイトは通り、131,072 バイトから
    # Argument list too long になった。131,072 をそのまま「渡せる最大」として
    # 使うと、チャンクがちょうど境界に達したときに E2BIG で落ちる。
    CLI="agy"
    page_size="$(getconf PAGE_SIZE 2>/dev/null || getconf PAGESIZE 2>/dev/null || echo 4096)"
    max_arg_bytes=$((page_size * 32 - 1))

    # 文字数（${#var}）ではなくバイト数で測る。${#var} はロケール依存で、日本語を
    # 含む差分では 1 文字が複数バイトになり、上限判定が実際より甘くなる
    # （実測: 文字数 156,080 に対しバイト数 396,080）。wc -c は常にバイト数を返す。
    prompt_bytes="$(LC_ALL=C printf '%s' "$PROMPT" | wc -c)"
    # diff 本文とプロンプトの間に挟む改行 1 バイト分を引く（実際に渡す引数は
    # "$chunk_text\n$PROMPT" の形）。
    chunk_budget=$((max_arg_bytes - prompt_bytes - 1))
    diff_bytes="$(LC_ALL=C printf '%s' "$diff_text" | wc -c)"

    if [[ "$diff_bytes" -le "$chunk_budget" ]]; then
      # 分割不要。従来どおり 1 回で渡す（ログの見え方も変えない）。
      chunk_paths=("$diff_file")
    else
      # 上限超過を「範囲を分けてください」と拒否して終わらせない。生成物
      # （ロックファイル等）を含む差分は、範囲を分けても 1 ファイルの差分自体が
      # 上限を超えることがあり、それだと永久にレビューできなくなる。
      #
      # ファイル単位を基本に、複数ファイルを 1 チャンクへ詰める。1 ファイルの
      # 差分だけで上限を超える場合に限りハンク単位へ落とし、ハンクごとに
      # ファイルヘッダを付け直す（付けないとモデルがどのファイルの変更か
      # 判断できない）。1 ハンクだけで上限を超える、またはハンクを持たない
      # 差分（二値・モード変更のみ）が単体で上限を超える場合は、分割できない
      # 単位として黙って切り詰めず、該当ファイル名を添えて失敗させる。切り詰めると
      # レビューしていない部分を緑として報告することになる。
      #
      # 分割そのものは awk（LC_ALL=C 固定でバイト単位の length() にする。BSD awk /
      # gawk のどちらでも、この固定で多バイト文字を 1 バイトずつ数える）で行う。
      # bash 側は組み立てられたチャンクファイルを集めるだけにする。
      chunks_dir="$work_dir/chunks"
      mkdir -p "$chunks_dir"
      if ! LC_ALL=C awk -v budget="$chunk_budget" -v workdir="$chunks_dir" '
        BEGIN {
          chunk_no = 0
          cur = ""; cur_len = 0
          buf = ""; buf_len = 0
          have_buf = 0
          aborted = 0
        }

        function chunkpath(n) {
          return sprintf("%s/chunk-%05d.diff", workdir, n)
        }

        # 詰め合わせ中のチャンクを 1 ファイルへ書き出す。
        function flush_cur(    fn) {
          if (cur_len > 0) {
            chunk_no++
            fn = chunkpath(chunk_no)
            printf "%s", cur > fn
            close(fn)
            cur = ""; cur_len = 0
          }
        }

        # 分割できない単位を検出したときの唯一の出口。該当ファイル名を含む行を
        # stderr へ出し、非 0 で終了する。ここまでに書き出したチャンクは残る
        # （trap で work_dir ごと消えるため後始末は呼び出し元に任せる）。
        function fail(msg) {
          print "error: " msg > "/dev/stderr"
          aborted = 1
          exit 1
        }

        # 1 ファイル分のブロック（1 行目が "diff --git ..."）を処理する。
        # budget に収まればチャンクへ詰め、収まらなければハンク単位へ落とす。
        function process_file(block, block_len,
            header, header_len, lines, n, i, line, in_hunk, hh, hh_len, first_line, fnh) {
          if (block_len <= budget) {
            if (cur_len + block_len <= budget) {
              cur = cur block
              cur_len += block_len
            } else {
              flush_cur()
              cur = block
              cur_len = block_len
            }
            return
          }

          # 単体で上限を超える。ファイル単位の詰め合わせとは混ぜず、ここで
          # 現在のチャンクを確定してからハンク単位へ落とす。
          flush_cur()

          n = split(block, lines, "\n")
          header = ""; header_len = 0
          first_line = lines[1]
          in_hunk = 0
          hh = ""; hh_len = 0

          for (i = 1; i <= n; i++) {
            line = lines[i]
            # split() は block 末尾の "\n" の分だけ空要素を最後に残す。
            if (i == n && line == "") continue

            if (!in_hunk && line ~ /^@@ -/) in_hunk = 1

            if (!in_hunk) {
              header = header line "\n"
              header_len += length(line) + 1
              continue
            }

            if (line ~ /^@@ -/) {
              # 新しいハンクの開始。直前のハンクをファイルヘッダ付きで確定する。
              if (hh_len > 0) {
                if (header_len + hh_len > budget) {
                  fail("チャンク分割できません（1 ハンクで上限超過）: " first_line)
                }
                chunk_no++
                fnh = chunkpath(chunk_no)
                printf "%s%s", header, hh > fnh
                close(fnh)
                hh = ""; hh_len = 0
              }
            }

            hh = hh line "\n"
            hh_len += length(line) + 1
          }

          if (!in_hunk) {
            # 二値ファイル・モード変更のみなど、ハンクを 1 つも持たない差分が
            # 単体で上限を超えている。これ以上は分割できない。
            fail("チャンク分割できません（ハンクを持たない差分が上限超過）: " first_line)
          }

          if (hh_len > 0) {
            if (header_len + hh_len > budget) {
              fail("チャンク分割できません（1 ハンクで上限超過）: " first_line)
            }
            chunk_no++
            fnh = chunkpath(chunk_no)
            printf "%s%s", header, hh > fnh
            close(fnh)
          }
        }

        /^diff --git / {
          if (have_buf) process_file(buf, buf_len)
          buf = $0 "\n"
          buf_len = length($0) + 1
          have_buf = 1
          next
        }

        { buf = buf $0 "\n"; buf_len += length($0) + 1 }

        END {
          if (aborted) exit 1
          if (have_buf) process_file(buf, buf_len)
          flush_cur()
        }
      ' "$diff_file"; then
        # 理由（該当ファイル名を含む）は awk が stderr へ出し済み。
        exit 1
      fi

      chunk_paths=()
      while IFS= read -r chunk_path; do
        chunk_paths+=("$chunk_path")
      done < <(find "$chunks_dir" -type f -name 'chunk-*.diff' | sort)

      if [[ "${#chunk_paths[@]}" -eq 0 ]]; then
        echo "error: 差分の分割に失敗しました（チャンクが生成されませんでした）" >&2
        exit 1
      fi
    fi
    ;;
  codex)
    # codex exec は `-` を指定すると、指示文そのものを標準入力から読む。差分と
    # プロンプトを「差分が先・プロンプトが後」の順で 1 つのファイルにまとめて流す
    # （上記ヘッダ「ツールの解禁」。ツールが使えない環境でも差分は必ず届く）。
    # 引数に載せないので単一引数の上限を受けない。分割しない（1 チャンク）。
    CLI="codex"
    chunk_paths=("$diff_file")
    ;;
esac

# 通過判定は「出力の最後の行に置かれた判定トークン」で行う。
#
# 出力全体が判定トークンと一致することを要求してはいけない。モデルは回答の前に
# 「これから何をするか」という作業ナレーションを出すことがあり、それが出た瞬間に、
# 指摘が 1 件も無くても「指摘あり」へ化ける。実測では 3 run すべてがこの形で落ちた。
# ナレーションは同じ差分なら毎回同じように出るため、run 数を増やしても消えない。
# 偽の赤が定常化すると、ゲートそのものが読まれなくなる。
#
# 逆に「LGTM を含む」へ緩めることもしない。ファイル別に講評して途中の 1 行へ LGTM と
# 書く形や、指摘の末尾へ **LGTM** を添える形は、モデルが自然に取る出力で実際に起きる。
# 行の存在で判定すると、重大な指摘が同時に出ていても通過する。判定トークンを
# `VERDICT:` 付きの専用の形にしているのはこのためで、末尾に装飾された LGTM が
# 置かれていても判定トークンではないので通過しない。
#
# 部分一致にもしない。`VERDICT: not LGTM` の類は一致しない。
#
# 判定トークンが無い出力は指摘ありとして扱う（安全側）。指示に従わなかった出力を
# 通すと、判定していないものを緑として報告することになる。
#
# 装飾（`**` / `` ` `` / `_` / `#`）と空白・末尾の句点は落としてから比較する。判定を
# 厳しくした結果ゲートが常に赤くなると、無視されるようになる。
normalize_verdict() {
  local normalized
  normalized="$(printf '%s' "$1" | tr -d '`*_#[:space:]')"
  normalized="${normalized%.}"
  normalized="${normalized%。}"
  printf '%s' "$normalized"
}

# 最後の非空行。判定トークンの後ろに空行が続く出力を取りこぼさない。
last_nonempty_line() {
  printf '%s\n' "$1" | grep -v '^[[:space:]]*$' | tail -n 1
}

is_lgtm() {
  # 後方互換の通過経路。出力全体が LGTM だけの場合は、判定トークンが無くても通す。
  # 「LGTM とだけ返す」旧仕様に従うモデルを、仕様変更だけで赤にしないため。
  if [[ "$(normalize_verdict "$1")" == "" ]]; then
    return 1
  fi
  # grep へ -q を渡さない。-q は最初のマッチで終了してパイプを閉じ、まだ書き込み中の
  # printf が SIGPIPE で死ぬ。pipefail 下ではパイプライン全体が非 0 になり、**LGTM の
  # ときに限って**判定が反転する（偽の指摘あり）。モデル出力はパイプバッファを超えうる。
  if printf '%s\n' "$(normalize_verdict "$1")" | grep -ix 'LGTM' >/dev/null; then
    return 0
  fi
  printf '%s\n' "$(normalize_verdict "$(last_nonempty_line "$1")")" | grep -ix 'VERDICT:LGTM' >/dev/null
}

# 判定トークンが「無い」のか「FINDINGS だった」のかを区別して診断へ出す。無い場合、
# モデルが出力形式に従っていない可能性があり、指摘本文を読んでも原因が分からない。
has_verdict_token() {
  printf '%s\n' "$(normalize_verdict "$(last_nonempty_line "$1")")" \
    | grep -iE '^VERDICT:(LGTM|FINDINGS)$' >/dev/null
}

# ここから JSON スキーマ方式（antigravity / codex）の判定。gemini はここを使わない。
#
# 回答から JSON を取り出す。エンジンごとに包みが違うのはここだけ。
#   codex        -o のファイルがそのまま JSON（スキーマで強制済み）
#   antigravity  stdout が包みで、回答は `.structured_output`（スキーマで強制済み）
extract_answer_json() {
  local raw="$1"
  case "$ENGINE" in
    codex)
      printf '%s' "$raw"
      ;;
    antigravity)
      printf '%s' "$raw" | jq -c '.structured_output' 2>/dev/null || true
      ;;
    *)
      printf '%s' "$raw"
      ;;
  esac
}

# 形が満たされているかを見る。**「読めなかった」を「指摘なし」にしない**
# ——読めないまま通すと、レビューしていないものを緑として報告することになる。
#
# category の値まで見る。配列であることしか見ないと、スキーマに無い綴り
# （強制が効いていない・CLI の版差等）が来たときに「落とす指摘 0 件」と数えられ、
# ゲートが緑になる。知らない category は「重さが分からない」ので、指摘なしへ
# 倒さず、読めなかったものとして落とす。
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

# 落とす指摘の数。`paste -sd ' or '` のような区切り文字の連結は使わない——`-d` は
# 「区切り文字の並び」を 1 文字ずつ循環して使う指定なので、複数文字の区切りを渡すと
# 壊れた並びになる。filter は jq 式として自前で組み立てる。
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

# 人が読む形にする。報告は 4 点の外（promise-mismatch / other）も出す。
print_findings() {
  printf '%s' "$1" | jq -r '.findings[] |
    "  [" + .category + "] " + (if .file == "" then "(場所の特定なし)" else .file + ":" + (.line | tostring) end) + "\n" +
    "    何が: " + .what + "\n" +
    "    なぜ: " + .why'
}

# 過半数。N=1 なら 1、N=2 なら 2、N=3 なら 2、N=4 なら 3。
threshold=$((RUNS / 2 + 1))

# チャンクが複数あるときも、全チャンクの run を合算して過半数を取らない。片方の
# チャンクだけが確実に指摘を出していても、他方の LGTM に薄められて通過しうる。
# チャンクごとに過半数を取り、1 つでも指摘ありなら全体を指摘ありとする
# （findings_chunks で「指摘ありと判定されたチャンク数」を数える）。
#
# チャンクが 1 個（既定・分割が起きなかった場合）のログとメッセージは、分割を
# 導入する前と完全に同じ形にする。チャンクをまたぐ言い回しを混ぜると、
# 大半を占める「分割なし」の実行でも表示が変わってしまう。
chunk_count=${#chunk_paths[@]}
findings_chunks=0
findings=0
chunk_idx=0
for chunk_path in "${chunk_paths[@]}"; do
  chunk_idx=$((chunk_idx + 1))

  case "$ENGINE" in
    gemini)
      args=(--skip-trust --include-directories "$work_dir" -p "@$chunk_path
$PROMPT")
      [[ -n "$MODEL" ]] && args=(-m "$MODEL" "${args[@]}")
      ;;
    antigravity)
      # 分割なし（chunk_path が diff_file 本体）のときは $diff_text をそのまま使う。
      # ファイル経由で読み直すと、コマンド置換や read が末尾の改行を落としうる。
      if [[ "$chunk_path" == "$diff_file" ]]; then
        chunk_text="$diff_text"
      else
        # read -d '' はデリミタが無いまま EOF に達すると非 0 を返すが、変数には
        # 読み取れた内容がそのまま入る。command substitution と違い、末尾の
        # 改行を落とさない（分割されたチャンクをバイト単位で正確に渡すため）。
        IFS= read -r -d '' chunk_text < "$chunk_path" || true
      fi
      # --json-schema は構造化出力を強制する。`--output-format json` が無いと
      # 「--json-schema can only be used when --output-format is 'json' or
      # 'stream-json'」で落ちるため、常に併せて渡す。回答は包みの
      # `.structured_output` に入る（下の extract_answer_json で取り出す）。
      args=(-p "$chunk_text
$PROMPT" --output-format json --json-schema "$SCHEMA_FILE")
      [[ -n "$MODEL" ]] && args=(--model "$MODEL" "${args[@]}")
      ;;
    codex)
      # 判定に使う入力を -o（最後のメッセージ）へ固定する。stdout の形には頼らない
      # ——codex exec は見出し・設定・受け取ったプロンプトの復唱を stderr へ出すが、
      # 回答を stdout のどこへ何行で書くかは CLI の版で変わりうる。-o は
      # 「エージェントの最後のメッセージ」を書く明示の口なので、ここを読む。
      #
      # 失敗すれば -o のファイルは作られない。run の呼び出しが終了コードで先に
      # 落ちるため、無いファイルを読んで「回答が空」と報告する経路には入らない。
      answer_file="$work_dir/codex-answer.json"

      # 標準入力には「差分が先・プロンプトが後」の順で流す（プロンプト冒頭の
      # 「上記は git の差分です」が指す先を保つ）。差分を渡す理由は PROMPT の
      # 組み立ての注記（サンドボックスが起動しない環境）。
      stdin_file="$work_dir/codex-input.txt"
      printf '%s\n\n%s\n' "$diff_text" "$PROMPT" > "$stdin_file"

      # --sandbox read-only: ツールの解禁はここが担保する（上記ヘッダ「ツールの
      #   解禁」）。既定に頼らず明示する。
      # --output-schema: 回答の形を強制する。これで「出力の最後の行の判定トークン」
      #   を解析する仕組みが要らなくなり、ナレーション 1 行で誤分類する故障クラスが
      #   構造的に消える。
      # --color never: ANSI のエスケープが JSON に混じらないようにする。
      args=(exec - --sandbox read-only --color never \
            --output-schema "$SCHEMA_FILE" -o "$answer_file")
      [[ -n "$MODEL" ]] && args+=(--model "$MODEL")
      ;;
  esac

  findings=0
  run=0
  while [[ "$run" -lt "$RUNS" ]]; do
    run=$((run + 1))

    # 回答のファイルは呼び出しの直前に消す。args の組み立ては 1 チャンクに 1 回しか
    # 走らないので、そこで消すだけでは --runs 2 以上のときに 2 回目が 1 回目の回答を
    # 読む——0 で終わりながら -o を書かなかった回が、前の回の判定で通ってしまう。
    [[ "$ENGINE" == "codex" && -n "$answer_file" ]] && rm -f "$answer_file"

    # CLI の警告や進捗表示は「回答」ではない。判定へ混ぜると、警告が 1 行出ただけで
    # LGTM が指摘ありに化け、ゲートが常に赤くなる（実測: 端末の色数や ripgrep 不在の
    # 警告が stderr に出る）。判定はモデルの回答だけで行い、stderr は失敗したときの
    # 診断に回す。gemini / antigravity は差分を引数で渡すため標準入力は渡さない。
    # codex は標準入力に流す（stdin_file は codex 以外のとき /dev/null のまま）。
    output="$($CLI "${args[@]}" <"$stdin_file" 2>"$stderr_file")" || {
      echo "error: second opinion failed (engine=$ENGINE, run $run/$RUNS$( [[ "$chunk_count" -gt 1 ]] && echo ", chunk $chunk_idx/$chunk_count" ))" >&2
      cat "$stderr_file" >&2
      printf '%s\n' "$output" >&2
      exit 1
    }

    # codex は回答を stdout ではなく -o のファイルへ取る（上の args 組み立ての注記）。
    # 無ければ失敗させる。0 で終わったのにファイルが無いのは判定の入力が無いという
    # ことで、「回答が空」として指摘あり側へ倒すと理由が読めなくなる。
    if [[ "$ENGINE" == "codex" ]]; then
      if [[ ! -f "$answer_file" ]]; then
        echo "error: codex が最後のメッセージを書きませんでした（-o のファイルが無い。engine=$ENGINE, run $run/$RUNS$( [[ "$chunk_count" -gt 1 ]] && echo ", chunk $chunk_idx/$chunk_count" )）" >&2
        cat "$stderr_file" >&2
        exit 1
      fi
      output="$(cat "$answer_file")"
    fi

    # 回答が空でも終了コードが 0 になる経路がある。実測では、agy がツールの実行許可を
    # 求めて非対話では承認できず自動拒否し、「回答なし」を stderr へ書いて 0 で終えた。
    # このとき判定は（判定トークンが無いので）指摘あり側へ倒れるが、指摘本文が無いため
    # 画面には何も出ず、原因が分からないまま赤になる。CLI の診断をここで見せる。
    if [[ -z "${output//[[:space:]]/}" && -s "$stderr_file" ]]; then
      echo "[second-opinion] run $run/$RUNS: モデルの回答が空です。CLI の診断:" >&2
      cat "$stderr_file" >&2
    fi

    log_prefix="[second-opinion]"
    [[ "$chunk_count" -gt 1 ]] && log_prefix="[second-opinion] chunk $chunk_idx/$chunk_count"

    # どの run が何を報告したかを追えるようにする。集約結果だけを出すと、
    # 過半数に届かなかった指摘が消えて確認できなくなる。
    #
    # 判定方式はエンジンで固定。gemini は出力の最後の行の判定トークン
    # （is_lgtm / has_verdict_token）、antigravity / codex は回答の JSON の
    # category（上記「ここから JSON スキーマ方式」）。
    if [[ "$ENGINE_JSON" -eq 1 ]]; then
      answer_json="$(extract_answer_json "$output")"
      if ! answer_is_valid "$answer_json"; then
        # **「読めなかった」を「指摘なし」に倒さない。** レビューしていないものを
        # 緑として報告することになる。
        echo "error: 回答を JSON として読めませんでした（engine=$ENGINE, run $run/$RUNS$( [[ "$chunk_count" -gt 1 ]] && echo ", chunk $chunk_idx/$chunk_count" )）。生の出力:" >&2
        printf '%s\n' "$output" >&2
        if [[ -s "$stderr_file" ]]; then
          echo "--- CLI の診断 ---" >&2
          cat "$stderr_file" >&2
        fi
        exit 1
      fi

      # **差分を読めなかった回答は、指摘の中身によらず落とす**（game-forge #873）。
      # `other` の指摘だけを返して LGTM になると、読んでいないものがレビュー済み
      # として記録される。**ここで完了の行（LGTM / findings reported ...）を
      # 出さない。** loop-gate.sh の second-opinion-record.sh への記録は、出力に
      # その行があるかどうかで「判定に到達したか」を見ているため、出さずに exit
      # すれば記録も残らない。
      if [[ "$(printf '%s' "$answer_json" | jq -r '.reviewed')" != "true" ]]; then
        echo "error: 第二意見が差分を読めなかったと答えました（engine=$ENGINE, run $run/$RUNS$( [[ "$chunk_count" -gt 1 ]] && echo ", chunk $chunk_idx/$chunk_count" )）。レビューは成立していません:" >&2
        print_findings "$answer_json" >&2
        if [[ -s "$stderr_file" ]]; then
          echo "--- CLI の診断 ---" >&2
          cat "$stderr_file" >&2
        fi
        exit 1
      fi

      blocking="$(blocking_count "$answer_json")"
      total="$(printf '%s' "$answer_json" | jq '.findings | length')"
      if [[ "$blocking" -eq 0 ]]; then
        if [[ "$total" -eq 0 ]]; then
          echo "$log_prefix run $run/$RUNS: LGTM"
        else
          # 落とさない指摘（promise-mismatch / other）は、通したうえで見せる。
          echo "$log_prefix run $run/$RUNS: LGTM（落とさない指摘が $total 件）"
          print_findings "$answer_json"
        fi
      else
        findings=$((findings + 1))
        echo "$log_prefix run $run/$RUNS: findings（落とす $blocking 件 / 全 $total 件）"
        print_findings "$answer_json"
      fi
    else
      if is_lgtm "$output"; then
        echo "$log_prefix run $run/$RUNS: LGTM"
      else
        findings=$((findings + 1))
        if has_verdict_token "$output"; then
          echo "$log_prefix run $run/$RUNS: findings"
        else
          # 判定トークンが無い出力を黙って「指摘あり」に数えると、モデルが形式に
          # 従わなかっただけの赤と、実在の指摘による赤が区別できない。
          echo "$log_prefix run $run/$RUNS: findings (判定トークンが見つかりません。最後の行に VERDICT: LGTM または VERDICT: FINDINGS が必要です)"
        fi
        printf '%s\n' "$output"
      fi
    fi
  done

  if [[ "$findings" -ge "$threshold" ]]; then
    findings_chunks=$((findings_chunks + 1))
  fi

  # チャンクが 1 個のときは、このチャンクの集計がそのまま全体の集計になる。
  # 後段の分岐でそのまま使うため、ここでチャンク単位のメッセージは出さない。
  if [[ "$chunk_count" -gt 1 ]]; then
    if [[ "$findings" -lt "$threshold" ]]; then
      echo "[second-opinion] chunk $chunk_idx/$chunk_count: LGTM ($findings/$RUNS runs reported findings; threshold $threshold)"
    else
      echo "[second-opinion] chunk $chunk_idx/$chunk_count: findings reported by $findings/$RUNS runs (threshold $threshold)." >&2
    fi
  fi
done

if [[ "$chunk_count" -eq 1 ]]; then
  # 分割が起きなかった場合の表示は、分割を導入する前と完全に同じ形にする。
  if [[ "$findings" -lt "$threshold" ]]; then
    echo "[second-opinion] LGTM ($findings/$RUNS runs reported findings; threshold $threshold)"
    # 過半数に届かなくても、指摘があった事実は伏せない。誤検出とは限らない。
    if [[ "$findings" -gt 0 ]]; then
      echo "[second-opinion] note: 少数の run が指摘しています。内容は上に出ています。" >&2
    fi
    exit 0
  fi

  echo "[second-opinion] findings reported by $findings/$RUNS runs (threshold $threshold)." >&2
  echo "[second-opinion] fix them in a single iteration before push." >&2
  exit 1
fi

if [[ "$findings_chunks" -eq 0 ]]; then
  echo "[second-opinion] LGTM (all $chunk_count chunks passed chunk-wise majority)"
  exit 0
fi

echo "[second-opinion] $findings_chunks/$chunk_count chunks reported findings (chunk-wise majority)." >&2
echo "[second-opinion] fix them in a single iteration before push." >&2
exit 1
