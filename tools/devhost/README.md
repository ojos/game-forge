# devhost — dev01 のホストに置く道具（game-forge の差分）

**devhost の本体（`dev` と `dev-up@.service`、Termux と ssh の雛形）は、上流の版を使います。**
上流は ojos/ai-packages-dev の `packages/devhost` で、[devcontainer-bootstrap（DCB）のリリース](https://github.com/ojos/devcontainer-bootstrap/releases)に
同梱されています（同梱は [v0.14.0](https://github.com/ojos/devcontainer-bootstrap/releases/tag/v0.14.0) から）。
導入・stopCompose の扱い・鍵の作り方と失効・Termux の設定は、**DCB のアーカイブの `devhost/README.md` が正本**です。
入手は、その README の「devhost を入手する」のとおり、`RELEASE-MANIFEST.json` に記録された
`PACKAGE_ARCHIVE.tar.gz` のハッシュと照合してから `./devhost` を取り出します。

**上流の版をこのリポジトリへ写しません**（二重管理を作らないため。#923）。ここに置くのは、上流に無い
game-forge 固有の差分だけです。`scripts/check-devhost.sh` が、このディレクトリに次の 3 つ以外が無いことを見ます。

| ファイル | 置き場所（dev01） | 役割 |
|---|---|---|
| `dev-auth-aws.sh` | `~/.local/bin/dev-auth-aws` | コンテナの中で AWS の SSO にデバイスコードで入る |
| `dev-auth-aws.selftest.sh` | （置かない） | 偽の devcontainer / docker / aws で回す自己試験 |
| `README.md` | （置かない） | この案内 |

dev01 の値で埋めた導入の形と、復旧の手順は [docs/local-dev.md の 7.9](../../docs/local-dev.md) にあります。

## dev-auth-aws（AWS SSO に入る薄い追加）

上流は「特定のクラウドへの認証を devhost に組み込まない」方針で、game-forge 版にあった `dev auth aws` を持ちません。
その 1 つだけを、上流の `dev` から独立した別のコマンドとして残します。

```text
dev-auth-aws <名前> [--sso-session <s>]               自前の設定ファイルの行で入る
dev-auth-aws --workspace <絶対パス> --sso-session <s>  設定ファイルを読まずに入る
```

- することは、game-forge 版の `dev auth aws` と同じです。コンテナが動いていることを確かめてから
  `devcontainer exec --workspace-folder <パス> aws sso login --sso-session <s> --no-browser --use-device-code` を打ちます。
  **コンテナは起こしません**（止まっていれば、打たずに `dev up` を案内して 1 で止まります）。
- **上流の `dev` にも、その設定ファイル（`~/.config/dev/projects`）にも依存しません。** 上流の `dev` は
  知らないキーで止まるので、セッション名をあちらに書けないためです。設定は自前の
  `~/.config/dev/aws-sso`（`DEV_AUTH_AWS_FILE` で差し替えられる）に、1 行 1 つ `名前 絶対パス セッション名` で書きます。
- 終了コードは 0 = 成功 / 1 = 実行の失敗 / 2 = 使い方か設定の誤り（未登録の名前を含む）。
  `aws sso login` が失敗したときは、その終了コードをそのまま返します。

### 試験

```bash
bash tools/devhost/dev-auth-aws.selftest.sh   # DEV_AUTH_AWS_SELFTEST_PASS
```

`scripts/check-devhost.sh`（`scripts/acceptance.sh` から回る）が呼びます。「コンテナの中で `aws sso login` を
正しい引数で呼ぶ」「コンテナが止まっている・無いときは打たずに 1 で止まる」「使い方と設定の誤りは何も呼ばずに 2」を、
終了コードと偽物の呼び出しの記録で見ます。偽物を本物に合わせたところは、自己試験の冒頭にあります。

## 上流の版へ寄せて失うもの

| 失うもの | 代わりの確かめ方 |
|---|---|
| `dev ls` の AWS の列（`aws sts get-caller-identity --profile <p>` で、いま認証が通るかを見ていた） | `dev attach <名前>` で入ってから `aws sts get-caller-identity --profile game-forge-dev`。通れば JSON、切れていれば `Token has expired` |
| `dev auth aws <名前>` | `dev-auth-aws <名前>`（上の薄い追加） |
| 設定ファイルの `aws_sso_session` / `aws_profile` のキー | セッション名は `~/.config/dev/aws-sso` へ。`aws_profile` は使い道が無くなる（上の行を手で打つときに名前を書く） |

ホストから入らずに確かめるなら、`devcontainer exec --workspace-folder <パス> aws sts get-caller-identity --profile game-forge-dev` の
1 行でも同じです（コンテナが動いていること）。

## dev01 の移行手順（game-forge 版から上流の版へ）

**作業中のコンテナを止めずに済む順序です。** 要点は 2 つです。

- **上流の `dev` を置く前に、設定ファイルから AWS のキーを外します。** 上流の `dev` は知らないキーで止まります。
  先に置くと、次にコンテナが止まったときのユニットの `dev supervise` が設定の誤りで落ち続け、コンテナが戻りません。
  逆に、キーを外しても game-forge 版の `dev` は困りません（AWS の列が `-` になるだけ）。
- **置き換えは `install` で行い、`cp` で上書きしません。** いま動いているユニットの `dev supervise` は bash が
  スクリプトを少しずつ読みながら `docker wait` で待っています。`install` は新しいファイルを作って差し替えるので、
  動いているプロセスは古い中身のまま最後まで動きます。同じファイルへ上書きすると、待ち終わった後に新しい中身の
  途中から読みます。

```bash
# 0. いまの状態を控える（CONTAINER が running、UNIT が active であること）
~/.local/bin/dev ls

# 1. 上流の版を DCB v0.14.0 から取り出す（作業用のディレクトリで。手順の全文は上流の README の「devhost を入手する」）
mkdir -p ~/dcb-v0.14.0 && cd ~/dcb-v0.14.0
TAG=v0.14.0
BASE="https://github.com/ojos/devcontainer-bootstrap/releases/download/${TAG}"
curl -sSL "${BASE}/RELEASE-MANIFEST.json" -o RELEASE-MANIFEST.json
curl -sSL "${BASE}/PACKAGE_ARCHIVE.tar.gz" -o PACKAGE_ARCHIVE.tar.gz
jq -r '.checksums["PACKAGE_ARCHIVE.tar.gz"] + "  PACKAGE_ARCHIVE.tar.gz"' RELEASE-MANIFEST.json | sha256sum -c -   # bsd-ok: dev01（Linux）のホストで打つ手順。OK と出ること
tar -xzf PACKAGE_ARCHIVE.tar.gz ./devhost

# 2. ユニットを比べる。v0.14.0 は game-forge 版と同じ中身なので、何も出ずに 0 で抜けるはず。
#    同じなら入れ替えない（daemon-reload も restart もしない）。
cmp devhost/dev-up@.service ~/.config/systemd/user/dev-up@.service && echo SAME_UNIT

# 3. 薄い追加を置く（作業中のツリーを触らず、main の版を取ってくる）
curl -fsSL https://raw.githubusercontent.com/ojos/game-forge/main/tools/devhost/dev-auth-aws.sh -o dev-auth-aws.sh
less dev-auth-aws.sh                           # 中身を読んでから置く
install -D -m 0755 dev-auth-aws.sh ~/.local/bin/dev-auth-aws
# パスは決め打ちせず、いまの projects ファイルから読む（4 で外す前に）。
# dev01 の置き場所は ~/Workspaces/game-forge で、docs の ~/game-forge と違う（#923 の移行で踏んだ）。
# セッション名は projects の aws_sso_session から読み、無ければ（新しく導入するときは、projects に AWS のキーが無い）
# game-forge の既定の ojos（~/.aws/config の [sso-session ojos]）を使う。
awk -v def=ojos '$1=="game-forge"{s=def; for(i=3;i<=NF;i++) if($i ~ /^aws_sso_session=/) s=substr($i,17); print $1, $2, s}' \
  ~/.config/dev/projects > ~/.config/dev/aws-sso
cat ~/.config/dev/aws-sso                      # 「名前 絶対パス セッション名」の 3 列であること
~/.local/bin/dev-auth-aws game-forge          # デバイスコードをブラウザで承認する（game-forge 版の dev のままでも動く）

# 4. 設定ファイルから AWS のキーを外す（game-forge 版の dev のままで、ls の AWS 列が - になる）
cp ~/.config/dev/projects ~/.config/dev/projects.bak
sed -e 's/[[:space:]]aws_sso_session=[^[:space:]]*//g' -e 's/[[:space:]]aws_profile=[^[:space:]]*//g' \
  ~/.config/dev/projects.bak > ~/.config/dev/projects
grep -c 'aws_' ~/.config/dev/projects          # 0 であること
~/.local/bin/dev ls                            # まだ game-forge 版。AWS の列が - になる

# 5. 上流の dev を置く（install で差し替える。ユニットは止めない）
install -D -m 0755 devhost/dev.sh ~/.local/bin/dev
~/.local/bin/dev ls                            # NAME / CONTAINER / UNIT / TMUX の 4 列。設定の誤りで止まらないこと
systemctl --user is-active dev-up@game-forge.service   # active のまま

# 6. 片付け
rm ~/.config/dev/projects.bak
cd ~ && rm -rf ~/dcb-v0.14.0
```

- **動いているユニットの `dev supervise` は、次にコンテナが止まるまで game-forge 版のまま**です。止まった後、
  ユニットが起こし直すときから上流の版が動きます（ユニットの中身は同じなので、入れ替えは要りません）。
  すぐに上流の版で見張らせたいときは、作業の切れ目で `systemctl --user restart dev-up@game-forge.service` を打ちます
  （ユニットを止めてもコンテナは止まりません。`up` は動いているコンテナに対しては起こし直しません）。
- **薄い追加を更新するとき**は、3 の `curl` と `install` をもう一度打ちます（リンクにしないのは、上流の `dev` と同じく、
  ブランチの切り替えでホストの道具が黙って変わらないようにするため）。
- **2 でユニットが違った場合**は、`install -D -m 0644 devhost/dev-up@.service ~/.config/systemd/user/dev-up@.service` と
  `systemctl --user daemon-reload` だけを打ちます。restart はしません（次に起こし直すときから新しい中身が効きます）。
- **スマホのボタンの `gf-auth-aws` を書き換えます**（他の 3 つはそのまま）。

  ```bash
  printf '#!/data/data/com.termux/files/usr/bin/bash\nexec ssh -t dev01 .local/bin/dev-auth-aws game-forge\n' > ~/.shortcuts/gf-auth-aws
  chmod +x ~/.shortcuts/gf-auth-aws
  ```

### 移行の後に確かめること（#923 の acceptance の 3 つ目）

dev01 で、上流の版の `dev ls` / `dev up game-forge` / `dev attach game-forge` と、`dev-auth-aws game-forge` を 1 回ずつ通し、
結果を #923 か PR に書きます。
