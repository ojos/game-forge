#!/usr/bin/env bash
# acceptance.sh — このプロジェクトの受け入れ条件（プロジェクトが所有・編集する）
#
# verify.sh がこのスクリプトを実行し、終了コードで合否を判定する。
# 生成時は、選択言語のマニフェスト（package.json / go.mod など）がルート直下に
# 存在する対象だけを、その言語の慣習的なテストで検証する。マニフェストが無い言語は
# スキップし（失敗させない）、マニフェストはあるがツールが無い場合は導入手順を添えて
# 失敗させる。1 つも検証できなければ「受け入れ条件が未定義」として非0で終了する。
# プロジェクトの実態（テスト・ビルド・lint・E2E など）に合わせて自由に編集すること。
# 受け入れ条件が検証可能であるほど、ループコーディングの反復が収束しやすくなる。
#
# 終了コード: 0 = 合格 / 非0 = 不合格・未定義
set -euo pipefail

# 検証はプロジェクトルート基準で行う。scripts/ の 1 階層上がルート。
# 任意の作業ディレクトリから起動しても結果が不変になるよう、起動時 CWD に依存しない。
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$(dirname "$HERE")"

echo "[acceptance] project acceptance checks"
# 実際に検証を 1 つでも実行したか。1 つも実行できなければ「合格」ではなく失敗にする。
# 検証していないことを合格として報告するのが最悪であるため。
ran_any=0

# 追跡ファイルへの「表示されない制御文字」混入の検査（#134）。
#
# **一番手前に置く。** 言語のマニフェストに依存せず、0.03 秒で終わり、しかも混入したまま
# 先へ進むと後続の道具が読み取りにくい形で壊れる（エディタ・差分・リンタが扱いを誤る）。
# 安い検査から落として反復を短くするのは、verify.sh が機密混入検査を受け入れ条件の
# 手前へ置いているのと同じ考え方である。
#
# 判定はスクリプト側が持つ（理由と禁止範囲は scripts/check-control-chars.sh の冒頭）。
# verify.sh ではなくこちらへ置くのは、verify.sh が直接呼ぶのを機密混入という別格の
# 関心事に限っているため。
#
# ran_any は立てない。この検査はマニフェストに関係なく必ず走るため、立てると
# 「テストを 1 つも実行していないのに合格」を作れてしまう（下の /waitlist 検査と同じ）。
echo "[acceptance] (hygiene) scripts/check-control-chars.sh"
bash scripts/check-control-chars.sh

# Go の版の写しと正本（ARG GO_VERSION）の機械照合（#141 / shared-ai-rules 12 章）。
#
# **前寄りに置く。** 35 ms で終わり（実測。同スクリプト末尾）、npm test より 2 桁安い。
# 安い検査から落として反復を短くするのは、上の制御文字検査や verify.sh の機密混入検査と
# 同じ考え方である。
#
# **判定はスクリプト側が持つ**（記録と写しの見分けかた、除外を表現する形、承知のうえで
# 受け入れた限界は scripts/check-go-version-copies.sh の冒頭）。
#
# 走査そのものは追跡ファイル全体に及ぶが、**照合の起点は docker/isolated-build/Dockerfile
# の `ARG GO_VERSION`** なので、正本が無いプロジェクトでは走らせても意味がない。他の検査が
# マニフェストの有無で分岐しているのと同じ形にそろえる。
if [[ -f docker/isolated-build/Dockerfile ]]; then
  echo "[acceptance] (go-version) scripts/check-go-version-copies.sh"
  bash scripts/check-go-version-copies.sh
  ran_any=1
else
  echo "[acceptance] (go-version) skip: docker/isolated-build/Dockerfile not found"
fi

# 基盤のリトライが 0 と宣言されていること（#160 / 4.3）。
#
# **前寄りに置く。** grep 数本で終わり、npm test より 2 桁安い。しかも外すと
# 1 回の送信から**最大 9 回・約 144 円・日次枠 9 個**が出る（5.2-7 の 3 試行との
# 掛け算）。安い検査から落として反復を短くするのは、上の検査群と同じ考え方である。
#
# **判定はスクリプト側が持つ**（何を見て、なぜ見るのかは
# scripts/check-orchestrator-retry.sh の冒頭）。宣言と実状態の一致は外部層
# （scripts/acceptance-remote.sh）が見る。ここが見るのは宣言だけである。
if [[ -f terraform/orchestrator.tf ]]; then
  echo "[acceptance] (orchestrator) scripts/check-orchestrator-retry.sh"
  bash scripts/check-orchestrator-retry.sh
  ran_any=1
