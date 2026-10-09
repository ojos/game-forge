# `.devcontainer/` の注記

`devcontainer.json` と `compose.yaml` は devcontainer-bootstrap（DCB）が生成するファイルです。
雛形との差分のうち残しているものの一覧は `.github/project-ai-rules.md`「雛形からの逸脱」が正本で、
このファイルは各値の理由と経緯を持ちます。追従の手順は `docs/local-dev.md`「DCB と規範への追従」です。

## `devcontainer.json` は純粋な JSON に保つ（#939）

**コメントを書かないでください。** DCB の `doctor.sh` は `jq` で読むので、JSONC のコメントが 1 行でもあると
`devcontainer.json invalid JSON` の FAIL になります（#938 で 1 件だけ満たせなかった acceptance）。
#939 で、それまでこのファイルにコメントで書いていた注記をこの README へ移しました（値は 1 つも変えていません）。
`scripts/check-devcontainer-dev01.sh`（`scripts/acceptance.sh` から回る）が `jq` で読めることを確かめます。

注記を足したいときは、このファイルへ書きます。

### `"updateRemoteUserUID": true`（#879）

vscode の UID/GID をホストの利用者に合わせます。**既定で on ですが、依存していることを明示しています。**

- devcontainer CLI が Linux で動くとき（dev01 の Remote-SSH）、compose 方式でもコンテナを作るたびに
  `updateUID.Dockerfile` の段（`-uid` 付きのイメージ）で付け替えます。ネイティブ Linux の Docker は
  bind mount の所有者を数値のまま通すので、これが無いと dev01（uid=1001）でワークスペースへ書き込めません。
- macOS では CLI が既定で飛ばし、vscode は 1000 のままです（Docker Desktop が所有者を写すので要りません）。
- **false にすると dev01 で書き込めなくなります。** `scripts/check-devcontainer-dev01.sh` が見ます。

compose.yaml 側で付け替えない理由と、付け替えの代償（features が置いたディレクトリの所有者）は、
compose.yaml の `image` の上の注記にあります。

### `"securityOpt": ["seccomp=unconfined"]`（#929 / #933）

codex の `--sandbox read-only`（同梱の bwrap）が namespace を作れるよう、seccomp を外します。

- go の feature（`ghcr.io/devcontainers/features/go:1`）も同じ値を宣言しますが、それに頼ると、
  feature を外した日や feature 側の宣言が変わった日に、dev01 でも Mac でも黙って動かなくなります。
- **compose.yaml の `security_opt` には書きません。** そこに書くと feature の上書きの compose と値が重なり、
  Mac の compose（2.40.3）が `security_opt items ... are equal` で起動を拒否します（#933。#929 で書いて
  2026-10-03 に Mac で落ちた）。ここに書いた値は、devcontainer CLI が feature の宣言と重複を除いてまとめます
  （CLI 0.89.0 の実装で確かめた）。DCB の雛形は compose.yaml に書くので、ここは雛形からの逸脱です。
- 経緯（AppArmor を外す理由と、両方を外す必要がある実測）は compose.yaml の `security_opt` の上にあります。
  `scripts/check-devcontainer-dev01.sh` が、compose.yaml に seccomp が**無い**ことと、ここに**在る**ことを見ます。

### `"ghcr.io/devcontainers/features/go:1": {}` に版を書かない（#141 / #185）

**Go の版をここへ書き写さないでください。** 値の正本は `docker/isolated-build/Dockerfile` の `ARG GO_VERSION` です。

- **開発環境をピン留めへ揃えていないのは、判断した結果です**（#185）。モジュールの `go` ディレクティブ
  （正本と機械照合済み）を読んで go 自身がツールチェインを切り替えるため、ここで版を固定しなくても、
  ピン留めどおりの版でビルド・テストが回ります。**ここへ版を書くと「必ず古くなる写し」が 1 つ増え、
  しかも Go を上げるたびに全員が devcontainer を再構築することになります。**
  理由・帰結・踏んだときの直しかたは `docs/local-dev.md` 5.11 にあります。
