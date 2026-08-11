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
#   SECOND_OPINION_RUNS=3 bash scripts/second-opinion-review.sh
#
# エンジン:
#   認証手段の違う 2 つの CLI から選べる。判定ロジックは 1 か所に集約し、エンジン
#   ごとに複製しない。複製すると、判定の修正が片側にしか効かない状態が生まれる。
#   エンジンごとに違うのは「CLI の名前」「認証」「差分の渡し方」の 3 点だけである。
#
#   gemini       gemini CLI。API キー認証（GEMINI_API_KEY）。既定
#   antigravity  Antigravity CLI（agy）。Google アカウントの OAuth 認証。API キー非対応
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
#   回数では消えない故障もある。モデルが回答の前に作業ナレーションを出す形は、
#   同じ差分なら毎回同じように出るため、run を増やしても全 run が同じように落ちる。
#   これは回数ではなく判定側で受ける（下記「通過判定」）。
#
# 通過判定:
#   出力の最後の行に置かれた判定トークン `VERDICT: LGTM` を通過とみなす。
#   出力全体の一致では判定しない（前置きが 1 行出ただけで偽の赤になる）。
#   行の存在でも判定しない（指摘と併記された LGTM で偽の緑になる）。
#   理由の詳細は is_lgtm のコメントに置く。
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
  --engine <name>       レビューを実行する CLI（gemini | antigravity。既定: gemini。
                        SECOND_OPINION_ENGINE でも指定可）
  --model <name>        使用モデル（既定: 各 CLI の既定。SECOND_OPINION_MODEL でも指定可）
  --runs <n>            実行回数（既定: 1。SECOND_OPINION_RUNS でも指定可）
                        指摘を報告した run が過半数に達したときだけ非 0 で終わる
  -h, --help            ヘルプ

engines:
  gemini       gemini CLI。API キー認証（GEMINI_API_KEY）
  antigravity  Antigravity CLI（agy）。Google アカウントの OAuth 認証。API キー非対応
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
    ;;
  *)
    echo "error: unknown engine: $ENGINE（gemini | antigravity）" >&2
    exit 1
    ;;
esac

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

# ゲート対象は review-workflow.md の限定に合わせる。
read -r -d '' PROMPT <<'EOF' || true

上記は git の差分です。コードレビューを行ってください。

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
  - 上記 4 点に該当する指摘が 1 件もない場合: `VERDICT: LGTM`
  - 指摘がある場合: `VERDICT: FINDINGS`
- 指摘がある場合は、判定トークンより前に、各指摘について「該当ファイルと行」「何が問題か」「なぜ問題か（再現条件や影響）」を簡潔に記述してください。
- 通過判定は最後の行だけで行います。判定トークンの無い出力は指摘ありとして扱います。
EOF

echo "[second-opinion] reviewing $scope (engine=$ENGINE, runs=$RUNS)"

# 一時領域は両エンジンで使う。gemini は差分の受け渡しに、両者とも stderr の退避に。
# テンプレートを明示する。BSD 系（macOS）の mktemp はテンプレート無しの呼び出しを
# 受け付けず、この雛形は Linux 以外へ配布されうる。
work_dir="$(mktemp -d "${TMPDIR:-/tmp}/second-opinion.XXXXXX")"
diff_file="$work_dir/review.diff"
stderr_file="$work_dir/stderr"
trap 'rm -rf "$work_dir"' EXIT
printf '%s\n' "$diff_text" > "$diff_file"

