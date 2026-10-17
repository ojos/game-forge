# `.devcontainer/` の注記

`devcontainer.json` と `compose.yaml` は devcontainer-bootstrap（DCB）が生成するファイルです。
雛形との差分のうち残しているものの一覧は `.github/project-ai-rules.md`「雛形からの逸脱」が正本で、
このファイルは各値の理由と経緯を持ちます。追従の手順は `docs/local-dev.md`「DCB と規範への追従」です。

## `devcontainer.json` のコメントは雛形のものだけにする（#939 / DCB v0.21.0）

**DCB v0.21.0 から、`devcontainer.json` は JSONC（コメント付き）になりえます**（ojos/ai-packages-dev#571）。
`doctor.sh` はコメントを除いてから `jq` で読みます。#939 では、当時の `doctor.sh` がコメントで FAIL を出したので
純粋な JSON に保ち、注記をこの README へ移しました。v0.22.1 への追従で、雛形が `securityOpt` の上に置く
コメントだけを取り込んでいます。

**game-forge の注記は、これまでどおりこのファイルへ書きます。** `devcontainer.json` に足すと、雛形との差分が増え、
追従のたびに `.dcb-new` で突き合わせる行が増えます。
`scripts/check-devcontainer-dev01.sh`（`scripts/acceptance.sh` から回る）は、`doctor.sh` と同じ方法でコメントを除いてから読みます。

### `"updateRemoteUserUID": true`（#879）

vscode の UID/GID をホストの利用者に合わせます。**既定で on ですが、依存していることを明示しています。**

- devcontainer CLI が Linux で動くとき（dev01 の Remote-SSH）、compose 方式でもコンテナを作るたびに
  `updateUID.Dockerfile` の段（`-uid` 付きのイメージ）で付け替えます。ネイティブ Linux の Docker は
  bind mount の所有者を数値のまま通すので、これが無いと dev01（uid=1001）でワークスペースへ書き込めません。
- macOS では CLI が既定で飛ばし、vscode は 1000 のままです（Docker Desktop が所有者を写すので要りません）。
- **false にすると dev01 で書き込めなくなります。** `scripts/check-devcontainer-dev01.sh` が見ます。

compose.yaml 側で付け替えない理由と、付け替えの代償（features が置いたディレクトリの所有者）は、
compose.yaml の `image` の上の注記にあります。

### `"securityOpt": ["apparmor=unconfined", "seccomp=unconfined"]`（#874 / #929 / #933）

codex の `--sandbox read-only`（同梱の bwrap）を動かすために、AppArmor と seccomp の既定の制限を外します。
**v0.22.1 への追従で、DCB の雛形の置き場所（両方を `devcontainer.json` の `securityOpt`。ojos/ai-packages-dev#543）へ寄せました。**
それまでは AppArmor を compose.yaml の `security_opt` に、seccomp をここに置いていました（雛形からの逸脱でした）。

- **AppArmor**（#874）: dev01（Ubuntu 26.04 のネイティブ Docker）はコンテナに AppArmor の `docker-default` を当て、
  その `deny mount` で bwrap が `Failed to make / slave: Permission denied` になります。codex は差分を読めないまま答えます
  （#873 でゲートは止まるようになりましたが、第二意見そのものが取れません）。Mac（Docker Desktop）には AppArmor が無いので
  何も変わりません。**codex を danger-full-access で回す代わりにこれを選びました**（read-only の担保を残す）。
- **seccomp**（#929）: Docker の既定の seccomp は namespace の作成を止めます（Mac の Docker Desktop でも同じ。
  ojos/ai-packages-dev#392 の実測）。**dev01 で bwrap が通るには両方を外す必要があります**（AppArmor だけでは
  `No permissions to create new namespace` で落ちる。同じ実測）。
- go の feature（`ghcr.io/devcontainers/features/go:1`。devcontainer-feature.json 1.4.0）も、delve のために
  `securityOpt: ["seccomp=unconfined"]`・`capAdd: ["SYS_PTRACE"]`・`init: true` を宣言しています。devcontainer CLI が
  それを上書きの compose（`docker-compose.devcontainer.containerFeatures-*.yml`）で足します。それに頼ると、
  feature を外した日や feature 側の宣言が変わった日に、dev01 でも Mac でも黙って動かなくなるので明示します。
- **compose.yaml の `security_opt` には書きません。** そこに書くと feature の上書きの compose と値が重なり、
  Mac の compose（2.40.3）が `security_opt items ... are equal` で起動を拒否します（#933。#929 で書いて
  2026-10-03 に Mac で落ちた。compose v5.6.0 は黙って 1 つにまとめるので、版によっては気づけません）。
  ここに書いた値は、devcontainer CLI が feature の宣言と重複を除いてまとめます（CLI 0.89.0 の実装で確かめた）。
- 外して失う隔離は小さいと判断しています（docker.sock も mount している）。
- **第二意見のようにツールを無効にした codex の起動でも、緩和は要ります。** codex は起動のたびに bwrap を
  サンドボックスの能力の確認として起動します（DCB の上流が strace で確かめた。ojos/ai-packages-dev#649、DCB v0.23.3 で雛形の
  コメントに追記）。緩和を外した状態での実測は上流でも未了なので、外すのは codex を使わなくなったときだけにします。
