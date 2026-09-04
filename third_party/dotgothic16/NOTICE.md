# DotGothic16

生成されたゲームが日本語を表示するためのフォント（#285）。

**Copyright 2020 The DotGothic16 Project Authors**
（https://github.com/fontworks-fonts/DotGothic16）

このフォントは **SIL Open Font License, Version 1.1** で提供されています。
全文は同じディレクトリの [`OFL.txt`](./OFL.txt) にあります。

## このディレクトリが在る理由

OFL は再配布と埋め込みを明示的に許可していますが、**「each copy contains the above
copyright notice and this license」が条件**です。リポジトリと配布物（隔離ビルドの
イメージ、そこから出るゲームの wasm）には、フォントから焼いたビットマップが入るため、
著作権表示とライセンス全文を同梱します。

**Reserved Font Name の指定はありません**（`OFL.txt` の RFN 欄が空）。そのため、
焼いた派生物の名前に制約はかかりません。

## リポジトリに入っているもの / 入っていないもの

| | |
|---|---|
| 入っている | このディレクトリ（著作権表示とライセンス全文）と、**16×16 へ焼いたビットマップ**（`docker/isolated-build/template/jpfont/glyphs_gen.go`） |
| 入っていない | **TTF そのもの**（2,069,236 バイト）。取得元 URL と SHA-256 だけを `tools/fontbake/main.go` が持ち、焼くときに取得して検証します |

焼いた元データ:

```
https://raw.githubusercontent.com/fontworks-fonts/DotGothic16/Version1.101/fonts/ttf/DotGothic16-Regular.ttf
SHA-256 155da8f318553c11d9dffc2affbc7c2114c6a46f9740bcf639ed5568af92be71
```

`OFL.txt` は同じタグ（Version1.101）のリポジトリ直下から取得したものです
（SHA-256 `b6630c61ea078cacd7fabe37d14ffe557a0b45b06683374a9aa9e24262993e33`）。

## 焼き直しかた

```bash
cd tools/fontbake && go run .
```

TTF を取得し、SHA-256 を検証してから焼き、
`docker/isolated-build/template/jpfont/glyphs_gen.go` を書き出します。
**開発時に 1 回だけ走らせる工程**で、イメージのビルドには含まれません
（判断の理由は `tools/fontbake/main.go` の冒頭）。
