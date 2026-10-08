#!/usr/bin/env bash
# session-ledger.sh — 同じホストで並行して動く AI セッションの共有台帳。
#
# 規範は .ai-playbook/shared-ai-rules.md「セッション間の協調」。この文書へ判定基準を
# 複製しない。ここは台帳の読み書きだけを担い、実行環境（フック・メッセージ）には依存しない。
#
# 使い方:
#   session-ledger.sh claim   [--call <ID>] <kind> [target]   登録する（同じ登録は更新時刻を更新する）
#   session-ledger.sh release [--call <ID>] [<kind> [target]] 自分の登録を解放する（引数なしは全部）
#   session-ledger.sh list    [--others|--all]  登録を表示する（既定は生きている登録すべて）
#   session-ledger.sh check   <kind> [target]   他セッションの登録と衝突するかを調べる
#   session-ledger.sh refresh                   自分の最後の更新時刻を新しくする（失効を避ける）
#
# kind（登録の種類）と衝突の判定・強さ:
#   issue  target = issue 番号（# は付けても付けなくてもよい）。同じ番号で衝突。警告。
#   doc    target = 文書のパス（作業ツリーの絶対パスは相対へ直す。末尾 / はその配下すべて）。
#          同じパスで衝突。警告。
#   merge  マージ・リリース。target は任意。種類が同じなら衝突。拒否。
#   git    作業ツリーでの git 操作（checkout / rebase / reset / fetch など）。target 省略時は
#          現在の作業ツリー。同じ作業ツリーで衝突。拒否。
#   gate   重いゲート（verify / loop-gate など）。種類が同じなら衝突。拒否。
#   台帳は排他制御ではなく合図である。2 つのセッションがほぼ同時に登録すると、両方が
#   通ることがある。止める強さは「拒否」でも、確実な排他を保証しない。
#
# 置き場所と書式:
#   $(git rev-parse --git-common-dir)/session-ledger/<セッション識別子>.tsv
#   作業ツリーをまたいで共有され、セッションごとに別ファイルへ追記する（追記のみ。
#   既存の行を書き換えない。解放も「解放の行」を足す）。1 行 = タブ区切り 8 列:
#     時刻(epoch 秒)  claim|release  kind  target  PID  作業ツリー  開始時刻のキー  識別子
#   呼び出しの識別子（8 列目。任意）: claim / release の --call <ID> で渡す。
#     claim に --call を付けると、その登録に識別子を持たせる（8 列目。無ければ -）。
#     release に --call を付けると、その識別子の登録だけを解放する（kind / target を
#     併せて渡せば、その中でさらに絞る。無ければ、その識別子の登録すべて）。識別子は
#     照合のキーにも衝突の判定にも使わない。解放の単位にだけ使う。同じセッションが同じ
#     （kind, target）を別々の識別子で登録しても、衝突の判定は従来どおり。
#     --call の無い呼び出しは従来どおり、種類と対象の単位で登録・解放する（release は、
#     識別子の有無にかかわらずその（kind, target）の登録をすべて外す）。
#     いま有効な登録の判定: 同じ（kind, target）に識別子の違う claim が複数あるとき、
#     解放されていないものが 1 つでもあれば有効（1 件として表示・判定する）。
#     7 列（識別子なし）の古い台帳ファイルも読める（識別子は - として扱う）。
#   release の kind が * なら全部、target が * ならその種類すべてを解放する。
#
# セッションの識別子と持ち主の PID:
#   SESSION_LEDGER_ID があればそれを使う（英数字と ._- 以外は _ になる）。無ければ
#   pid-<持ち主の PID>。持ち主の PID は SESSION_LEDGER_PID があればそれ、無ければ祖先の
#   プロセスをたどって、最初に現れるシェル以外のプロセス（セッションを動かしている
#   本体）。見つからなければ親プロセス。識別子は pid-<PID>-<開始時刻のキー> で、
#   PID が再利用されても別のセッションとして扱う。
#   開始時刻のキー: /proc/<PID>/stat の 22 列目（起動からの経過のクロック数）。ホストの
#   時刻の付け直しやタイムゾーンで変わらない。/proc が無い環境（macOS など）では、
#   TZ=UTC・LC_ALL=C で読んだ `ps -o lstart=` の cksum に落とす（時刻の付け直しで変わり
#   うる）。キーの取り方が違う版の台帳（#433 より前の、lstart の cksum）の登録は、キーが
#   一致しないため失効として扱う（誤って止める側には倒れない）。
#   人がシェルから直接使うときは、同じ端末から起動した複数のシェルが同じ持ち主に
#   なりうるので、SESSION_LEDGER_ID を明示する。
#
# 失効:
#   次のどちらかなら、その登録は失効したものとして無視する。
#     - 持ち主の PID のプロセスが存在しない
#     - そのセッションの最後の更新から SESSION_LEDGER_TTL 秒（既定 28800）を超えた
#       （実行のあいだだけ持つ登録 = merge / git / gate は、セッションの最後の更新ではなく、
#       その登録（同じ kind, target）の最後の claim から数える。refresh で生かし続けない）
#
# 出力と終了コード（check / claim）:
#   標準出力の 1 行目が判定。LEDGER_OK（衝突なし）/ LEDGER_WARN（警告して通す）/
#   LEDGER_DENY（拒否）/ LEDGER_SKIP（台帳を読み書きできなかった。警告を出して通す）。
#   衝突があれば続けて、衝突ごとに 1 行
#     conflict: session=… kind=… target=… pid=… worktree=… age=…s
#   と、調整の手順を `coordinate` で始まる行で出す。
#   終了コードは LEDGER_DENY のときだけ 3。それ以外は 0（台帳の不具合は fail-open）。
#   使い方の誤りは 2。
#
# 更新（refresh）:
#   自分に生きている issue / doc の登録があり、最後の更新から SESSION_LEDGER_REFRESH_MIN 秒
#   （既定 300）以上たっていれば、その登録を 1 件だけ claim し直す（追記のみ）。issue / doc の
#   失効の判定はセッション単位で最後の更新を見るため、1 件で足りる。長く続くセッションが、
#   フックなどから呼んで失効を避けるための入口。頻繁に呼んでも台帳が膨らまない。
#   merge / git / gate の登録は claim し直さず、その失効も延ばさない。実行のあいだだけ持つ
#   はずの登録が、解放し損ねたまま（フックの版の切り替えなど）生き続けて、他のセッションを
#   止め続けないようにするため（#433）。
#
# 環境変数: SESSION_LEDGER_ID / SESSION_LEDGER_PID / SESSION_LEDGER_TTL /
#           SESSION_LEDGER_REFRESH_MIN / SESSION_LEDGER_DIR（置き場所を差し替える。試験用）
#
# bash 3.2 互換（連想配列・mapfile を使わない）。
set -u