- `scripts/check-devcontainer-dev01.sh` が、compose.yaml に `security_opt` が**無い**ことと、ここに両方が**在る**ことを見ます。
  **効くかどうか**（作り直した dev01 のコンテナで bwrap が通るか）は作り直して確かめます（`docs/local-dev.md` 7.4）。

### `"ghcr.io/devcontainers/features/go:1": {}` に版を書かない（#141 / #185）

**Go の版をここへ書き写さないでください。** 値の正本は `docker/isolated-build/Dockerfile` の `ARG GO_VERSION` です。

- **開発環境をピン留めへ揃えていないのは、判断した結果です**（#185）。モジュールの `go` ディレクティブ
  （正本と機械照合済み）を読んで go 自身がツールチェインを切り替えるため、ここで版を固定しなくても、
  ピン留めどおりの版でビルド・テストが回ります。**ここへ版を書くと「必ず古くなる写し」が 1 つ増え、
  しかも Go を上げるたびに全員が devcontainer を再構築することになります。**
  理由・帰結・踏んだときの直しかたは `docs/local-dev.md` 5.11 にあります。
- **`GOTOOLCHAIN` を `local` に固定しないこと。** あれはビルドイメージ側の要求（CVE-2023-39320 の系統）で、
  開発環境で同じ値にすると上の切り替えが止まり、ハンドラのテストが手元で回らなくなります。
- #939 より前は、版を書き足した行に「値の正本は `ARG GO_VERSION`」と名乗らせて
  `scripts/check-go-version-copies.sh` に照合させる、という逃げ道を注記で残していました。
  **#939 からは `scripts/check-devcontainer-dev01.sh` が、go の feature が在り、そのオプションが空（`{}`）であることを
  確かめます。** 版を書くと落ちます（DCB v0.21.0 でコメントを書けるようになった後も、この形のままにしています）。

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

### `postCreateCommand` の `install-whisper.sh`（#974）

試用の録画の文字起こしの道具（faster-whisper と whisper large-v3-turbo のモデル）と ffmpeg を `~/.local/share/game-forge/whisper/` へ入れます。`scripts/trial-analyze.sh` が使うためです。版（公開から 2 週間以上たったもの）とハッシュは、`scripts/lib/trial-whisper-requirements.txt` とモデルの commit・sha256（`scripts/install-whisper.sh`）で固定し、合わなければ入れません。`~/.local` は volume ではないので、作り直すたびに入れ直します（取得は約 1.9 GB で、aarch64 で 1 分 28 秒）。入ったかは `scripts/post-rebuild-check.sh` の `[check] stamp OK`・`faster-whisper OK`・`model OK`・`ffmpeg OK` で確かめます。DCB の雛形には無い、このプロジェクト固有の段です（`.github/project-ai-rules.md`「雛形からの逸脱」）。

## `onCreateCommand` と `claudeCode.claudeProcessWrapper`（#968）

DCB v0.23.3 の雛形どおりの値です（逸脱ではありません）。`onCreateCommand` が起動役 `~/.local/bin/claude-session-launcher` を
作業ツリーの外へ直接書き出し（DCB v0.19.1 から。`scripts/on-attach.sh` を呼ばない）、接続のたびに `scripts/on-attach.sh` も同じ中身で置き直します。VS Code の設定 `claudeCode.claudeProcessWrapper` がそれを指します。
起動役は、起動したときの作業ツリーに `scripts/claude-session-wrapper.sh` があればそれを経由し、無ければそのまま Claude Code を起動します。
ラッパーは `.env` の `SESSION_HOST_LABEL` があれば、セッションの宛先名を `<ラベル>-<作業ツリー名>-<末尾>` にします（`/peers` で使う）。末尾は、DCB v0.21.0 から会話の識別子の先頭 8 桁です（起動の引数に `--resume` が無いときは従来どおり PID の 16 進。ojos/ai-packages-dev#577）。

- **`devcontainer.json` に `.dcb-new` を残したまま作り直しません。** v0.19.1 からは設置と配線（`claudeCode.claudeProcessWrapper`）が
  同じファイルにあるので片方だけが新しい状態は起きませんが、`devcontainer.json` が v0.19.0 のまま残ると、設置を
  `on-attach.sh --install-launcher` に頼る形に戻ります（DCB v0.19.1 の CHANGELOG「移行」）。
- 配線は作り直しで効きます。作り直したら `test -x ~/.local/bin/claude-session-launcher` で起動役が置かれたことを確かめます。
- **万一 Claude Code が起動しなくなったら**、VS Code のリモートの設定で `claudeCode.claudeProcessWrapper` を空にすれば元に戻ります。

## `compose.yaml` の `init: true`（#939）

DCB の雛形に合わせて、PID 1 を Docker の組み込みの init（docker-init）にし、孤児になったプロセスを回収させます
（理由は compose.yaml の注記）。

**効き目は #939 の前から出ています。** go の feature が `init: true` も宣言しており（devcontainer-feature.json 1.4.0。
`securityOpt`・`capAdd` と同じく delve のため）、devcontainer CLI が上書きの compose で足すので、2026-10-08 の時点で
Mac のコンテナの PID 1 はすでに `docker-init` でした（`ps -p 1 -o comm=`）。compose.yaml に書くのは、seccomp と同じく
go の feature に頼らないためです。`init` は真偽値なので、feature の宣言と重なっても `security_opt` のような
重複の拒否は起きません（作り直しで確かめる。#939 の acceptance）。
`scripts/check-devcontainer-dev01.sh` が、展開した compose で `init` が `true` であることを見ます。