else
  echo "[acceptance] (orchestrator) skip: terraform/orchestrator.tf not found"
fi

# シェルスクリプトが GNU 拡張に依存していないこと（BSD / macOS で落ちる書き方）。
#
# **前寄りに置く。** grep 数本で終わる。**同じ事故を 3 度繰り返した**（第 1 波の
# GNU 拡張オプション、第 2 波の `date +%s%N` と `sha256sum`、第 4 波の `mktemp`）。
# いずれもこの開発環境（Linux / GNU coreutils）では通り、**利用者の端末（macOS）で
# 落ちる。** しかも落ちるのは、配備や検証という**利用者が自分で叩く手順の中**である。
#
# **判定はスクリプト側が持つ**（表と、この検査が約束しないことは
# scripts/check-shell-portability.sh の冒頭）。**網羅ではない**——踏んだ事故を表へ
# 足していく形なので、緑でも macOS で落ちうる。
if [[ -d scripts ]]; then
  echo "[acceptance] (portability) scripts/check-shell-portability.sh"
  bash scripts/check-shell-portability.sh
  ran_any=1
else
  echo "[acceptance] (portability) skip: scripts/ not found"
fi

# OGP 撮影の「写し」の機械照合（#26 / #235 / shared-ai-rules 12 章）。
#
# **前寄りに置く。** 23 ms で終わる（実測）。外すと、宣言と実装がずれた状態がどれも
# **黙って壊れる**形で本番へ出る——関数名がずれれば撮影が呼べず、コールバックの綴りが
# ずれれば ogp_state が capturing のまま残り、ローダーの合図がずれれば撮影は必ず
# 時間切れになる（判定と理由は scripts/check-ogp-copies.sh の冒頭）。
#
# **これまで手で叩く手順にしか無かった**（docs/ogp-capture.md 3 章・6.1）。#235 で
# 「中断した撮影の検出が読む定数」という 7 組目の照合が増えたので、ここへ移す
# ——**思い出して叩く運用は破綻する**（.github/project-ai-rules.md「単一入口」）。
if [[ -f terraform/ogp-function.tf ]]; then
  echo "[acceptance] (ogp) scripts/check-ogp-copies.sh"
  bash scripts/check-ogp-copies.sh
  ran_any=1
else
  echo "[acceptance] (ogp) skip: terraform/ogp-function.tf not found"
fi

# 検査が読む terraform output が、宣言側に実在すること（#160 / shared-ai-rules 12 章）。
#
# **前寄りに置く。** grep 数本で終わる。外すと、宣言側で output を改名・削除したときに
# 外部層の検査が**空のまま比較して緑になる**（実際に #160 で起きた。停止対象が IAM
# ユーザーからロールへ移ったとき、層 2 の検査は消えた output と消えた環境変数を
# 突き合わせて緑だった）。**確かめていない検査は、赤より悪い。**
#
# **判定はスクリプト側が持つ**（scripts/check-tf-output-refs.sh の冒頭）。
# ネットワークも AWS の認証も要らない（宣言のテキストどうしの照合）。
if [[ -d terraform ]]; then
  echo "[acceptance] (tf-output-refs) scripts/check-tf-output-refs.sh"
  bash scripts/check-tf-output-refs.sh
  ran_any=1
else
  echo "[acceptance] (tf-output-refs) skip: terraform/ not found"
fi

