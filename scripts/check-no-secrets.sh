#!/usr/bin/env bash
# check-no-secrets.sh — 機密混入の検知ゲート（共通規範「機密をコミットしない」の機械化）
#
# 位置づけ:
#   判定はこのスクリプトが持ち、scripts/verify.sh と CI は呼ぶだけ。
#   scripts/verify-commit-identity.sh と同じ形にそろえる。
#
#   受け入れ条件の雛形（scripts/acceptance.sh）へ書かない理由: あちらは
#   プロジェクトが所有・編集する設計であり、受け入れ条件を書き足すたびに触られる。
#   規範由来の検査をそこへ置くと、書き換えのたびに検査が消える経路ができる。
#   verify.sh から直接呼べば、その経路を作らずに済む。
#
# 検査は 4 つ:
#
#   1. 追跡前（git status --porcelain -z）
#      追跡対象へ入る「前」に落とす。誤ってコミットしてからでは、削除コミットでは
#      漏洩は解消しない（履歴からの除去と、当該資格情報の失効・再発行が必要になる）。
#      列挙は NUL 区切り（#263）。パス名に改行を含むファイルも 1 レコードのまま
#      崩れずに読める（後述）。
#
#   2. 追跡済み（git ls-files -z）
#      CI で落とす。checkout 直後の作業ツリーはクリーンで 1. の出力が空になるため、
#      追跡前の検査だけでは CI は「何も検査していない状態」で合格する。CI が
#      本来捕まえたいのは機密を含んだままの PR、すなわち追跡済みの状態である。
#      両方あって初めて、どちらの経路でも機密が既定ブランチへ入らない。
#      こちらも列挙は NUL 区切り（#263）。
#
#   3. .env.example に機密の値が入っていないこと
#      機密でない設定既定値は共有する意味があるため、キー名で対象を絞る。
#
#   4. .env と .env.example のキー整合
#      .env が唯一の供給元で、.env.example はその雛形。
#
# 検査が成立していないことを合格にしない:
#   git 管理外での実行、git コマンド自体の失敗、追跡ファイル 0 件は、いずれも
#   「機密が無い」ことを意味しない。空の出力を「該当なし」と読むと、検査して
#   いないのに合格になる。これらはすべて失敗として扱う。
#
# 出力に機密の値を出さない:
#   検出時に出すのはパスとキー名だけで、値は決して出力しない（共通規範
#   「ログ・issue 本文・相談記録・PR 説明に機密を含めない」）。
#
# 終了コード:
#   0 = SECRETS_PASS
#   1 = SECRETS_FAIL（機密の混入、または検査が成立しなかった）
set -euo pipefail

# ロケールを C に固定する。
#
# #263 以前は「判定の解析」（追跡前が git add --dry-run の人間向け出力
# add '<path>' を解析していたため、翻訳されるとパターンに一致しなくなる）も
# 固定の理由だった。追跡前・追跡済みとも git status --porcelain -z /
# git ls-files -z の機械可読出力（ステータス文字とパスのみで、翻訳される
# メッセージ文字列を含まない）へ置き換えたため、この理由は無くなった
# （依存を外したのでここに書く）。
#
# 残る理由（並びの比較）: キー整合は sort / comm で集合差を取る。GNU sort の照合順は
#   ロケールで変わり（実測: C では MYVAR < MY_VAR、en_US.utf8 では MY_VAR < MYVAR）、
#   両辺が別の照合順で並ぶと comm は "not in sorted order" を警告しつつ終了コード 0 を
#   返し、誤った差集合をそのまま使わせる（実測: 存在しないキー AB が片側だけに
#   あると報告された）。両辺を同じ照合順に固定して依存そのものを切る。
export LC_ALL=C

# 検査はプロジェクトルート基準で行う。scripts/ は生成先プロジェクト直下にあるため、
# スクリプト位置の 1 階層上がルート。任意の作業ディレクトリから起動しても不変にする。
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$(dirname "$HERE")"

ENV_EXAMPLE=".env.example"
LOADER="$HERE/load-project-env.sh"

VIOLATIONS=0

ng() {
  printf '[secrets] NG %s\n' "$1" >&2
  VIOLATIONS=$((VIOLATIONS + 1))
}