# 差分の渡し方はエンジンごとに違う。**どちらも「差分が加工されずモデルへ届くこと」を
# 実測で確かめたうえで選んでいる。** 片方の作法をもう片方へ流用しない。
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
    args=(--skip-trust --include-directories "$work_dir" -p "@$diff_file
$PROMPT")
    [[ -n "$MODEL" ]] && args=(-m "$MODEL" "${args[@]}")
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
    # 手前で止めて、範囲を絞る指示を出す。黙って切り詰めない（レビューされて
    # いない部分を緑として報告することになる）。
    arg_limit="$(getconf ARG_MAX 2>/dev/null || echo 131072)"
    arg_limit=$((arg_limit / 2))
    if [[ "${#diff_text}" -gt "$arg_limit" ]]; then
      echo "error: 差分が大きすぎて $ENGINE へ渡せません（${#diff_text} > $arg_limit）。--range で範囲を分けてください" >&2
      exit 1
    fi
    CLI="agy"
    args=(-p "$diff_text
$PROMPT")
    [[ -n "$MODEL" ]] && args=(--model "$MODEL" "${args[@]}")
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
  if printf '%s\n' "$(normalize_verdict "$1")" | grep -qix 'LGTM'; then
    return 0
  fi
  printf '%s\n' "$(normalize_verdict "$(last_nonempty_line "$1")")" | grep -qix 'VERDICT:LGTM'
}

# 判定トークンが「無い」のか「FINDINGS だった」のかを区別して診断へ出す。無い場合、
# モデルが出力形式に従っていない可能性があり、指摘本文を読んでも原因が分からない。
has_verdict_token() {
  printf '%s\n' "$(normalize_verdict "$(last_nonempty_line "$1")")" \
    | grep -qiE '^VERDICT:(LGTM|FINDINGS)$'
}

findings=0
run=0
while [[ "$run" -lt "$RUNS" ]]; do
  run=$((run + 1))

  # CLI の警告や進捗表示は「回答」ではない。判定へ混ぜると、警告が 1 行出ただけで
  # LGTM が指摘ありに化け、ゲートが常に赤くなる（実測: 端末の色数や ripgrep 不在の
  # 警告が stderr に出る）。判定はモデルの回答（stdout）だけで行い、stderr は失敗
  # したときの診断に回す。標準入力は渡さない（差分は引数で渡している）。
  output="$($CLI "${args[@]}" </dev/null 2>"$stderr_file")" || {
    echo "error: second opinion failed (engine=$ENGINE, run $run/$RUNS)" >&2
    cat "$stderr_file" >&2
    printf '%s\n' "$output" >&2
    exit 1
  }

  # 回答が空でも終了コードが 0 になる経路がある。実測では、agy がツールの実行許可を
  # 求めて非対話では承認できず自動拒否し、「回答なし」を stderr へ書いて 0 で終えた。
  # このとき判定は（判定トークンが無いので）指摘あり側へ倒れるが、指摘本文が無いため
  # 画面には何も出ず、原因が分からないまま赤になる。CLI の診断をここで見せる。
  if [[ -z "${output//[[:space:]]/}" && -s "$stderr_file" ]]; then
    echo "[second-opinion] run $run/$RUNS: モデルの回答が空です。CLI の診断:" >&2
    cat "$stderr_file" >&2
  fi

  # どの run が何を報告したかを追えるようにする。集約結果だけを出すと、
  # 過半数に届かなかった指摘が消えて確認できなくなる。
  if is_lgtm "$output"; then
    echo "[second-opinion] run $run/$RUNS: LGTM"
  else
    findings=$((findings + 1))
    if has_verdict_token "$output"; then
      echo "[second-opinion] run $run/$RUNS: findings"
    else
      # 判定トークンが無い出力を黙って「指摘あり」に数えると、モデルが形式に
      # 従わなかっただけの赤と、実在の指摘による赤が区別できない。
      echo "[second-opinion] run $run/$RUNS: findings (判定トークンが見つかりません。最後の行に VERDICT: LGTM または VERDICT: FINDINGS が必要です)"
    fi
    printf '%s\n' "$output"
  fi
done

# 過半数。N=1 なら 1、N=2 なら 2、N=3 なら 2、N=4 なら 3。
threshold=$((RUNS / 2 + 1))

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