- **`GOTOOLCHAIN` を `local` に固定しないこと。** あれはビルドイメージ側の要求（CVE-2023-39320 の系統）で、
  開発環境で同じ値にすると上の切り替えが止まり、ハンドラのテストが手元で回らなくなります。
- JSONC だったころは、版を書き足した行に「値の正本は `ARG GO_VERSION`」と名乗らせて
  `scripts/check-go-version-copies.sh` に照合させる、という逃げ道を注記で残していました。
  純粋な JSON では行に名乗りを付けられないので、**#939 からは `scripts/check-devcontainer-dev01.sh` が、
  go の feature が在り、そのオプションが空（`{}`）であることを確かめます。** 版を書くと落ちます。

### `postCreateCommand` の `install-cloudflared.sh`（#802）

dev01 へ ssh で入る入口（cloudflared）を用意します。`DEVCONTAINER_HOST=dev01`（`.devcontainer/.env`、追跡外）の
ときは、dev01 自身への入口（自己参照）を書かずに抜けます。DCB の雛形には無い、このプロジェクト固有の段です。

### `postCreateCommand` の `install-uv.sh`（#956）

uv を `~/.local/bin` へ入れます。月次の運営報告の推敲の段（`scripts/ops-report-draft.sh`）が、
`.claude/skills/natural-japanese/` の lint を `uv run` で動かすためです。版（公開から 2 週間以上たったもの）と
アーキテクチャごとのチェックサムを `scripts/install-uv.sh` に固定し、合わなければ置きません。`~/.local` は volume では
ないので、作り直すたびに入れ直します。入ったかは `scripts/post-rebuild-check.sh` の `[check] uv OK (<版>)` で確かめます。
DCB の雛形には無い、このプロジェクト固有の段です（`.github/project-ai-rules.md`「雛形からの逸脱」）。

### `postCreateCommand` の `install-browser.sh`（#960）

Chromium（headless shell）を `~/.cache/ms-playwright/` へ入れ、その依存のシステムのパッケージ（日本語のフォントを含む）を
足りないときだけ sudo で入れます。月次の運営報告の画像の段（#957）と、実ブラウザの検査（`scripts/check-page-width.sh`・
`scripts/check-sandbox-browser.sh`・`scripts/shoot-pages.sh`）が使うためです。playwright-core の版（公開から 2 週間以上たったもの）と
npm の tarball のチェックサムを `scripts/install-browser.sh` に固定し、合わなければ使いません。sudo で入れるのは
`playwright install-deps` が挙げるパッケージだけです。`~/.cache` も apt で入れたものも volume ではないので、作り直すたびに
入れ直します（取得は headless shell が約 115 MB、apt が約 85 MB。空の noble で aarch64 が 33 秒、x86_64 がエミュレーションで 45 秒）。
入ったかは `scripts/post-rebuild-check.sh` の `[check] headless shell OK (…)`・`[check] system packages OK (…)`・`[check] japanese font OK (…)` で確かめます。
DCB の雛形には無い、このプロジェクト固有の段です（`.github/project-ai-rules.md`「雛形からの逸脱」）。

## `compose.yaml` の `init: true`（#939）

DCB の雛形に合わせて、PID 1 を Docker の組み込みの init（docker-init）にし、孤児になったプロセスを回収させます
（理由は compose.yaml の注記）。

**効き目は #939 の前から出ています。** go の feature が `init: true` も宣言しており（devcontainer-feature.json 1.4.0。
`securityOpt`・`capAdd` と同じく delve のため）、devcontainer CLI が上書きの compose で足すので、2026-10-08 の時点で
Mac のコンテナの PID 1 はすでに `docker-init` でした（`ps -p 1 -o comm=`）。compose.yaml に書くのは、seccomp と同じく
go の feature に頼らないためです。`init` は真偽値なので、feature の宣言と重なっても `security_opt` のような
重複の拒否は起きません（作り直しで確かめる。#939 の acceptance）。
`scripts/check-devcontainer-dev01.sh` が、展開した compose で `init` が `true` であることを見ます。