# aws CLI の呼び出しが、引数の形として CLI の契約に合っていること（#160）。
#
# **前寄りに置く。** 1 秒強で終わり、npm test より 1 桁安い。しかも外すと
# **本番の配備が引数 1 つで落ちる**——実際に `--publish false` で落ちて、切り替え
# 直後の生成が止まった。AWS CLI の真偽値フラグは値を取らない（`--publish` か
# `--no-publish`）。**実行しなくても分かる誤りは、実行せずに落とす。**
#
# **判定はスクリプト側が持つ**（何を見て、何を見ないかは
# scripts/check-aws-cli-usage.sh の冒頭）。ここが見るのは引数の形だけで、
# **権限・存在・状態は外部層（scripts/acceptance-remote.sh）と本番でしか分からない。**
#
# 既定の対象は配備スクリプトである（他の経路で一度も実行されないため）。
# scripts/ 配下すべてを見るには CHECK_AWS_ALL=1 を付ける。
if [[ -f scripts/deploy-orchestrator.sh ]]; then
  echo "[acceptance] (aws-usage) scripts/check-aws-cli-usage.sh"
  bash scripts/check-aws-cli-usage.sh
  ran_any=1
else
  echo "[acceptance] (aws-usage) skip: scripts/deploy-orchestrator.sh not found"
fi

if [[ -f package.json ]]; then
  command -v npm >/dev/null 2>&1 || { echo "[acceptance] (node) npm not found. install Node.js (npm) to run this acceptance check." >&2; exit 1; }
  # 依存の実体が宣言（package-lock.json）と一致していること（#99）。
  #
  # **npm test より前に置く。** ずれた状態でテストを回すと `Cannot find package` で
  # スイートが全滅し、原因が読み取れない赤になる（2026-08-27 に 15 スイートが全滅した）。
  # 安い検査から落として反復を短くするのは、verify.sh が機密混入検査を受け入れ条件の
  # 手前へ置いているのと同じ考え方である。
  #
  # **verify.sh ではなくこちらへ置く理由。** verify.sh が持つのは規範由来の検査
  # （どのプロジェクトでも同じ機密混入検査）で、言語やパッケージ管理を前提にしない
  # 汎用の入口である。この検査は package.json / npm という**このプロジェクトの実態**に
  # 依存し、「受け入れ条件を検証できる状態か」を見るものなので、プロジェクトが所有する
  # この層に属する。package.json がある場合だけ走る、という既存の分岐にもそのまま乗る。
  #
  # 直さずに落とすだけである（理由は scripts/check-deps-installed.sh の冒頭）。
  # CI は毎回 npm ci を実行するため、この検査で CI が赤くなることはない。
  echo "[acceptance] (node) scripts/check-deps-installed.sh"
  bash scripts/check-deps-installed.sh
  # 生成物（worker-configuration.d.ts）が宣言（wrangler.toml）より古くないこと（#175）。
  #
  # **上の依存の検査とまったく同じ事故で、対象が別の生成物である。** wrangler.toml へ
  # [vars] を足した PR が入ると、npm ci を打っていない worktree の生成物が黙って古くなり、
  # npm test / npm run typecheck が TS2339（Property ... does not exist on type 'Env'）で
  # 落ちる。**自分の変更と無関係な赤で、しかも原因が読み取りにくい。** 第 4 波で 4 者が
  # 同じ赤を踏んだ。直さずに落とすだけである（理由は scripts/check-deps-installed.sh の
  # 冒頭と、あの生成物に固有の事情は check-worker-types-fresh.sh の冒頭）。
  #
  # **本命の置き場所は package.json の typecheck / test 側である。** 落ちる当のコマンドの
  # 手前に置かないと、`npm run typecheck` を直接叩く反復には効かない。ここへも書くのは、
  # 上の依存の検査と同じ並びで読めるようにするためと、npm 側の配線が外れても受け入れ
  # 検証からは消えないようにするため（20 ms なので重ねても値段は変わらない）。
  #
  # **完全な照合ではない。** 名前と値と compatibility_date しか見ない。全行の一致は
  # 下の scripts/check-worker-types.sh が wrangler types を実行して確かめる。
  echo "[acceptance] (node) scripts/check-worker-types-fresh.sh"
  bash scripts/check-worker-types-fresh.sh
  echo "[acceptance] (node) npm test"
  npm test
  echo "[acceptance] (node) npm run typecheck"
  npm run --silent typecheck
  # オーケストレータが Node へ束ねられること（#160）。
  #
  # **テストは workerd の上で走る。** 配備先は AWS Lambda の Node 22 で、そこには
  # workerd の API が無い。`src/` を共有している以上、うっかり workerd 専用の口を
  # 使った瞬間に**テストは緑のまま本番だけが落ちる。** 束ね直しは 20 ms 程度で、
  # 束ねられないこと自体をここで捕まえる。
  #
  # **走らせて確かめてはいない**（それには資格情報が要る）。ここで見るのは
  # 「1 ファイルの ESM になること」までである。
  if [[ -f src/orchestrator/handler.ts ]]; then
    echo "[acceptance] (orchestrator) scripts/bundle-orchestrator.sh"
    bash scripts/bundle-orchestrator.sh >/dev/null
  fi
  ran_any=1