fatal() {
  printf '[secrets] %s\n' "$1" >&2
  echo "SECRETS_FAIL"
  exit 1
}

# git コマンドの stderr を一時退避する。追跡前 / 追跡済みのどちらの経路も、この
# 検査の主題は「検査が成立していないことを合格にしない」ことであり、成立しなかった
# 理由（index の破損・権限・パスの問題など）が読めないと主題と噛み合わない。
#
# 一方でこれらの git コマンドは成功時にも警告（embedded git repository・改行コード
# 等）を出しうるため、常時 stderr をそのまま出すと通常運用で毎回ノイズが出る。それは
# 「赤を無視する習慣」を作る経路であり、出力そのものが読まれなくなる。そのため
# 一時ファイルへ落とし、失敗したときだけ見せる。
#
# mktemp はテンプレート付きで呼ぶ。$$ 由来の予測可能な名前は使わない（同名を先に
# 置かれると書き込み先を乗っ取られる）。後始末は EXIT トラップで行う（この
# スクリプトはここより前で trap を張っていない）。
#
# GIT_STDERR に加え、追跡前 / 追跡済みそれぞれの列挙（NUL 区切り）も一時ファイルへ
# 落とす。bash の変数（"$(...)" によるコマンド置換）は NUL バイトを保持できず、
# 埋め込まれた NUL がそのまま消えてしまう（末尾の改行除去とは別の、bash 自体の
# 制約）。NUL 区切りのまま `while IFS= read -r -d '' ...` で読むには、変数ではなく
# ファイルとして経由させる必要がある。
#
# trap は 3 つの mktemp より「前」に張る。あとから張ると、2 つ目・3 つ目の mktemp が
# 失敗して fatal で抜けたときに、先に作られたファイルが消えずに残る（一時領域の
# 容量やファイル数の上限に当たった環境で起きる）。変数は空で先に宣言する。
#
# 削除は関数に置き、パスを必ず二重引用符で囲む。${VAR:+"$VAR"} を rm の引数へ
# 直接展開する形でも bash では引用が保たれる（実測: TMPDIR にスペースと * を
# 含めても巻き添え削除は起きなかった）が、展開結果が引用されるかどうかはシェルの
# 版ごとに確かめないと読み取れない。この雛形は任意の環境へ配布され、macOS の
# bash 3.2 でも動く必要があるため、確かめなくても読める形にする。
# -- を付けて、パスが rm のオプションとして解釈される経路も閉じる。
GIT_STDERR=""
PENDING_RAW=""
TRACKED_RAW=""
# trap から呼ぶため、静的解析からは呼び出しが見えない。
# shellcheck disable=SC2329
cleanup_temp_files() {
  [[ -n "$GIT_STDERR" ]] && rm -f -- "$GIT_STDERR"
  [[ -n "$PENDING_RAW" ]] && rm -f -- "$PENDING_RAW"
  [[ -n "$TRACKED_RAW" ]] && rm -f -- "$TRACKED_RAW"
  return 0
}
trap cleanup_temp_files EXIT
GIT_STDERR="$(mktemp "${TMPDIR:-/tmp}/check-no-secrets.XXXXXX")" || fatal "一時ファイルを作成できませんでした。stderr の退避が成立しません。"
PENDING_RAW="$(mktemp "${TMPDIR:-/tmp}/check-no-secrets-pending.XXXXXX")" || fatal "一時ファイルを作成できませんでした。追跡前の一覧が保存できません。"
TRACKED_RAW="$(mktemp "${TMPDIR:-/tmp}/check-no-secrets-tracked.XXXXXX")" || fatal "一時ファイルを作成できませんでした。追跡済みの一覧が保存できません。"

# 失敗したときだけ、退避しておいた git の stderr を見せる。正常時は無音のまま。
show_git_stderr_if_any() {
  if [[ -s "$GIT_STDERR" ]]; then
    printf '[secrets] git の出力:\n' >&2
    sed 's/^/    /' "$GIT_STDERR" >&2
  fi
}