warn() { echo "[session-ledger] WARN: $*" >&2; }

usage() {
  cat >&2 <<'USAGE'
usage: session-ledger.sh claim   [--call <ID>] <issue|doc|merge|git|gate> [target]
       session-ledger.sh release [--call <ID>] [<kind> [target]]
       session-ledger.sh list    [--others|--all]
       session-ledger.sh check   <issue|doc|merge|git|gate> [target]
       session-ledger.sh refresh
USAGE
}

TAB="$(printf '\t')"

valid_kind() {
  case "$1" in
    issue | doc | merge | git | gate) return 0 ;;
    *) return 1 ;;
  esac
}

# 止める強さ。種類ごとに固定する（規範の表と同じ）。
level_of() {
  case "$1" in
    issue | doc) echo "WARN" ;;
    *) echo "DENY" ;;
  esac
}

# ファイル名として安全な形へ直す。置き換えが起きたときは、元の識別子の cksum を足して、
# 別の識別子（a/b と a_b など）が同じファイルにならないようにする。置き換えが起きない
# 識別子は変えない。
sanitize() {
  local s sum
  s="$(printf '%s' "$1" | tr -c 'A-Za-z0-9._-' '_')"
  # 先頭の . は隠しファイルになり、台帳の読み出し（*.tsv）から漏れるので置き換える。
  case "$s" in .*) s="_${s#.}" ;; esac
  if [ "$s" != "$1" ]; then
    sum="$(printf '%s' "$1" | cksum | cut -d' ' -f1)"
    s="$s-$sum"
  fi
  printf '%s' "$s"
}

# ── 持ち主の PID とセッション識別子 ──────────────────────────────────────────

