#!/usr/bin/env bash
# check-deps-installed.sh — node_modules が package-lock.json と一致していることの機械照合
#
# 位置づけ:
#   判定はこのスクリプトが持ち、scripts/acceptance.sh は node の節から呼ぶだけ。
#   scripts/check-no-secrets.sh / scripts/check-control-chars.sh と同じ形にそろえる。
#
# なぜ機構で押さえるか:
#   package-lock.json は「入っているべき依存の一覧」の宣言で、node_modules はその実体
#   である。`npm ci` を回さずに反復すると、この 2 つが黙ってずれる。ずれた状態で
#   受け入れ条件を回すと、テストが `Cannot find package '...'` で全滅する。
#
#   **これは自分の変更と無関係な赤で、しかも原因が読み取りにくい。** 偽の赤と同じ
#   ようにゲートへの信頼を削る。CI は毎回 `npm ci` するので緑のままで、**手元でだけ
#   出る。** worktree を使う並列作業ではレーンごとに `npm ci` が要るため、踏む頻度が
#   上がる。
#
#   検査するのは「`npm ci` を実行したか」ではなく「一致しているか」である。
#
# **直さない。落とすだけである。**
#   ゲートの役割は判定であって環境の修復ではない。黙って `npm ci` を走らせると、
#   何が起きたのかが見えないまま結果だけが変わる。加えて `npm ci` は node_modules を
#   丸ごと作り直すため、反復の接地信号が目に見えて遅くなる。対処は人（または
#   エージェント）が明示的に実行する。
#
# マニフェストが無ければスキップする:
#   **通過と同じ信号を出さない。** 「検査していない」と「一致を確認した」は別のこと
#   で、同じ信号にすると読み分けられなくなる。scripts/acceptance.sh も、マニフェストが
#   無い言語はスキップして失敗させない方針で作られている。
#
#   ただし **package.json があるのに周辺が欠けている場合は失敗させる。** そこは
#   「検査が成立しない」であって「対象が無い」ではない。
#
# 何と何を比べるか:
#   package-lock.json（宣言）と node_modules/.package-lock.json（npm が導入時に書く
#   「実際に入れた木」の記録）を比べ、記録にある分だけディレクトリの存在も見る。
#   node_modules 全体は走査しない。
#
#   実測（宣言 300 件・実体 300 件、この開発環境）: 13〜20ms。**ほぼ node の起動費用
#   である**（同じ環境で `node -e ''` が 21ms）。反復のたびに通ることを前提にした値段
#   として測った。**取り込み元の数値は書き写さない。** 環境が違えば変わる。
#
#   4 方向を見る:
#     - 宣言にあって記録に無い   … `npm ci` していない
#     - 版が食い違う             … 別の版のまま残っている
#     - 記録にあって宣言に無い   … 依存を削ったあと `npm ci` していない
#     - 記録にあるが実体が無い   … ディレクトリを消した（退避した）状態、または
#                                    ディレクトリが通常ファイルに置き換わった状態
#
#   optional な依存は宣言にあっても入らないのが正常なので、宣言側から除く（他の
#   プラットフォーム向けの esbuild / workerd などがこれに当たる）。link は
#   workspace への参照で実体の版を持たないため、**宣言側と記録側の両方から**除く。
#
#   **どちらの lockfile も packages を持っていなければ失敗させる。** 空として扱うと、
#   両方が空になって「差分ゼロ＝一致」になり、比較が成立していないのに緑を返す。
#   lockfileVersion 1 は packages を持たないので、この検査は 2 以降を前提にする。
#
# 対象は npm だけである:
#   pnpm / yarn / bun は記録の形式が違う。見ない。
#
# 終了コード:
#   0 = DEPS_PASS（一致）/ DEPS_SKIP（package.json が無い）
#   1 = DEPS_FAIL（ずれている、または検査が成立しなかった）
set -euo pipefail

# 検査はプロジェクトルート基準で行う。scripts/ の 1 階層上がルート。
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$(dirname "$HERE")"

fail() {
  printf '[deps] %s\n' "$1" >&2
  echo "DEPS_FAIL"
  exit 1
}

# ── 対象の有無 ───────────────────────────────────────────────────────────────
#
# package.json が無いのは「この構成では対象が無い」であって、異常ではない。
if [ ! -f package.json ]; then
  echo "[deps] package.json がありません。照合の対象が無いため飛ばします。"
  echo "DEPS_SKIP"
  exit 0
fi

# ── ここから先は「対象がある」。欠けていれば検査が成立しない ────────────────
[ -f package-lock.json ] \
  || fail "package-lock.json がありません。宣言が無いため照合できません（'npm install' で生成し、追跡に含めること）。"
[ -d node_modules ] \
  || fail "node_modules がありません。'npm ci' を実行してください。"

