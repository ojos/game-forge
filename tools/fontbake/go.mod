// fontbake は**開発時に 1 回だけ走らせる工程**であり、隔離ビルドのイメージには
// 入らない（tools/fontbake/main.go の冒頭）。そのため、この go.mod は
// docker/isolated-build/template/go.mod と**別の判断軸**にある。
//
//   - `go` ディレクティブはイメージの ARG GO_VERSION に合わせない。合わせると、
//     手元の Go がそれより古いときに GOTOOLCHAIN がツールチェインを取りに行く。
//     ここは開発機で動けばよいので、下限だけを宣言する。
//   - golang.org/x/image は**テンプレートと同じ版に合わせる**。焼く側と使う側で
//     ラスタライザが違うと、焼いた結果が説明できなくなる。
//   - golang.org/x/text は**この工程にしか要らない**。JIS X 0208 の区点から
//     Unicode への対応表を書き写さずに引くために使う（main.go の「収録範囲」）。
module gameforge.local/tools/fontbake

go 1.26

require (
	golang.org/x/image v0.45.0
	golang.org/x/text v0.41.0
)

require golang.org/x/sys v0.47.0 // indirect