owner_pid() {
  local p pp comm base i
  if [ -n "${SESSION_LEDGER_PID:-}" ]; then
    echo "$SESSION_LEDGER_PID"
    return 0
  fi
  p=$$
  i=0
  while [ "$i" -lt 32 ]; do
    pp="$(ps -o ppid= -p "$p" 2>/dev/null | tr -d ' ')"
    case "$pp" in '' | *[!0-9]*) break ;; esac
    [ "$pp" -gt 1 ] || break
    comm="$(ps -o comm= -p "$pp" 2>/dev/null)"
    base="${comm##*/}"
    base="${base#-}"
    case "$base" in
      bash | sh | zsh | dash | ksh | fish | env | timeout | sudo | xargs)
        p="$pp"
        i=$((i + 1))
        continue
        ;;
    esac
    echo "$pp"
    return 0
  done
  # 持ち主を特定できない。PID 1 などは別のセッションと共有してしまうので使わない。
  case "$PPID" in '' | *[!0-9]*) return 0 ;; esac
  [ "$PPID" -gt 1 ] && echo "$PPID"
  return 0
}

# 持ち主を特定できないときは SELF_ID を空にし、登録・確認を警告して通す（fail-open）。
# SESSION_LEDGER_ID を明示した場合は、PID を特定できなくても親プロセスを使う。
# プロセスの開始時刻のキー。PID が再利用されたとき、別のプロセスと見分けるために使う。
# /proc があれば stat の 22 列目（起動からの経過のクロック数。時刻の付け直しやタイムゾーンで
# 変わらない）。2 列目のプロセス名は空白や括弧を含みうるので、最後の ")" の後ろ（3 列目から）
# を数える。/proc が無ければ、TZ と言語を固定した lstart の cksum。
# 取れないときは - を返す（従来の PID だけの判定に落ちる）。
proc_start_key() { # pid
  local stat start lstart sum
  case "$1" in '' | *[!0-9]*) printf '%s' "-"; return 0 ;; esac
  if [ -r "/proc/$1/stat" ]; then
    stat="$(cat "/proc/$1/stat" 2>/dev/null)" || stat=""
    case "$stat" in
      *')'*)
        stat="${stat##*\)}"
        start="$(printf '%s\n' "$stat" | awk '{ print $20 }')"
        case "$start" in
          '' | *[!0-9]*) ;;
          *) printf '%s' "$start"; return 0 ;;
        esac
        ;;
    esac
  fi
  lstart="$(TZ=UTC LC_ALL=C ps -o lstart= -p "$1" 2>/dev/null)"
  [ -n "$lstart" ] || { printf '%s' "-"; return 0; }
  sum="$(printf '%s' "$lstart" | cksum | cut -d' ' -f1)"
  printf '%s' "${sum:--}"
}

SELF_PID="$(owner_pid)"
SELF_ID=""
SELF_KEY="-"
if [ -n "${SESSION_LEDGER_ID:-}" ]; then
  SELF_ID="$(sanitize "$SESSION_LEDGER_ID")"
  [ -n "$SELF_PID" ] || SELF_PID="$PPID"
  SELF_KEY="$(proc_start_key "$SELF_PID")"
elif [ -n "$SELF_PID" ]; then
  SELF_KEY="$(proc_start_key "$SELF_PID")"
  SELF_ID="pid-$SELF_PID"
  [ "$SELF_KEY" = "-" ] || SELF_ID="$SELF_ID-$SELF_KEY"
fi

# 持ち主を特定できないとき 0 を返す（呼び出し側が警告して通す）。
owner_unknown() {
  [ -n "$SELF_ID" ] && return 1
  warn "セッションの持ち主を特定できません。SESSION_LEDGER_ID と SESSION_LEDGER_PID を指定してください。台帳を使わず通します。"
  return 0
}

# 持ち主が生きているか。登録時の開始時刻が分かっていて、いまのプロセスの開始時刻と
# 違えば、PID が再利用された別のプロセスなので、生きていないものとして扱う。
pid_alive() { # pid [開始時刻の cksum]
  local now_key
  case "$1" in '' | *[!0-9]*) return 1 ;; esac
  if ! kill -0 "$1" 2>/dev/null; then
    # 他ユーザーのプロセスは kill -0 が EPERM で失敗する。存在だけを ps で確かめる。
    ps -p "$1" >/dev/null 2>&1 || return 1
  fi
  case "${2:--}" in
    - | '') return 0 ;;
  esac
  now_key="$(proc_start_key "$1")"
  [ "$now_key" = "-" ] || [ "$now_key" = "$2" ]
}