HIDDEN="node_modules/.package-lock.json"
[ -f "$HIDDEN" ] \
  || fail "$HIDDEN がありません（npm が導入時に書く記録）。node_modules が npm 以外の手段で作られたか壊れています。'npm ci' を実行してください。"

command -v node >/dev/null 2>&1 \
  || fail "node が見つかりません。Node.js を導入してください。"

# ── 照合 ─────────────────────────────────────────────────────────────────────
#
# 比較そのものは node で行う。JSON を正しく読む道具が要り、node はこの検査の対象
# （Node プロジェクト）に必ず存在するため、新しい依存を増やさずに済む。
#
# 差分は先頭 10 件だけ出す。全件出しても取るべき行動（`npm ci`）は変わらず、大量の
# 行で「対処」が画面から流れると読めない赤になる。
if ! diff_report="$(node - <<'JS'
const fs = require('fs');
const read = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));

// `|| {}` で受けない。**packages を持たない文書を空の宣言として扱うと、両方が空に
// なって「差分ゼロ＝一致」になる。** 比較が一度も成立していないのに緑を返す経路で、
// 検査が成立しないことを合格にしないという方針に反する（実測で踏んだ）。
//
// lockfileVersion 1 は packages を持たない（dependencies だけ）。この検査は 2 以降を
// 前提にする。1 のまま使うプロジェクトは `npm install` で作り直すこと。
const packagesOf = (doc, path) => {
  const pkgs = doc.packages;
  if (pkgs === null || typeof pkgs !== 'object' || Array.isArray(pkgs)) {
    throw new Error(`${path} に packages がありません（lockfileVersion 2 以降が必要です）`);
  }
  return pkgs;
};

const declared = packagesOf(read('package-lock.json'), 'package-lock.json');
const installed = packagesOf(read('node_modules/.package-lock.json'), 'node_modules/.package-lock.json');
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
  // ルートを表す空文字キーは、実測した npm では記録側へ書かれない。**書かれない
  // ことを前提にしない。** 将来の版が書くようになると fs.existsSync('') が false を
  // 返すため、正常な状態が毎回「実体が無い」になる。1 行のガードで版への依存を外す。
  if (path === '') continue;
  // **記録側でも link を外す。** 宣言側だけで外すと、workspace への参照が実体の
  // 確認まで到達して「実体が無い」と報告される。除外の契約は両側で同じにする。
  if (entry.link) continue;
  if (!(path in declared)) {
    problems.push(`宣言に無い: ${path}@${entry.version ?? '(版不明)'}`);
    continue;
  }
  // 記録にあるものが実体として置かれていることも見る。記録だけを信じると、
  // ディレクトリを消した（退避した）状態を「一致している」と報告してしまう。
  //
  // **existsSync では足りない。通常ファイルでも真になる。** ディレクトリが 1 バイトの
  // ファイルに置き換わった壊れ方を「一致」として通していた（実測で踏んだ）。
  // statSync はシンボリックリンクを辿るので、ディレクトリへのリンクは通る。
  let isDir = false;
  try {
    isDir = fs.statSync(path).isDirectory();
  } catch {
    isDir = false;
  }
  if (!isDir) {
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
  # node 自身が落ちた場合（JSON が壊れている等）も、ここへ来る。
  #
  # **node の標準エラーは捕捉していない**（`2>&1` を付けていない）ので diff_report は
  # 空になり、下の分岐が読めるメッセージを出す。標準エラーを混ぜると、スタックの
  # 1 行目を件数として表示してしまう。**足さない理由をここへ残す。**
  if [ -z "$diff_report" ]; then
    printf '[deps] ---- 上は node の出力 ----\n' >&2
    fail "package-lock.json / $HIDDEN を読めませんでした（JSON が壊れているか、packages を持っていません）。上の node の出力に理由があります。lockfileVersion 1 のままなら 'npm install' で作り直し、それ以外は 'npm ci' を実行してください。"
  fi

  # 先頭行が件数（数字）でなければ、想定外の出力である。**件数として表示しない。**
  first_line="$(printf '%s\n' "$diff_report" | sed -n 1p)"
  case "$first_line" in
    '' | *[!0-9]* )
      printf '[deps] 依存の照合が想定外の出力を返しました。そのまま出します:\n' >&2
      printf '%s\n' "$diff_report" | sed 's/^/[deps]     /' >&2
      echo "DEPS_FAIL"
      exit 1
      ;;
  esac

  printf '[deps] node_modules が package-lock.json とずれています（差分 %s 件）:\n' "$first_line" >&2
  printf '%s\n' "$diff_report" | sed -n '2,$p' | sed 's/^/[deps]     /' >&2
  printf "[deps] 対処: npm ci\n" >&2
  printf '[deps] このゲートは自動で直しません（判定と修復を混ぜると、何が起きたのかが見えなくなるため）。\n' >&2
  echo "DEPS_FAIL"
  exit 1
fi

echo "[deps] package-lock.json と node_modules の記録が一致しています。"
echo "DEPS_PASS"
exit 0
