#!/usr/bin/env bash
# check-isolated-build.sh — 配る現物のイメージを、7.1 の封じ込めのもとで実際に動かす。
#
# ─────────────────────────────────────────────────────────────────────────────
# **この検査は「本番構成の検証」ではない。** #103 で位置づけを書き直した。
#
# 本番の実行環境は AWS Lambda（コンテナイメージ。確定24 / 3.8）である。ここが回すのは
# ローカルの `docker run` であり、**同じイメージ・同じハンドラを、違う入口で動かして
# いる。** 7.1 の「`scripts/check-isolated-build.sh` は本番構成の検証ではなくなる」が
# 定めたとおりで、それでも残す理由は、**イメージが壊れていないことと上流の層
# （vendor 固定・許可パッケージ）の回帰検知**にある。
#
# ## 何を検証し、何を検証しないか
#
# | 検査 | 本番でも成立するか |
# |---|---|
# | イメージがビルドできる／指定されたものが在る | **する** |
# | **ハンドラの単体テスト**（`/tmp` の掃除） | **する**（同じコードが Lambda で動く） |
# | **`/tmp` の掃除がハンドラの先頭で走る** | **する**（7.1 の「受け入れた劣化」3 点目の要件そのもの） |
# | **呼び出しをまたいで残骸が残らない** | **する** |
# | Ebitengine が vendor から解決できる | **する**（`GOFLAGS=-mod=vendor` は本番でも効く） |
# | 成果物が申告と一致し、wasm と `.wasm.br` になる | **する** |
# | 壊れたソースが `ok=false` で返る | **する** |
# | **R2 の構成が無い／資格情報を読めないときに成功しない**（3.3-6） | **する**（同じコードが Lambda で動く） |
# | `--read-only`（`/tmp` 以外が書けない） | **する**（本番もプラットフォーム既定でそうなる） |
# | **`--network=none` が効いている** | **しない。本番に対応物が無い**（7.1 の「受け入れた劣化」1 点目） |
# | **実行ユーザーが uid 65534** | **しない。** Lambda は USER を解釈すると明記していない（同 5 点目） |
# | **`--pids-limit` / `no-new-privileges`** | **しない。対応物が無い**（同 4 点目） |
#
# **ずれの向きは「ローカルのほうが本番より強い」**（7.1 / 9.1）。ここが緑でも本番の
# egress が塞がっているわけではない。**逆に、ここが赤なら本番も壊れている。**
#
# ## v1.11 までとの違い
#
# - **入口が変わった。** `entrypoint.sh` の「標準入力＝ソース／標準出力＝base64」契約は
#   廃止した。入口は Lambda と共通のハンドラ（`docker/isolated-build/handler/`）で、
#   ここでは oneshot モードで叩く。**成果物は標準出力で運ばない**（下記）。
# - **`--tmpfs /work` と volume `/cache` を外した。** 本番で書けるのは `/tmp` だけで
#   （7.1 の対応表）、ハンドラは 3 領域を使わない。マウントしても production の
#   コードパスが触らないため、「書けること」を確かめても本番の何も保証しない。
#   7.1 の前提 2（`/cache` の chown）は、これで根拠ごと消えた。
# - **`--memory` / `--cpus` を本番の配分に合わせた**（3,008 MB / 1.7 vCPU。3.8）。
#   ※ 当初は 3,538 MB / 2 vCPU だった。**このアカウントの Lambda メモリ上限が
#   3,008 MB で、3,538 を宣言できない**（#103。terraform/build-function.tf に経緯）。
#   `--memory=512m --cpus=1` では実測 11.3 秒でタイムアウトに収まらず、
#   ここで測る時間が本番の判断材料にならない。
#
# ## 成果物を標準出力で運ばない理由（実測）
#
# docker の attach 経由の標準出力は、**標準入力が EOF に達したあと数秒走り続けると
# 標準出力も標準エラーもまるごと失われる**（終了コードは 0 のまま）。
# 2026-08-27、docker 28.5.1 の docker-outside-of-docker 構成で再現した
# （`sh -c 'cat >/dev/null; sleep 2; echo hello'` で確定的に起きる）。旧
# `entrypoint.sh` の注記が「無音で落ちる」と書いていたのはこれで、**暖機しても
# 回避できない。** そこで、入力は環境変数で渡し、結果は名前付きボリュームへ書かせて
# `docker cp` で取り出す。
#
# 前提: Docker が使えること。イメージの取得には初回のみネットワークが要る。
#   このためローカル層の受け入れ条件（scripts/acceptance.sh）へは入れない。
#
# 終了コード:
#   0 = ISOLATED_BUILD_PASS
#   1 = ISOLATED_BUILD_FAIL
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$(dirname "$HERE")"

