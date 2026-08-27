#!/usr/bin/env bash
# check-deps-installed.sh — node_modules が package-lock.json と一致していることの機械照合。
#
# 位置づけ:
#   package-lock.json は「入っているべき依存の一覧」の宣言で、node_modules はその
#   実体である。`npm ci` を回さずに反復すると、この 2 つが黙ってずれる。ずれた状態で
#   受け入れ条件を回すと、テストが `Cannot find package '...'` で全滅する。2026-08-27 に
#   実際に踏んだ（#98 が aws4fetch を足した直後、15 スイートが全滅した）。
#
#   **これは自分の変更と無関係な赤で、しかも原因が読み取りにくい。** review-workflow.md
#   の言う「原因が読み取れない赤」であり、偽の赤と同じようにゲートへの信頼を削る。
#   CI は毎回 `npm ci` するので緑のままで、手元でだけ出る。worktree を使う並列作業では
#   レーンごとに `npm ci` が要るため、踏む頻度が上がる。
#
#   検査するのは「`npm ci` を実行したか」ではなく「一致しているか」である。
#
# **直さない。落とすだけである。**
#   ゲートの役割は判定であって環境の修復ではない。黙って `npm ci` を走らせると、
#   何が起きたのかが見えないまま結果だけが変わる。加えて `npm ci` は node_modules を
#   丸ごと作り直すため、反復の接地信号が目に見えて遅くなる。対処は人（またはエージェント）
#   が明示的に実行する。
#
# 何と何を比べるか:
#   package-lock.json（宣言）と node_modules/.package-lock.json（npm が導入時に書く
#   「実際に入れた木」の記録）を比べ、記録にある分だけディレクトリの存在も見る。
#   node_modules 全体は走査しないので安い（実測 30ms 未満）。ループの反復ごとに通ることを
#   前提にした値段である。
#
#   3 方向を見る:
#     - 宣言にあって記録に無い   … `npm ci` していない（#98 で踏んだ経路）
#     - 版が食い違う             … 別の版のまま残っている
#     - 記録にあって宣言に無い   … 依存を削ったあと `npm ci` していない
#   加えて、記録にあるものの実体（ディレクトリ）が置かれていることも確かめる。
#
#   optional な依存は宣言にあっても入らないのが正常なので、宣言側から除く（他の
#   プラットフォーム向けの esbuild / workerd などがこれに当たる）。
#
# 終了コード:
#   0 = DEPS_PASS
#   1 = DEPS_FAIL（ずれている、または検査が成立しなかった）
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$(dirname "$HERE")"

fail() {
  printf '[deps] %s\n' "$1" >&2
  echo "DEPS_FAIL"
  exit 1
}

# 検査が成立しない状態を合格にしない（verify.sh の既定方針）。
# どれも対処は同じ（`npm ci`）なので、理由と併せて示す。
[[ -f package.json ]] || fail "package.json がありません。照合の対象がありません。"
[[ -f package-lock.json ]] || fail "package-lock.json がありません。宣言が無いため照合できません（'npm install' で生成し、追跡に含めること）。"
[[ -d node_modules ]] || fail "node_modules がありません。'npm ci' を実行してください。"

HIDDEN="node_modules/.package-lock.json"
[[ -f "$HIDDEN" ]] || fail "$HIDDEN がありません（npm が導入時に書く記録）。node_modules が npm 以外の手段で作られたか壊れています。'npm ci' を実行してください。"

command -v node >/dev/null 2>&1 || fail "node が見つかりません。Node.js を導入してください。"

# 比較そのものは node で行う。JSON を正しく読む道具が要り、node はこの検査の対象
# （Node プロジェクト）に必ず存在するため、新しい依存を増やさずに済む。
# 差分は先頭 10 件だけ出す。全件出しても取るべき行動（`npm ci`）は変わらず、
# 大量の行で「対処」が画面から流れると読めない赤になる。
if ! diff_report="$(node - <<'JS'
const fs = require('fs');
const read = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));

const declared = read('package-lock.json').packages || {};
const installed = read('node_modules/.package-lock.json').packages || {};
const problems = [];

for (const [path, entry] of Object.entries(declared)) {
  // "" はルート（package.json 自身）で、導入記録側には現れない。
  if (path === '') continue;
  // optional は「入らないのが正常」な経路がある（他プラットフォーム向けの依存）。
  if (entry.optional) continue;
  // link はワークスペースへの参照で、実体の版を持たない。
  if (entry.link) continue;
  const got = installed[path];
  if (!got) {
    problems.push(`未導入: ${path}@${entry.version ?? '(版不明)'}`);
    continue;
  }
  if (entry.version && got.version !== entry.version) {
    problems.push(`版ちがい: ${path} 宣言=${entry.version} 導入=${got.version}`);
  }
}

for (const [path, entry] of Object.entries(installed)) {
  // ルートを表す空文字キーは、この npm（実測: 10.x）では node_modules/.package-lock.json
  // へ書かれない（package-lock.json 側にはある）。**書かれないことを前提にしない。**
  // 将来の版が書くようになると fs.existsSync('') が false を返すため、正常な状態が
  // 毎回「実体が無い」になる。1 行のガードで版への依存を外しておく。
  if (path === '') continue;
  if (!(path in declared)) {
    problems.push(`宣言に無い: ${path}@${entry.version ?? '(版不明)'}`);
    continue;
  }
  // 記録にあるものが実体として置かれていることも見る。記録だけを信じると、
  // ディレクトリを消した（退避した）状態を「一致している」と報告してしまう。
  // stat を数十回するだけなので値段は変わらない。
  if (!fs.existsSync(path)) {
    problems.push(`実体が無い: ${path}@${entry.version ?? '(版不明)'}`);
  }
}

if (problems.length === 0) process.exit(0);
console.log(String(problems.length));
for (const line of problems.slice(0, 10)) console.log(line);
if (problems.length > 10) console.log(`... 他 ${problems.length - 10} 件`);
process.exit(1);
JS
)"; then
  # node 自身が落ちた場合（JSON が壊れている等）も、ここへ来る。出力をそのまま見せる。
  if [[ -z "$diff_report" ]]; then
    fail "package-lock.json / $HIDDEN を読めませんでした。'npm ci' を実行してください。"
  fi
  count="$(printf '%s\n' "$diff_report" | head -1)"
  printf '[deps] node_modules が package-lock.json とずれています（差分 %s 件）:\n' "$count" >&2
  printf '%s\n' "$diff_report" | tail -n +2 | sed 's/^/[deps]     /' >&2
  printf '[deps] 対処: npm ci\n' >&2
  printf '[deps] このゲートは自動で直しません（判定と修復を混ぜると、何が起きたのかが見えなくなるため）。\n' >&2
  echo "DEPS_FAIL"
  exit 1
fi

echo "DEPS_PASS"
