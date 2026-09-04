#!/usr/bin/env bash
# check-orchestrator-bundle.sh — 画面の実装が Lambda の束に入っていないこと（#290）
#
# ══════════════════════════════════════════════════════════════════════════════
# なぜこの検査が要るのか
# ══════════════════════════════════════════════════════════════════════════════
#
# **#266 と #283 は、画面しか触っていないのに本番配備を止めた。** #241 の関門
# （配備済みオーケストレータが古ければ Worker を配らない）が起動したためである。
#
# 関門は設計どおりに動いていた。問題は束の中身で、`src/generate.ts` と
# `src/mail/generation-notice.ts` が **パスを組み立てるだけの `workPagePath`** の
# ために `src/work-page.ts` を import し、そこから `siteHead` / `siteFooter` を
# 通じて画面 4 本が束へ引き込まれていた（実測: 束 47 本中 4 本）。
#
# **画面を触るたびに Lambda の `CodeSha256` が変わる**ので、M8-2 / M8-3 でも
# 同じことが起きる。連鎖を切ったうえで、**戻らないことを機構で押さえる。**
#
# ══════════════════════════════════════════════════════════════════════════════
# 何を「画面」とみなすか——一覧を書き写さない
# ══════════════════════════════════════════════════════════════════════════════
#
# **ファイル名を並べない**（`.ai-playbook/shared-ai-rules.md` 12 章）。並べると、
# 画面を 1 枚足した日に検査だけが古い一覧を見続ける。
#
# 導出はこうする。
#
#   1. **文書の外枠を配っているモジュール**を、宣言から見つける
#      （`export function siteHead` / `export function siteFooter`）
#   2. esbuild の **metafile** から、束に入った入力の一覧を取る
#   3. 1 が 2 に 1 本でも含まれていたら赤
#
# **`siteHead` を別のモジュールへ移しても追随する**（宣言を探すため）。
# **説明文に `siteHead` と書いてあるだけのモジュールは当たらない**（宣言だけを見る。
# 実際に `src/paths.ts` がそれで偽陽性になった）。
#
# 1 が束に無ければ、それを呼ぶ画面も束に無い（呼べば import されるため）。
#
# ══════════════════════════════════════════════════════════════════════════════
# なぜローカル層へ入れるか
# ══════════════════════════════════════════════════════════════════════════════
#
# **esbuild だけで完結する。** ネットワークも AWS もブラウザも要らないので、
# `scripts/verify.sh` の接地信号に含めてよい（`scripts/check-page-width.sh` を
# 外した理由とは条件が違う）。
#
# 使い方:
#   bash scripts/check-orchestrator-bundle.sh
#
# 終了コード: 0 = ORCHESTRATOR_BUNDLE_CLEAN / 1 = 画面が入っている・検査不能
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$(dirname "$HERE")"

fail() {
  printf '[orchestrator-bundle] %s\n' "$*" >&2
  exit 1
}

command -v npx >/dev/null 2>&1 || fail "npx が見つかりません。"
[[ -f src/orchestrator/handler.ts ]] || fail "src/orchestrator/handler.ts がありません。"

WORK="$(mktemp -d "${TMPDIR:-/tmp}/gf-orch-bundle.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

# **束ね方は `scripts/bundle-orchestrator.sh` と揃える。** 別の設定で束ねると、
# ここで見ているものと本番へ載るものが別になる。metafile を採るためだけに
# `--outfile=/dev/null` を足している。
npx esbuild src/orchestrator/handler.ts \
  --bundle \
  --platform=node \
  --format=esm \
  --metafile="$WORK/meta.json" \
  --outfile=/dev/null >"$WORK/esbuild.log" 2>&1 ||
  { sed 's/^/    /' "$WORK/esbuild.log" >&2; fail "束ねられませんでした。"; }

node -e '
const fs = require("node:fs");
const path = require("node:path");

const meta = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));

// 文書の外枠を配っているモジュールを、**宣言**から探す。説明文の中の言及には
// 当たらない（`export function` の形だけを見る）。
const SHELL_EXPORTS = ["siteHead", "siteFooter"];
// **名前ごとに、どこで宣言されているかを持つ。** 1 つでも見つからないまま進むと、
// 綴りを変えた日に**種が静かに減って検査が緩む**（変異で確認した）。
const shellByName = new Map(SHELL_EXPORTS.map((name) => [name, []]));
const shell = [];
const walk = (dir) => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full);
      continue;
    }
    if (!entry.name.endsWith(".ts")) {
      continue;
    }
    const source = fs.readFileSync(full, "utf8");
    for (const name of SHELL_EXPORTS) {
      if (new RegExp("^export function " + name + "\\(", "mu").test(source)) {
        shellByName.get(name).push(full);
        if (!shell.includes(full)) {
          shell.push(full);
        }
      }
    }
  }
};
walk("src");

const missing = SHELL_EXPORTS.filter((name) => shellByName.get(name).length === 0);
if (missing.length > 0) {
  console.error(`[orchestrator-bundle] 外枠の宣言が見つかりません: ${missing.join(", ")}`);
  console.error("[orchestrator-bundle] 綴りを変えた・消したなら、この検査の SHELL_EXPORTS を追随させてください。");
  console.error("[orchestrator-bundle] **見つからないまま進むと、検査が静かに緩みます**（このファイルの冒頭）。");
  process.exit(1);
}

const inputs = new Set(Object.keys(meta.inputs));
const found = shell.filter((file) => inputs.has(file));

console.log(`[orchestrator-bundle] 外枠のモジュール: ${shell.join(" / ")}`);
console.log(`[orchestrator-bundle] 束に入った入力: ${inputs.size} 本`);

if (found.length > 0) {
  console.error("[orchestrator-bundle] 画面の実装が Lambda の束に入っています:");
  for (const file of found) {
    // どこから引かれているかを出す。**赤の原因が読めないと直せない。**
    const importers = Object.entries(meta.inputs)
      .filter(([, value]) => (value.imports ?? []).some((i) => i.path === file))
      .map(([key]) => key);
    console.error(`    ${file} ← ${importers.join(", ")}`);
  }
  console.error("[orchestrator-bundle] 画面を触るたびに CodeSha256 が変わり、本番配備が止まります（#290 / #241）。");
  console.error("[orchestrator-bundle] 対処: 借りている値を src/paths.ts のような葉へ移し、連鎖を切ってください。");
  process.exit(1);
}
' "$WORK/meta.json" || exit 1

echo "ORCHESTRATOR_BUNDLE_CLEAN"
