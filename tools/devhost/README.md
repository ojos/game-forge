# devhost — dev01 のホストに置く道具（game-forge の差分）

**devhost の本体（`dev` と `dev-up@.service`、Termux と ssh の雛形）は、上流の版を使います。**
上流は ojos/ai-packages-dev の `packages/devhost` で、[devcontainer-bootstrap（DCB）のリリース](https://github.com/ojos/devcontainer-bootstrap/releases)に
同梱されています（同梱は v0.14.0 から）。**dev01 に置く版は、下の「上流の版を上げる（dev01 の更新）」の
`TAG=` の行が正本**です（#944。いまの版の文字列はほかの節に書かず、そこを参照します）。
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


## 上流の版を上げる（dev01 の更新）

**作業中のコンテナを止めずに済む順序です。** ユニット（`dev-up@.service`）は中身が変わったときだけ入れ替え、
`dev` は `install` で差し替えます。

- **置き換えは `install` で行い、`cp` で上書きしません。** いま動いているユニットの `dev supervise` は bash が
  スクリプトを少しずつ読みながら `docker wait` で待っています。`install` は新しいファイルを作って差し替えるので、
  動いているプロセスは古い中身のまま最後まで動きます。同じファイルへ上書きすると、待ち終わった後に新しい中身の
  途中から読みます。
- **上げる前に、アーカイブの `CHANGELOG.md` を読みます**（手順の 1 の最後）。設定ファイル（`~/.config/dev/projects`）の
  書式が変わっていれば、3 で差し替える前にそちらを先に合わせます（上流の `dev` は知らないキーで止まる）。
- 値（ハッシュ・パス）は手順の中で読みます。ここに書き写しません。

```bash
# 0. 上げる先の版（dev01 に置く上流の版の正本。上げるときはこの 1 行だけを書き換える）
TAG=v0.17.0
#    いまの状態を控える（CONTAINER が running、UNIT が active であること）
~/.local/bin/dev ls
sha256sum ~/.local/bin/dev                     # bsd-ok: dev01（Linux）のホストで打つ手順。上げる前の値を控える
systemctl --user is-active dev-up@game-forge.service

# 1. 取り出す（作業用の空のディレクトリで。手順の全文は上流の README の「devhost を入手する」）
W="$(mktemp -d "${TMPDIR:-/tmp}/devhost.XXXXXX")" && cd "$W"
BASE="https://github.com/ojos/devcontainer-bootstrap/releases/download/${TAG}"
curl -fsSL "${BASE}/RELEASE-MANIFEST.json" -o RELEASE-MANIFEST.json
curl -fsSL "${BASE}/PACKAGE_ARCHIVE.tar.gz" -o PACKAGE_ARCHIVE.tar.gz
jq -r '.checksums["PACKAGE_ARCHIVE.tar.gz"] + "  PACKAGE_ARCHIVE.tar.gz"' RELEASE-MANIFEST.json | sha256sum -c -   # bsd-ok: dev01（Linux）のホストで打つ手順。OK と出ること
tar -xzf PACKAGE_ARCHIVE.tar.gz ./devhost
tar -xzOf PACKAGE_ARCHIVE.tar.gz ./CHANGELOG.md | less   # いまの版から上げる先までの変更を読む

# 2. ユニットを比べる。同じなら SAME_UNIT と出る。同じなら入れ替えない（daemon-reload も restart もしない）
cmp devhost/dev-up@.service ~/.config/systemd/user/dev-up@.service && echo SAME_UNIT

# 3. dev を差し替える（install で。ユニットは止めない）
install -D -m 0755 devhost/dev.sh ~/.local/bin/dev
cmp devhost/dev.sh ~/.local/bin/dev && echo SAME_DEV
sha256sum devhost/dev.sh ~/.local/bin/dev      # bsd-ok: dev01（Linux）のホストで打つ手順。2 行の値が一致すること

# 4. 確かめる（どれも 0 で終わり、ユニットは active のまま）
~/.local/bin/dev ls; echo "ls=$?"
~/.local/bin/dev doctor game-forge; echo "doctor=$?"   # 0 = 問題なし / 1 = FAIL / 3 = WARN だけ
~/.local/bin/dev help >/dev/null; echo "help=$?"
systemctl --user is-active dev-up@game-forge.service

# 5. 片付け
cd ~ && rm -rf "$W"
```

- **動いているユニットの `dev supervise` は、次にコンテナが止まるまで古い版のまま**です。止まった後、
  ユニットが起こし直すときから新しい版が動きます。すぐに新しい版で見張らせたいときは、作業の切れ目で
  `systemctl --user restart dev-up@game-forge.service` を打ちます
  （ユニットを止めてもコンテナは止まりません。`up` は動いているコンテナに対しては起こし直しません）。
- **2 でユニットが違った場合**は、`install -D -m 0644 devhost/dev-up@.service ~/.config/systemd/user/dev-up@.service` と
  `systemctl --user daemon-reload` だけを打ちます。restart はしません（次に起こし直すときから新しい中身が効きます）。
- **`dev doctor` が 3（WARN だけ）で終わった場合**は、上げた作業の失敗ではありません（pids の上限に当たった回数・
  ゾンビ・oom_kill のどれかが記録に残っている）。出た項目を読んでから判断します。1（FAIL）なら上流の README の
  「dev doctor」のとおり `dev rebuild game-forge` を検討します（作業中のコンテナと tmux は消えます）。
- **v0.17.0 で増えたもの**（v0.14.0 から）: `dev rebuild <名前> [--pull]`（ユニットを止めてから作り直し、起こし直す）、
  `dev doctor <名前>`（コンテナ・exec の疎通・プロセス数・ゾンビ・oom_kill・ユニットを 1 回で見る）、`dev help`。
  ユニットの中身は v0.14.0 と同じです（#944 で `cmp` で確かめた）。**作り直しは、VS Code の Rebuild Container と
  ユニットの手での stop / start の代わりに `dev rebuild game-forge` で行えます。**

## 薄い追加を置く・更新する

作業中のツリーを触らず、main の版を取ってきます。新しく置くときも、更新するときも同じです
（リンクにしないのは、上流の `dev` と同じく、ブランチの切り替えでホストの道具が黙って変わらないようにするため）。

```bash
W="$(mktemp -d "${TMPDIR:-/tmp}/devhost.XXXXXX")" && cd "$W"
curl -fsSL https://raw.githubusercontent.com/ojos/game-forge/main/tools/devhost/dev-auth-aws.sh -o dev-auth-aws.sh
less dev-auth-aws.sh                           # 中身を読んでから置く
install -D -m 0755 dev-auth-aws.sh ~/.local/bin/dev-auth-aws
cd ~ && rm -rf "$W"
```

設定ファイル `~/.config/dev/aws-sso` が無ければ、`~/.config/dev/projects` の行から作ります。パスは決め打ちせず、
いまの projects ファイルから読みます（dev01 の置き場所は `~/Workspaces/game-forge` で、docs の `~/game-forge` と違う。
#923 の移行で踏んだ）。セッション名は game-forge の既定の `ojos`（`~/.aws/config` の `[sso-session ojos]`）です。

```bash
[ -e ~/.config/dev/aws-sso ] || awk '$1=="game-forge"{print $1, $2, "ojos"}' ~/.config/dev/projects > ~/.config/dev/aws-sso
cat ~/.config/dev/aws-sso                      # 「名前 絶対パス セッション名」の 3 列であること
~/.local/bin/dev-auth-aws game-forge          # デバイスコードをブラウザで承認する
```

## スマホのボタンに doctor / rebuild を足す（任意）

v0.17.0 の上流の雛形（`devhost/termux/shortcut.example`）は、ボタンの操作に `doctor <名前>` と `rebuild <名前>` を
挙げています。**足すかどうかは利用者が決めます。** 足さなくても、`gf-attach` が通らないときに Termux を開いて
`ssh -t dev01 .local/bin/dev doctor game-forge` を打てば同じです。

| ボタン | 押したときに起きること | 足す前に考えること |
|---|---|---|
| `gf-doctor` | 読み取りだけ（コンテナ・exec・プロセス数・ゾンビ・oom_kill・ユニット） | 害は無い。ただし Termux:Widget はボタンの ssh が終わると閉じるので、出力を読むには Termux を開いて打つほうが早い |
| `gf-rebuild` | **コンテナを作り直す。中の tmux と Claude の作業は消える**（ユニットの停止と起こし直しは `dev rebuild` がする） | 誤タップで作業が消える。確かめの段は無い。`--pull` は付けない（作業中のツリーで `git pull` が走る） |

足すときは、Termux で次を打ちます（片方だけでもよい）。

```bash
for b in "gf-doctor:dev doctor game-forge" "gf-rebuild:dev rebuild game-forge"; do
  printf '#!/data/data/com.termux/files/usr/bin/bash\nexec ssh -t dev01 .local/bin/%s\n' "${b#*:}" > ~/.shortcuts/"${b%%:*}"
done
chmod +x ~/.shortcuts/gf-doctor ~/.shortcuts/gf-rebuild
```

dev01 の `dev` を v0.17.0 以降へ上げる前に足すと、ボタンは `dev` の使い方の誤り（2）で止まります。

## dev01 の移行手順（game-forge 版から上流の版へ。#923 で済み）

**この移行は 2026-10-03 に済んでいます（#923）。** ほかの機械を game-forge 版から移すことがあったとき、と
移した理由の記録のために残します。上流の版を上げるだけなら、上の「上流の版を上げる」だけで足ります。要点は 2 つです。

- **上流の `dev` を置く前に、設定ファイルから AWS のキーを外します。** 上流の `dev` は知らないキーで止まります。
  先に置くと、次にコンテナが止まったときのユニットの `dev supervise` が設定の誤りで落ち続け、コンテナが戻りません。
  逆に、キーを外しても game-forge 版の `dev` は困りません（AWS の列が `-` になるだけ）。
- **置き換えは `install` で行います**（理由は「上流の版を上げる」と同じ）。

順序は次のとおりです。

1. 上の「上流の版を上げる」の 0〜2 で、上流の版を取り出し、ユニットを比べる（game-forge 版のユニットは上流の
   v0.14.0 以降と同じ中身でした）。
2. 「薄い追加を置く・更新する」で `dev-auth-aws` を置く。このとき `aws-sso` は、AWS のキーを外す前の projects から作る。
   セッション名は projects の `aws_sso_session` から読み、無ければ `ojos` を使う:

   ```bash
   awk -v def=ojos '$1=="game-forge"{s=def; for(i=3;i<=NF;i++) if($i ~ /^aws_sso_session=/) s=substr($i,17); print $1, $2, s}' \
     ~/.config/dev/projects > ~/.config/dev/aws-sso
   ```

3. 設定ファイルから AWS のキーを外す（game-forge 版の dev のままで、ls の AWS 列が - になる）:

   ```bash
   cp ~/.config/dev/projects ~/.config/dev/projects.bak
   sed -e 's/[[:space:]]aws_sso_session=[^[:space:]]*//g' -e 's/[[:space:]]aws_profile=[^[:space:]]*//g' \
     ~/.config/dev/projects.bak > ~/.config/dev/projects
   grep -c 'aws_' ~/.config/dev/projects          # 0 であること
   ```

4. 「上流の版を上げる」の 3〜5 で上流の `dev` を置いて確かめ、`rm ~/.config/dev/projects.bak` で片付ける。
5. スマホのボタンの `gf-auth-aws` を書き換える（他の 3 つはそのまま）:

   ```bash
   printf '#!/data/data/com.termux/files/usr/bin/bash\nexec ssh -t dev01 .local/bin/dev-auth-aws game-forge\n' > ~/.shortcuts/gf-auth-aws
   chmod +x ~/.shortcuts/gf-auth-aws
   ```

移行の後に確かめたこと（#923 の acceptance の 3 つ目）は、上流の版の `dev ls` / `dev up game-forge` /
`dev attach game-forge` と、`dev-auth-aws game-forge` を 1 回ずつ通すことでした（結果は #923）。
