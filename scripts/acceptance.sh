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

echo "[acceptance] OK"