# ── 機密とみなすパス ─────────────────────────────────────────────────────────
#
# 判定は 2 経路で同じパターンを使う。片方だけ末尾一致に絞ると、改名・退避ファイル
# （credentials.json.bak / terraform.tfstate-backup）が片側だけすり抜け、「経路が
# 違うだけで守る対象は同じ」という前提が崩れる。
#
# 各名前のうしろに ([-._~][^/]*)? を許すことで、その退避形まで 1 つの式で拾う。
# 境界を [-._~] に限るのは、無制限の後方一致にすると setup.environment.md や
# foo.keys のような無関係な名前まで拾ってしまうため。広すぎる検知層は「赤を無視する
# 習慣」を作り、検知層そのものを無力化する。
#
# 拡張子側は [^/]+ を前置きして、パス区切りをまたがせない。
#
# 接頭辞側（名前系トークンのみ）: credentials.json / client_secret /
# service[-_]account の 3 つに限り、うしろと同じ境界 ([^/]*[-._~])? を前へも許す。
# dev-credentials.json / prod-service-account.json / my-client_secret.json のように
# 環境名や用途名を前置きする運用が実際にあり、先頭固定のままだとこの形がすり抜ける。
# 境界を接尾辞側と同じ [-._~] に揃えるのは、無制限の前方一致にすると無関係な名前まで
# 拾ってしまうため（接尾辞側と同じ理由）。
#
# .env / .netrc / .pgpass / .git-credentials / id_(rsa|...) は対象外のまま先頭固定に
# 残す。これらは名前自体が短く、接頭辞を許すと foo.env のように無関係な名前（英単語
# environment 系）まで拾う経路が接尾辞側より太い。過検知は検知層そのものを無力化する
# ため、実際に接頭辞付き運用が確認された名前系トークンだけに絞る。
SECRET_PATH_RE='(^|/)(\.env|\.netrc|\.pgpass|\.git-credentials|id_(rsa|dsa|ecdsa|ed25519)|([^/]*[-._~])?(credentials\.json|client_secret|service[-_]account)|[^/]+\.(pem|key|p12|pfx|jks|keystore|kdbx|tfstate|tfvars))([-._~][^/]*)?$'

# 値を持たない雛形と公開鍵は共有が前提なので除外する（共通規範「共有するのは値の
# ない雛形のみ」/ .pub は公開鍵）。
#
# トレードオフ: 名前で判定するため、機密を .example という名前で置けばこの検査は
# すり抜ける。名前の検査だけでは中身は見られないので、配布する唯一の雛形である
# .env.example については下の「機密の値」検査を第 2 層として持つ。
SECRET_EXEMPT_RE='\.(example|sample|template|dist|pub)$'

# 1 パスが機密とみなす対象かどうかを判定する。
#
# grep へ渡さず bash の =~ で判定するのは、grep の終了コード（1 = 該当なし /
# 2 = エラー）をパイプライン越しに読み分けようとすると、エラーを「該当なし」と
# 取り違える経路ができるため。ここでは外部プロセスを一切挟まない。
is_secret_path() {
  local path="$1" base
  if [[ ! "$path" =~ $SECRET_PATH_RE ]]; then
    return 1
  fi
  base="${path##*/}"
  if [[ "$base" =~ $SECRET_EXEMPT_RE ]]; then
    return 1
  fi
  return 0
}

# ── 0. 検査が成立する状態か ──────────────────────────────────────────────────

if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  printf '[secrets] git の作業ツリーではありません: %s\n' "$PWD" >&2
  printf '[secrets] 機密が無いことと、検査が成立していないことは別です。\n' >&2
  printf '[secrets] 対処: git init し、追跡対象を 1 件以上コミットしてから実行してください。\n' >&2
  fatal "検査が成立しないため失敗させます。"
fi