# ── 置き場所 ──────────────────────────────────────────────────────────────────

LEDGER_DIR=""
resolve_dir() {
  local common
  if [ -n "${SESSION_LEDGER_DIR:-}" ]; then
    LEDGER_DIR="$SESSION_LEDGER_DIR"
    return 0
  fi
  common="$(git rev-parse --git-common-dir 2>/dev/null)" || return 1
  [ -n "$common" ] || return 1
  common="$(cd "$common" 2>/dev/null && pwd)" || return 1
  LEDGER_DIR="$common/session-ledger"
}

TOPLEVEL="$(git rev-parse --show-toplevel 2>/dev/null || true)"
[ -n "$TOPLEVEL" ] || TOPLEVEL="$(pwd)"
# シンボリックリンクをたどった実体のパスに揃える（同じ作業ツリーが別の表記で現れても一致させる）。
TOPLEVEL="$(cd -P "$TOPLEVEL" 2>/dev/null && pwd -P || printf '%s' "$TOPLEVEL")"

# 台帳の置き場所を使える状態にする。失敗したら呼び出し側が警告して通す。
ensure_dir() {
  resolve_dir || { warn "git リポジトリの共通ディレクトリを解決できません。台帳を使わず通します。"; return 1; }
  mkdir -p "$LEDGER_DIR" 2>/dev/null && [ -d "$LEDGER_DIR" ] && [ -w "$LEDGER_DIR" ] || {
    warn "台帳の置き場所を作れない、または書けません: $LEDGER_DIR。台帳を使わず通します。"
    return 1
  }
}

# ── 対象の正規化 ──────────────────────────────────────────────────────────────

# パスを絶対パスにし、. と .. を畳む。存在しない部分は、存在する親ディレクトリの実体
# から先を字句だけで畳む。末尾の / は保つ。
normalize_path() {
  local p="$1" trail="" abs out seg d rest real
  case "$p" in */) trail="/" ;; esac
  case "$p" in
    /*) abs="$p" ;;
    *) abs="$(pwd -P)/$p" ;;
  esac
  out=""
  set -f
  local IFS=/
  for seg in $abs; do
    case "$seg" in
      '' | .) ;;
      ..) out="${out%/*}" ;;
      *) out="$out/$seg" ;;
    esac
  done
  unset IFS
  set +f
  abs="${out:-/}"
  d="$abs"
  rest=""
  while [ ! -d "$d" ] && [ "$d" != "/" ]; do
    rest="/${d##*/}$rest"
    d="${d%/*}"
    [ -n "$d" ] || d="/"
  done
  real="$(cd -P "$d" 2>/dev/null && pwd -P)" || real="$d"
  abs="${real%/}$rest"
  [ -n "$abs" ] || abs="/"
  if [ "$abs" = "/" ]; then trail=""; fi
  printf '%s%s' "$abs" "$trail"
}