else
  echo "[acceptance] (node) skip: package.json not found"
fi

# Worker のバインディング一覧の機械照合（shared-ai-rules 12 章）。
# worker-configuration.d.ts は wrangler.toml から生成される一覧の複製であり、
# 追随漏れは「書かれていない行」として現れるため文書を読んでも気づけない。
# ネットワークも外部認証も要さないのでローカル層に置く。
if [[ -f wrangler.toml ]]; then
  echo "[acceptance] (worker) scripts/check-worker-types.sh"
  bash scripts/check-worker-types.sh
  ran_any=1
else
  echo "[acceptance] (worker) skip: wrangler.toml not found"
fi

# .dev.vars（Worker から見えるシークレット）の衛生検査。
#
# scripts/check-no-secrets.sh は名前で機密を判定するが、そのパターンは .dev.vars を
# 拾わない（.env や *.key と違い、名前から機密と判定できない）。共通規範が
# 「一次の対策は .gitignore での除外」としている以上、除外が実際に効いていることを
# 機械で確かめる。あわせて、共有する雛形に値が入っていないことも見る
# （check-no-secrets.sh の値検査は .env.example しか対象にしない）。
if [[ -f .dev.vars.example ]]; then
  echo "[acceptance] (dev-vars) .dev.vars が追跡除外されていること"
  if ! git check-ignore -q .dev.vars; then
    echo "[acceptance] .dev.vars が .gitignore で除外されていません。" >&2
    echo "[acceptance] Worker のシークレットが追跡対象へ入る経路が開いています。" >&2
    exit 1
  fi

  echo "[acceptance] (dev-vars) .dev.vars.example に値が入っていないこと"
  if grep -qE '^[[:space:]]*[A-Za-z_][A-Za-z0-9_]*[[:space:]]*=[[:space:]]*[^[:space:]]' .dev.vars.example; then
    echo "[acceptance] .dev.vars.example に値が入っています（雛形はキー名だけを共有する）。" >&2
    grep -nE '^[[:space:]]*[A-Za-z_][A-Za-z0-9_]*[[:space:]]*=[[:space:]]*[^[:space:]]' .dev.vars.example \
      | cut -d= -f1 >&2
    exit 1
  fi
  ran_any=1
else
  echo "[acceptance] (dev-vars) skip: .dev.vars.example not found"
fi
if [[ -f go.mod ]]; then
  command -v go >/dev/null 2>&1 || { echo "[acceptance] (go) go not found. install the Go toolchain to run this acceptance check." >&2; exit 1; }
  echo "[acceptance] (go) go test ./..."
  go test ./...
  ran_any=1
else
  echo "[acceptance] (go) skip: go.mod not found"
fi

# IaC の書式検査。ネットワークも外部認証も要さないためローカル層に置く。
#
# terraform validate はプロバイダの取得（init）を前提とし、初回はネットワークを要する
# ため、この層には置かない。宣言と外部状態の一致とあわせて外部層
# （scripts/acceptance-remote.sh）で検証する。
if [[ -d terraform ]]; then
  command -v terraform >/dev/null 2>&1 || { echo "[acceptance] (terraform) terraform not found. install Terraform to run this acceptance check." >&2; exit 1; }
  echo "[acceptance] (terraform) terraform fmt -check -recursive terraform"
  terraform fmt -check -recursive terraform
  ran_any=1
else
  echo "[acceptance] (terraform) skip: terraform/ not found"
fi