# ── 1. 追跡前（追跡対象へ入る前に落とす） ────────────────────────────────────
#
# #263 より前は git add --all --dry-run の人間向け出力（add '<path>'）を行単位で
# 解析していた。パス名に改行が含まれると、git はその改行をそのまま出力するため
# 1 パスが 2 行へ割れ、`add '<path>'` の行末アンカー一致が成立せず検知できな
# かった（実測: git 2.53.0 で追跡前・追跡済みとも SECRETS_PASS まで通過）。
#
# 塞ぎ方: 列挙そのものを NUL 区切りへ変える。git add --dry-run に -z は無いため、
# 同じ「index へまだ入っていない変更」を機械可読で返す git status --porcelain -z
# へ置き換える（出力書式の解析そのものが変わる。追跡済み側の ls-files -z と対で
# 読むこと）。
#
# --untracked-files=all: 既定（normal）は未追跡ディレクトリを "?? dir/" と 1 行に
# 畳んでしまい、配下の credentials.json が見えなくなる（実測）。add --dry-run は
# 元々ファイル単位で列挙していたため、同じ広さに戻す。
# --no-renames: 既定では index 側（ステージ済み）の改名が 1 レコード 2 パス
# （新パス\0旧パス\0）になり、NUL 区切りのままでは「次のレコード」との境界が
# 曖昧になる。無効化すると改名は旧パスの削除・新パスの追加という 2 レコードに
# 分かれ、1 レコード = 1 パスの前提が常に成り立つ（実測: 作業ツリー側の改名は
# 既定のままでも常にこの 2 レコード形であり、影響を受けない）。
# パス指定を `.` にしてルート配下へ限るのは、下の git ls-files と同じ広さに
# そろえるため（プロジェクトルートがリポジトリのサブディレクトリである構成でも、
# 2 経路の対象が食い違わないようにする）。
if ! git status --porcelain -z --untracked-files=all --no-renames -- . \
      >"$PENDING_RAW" 2>"$GIT_STDERR"; then
  show_git_stderr_if_any
  fatal "git status --porcelain -z に失敗しました。追跡前の検査が成立しません。"
fi

# 各レコードは "XY<space><path>" で、X が index 側・Y が作業ツリー側の 1 文字
# ステータス。数えるのは「これから git add --all で追跡対象へ入る変更」のみ:
#
#   Y が空白 … 作業ツリーに変更が無い（index 側だけの状態）。既に追跡済みなので
#              下の git ls-files -z が拾う。ここで重複計上しない。
#   Y = D    … 作業ツリーでの削除。git add --all は remove として扱い、削除は
#              追跡対象へ「入る」変更ではない（#263 以前の add --dry-run 版も
#              remove '<path>' 行を対象外にしていたのと同じ扱い）。
#   Y = !    … 無視対象。--ignored を渡していないため通常は現れないが、将来
#              オプションを増やしたときに備えて明示的に除外する。
#   それ以外（?? の未追跡や M・A・T・C 等の未ステージ変更）は対象に含める。
pending_count=0
while IFS= read -r -d '' pending_rec; do
  [[ -n "$pending_rec" ]] || continue
  pending_y="${pending_rec:1:1}"
  if [[ "$pending_y" == ' ' || "$pending_y" == 'D' || "$pending_y" == '!' ]]; then
    continue
  fi
  pending_path="${pending_rec:3}"
  pending_count=$((pending_count + 1))
  if is_secret_path "$pending_path"; then
    ng "追跡対象へ入ろうとしています: $pending_path"
  fi
done <"$PENDING_RAW"

# ── 2. 追跡済み（CI で落とす層） ─────────────────────────────────────────────
#
# -z で列挙する（#263）。ls-files -z / status --porcelain -z は core.quotePath の
# 設定に関わらずパスを一切引用・エスケープせず生バイト列のまま NUL 区切りで返す
# （実測: git 2.53.0、非 ASCII パスも 8 進エスケープされない）。#263 より前は
# newline 区切りの ls-files に -c core.quotePath=false を渡すことで同じ効果を
# 得ていたが、-z へ移ったことでその依存が外れたため、ここでは渡していない
# （依存を外したのでここに書く）。
if ! git ls-files -z -- . >"$TRACKED_RAW" 2>"$GIT_STDERR"; then
  show_git_stderr_if_any
  fatal "git ls-files に失敗しました。追跡済みの検査が成立しません。"
fi

if [[ ! -s "$TRACKED_RAW" ]]; then
  printf '[secrets] 追跡ファイルが 1 件もありません。\n' >&2
  printf '[secrets] 出力が空なのは「機密が無い」ではなく「検査していない」状態です。\n' >&2
  fatal "検査が成立しないため失敗させます。"
fi

tracked_count=0
while IFS= read -r -d '' tracked_path; do
  [[ -n "$tracked_path" ]] || continue
  tracked_count=$((tracked_count + 1))
  if is_secret_path "$tracked_path"; then
    ng "追跡対象に含まれています: $tracked_path"
  fi