normalize_target() { # kind target
  local kind="$1" t="$2" top
  # タブと改行は書式を壊すので空白へ。
  t="$(printf '%s' "$t" | tr '\t\n\r' '   ')"
  case "$kind" in
    issue)
      t="${t#\#}"
      ;;
    doc)
      if [ -n "$t" ]; then
        t="$(normalize_path "$t")"
        case "$t" in
          "$TOPLEVEL"/*) t="${t#"$TOPLEVEL"/}" ;;
        esac
      fi
      ;;
    git)
      if [ -n "$t" ]; then t="$(normalize_path "$t")"; else t="$TOPLEVEL"; fi
      t="${t%/}"
      # 作業ツリーの下の階層を渡されても、その作業ツリーのルートへ揃える（cd した先や
      # git -C の先がサブディレクトリでも、同じ作業ツリーの登録と照合できるように）。
      if [ -d "$t" ]; then
        top="$(git -C "$t" rev-parse --show-toplevel 2>/dev/null)" || top=""
        if [ -n "$top" ]; then
          top="$(cd -P "$top" 2>/dev/null && pwd -P)" || top=""
          [ -n "$top" ] && t="$top"
        fi
      fi
      [ -n "$t" ] || t="/"
      ;;
  esac
  [ -n "$t" ] || t="-"
  printf '%s' "$t"
}

# ── 台帳の読み出し ────────────────────────────────────────────────────────────

# 1 セッションぶんのファイルを再生して、いま有効な登録を TSV で出す:
#   sid kind target pid worktree 最後の更新(epoch) 開始時刻のキー 識別子
# 最後の更新は、issue / doc ならセッションの最後の行の時刻、merge / git / gate なら
# その（kind, target）の有効な claim のうち最後の時刻（refresh で延ばさない。#433）。
# 壊れた行は読み飛ばし、件数を警告する。
replay_file() { # file sid
  awk -v sid="$2" -v file="$1" '
    BEGIN { FS = "\t"; bad = 0; last = 0 }
    {
      if (NF < 6 || $1 !~ /^[0-9]+$/ || ($2 != "claim" && $2 != "release") || $5 !~ /^[0-9]+$/) { bad++; next }
      if ($1 + 0 > last) last = $1 + 0
      cid = (NF >= 8 && $8 != "") ? $8 : "-"
      key = $3 "\034" $4 "\034" cid
      if ($2 == "claim") {
        live[key] = 1; ctime[key] = $1 + 0; kind[key] = $3; tgt[key] = $4; pid[key] = $5; wt[key] = $6; cids[key] = cid
        skey[key] = (NF >= 7 && $7 ~ /^[0-9]+$/) ? $7 : "-"
      } else {
        # 識別子の付いた解放は、その識別子の登録だけを（kind / target で絞って）外す。
        # 識別子の無い解放は、従来どおり種類と対象の単位で、識別子にかかわらず外す。
        for (x in live) {
          if (cid != "-" && cids[x] != cid) continue
          if ($3 != "*" && kind[x] != $3) continue
          if ($3 != "*" && $4 != "*" && tgt[x] != $4) continue
          delete live[x]
        }
      }
    }
    END {
      # 同じ（kind, target）に識別子の違う登録が複数あっても、1 件として出す（1 つでも
      # 解放されていなければ有効）。
      for (x in live) {
        kt = kind[x] "\034" tgt[x]
        if (!(kt in seen) || cids[x] != "-") { seen[kt] = 1; pick[kt] = x }
        if (!(kt in klast) || ctime[x] > klast[kt]) klast[kt] = ctime[x]
      }
      for (kt in pick) {
        x = pick[kt]
        upd = (kind[x] == "issue" || kind[x] == "doc") ? last : klast[kt]
        printf "%s\t%s\t%s\t%s\t%s\t%d\t%s\t%s\n", sid, kind[x], tgt[x], pid[x], wt[x], upd, skey[x], cids[x]
      }
      if (bad > 0) printf "[session-ledger] WARN: %s: 壊れた行を %d 件読み飛ばしました。\n", file, bad > "/dev/stderr"
    }
  ' "$1"
}

# 全セッションの有効な登録に、状態（live / expired）を付けて出す。
#   sid kind target pid worktree 最後の更新 age state 識別子
collect() {
  local f sid now ttl
  now="$(date +%s)"
  ttl="${SESSION_LEDGER_TTL:-28800}"
  case "$ttl" in '' | *[!0-9]*) ttl=28800 ;; esac
  for f in "$LEDGER_DIR"/*.tsv; do
    [ -e "$f" ] || continue
    sid="$(basename "$f" .tsv)"
    if [ ! -r "$f" ]; then
      warn "読めない台帳のファイルを読み飛ばします: $f"
      continue
    fi
    replay_file "$f" "$sid" | while IFS="$TAB" read -r a_sid a_kind a_tgt a_pid a_wt a_last a_key a_cid; do
      [ -n "$a_sid" ] || continue
      state="live"
      if ! pid_alive "$a_pid" "$a_key"; then
        state="expired"
      elif [ $((now - a_last)) -gt "$ttl" ]; then
        state="expired"
      fi
      printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
        "$a_sid" "$a_kind" "$a_tgt" "$a_pid" "$a_wt" "$a_last" "$((now - a_last))" "$state" "$a_cid"
    done
  done
}

# ── 衝突の判定 ────────────────────────────────────────────────────────────────

target_matches() { # kind query claimed
  local kind="$1" q="$2" c="$3"
  case "$kind" in
    merge | gate) return 0 ;;
    doc)
      [ "$q" = "$c" ] && return 0
      # 末尾が / の登録は、その配下すべてを指す。どちらか一方がもう一方の配下なら
      # 衝突とする（登録の順序に依らない）。
      case "$c" in
        */)
          case "$q" in
            "$c"*) return 0 ;;
          esac
          ;;
      esac
      case "$q" in
        */)
          case "$c" in
            "$q"*) return 0 ;;
          esac
          ;;
      esac
      return 1
      ;;
    *) [ "$q" = "$c" ] ;;
  esac
}