# 仕様書の版表記の一致。
#
# docs/product-spec.md は版を 2 か所に書いている（H1 タイトルの "(vX.Y)" と
# 本文の "- 版: vX.Y"）。実際に片方だけ更新して不整合を出したことがあるため、
# 呼びかけではなく機械照合で塞ぐ（shared-ai-rules.md 12 章「一覧の複製は
# 機械照合で担保する」）。
#
# 「更新したか」ではなく「一致しているか」を見るので、空更新では通過しない。
# ネットワークも外部認証も要さないためローカル層に置く。
SPEC="docs/product-spec.md"
if [[ -f "$SPEC" ]]; then
  echo "[acceptance] (docs) spec version consistency"
  spec_title_ver="$(sed -n '1s/.*(\(v[0-9][0-9.]*\)).*/\1/p' "$SPEC")"
  spec_body_ver="$(sed -n 's/^- 版: \(v[0-9][0-9.]*\).*/\1/p' "$SPEC" | head -1)"
  if [[ -z "$spec_title_ver" || -z "$spec_body_ver" ]]; then
    echo "[acceptance] (docs) $SPEC から版表記を取得できません（H1 の (vX.Y) と '- 版: vX.Y' の両方が必要）。" >&2
    exit 1
  fi
  if [[ "$spec_title_ver" != "$spec_body_ver" ]]; then
    echo "[acceptance] (docs) $SPEC の版表記が一致しません: タイトル=${spec_title_ver} 本文=${spec_body_ver}" >&2
    exit 1
  fi
  ran_any=1
else
  echo "[acceptance] (docs) skip: $SPEC not found"
fi

if [[ "$ran_any" -eq 0 ]]; then
  echo "[acceptance] 受け入れ条件が未定義です。検証対象のマニフェストが 1 つも見つかりません。" >&2
  echo "[acceptance] このプロジェクトの受け入れ条件（テスト等）を scripts/acceptance.sh に定義してください。" >&2
  exit 1
fi

# API のパスが /api/* へ寄っていること（確定22 / #71）。
#
# `/waitlist` は M1 の時点の綴りで、9.3 が未確定だったため /api/ を避けていた。
# 確定22 で正が決まった以上、古い綴りが残っていれば「経路表には無いのにフォームや
# テストだけが古いパスを指す」状態になりうる。文字列として残っていないことを見る。
#
# 対象は src/ と test/ に限り、**コメント行は除く**。docs/ とコメントは移行の経緯を
# 書く場所であり、そこで旧綴りに触れられないと「なぜ変えたのか」を残せなくなる。
# 見たいのは、経路の登録・フォームの action・fetch の宛先といった**実際に効く位置**に
# 旧綴りが残っていないことである。
#
# 前後に `.` を許さないのは、`./waitlist.js` のような**モジュール指定子**と区別する
# ためである（ファイル名は移行の対象ではない）。
#
# 限界: コメントを除く判定は行頭が `*` か `//` かで見るだけなので、行末コメントに
# 書いた旧綴りは捕まえる。より厳密にやるなら構文解析が要るが、この検査の目的
# （移行の取りこぼしを見つける）には行単位で足りる。
echo "[acceptance] (paths) API のパスに旧綴りの /waitlist が残っていないこと"
stale_paths="$(grep -rnE "(^|[^a-zA-Z0-9/_.-])/waitlist([^a-zA-Z0-9/_.-]|$)" src test 2>/dev/null \
  | grep -vE "^[^:]+:[0-9]+:[[:space:]]*(\*|//)" || true)"
if [[ -n "$stale_paths" ]]; then
  echo "[acceptance] 旧綴りの /waitlist が残っています（確定22 で /api/waitlist が正）:" >&2
  printf '%s\n' "$stale_paths" >&2
  exit 1
fi
# ここで ran_any を立てない。この検査は言語のマニフェストに関係なく必ず走るため、
# 立てると「テストを 1 つも実行していないのに合格」を作れてしまう。上の
# 「受け入れ条件が未定義」の判定（ran_any=0 で失敗）は、**実際に検証が動いたか**を
# 見るためのものなので、常に真になる lint を数に入れない。

echo "[acceptance] OK"