done <"$TRACKED_RAW"

# ── .env / .env.example のキー抽出 ───────────────────────────────────────────
#
# 抽出をここへ書き直さず、ローダー（scripts/load-project-env.sh）自身に読ませる。
# 別に書くと「実際には読まれるのに検査からは見えないキー」が生まれ、下の機密値の
# 検査に穴が開く（CRLF・export 記法・KEY = VALUE・クォート囲みの揺れを吸収して
# いるのはローダーだけである）。
#
# env -i を通す理由: 対話シェルには on-attach.sh が .env の読み込みを注入する。
# 呼び出し元のシェルが既に .env を読んでいると、その値が「ファイルに書かれている」
# のと区別できない。最小の環境から始め、ソース前後で export 済みになった変数の差
# だけを取る。PATH / HOME / LC_ALL は落とすと外部コマンド（git / sort / comm）が
# 動かない、あるいは並びが揺れるため明示的に渡す。
#
# 制約: PATH のように最小環境にも存在する名前が .env にあると差分に現れない。
# 実運用の .env でその名前を使うことはなく、使えばローダーがシェルの PATH を
# 壊すので、検査の穴としては表面化しない。
#
# 第 1 引数 = 出力モード（keys = キー名 / valued = 値が空でないキー名）
# 第 2 引数 = ローダーの絶対パス
#
# valued モードでも値は出力しない。機密をログ・差分へ混入させないため、返すのは
# 「値が空でないキーの名前」だけである。
#
# 単一引用符は意図的。この文字列は子 bash が解釈するプログラムで、ここで展開させない。
#
# 子シェルも fail-closed にする（set -euo pipefail）。以前は set -e 系が無く、
# sort / comm が存在しない・失敗する環境でもキー抽出が空のまま exit 0 で完走して
# いた（実測: PATH から comm を外すと `comm: command not found` を stderr へ出し
# つつ空文字列を返し、rc=0 のまま抜ける）。呼び出し側は終了ステータスだけを見て
# いるため、この経路は検出できず、下の機密値検査が「何も検査せずに通る」状態に
# なっていた。git add / git ls-files の失敗は既に fail-closed にしており、内部で
# 扱いが割れていたのをそろえる。
#
# 副作用の確認（実測、git 2.53.0 / bash 5.x）:
#   - compgen -e は env -i でも PATH / HOME / LC_ALL を cns_probe() が明示的に
#     渡しているため常に非空で、pipefail で before="$(compgen -e | sort)" が
#     落ちることはない。
#   - . "$loader" || exit 3 の既存ガードは維持する。
#   - valued モードの ${!k} は compgen -e が返した「現に export 済みの名前」だけを
#     対象にするため、set -u 下でも未定義変数を参照しない。
#   - printf ... | while read ... の pipeline は、read が EOF で通常終了する分には
#     非 0 にならず、pipefail で落ちない。
#
# baseline モード: ローダーを読む「前」に既に export されている名前（PATH / HOME /
# LC_ALL に加え、bash が自動で export する PWD / SHLVL / _ など）をそのまま返す。
# comm -13 は「ローダー実行後に増えた」ものだけを差分として拾うため、この一覧に
# 含まれる名前は .env.example に書かれていても原理的に検出できない（下の空抽出
# ガードが使う。「制約: PATH のように…」の段落と対で読むこと）。keys / valued の
# 挙動は変えない。
#
# shellcheck disable=SC2016
CNS_PROBE='
  set -euo pipefail
  mode="$1"; loader="$2"
  before="$(compgen -e | sort)"
  if [ "$mode" = baseline ]; then
    printf "%s\n" "$before"
    exit 0
  fi
  . "$loader" || exit 3
  after="$(compgen -e | sort)"
  keys="$(comm -13 <(printf "%s\n" "$before") <(printf "%s\n" "$after"))"
  if [ "$mode" = keys ]; then
    printf "%s\n" "$keys"
    exit 0
  fi
  printf "%s\n" "$keys" | while IFS= read -r k; do
    [ -n "$k" ] || continue
    if [ -n "${!k}" ]; then printf "%s\n" "$k"; fi
  done
  exit 0
'