print_coordinate() { # 自分の識別子を除いた相手の一覧を引数にとる
  echo "coordinate: 相手のセッション（$*）と調整してください。相手が release するか、登録が失効（持ち主の PID が消える、または一定時間更新が無い）するまで待ちます。どちらが譲るかは自動では決まりません。"
  echo "coordinate[claude-code]: ListAgents で相手のセッションを確かめ、SendMessage で連絡します。"
  echo "coordinate[other]: 上記以外の実行環境では、利用者へ相手のセッションと作業ツリーを伝え、調整を依頼します。"
}

# check の本体。標準出力へ判定を出し、DENY のとき 3 を返す。
do_check() { # kind target
  local kind="$1" target="$2" level out peers n rows
  level="$(level_of "$kind")"
  rows="$(collect)" || rows=""
  out=""
  peers=""
  n=0
  while IFS="$TAB" read -r r_sid r_kind r_tgt r_pid r_wt _ r_age r_state _; do
    [ -n "$r_sid" ] || continue
    [ "$r_state" = "live" ] || continue
    [ "$r_sid" != "$SELF_ID" ] || continue
    [ "$r_kind" = "$kind" ] || continue
    target_matches "$kind" "$target" "$r_tgt" || continue
    n=$((n + 1))
    out="${out}conflict: session=$r_sid kind=$r_kind target=$r_tgt pid=$r_pid worktree=$r_wt age=${r_age}s"$'\n'
    peers="${peers:+$peers, }$r_sid"
  done <<EOF
$rows
EOF
  if [ "$n" -eq 0 ]; then
    echo "LEDGER_OK"
    return 0
  fi
  echo "LEDGER_$level"
  printf '%s' "$out"
  print_coordinate "$peers"
  [ "$level" = "DENY" ] && return 3
  return 0
}

# 呼び出しの識別子。--call で渡されたものを、セッションの識別子と同じ規則（sanitize）で
# 安全な形へ直す。置き換えが起きたときは元の値の cksum を足すので、a/b と a_b は別の識別子
# になる。渡されなければ - （識別子なし）。空文字と - は「識別子なし」と区別できないため、
# 使い方の誤りとして 1 を返す。
CALL_ID="-"
set_call_id() { # 値
  case "$1" in '' | -) return 1 ;; esac
  CALL_ID="$(sanitize "$1")"
}

append_record() { # op kind target
  printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "$(date +%s)" "$1" "$2" "$3" "$SELF_PID" "$TOPLEVEL" "$SELF_KEY" "$CALL_ID" \
    >>"$LEDGER_DIR/$SELF_ID.tsv" 2>/dev/null
}

# ── サブコマンド ──────────────────────────────────────────────────────────────

cmd_check() {
  local kind="${1:-}" target
  valid_kind "$kind" || { usage; return 2; }
  target="$(normalize_target "$kind" "${2:-}")"
  if owner_unknown; then
    echo "LEDGER_SKIP"
    return 0
  fi
  if ! ensure_dir; then
    echo "LEDGER_SKIP"
    return 0
  fi
  do_check "$kind" "$target"
}

