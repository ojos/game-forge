// 生成コードをビルドするテンプレート。**vendor はリポジトリへ入れず、イメージの
// ビルド時に焼き込む**（Dockerfile の注記）。版はこの go.mod と go.sum が正で、
// Dockerfile は `go mod tidy` を走らせない。
//
// go ディレクティブは Dockerfile のベースイメージと同じ版に固定する（確定12 / 3.5）。
// **値の正本は Dockerfile の `ARG GO_VERSION` で、一致は Dockerfile が機械照合する**
// （#101）。手順は 3.5 にある。
//
// **Ebitengine と golang.org/x/image の版は、Go 本体の更新とは別の判断軸である**
// （#101 の scope.out）。vendor の焼き直しを伴うため、同じ契機で動かさない。
module gameforge.local/sandbox

go 1.27.0

require (
	github.com/hajimehoshi/ebiten/v2 v2.9.9
	golang.org/x/image v0.45.0
)

require (
	github.com/ebitengine/gomobile v0.0.0-20250923094054-ea854a63cce1 // indirect
	github.com/ebitengine/hideconsole v1.0.0 // indirect
	github.com/ebitengine/purego v0.9.0 // indirect
	github.com/go-text/typesetting v0.3.0 // indirect
	github.com/jezek/xgb v1.1.1 // indirect
	github.com/rivo/uniseg v0.4.7 // indirect
	golang.org/x/sync v0.22.0 // indirect
	golang.org/x/sys v0.47.0 // indirect
	golang.org/x/text v0.41.0 // indirect
)
