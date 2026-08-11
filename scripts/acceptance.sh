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

if [[ -f package.json ]]; then
  command -v npm >/dev/null 2>&1 || { echo "[acceptance] (node) npm not found. install Node.js (npm) to run this acceptance check." >&2; exit 1; }
  echo "[acceptance] (node) npm test"
  npm test
  ran_any=1
else
  echo "[acceptance] (node) skip: package.json not found"
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

if [[ "$ran_any" -eq 0 ]]; then
  echo "[acceptance] 受け入れ条件が未定義です。検証対象のマニフェストが 1 つも見つかりません。" >&2
  echo "[acceptance] このプロジェクトの受け入れ条件（テスト等）を scripts/acceptance.sh に定義してください。" >&2
  exit 1
fi

echo "[acceptance] OK"