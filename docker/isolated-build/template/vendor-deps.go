// vendor 焼き込みのためだけに存在するファイル（M2-4 / #18）。
//
// `go mod vendor` は「実際に import されているもの」だけを vendor へ入れる。
// 生成コードは実行時に決まるため、テンプレート側で許可パッケージを一度 import して
// おかないと、--network=none のビルドで依存を解決できない。
//
// **イメージのビルド中に vendor を作ったら削除する。** ビルドタグで隠す手もあるが、
// `go mod vendor` がタグ付きファイルを拾うかは実装依存なので、確実な「消す」を採る。
// 残すと生成コードと同じパッケージに同居し、不要なパッケージが連結されうる
// （3.4 のバイナリサイズ削減）。
//
// ここの一覧は許可パッケージ（`src/go-import-allowlist.ts`）と一致させること。
// ずれると「プロンプトと AST 検査は許すが、vendor に無いのでビルドが落ちる」状態になる。
//
// **ここへ 1 行足すと go.mod の間接依存が増えることがある。** `ebiten/v2/audio` が
// `github.com/ebitengine/oto/v3` を引き込んだのがその例で、理由は go.mod の注記にある
// （#286）。**`go mod vendor` はモジュールグラフに無いものを集められない**ので、
// require が無いまま焼くと `--network=none` のビルドが落ちる。
package main

import (
	_ "github.com/hajimehoshi/ebiten/v2"
	_ "github.com/hajimehoshi/ebiten/v2/audio"
	_ "github.com/hajimehoshi/ebiten/v2/inpututil"
	_ "github.com/hajimehoshi/ebiten/v2/text/v2"
	_ "github.com/hajimehoshi/ebiten/v2/vector"
	_ "golang.org/x/image/font/basicfont"
)