# 検査するイメージ。既定はローカル用のタグで、その場合はこのスクリプトが自分で
# ビルドする。**外から IMAGE を渡したときはビルドしない。** CI では、レジストリへ
# 配る現物そのものを検査したい。ここで作り直すと、同じ Dockerfile から作った
# 「別のイメージ」を検査することになり、配られた版が検査を通った保証にならない。
IMAGE_EXTERNAL="${IMAGE:-}"
IMAGE="${IMAGE:-game-forge/isolated-build:local}"

# 結果を取り出すためのボリューム。**本番には存在しない書き込み領域である**が、
# 成果物を標準出力で運べない以上ほかに手が無い（冒頭の注記）。ハンドラ自身は
# ここを使わず、`--out-file` で示された先へ書くだけである。
OUT_VOLUME="${OUT_VOLUME:-game-forge-isolated-build-out}"

BUILD_TIMEOUT="${BUILD_TIMEOUT:-900}"
FAILURES=0
WORKDIR=""

# brotli の品質は**宣言から読む**（terraform/build-function.tf の local.build_brotli_quality）。
#
# ハンドラは既定値を持たない（handler/main.go）ので、検査側が何かを渡さなければ
# ならない。**ここへ数値を書き写すと、宣言を変えたときに検査だけが古い品質で
# 「10 秒に収まる」と言い続ける**（共通規範 12 章）。宣言のほうを読む。
BROTLI_QUALITY="${BROTLI_QUALITY:-}"
if [[ -z "$BROTLI_QUALITY" ]]; then
  BROTLI_QUALITY="$(sed -nE 's/^[[:space:]]*build_brotli_quality[[:space:]]*=[[:space:]]*([0-9]+).*/\1/p' \
    terraform/build-function.tf | head -1)"
fi

# タイムアウトも**宣言から読む**（同じ理由。#103 で 10 秒から 25 秒へ変えたとき、
# ここに 10000 が直書きされていて、検査だけが古い予算で判定し続ける形になっていた）。
BUDGET_SECONDS="$(sed -nE 's/^[[:space:]]*build_function_timeout_seconds[[:space:]]*=[[:space:]]*([0-9]+).*/\1/p' \
  terraform/build-function.tf | head -1)"

ng() {
  printf '[isolated-build] NG %s\n' "$1" >&2
  FAILURES=$((FAILURES + 1))
}
ok() { printf '[isolated-build] OK %s\n' "$1"; }
info() { printf '[isolated-build] .. %s\n' "$1"; }
fatal() {
  printf '[isolated-build] %s\n' "$1" >&2
  echo "ISOLATED_BUILD_FAIL"
  exit 1
}

# trap から呼ぶため、静的解析からは呼び出しが見えない。
# shellcheck disable=SC2329
cleanup() {
  [[ -n "$WORKDIR" ]] && rm -rf -- "$WORKDIR"
  docker rm -f "$OUT_VOLUME-reader" >/dev/null 2>&1 || true
  docker volume rm "$OUT_VOLUME" >/dev/null 2>&1 || true
  return 0
}
trap cleanup EXIT

command -v docker >/dev/null 2>&1 || fatal "docker が見つかりません。"
docker info >/dev/null 2>&1 || fatal "Docker デーモンへ接続できません。"
command -v jq >/dev/null 2>&1 || fatal "jq が見つかりません（結果 JSON の読み取りに要ります）。"

[[ -n "$BROTLI_QUALITY" ]] \
  || fatal "terraform/build-function.tf から build_brotli_quality を読めません（宣言が正本です）。"
[[ -n "$BUDGET_SECONDS" ]] \
  || fatal "terraform/build-function.tf から build_function_timeout_seconds を読めません（宣言が正本です）。"

WORKDIR="$(mktemp -d "${TMPDIR:-/tmp}/isolated-build.XXXXXX")" || fatal "一時ディレクトリを作成できませんでした。"

# 7.1 の docker run オプション一式。ここを配列で 1 か所に持ち、すべての検査で使う。
# 検査ごとに書き下すと、片方だけ制約が緩んだ状態で緑になる経路ができる。
#
# `/tmp` の大きさと `--memory` / `--cpus` は**本番の宣言に合わせてある**
# （terraform/build-function.tf: エフェメラルストレージ 1,024 MB / メモリ 3,008 MB）。
# Lambda の vCPU はメモリに比例し 1 vCPU = 1,769 MB なので、3,008 MB は 1.70 vCPU
# 相当になる。**本番より速い配分でここを緑にすると、10 秒の判定が甘くなる。**
#
# --tmpfs の値にはカンマ区切りのマウントオプションが入る。shellcheck は配列要素の
# 区切りと読み違えるが、ここは 1 要素として渡すのが正しい。
# shellcheck disable=SC2054
CONTAIN_OPTS=(
  --rm
  --network=none
  --read-only
  --tmpfs /tmp:rw,nosuid,nodev,size=1024m
  --user 65534:65534
  --pids-limit=64
  --memory=3008m
  --cpus=1.7
  --security-opt no-new-privileges
)