# $1 = モード / $2 = PROJECT_ENV_FILE へ渡す絶対パス（空ならローダー自身の解決に委ねる）
cns_probe() {
  local mode="$1" env_file="${2-}"
  if [[ -n "$env_file" ]]; then
    env -i PATH="$PATH" HOME="${HOME:-}" LC_ALL=C PROJECT_ENV_FILE="$env_file" \
      bash --noprofile --norc -c "$CNS_PROBE" cns-probe "$mode" "$LOADER"
  else
    # .env の場所はローダーに決めさせる。worktree から実行された場合にメインの
    # 作業コピーへ回り込む挙動まで含めて、実際に読まれるファイルを対象にする。
    env -i PATH="$PATH" HOME="${HOME:-}" LC_ALL=C \
      bash --noprofile --norc -c "$CNS_PROBE" cns-probe "$mode" "$LOADER"
  fi
}

if [[ ! -f "$LOADER" ]]; then
  fatal "$LOADER が見つかりません。.env 系の検査が成立しません。"
fi

if [[ ! -f "$ENV_EXAMPLE" ]]; then
  printf '[secrets] %s がありません。\n' "$ENV_EXAMPLE" >&2
  printf '[secrets] 値のない雛形は共通規範が要求する共有物です（値は各自が .env へ設定する）。\n' >&2
  fatal "検査が成立しないため失敗させます。"
fi

example_keys=""
if ! example_keys="$(cns_probe keys "$PWD/$ENV_EXAMPLE")"; then
  fatal "$ENV_EXAMPLE のキーを抽出できませんでした。"
fi

# 抽出そのものが「失敗はしていないが結果が空」になる経路を塞ぐ。CNS_PROBE の
# set -euo pipefail だけでは、非 0 で終わらずに空を返すケースまでは塞げない。
#
# 空の .env.example は正当（環境変数を使わないプロジェクトもある）ため、単純に
# 「空なら落とす」にはできない。KEY=... の形の行が 1 行以上あるのに抽出結果が
# 0 件なら、それは「値が無い」のではなく「抽出そのものが成立していない」ことを
# 意味するため、その場合だけ fatal で落とす……はずだったが、比較対象を素朴な
# 行数にすると誤検知する。CNS_PROBE は「ローダー実行前に既に export されている
# 名前」（baseline: PATH / HOME / LC_ALL や、bash が自動で export する PWD /
# SHLVL / _ など）を comm -13 で除外する構造上、.env.example がそういう名前だけで
# 構成されていると、行はあるのに抽出は原理的に 0 件になる（上の「制約: PATH の
# ように最小環境にも存在する名前が .env にあると差分に現れない」と同じ理由）。
# これは検査していないのではなく、検出できない対象を正しく除外した結果であり、
# fatal にしてはならない。そのため比較対象を「baseline に含まれないキー」だけに
# 絞る。
if [[ -z "$example_keys" ]]; then
  baseline_keys=""
  if ! baseline_keys="$(cns_probe baseline "")"; then
    fatal "ベースラインの環境変数一覧を取得できませんでした。空抽出の判定が成立しません。"
  fi

  # .env.example から KEY=... の行のキー名だけを取り出す（値・コメント・空行は
  # 無視する）。ローダーの正確な解析ルールとは別に、ここでは「fatal を出すか」の
  # 判定にのみ使う概算でよい。
  example_candidate_keys="$(sed -nE 's/^[[:space:]]*(export[[:space:]]+)?([A-Za-z_][A-Za-z0-9_]*)[[:space:]]*=.*/\2/p' "$ENV_EXAMPLE")"

  example_non_baseline_count="$(comm -23 \
    <(printf '%s\n' "$example_candidate_keys" | sort) \
    <(printf '%s\n' "$baseline_keys" | sort) \
    | grep -c '[^[:space:]]' || true)"

  if [[ "$example_non_baseline_count" -gt 0 ]]; then
    fatal "$ENV_EXAMPLE にベースライン外の KEY=... 行が $example_non_baseline_count 件あるのに抽出結果が 0 件でした。抽出が成立していない疑いがあります（検査していないことを合格にしない）。"
  fi
fi

