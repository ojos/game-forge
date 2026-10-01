# devhost — 開発機のホストに置く入口の道具

Linux の開発機（Docker Engine が動くホスト）に置き、**スマホ（Termux）のショートカット 1 タップで
devcontainer を起こし、入り、再認証する**ための道具一式です。どのプロジェクトにも依存しません。
名前・パス・ホスト名は開発機の設定ファイルに置き、ここには書きません（機械で検査しています）。

| ファイル | 置き場所（ホスト） | 役割 |
|---|---|---|
| `dev.sh` | `~/.local/bin/dev` | 入口の道具。`ls` / `up` / `attach` / `auth aws` / `supervise` |
| `dev-up@.service` | `~/.config/systemd/user/` | 起動時と、コンテナが止まったときに起こし直すユニット |
| `projects.example` | `~/.config/dev/projects` | 設定ファイルの雛形（名前 → パス） |
| `termux/ssh_config.example` | スマホの `~/.ssh/config` | ssh の入口の断片 |
| `termux/shortcut.example` | スマホの `~/.shortcuts/` | Termux:Widget のボタン 1 つ分 |
| `selftest.sh` | （置かない） | 偽の道具で回す自己試験 |

## 層と、この道具が戻すもの

| 層 | 落ちたとき | 戻し方 |
|---|---|---|
| ① 電源・OS | 何も届かない | **範囲外**（物理的な対処） |
| ② ホストの ssh の入口（トンネル・sshd） | ssh が通らない | **範囲外**（ホストの systemd が持つ） |
| ③ devcontainer | `dev ls` の CONTAINER が running でない | **自動**（`dev-up@<名前>`）。待てないときは `dev up <名前>` |
| ④ tmux とその中のエージェント | `dev ls` の TMUX が none | **手で**（`dev attach <名前>`。指示の無いエージェントを自動で起こしても作業は進まない） |
| ⑤ 認証 | `dev ls` の AWS が expired | **手で**（`dev auth aws <名前>`。デバイスコードをスマホのブラウザで承認する） |

## ホストへの導入

### devcontainer CLI を入れる

公式の導入スクリプトを使います。**Node.js を同梱して `~/.devcontainers/` に入る**ので、ホストに Node を
入れる必要がなく、ssh の非対話のコマンドや systemd のように `~/.profile` を読まない場面でも
版がずれません（`dev` が `~/.devcontainers/bin` を PATH の末尾へ足します）。

```bash
curl -fsSL https://raw.githubusercontent.com/devcontainers/cli/main/scripts/install.sh -o /tmp/devcontainer-install.sh
less /tmp/devcontainer-install.sh          # 中身を読んでから回す
sh /tmp/devcontainer-install.sh --version 0.89.0
~/.devcontainers/bin/devcontainer --version
```

npm の `@devcontainers/cli` でも動きますが、ホストに Node 20 以上が要ります（0.89.0 の `engines`）。

### dev を置く

```bash
install -D -m 0755 tools/devhost/dev.sh ~/.local/bin/dev
mkdir -p ~/.config/dev
cp tools/devhost/projects.example ~/.config/dev/projects   # 名前と絶対パスを書く
~/.local/bin/dev ls
```

**リンクではなく写しで置きます。** リンクにすると、そのリポジトリのブランチを切り替えただけで
ホストの道具が黙って変わるためです。道具を更新したら、同じ `install` をもう一度打ちます。

### ユニットを入れる

```bash
install -D -m 0644 tools/devhost/dev-up@.service ~/.config/systemd/user/dev-up@.service
systemctl --user daemon-reload
sudo loginctl enable-linger "$USER"        # ログインしていない間も、起動時からユーザーのユニットを動かす
systemctl --user enable --now dev-up@<名前>.service
systemctl --user status dev-up@<名前>.service
journalctl --user -u dev-up@<名前>.service -n 20
```

- **ユーザーのユニットにしています。** root のユニットにすると利用者の名前（`User=`）を書くことになり、
  docker グループの権限で足りるものに root を使うことになるためです。
- **`docker` グループへ足したのがユーザーのマネージャの起動より後なら**、マネージャは古いグループのまま
  なので、ホストを再起動するか `sudo systemctl restart user@$(id -u).service` で起こし直します。
- 起動の直後に Docker のデーモンが遅れても、`up` が失敗して 30 秒後にやり直します（回数の上限なし）。

## VS Code の窓を閉じたときの停止（stopCompose）

devcontainer.json が `shutdownAction: stopCompose` のプロジェクトでは、ホストに繋いだ VS Code の窓を
閉じるとコンテナが止まります。**docker から見れば「意図した停止」で、異常終了ではありません。**
これをどう戻すかの比較です。

| 案 | VS Code を閉じた後 | docker kill の後 | 他の端末への影響 | 採否 |
|---|---|---|---|---|
| **A. ユニットの ExecStart が止まるまで待ち、止まったら 0 以外で抜ける**（`dev supervise`） | 30 秒後に戻る | 30 秒後に戻る | なし（プロジェクトの定義を触らない） | **採用** |
| B. タイマーで定期に `dev up` を打つ | 周期の分だけ遅れる | 同左 | なし | 不採用。動いている間も `up` を打ち続け、そのたびに postAttachCommand が走る |
| C. 開発機では VS Code から繋がない運用にする | 止まる | 戻らない（別の仕組みが要る） | なし | 不採用。導入とログインで VS Code が要り、約束は 1 度閉じれば破れる |
| D. devcontainer.json の shutdownAction を開発機だけ `none` にする | 止まらない | 戻らない（別の仕組みが要る） | 共通の定義を触る | 不採用。compose の `.env` は devcontainer.json に届かず、列挙値への置換が効くかは確かめられない。異常停止にはどのみち A が要る |
| E. compose に `restart: unless-stopped` | 戻らない（stop は除外される） | 戻る | 共通の定義を触る | 不採用。本件（意図した停止）を解かない |