# ── イメージ ────────────────────────────────────────────────────────────────

if [[ -n "$IMAGE_EXTERNAL" ]]; then
  echo "[isolated-build] 指定されたイメージを検査します: $IMAGE"
  docker image inspect "$IMAGE" >/dev/null 2>&1 \
    || fatal "指定されたイメージがローカルにありません: $IMAGE"
  ok "指定されたイメージが存在する"
else
  echo "[isolated-build] イメージをビルドします: $IMAGE"
  # **Dockerfile が `go vet` と `go test` を走らせる。** 落ちればここで落ちる。
  if ! docker build -q -t "$IMAGE" docker/isolated-build >"$WORKDIR/build.log" 2>&1; then
    sed 's/^/    /' "$WORKDIR/build.log" >&2
    fatal "イメージのビルドに失敗しました（ハンドラのテストが落ちた可能性があります）。"
  fi
  ok "イメージをビルドできた（ハンドラの go vet / go test を含む）"
fi

# ── 1. ハンドラの単体テスト ─────────────────────────────────────────────────
#
# **掃除がテスト可能な単位であることは、7.1 が使い捨ての保証を手放す条件である。**
# イメージのビルドが同じテストを走らせるので二重だが、こちらは**イメージを作らない
# 経路（IMAGE を外から渡した場合）でも回り、失敗の中身がそのまま読める。**
#
# **ホストの Go の版が足りないときは回さない。** handler/go.mod は 1.26.5 を要求し、
# `GOTOOLCHAIN=local` があるので古い Go は toolchain を落としに行かず、
# `go.mod requires go >= 1.26.5 (running go 1.24.13)` で必ず落ちる。
# **GitHub のランナーが実際にこれを踏んだ**（2026-08-27。ランナーの Go は 1.24.13、
# 開発機は 1.26.5）。**開発機でだけ通る検査**になっていた。
#
# ここを「落とす」にすると、ホストの Go の版という**このイメージと無関係な理由**で
# 赤が出る。イメージのビルドが同じテストを同じ Go（1.26.5）で走らせているので、
# **担保は失われない。**
##
# 版 $1 が $2 以上かを判定する（`1.26.5` 形式）。
#
# **`sort -V` を使わない。** あれは GNU coreutils の拡張で、BSD の sort には無い。
# 無い環境では `sort` がエラーを返し、**判定が常に「足りない」へ倒れて検査が黙って
# 無効になる**（PR #108 の Copilot code review の指摘）。**検査していないことを
# 合格にしない**ためには、外部コマンドに依存しない形が要る。
#
# 戻り値: 0 = $1 >= $2 / 1 = それ以外
##
version_at_least() {
  local have="$1" want="$2" i
  local -a h w
  IFS=. read -r -a h <<<"$have"
  IFS=. read -r -a w <<<"$want"
  for ((i = 0; i < ${#w[@]}; i++)); do
    local hv="${h[i]:-0}" wv="${w[i]:-0}"
    # 数字でない断片（rc1 など）は 0 として扱う。厳密な比較は要らない。
    [[ "$hv" =~ ^[0-9]+$ ]] || hv=0
    [[ "$wv" =~ ^[0-9]+$ ]] || wv=0
    ((hv > wv)) && return 0
    ((hv < wv)) && return 1
  done
  return 0
}

HANDLER_GO_MIN="$(sed -nE 's/^go ([0-9.]+)$/\1/p' docker/isolated-build/handler/go.mod | head -1)"
if ! command -v go >/dev/null 2>&1; then
  info "go が無いため単体テストはここでは回しません（イメージのビルドが同じテストを走らせます）"
elif [[ -n "$HANDLER_GO_MIN" ]] \
  && ! version_at_least "$(go env GOVERSION | sed 's/^go//')" "$HANDLER_GO_MIN"; then
  info "ホストの Go が $(go env GOVERSION)（handler/go.mod は ${HANDLER_GO_MIN} 以上を要求）なのでここでは回しません（イメージのビルドが同じテストを走らせます）"
else
  if (cd docker/isolated-build/handler \
      && env GOFLAGS= GOOS=linux GOTOOLCHAIN=local go test ./... >"$WORKDIR/gotest.log" 2>&1); then
    ok "ハンドラの単体テストが通る（/tmp の掃除の単位）"
  else
    sed 's/^/    /' "$WORKDIR/gotest.log" >&2
    ng "ハンドラの単体テストが落ちました"
  fi
fi

# ── 実行ヘルパ ──────────────────────────────────────────────────────────────

##
# 結果用ボリュームを作り直し、実行ユーザーが書けるようにする。
##
out_reset() {
  docker volume rm "$OUT_VOLUME" >/dev/null 2>&1 || true
  docker volume create "$OUT_VOLUME" >/dev/null
  docker run --rm -v "$OUT_VOLUME":/out --user 0:0 --entrypoint /bin/sh "$IMAGE" \
    -c 'chown 65534:65534 /out' >/dev/null
}

##
# ボリューム上のファイルをホストへ取り出す。
#
#   out_fetch <ボリューム内のパス> <ホスト側の出力先>
#
# **`docker run ... cat` では取り出さない。** 標準出力は失われうる（冒頭の注記）。
# `docker cp` は attach を経由しないため、この失敗の影響を受けない。
##
out_fetch() {
  local src="$1" dst="$2" cid="$OUT_VOLUME-reader"
  docker rm -f "$cid" >/dev/null 2>&1 || true
  docker create --name "$cid" -v "$OUT_VOLUME":/out "$IMAGE" >/dev/null
  local rc=0
  docker cp "$cid:/out/$src" "$dst" >/dev/null 2>&1 || rc=1
  docker rm -f "$cid" >/dev/null 2>&1 || true
  return "$rc"
}

# R2 への書き戻し（3.3-6）の構成。
#
# **この検査は R2 へ書けない。** `--network=none` なので SSM にも R2 にも到達できない。
# ハンドラは**未設定を「書かない」と読み替えない**（`R2_CREDENTIALS_PARAMETER` が
# 無ければ起動しない。handler/r2.go）ので、検査側が「書かない」を明示する。
#
# **既定値としてここに書き写しているのではない。** 本番の宣言は
# terraform/build-function.tf の `R2_CREDENTIALS_PARAMETER` で、こちらはローカルの
# 検査だけが使う逃げ道である。**逃げ道が本番へ紛れ込まないこと自体を、下の
# 「4. R2 の構成」で検査する。**
R2_ENV_OPTS=(-e "R2_UPLOAD=skip")

##
# 封じ込め下でハンドラを走らせる。
#
#   run_handler <ソースのパス> <ボリューム内で使う接頭辞> [シェルの前処理]
#
# 第 3 引数は、ハンドラを起動する前に `/tmp` へ細工をするためにある
# （掃除の検査で「前回の残骸」を置く）。
#
# R2 の構成は `R2_ENV_OPTS`（配列）で渡す。呼び出しごとに差し替えられる。
##
run_handler() {
  local source_file="$1" prefix="$2" pre="${3:-true}"
  local event
  event="$(jq -Rs '{source: .}' <"$source_file")"

  # **診断も一覧も、ハンドラの終了コードに関わらず書く。** 失敗したときにこそ
  # 中身が要る。終了コードは最後にそのまま返す。
  timeout "$BUILD_TIMEOUT" docker run -e "EVENT_JSON=$event" -e "BROTLI_QUALITY=$BROTLI_QUALITY" \
    "${R2_ENV_OPTS[@]}" \
    "${CONTAIN_OPTS[@]}" -v "$OUT_VOLUME":/out \
    --entrypoint /bin/sh "$IMAGE" -c "
      rc=0
      $pre
      /build-handler --oneshot --out-file /out/${prefix}.json > /out/${prefix}.log 2>&1 || rc=\$?
      echo \"rc=\$rc\" >> /out/${prefix}.log
      # 呼び出し後の /tmp の中身を記録する。掃除の検査がこれを読む。
      ls -A /tmp > /out/${prefix}.tmp-listing 2>&1 || true
      exit \$rc
    "
}

##
# ホストのファイルをボリュームへ置く。
#
#   out_put <ホスト側のパス> <ボリューム内での名前>
##
out_put() {
  local src="$1" name="$2" cid="$OUT_VOLUME-reader"
  docker rm -f "$cid" >/dev/null 2>&1 || true
  docker create --name "$cid" -v "$OUT_VOLUME":/out "$IMAGE" >/dev/null
  local rc=0
  docker cp "$src" "$cid:/out/$name" >/dev/null 2>&1 || rc=1
  docker rm -f "$cid" >/dev/null 2>&1 || true
  return "$rc"
}

##
# base64 の復号と sha256 の算出は、GNU 版と BSD 版でオプションが違う
# （GNU: `base64 -d` / `sha256sum`、BSD/macOS: `base64 -D` / `shasum -a 256`）。
# GNU 版を決め打つと macOS で原因の読めない失敗になるため、openssl を最後の受け皿にする。
##
decode_base64() {
  local src="$1" dst="$2"
  base64 -d <"$src" >"$dst" 2>/dev/null && return 0
  base64 -D <"$src" >"$dst" 2>/dev/null && return 0
  command -v openssl >/dev/null 2>&1 && openssl base64 -d -A -in "$src" -out "$dst" 2>/dev/null && return 0
  return 1
}

sha256_of() {
  local path="$1"
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$path" | cut -d' ' -f1
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$path" | cut -d' ' -f1
  elif command -v openssl >/dev/null 2>&1; then
    openssl dgst -sha256 "$path" | awk '{print $NF}'
  else
    return 1
  fi
}

# ── 2. 実ビルド・掃除・使い捨て ─────────────────────────────────────────────
#
# **Ebitengine のサンプルで測る。** 標準ライブラリだけの小さなサンプルは速いが、
# **vendor が空でも通ってしまう。** 焼き込みが効いているかは、許可パッケージの外部
# モジュールをすべて使うサンプルを `--network=none` でビルドして初めて分かる。
#
# 同じ実行の中で **2 回**呼ぶ。1 回目の前に残骸を置いておき、
#
#   - 1 回目のあとに残骸が消えていること     → 掃除がハンドラの先頭で走っている
#   - 2 回目のあとに作業ディレクトリが 1 つだけ → 呼び出しをまたいで残らない
#
# を同時に確かめる。**これが 7.1 の「受け入れた劣化」3 点目の運用担保そのものである。**
echo "[isolated-build] Ebitengine のサンプルを 2 回ビルドします（brotli q${BROTLI_QUALITY} / 最大 ${BUILD_TIMEOUT} 秒）"
out_reset

MARKER="residue-from-a-previous-invocation"
PRE="
  mkdir -p /tmp/$MARKER/nested
  echo leftover > /tmp/$MARKER/nested/file
  echo leftover > /tmp/.hidden-residue
"

if run_handler docker/isolated-build/sample/ebitengine.go first "$PRE" \
   && run_handler docker/isolated-build/sample/ebitengine.go second; then
  ok "封じ込め下で Ebitengine のサンプルを 2 回ビルドできた"
else
  out_fetch first.log "$WORKDIR/first.log" && sed 's/^/    /' "$WORKDIR/first.log" >&2 || true
  ng "封じ込め下でのビルドが失敗しました"
fi

if out_fetch first.json "$WORKDIR/first.json"; then
  if [[ "$(jq -r '.ok' <"$WORKDIR/first.json")" == "true" ]]; then
    ok "成果物が返った（ok=true）"
  else
    jq -r '"    stage=\(.stage) \(.message)"' <"$WORKDIR/first.json" >&2
    ng "ビルドが ok=false で返りました"
  fi

  # **申告と実物を突き合わせる。終了コードだけを信用しない。**
  # 経路のどこかで切り詰めが起きたら、ここで合わなくなる。
  jq -r '.compressed.data // ""' <"$WORKDIR/first.json" | tr -d '\n' >"$WORKDIR/game.br.b64"
  if [[ -s "$WORKDIR/game.br.b64" ]] && decode_base64 "$WORKDIR/game.br.b64" "$WORKDIR/game.wasm.br"; then
    actual_bytes="$(wc -c <"$WORKDIR/game.wasm.br" | tr -d '[:space:]')"
    reported_bytes="$(jq -r '.compressed.bytes' <"$WORKDIR/first.json")"
    actual_sha="$(sha256_of "$WORKDIR/game.wasm.br")"
    reported_sha="$(jq -r '.compressed.sha256' <"$WORKDIR/first.json")"

    if [[ "$actual_bytes" == "$reported_bytes" && "$actual_sha" == "$reported_sha" ]]; then
      ok ".wasm.br が申告と一致する（${actual_bytes} バイト）"
    else
      ng ".wasm.br が申告と一致しません（申告 ${reported_bytes}B/${reported_sha:0:12} ≠ 受領 ${actual_bytes}B/${actual_sha:0:12}）"
    fi

    # brotli にマジックナンバーは無い。**復号して wasm に戻ることで確かめる。**
    # 3.4-1 が R2 へ置くのは `.wasm.br` なので、戻らないものを置くわけにはいかない。
    #
    # ホストに brotli(1) があるとは限らない（devcontainer には無い）。**無ければ
    # イメージの中の brotli を使う**。イメージには必ず入っている（Dockerfile）。
    if command -v brotli >/dev/null 2>&1; then
      brotli -d -f -o "$WORKDIR/game.wasm" "$WORKDIR/game.wasm.br" 2>/dev/null || true
    elif out_put "$WORKDIR/game.wasm.br" decode.wasm.br; then
      docker run --rm -v "$OUT_VOLUME":/out --network=none --user 0:0 \
        --entrypoint /bin/sh "$IMAGE" \
        -c 'brotli -d -f -o /out/decode.wasm /out/decode.wasm.br' >/dev/null 2>&1 || true
      out_fetch decode.wasm "$WORKDIR/game.wasm" || true
    fi

    magic="$(head -c 4 "$WORKDIR/game.wasm" 2>/dev/null | od -An -tx1 | tr -d ' \n')"
    if [[ "$magic" == "0061736d" ]]; then
      ok "復号すると wasm のマジックナンバー（\\0asm）に戻る"
    else
      ng "復号しても wasm になりません（先頭 4 バイト: ${magic:-空}）"
    fi
  else
    ng ".wasm.br を base64 として復号できませんでした"
  fi

  # 所要時間。**必ず出すが、値では落とさない。**
  #
  # **ここで測れるのは「この機械での時間」であって、Lambda での時間ではない。**
  # 同じ `--cpus=2` でも機械差が大きい（2026-08-27 の実測: 開発機 5,392 ms /
  # GitHub のランナー 14,598 ms ＝ **2.7 倍**）。どちらも Lambda ではない。
  #
  # 値で落とすと、**機械が遅いという、この変更と無関係な理由で赤が出る**。
  # #99 が塞いだ「原因の読めない赤」を新しく作ることになる。
  #
  # **3.8 の 10 秒の判定は Lambda 上の実測が持つ。** ここは回帰を目で見るための
  # 数字であり、極端に伸びたときに気づくためのものである。
  total_ms="$(jq -r '.timings.totalMs' <"$WORKDIR/first.json")"
  jq -r '"    timings: \(.timings)"' <"$WORKDIR/first.json" >&2
  if [[ "$total_ms" =~ ^[0-9]+$ ]] && ((total_ms < BUDGET_SECONDS * 1000)); then
    ok "1 回の呼び出しが ${total_ms} ms（この機械では ${BUDGET_SECONDS} 秒に収まる。**Lambda の判定ではない**）"
  else
    info "1 回の呼び出しが ${total_ms} ms（この機械では ${BUDGET_SECONDS} 秒を超える。**Lambda の判定ではない**。3.8 の判定は Lambda 上の実測が持つ）"
  fi
else
  ng "1 回目の結果を取り出せませんでした"
fi

# 掃除（7.1 の「受け入れた劣化」3 点目）。
if out_fetch first.tmp-listing "$WORKDIR/first.listing"; then
  if grep -q "$MARKER" "$WORKDIR/first.listing" || grep -q '\.hidden-residue' "$WORKDIR/first.listing"; then
    sed 's/^/    /' "$WORKDIR/first.listing" >&2
    ng "前の呼び出しの残骸が /tmp に残っています（掃除がハンドラの先頭で走っていない）"
  else
    ok "ハンドラの先頭で /tmp が掃除されている（隠しファイルごと消える）"
  fi
else
  ng "1 回目の /tmp の一覧を取り出せませんでした"
fi

if out_fetch second.tmp-listing "$WORKDIR/second.listing"; then
  # **Rosetta の残骸だけは数えない（#103）。** Apple Silicon の機械で amd64 の
  # イメージを動かすと、Docker Desktop の Rosetta が `$HOME/.cache/rosetta` を作る。
  # Dockerfile が `HOME=/tmp` にしているため、これが `/tmp/.cache` として現れる。
  #
  # **ハンドラの残骸ではなく、エミュレーションの足跡である。** Lambda（実 x86_64）でも
  # amd64 のランナーでも生じない。除かないと、初回構築のときだけ**中身の無い赤**が出る。
  #
  # **除外は `.cache` の 1 語に限る。** 「掃除されていない」を見逃す穴になり得るので、
  # 前方一致や広い正規表現にはしない。エミュレーションしているときだけ効かせる。
  image_arch="$(docker image inspect "$IMAGE" --format '{{.Architecture}}' 2>/dev/null || true)"
  host_arch="$(docker version --format '{{.Server.Arch}}' 2>/dev/null || true)"
  if [[ -n "$image_arch" && -n "$host_arch" && "$image_arch" != "$host_arch" ]]; then
    if grep -qx '\.cache' "$WORKDIR/second.listing"; then
      info "/tmp/.cache は Rosetta の足跡として数えません（${host_arch} の機械で ${image_arch} のイメージを動かしています）"
      grep -vx '\.cache' "$WORKDIR/second.listing" >"$WORKDIR/second.listing.filtered" || true
      mv "$WORKDIR/second.listing.filtered" "$WORKDIR/second.listing"
    fi
  fi
  leftovers="$(grep -c . "$WORKDIR/second.listing" || true)"
  if [[ "$leftovers" == "1" ]]; then
    ok "2 回目のあと /tmp に残るのは今回の作業ディレクトリ 1 つだけ"
  else
    sed 's/^/    /' "$WORKDIR/second.listing" >&2
    ng "呼び出しをまたいで /tmp に ${leftovers} 件残っています"
  fi
else
  ng "2 回目の /tmp の一覧を取り出せませんでした"
fi

# ── 3. 壊れたソースがきちんと失敗する ───────────────────────────────────────
#
# 成功だけを見ていると、ビルドしていなくても緑になる経路に気づけない。
# **`ok=false` で返ること**まで見る。関数の障害として返ると、3.8 の degrade 判定
# （「ビルド依頼の失敗」で発火する）が利用者のコードの誤りで誤爆する。
printf 'package main\nfunc main() { this is not go }\n' >"$WORKDIR/broken.go"
if run_handler "$WORKDIR/broken.go" broken && out_fetch broken.json "$WORKDIR/broken.json"; then
  if [[ "$(jq -r '.ok' <"$WORKDIR/broken.json")" == "false" \
     && "$(jq -r '.stage' <"$WORKDIR/broken.json")" == "build" ]]; then
    ok "壊れたソースは ok=false / stage=build で返る"
  else
    jq -c . <"$WORKDIR/broken.json" | sed 's/^/    /' >&2
    ng "壊れたソースが build 段の失敗として返っていません"
  fi
else
  ng "壊れたソースの呼び出しが結果を返しませんでした"
fi

# ── 4. R2 への書き戻しの構成（3.3-6） ───────────────────────────────────────
#
# **ここで確かめるのは「書けること」ではない**（`--network=none` なので書けない）。
# 確かめるのは **「書けないときに成功しないこと」** である。
#
# 3.3-6 が成立していない状態で `ok=true` が返ると、呼び出し側（3.3-8）は
# **成果物の無いキーで `games` 行を作る。** 壊れていることに気づくのは、
# 作者が試遊した瞬間（5.4）か、公開後のプレイヤーである。
#
# 2 つの落とし方を見る。**どちらも「黙って成功」の経路そのものである。**
#
#   - 宣言（terraform/build-function.tf）から環境変数が落ちた   → 起動しない
#   - 資格情報を読みに行けない（SSM へ到達できない・権限が無い） → 呼び出しが失敗する
echo "[isolated-build] R2 への書き戻しの構成を検査します（3.3-6）"

# (1) 構成が無いまま動き出さない。**未設定を「書かない」と読み替えない。**
out_reset
R2_ENV_OPTS=()
if run_handler docker/isolated-build/sample/ebitengine.go noconfig >/dev/null 2>&1; then
  ng "R2 の構成が無いのに成功しました（未設定を「書かない」と読み替えています）"
else
  if out_fetch noconfig.json "$WORKDIR/noconfig.json"; then
    ng "R2 の構成が無いのに結果を返しました"
  else
    ok "R2 の構成が無ければ起動しない（黙って成果物だけ返さない）"
  fi
fi

# (2) 資格情報を読めなければ、呼び出しは失敗する。
#
# **ビルドが通ったうえで**書き戻しに失敗する経路を見る。`ok=true` が返れば
# 「R2 に無いのに成功した」ことになる。
#
# **Ebitengine のサンプルは使わない。** ここで見たいのは書き戻しの側だけで、
# ビルドの中身は上の 2 で見ている。標準ライブラリだけの最小のソースにして、
# 検査 1 回分の時間を足さない。
printf 'package main\n\nfunc main() {}\n' >"$WORKDIR/minimal.go"
out_reset
R2_ENV_OPTS=(-e "R2_CREDENTIALS_PARAMETER=/game-forge/prod/r2-credentials" -e "AWS_REGION=ap-northeast-1")
if run_handler "$WORKDIR/minimal.go" unreachable >/dev/null 2>&1; then
  ng "SSM へ到達できないのに成功しました"
else
  if out_fetch unreachable.json "$WORKDIR/unreachable.json"; then
    jq -c . <"$WORKDIR/unreachable.json" | sed 's/^/    /' >&2
    ng "資格情報を読めないのに結果を返しました（黙って成功しています）"
  else
    ok "資格情報を読めなければ関数の障害として落ちる（成果物だけ返さない）"
  fi
fi
R2_ENV_OPTS=(-e "R2_UPLOAD=skip")

# ── 5. 封じ込めそのもの（ローカルにしか無い層を含む） ───────────────────────
#
# **ここから下は本番構成の検証ではない**（冒頭の表）。設定が外れたことに気づけない
# まま緑が出続けるのを防ぐために残している。

# ネットワークへ到達できないこと。
#
# `ip` コマンドは使わない。golang イメージに iproute2 が入っておらず、
# `ip -o link show | wc -l` は常に 0 を返すため、`--network=bridge` でも
# 「インターフェイス無し」と読めてしまう（実測。当初それで偽陰性になっていた）。
# 判定は経路表で行う。`--network=none` では /proc/net/route に 1 件も無い。
net_routes="$(docker run --rm --entrypoint /bin/sh "${CONTAIN_OPTS[@]:1}" "$IMAGE" \
  -c 'tail -n +2 /proc/net/route | wc -l' 2>/dev/null || echo "error")"
net_ifaces="$(docker run --rm --entrypoint /bin/sh "${CONTAIN_OPTS[@]:1}" "$IMAGE" \
  -c 'ls /sys/class/net | grep -c "^eth" || true' 2>/dev/null || echo "error")"

if [[ "$net_routes" == "0" && "$net_ifaces" == "0" ]]; then
  ok "コンテナに経路も外部インターフェイスも無い（--network=none。**本番に対応物は無い**）"
else
  ng "ネットワークへ到達しうる状態です（経路 ${net_routes} 件 / eth 系 ${net_ifaces} 個）"
fi

# ルートファイルシステムが読み取り専用であること。
#
# **この検査だけは root で実行する。** uid 65534 では、--read-only の有無に関わらず
# / へ書き込めない（/ は root 所有 0755）。非 root のまま検査すると「書けなかった」の
# 原因が読み取り専用なのか権限なのか区別できず、--read-only を外しても緑になる
# （実測。当初それで偽陰性になっていた）。--user を後ろに置いて上書きする。
if docker run --rm --entrypoint /bin/sh "${CONTAIN_OPTS[@]:1}" --user 0:0 "$IMAGE" \
     -c 'touch /should-fail' >/dev/null 2>&1; then
  ng "root でルートファイルシステムへ書き込めました（--read-only が効いていない）"
else
  ok "ルートファイルシステムが読み取り専用（root でも書けない。**本番も同じ性質を持つ**）"
fi

# 書き込みが許された唯一の場所が実際に書けること。読み取り専用にしすぎると
# `go build` が動かないため、「塞がっている」だけでなく「必要な穴が開いている」ことも
# 確かめる。**本番でも書けるのは /tmp だけである。**
if docker run --rm --entrypoint /bin/sh "${CONTAIN_OPTS[@]:1}" "$IMAGE" \
     -c 'touch /tmp/a' >/dev/null 2>&1; then
  ok "/tmp が書き込み可能（本番で書けるのもここだけ）"
else
  ng "/tmp へ書き込めません"
fi

# 実行ユーザー。**--user を書いただけでは、効いていることの確認にならない。**
actual_uid="$(docker run --rm --entrypoint /usr/bin/id "${CONTAIN_OPTS[@]:1}" "$IMAGE" -u 2>/dev/null || true)"
if [[ "$actual_uid" == "65534" ]]; then
  ok "実行ユーザーが uid 65534（**本番では固定できない**。7.1 の劣化 5 点目）"
else
  ng "実行ユーザーが 65534 ではありません（実測: ${actual_uid:-取得できず}）"
fi

# vendor が /src に焼かれていること（7.1 の前提 1）。
#
# **`--tmpfs /work` に隠れていないか**という当初の検査は、本番のハンドラが
# `/work` を使わなくなったため意味を失った。代わりに、**焼き込みそのもの**と、
# **読み取り専用のまま複製できること**を見る。
vendor_check="$(docker run --rm --entrypoint /bin/sh "${CONTAIN_OPTS[@]:1}" "$IMAGE" \
  -c 'test -f /src/vendor/modules.txt && mkdir -p /tmp/work && cp -R /src/. /tmp/work/ && test -f /tmp/work/vendor/modules.txt && echo ok' 2>/dev/null || true)"
if [[ "$vendor_check" == "ok" ]]; then
  ok "vendor が /src に焼かれ、読み取り専用のまま /tmp へ複製できる"
else
  ng "vendor が /src に無いか、/tmp へ複製できていません（7.1 の前提 1）"
fi

if [[ "$FAILURES" -gt 0 ]]; then
  printf '[isolated-build] %s 件の検査に失敗しました。\n' "$FAILURES" >&2
  echo "ISOLATED_BUILD_FAIL"
  exit 1
fi

echo "ISOLATED_BUILD_PASS"
exit 0