# ── 3. .env.example に機密の値が入っていないこと ─────────────────────────────
#
# 機密でない設定既定値（例: 回数・モデル名）は雛形で共有する意味があるため、
# すべてのキーを空必須にはしない。機密を示す語を含むキーと identity キーだけを
# 対象にする。
#
# 部分一致で見る。語尾一致にすると AWS_SECRET_ACCESS_KEY_ID のような修飾付きが
# すり抜ける。PAT だけは PATH との衝突を避けて語境界（先頭か _ に挟まれる）を要求する。
SECRET_KEY_RE='SECRET|TOKEN|PASSWORD|PASSWD|CREDENTIAL|PRIVATE|KEY|AUTH|IDENTITY|(^|_)PAT(_|$)'

example_valued=""
if ! example_valued="$(cns_probe valued "$PWD/$ENV_EXAMPLE")"; then
  fatal "$ENV_EXAMPLE の値を検査できませんでした。"
fi

while IFS= read -r key; do
  [[ -n "$key" ]] || continue
  if printf '%s' "$key" | grep -Eqi "$SECRET_KEY_RE"; then
    ng "$ENV_EXAMPLE に値が入っています（雛形はキー名だけを共有する）: $key"
  fi
done <<<"$example_valued"

# ── 4. .env と .env.example のキー整合 ───────────────────────────────────────
#
# .env が唯一の供給元で、.env.example はその雛形。.env にしか無いキーは、雛形が
# その設定項目を伝えていない状態で、他の環境が .env を作り直すと黙って欠ける。
#
# .env は追跡外なので、無い環境（CI）ではキーが 1 件も取れない。その場合はスキップ
# する（この検査に限り、issue の指定どおり「.env が無い環境ではスキップ」とする）。
env_keys=""
if ! env_keys="$(cns_probe keys "")"; then
  fatal ".env のキーを抽出できませんでした。"
fi

if [[ -z "$env_keys" ]]; then
  printf '[secrets] .env からキーを取得できないため、キー整合はスキップします（CI など .env が無い環境）。\n'
else
  only_env="$(comm -23 \
    <(printf '%s\n' "$env_keys" | sort) \
    <(printf '%s\n' "$example_keys" | sort))"
  only_example="$(comm -13 \
    <(printf '%s\n' "$env_keys" | sort) \
    <(printf '%s\n' "$example_keys" | sort))"

  while IFS= read -r key; do
    [[ -n "$key" ]] || continue
    ng ".env にあるキーが $ENV_EXAMPLE に無い（雛形から作り直した環境で黙って欠ける）: $key"
  done <<<"$only_env"

  # 逆向き（雛形にあって .env に無い）は失敗にしない。
  #
  # 判断と理由: 雛形へキーが増えた直後は、各環境の .env が追いつくまで必ずこの状態を
  # 通る。ここで落とすと、配布物の更新のたびに全利用者のローカルゲートが赤くなり、
  # 直す先が追跡ファイルではなく各人の手元になる。実測でもこのリポジトリが該当した
  # （#237 が .env.example へ GH_TOKEN を足した一方、手元の .env は 4 キーのまま）。
  # 一方でこの向きが実害になる経路（値が解決できない）は、それを必要とする検査が
  # それぞれ fail-closed で落とす（例: verify-commit-identity.sh の許可 email）。
  # 黙って無視はせず、事実として提示する。
  while IFS= read -r key; do
    [[ -n "$key" ]] || continue
    printf '[secrets] NOTICE %s にあるキーが .env に未設定です: %s\n' "$ENV_EXAMPLE" "$key"
  done <<<"$only_example"
fi

# ── 結果 ─────────────────────────────────────────────────────────────────────

printf '[secrets] 検査したパス: 追跡済み %s 件 / 追跡前 %s 件\n' \
  "$tracked_count" "$pending_count"

if [[ "$VIOLATIONS" -gt 0 ]]; then
  printf '[secrets] 機密の混入を %s 件検出しました。\n' "$VIOLATIONS" >&2
  printf '[secrets] 対処: 追跡前なら .gitignore へ加える。追跡済みなら git rm --cached で外し、\n' >&2
  printf '[secrets] 既にコミット済みなら履歴からの除去と、当該資格情報の失効・再発行まで行う\n' >&2
  printf '[secrets] （削除コミットでは漏洩は解消しません）。\n' >&2
  echo "SECRETS_FAIL"
  exit 1
fi

echo "SECRETS_PASS"
exit 0