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
//
// **間接依存に `github.com/ebitengine/oto/v3` が 1 つ増えている（#286）。版は 1 つも
// 動いていない。** 増えた理由は、許可パッケージへ `github.com/hajimehoshi/ebiten/v2/audio`
// を足したことである。**`audio/context.go` が `oto/v3` を無条件に import する**ので、
// ebiten 本体だけを require していた頃には現れなかった依存が、パッケージを 1 つ足した
// だけでモジュールグラフへ入る。**`go mod vendor` は実際に import されているものしか
// 集めない**ため、`vendor-deps.go` へ `audio` を書いた時点でこの require が要る
// （書かないと `--network=none` のビルドが依存を解決できない）。
//
// **これは版の更新ではないので、上の「別の判断軸」には抵触しない。** 逆に、
// ここを消しても Ebitengine の版は変わらないが、**音を使う生成物がビルドできなくなる。**
module gameforge.local/sandbox

go 1.27.0

require (
	github.com/hajimehoshi/ebiten/v2 v2.9.9
	golang.org/x/image v0.45.0
)

require (
	github.com/ebitengine/gomobile v0.0.0-20250923094054-ea854a63cce1 // indirect
	github.com/ebitengine/hideconsole v1.0.0 // indirect
	github.com/ebitengine/oto/v3 v3.4.0 // indirect
	github.com/ebitengine/purego v0.9.0 // indirect
	github.com/go-text/typesetting v0.3.0 // indirect
	github.com/jezek/xgb v1.1.1 // indirect
	github.com/rivo/uniseg v0.4.7 // indirect
	golang.org/x/sync v0.22.0 // indirect
	golang.org/x/sys v0.47.0 // indirect
	golang.org/x/text v0.41.0 // indirect
)
