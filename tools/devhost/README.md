# devhost — dev01 のホストに置く道具（game-forge の差分）

**devhost の本体（`dev` と `dev-up@.service`、Termux と ssh の雛形）は、上流の版を使います。**
上流は、独自の版を持つ公開リポジトリ [ojos/devcontainer-host のリリース](https://github.com/ojos/devcontainer-host/releases)です
（DCB の v0.14.0〜v0.17.0 のリリースに同梱されていましたが、DCB は v0.18.0 で同梱をやめました。#953）。
**dev01 に置く版は、下の「上流の版を上げる（dev01 の更新）」の `TAG=` の行が正本**です（#944。いまの版の文字列は
ほかの節に書かず、そこを参照します）。
導入・stopCompose の扱い・鍵の作り方と失効・Termux の設定は、**devcontainer-host の README が正本**です。
入手は、その README の「install.sh で入れる」のとおり、`RELEASE-MANIFEST.json` に記録された `install.sh` の
ハッシュと照合してから実行します。

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

**作業中のコンテナを止めずに済む順序です。** 上流の `install.sh` で上げます。

- **`install.sh` は、照合済みの `dev.sh` と `dev-up@.service` を一時ファイルから `mv` で置き換えます。** いま動いている
  ユニットの `dev supervise` は bash がスクリプトを少しずつ読みながら `docker wait` で待っていますが、`mv` は別の
  ファイルへ差し替えるので、動いているプロセスは古い中身のまま最後まで動きます（同じファイルへ `cp` で上書きすると、
  待ち終わった後に新しい中身の途中から読みます）。`~/.config/dev/projects` は、あれば上書きしません。
- **上げる前に、上流の `CHANGELOG.md` を読みます**（リリースのページか、アーカイブの中）。設定ファイル（`~/.config/dev/projects`）の
  書式が変わっていれば、上げる前にそちらを先に合わせます（上流の `dev` は知らないキーで止まる）。
- **`dev self-update` は使いません。** `dev` だけを上げ、ユニットのファイルは更新しない（差があれば `install.sh` の再実行を
  案内するだけ）うえに、既定で最新を取るので `TAG=` の正本とずれます。
- 値（ハッシュ・パス）は手順の中で読みます。ここに書き写しません。

```bash
# 0. 上げる先の版（dev01 に置く上流の版の正本。上げるときはこの 1 行だけを書き換える）
TAG=v0.1.0
#    いまの状態を控える（CONTAINER が running、UNIT が active であること）
~/.local/bin/dev ls
~/.local/bin/dev version                       # DCB 同梱の版（v0.17.0 以前）には無く、使い方の誤り（2）で止まる
systemctl --user is-active dev-up@game-forge.service

# 1. 取得する（作業用の空のディレクトリで。手順の全文は上流の README の「install.sh で入れる」）
W="$(mktemp -d "${TMPDIR:-/tmp}/devhost.XXXXXX")" && cd "$W"
BASE="https://github.com/ojos/devcontainer-host/releases/download/${TAG}"
curl -fsSL "${BASE}/RELEASE-MANIFEST.json" -o RELEASE-MANIFEST.json
curl -fsSL "${BASE}/install.sh" -o install.sh
verified() { jq -r '.checksums["install.sh"] + "  install.sh"' RELEASE-MANIFEST.json | sha256sum -c -; }   # bsd-ok: dev01（Linux）のホストで打つ手順

# 2. 計画を読んでから入れる。照合・計画・本実行を && でつなぐ（行を分けると、照合や計画が失敗しても本実行が走る）。
#    計画（dev を置き換える / ユニットは置き換えない / projects は触らない、など）を読んで Enter、やめるなら Ctrl-C。
#    install.sh も dev.sh などを同じマニフェストで照合し、1 つでも違えば何も置かずに止まる
verified && bash install.sh --version "${TAG}" --dry-run \
  && read -r -p '計画を読んだら Enter（やめるなら Ctrl-C）: ' \
  && verified && bash install.sh --version "${TAG}"

# 3. 確かめる（どれも 0 で終わり、ユニットは active のまま）
~/.local/bin/dev version                       # 「dev <TAG の版>」と出ること
~/.local/bin/dev ls; echo "ls=$?"
~/.local/bin/dev doctor game-forge; echo "doctor=$?"   # 0 = 問題なし / 1 = FAIL / 3 = WARN だけ
systemctl --user is-active dev-up@game-forge.service

# 4. 片付け
cd ~ && rm -rf "$W"
```

- **DCB 同梱の版（v0.17.0 以前）から移るときも、この手順のままです**（#953 で 1 度だけ行った）。古い `dev` の
  `dev self-update` は取得先が DCB のリリースなので、終了コード 1 で何も置き換えずに止まります。上の手順で入れ直した後は、
  `dev version` が版を出します。
- **動いているユニットの `dev supervise` は、次にコンテナが止まるまで古い版のまま**です。止まった後、
  ユニットが起こし直すときから新しい版が動きます。すぐに新しい版で見張らせたいときは、作業の切れ目で
  `systemctl --user restart dev-up@game-forge.service` を打ちます
  （ユニットを止めてもコンテナは止まりません。`up` は動いているコンテナに対しては起こし直しません）。
- **`install.sh` はユニットのファイルを置いたあと `systemctl --user daemon-reload` を呼びます。** restart はしません
  （次に起こし直すときから新しい中身が効きます）。devcontainer-host v0.1.0 のユニットは、DCB v0.17.0 に同梱されていたものと
  同じ中身です（#953 で `cmp` で確かめた）。
- **`dev doctor` は 0 で終わることを確かめます**（#944 の acceptance）。3（WARN だけ）は `dev` の差し替えそのものの
  失敗ではなく、コンテナの記録（pids の上限に当たった回数・ゾンビ・oom_kill）を指しますが、**0 でない間は「上げて確かめた」
  とはしません。** 出た項目を issue に書き、原因を調べてから判断します。1（FAIL）なら上流の README の
  「dev doctor」のとおり `dev rebuild game-forge` を検討します（作業中のコンテナと tmux は消えます）。
- **devcontainer-host v0.1.0 で増えたもの**（DCB v0.17.0 同梱の版から）: `dev restart <名前>`（作り直さずに起こし直す）、
  `dev stop <名前>`（ユニットを止めてからコンテナを止める）、`dev enable` / `dev disable <名前>`（ユニットの有効・無効。
  `disable` はコンテナも止める）、`dev logs <名前>`（ユニットのログ）、`dev exec <名前> -- <コマンド...>`（tmux を介さずに
  コンテナの中で 1 つ実行する）、`dev version`。それ以前の DCB v0.17.0 で `dev rebuild <名前> [--pull]`・`dev doctor <名前>`・
  `dev help` が増えています。**作り直しは、VS Code の Rebuild Container とユニットの手での stop / start の代わりに
  `dev rebuild game-forge` で行えます。**

## 薄い追加を置く・更新する

作業中のツリーを触らず、main の版を取ってきます。新しく置くときも、更新するときも同じです
（リンクにしないのは、上流の `dev` と同じく、ブランチの切り替えでホストの道具が黙って変わらないようにするため）。
`cd` せず、別の変数 `A` で作業するので、「上流の版を上げる」の `W` の途中で打っても、そちらの作業場所を壊しません。

```bash
A="$(mktemp -d "${TMPDIR:-/tmp}/dev-auth-aws.XXXXXX")"
curl -fsSL https://raw.githubusercontent.com/ojos/game-forge/main/tools/devhost/dev-auth-aws.sh -o "$A/dev-auth-aws.sh"
less "$A/dev-auth-aws.sh"                      # 中身を読んでから置く
install -D -m 0755 "$A/dev-auth-aws.sh" ~/.local/bin/dev-auth-aws
rm -rf "$A"
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

上流の雛形（DCB v0.17.0 同梱の `devhost/termux/shortcut.example`。devcontainer-host では `termux/shortcut.example`）は、ボタンの操作に `doctor <名前>` と `rebuild <名前>` を
挙げています。**足すかどうかは利用者が決めます。** 足さなくても、`gf-attach` が通らないときに Termux を開いて
`ssh -t dev01 .local/bin/dev doctor game-forge` を打てば同じです。

| ボタン | 押したときに起きること | 足す前に考えること |
|---|---|---|
| `gf-doctor` | 読み取りだけ（コンテナ・exec・プロセス数・ゾンビ・oom_kill・ユニット） | 害は無い。ただし Termux:Widget はボタンの ssh が終わると閉じるので、出力を読むには Termux を開いて打つほうが早い |
| `gf-rebuild` | **コンテナを作り直す。中の tmux と Claude の作業は消える**（ユニットの停止と起こし直しは `dev rebuild` がする） | 誤タップで作業が消える。確かめの段は無い。`--pull` は付けない（作業中のツリーで `git pull` が走る） |

足すときは、Termux で足したいボタンの行だけを打ちます（1 ボタン 1 行。片方だけでもよい）。

```bash
# gf-doctor（読み取りだけ）
printf '#!/data/data/com.termux/files/usr/bin/bash\nexec ssh -t dev01 .local/bin/dev doctor game-forge\n' > ~/.shortcuts/gf-doctor && chmod +x ~/.shortcuts/gf-doctor
# gf-rebuild（作り直す。中の作業は消える）
printf '#!/data/data/com.termux/files/usr/bin/bash\nexec ssh -t dev01 .local/bin/dev rebuild game-forge\n' > ~/.shortcuts/gf-rebuild && chmod +x ~/.shortcuts/gf-rebuild
```

dev01 の `dev` を v0.17.0 以降へ上げる前に足すと、ボタンは `dev` の使い方の誤り（2）で止まります。

## dev01 の移行手順（game-forge 版から上流の版へ。#923 で済み）

**この移行は 2026-10-03 に済んでいます（#923）。** ほかの機械を game-forge 版から移すことがあったとき、と
移した理由の記録のために残します。上流の版を上げるだけなら、上の「上流の版を上げる」だけで足ります。要点は 2 つです。

- **上流の `dev` を置く前に、設定ファイルから AWS のキーを外します。** 上流の `dev` は知らないキーで止まります。
  先に置くと、次にコンテナが止まったときのユニットの `dev supervise` が設定の誤りで落ち続け、コンテナが戻りません。
  逆に、キーを外しても game-forge 版の `dev` は困りません（AWS の列が `-` になるだけ）。
- **置き換えは `cp` で上書きせず、別のファイルから差し替えます**（理由は「上流の版を上げる」と同じ。#923 の当時は `install` で、いまは上流の `install.sh` が `mv` で行う）。

順序は次のとおりです。

1. 上流の版を取得して照合する（#923 の当時は DCB v0.14.0 のアーカイブから取り出し、ユニットを比べた。game-forge 版のユニットは
   上流の v0.14.0 以降と同じ中身でした。いまは上の「上流の版を上げる」の 0〜1）。
2. 先に、AWS のキーを外す前の projects から `aws-sso` を作る（セッション名は projects の `aws_sso_session` から読み、
   無ければ `ojos`）:

   ```bash
   awk -v def=ojos '$1=="game-forge"{s=def; for(i=3;i<=NF;i++) if($i ~ /^aws_sso_session=/) s=substr($i,17); print $1, $2, s}' \
     ~/.config/dev/projects > ~/.config/dev/aws-sso
   ```

   続けて「薄い追加を置く・更新する」で `dev-auth-aws` を置く（`aws-sso` が既にあるので、その節の awk は何もしない）。

3. 設定ファイルから AWS のキーを外す（game-forge 版の dev のままで、ls の AWS 列が - になる）:

   ```bash
   cp ~/.config/dev/projects ~/.config/dev/projects.bak
   sed -e 's/[[:space:]]aws_sso_session=[^[:space:]]*//g' -e 's/[[:space:]]aws_profile=[^[:space:]]*//g' \
     ~/.config/dev/projects.bak > ~/.config/dev/projects
   grep -c 'aws_' ~/.config/dev/projects          # 0 であること
   ```

4. 「上流の版を上げる」の 2〜4 で上流の `dev` を置いて確かめ、`rm ~/.config/dev/projects.bak` で片付ける。
5. スマホのボタンの `gf-auth-aws` を書き換える（他の 3 つはそのまま）:

   ```bash
   printf '#!/data/data/com.termux/files/usr/bin/bash\nexec ssh -t dev01 .local/bin/dev-auth-aws game-forge\n' > ~/.shortcuts/gf-auth-aws
   chmod +x ~/.shortcuts/gf-auth-aws
   ```

移行の後に確かめたこと（#923 の acceptance の 3 つ目）は、上流の版の `dev ls` / `dev up game-forge` /
`dev attach game-forge` と、`dev-auth-aws game-forge` を 1 回ずつ通すことでした（結果は #923）。
