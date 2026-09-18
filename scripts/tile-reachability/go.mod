// タイル地図の到達判定（#675）。運営の手元で回す道具で、隔離ビルドのイメージにも
// オーケストレータの束にも入らない（入口は scripts/tile-reachability.sh）。
//
//   - 依存を持たない（標準ライブラリだけ）。go.sum も無い。手元でも CI でも
//     モジュールを取りに行かない。
//   - `go` ディレクティブは下限だけを宣言する。隔離ビルドの版の正本に合わせると、
//     手元の Go がそれより古いときに GOTOOLCHAIN がツールチェインを取りに行く
//     （tools/fontbake/go.mod と同じ判断）。
module gameforge.local/scripts/tile-reachability

go 1.24