**A は「止まった理由」を見ません。** `dev supervise` は `devcontainer up` の結果からコンテナの ID を取り、
`docker wait` で止まるまで待ち、止まったら 0 以外で抜けます。ユニットの `Restart=always` は
（0 以外で抜けるので `on-failure` でも）30 秒後に起こし直します。VS Code の停止も、docker kill も、
デーモンの再起動も同じ扱いです。

**引き換えに、意図して止めたいときはユニットを先に止めます。** Rebuild Container の前も同じです
（止めずに Rebuild すると、30 秒後にユニットの `up` が VS Code のビルドと重なりえます）。

```bash
systemctl --user stop dev-up@<名前>.service    # 戻すのをやめる（コンテナは止めない）
# … Rebuild や docker compose stop など …
systemctl --user start dev-up@<名前>.service   # 再び見張る（止まっていれば起こす）
```

## 使い方

```text
dev ls                                   NAME / CONTAINER / UNIT / TMUX / AWS を 1 行ずつ
dev up <名前>                            devcontainer up --workspace-folder <パス>
dev attach <名前>                        devcontainer exec --workspace-folder <パス> tmux new-session -A -s <セッション>
dev auth aws <名前> [--sso-session <s>]  devcontainer exec ... aws sso login --sso-session <s> --no-browser --use-device-code
```

- **`attach` はコンテナを起こしません。** 止まっていれば `dev up` を案内して止まります（ユニットが
  起こし直している最中に 2 本目の `up` を重ねないため）。
- `ls` の AWS は**期限の日時ではなく「いま通るか」**です（`aws sts get-caller-identity --profile <p>`）。
  SSO のキャッシュの `expiresAt` はアクセストークンの短い期限で、再認証が要る日ではないためです。
  `aws_profile` を書いていないプロジェクトは `-` です。
- 終了コードは 0 = 成功 / 1 = 実行の失敗 / 2 = 使い方か設定の誤り（未登録の名前を含む）。

## スマホ（Termux）

### 入れるもの

**Termux と Termux:Widget は同じ入手元（F-Droid か GitHub の Releases）から入れます。** 署名が入手元ごとに
違い、混ぜると連携しません。Google Play 版は更新が止まっていて、追加アプリとも連携しません。

```bash
pkg install openssh cloudflared
```

### スマホ専用の鍵

**このスマホのためだけの鍵を作り、パスフレーズを付けます。** 他の端末の鍵は写しません。
紛失したら、ホストの `authorized_keys` からその 1 行を消せば失効します。

```bash
# スマホ（Termux）で
ssh-keygen -t ed25519 -a 100 -f ~/.ssh/<鍵> -C "<見分けの付く名前>"   # パスフレーズを付ける
cat ~/.ssh/<鍵>.pub                                                      # この 1 行をホストへ渡す
```

公開鍵は秘密ではないので、自分宛てのメモなどでホストに入れる端末へ渡し、ホストで足します。

```bash
# ホストで（既に入れる端末から）
umask 077 && mkdir -p ~/.ssh
printf '%s\n' '<公開鍵の 1 行>' >> ~/.ssh/authorized_keys
```

**失効させる**（ホストで。コメントの `<見分けの付く名前>` で行を引く）:

```bash
cp ~/.ssh/authorized_keys ~/.ssh/authorized_keys.bak
grep -vF '<見分けの付く名前>' ~/.ssh/authorized_keys.bak > ~/.ssh/authorized_keys
grep -cF '<見分けの付く名前>' ~/.ssh/authorized_keys     # 0 であること
```

既存のファイルへの書き込みなので、`authorized_keys` の権限（600）はそのまま残ります。
失効の後、スマホからの ssh は `Permission denied (publickey)` で止まります。

### ssh の入口とショートカット

`termux/ssh_config.example` を `~/.ssh/config` に足し、`termux/shortcut.example` を写して
`~/.shortcuts/` にボタン 1 つにつき 1 ファイル置きます（`chmod 700 ~/.shortcuts && chmod +x ~/.shortcuts/*`）。
ホーム画面に Termux:Widget のウィジェットを置くと、ファイル名がボタンになります。

- **ボタンを押すたびに鍵のパスフレーズを聞かれます。** 紛失時の守りなので、agent に常駐させません。
- **Access の認証が切れていると**、ssh の代わりに cloudflared が URL を出して待ちます。URL を長押しで開き、
  ブラウザで認証すると、そのまま ssh が続きます。
- ショートカットの `dev` は `.local/bin/dev` と書きます。ssh の非対話のコマンドではホストの `~/.profile` が
  読まれず、`~/.local/bin` が PATH に無いためです。

## 試験

```bash
bash tools/devhost/selftest.sh   # DEVHOST_SELFTEST_PASS
```

偽の devcontainer / docker / tmux / aws / systemctl を PATH に置き、組み立てるコマンド・未登録の名前の拒否・
設定ファイルの誤り・ユニットの要の行を見ます。偽物を本物に合わせたところは `selftest.sh` の冒頭にあります。