cmd_claim() {
  local kind target res rc
  if [ "${1:-}" = "--call" ]; then
    [ "$#" -ge 2 ] || { usage; return 2; }
    set_call_id "$2" || { usage; return 2; }
    shift 2
  fi
  kind="${1:-}"
  valid_kind "$kind" || { usage; return 2; }
  target="$(normalize_target "$kind" "${2:-}")"
  if owner_unknown; then
    echo "LEDGER_SKIP"
    return 0
  fi
  if ! ensure_dir; then
    echo "LEDGER_SKIP"
    return 0
  fi
  res="$(do_check "$kind" "$target")"
  rc=$?
  if [ "$rc" -eq 3 ]; then
    # 拒否の種類は、衝突しているあいだは登録しない。登録すると相手も拒否される。
    printf '%s\n' "$res"
    return 3
  fi
  if ! append_record claim "$kind" "$target"; then
    warn "台帳へ書き込めませんでした。登録せず通します。"
    echo "LEDGER_SKIP"
    return 0
  fi
  printf '%s\n' "$res"
  echo "claimed: session=$SELF_ID kind=$kind target=$target"
  return 0
}

cmd_release() {
  local kind target
  if [ "${1:-}" = "--call" ]; then
    [ "$#" -ge 2 ] || { usage; return 2; }
    set_call_id "$2" || { usage; return 2; }
    shift 2
  fi
  kind="${1:-*}"
  target="${2:-*}"
  if [ "$kind" != "*" ]; then
    valid_kind "$kind" || { usage; return 2; }
    [ "$target" = "*" ] || target="$(normalize_target "$kind" "$target")"
  fi
  owner_unknown && return 0
  if ! ensure_dir; then
    return 0
  fi
  # 自分のファイルが無ければ解放するものも無い。
  [ -e "$LEDGER_DIR/$SELF_ID.tsv" ] || return 0
  if ! append_record release "$kind" "$target"; then
    # 解放の行を書けなかった。登録は残っている。fail-open の方針なので終了コードは 0 のまま
    # にし、残っていることが出力から分かるようにする（失効するか、書けるようになった後の
    # release で消える）。
    warn "台帳へ書き込めませんでした。解放できていません（登録が残っています）。"
    echo "release-failed: session=$SELF_ID kind=$kind target=$target（登録は残っています）"
    return 0
  fi
  echo "released: session=$SELF_ID kind=$kind target=$target"
  return 0
}

cmd_refresh() {
  local rows min
  owner_unknown && return 0
  min="${SESSION_LEDGER_REFRESH_MIN:-300}"
  case "$min" in '' | *[!0-9]*) min=300 ;; esac
  ensure_dir || return 0
  rows="$(collect)" || rows=""
  while IFS="$TAB" read -r r_sid r_kind r_tgt _ _ _ r_age r_state r_cid; do
    [ -n "$r_sid" ] || continue
    [ "$r_sid" = "$SELF_ID" ] || continue
    [ "$r_state" = "live" ] || continue
    # 実行のあいだだけ持つ登録は更新しない（解放し損ねた登録を生かし続けないため。#433）。
    case "$r_kind" in issue | doc) ;; *) continue ;; esac
    if [ "$r_age" -ge "$min" ]; then
      CALL_ID="${r_cid:--}"
      append_record claim "$r_kind" "$r_tgt" || warn "台帳へ書き込めませんでした。更新できていません。"
      echo "refreshed: session=$SELF_ID"
    fi
    break
  done <<EOF
$rows
EOF
  return 0
}

cmd_list() {
  local mode="${1:-}" rows
  case "$mode" in '' | --others | --all) ;; *) usage; return 2 ;; esac
  ensure_dir || return 0
  rows="$(collect)" || rows=""
  while IFS="$TAB" read -r r_sid r_kind r_tgt r_pid r_wt _ r_age r_state _; do
    [ -n "$r_sid" ] || continue
    if [ "$mode" != "--all" ] && [ "$r_state" != "live" ]; then continue; fi
    if [ "$mode" = "--others" ] && [ "$r_sid" = "$SELF_ID" ]; then continue; fi
    echo "session=$r_sid kind=$r_kind target=$r_tgt pid=$r_pid worktree=$r_wt age=${r_age}s state=$r_state"
  done <<EOF
$rows
EOF
  return 0
}

main() {
  local sub="${1:-}"
  [ "$#" -gt 0 ] && shift
  case "$sub" in
    claim) cmd_claim "$@" ;;
    release) cmd_release "$@" ;;
    list) cmd_list "$@" ;;
    check) cmd_check "$@" ;;
    refresh) cmd_refresh ;;
    *) usage; return 2 ;;
  esac
}

# source ガード。読み込まれただけのときは関数定義だけを提供する。
if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
  exit $?
fi
